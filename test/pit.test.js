import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, SPEC, closedBars, ewmaSigma, featuresAt, labelFor } from '../lib/pit.js';

const T0 = Date.UTC(2024, 0, 1);

// Chuỗi giá giả định có biến động, đủ dài cho warm-up 60 return và SMA50.
function makeBars(n, { skip = [] } = {}) {
  const bars = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    close *= Math.exp(0.02 * Math.sin(i * 1.7) + 0.001);
    if (skip.includes(i)) continue;
    const openTime = T0 + (i * DAY_MS);
    bars.push({
      openTime,
      closeTime: openTime + DAY_MS - 1,
      open: close * 0.995,
      high: close * 1.01,
      low: close * 0.985,
      close,
      volume: 10
    });
  }
  return bars;
}

const asOfAfter = (bars, i) => bars[i].closeTime + 1;

test('ewmaSigma: warm-up 60 return, khởi tạo bằng trung bình r², có sàn 1%', () => {
  const flat = makeBars(61).map((b, i) => ({ ...b, close: 100 * Math.exp(0.001 * i) }));
  assert.equal(ewmaSigma(flat.slice(0, 60)), null);
  // r luôn = 0,001 → σ = 0,001, bị nâng lên sàn 0,01
  assert.equal(ewmaSigma(flat), 0.01);

  // Tính tay: 60 return = 0,03 → v = 0,0009; return thứ 61 = −0,05 → v = 0,94·0,0009 + 0,06·0,0025
  const closes = [100];
  for (let i = 0; i < 60; i += 1) closes.push(closes[closes.length - 1] * Math.exp(0.03));
  closes.push(closes[closes.length - 1] * Math.exp(-0.05));
  const bars = closes.map((c, i) => ({ openTime: T0 + (i * DAY_MS), close: c }));
  const expected = Math.sqrt((0.94 * 0.0009) + (0.06 * 0.0025));
  assert.ok(Math.abs(ewmaSigma(bars) - expected) < 1e-12);
});

test('featuresAt: không đủ warm-up thì invalid kèm lý do', () => {
  const bars = makeBars(40);
  const f = featuresAt(bars, asOfAfter(bars, 39));
  assert.equal(f.valid, false);
  assert.ok(f.reasons.includes('sigma_warmup'));
  assert.ok(f.reasons.includes('sma_warmup'));
});

test('point-in-time: cắt dữ liệu tại t cho cùng feature như dữ liệu đầy đủ với asOf = t', () => {
  const full = makeBars(200);
  for (const i of [70, 120, 199]) {
    const asOf = asOfAfter(full, i);
    const a = featuresAt(full.slice(0, i + 1), asOf);
    const b = featuresAt(full, asOf);
    assert.deepEqual(a, b);
    assert.equal(b.valid, true);
    assert.equal(b.originOpenTime, full[i].openTime);
  }
});

test('point-in-time: sửa dữ liệu sau cutoff hoặc thêm nến đang chạy không đổi feature', () => {
  const full = makeBars(150);
  const asOf = asOfAfter(full, 100);
  const before = featuresAt(full, asOf);
  const tampered = full.map((b, i) => (i > 100 ? { ...b, close: b.close * 3, high: b.high * 3 } : b));
  assert.deepEqual(featuresAt(tampered, asOf), before);

  // Nến đang chạy: open đúng lúc asOf, closeTime sau asOf
  const running = { openTime: asOf, closeTime: asOf + DAY_MS - 1, open: 1, high: 999, low: 1, close: 999 };
  assert.deepEqual(featuresAt([...full.slice(0, 101), running], asOf), before);
  assert.equal(closedBars([...full.slice(0, 101), running], asOf).length, 101);
});

test('featuresAt: cùng input cho cùng output', () => {
  const bars = makeBars(120);
  const asOf = asOfAfter(bars, 119);
  assert.deepEqual(featuresAt(bars, asOf), featuresAt(structuredClone(bars), asOf));
});

test('gap trong cửa sổ 60 ngày → invalid; mom1z không dùng nến cách gap', () => {
  const bars = makeBars(200, { skip: [100] });
  const idx = bars.findIndex((b) => b.openTime === T0 + (101 * DAY_MS));
  const f = featuresAt(bars, asOfAfter(bars, idx));
  assert.equal(f.valid, false);
  assert.ok(f.reasons.includes('prev_bar_missing'));
  assert.ok(f.reasons.includes('gap_in_window'));
  assert.equal(f.mom1z, null);

  // 70 ngày sau gap thì hợp lệ trở lại
  const later = featuresAt(bars, asOfAfter(bars, idx + 69));
  assert.equal(later.valid, true);
});

test('labelFor: target theo timestamp, thiếu target thì null, không lấy nến kế tiếp', () => {
  const bars = makeBars(150, { skip: [101] });
  const origin = bars.find((b) => b.openTime === T0 + (100 * DAY_MS));
  const l = labelFor(bars, origin.openTime, 0.02);
  assert.equal(l.label, null);
  assert.equal(l.reason, 'target_missing');
  assert.equal(l.knownAt, null);
});

test('labelFor: ranh giới r = ±band thuộc về tăng/giảm; knownAt = đóng nến target', () => {
  const bars = makeBars(10);
  const o = bars[5];
  const t = bars[6];
  const r = Math.log(t.close / o.close);
  const sigmaAtBoundary = Math.abs(r) / SPEC.label.k; // band = |r| đúng bằng nhau (k = 0,5 nhân chia chính xác)
  const atBoundary = labelFor(bars, o.openTime, sigmaAtBoundary);
  assert.equal(atBoundary.band, Math.abs(r));
  assert.equal(atBoundary.label, r > 0 ? 'bullish' : 'bearish');
  assert.equal(atBoundary.knownAt, t.closeTime + 1);

  const wide = labelFor(bars, o.openTime, (Math.abs(r) / SPEC.label.k) * 1.01);
  assert.equal(wide.label, 'sideways');
});

test('ví dụ trong spec: 60.000 → 60.724 với σ = 2,4% là bullish, 59.284 là bearish', () => {
  const mk = (close, day) => ({ openTime: T0 + (day * DAY_MS), closeTime: T0 + ((day + 1) * DAY_MS) - 1, close });
  assert.equal(labelFor([mk(60000, 0), mk(60725, 1)], T0, 0.024).label, 'bullish');
  assert.equal(labelFor([mk(60000, 0), mk(59284, 1)], T0, 0.024).label, 'bearish');
  assert.equal(labelFor([mk(60000, 0), mk(60500, 1)], T0, 0.024).label, 'sideways');
});
