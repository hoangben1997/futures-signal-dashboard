/**
 * Dashboard audit dashboard-audit-v1 (docs/AUDIT_SPEC.md): tái hiện snapshot dashboard tại mỗi
 * origin 00:00 UTC chỉ từ dữ liệu có trước origin, chạy đúng code dashboard (buildMetrics,
 * inferTrend, summarizeTimeframe, buildMarketReport), rồi chấm từng tín hiệu với kết quả 24h.
 * Thuần: nhận dữ liệu đã nạp, không đọc file, không gọi mạng.
 */
import { buildMetrics } from './metrics.js';
import { inferTrend } from './scoring.js';
import { buildMarketReport } from './analysis.js';
import { summarizeTimeframe } from './indicators.js';
import { DAY_MS } from './pit.js';
import { buildObservations, rng } from './replay.js';

const HOUR = 3600 * 1000;

export const AUDIT_SPEC = Object.freeze({
  version: 'dashboard-audit-v1',
  start: '2020-09-02T00:00:00.000Z',
  discoveryEnd: '2024-01-01T00:00:00.000Z', // origin < mốc này thuộc discovery
  end: '2025-11-24T00:00:00.000Z', // origin < mốc này (holdout P1 không dùng)
  timeframeHours: 24,
  klineLimits: { '1h': 72, '4h': 183, '1d': 37, '1w': 8 },
  technicalBars: 400,
  bootstrap: { blockLength: 7, iterations: 2000, seed: 12345, ci: 0.95 },
  minFired: 30,
  maxStaleMs: { metrics: 2 * HOUR, oiOld: HOUR, fearGreed: 3 * DAY_MS }
});

/** Chỉ số lớn nhất i có arr[i][key] < t (arr đã sort tăng theo key), hoặc -1. */
export function lastIndexBefore(arr, key, t, inclusive = false) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid][key];
    if (inclusive ? v <= t : v < t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function toKline(b) {
  return [b.openTime, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), b.closeTime,
    String(b.quoteVolume ?? 0), b.trades ?? 0, String(b.takerBuyBase ?? 0), String(b.takerBuyQuote ?? 0), '0'];
}

function closedSlice(bars, t, n) {
  const i = lastIndexBefore(bars, 'closeTime', t);
  return i < 0 ? [] : bars.slice(Math.max(0, i - n + 1), i + 1);
}

/** Bản ghi metrics 5m mới nhất trước t có giá trị field (không quá maxAge). */
function latestMetric(metrics5m, t, field, maxAgeMs, inclusive = false) {
  let i = lastIndexBefore(metrics5m, 't', t, inclusive);
  while (i >= 0 && metrics5m[i][field] === null) i -= 1;
  if (i < 0 || t - metrics5m[i].t > maxAgeMs) return null;
  return metrics5m[i];
}

/**
 * Dựng lại đầu vào API tại origin t (ms, 00:00 UTC). data: { bars: {'1h','4h','1d','1w','1M'},
 * funding, fng, metrics5m } đều sort tăng theo thời gian.
 */
export function reconstructInputs(data, t, spec = AUDIT_SPEC) {
  const { bars, funding, fng, metrics5m } = data;
  const lim = spec.klineLimits;
  const h1 = closedSlice(bars['1h'], t, Math.max(lim['1h'], 25));
  const last1h = h1[h1.length - 1];
  const prev24 = h1.length >= 25 ? h1[h1.length - 25] : null;

  const fIdx = lastIndexBefore(funding, 'fundingTime', t, true);
  const fgIdx = lastIndexBefore(fng, 'timestamp', t);
  const fg = fgIdx >= 0 && t - fng[fgIdx].timestamp <= spec.maxStaleMs.fearGreed ? fng[fgIdx] : null;

  const oiNow = latestMetric(metrics5m, t, 'oi', spec.maxStaleMs.metrics);
  const oiOld = latestMetric(metrics5m, t - (6 * HOUR), 'oi', spec.maxStaleMs.oiOld, true);
  const ls = latestMetric(metrics5m, t, 'globalAcc', spec.maxStaleMs.metrics);
  const top = latestMetric(metrics5m, t, 'topPos', spec.maxStaleMs.metrics);
  const takerDen = last1h ? last1h.volume - last1h.takerBuyBase : null;

  return {
    premium: fIdx >= 0 ? { lastFundingRate: String(funding[fIdx].fundingRate) } : null,
    oiNow: oiNow ? { openInterest: String(oiNow.oi) } : null,
    oiHist: oiNow && oiOld ? [oiOld, ...Array(5).fill(oiNow), oiNow].map((r) => ({ sumOpenInterest: String(r.oi) })) : null,
    lsHist: ls ? [{ longShortRatio: String(ls.globalAcc) }] : null,
    topTraderLs: top ? [{ longShortRatio: String(top.topPos) }] : null,
    takerFlow: last1h && takerDen > 0 ? [{ buySellRatio: String(last1h.takerBuyBase / takerDen) }] : null,
    ticker24h: last1h ? {
      lastPrice: String(last1h.close),
      priceChangePercent: prev24 ? String(((last1h.close / prev24.close) - 1) * 100) : null
    } : null,
    kline1h: h1.slice(-lim['1h']).map(toKline),
    kline4h: closedSlice(bars['4h'], t, lim['4h']).map(toKline),
    kline1d: closedSlice(bars['1d'], t, lim['1d']).map(toKline),
    kline1w: closedSlice(bars['1w'], t, lim['1w']).map(toKline),
    fearGreed: fg ? { data: [{ value: String(fg.value) }] } : null,
    deribit: null,
    coingeckoGlobal: null
  };
}

