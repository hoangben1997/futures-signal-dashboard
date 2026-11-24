import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoricalTfStats } from '../lib/historical.js';

// Regression: trước đây `clamp` không được định nghĩa nên nhánh backtest (≥ 140 mẫu) luôn throw.
test('historical (offline): ≥ 140 mẫu đi qua nhánh backtest không throw', () => {
  const closes = Array.from({ length: 400 }, (_, i) => 100 * (1 + 0.05 * Math.sin(i / 9) + 0.01 * Math.cos(i / 2)));
  const stats = buildHistoricalTfStats(closes, 1, 1.0, 14);
  assert.ok(stats.samples >= 140);
  assert.ok(stats.backtest);
  assert.ok(Number.isFinite(stats.backtest.brierScore));
  assert.equal(stats.backtest.testSamples, stats.samples - Math.floor(stats.samples * 0.7));
});
