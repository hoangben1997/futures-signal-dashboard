/**
 * Chỉ báo kỹ thuật thuần (không gọi mạng), công thức bám theo Pine Script của TradingView
 * để số trên dashboard đối chiếu được với chart:
 * - sma: ta.sma
 * - rsi: ta.rsi (RMA/Wilder)
 * - ema: ta.ema
 * - macd: ta.macd(12, 26, 9)
 * RMA và EMA đều khởi tạo bằng SMA. Đã đối chiếu với TradingView (ETHUSDT spot, khung M/W/D/4H):
 * khớp tới 2 chữ số thập phân.
 * Mỗi series trả về mảng cùng độ dài input, phần chưa đủ dữ liệu là null.
 */

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || period < 1) return out;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count += 1;
    if (count > period) {
      sum -= values[i - period];
      count = period;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

// Làm mượt hàm mũ, khởi tạo bằng SMA của `period` giá trị đầu (giống TradingView).
function smoothSmaSeeded(values, period, alpha) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || period < 1) return out;
  let prev = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (prev === null) {
      seedSum += v;
      seedCount += 1;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (alpha * v) + ((1 - alpha) * prev);
    out[i] = prev;
  }
  return out;
}

export function ema(values, period) {
  return smoothSmaSeeded(values, period, 2 / (period + 1));
}

function rma(values, period) {
  return smoothSmaSeeded(values, period, 1 / period);
}

export function rsi(closes, period = 14) {
  const ups = new Array(closes.length).fill(null);
  const downs = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (!Number.isFinite(change)) continue;
    ups[i] = Math.max(change, 0);
    downs[i] = Math.max(-change, 0);
  }
  const avgUp = rma(ups, period);
  const avgDown = rma(downs, period);
  return closes.map((_, i) => {
    const u = avgUp[i];
    const d = avgDown[i];
    if (u === null || d === null) return null;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - (100 / (1 + (u / d)));
  });
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => (
    fastEma[i] !== null && slowEma[i] !== null ? fastEma[i] - slowEma[i] : null
  ));
  const signal = ema(line, signalPeriod);
  const hist = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i] : null));
  return { line, signal, hist };
}

/**
 * Pivot high/low kiểu ta.pivothigh/ta.pivotlow: nến i là đỉnh nếu high[i] cao hơn
 * `strength` nến mỗi bên. Pivot chỉ được xác nhận sau `strength` nến bên phải.
 */
export function findSwings(candles, strength = 3) {
  const highs = [];
  const lows = [];
  for (let i = strength; i < candles.length - strength; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: c.time, price: c.high, volume: c.volume });
    if (isLow) lows.push({ index: i, time: c.time, price: c.low, volume: c.volume });
  }
  return { highs, lows };
}

/**
 * Cấu trúc HH/HL/LH/LL từ 2 đỉnh và 2 đáy xác nhận gần nhất.
 * bullish = HH + HL, bearish = LH + LL, còn lại là mixed.
 * Pivot cần vài nến bên phải mới xác nhận, nên nếu nến đóng gần nhất (`lastClose`)
 * đã thủng đáy / vượt đỉnh xác nhận gần nhất thì coi là phá cấu trúc (broken)
 * và state theo hướng phá.
 */
export function classifyStructure(swings, lastClose = null) {
  const [h1, h2] = swings.highs.slice(-2);
  const [l1, l2] = swings.lows.slice(-2);
  if (!h1 || !h2 || !l1 || !l2) {
    return { state: 'unknown', highs: null, lows: null, broken: null };
  }
  const highs = h2.price > h1.price ? 'HH' : 'LH';
  const lows = l2.price > l1.price ? 'HL' : 'LL';
  let state = 'mixed';
  if (highs === 'HH' && lows === 'HL') state = 'bullish';
  else if (highs === 'LH' && lows === 'LL') state = 'bearish';
  let broken = null;
  if (Number.isFinite(lastClose)) {
    if (lastClose < l2.price) broken = 'down';
    else if (lastClose > h2.price) broken = 'up';
  }
  if (broken === 'down') state = 'bearish';
  else if (broken === 'up') state = 'bullish';
  return {
    state,
    highs,
    lows,
    broken,
    lastHigh: round(h2.price, 2),
    prevHigh: round(h1.price, 2),
    lastLow: round(l2.price, 2),
    prevLow: round(l1.price, 2)
  };
}

/**
 * Fibonacci retracement theo swing lớn nhất trong cửa sổ `lookback` nến.
 * direction = 'down' khi đỉnh xảy ra trước đáy (đang hồi lên từ đáy),
 * khi đó level r nằm ở low + r × (high − low).
 */
export function fibRetracement(candles, lookback = 90) {
  const window = candles.slice(-lookback);
  if (window.length < 2) return null;
  let hi = window[0];
  let lo = window[0];
  for (const c of window) {
    if (c.high > hi.high) hi = c;
    if (c.low < lo.low) lo = c;
  }
  const range = hi.high - lo.low;
  if (!(range > 0)) return null;
  const direction = hi.time < lo.time ? 'down' : 'up';
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const levels = ratios.map((r) => ({
    ratio: r,
    price: round(direction === 'down' ? lo.low + (r * range) : hi.high - (r * range), 2)
  }));
  return {
    direction,
    swingHigh: { price: hi.high, time: hi.time },
    swingLow: { price: lo.low, time: lo.time },
    levels
  };
}

