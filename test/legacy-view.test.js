import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installMockMarket } from './helpers/mock-market.js';
import { getSnapshot, resetCaches } from '../server.js';
import { inferTrend } from '../lib/scoring.js';
import { statisticalModelCheck } from '../lib/analysis.js';
import {
  decisionBarView,
  playbookBasisLines,
  scenarioPanelView,
  staleSourceAlerts,
  statisticalNoteText
} from '../public/legacy-view.js';

let mock;
afterEach(() => { mock?.restore(); mock = null; });

function renderedText(trend, stat, hours) {
  const bar = decisionBarView(trend);
  const panel = scenarioPanelView(trend, hours);
  return [
    bar.badgeText, bar.strengthText, bar.strengthTitle, bar.scoreText,
    panel.horizonNote, panel.probabilityNotice,
    ...(panel.monitoring ? Object.values(panel.monitoring) : []),
    ...playbookBasisLines(trend.playbookBasis),
    statisticalNoteText(stat)
  ].join('\n');
}

function assertNoProbabilityLabels(text, trend, stat) {
  for (const s of trend.scenarioProbabilities) {
    assert.ok(!text.includes(`${s.probability.toFixed(1)}%`), `lộ xác suất heuristic ${s.probability}`);
    assert.ok(!text.includes(`${s.probability}%`), `lộ xác suất heuristic ${s.probability}`);
  }
  assert.ok(!text.includes(`${Number(trend.confidence).toFixed(1)}%`), 'lộ confidence %');
  // Nhãn cũ (viết hoa đầu câu); câu cảnh báo "Chưa có xác suất kịch bản…" thì được phép
  assert.ok(!/Xác suất kịch bản|Thống kê 1 năm|Confidence/.test(text));
  if (stat && !stat.hasSkill) {
    assert.ok(!text.includes(`${stat.up}%`) && !text.includes(`${stat.down}%`), 'lộ số mô hình chưa kiểm định');
  }
}

test('UI: không có nhãn xác suất ở 3 trạng thái (heuristic, hàng lịch sử chèn vào, thiếu mô hình)', async () => {
  resetCaches();
  mock = installMockMarket();
  const snap = await getSnapshot('BTCUSDT', 24);

  // 1. Heuristic (trạng thái mặc định hiện tại)
  assertNoProbabilityLabels(renderedText(snap.trend, snap.analysis.statisticalModel, 24), snap.trend, snap.analysis.statisticalModel);

  // 2. Có hàng lịch sử chưa kiểm định được chèn vào metrics
  const injected = { byTimeframe: { '1d': { up: 71.2, down: 9.4, sideway: 19.4, samples: 400, backtest: { brierScore: 0.09, testSamples: 122 } } } };
  const trend2 = inferTrend({ ...snap.metrics, historicalScenarioModel: injected }, 24);
  const stat2 = statisticalModelCheck(injected, '1d');
  assert.equal(stat2.hasSkill, false);
  assertNoProbabilityLabels(renderedText(trend2, stat2, 24), trend2, stat2);

  // 3. Thiếu mô hình và thiếu breakout levels
  const trend3 = { ...snap.trend, breakoutLevels: null };
  const text3 = renderedText(trend3, null, 4);
  assertNoProbabilityLabels(text3, trend3, null);
  assert.match(text3, /Không có mô hình thống kê đã kiểm định/);
});

test('UI: badge dùng trend.outlook của backend, không dùng ngưỡng cứng', () => {
  // decision.score 0,24 < 0,25 (ngưỡng cứng cũ) nhưng backend đã chốt Bullish theo ngưỡng weak 0,24
  const v = decisionBarView({ outlook: 'Bullish Bias', decision: { score: 0.24 }, score: 1.2 });
  assert.equal(v.badgeText, 'BULLISH');
  assert.equal(v.strengthText, '0.24');
  assert.ok(!v.strengthText.includes('%'));
});

test('UI: mô hình đã kiểm định mới được hiện số', () => {
  const text = statisticalNoteText({ hasSkill: true, up: 31, down: 30, sideway: 39, samples: 500, verdict: 'ok' });
  assert.match(text, /Tăng 31%/);
});

test('UI: cảnh báo nguồn cũ (stale) có tuổi dữ liệu', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const alerts = staleSourceAlerts([
    { name: 'Fear & Greed', ok: true, stale: true, observedAt: '2026-11-21T12:00:00Z', fetchedAt: '2026-11-24T12:00:00Z' },
    { name: 'USDC treasury (whale-alert)', ok: false, stale: true, fetchedAt: '2026-11-24T09:00:00Z' },
    { name: 'Binance ticker24h', ok: true, stale: false }
  ], now);
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /3 ngày/);
  assert.match(alerts[1], /lỗi, đang dùng dữ liệu cũ \(nhận cách đây 3 giờ\)/);
});
