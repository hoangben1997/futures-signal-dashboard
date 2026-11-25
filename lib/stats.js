/**
 * Hàm thống kê nhỏ dùng chung giữa server.js và lib/historical.js.
 */

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function pctChange(oldValue, newValue) {
  if (!oldValue || !newValue) return null;
  return ((newValue - oldValue) / oldValue) * 100;
}

export function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function finiteOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function std(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function toClosedKlines(klines, nowMs = Date.now()) {
  if (!Array.isArray(klines) || !klines.length) return [];
  const rows = klines.filter((k) => Array.isArray(k) && k.length >= 7);
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const closeTime = num(last?.[6]);
  if (closeTime !== null && nowMs < closeTime) {
    return rows.slice(0, -1);
  }
  return rows;
}

export function percentile(values, pct) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function computeAbsMovePct(closes, lag = 1) {
  if (!Array.isArray(closes) || closes.length <= lag) return [];
  const moves = [];
  for (let i = lag; i < closes.length; i += 1) {
    const oldV = closes[i - lag];
    const newV = closes[i];
    if (!oldV || !newV) continue;
    moves.push(Math.abs(((newV - oldV) / oldV) * 100));
  }
  return moves;
}

export function summarizeMoves(moves) {
  return {
    samples: moves.length,
    p50MovePct: num(percentile(moves, 50)?.toFixed(4)),
    p75MovePct: num(percentile(moves, 75)?.toFixed(4))
  };
}
