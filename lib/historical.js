/**
 * Mô hình kịch bản lịch sử cũ (chuyển nguyên văn từ server.js, chỉ thêm import `clamp` bị thiếu).
 * ĐÃ CÁCH LY khỏi luồng snapshot (REVISED_ROADMAP P0): thiết kế có leakage và chưa chứng minh
 * được skill ngoài mẫu (docs/SYSTEM_AUDIT.md §3.4, docs/INDEPENDENT_REVIEW.md §4).
 * Chỉ dùng để tái lập / debug offline. Không đưa kết quả lên dashboard.
 */
import { clamp, finiteOr, num, percentile, std, toClosedKlines } from './stats.js';
function signBucket(value, eps = 0.02) {
  if (!Number.isFinite(value)) return 'flat';
  if (value > eps) return 'up';
  if (value < -eps) return 'down';
  return 'flat';
}

function classifyOutcome(futureChangePct, thresholdPct) {
  if (!Number.isFinite(futureChangePct) || !Number.isFinite(thresholdPct) || thresholdPct <= 0) return 'sideway';
  if (futureChangePct >= thresholdPct) return 'up';
  if (futureChangePct <= -thresholdPct) return 'down';
  return 'sideway';
}

function incrementOutcome(target, outcome) {
  if (outcome === 'up') target.up += 1;
  else if (outcome === 'down') target.down += 1;
  else target.sideway += 1;
}

function emptyOutcomeCounts() {
  return { up: 0, down: 0, sideway: 0 };
}

function probsFromCounts(counts) {
  const total = (counts.up || 0) + (counts.down || 0) + (counts.sideway || 0);
  if (!total) return null;
  return {
    samples: total,
    up: (counts.up / total) * 100,
    down: (counts.down / total) * 100,
    sideway: (counts.sideway / total) * 100
  };
}

function normalize3(up, down, sideway) {
  let a = Number.isFinite(up) ? up : 0;
  let b = Number.isFinite(down) ? down : 0;
  let c = Number.isFinite(sideway) ? sideway : 0;
  a = Math.max(0.5, a);
  b = Math.max(0.5, b);
  c = Math.max(0.5, c);
  const total = a + b + c;
  return { up: (a / total) * 100, down: (b / total) * 100, sideway: (c / total) * 100 };
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || !values.length || period <= 1) return [];
  const out = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    const v = values[i];
    prev = (v * k) + (prev * (1 - k));
    out.push(prev);
  }
  return out;
}

function latestPositionState(closes, lookback = 90) {
  if (!Array.isArray(closes) || closes.length < Math.max(lookback, 3)) return 'mid';
  const window = closes.slice(-lookback);
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  const last = closes[closes.length - 1];
  const r = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  if (r >= 0.7) return 'high';
  if (r <= 0.3) return 'low';
  return 'mid';
}

function stateEdge(counts, state) {
  const row = counts?.[state];
  if (!row) return { edge: 0, samples: 0 };
  const total = (row.up || 0) + (row.down || 0) + (row.sideway || 0);
  if (!total) return { edge: 0, samples: 0 };
  const rawEdge = ((row.up || 0) - (row.down || 0)) / total;
  const shrink = Math.min(1, total / 80);
  return { edge: rawEdge * shrink, samples: total };
}

function buildFeatureCountsStructure() {
  return {
    trend: { bull: emptyOutcomeCounts(), bear: emptyOutcomeCounts() },
    momentum: { up: emptyOutcomeCounts(), down: emptyOutcomeCounts(), flat: emptyOutcomeCounts() },
    position: { high: emptyOutcomeCounts(), mid: emptyOutcomeCounts(), low: emptyOutcomeCounts() },
    volatility: { high: emptyOutcomeCounts(), low: emptyOutcomeCounts() }
  };
}

export function computeScenarioProbsFromState(countsAll, buckets, featureCounts, sampleState) {
  const all = probsFromCounts(countsAll);
  if (!all) return null;

  const sign = sampleState.momentumState || 'flat';
  const volState = sampleState.volState || 'low';
  const conditional = probsFromCounts(buckets?.[`${sign}_${volState}`] || emptyOutcomeCounts());
  const base = (!conditional || conditional.samples < 35)
    ? { ...all, mode: 'unconditional' }
    : { ...conditional, mode: 'conditional' };

  const trendState = sampleState.trendState === 'bull' ? 'bull' : 'bear';
  const positionState = ['high', 'mid', 'low'].includes(sampleState.positionState) ? sampleState.positionState : 'mid';

  const eTrend = stateEdge(featureCounts?.trend, trendState);
  const eMomentum = stateEdge(featureCounts?.momentum, sign);
  const ePosition = stateEdge(featureCounts?.position, positionState);
  const eVol = stateEdge(featureCounts?.volatility, volState);

  const formulaScore = clamp(
    (eTrend.edge * 0.4) + (eMomentum.edge * 0.3) + (ePosition.edge * 0.2) + (eVol.edge * 0.1),
    -1,
    1
  );
  const tilt = formulaScore * 12;
  const adjusted = normalize3(
    base.up + tilt,
    base.down - tilt,
    base.sideway - Math.abs(formulaScore) * 4
  );

  return {
    ...adjusted,
    mode: base.mode,
    formulaScore
  };
}

