import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSeries,
  buildManifest,
  fetchKlinesRange,
  normalizeKline,
  parseJsonl,
  toJsonl
} from '../lib/dataset.js';

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2024, 0, 1);

function kline(dayIndex, close = 100 + dayIndex) {
  const open = T0 + (dayIndex * DAY);
  return [open, String(close - 1), String(close + 2), String(close - 2), String(close), '10', open + DAY - 1, '1000', 50, '5', '500', '0'];
}

test('normalizeKline: đủ 11 trường số, thiếu trường thì null', () => {
  const row = normalizeKline(kline(0));
  assert.equal(row.openTime, T0);
  assert.equal(row.closeTime, T0 + DAY - 1);
  assert.equal(row.close, 100);
  assert.equal(row.takerBuyQuote, 500);
  assert.equal(normalizeKline([1, 2, 3]), null);
  assert.equal(normalizeKline([...kline(0).slice(0, 4), 'x', ...kline(0).slice(5)]), null);
});

test('buildSeries: bỏ nến sau cutoff, gộp trùng giống hệt, báo conflict và gap', () => {
  const cutoff = T0 + (6 * DAY);
  const raw = [
    kline(2), kline(0), kline(1), kline(1), // trùng giống hệt
    kline(3, 999), kline(3), // conflict: cùng openTime, khác close
    kline(5), // gap: thiếu ngày 4
    kline(6), // closeTime ≥ cutoff → bỏ
    [1, 2]
  ];
  const s = buildSeries(raw, { interval: '1d', cutoffMs: cutoff });
  assert.deepEqual(s.rows.map((r) => (r.openTime - T0) / DAY), [0, 1, 2, 3, 5]);
  assert.equal(s.duplicatesDropped, 1);
  assert.equal(s.invalidRows, 1);
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].openTime, T0 + (3 * DAY));
  assert.deepEqual(s.gaps, [{ from: T0 + (4 * DAY), to: T0 + (4 * DAY), missingBars: 1 }]);
});

test('JSONL + checksum: idempotent và không phụ thuộc thứ tự input', () => {
  const cutoff = T0 + (10 * DAY);
  const a = buildSeries([kline(0), kline(1), kline(2)], { interval: '1d', cutoffMs: cutoff });
  const b = buildSeries([kline(2), kline(0), kline(1), kline(0)], { interval: '1d', cutoffMs: cutoff });
  const ja = toJsonl(a.rows);
  const jb = toJsonl(b.rows);
  assert.equal(ja, jb);
  const ma = buildManifest({ symbol: 'BTCUSDT', interval: '1d', cutoffMs: cutoff, series: a, jsonl: ja, fetchedAt: 'x' });
  const mb = buildManifest({ symbol: 'BTCUSDT', interval: '1d', cutoffMs: cutoff, series: b, jsonl: jb, fetchedAt: 'y' });
  assert.equal(ma.sha256, mb.sha256);
  assert.equal(ma.rows, 3);
  assert.equal(ma.cutoffUtc, '2024-01-11T00:00:00.000Z');
  assert.deepEqual(parseJsonl(ja), a.rows);
});

test('fetchKlinesRange: phân trang theo startTime, dừng khi trang thiếu', async () => {
  const all = Array.from({ length: 3200 }, (_, i) => kline(i));
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    const start = Number(new URL(url).searchParams.get('startTime'));
    const limit = Number(new URL(url).searchParams.get('limit'));
    return all.filter((k) => k[0] >= start).slice(0, limit);
  };
  const raw = await fetchKlinesRange({ fetchJson, symbol: 'BTCUSDT', interval: '1d', startMs: T0, cutoffMs: T0 + (4000 * DAY) });
  assert.equal(raw.length, 3200);
  assert.equal(urls.length, 3);
  assert.equal(Number(new URL(urls[1]).searchParams.get('startTime')), T0 + (1500 * DAY));
});