function lastValue(series, offset = 0) {
  const v = series[series.length - 1 - offset];
  return Number.isFinite(v) ? v : null;
}

function crossState(fastSeries, slowSeries, lookback) {
  const n = fastSeries.length;
  for (let back = 0; back < Math.min(lookback, n - 1); back += 1) {
    const i = n - 1 - back;
    const a = fastSeries[i];
    const b = slowSeries[i];
    const pa = fastSeries[i - 1];
    const pb = slowSeries[i - 1];
    if (![a, b, pa, pb].every(Number.isFinite)) break;
    if (pa <= pb && a > b) return { type: 'golden', barsAgo: back };
    if (pa >= pb && a < b) return { type: 'death', barsAgo: back };
  }
  return null;
}

function candleCharacter(c) {
  if (!c) return null;
  const range = c.high - c.low;
  if (!(range > 0)) return null;
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  let shape = 'normal';
  if (lowerWick >= body * 1.5 && lowerWick > upperWick) shape = 'long_lower_wick';
  else if (upperWick >= body * 1.5 && upperWick > lowerWick) shape = 'long_upper_wick';
  else if (body / range >= 0.7) shape = c.close > c.open ? 'strong_bull' : 'strong_bear';
  return {
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    changePct: round(((c.close - c.open) / c.open) * 100, 2),
    closePositionInRange: round((c.close - c.low) / range, 2),
    shape
  };
}

/**
 * Tóm tắt kỹ thuật cho một khung. `candles` gồm cả nến đang chạy ở cuối
 * (giống chart), `closedCount` = số nến đã đóng. Cấu trúc và nến đóng gần nhất
 * chỉ dùng nến đã đóng để không bị nến đang chạy làm nhiễu.
 */
export function summarizeTimeframe(candles, { closedCount = candles.length, swingStrength = 3, fibLookback = 90 } = {}) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ma50 = sma(closes, 50);
  const ma100 = sma(closes, 100);
  const ma200 = sma(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const rsiMaSeries = sma(rsiSeries, 14);
  const m = macd(closes);
  const volMa20 = sma(volumes, 20);

  const closed = candles.slice(0, closedCount);
  const price = closes[closes.length - 1];
  const mas = { ma50: lastValue(ma50), ma100: lastValue(ma100), ma200: lastValue(ma200) };

  const position = {};
  for (const [key, value] of Object.entries(mas)) {
    position[key] = value === null ? null : price >= value ? 'above' : 'below';
  }

  let stack = 'unknown';
  if (mas.ma50 !== null && mas.ma100 !== null && mas.ma200 !== null) {
    if (mas.ma50 > mas.ma100 && mas.ma100 > mas.ma200) stack = 'bullish';
    else if (mas.ma50 < mas.ma100 && mas.ma100 < mas.ma200) stack = 'bearish';
    else stack = 'mixed';
  }

  const lastClosedIdx = closedCount - 1;
  const lastClosedVolRatio = lastClosedIdx >= 0 && volMa20[lastClosedIdx]
    ? volumes[lastClosedIdx] / volMa20[lastClosedIdx]
    : null;

  const swings = findSwings(closed, swingStrength);

  return {
    price: round(price, 2),
    bars: candles.length,
    ma50: round(mas.ma50, 2),
    ma100: round(mas.ma100, 2),
    ma200: round(mas.ma200, 2),
    position,
    stack,
    cross50x200: mas.ma200 === null
      ? null
      : {
          current: mas.ma50 > mas.ma200 ? 'golden' : 'death',
          recent: crossState(ma50, ma200, 30)
        },
    rsi: round(lastValue(rsiSeries), 2),
    rsiMa: round(lastValue(rsiMaSeries), 2),
    macd: round(lastValue(m.line), 4),
    macdSignal: round(lastValue(m.signal), 4),
    macdHist: round(lastValue(m.hist), 4),
    macdHistPrev: round(lastValue(m.hist, 1), 4),
    macdCross: crossState(m.line, m.signal, 5),
    lastClosedVolRatio: round(lastClosedVolRatio, 2),
    lastClosedCandle: candleCharacter(closed[closed.length - 1]),
    structure: classifyStructure(swings, closed[closed.length - 1]?.close ?? null),
    recentSwings: {
      highs: swings.highs.slice(-3).map((s) => ({ price: s.price, time: s.time, volume: s.volume })),
      lows: swings.lows.slice(-3).map((s) => ({ price: s.price, time: s.time, volume: s.volume }))
    },
    fib: fibRetracement(closed, fibLookback)
  };
}

/** Chuyển kline Binance [openTime, o, h, l, c, v, closeTime, ...] sang candle object. */
export function klinesToCandles(klines, nowMs = Date.now()) {
  if (!Array.isArray(klines)) return { candles: [], closedCount: 0 };
  const candles = [];
  let closedCount = 0;
  for (const k of klines) {
    if (!Array.isArray(k) || k.length < 7) continue;
    const c = {
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    };
    if (![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) continue;
    candles.push(c);
    if (Number(k[6]) <= nowMs) closedCount = candles.length;
  }
  return { candles, closedCount };
}