export function computeBacktestMetrics(samples) {
  if (!Array.isArray(samples) || samples.length < 140) return null;
  const split = Math.floor(samples.length * 0.7);
  const train = samples.slice(0, split);
  const test = samples.slice(split);
  if (train.length < 80 || test.length < 40) return null;

  const countsAll = emptyOutcomeCounts();
  const buckets = {};
  const featureCounts = buildFeatureCountsStructure();

  for (const s of train) {
    incrementOutcome(countsAll, s.outcome);
    const key = `${s.momentumState}_${s.volState}`;
    if (!buckets[key]) buckets[key] = emptyOutcomeCounts();
    incrementOutcome(buckets[key], s.outcome);
    incrementOutcome(featureCounts.trend[s.trendState], s.outcome);
    incrementOutcome(featureCounts.momentum[s.momentumState], s.outcome);
    incrementOutcome(featureCounts.position[s.positionState], s.outcome);
    incrementOutcome(featureCounts.volatility[s.volState], s.outcome);
  }

  let brier = 0;
  let top1Hits = 0;
  let dirHits = 0;
  let dirTotal = 0;

  for (const s of test) {
    const probs = computeScenarioProbsFromState(countsAll, buckets, featureCounts, s);
    if (!probs) continue;

    const pUp = probs.up / 100;
    const pDown = probs.down / 100;
    const pSide = probs.sideway / 100;
    const oUp = s.outcome === 'up' ? 1 : 0;
    const oDown = s.outcome === 'down' ? 1 : 0;
    const oSide = s.outcome === 'sideway' ? 1 : 0;
    brier += (((pUp - oUp) ** 2) + ((pDown - oDown) ** 2) + ((pSide - oSide) ** 2)) / 3;

    const pred = pUp >= pDown && pUp >= pSide ? 'up' : pDown >= pUp && pDown >= pSide ? 'down' : 'sideway';
    if (pred === s.outcome) top1Hits += 1;
    if (s.outcome === 'up' || s.outcome === 'down') {
      dirTotal += 1;
      if (pred === s.outcome) dirHits += 1;
    }
  }

  const n = test.length || 1;
  return {
    testSamples: test.length,
    brierScore: num((brier / n).toFixed(4)),
    top1AccuracyPct: num(((top1Hits * 100) / n).toFixed(2)),
    directionalAccuracyPct: dirTotal ? num(((dirHits * 100) / dirTotal).toFixed(2)) : null
  };
}

function klineIntervalMs(interval) {
  if (interval === '4h') return 4 * 60 * 60 * 1000;
  if (interval === '1d') return 24 * 60 * 60 * 1000;
  throw new Error(`Unsupported interval: ${interval}`);
}

