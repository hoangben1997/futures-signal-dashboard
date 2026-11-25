import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installMockMarket } from './helpers/mock-market.js';
import { getSnapshot, resetCaches, start, server } from '../server.js';
import { inferTrend } from '../lib/scoring.js';
import { buildMarketReport } from '../lib/analysis.js';

let mock;
beforeEach(() => { resetCaches(); });
afterEach(() => { mock?.restore(); mock = null; });

const PER_SYMBOL_ENDPOINTS = [
  'fapi.binance.com/fapi/v1/premiumIndex',
  'fapi.binance.com/fapi/v1/openInterest',
  'fapi.binance.com/futures/data/openInterestHist',
  'fapi.binance.com/futures/data/globalLongShortAccountRatio',
  'fapi.binance.com/futures/data/topLongShortPositionRatio',
  'fapi.binance.com/futures/data/takerlongshortRatio',
  'fapi.binance.com/fapi/v1/ticker/24hr',
  'www.deribit.com/api/v2/public/get_book_summary_by_currency'
];

test('snapshot: mô hình lịch sử bị cách ly, không có xác suất kiểm định, không tải lại lịch sử', async () => {
  mock = installMockMarket();
  const snap = await getSnapshot('BTCUSDT', 24);
  assert.equal(snap.contract.validatedProbabilities, false);
  assert.equal(snap.contract.historicalModel, 'disabled');
  assert.equal(snap.metrics.historicalScenarioModel, null);
  assert.ok(!snap.errors.some((e) => /Historical|clamp/.test(e)), snap.errors.join('; '));
  assert.equal(snap.trend.scenarioMeta.source, 'heuristic');
  assert.equal(snap.analysis.statisticalModel, null);
  assert.ok(snap.analysis.scenarios.every((s) => s.statisticalProbabilityPct === undefined));
  // Không còn request dạng klines theo startTime/endTime (luồng tải lịch sử 1 năm cũ)
  assert.equal(mock.calls.filter((u) => u.searchParams.has('startTime')).length, 0);
});

test('snapshot: hai horizon cùng symbol dùng chung một lần lấy dữ liệu nguồn (single-flight)', async () => {
  mock = installMockMarket();
  const [a, b] = await Promise.all([getSnapshot('BTCUSDT', 4), getSnapshot('BTCUSDT', 24)]);
  for (const key of PER_SYMBOL_ENDPOINTS) assert.equal(mock.count(key), 1, key);
  // klines: 1h/4h/1d/1w cho snapshot + 4 khung futures cho technicals
  assert.equal(mock.count('fapi.binance.com/fapi/v1/klines'), 8);
  assert.equal(mock.count('api.alternative.me/fng/'), 1);
  assert.equal(a.trend.mappedTrend.timeframe, '4h');
  assert.equal(b.trend.mappedTrend.timeframe, '1d');
  assert.equal(a.metrics.price, b.metrics.price);

  // Lần gọi tiếp trong TTL dùng cache, không gọi lại nguồn
  const before = mock.calls.length;
  await getSnapshot('BTCUSDT', 12);
  assert.equal(mock.calls.length, before);
});

test('snapshot: giữ số nến 1h dùng cho realized vol theo horizon như trước (72 / 96)', async () => {
  mock = installMockMarket();
  const s4 = await getSnapshot('BTCUSDT', 4);
  const s168 = await getSnapshot('BTCUSDT', 168);
  // 97 = 96 nến đã đóng + 1 nến đang chạy (bị bỏ khi tính metrics)
  const kl1h = mock.calls.filter((u) => u.pathname === '/fapi/v1/klines' && u.searchParams.get('interval') === '1h' && u.searchParams.get('limit') === '97');
  assert.equal(kl1h.length, 1);
  assert.equal(s4.history.candles1h.length, 72);
  assert.notEqual(s4.metrics.realizedVol24h, s168.metrics.realizedVol24h);
});

