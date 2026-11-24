import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brier,
  logLoss,
  climatology,
  fitShrinkage,
  chooseAlpha,
  runReplay,
  summarize,
  bootstrapBss,
  buildObservations,
  GAUSS_REFERENCE,
  REPLAY_SPEC,
  rng
} from '../lib/replay.js';
import { DAY_MS } from '../lib/pit.js';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const T0 = Date.UTC(2020, 0, 1);

function obsSeries(n, labelFn, { start = T0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const originOpenTime = start + (i * DAY_MS);
    const o = {
      originOpenTime,
      asOf: originOpenTime + DAY_MS,
      knownAt: originOpenTime + (2 * DAY_MS),
      label: labelFn(i),
      trend50: i % 2 ? 1 : -1,
      mom1z: i % 3 ? 1 : -1
    };
    o.cell = (o.trend50 >= 0 ? 2 : 0) + (o.mom1z >= 0 ? 1 : 0);
    return o;
  });
}

test('brier (tổng 3 lớp) và log loss: tính tay', () => {
  near(brier([0.2, 0.5, 0.3], 'bullish'), 0.64 + 0.25 + 0.09);
  near(brier([1 / 3, 1 / 3, 1 / 3], 'sideways'), 2 / 3);
  near(logLoss([0.2, 0.5, 0.3], 'bearish'), -Math.log(0.3));
  near(logLoss([0, 1, 0], 'bullish'), -Math.log(1e-6));
});

test('climatology: làm mượt Laplace (n_k + 1)/(N + 3)', () => {
  const obs = [{ label: 'bullish' }, { label: 'bullish' }, { label: 'sideways' }];
  const p = climatology(obs);
  near(p[0], 3 / 6);
  near(p[1], 2 / 6);
  near(p[2], 1 / 6);
});

test('Gauss reference: p_side = 2Φ(0,5) − 1 ≈ 0,3829', () => {
  near(GAUSS_REFERENCE[1], 0.382924922548026, 1e-12);
  near(GAUSS_REFERENCE[0] + GAUSS_REFERENCE[1] + GAUSS_REFERENCE[2], 1);
});

test('fitShrinkage: (n_k(s) + α·p0_k)/(N(s) + α); ô rỗng = p0', () => {
  const obs = [
    { cell: 3, label: 'bullish' }, { cell: 3, label: 'bullish' }, { cell: 3, label: 'bearish' }
  ];
  const p0 = [0.3, 0.4, 0.3];
  const m = fitShrinkage(obs, 20, p0);
  near(m[3][0], (2 + 6) / 23);
  near(m[3][1], (0 + 8) / 23);
  near(m[3][2], (1 + 6) / 23);
  assert.deepEqual(m[0], [0.3, 0.4, 0.3].map((v) => (20 * v) / 20));
});

test('chooseAlpha: hoà thì chọn α lớn nhất; ô mang thông tin thì chọn α nhỏ', () => {
  // Tập fit rỗng → mọi ô = p0 đều nhau với mọi α → hoà tuyệt đối
  const obs = obsSeries(1000, (i) => ['bullish', 'sideways', 'bearish'][i % 3]);
  assert.equal(chooseAlpha(obs.slice(-730), []).alpha, 100);

  // Nhãn quyết định hoàn toàn bởi ô → co ít (α nhỏ) cho Brier tốt hơn
  const byCell = ['bearish', 'sideways', 'sideways', 'bullish'];
  const informative = obsSeries(1000, () => null).map((o) => ({ ...o, label: byCell[o.cell] }));
  assert.equal(chooseAlpha(informative.slice(-730), informative).alpha, 20);
});

test('runReplay: purge, cửa sổ 730 ngày, loại holdout, tham số cố định trong tháng', () => {
  const r = rng(7);
  const labels = ['bullish', 'sideways', 'bearish'];
  // Chuỗi từ 2020-01-01 tới qua holdout 2025-11-24
  const n = Math.round((Date.UTC(2026, 0, 31) - T0) / DAY_MS);
  const obs = obsSeries(n, () => labels[Math.floor(r() * 3)]);
  const { predictions, folds } = runReplay(obs);
  const holdout = Date.parse(REPLAY_SPEC.holdoutStartUtc);
  assert.ok(predictions.length > 0);
  assert.ok(predictions.every((p) => p.originOpenTime < holdout), 'không có origin holdout');
  for (const f of folds) {
    const cutoff = Date.parse(f.cutoff);
    assert.ok(Date.parse(f.maxTrainKnownAt) <= cutoff, 'nhãn train phải biết trước cutoff');
    assert.ok(Date.parse(f.trainFirst) >= cutoff - (730 * DAY_MS), 'cửa sổ 730 ngày');
  }
  // Tháng test đầu tiên cách origin đầu ≥ 730 ngày
  assert.ok(Date.parse(folds[0].cutoff) >= T0 + (730 * DAY_MS));
  // Mọi dự báo trong cùng fold & cùng ô có cùng xác suất M1
  const byKey = new Map();
  for (const p of predictions) {
    const key = `${p.fold}:${p.cell}`;
    if (byKey.has(key)) assert.deepEqual(byKey.get(key), p.p.M1);
    else byKey.set(key, p.p.M1);
  }
  // Không đổi input
  assert.equal(obs[0].nullCell, undefined);
});

test('runReplay + summarize: tái lập (cùng input → cùng output); nhãn ngẫu nhiên → không qua cổng', () => {
  const r = rng(99);
  const labels = ['bullish', 'sideways', 'bearish'];
  const n = Math.round((Date.UTC(2025, 6, 1) - T0) / DAY_MS);
  const obs = obsSeries(n, () => labels[Math.floor(r() * 3)]);
  const a = runReplay(obs);
  const b = runReplay(obs);
  const sa = summarize(a.predictions, a.folds);
  const sb = summarize(b.predictions, b.folds);
  assert.deepEqual(sa, sb);
  assert.equal(sa.gate.passed, false);
});

test('bootstrapBss: deterministic theo seed; loss bằng nhau → CI = [0, 0]', () => {
  const base = Array.from({ length: 200 }, (_, i) => 0.6 + ((i % 7) * 0.01));
  const opts = { blockLength: 7, iterations: 500, seed: 1, ci: 0.9 };
  assert.deepEqual(bootstrapBss(base, base, opts), { lower: 0, upper: 0 });
  const better = base.map((v) => v * 0.9);
  const ci = bootstrapBss(better, base, opts);
  near(ci.lower, 0.1, 1e-9);
  near(ci.upper, 0.1, 1e-9);
  assert.deepEqual(bootstrapBss(better.map((v, i) => v + (i % 3) * 0.05), base, opts),
    bootstrapBss(better.map((v, i) => v + (i % 3) * 0.05), base, opts));
});

test('buildObservations: chỉ giữ origin có feature hợp lệ và có nhãn', () => {
  const bars = [];
  let close = 100;
  for (let i = 0; i < 120; i += 1) {
    close *= Math.exp(0.02 * Math.sin(i * 1.3));
    const openTime = T0 + (i * DAY_MS);
    bars.push({ openTime, closeTime: openTime + DAY_MS - 1, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 });
  }
  const obs = buildObservations(bars);
  // 60 return warm-up → origin đầu hợp lệ là nến thứ 61 (index 60); nến cuối không có target
  assert.equal(obs.length, 120 - 60 - 1);
  assert.equal(obs[0].originOpenTime, bars[60].openTime);
  assert.ok(obs.every((o) => o.knownAt === o.originOpenTime + (2 * DAY_MS)));
});