async function fetchBinanceKlinesRange(fetchJson, symbol, interval, startTimeMs, endTimeMs, limit = 1000, maxPages = 6) {
  const rows = [];
  const seen = new Set();
  const stepMs = klineIntervalMs(interval);
  let cursor = startTimeMs;

  for (let page = 0; page < maxPages && cursor < endTimeMs; page += 1) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTimeMs}&limit=${limit}`;
    const batch = await fetchJson(url, 12000);
    if (!Array.isArray(batch) || !batch.length) break;

    for (const k of batch) {
      const openTime = num(k?.[0]);
      if (!Number.isFinite(openTime) || seen.has(openTime)) continue;
      seen.add(openTime);
      rows.push(k);
    }

    const lastOpen = num(batch[batch.length - 1]?.[0]);
    if (!Number.isFinite(lastOpen)) break;
    const nextCursor = lastOpen + stepMs;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }

  rows.sort((a, b) => num(a?.[0]) - num(b?.[0]));
  return rows;
}

export function buildHistoricalTfStats(closes, horizonBars, thresholdPct, volWindowBars = 24) {
  const countsAll = { up: 0, down: 0, sideway: 0 };
  const samples = [];
  if (!Array.isArray(closes) || closes.length < horizonBars + volWindowBars + 3) {
    return { countsAll, buckets: {}, medianVol: null, samples: 0, featureCounts: {} };
  }

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);

  for (let i = volWindowBars; i + horizonBars < closes.length; i += 1) {
    const nowPrice = closes[i];
    const prevPrice = closes[i - horizonBars];
    const nextPrice = closes[i + horizonBars];
    if (!nowPrice || !prevPrice || !nextPrice) continue;

    const momentum = ((nowPrice - prevPrice) / prevPrice) * 100;
    const futureChange = ((nextPrice - nowPrice) / nowPrice) * 100;
    const outcome = classifyOutcome(futureChange, thresholdPct);

    const logRets = [];
    for (let j = i - volWindowBars + 1; j <= i; j += 1) {
      const a = closes[j - 1];
      const b = closes[j];
      if (a > 0 && b > 0) logRets.push(Math.log(b / a));
    }
    const vol = std(logRets);
    if (!Number.isFinite(vol)) continue;

    const hi = Math.max(...closes.slice(Math.max(0, i - 89), i + 1));
    const lo = Math.min(...closes.slice(Math.max(0, i - 89), i + 1));
    const posRatio = hi > lo ? (nowPrice - lo) / (hi - lo) : 0.5;
    const positionState = posRatio >= 0.7 ? 'high' : posRatio <= 0.3 ? 'low' : 'mid';
    const trendState = (Number.isFinite(ema20[i]) && Number.isFinite(ema50[i]) && ema20[i] >= ema50[i]) ? 'bull' : 'bear';

    samples.push({
      momentum,
      momentumState: signBucket(momentum),
      vol: vol * 100,
      positionState,
      trendState,
      outcome
    });
    incrementOutcome(countsAll, outcome);
  }

  const medianVol = percentile(samples.map((x) => x.vol), 50);
  const buckets = {};
  const featureCounts = buildFeatureCountsStructure();

  for (const s of samples) {
    const sign = s.momentumState;
    const volState = Number.isFinite(medianVol) && s.vol >= medianVol ? 'high' : 'low';
    s.volState = volState;
    const key = `${sign}_${volState}`;
    if (!buckets[key]) buckets[key] = { up: 0, down: 0, sideway: 0 };
    incrementOutcome(buckets[key], s.outcome);
    incrementOutcome(featureCounts.trend[s.trendState], s.outcome);
    incrementOutcome(featureCounts.momentum[sign], s.outcome);
    incrementOutcome(featureCounts.position[s.positionState], s.outcome);
    incrementOutcome(featureCounts.volatility[volState], s.outcome);
  }

  return {
    countsAll,
    buckets,
    featureCounts,
    medianVol: Number.isFinite(medianVol) ? medianVol : null,
    samples: samples.length,
    backtest: computeBacktestMetrics(samples)
  };
}

export function pickHistoricalProbs(stats, context) {
  if (!stats) return null;
  const all = probsFromCounts(stats.countsAll);
  if (!all) return null;

  const sign = signBucket(context?.momentumPct);
  const volState = Number.isFinite(stats.medianVol) && Number.isFinite(context?.volPct) && context.volPct >= stats.medianVol ? 'high' : 'low';
  const trendState = context?.trendState === 'bull' ? 'bull' : 'bear';
  const positionState = ['high', 'mid', 'low'].includes(context?.positionState) ? context.positionState : 'mid';
  const probs = computeScenarioProbsFromState(stats.countsAll, stats.buckets, stats.featureCounts, {
    momentumState: sign,
    volState,
    trendState,
    positionState
  });
  if (!probs) return { ...all, mode: 'unconditional' };

  const eTrend = stateEdge(stats.featureCounts?.trend, trendState);
  const eMomentum = stateEdge(stats.featureCounts?.momentum, sign);
  const ePosition = stateEdge(stats.featureCounts?.position, positionState);
  const eVol = stateEdge(stats.featureCounts?.volatility, volState);

  return {
    samples: probsFromCounts(stats.buckets?.[`${sign}_${volState}`] || emptyOutcomeCounts())?.samples
      || probsFromCounts(stats.countsAll)?.samples
      || 0,
    up: probs.up,
    down: probs.down,
    sideway: probs.sideway,
    mode: probs.mode || 'unconditional',
    formulaScore: probs.formulaScore,
    drivers: {
      trend: { state: trendState, edge: eTrend.edge, samples: eTrend.samples },
      momentum: { state: sign, edge: eMomentum.edge, samples: eMomentum.samples },
      position: { state: positionState, edge: ePosition.edge, samples: ePosition.samples },
      volatility: { state: volState, edge: eVol.edge, samples: eVol.samples }
    }
  };
}

export async function getHistoricalScenarioModel(symbol, tfThresholdMap, metrics, { fetchJson, cache = new Map(), refreshMs = 6 * 60 * 60 * 1000 } = {}) {
  const nowMs = Date.now();
  const cached = cache.get(symbol);
  if (cached && (nowMs - cached.updatedAt) < refreshMs) {
    return cached.model;
  }

  const start4h = nowMs - (380 * 24 * 60 * 60 * 1000);
  const start1d = nowMs - (420 * 24 * 60 * 60 * 1000);
  const [k4h, k1d] = await Promise.all([
    fetchBinanceKlinesRange(fetchJson, symbol, '4h', start4h, nowMs, 1000, 6),
    fetchBinanceKlinesRange(fetchJson, symbol, '1d', start1d, nowMs, 1000, 2)
  ]);

  const close4h = toClosedKlines(k4h, nowMs).map((k) => num(k[4])).filter((x) => x !== null);
  const close1d = toClosedKlines(k1d, nowMs).map((k) => num(k[4])).filter((x) => x !== null);

  const fallbackThr = {
    '4h': 1.0, '8h': 1.2, '12h': 1.4, '1d': 2.0, '3d': 3.5, '1w': 5.0
  };
  const thresholds = {
    '4h': finiteOr(tfThresholdMap?.['4h'], fallbackThr['4h']),
    '8h': finiteOr(tfThresholdMap?.['8h'], fallbackThr['8h']),
    '12h': finiteOr(tfThresholdMap?.['12h'], fallbackThr['12h']),
    '1d': finiteOr(tfThresholdMap?.['1d'], fallbackThr['1d']),
    '3d': finiteOr(tfThresholdMap?.['3d'], fallbackThr['3d']),
    '1w': finiteOr(tfThresholdMap?.['1w'], fallbackThr['1w'])
  };

  const stats = {
    '4h': buildHistoricalTfStats(close4h, 1, thresholds['4h'], 18),
    '8h': buildHistoricalTfStats(close4h, 2, thresholds['8h'], 18),
    '12h': buildHistoricalTfStats(close4h, 3, thresholds['12h'], 18),
    '1d': buildHistoricalTfStats(close1d, 1, thresholds['1d'], 14),
    '3d': buildHistoricalTfStats(close1d, 3, thresholds['3d'], 14),
    '1w': buildHistoricalTfStats(close1d, 7, thresholds['1w'], 14)
  };

  const momentumNow = {
    '4h': finiteOr(metrics.closeChange4h, 0),
    '8h': finiteOr(metrics.closeChange4h, 0),
    '12h': finiteOr(metrics.closeChange4h, 0),
    '1d': finiteOr(metrics.closeChange1d, 0),
    '3d': finiteOr(metrics.closeChange1d, 0),
    '1w': finiteOr(metrics.closeChange1w, 0)
  };
  const currentVol = {
    '4h': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(4 / 24),
    '8h': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(8 / 24),
    '12h': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(12 / 24),
    '1d': finiteOr(metrics.realizedVol24h, 2.4),
    '3d': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(3),
    '1w': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(7)
  };
  const currentPosition4h = latestPositionState(close4h, 90);
  const currentPosition1d = latestPositionState(close1d, 90);
  const ema204h = emaSeries(close4h, 20);
  const ema504h = emaSeries(close4h, 50);
  const ema201d = emaSeries(close1d, 20);
  const ema501d = emaSeries(close1d, 50);
  const trendState4h = (ema204h.length && ema504h.length && ema204h[ema204h.length - 1] >= ema504h[ema504h.length - 1]) ? 'bull' : 'bear';
  const trendState1d = (ema201d.length && ema501d.length && ema201d[ema201d.length - 1] >= ema501d[ema501d.length - 1]) ? 'bull' : 'bear';

  const model = {};
  for (const tf of ['4h', '8h', '12h', '1d', '3d', '1w']) {
    const context = {
      momentumPct: momentumNow[tf],
      volPct: currentVol[tf],
      trendState: tf === '4h' || tf === '8h' || tf === '12h' ? trendState4h : trendState1d,
      positionState: tf === '4h' || tf === '8h' || tf === '12h' ? currentPosition4h : currentPosition1d
    };
    const probs = pickHistoricalProbs(stats[tf], context);
    if (!probs) continue;
    model[tf] = {
      up: num(probs.up?.toFixed(2)),
      down: num(probs.down?.toFixed(2)),
      sideway: num(probs.sideway?.toFixed(2)),
      samples: probs.samples,
      mode: probs.mode || 'unconditional',
      thresholdPct: thresholds[tf],
      formulaScore: num(probs.formulaScore?.toFixed(4)),
      drivers: probs.drivers,
      backtest: stats[tf].backtest || null
    };
  }

  const payload = {
    lookbackDays: 365,
    generatedAt: new Date(nowMs).toISOString(),
    byTimeframe: model
  };
  cache.set(symbol, { updatedAt: nowMs, model: payload });
  return payload;
}
