/**
 * Feature và nhãn point-in-time cho P1 (docs/P1_SPEC.md §2–5).
 * Một hàm dùng chung cho replay và live: featuresAt(bars, asOfMs) chỉ đọc nến có
 * closeTime < asOfMs, mọi độ trễ tính theo timestamp chứ không theo vị trí mảng.
 * bars: mảng row của dataset-v1 (openTime, closeTime, open, high, low, close, ...), interval 1d.
 */

export const DAY_MS = 24 * 3600 * 1000;

export const SPEC = Object.freeze({
  sigma: { version: 'sigma-ewma-v1', lambda: 0.94, warmupReturns: 60, floor: 0.01 },
  label: { version: 'label-ksigma-v1', k: 0.5, horizonDays: 1 },
  features: { version: 'features-v1', smaPeriod: 50, atrPeriod: 14 }
});

/** Nến đã đóng tại asOfMs, sắp theo thời gian. Nến đang chạy (closeTime ≥ asOf) bị bỏ. */
export function closedBars(bars, asOfMs) {
  return bars.filter((b) => b.closeTime < asOfMs).sort((a, b) => a.openTime - b.openTime);
}

/**
 * σ EWMA (RiskMetrics, mean = 0) tại nến cuối của `bars` (đã đóng, đã sắp).
 * Return đi qua gap d ngày đóng góp r²/d. Trả null khi chưa đủ warm-up.
 */
export function ewmaSigma(bars, spec = SPEC.sigma) {
  const { lambda, warmupReturns, floor } = spec;
  let v = null;
  let seedSum = 0;
  let count = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const days = Math.round((bars[i].openTime - bars[i - 1].openTime) / DAY_MS);
    const r = Math.log(bars[i].close / bars[i - 1].close);
    const r2 = (r * r) / Math.max(1, days);
    count += 1;
    if (v === null) {
      seedSum += r2;
      if (count === warmupReturns) v = seedSum / warmupReturns;
      continue;
    }
    v = (lambda * v) + ((1 - lambda) * r2);
  }
  if (v === null) return null;
  return Math.max(Math.sqrt(v), floor);
}

/** ATR Wilder (RMA, khởi tạo bằng SMA) tại nến cuối. */
function atrWilder(bars, period) {
  if (bars.length < period + 1) return null;
  let atr = null;
  let seed = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    if (i <= period) {
      seed += tr;
      if (i === period) atr = seed / period;
      continue;
    }
    atr = ((atr * (period - 1)) + tr) / period;
  }
  return atr;
}

function hasGap(bars, lookbackDays) {
  const last = bars[bars.length - 1];
  const start = last.openTime - (lookbackDays * DAY_MS);
  for (let i = bars.length - 1; i > 0 && bars[i].openTime > start; i -= 1) {
    if (bars[i].openTime - bars[i - 1].openTime !== DAY_MS) return true;
  }
  return false;
}

/**
 * Feature tại asOfMs. Origin = nến đóng gần nhất trước asOf.
 * valid = false kèm reasons khi thiếu dữ liệu hoặc có gap trong cửa sổ warm-up.
 */
export function featuresAt(allBars, asOfMs, spec = SPEC) {
  const bars = closedBars(allBars, asOfMs);
  const out = {
    version: spec.features.version,
    sigmaVersion: spec.sigma.version,
    asOf: asOfMs,
    originOpenTime: null,
    originCloseTime: null,
    close: null,
    sigma: null,
    mom1z: null,
    trend50: null,
    valid: false,
    reasons: []
  };
  if (!bars.length) {
    out.reasons.push('no_closed_bars');
    return out;
  }
  const origin = bars[bars.length - 1];
  out.originOpenTime = origin.openTime;
  out.originCloseTime = origin.closeTime;
  out.close = origin.close;

  const sigma = ewmaSigma(bars, spec.sigma);
  if (sigma === null) out.reasons.push('sigma_warmup');
  out.sigma = sigma;

  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  if (prev && origin.openTime - prev.openTime === DAY_MS && sigma !== null) {
    out.mom1z = Math.log(origin.close / prev.close) / sigma;
  } else if (prev && origin.openTime - prev.openTime !== DAY_MS) {
    out.reasons.push('prev_bar_missing');
  }

  const { smaPeriod, atrPeriod } = spec.features;
  if (bars.length >= smaPeriod) {
    const window = bars.slice(-smaPeriod);
    const sma = window.reduce((s, b) => s + b.close, 0) / smaPeriod;
    const atr = atrWilder(bars, atrPeriod);
    if (atr && atr > 0) out.trend50 = (origin.close - sma) / atr;
  } else {
    out.reasons.push('sma_warmup');
  }

  if (hasGap(bars, spec.sigma.warmupReturns)) out.reasons.push('gap_in_window');
  out.valid = out.reasons.length === 0 && out.mom1z !== null && out.trend50 !== null;
  return out;
}

/**
 * Nhãn cho origin (theo openTime của nến origin). Target tìm theo timestamp;
 * thiếu nến target thì label = null. sigma phải là σ tại origin (từ featuresAt).
 */
export function labelFor(allBars, originOpenTime, sigma, spec = SPEC.label) {
  const origin = allBars.find((b) => b.openTime === originOpenTime);
  const targetOpen = originOpenTime + (spec.horizonDays * DAY_MS);
  const target = allBars.find((b) => b.openTime === targetOpen);
  const base = {
    version: spec.version,
    originOpenTime,
    targetOpenTime: targetOpen,
    knownAt: target ? target.closeTime + 1 : null,
    r: null,
    band: null,
    label: null,
    reason: null
  };
  if (!origin) return { ...base, reason: 'origin_missing' };
  if (!target) return { ...base, reason: 'target_missing' };
  if (!Number.isFinite(sigma)) return { ...base, reason: 'sigma_missing' };
  const r = Math.log(target.close / origin.close);
  const band = spec.k * sigma;
  let label = 'sideways';
  if (r >= band) label = 'bullish';
  else if (r <= -band) label = 'bearish';
  return { ...base, r, band, label };
}
