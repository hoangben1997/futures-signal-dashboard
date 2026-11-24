/**
 * Replay walk-forward replay-v1 (docs/P1_SPEC.md §7).
 * Thuần: nhận bars của dataset-v1, trả dự báo từng origin và bảng tổng hợp.
 * Không đọc/ghi file, không gọi mạng.
 */
import { DAY_MS, featuresAt, labelFor, SPEC } from './pit.js';

export const REPLAY_VERSION = 'replay-v1';
export const CLASSES = ['bullish', 'sideways', 'bearish'];
export const REPLAY_SPEC = Object.freeze({
  version: REPLAY_VERSION,
  windowDays: 730,
  alphas: [20, 50, 100],
  validationSize: 180,
  smoothing: 1,
  bootstrap: { blockLength: 7, sensitivityBlocks: [1, 30], iterations: 2000, seed: 12345, ci: 0.9 },
  nullSeed: 12345,
  holdoutStartUtc: '2025-11-24T00:00:00.000Z'
});

const LOG_FLOOR = 1e-6;

/* ------------------------------ metric ------------------------------ */

export function brier(p, label) {
  return CLASSES.reduce((s, c, i) => s + ((p[i] - (c === label ? 1 : 0)) ** 2), 0);
}

export function logLoss(p, label) {
  return -Math.log(Math.max(p[CLASSES.indexOf(label)], LOG_FLOOR));
}

export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** RNG mulberry32: deterministic theo seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ dữ liệu ------------------------------ */

export function cellOf(obs) {
  return (obs.trend50 >= 0 ? 2 : 0) + (obs.mom1z >= 0 ? 1 : 0);
}

/** Mỗi origin: feature point-in-time + nhãn. Chỉ giữ origin có feature hợp lệ và có nhãn. */
export function buildObservations(bars) {
  const out = [];
  for (const bar of bars) {
    const asOf = bar.closeTime + 1;
    const f = featuresAt(bars, asOf);
    if (!f.valid) continue;
    const l = labelFor(bars, f.originOpenTime, f.sigma);
    if (!l.label) continue;
    const obs = {
      originOpenTime: f.originOpenTime,
      asOf,
      knownAt: l.knownAt,
      label: l.label,
      z: l.r / f.sigma,
      sigma: f.sigma,
      mom1z: f.mom1z,
      trend50: f.trend50
    };
    obs.cell = cellOf(obs);
    out.push(obs);
  }
  return out;
}

/* ------------------------------ mô hình ------------------------------ */

export function climatology(obs, smoothing = REPLAY_SPEC.smoothing) {
  const counts = CLASSES.map((c) => obs.filter((o) => o.label === c).length);
  const n = obs.length;
  return counts.map((k) => (k + smoothing) / (n + (smoothing * CLASSES.length)));
}

export const GAUSS_REFERENCE = (() => {
  // Φ(0,5) = 0,691462461274013 → p_side = 2Φ(k) − 1
  const side = (2 * 0.691462461274013) - 1;
  const tail = (1 - side) / 2;
  return [tail, side, tail];
})();

/** M1: Dirichlet shrinkage của tần suất theo ô về p0. Trả mảng 4 vector xác suất. */
export function fitShrinkage(obs, alpha, p0, cellKey = 'cell') {
  return [0, 1, 2, 3].map((cell) => {
    const inCell = obs.filter((o) => o[cellKey] === cell);
    const n = inCell.length;
    return CLASSES.map((c, i) => (inCell.filter((o) => o.label === c).length + (alpha * p0[i])) / (n + alpha));
  });
}

function windowObs(obs, cutoffMs, windowDays) {
  const start = cutoffMs - (windowDays * DAY_MS);
  return obs.filter((o) => o.knownAt <= cutoffMs && o.originOpenTime >= start);
}

/**
 * CV lồng: validation = `validationSize` origin cuối của train; fit trên cửa sổ `windowDays`
 * kết thúc trước validation (lấy từ `knownObs`, chỉ nhãn đã biết tại lúc bắt đầu validation).
 * Hoà thì chọn α lớn hơn.
 */
export function chooseAlpha(trainObs, knownObs, spec = REPLAY_SPEC, cellKey = 'cell') {
  const sorted = [...trainObs].sort((a, b) => a.originOpenTime - b.originOpenTime);
  const val = sorted.slice(-spec.validationSize);
  if (val.length < spec.validationSize) return { alpha: Math.max(...spec.alphas), scores: null };
  const valStart = val[0].asOf;
  const fitSet = windowObs(knownObs, valStart, spec.windowDays);
  const p0 = climatology(fitSet, spec.smoothing);
  const scores = {};
  let best = null;
  for (const alpha of [...spec.alphas].sort((a, b) => b - a)) {
    const model = fitShrinkage(fitSet, alpha, p0, cellKey);
    const score = mean(val.map((o) => brier(model[o[cellKey]], o.label)));
    scores[alpha] = score;
    if (best === null || score < best.score - 1e-12) best = { alpha, score };
  }
  return { alpha: best.alpha, scores };
}

function monthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextMonth(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Walk-forward theo tháng. Origin ≥ holdout bị loại hoàn toàn.
 * Trả mảng dự báo theo origin, mỗi phần tử gồm p của M0, B2, G, M1, NULL.
 */
export function runReplay(observations, spec = REPLAY_SPEC) {
  const holdoutStart = Date.parse(spec.holdoutStartUtc);
  const obs = observations
    .filter((o) => o.originOpenTime < holdoutStart)
    .map((o) => ({ ...o }))
    .sort((a, b) => a.originOpenTime - b.originOpenTime);
  if (!obs.length) return { predictions: [], folds: [] };

  // Đối chứng null: ô ngẫu nhiên, độc lập với dữ liệu
  const rand = rng(spec.nullSeed);
  for (const o of obs) o.nullCell = Math.floor(rand() * 4);

  const firstEligible = obs[0].originOpenTime + (spec.windowDays * DAY_MS);
  let cutoff = monthStart(firstEligible) < firstEligible ? nextMonth(firstEligible) : monthStart(firstEligible);
  const lastAsOf = obs[obs.length - 1].asOf;
  const predictions = [];
  const folds = [];

  for (; cutoff <= lastAsOf; cutoff = nextMonth(cutoff)) {
    const end = nextMonth(cutoff);
    const test = obs.filter((o) => o.asOf >= cutoff && o.asOf < end);
    if (!test.length) continue;
    const known = obs.filter((o) => o.knownAt <= cutoff);
    const train = windowObs(known, cutoff, spec.windowDays);
    const pM0 = climatology(train, spec.smoothing);
    const pB2 = climatology(known, spec.smoothing);
    const { alpha, scores } = chooseAlpha(train, known, spec, 'cell');
    const m1 = fitShrinkage(train, alpha, pM0, 'cell');
    const { alpha: nullAlpha } = chooseAlpha(train, known, spec, 'nullCell');
    const mNull = fitShrinkage(train, nullAlpha, pM0, 'nullCell');
    folds.push({
      cutoff: new Date(cutoff).toISOString(),
      trainSize: train.length,
      trainFirst: new Date(train[0].originOpenTime).toISOString(),
      maxTrainKnownAt: new Date(Math.max(...train.map((o) => o.knownAt))).toISOString(),
      testSize: test.length,
      alpha,
      alphaScores: scores,
      nullAlpha
    });
    for (const o of test) {
      predictions.push({
        originOpenTime: o.originOpenTime,
        label: o.label,
        cell: o.cell,
        alpha,
        fold: new Date(cutoff).toISOString().slice(0, 7),
        p: { M0: pM0, B2: pB2, G: GAUSS_REFERENCE, M1: m1[o.cell], NULL: mNull[o.nullCell] }
      });
    }
  }
  return { predictions, folds };
}

/* ------------------------------ tổng hợp ------------------------------ */

/** Circular block bootstrap ghép cặp cho BSS = 1 − mean(loss_model)/mean(loss_base). */
export function bootstrapBss(lossModel, lossBase, { blockLength, iterations, seed, ci }) {
  const n = lossModel.length;
  const rand = rng(seed);
  const stats = [];
  const blocks = Math.ceil(n / blockLength);
  for (let it = 0; it < iterations; it += 1) {
    let sm = 0;
    let sb = 0;
    let count = 0;
    for (let b = 0; b < blocks; b += 1) {
      const start = Math.floor(rand() * n);
      for (let j = 0; j < blockLength && count < n; j += 1) {
        const idx = (start + j) % n;
        sm += lossModel[idx];
        sb += lossBase[idx];
        count += 1;
      }
    }
    stats.push(1 - (sm / sb));
  }
  stats.sort((a, b) => a - b);
  const lo = stats[Math.floor(((1 - ci) / 2) * iterations)];
  const hi = stats[Math.ceil((1 - ((1 - ci) / 2)) * iterations) - 1];
  return { lower: lo, upper: hi };
}

export function reliability(predictions, model, bins = 10) {
  const perClass = {};
  CLASSES.forEach((c, ci) => {
    const rows = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, hits: 0 }));
    for (const pr of predictions) {
      const p = pr.p[model][ci];
      const b = Math.min(bins - 1, Math.floor(p * bins));
      rows[b].n += 1;
      rows[b].sumP += p;
      rows[b].hits += pr.label === c ? 1 : 0;
    }
    const n = predictions.length;
    const ece = rows.reduce((s, r) => (r.n ? s + ((r.n / n) * Math.abs((r.sumP / r.n) - (r.hits / r.n))) : s), 0);
    perClass[c] = {
      ece,
      bins: rows.map((r, i) => (r.n ? { bin: i, n: r.n, meanP: r.sumP / r.n, freq: r.hits / r.n } : null)).filter(Boolean)
    };
  });
  return perClass;
}

