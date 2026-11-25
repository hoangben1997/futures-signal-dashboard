import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastIndexBefore, reconstructInputs, evaluateSignal, classify, extractSignals } from '../lib/audit.js';
import { buildMetrics } from '../lib/metrics.js';

const H = 3600 * 1000;
const T = Date.UTC(2023, 5, 10);

test('lastIndexBefore: strict và inclusive', () => {
  const arr = [{ t: 1 }, { t: 3 }, { t: 5 }];
  assert.equal(lastIndexBefore(arr, 't', 5), 1);
  assert.equal(lastIndexBefore(arr, 't', 5, true), 2);
  assert.equal(lastIndexBefore(arr, 't', 1), -1);
  assert.equal(lastIndexBefore(arr, 't', 99), 2);
});

function hourBars(n, endOpen) {
  return Array.from({ length: n }, (_, i) => {
    const openTime = endOpen - ((n - 1 - i) * H);
    return { openTime, closeTime: openTime + H - 1, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, takerBuyBase: 6 };
  });
}

function dataAt() {
  const h1 = hourBars(100, T); // nến cuối mở lúc T → đang chạy tại origin T
  return {
    bars: { '1h': h1, '4h': [], '1d': [], '1w': [], '1M': [] },
    funding: [{ fundingTime: T - (8 * H), fundingRate: 0.0001 }, { fundingTime: T, fundingRate: 0.0002 }, { fundingTime: T + (8 * H), fundingRate: 0.9 }],
    fng: [{ timestamp: T - (24 * H), value: 40 }, { timestamp: T, value: 90 }],
    metrics5m: [
      { t: T - (6 * H), oi: 100, globalAcc: 1.5, topPos: 1.1 },
      { t: T - (5 * 60 * 1000), oi: 110, globalAcc: 1.6, topPos: null },
      { t: T, oi: 999, globalAcc: 9, topPos: 9 }
    ]
  };
}

test('reconstructInputs: chỉ dùng dữ liệu trước origin, không dùng nến đang chạy hay số công bố tại/sau origin', () => {
  const raw = reconstructInputs(dataAt(), T);
  // Nến 1h đang chạy (open = T) bị bỏ: close cuối là của nến mở lúc T − 1h
  assert.equal(raw.ticker24h.lastPrice, String(100 + 98));
  assert.equal(raw.kline1h.length, 72);
  // Funding đã chốt tại đúng T được dùng; funding sau T thì không
  assert.equal(raw.premium.lastFundingRate, '0.0002');
  // F&G: giá trị timestamp = T bị bỏ (có thể công bố sau origin)
  assert.equal(raw.fearGreed.data[0].value, '40');
  // OI/LS: mốc t = T bị bỏ; OI 6h trước = 100
  assert.equal(raw.oiNow.openInterest, '110');
  assert.equal(raw.oiHist[0].sumOpenInterest, '100');
  assert.equal(raw.lsHist[0].longShortRatio, '1.6');
  // top trader null ở mốc mới nhất → lùi về mốc gần nhất có giá trị (6h trước) nhưng quá 2h → null
  assert.equal(raw.topTraderLs, null);
  // Taker 1h: 6 / (10 − 6)
  assert.equal(raw.takerFlow[0].buySellRatio, String(1.5));

  const m = buildMetrics({ symbol: 'BTCUSDT', asOf: new Date(T).toISOString(), nowMs: T, ...raw });
  assert.ok(Math.abs(m.openInterestChange6h - 10) < 1e-9);
  assert.equal(m.fundingRate, 0.0002);
  assert.equal(m.deribitIv, null);
});

test('evaluateSignal: edge có dấu tính tay', () => {
  // d: [1, 1, -1, 0], d̄ = 0,25; s: [1, 0, -1, 0] → E = (1·0,75 + (−1)·(−1,25)) / 2 = 1
  const rows = [
    { d: 1, signals: { x: 1 } },
    { d: 1, signals: { x: 0 } },
    { d: -1, signals: { x: -1 } },
    { d: 0, signals: { x: 0 } }
  ];
  const r = evaluateSignal(rows, 'x', { bootstrap: { blockLength: 1, iterations: 200, seed: 1, ci: 0.95 } });
  assert.equal(r.fired, 2);
  assert.equal(r.edge, 1);
  assert.equal(r.whenUp.up, 1);
  assert.equal(r.whenDown.down, 1);
});

test('classify: chỉ bỏ khi discovery CI95 < 0 VÀ confirmation < 0, mỗi kỳ ≥ 30 lần kích hoạt', () => {
  const s = (edge, lower, upper, fired = 50) => ({ edge, fired, ci: { lower, upper } });
  assert.equal(classify(s(-0.1, -0.2, -0.01), s(-0.02, -0.1, 0.05)), 'remove_wrong_direction');
  assert.equal(classify(s(-0.1, -0.2, -0.01), s(0.01, -0.1, 0.1)), 'no_evidence');
  assert.equal(classify(s(-0.1, -0.2, 0.001), s(-0.05, -0.1, 0)), 'no_evidence');
  assert.equal(classify(s(-0.1, -0.2, -0.01, 29), s(-0.05, -0.1, 0)), 'no_evidence');
  assert.equal(classify(s(0.1, 0.01, 0.2), s(0.02, -0.1, 0.1)), 'keep_verified');
});

test('extractSignals: map rule, mapped trend, outlook, DiSSS', () => {
  const trend = {
    rules: [
      { name: 'Funding Rate High', pass: true, score: -1 },
      { name: 'Taker Flow', pass: false, score: 0 },
      { name: 'Global L/S Ratio Low', pass: true, score: 1 }
    ],
    mappedTrend: { components: { structure: 0.5, derivatives: -0.2, regime: -0.4, macroTime: 0 } },
    outlook: 'Bearish Bias'
  };
  const report = { families: [{ family: 'oi', direction: 'bullish' }], summary: { bias: 'insufficient' } };
  const s = extractSignals(trend, report);
  assert.equal(s['rule:funding'], -1);
  assert.equal(s['rule:taker'], 0);
  assert.equal(s['rule:globalLS'], 1);
  assert.equal(s['mapped:structure'], 1);
  assert.equal(s['mapped:derivatives'], 0);
  assert.equal(s['mapped:regime'], -1);
  assert.equal(s['headline:outlook'], -1);
  assert.equal(s['disss:oi'], 1);
  assert.equal(s['disss:volume'], 0);
  assert.equal(s['disss:bias'], 0);
});
