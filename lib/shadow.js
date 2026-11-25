/**
 * Shadow forward shadow-v1 (docs/REVISED_ROADMAP.md, P1 shadow): mỗi lần nến ngày đóng, ghi dự báo
 * của các baseline và ứng viên vào ledger JSONL chỉ-append TRƯỚC khi biết kết quả, rồi chấm sau 24h.
 * File này thuần (không I/O). Phần đọc/ghi file và gọi mạng ở lib/shadow-runner.js.
 *
 * Dự báo dùng đúng fitModelsAtCutoff + featuresAt của replay (parity). Không có gì được hiển thị
 * lên dashboard (published: false).
 */
import { DAY_MS, featuresAt, labelFor, SPEC } from './pit.js';
import {
  buildObservations,
  cellOf,
  fitModelsAtCutoff,
  monthStart,
  brier,
  logLoss,
  mean,
  GAUSS_REFERENCE,
  REPLAY_SPEC,
  SPEC_VERSIONS
} from './replay.js';
import { toJsonl, sha256 } from './dataset.js';

export const SHADOW_SPEC = Object.freeze({
  version: 'shadow-v1',
  horizon: '24h',
  // Quá hạn này sau origin thì dự báo vẫn ghi nhưng late = true và không được chấm
  deadlineMs: 60 * 60 * 1000,
  models: ['M0', 'B2', 'G', 'M1']
});

const iso = (ms) => new Date(ms).toISOString();

export function forecastId(symbol, originOpenTime) {
  return `${symbol}:1d:${iso(originOpenTime).slice(0, 10)}:${SHADOW_SPEC.version}:${SPEC.label.version}`;
}

/** Mốc thời gian của một origin (originOpenTime = openTime của nến ngày vừa đóng). */
export function originTimes(originOpenTime) {
  const asOf = originOpenTime + DAY_MS;
  return {
    asOf,
    deadline: asOf + SHADOW_SPEC.deadlineMs,
    targetOpenTime: originOpenTime + DAY_MS,
    targetKnownAt: asOf + DAY_MS
  };
}

/**
 * Dự báo cho một origin chỉ từ nến có closeTime < asOf. Trả null nếu thiếu nến origin.
 * issuedAtMs là thời gian sàn (exchange time) lúc ghi.
 */
export function buildForecast({ symbol, bars, originOpenTime, issuedAtMs }) {
  const t = originTimes(originOpenTime);
  const closed = bars.filter((b) => b.closeTime < t.asOf).sort((a, b) => a.openTime - b.openTime);
  if (!closed.length || closed[closed.length - 1].openTime !== originOpenTime) return null;

  const f = featuresAt(closed, t.asOf);
  const obs = buildObservations(closed);
  const cutoff = monthStart(t.asOf);
  const fit = fitModelsAtCutoff(obs, cutoff, REPLAY_SPEC);
  const cell = f.valid ? cellOf(f) : null;
  const band = Number.isFinite(f.sigma) ? SPEC.label.k * f.sigma : null;

  return {
    type: 'forecast',
    mode: 'live',
    id: forecastId(symbol, originOpenTime),
    symbol,
    horizon: SHADOW_SPEC.horizon,
    versions: { ...SPEC_VERSIONS, shadow: SHADOW_SPEC.version },
    originOpenTime: iso(originOpenTime),
    asOf: iso(t.asOf),
    deadline: iso(t.deadline),
    targetOpenTime: iso(t.targetOpenTime),
    targetKnownAt: iso(t.targetKnownAt),
    issuedAt: iso(issuedAtMs),
    late: issuedAtMs > t.deadline,
    features: { sigma: f.sigma, mom1z: f.mom1z, trend50: f.trend50, valid: f.valid, reasons: f.reasons, cell },
    band,
    thresholds: band === null ? null : {
      originClose: f.close,
      bullishAtOrAbove: f.close * Math.exp(band),
      bearishAtOrBelow: f.close * Math.exp(-band)
    },
    probs: {
      M0: fit.pM0,
      B2: fit.pB2,
      G: GAUSS_REFERENCE,
      M1: cell === null ? null : fit.m1[cell]
    },
    fit: { cutoff: iso(cutoff), trainSize: fit.train.length, knownSize: fit.known.length, alpha: fit.alpha },
    dataFingerprint: sha256(toJsonl(closed)),
    bars: closed.length,
    published: false
  };
}

/** Kết quả cho một dự báo khi nến target đã đóng. Trả null nếu chưa có nến target. */
export function resolveOutcome(forecast, bars, resolvedAtMs) {
  const originOpenTime = Date.parse(forecast.originOpenTime);
  const l = labelFor(bars, originOpenTime, forecast.features.sigma);
  if (l.reason === 'target_missing') return null;
  const issuedBeforeKnown = Date.parse(forecast.issuedAt) < (l.knownAt ?? Infinity);
  const scores = {};
  if (l.label) {
    for (const [m, p] of Object.entries(forecast.probs)) {
      if (p) scores[m] = { brier: brier(p, l.label), logLoss: logLoss(p, l.label) };
    }
  }
  return {
    type: 'outcome',
    id: forecast.id,
    label: l.label,
    reason: l.reason,
    r: l.r,
    band: l.band,
    knownAt: l.knownAt ? iso(l.knownAt) : null,
    resolvedAt: iso(resolvedAtMs),
    valid: Boolean(l.label) && issuedBeforeKnown,
    invalidReason: !l.label ? l.reason : issuedBeforeKnown ? null : 'issued_after_target_known',
    scores
  };
}