export function reconstructTechnicals(data, t, spec = AUDIT_SPEC) {
  const byTf = {};
  for (const tf of ['1M', '1w', '1d', '4h', '1h']) {
    const candles = closedSlice(data.bars[tf], t, spec.technicalBars)
      .map((b) => ({ time: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const s = summarizeTimeframe(candles, { closedCount: candles.length });
    if (s) byTf[tf] = s;
  }
  return { byTf };
}

/* ------------------------------ tín hiệu ------------------------------ */

const RULE_FAMILIES = {
  'rule:funding': /^Funding Rate/,
  'rule:oiFunding': /^OI /,
  'rule:globalLS': /^Global L\/S/,
  'rule:topTrader': /^Top Trader/,
  'rule:taker': /^Taker Flow/,
  'rule:fearGreed': /^Fear & Greed/,
  'rule:pricePumpDump': /^Price (Pump|Dump|Momentum)/
};
const DISSS_FAMILIES = ['price-long', 'price-short', 'volume', 'funding', 'oi', 'positioning', 'flow', 'sentiment'];

export function extractSignals(trend, report) {
  const s = {};
  for (const [key, re] of Object.entries(RULE_FAMILIES)) {
    const r = trend.rules.find((x) => re.test(x.name) && x.pass && x.score !== 0);
    s[key] = r ? Math.sign(r.score) : 0;
  }
  for (const [k, v] of Object.entries(trend.mappedTrend.components)) {
    s[`mapped:${k}`] = Number.isFinite(v) && Math.abs(v) >= 0.35 ? Math.sign(v) : 0;
  }
  s['headline:outlook'] = trend.outlook === 'Bullish Bias' ? 1 : trend.outlook === 'Bearish Bias' ? -1 : 0;
  const fam = Object.fromEntries((report?.families || []).map((f) => [f.family, f.direction]));
  for (const f of DISSS_FAMILIES) {
    s[`disss:${f}`] = fam[f] === 'bullish' ? 1 : fam[f] === 'bearish' ? -1 : 0;
  }
  const bias = report?.summary?.bias;
  s['disss:bias'] = bias === 'bullish' ? 1 : bias === 'bearish' ? -1 : 0;
  return s;
}

/**
 * Chạy dashboard tại mọi origin trong [start, end). opts.trendFn / opts.reportFn cho phép
 * chạy lại với rule đã bỏ để so trước/sau.
 */
export function runAudit(data, spec = AUDIT_SPEC, { trendFn = inferTrend, reportFn = buildMarketReport } = {}) {
  const obs = buildObservations(data.bars['1d']);
  const outcomeByAsOf = new Map(obs.map((o) => [o.asOf, o]));
  const dailyByOpen = new Map(data.bars['1d'].map((b) => [b.openTime, b]));
  const start = Date.parse(spec.start);
  const end = Date.parse(spec.end);
  const rows = [];
  for (let t = start; t < end; t += DAY_MS) {
    const o = outcomeByAsOf.get(t);
    if (!o) continue;
    const raw = reconstructInputs(data, t, spec);
    const metrics = buildMetrics({ symbol: 'BTCUSDT', asOf: new Date(t).toISOString(), nowMs: t, ...raw });
    const trend = trendFn(metrics, spec.timeframeHours);
    const technicals = reconstructTechnicals(data, t, spec);
    const report = reportFn({
      symbol: 'BTCUSDT',
      metrics,
      technicals,
      calendar: [],
      usdcEvents: [],
      sourceHealth: { onchain: { ok: false, stale: false } },
      nowMs: t
    });
    const c0 = dailyByOpen.get(o.originOpenTime)?.close;
    const c7 = dailyByOpen.get(o.originOpenTime + (7 * DAY_MS))?.close;
    rows.push({
      t,
      d: o.label === 'bullish' ? 1 : o.label === 'bearish' ? -1 : 0,
      d7: c0 && c7 ? Math.sign(Math.log(c7 / c0)) : null,
      signals: extractSignals(trend, report),
      inputsPresent: {
        funding: metrics.fundingRate !== null,
        oi: metrics.openInterestChange6h !== null,
        ls: metrics.longShortRatio !== null,
        top: metrics.topTraderLongShortRatio !== null,
        taker: metrics.takerBuySellRatio !== null,
        fng: metrics.fearGreed !== null
      }
    });
  }
  return rows;
}

/* ------------------------------ chấm điểm ------------------------------ */

function edgeStat(rows, idx, key, outKey, dbar) {
  let num = 0;
  let den = 0;
  for (const i of idx) {
    const s = rows[i].signals[key];
    const d = rows[i][outKey];
    if (!s || d === null || d === undefined) continue;
    num += s * (d - dbar);
    den += Math.abs(s);
  }
  return den ? num / den : null;
}

/** Edge có dấu + CI block bootstrap trên một giai đoạn. */
export function evaluateSignal(rows, key, { outKey = 'd', bootstrap = AUDIT_SPEC.bootstrap } = {}) {
  const valid = rows.map((r, i) => (r[outKey] === null || r[outKey] === undefined ? -1 : i)).filter((i) => i >= 0);
  const dbar = valid.reduce((s, i) => s + rows[i][outKey], 0) / (valid.length || 1);
  const fired = valid.filter((i) => rows[i].signals[key]);
  const pos = fired.filter((i) => rows[i].signals[key] > 0);
  const neg = fired.filter((i) => rows[i].signals[key] < 0);
  const freq = (set, v) => (set.length ? set.filter((i) => rows[i][outKey] === v).length / set.length : null);
  const E = edgeStat(rows, valid, key, outKey, dbar);

  let ci = null;
  if (fired.length) {
    const rand = rng(bootstrap.seed);
    const n = valid.length;
    const stats = [];
    for (let it = 0; it < bootstrap.iterations; it += 1) {
      const sample = [];
      while (sample.length < n) {
        const startPos = Math.floor(rand() * n);
        for (let j = 0; j < bootstrap.blockLength && sample.length < n; j += 1) sample.push(valid[(startPos + j) % n]);
      }
      const v = edgeStat(rows, sample, key, outKey, dbar);
      if (v !== null) stats.push(v);
    }
    stats.sort((a, b) => a - b);
    const a = (1 - bootstrap.ci) / 2;
    ci = { lower: stats[Math.floor(a * stats.length)], upper: stats[Math.ceil((1 - a) * stats.length) - 1] };
  }
  return {
    n: valid.length,
    fired: fired.length,
    firedUp: pos.length,
    firedDown: neg.length,
    edge: E,
    ci,
    base: { up: freq(valid, 1), down: freq(valid, -1) },
    whenUp: { up: freq(pos, 1), down: freq(pos, -1) },
    whenDown: { up: freq(neg, 1), down: freq(neg, -1) }
  };
}

/** Quy tắc quyết định AUDIT_SPEC §7. */
export function classify(disc, conf, minFired = AUDIT_SPEC.minFired) {
  if (!disc || !conf || disc.fired < minFired || conf.fired < minFired || !disc.ci) return 'no_evidence';
  if (disc.ci.upper < 0 && conf.edge < 0) return 'remove_wrong_direction';
  if (disc.ci.lower > 0 && conf.edge > 0) return 'keep_verified';
  return 'no_evidence';
}

export function splitPeriods(rows, spec = AUDIT_SPEC) {
  const cut = Date.parse(spec.discoveryEnd);
  return { discovery: rows.filter((r) => r.t < cut), confirmation: rows.filter((r) => r.t >= cut), all: rows };
}

export function evaluateAll(rows, spec = AUDIT_SPEC) {
  const periods = splitPeriods(rows, spec);
  const keys = Object.keys(rows[0]?.signals || {});
  const out = {};
  for (const key of keys) {
    const disc = evaluateSignal(periods.discovery, key);
    const conf = evaluateSignal(periods.confirmation, key);
    const all = evaluateSignal(periods.all, key);
    out[key] = { discovery: disc, confirmation: conf, all, decision: classify(disc, conf, spec.minFired) };
  }
  out['disss:bias@7d'] = {
    discovery: evaluateSignal(periods.discovery, 'disss:bias', { outKey: 'd7' }),
    confirmation: evaluateSignal(periods.confirmation, 'disss:bias', { outKey: 'd7' }),
    all: evaluateSignal(periods.all, 'disss:bias', { outKey: 'd7' })
  };
  out['disss:bias@7d'].decision = classify(out['disss:bias@7d'].discovery, out['disss:bias@7d'].confirmation, spec.minFired);
  return { periods: { discovery: periods.discovery.length, confirmation: periods.confirmation.length, all: rows.length }, signals: out };
}