function sd(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * (10 ** d)) / (10 ** d) : null);

export function summarize(predictions, folds, spec = REPLAY_SPEC) {
  const models = ['M0', 'B2', 'G', 'M1', 'NULL'];
  const loss = {};
  for (const m of models) {
    loss[m] = {
      brier: predictions.map((p) => brier(p.p[m], p.label)),
      logLoss: predictions.map((p) => logLoss(p.p[m], p.label))
    };
  }
  const meanBrierM0 = mean(loss.M0.brier);
  const byModel = {};
  for (const m of models) {
    const b = mean(loss[m].brier);
    byModel[m] = {
      brier: round(b),
      logLoss: round(mean(loss[m].logLoss)),
      bssVsM0: round(1 - (b / meanBrierM0))
    };
  }

  const { bootstrap } = spec;
  const ci = {};
  for (const m of ['M1', 'NULL', 'B2']) {
    ci[m] = {};
    for (const block of [bootstrap.blockLength, ...bootstrap.sensitivityBlocks]) {
      const r = bootstrapBss(loss[m].brier, loss.M0.brier, { ...bootstrap, blockLength: block });
      ci[m][`block${block}`] = { lower: round(r.lower), upper: round(r.upper) };
    }
  }

  const years = [...new Set(predictions.map((p) => new Date(p.originOpenTime).getUTCFullYear()))];
  const byYear = years.map((y) => {
    const idx = predictions.map((p, i) => (new Date(p.originOpenTime).getUTCFullYear() === y ? i : -1)).filter((i) => i >= 0);
    const b0 = mean(idx.map((i) => loss.M0.brier[i]));
    const b1 = mean(idx.map((i) => loss.M1.brier[i]));
    return { year: y, n: idx.length, brierM0: round(b0), brierM1: round(b1), bssM1: round(1 - (b1 / b0)) };
  });

  const baseRates = Object.fromEntries(CLASSES.map((c) => [c, round(predictions.filter((p) => p.label === c).length / predictions.length)]));
  const m1Dist = Object.fromEntries(CLASSES.map((c, i) => {
    const v = predictions.map((p) => p.p.M1[i]);
    return [c, { mean: round(mean(v)), sd: round(sd(v)), min: round(Math.min(...v)), max: round(Math.max(...v)) }];
  }));
  const alphaCounts = folds.reduce((acc, f) => ({ ...acc, [f.alpha]: (acc[f.alpha] || 0) + 1 }), {});
  const relM1 = reliability(predictions, 'M1');
  const relM0 = reliability(predictions, 'M0');

  const m1 = byModel.M1;
  const m1Ci = ci.M1[`block${bootstrap.blockLength}`];
  const gate = {
    bssPositive: m1.bssVsM0 > 0,
    ciLowerPositive: m1Ci.lower > 0,
    logLossNotWorse: m1.logLoss <= byModel.M0.logLoss
  };
  gate.passed = gate.bssPositive && gate.ciLowerPositive && gate.logLossNotWorse;

  return {
    n: predictions.length,
    firstOrigin: predictions.length ? new Date(predictions[0].originOpenTime).toISOString().slice(0, 10) : null,
    lastOrigin: predictions.length ? new Date(predictions[predictions.length - 1].originOpenTime).toISOString().slice(0, 10) : null,
    folds: folds.length,
    baseRates,
    byModel,
    ci,
    byYear,
    m1Distribution: m1Dist,
    alphaCounts,
    ece: {
      M1: Object.fromEntries(CLASSES.map((c) => [c, round(relM1[c].ece)])),
      M0: Object.fromEntries(CLASSES.map((c) => [c, round(relM0[c].ece)]))
    },
    reliabilityM1: relM1,
    gate
  };
}

export const SPEC_VERSIONS = Object.freeze({
  replay: REPLAY_VERSION,
  sigma: SPEC.sigma.version,
  label: SPEC.label.version,
  features: SPEC.features.version
});