test('snapshot: nguồn lỗi một phần vẫn trả snapshot, có trạng thái lỗi rõ', async () => {
  mock = installMockMarket({
    'api.coingecko.com/api/v3/global': { status: 500 },
    'fapi.binance.com/futures/data/openInterestHist': { status: 503 }
  });
  const snap = await getSnapshot('ETHUSDT', 4);
  assert.ok(snap.errors.includes('CoinGecko global lỗi'));
  assert.ok(snap.errors.includes('Binance openInterestHist lỗi'));
  const cg = snap.sources.find((s) => s.name === 'CoinGecko global');
  assert.equal(cg.ok, false);
  assert.match(cg.error, /500/);
  assert.equal(snap.metrics.btcMarketCapDominance, null);
  assert.equal(snap.metrics.openInterestChange6h, null);
  assert.ok(snap.analysis && snap.trend);
});

test('snapshot: nguồn global lỗi không bị cache 5 phút, lần sau thử lại', async () => {
  mock = installMockMarket({ 'api.alternative.me/fng/': { status: 500 } });
  await getSnapshot('BTCUSDT', 4);
  assert.equal(mock.count('api.alternative.me/fng/'), 1);
  // TTL của nhóm global khi có lỗi = REFRESH_MS; giả lập hết hạn bằng cách xoá cache symbol + global
  resetCaches();
  await getSnapshot('BTCUSDT', 4);
  assert.equal(mock.count('api.alternative.me/fng/'), 2);
});

test('snapshot: dữ liệu quá hạn được đánh dấu stale kèm observedAt và fetchedAt', async () => {
  const nowMs = Date.now();
  mock = installMockMarket({
    'api.alternative.me/fng/': () => ({ data: [{ value: '40', timestamp: String(Math.floor(nowMs / 1000) - 4 * 86400) }] })
  }, nowMs);
  const snap = await getSnapshot('BTCUSDT', 4);
  const fg = snap.sources.find((s) => s.name === 'Fear & Greed');
  assert.equal(fg.ok, true);
  assert.equal(fg.stale, true);
  assert.ok(Date.parse(fg.fetchedAt) - Date.parse(fg.observedAt) > 3 * 86400e3);
  const ticker = snap.sources.find((s) => s.name === 'Binance ticker24h');
  assert.equal(ticker.stale, false);
});

test('snapshot: thiếu gần hết nguồn → DiSSS "chưa đủ dữ liệu", không đoán hướng', async () => {
  const fail = { status: 500 };
  mock = installMockMarket({
    'fapi.binance.com/fapi/v1/klines': fail,
    'api.binance.com/api/v3/klines': fail,
    'fapi.binance.com/fapi/v1/premiumIndex': fail,
    'fapi.binance.com/futures/data/openInterestHist': fail,
    'fapi.binance.com/futures/data/globalLongShortAccountRatio': fail,
    'fapi.binance.com/futures/data/topLongShortPositionRatio': fail,
    'fapi.binance.com/futures/data/takerlongshortRatio': fail,
    'api.alternative.me/fng/': fail
  });
  const snap = await getSnapshot('SOLUSDT', 4);
  assert.equal(snap.analysis.summary.bias, 'insufficient');
  assert.deepEqual(snap.technicals.byTf, {});
  assert.ok(snap.errors.some((e) => /Technicals lỗi|klines 1M/.test(e)));
});

test('USDC: lỗi sau khi thử hết nguồn khác với feed rỗng hợp lệ', async () => {
  mock = installMockMarket({ 'whale-alert.io/alerts.json': () => '<html>blocked</html>' });
  const bad = await getSnapshot('BTCUSDT', 4);
  const badSrc = bad.sources.find((s) => s.name.startsWith('USDC treasury'));
  assert.equal(badSrc.ok, false);
  assert.ok(bad.errors.some((e) => e.startsWith('USDC treasury lỗi')));

  mock.restore();
  resetCaches();
  mock = installMockMarket({ 'whale-alert.io/alerts.json': () => [] });
  const empty = await getSnapshot('BTCUSDT', 4);
  const okSrc = empty.sources.find((s) => s.name.startsWith('USDC treasury'));
  assert.equal(okSrc.ok, true);
  assert.equal(okSrc.error, null);
  assert.deepEqual(empty.usdcMinting, []);
  assert.ok(!empty.errors.some((e) => e.startsWith('USDC treasury lỗi')));
});

