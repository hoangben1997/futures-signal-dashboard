/**
 * Ứng viên replay-v2-oi (docs/P1_SPEC.md §9): góc phần tư giá × OI, so với climatology expanding (B2).
 * Dùng lại runReplay/summarize của replay-v1, chỉ đổi ô (cell) và cửa sổ train.
 */
import { DAY_MS } from './pit.js';
import { REPLAY_SPEC, runReplay } from './replay.js';
import { lastIndexBefore } from './audit.js';

const HOUR = 3600 * 1000;

export const REPLAY_OI_SPEC = Object.freeze({
  ...REPLAY_SPEC,
  version: 'replay-v2-oi',
  windowDays: Infinity, // expanding: M0 ≡ B2, M1 co về B2
  minHistoryDays: 730,
  oiMaxAgeNowMs: 2 * HOUR,
  oiMaxAgeOldMs: HOUR
});

/** OI mới nhất trước t (strict) hoặc tại/trước t (inclusive), không quá maxAge. */
function oiAt(metrics5m, t, maxAgeMs, inclusive) {
  let i = lastIndexBefore(metrics5m, 't', t, inclusive);
  while (i >= 0 && metrics5m[i].oi === null) i -= 1;
  if (i < 0 || t - metrics5m[i].t > maxAgeMs) return null;
  return metrics5m[i].oi;
}

/** Gắn oiChg24 và ô giá × OI cho từng observation; bỏ origin thiếu OI. Không đổi input. */
export function attachOiCells(observations, metrics5m, spec = REPLAY_OI_SPEC) {
  const out = [];
  for (const o of observations) {
    const now = oiAt(metrics5m, o.asOf, spec.oiMaxAgeNowMs, false);
    const old = oiAt(metrics5m, o.asOf - DAY_MS, spec.oiMaxAgeOldMs, true);
    if (!(now > 0) || !(old > 0)) continue;
    const oiChg24 = Math.log(now / old);
    out.push({ ...o, oiChg24, cell: (o.mom1z >= 0 ? 2 : 0) + (oiChg24 >= 0 ? 1 : 0) });
  }
  return out;
}

/** Giai đoạn phát triển: loại holdout như replay-v1. */
export function runDevelopment(obsWithOi, spec = REPLAY_OI_SPEC) {
  return runReplay(obsWithOi, spec);
}

/**
 * Holdout: chạy cùng walk-forward trên toàn bộ dữ liệu (nhãn holdout chỉ vào train khi đã biết,
 * như live), rồi chỉ giữ dự báo có origin ≥ holdoutStart.
 */
export function runHoldout(obsWithOi, spec = REPLAY_OI_SPEC) {
  const holdoutStart = Date.parse(spec.holdoutStartUtc);
  const { predictions, folds } = runReplay(obsWithOi, { ...spec, holdoutStartUtc: '9999-01-01T00:00:00.000Z' });
  return {
    predictions: predictions.filter((p) => p.originOpenTime >= holdoutStart),
    folds: folds.filter((f) => Date.parse(f.cutoff) >= Date.parse(`${spec.holdoutStartUtc.slice(0, 7)}-01T00:00:00.000Z`))
  };
}