/* ------------------------------ ledger ------------------------------ */

/**
 * Đọc ledger JSONL. Dòng cuối dở dang (crash giữa lúc ghi) bị bỏ qua và báo partialTail.
 * Dòng hỏng ở giữa được đếm. Bản ghi trùng id: giữ bản đầu tiên.
 */
export function parseLedger(text = '') {
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const records = [];
  let partialTail = false;
  let corruptLines = 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      if (i === lines.length - 1 && !endsWithNewline) partialTail = true;
      else corruptLines += 1;
    }
  });
  return { records, partialTail, corruptLines };
}

export function indexLedger(records) {
  const idx = { start: null, forecasts: new Map(), outcomes: new Map(), missed: new Map(), duplicates: 0 };
  for (const r of records) {
    if (r.type === 'start') {
      if (!idx.start) idx.start = r;
      continue;
    }
    const map = r.type === 'forecast' ? idx.forecasts : r.type === 'outcome' ? idx.outcomes : r.type === 'missed' ? idx.missed : null;
    if (!map) continue;
    if (map.has(r.id)) idx.duplicates += 1;
    else map.set(r.id, r);
  }
  return idx;
}

/**
 * Lên kế hoạch cho một chu kỳ (thuần). latestClosedOpen = openTime của nến ngày đóng gần nhất
 * (watermark theo dữ liệu sàn), nowMs = thời gian sàn.
 * - Origin chưa có dự báo: còn trước khi biết kết quả → issue (late nếu quá deadline); đã biết kết quả → missed.
 * - Dự báo chưa có kết quả mà nến target đã đóng → resolve.
 */
export function planCycle({ idx, symbol, latestClosedOpen, nowMs }) {
  const actions = [];
  const firstOrigin = idx.start ? Date.parse(idx.start.firstOrigin) : latestClosedOpen;
  if (!idx.start) actions.push({ type: 'start', firstOrigin: latestClosedOpen });
  for (let o = firstOrigin; o <= latestClosedOpen; o += DAY_MS) {
    const id = forecastId(symbol, o);
    if (idx.forecasts.has(id) || idx.missed.has(id)) continue;
    const t = originTimes(o);
    actions.push(nowMs < t.targetKnownAt ? { type: 'issue', originOpenTime: o, id } : { type: 'missed', originOpenTime: o, id });
  }
  for (const [id, f] of idx.forecasts) {
    if (idx.outcomes.has(id)) continue;
    if (Date.parse(f.targetOpenTime) <= latestClosedOpen) actions.push({ type: 'resolve', id });
  }
  return actions;
}

/** Tổng hợp ledger: lịch so với đã phát hành / trễ / bỏ lỡ / đã chấm, và điểm trên dự báo đúng hạn. */
export function ledgerStatus(idx, { latestClosedOpen } = {}) {
  const firstOrigin = idx.start ? Date.parse(idx.start.firstOrigin) : null;
  const scheduled = firstOrigin !== null && Number.isFinite(latestClosedOpen)
    ? Math.max(0, Math.floor((latestClosedOpen - firstOrigin) / DAY_MS) + 1)
    : idx.forecasts.size + idx.missed.size;
  const forecasts = [...idx.forecasts.values()];
  const onTime = forecasts.filter((f) => !f.late);
  const scored = onTime
    .map((f) => ({ f, o: idx.outcomes.get(f.id) }))
    .filter(({ o }) => o && o.valid);
  const models = {};
  for (const m of SHADOW_SPEC.models) {
    const rows = scored.filter(({ o }) => o.scores[m]);
    models[m] = {
      n: rows.length,
      brier: rows.length ? mean(rows.map(({ o }) => o.scores[m].brier)) : null,
      logLoss: rows.length ? mean(rows.map(({ o }) => o.scores[m].logLoss)) : null
    };
  }
  const b0 = models.M0.brier;
  for (const m of Object.keys(models)) {
    models[m].bssVsM0 = b0 && models[m].brier !== null ? 1 - (models[m].brier / b0) : null;
  }
  return {
    firstOrigin: firstOrigin === null ? null : iso(firstOrigin),
    scheduled,
    issued: forecasts.length,
    onTime: onTime.length,
    late: forecasts.length - onTime.length,
    missed: idx.missed.size,
    resolved: idx.outcomes.size,
    scoredOnTime: scored.length,
    pending: forecasts.filter((f) => !idx.outcomes.has(f.id)).length,
    duplicatesIgnored: idx.duplicates,
    models
  };
}