test('lịch kinh tế: nguồn lỗi được báo trong errors và sources', async () => {
  mock = installMockMarket({ 'nfs.faireconomy.media/ff_calendar_thisweek.json': { status: 429 } });
  const snap = await getSnapshot('BTCUSDT', 4);
  assert.ok(snap.errors.some((e) => e.startsWith('Lịch kinh tế lỗi')));
  const cal = snap.sources.find((s) => s.name === 'Lịch kinh tế');
  assert.equal(cal.ok, false);
  assert.match(cal.error, /429/);
  assert.deepEqual(snap.economicCalendar, []);
});

test('fail closed: hàng lịch sử chưa kiểm định (≥140 mẫu, Brier đẹp) không đi vào kịch bản hay quyết định', async () => {
  mock = installMockMarket();
  const snap = await getSnapshot('BTCUSDT', 24);
  const injected = {
    byTimeframe: {
      '1d': {
        up: 70, down: 10, sideway: 20, samples: 400, mode: 'conditional',
        backtest: { testSamples: 122, brierScore: 0.09, top1AccuracyPct: 83, directionalAccuracyPct: null }
      }
    }
  };
  const base = inferTrend(snap.metrics, 24);
  const withRow = inferTrend({ ...snap.metrics, historicalScenarioModel: injected }, 24);
  assert.equal(withRow.scenarioMeta.source, 'heuristic');
  assert.deepEqual(withRow.scenarioProbabilities, base.scenarioProbabilities);
  assert.deepEqual(withRow.decision, base.decision);

  const report = buildMarketReport({ symbol: 'BTCUSDT', metrics: { ...snap.metrics, historicalScenarioModel: injected }, technicals: snap.technicals });
  assert.equal(report.statisticalModel.hasSkill, false);
  assert.ok(report.scenarios.every((s) => s.statisticalProbabilityPct === undefined));
});

test('HTTP: SSE gửi snapshot theo đúng symbol/horizon khi đổi tham số; /api/snapshot cho polling', async () => {
  mock = installMockMarket();
  await start(0);
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1', 'mặc định chỉ bind loopback');
  const firstSnapshot = async (query) => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?${query}`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: snapshot\ndata: (.*)\n\n/);
      if (m) {
        ctrl.abort();
        return JSON.parse(m[1]);
      }
    }
  };
  try {
    const a = await firstSnapshot('symbol=BTCUSDT&timeframe=4');
    assert.equal(a.metrics.symbol, 'BTCUSDT');
    assert.equal(a.trend.mappedTrend.timeframe, '4h');
    const b = await firstSnapshot('symbol=ETHUSDT&timeframe=72');
    assert.equal(b.metrics.symbol, 'ETHUSDT');
    assert.equal(b.trend.mappedTrend.timeframe, '3d');

    const res = await fetch(`http://127.0.0.1:${port}/api/snapshot?symbol=SOLUSDT&timeframe=168`);
    assert.equal(res.status, 200);
    const c = await res.json();
    assert.equal(c.metrics.symbol, 'SOLUSDT');
    assert.equal(c.contract.validatedProbabilities, false);

    const bad = await fetch(`http://127.0.0.1:${port}/api/snapshot?symbol=DOGEUSDT`);
    assert.equal(bad.status, 500);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('snapshot: metrics/badge bỏ nến đang chạy (giống audit), chart vẫn hiện nến đang chạy', async () => {
  mock = installMockMarket();
  const snap = await getSnapshot('BTCUSDT', 24);
  const now = Date.now();
  const lastChart = snap.history.candles1h[snap.history.candles1h.length - 1];
  assert.ok(Date.parse(lastChart.time) + 3600e3 > now, 'chart có nến 1h đang chạy');
  // closeNow1h là close của nến 1h đã đóng gần nhất, không phải nến đang chạy
  assert.equal(snap.metrics.closeNow1h, snap.history.candles1h[snap.history.candles1h.length - 2].close);
  assert.ok(snap.technicals.byTfClosed && snap.technicals.byTf);
});
