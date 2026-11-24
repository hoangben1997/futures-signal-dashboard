/**
 * Báo cáo phân tích theo khung DiSSS (Deconstruction → Selection → Sequencing → Stakes)
 * kèm bước tự phản biện. Toàn bộ là rule-based trên dữ liệu dashboard đã lấy:
 * - Không có dữ liệu thì ghi "thiếu dữ liệu", không suy diễn thay.
 * - Mỗi bằng chứng gắn kind (fact = số đo trực tiếp, inference = diễn giải) và timing
 *   (leading / coincident / lagging).
 * - Bằng chứng cùng nguồn dữ liệu (family) bị gộp và chặn trần, để 5 chỉ báo giá
 *   không bị đếm thành 5 bằng chứng độc lập.
 * - Xác suất bằng số chỉ lấy từ mô hình thống kê lịch sử (có backtest); phần còn lại
 *   chỉ dùng mức tin cậy thấp / trung bình / cao.
 */

// Trọng số mỗi nguồn dữ liệu độc lập. Điểm của một family bị chặn trong [-1, 1] trước khi nhân.
export const FAMILY_WEIGHTS = {
  'price-long': 1.0,
  'price-short': 1.0,
  volume: 0.5,
  funding: 0.5,
  oi: 0.5,
  positioning: 0.5,
  flow: 0.5,
  sentiment: 0.5,
  onchain: 0.3
};

const FAMILY_LABELS = {
  'price-long': 'Giá dài hạn (M/W)',
  'price-short': 'Giá ngắn hạn (D/4H/1H)',
  volume: 'Volume',
  funding: 'Funding',
  oi: 'Open Interest',
  positioning: 'Long/Short ratio',
  flow: 'Taker flow',
  sentiment: 'Fear & Greed',
  onchain: 'USDC mint/burn'
};

// Dữ liệu khung phân tích yêu cầu nhưng dashboard chưa có nguồn.
export const MISSING_DATA = [
  { group: 'macro', item: 'Lộ trình lãi suất FED / CPI thực tế so với kỳ vọng (chỉ có lịch sự kiện)' },
  { group: 'macro', item: 'DXY, lợi suất trái phiếu Mỹ, thanh khoản toàn cầu (M2, bảng cân đối FED)' },
  { group: 'structure', item: 'Cấu trúc khung 15M' },
  { group: 'liquidity', item: 'Liquidation heatmap / order book depth thật (vùng thanh khoản đang là suy luận từ swing)' },
  { group: 'derivatives', item: 'CVD (cumulative volume delta)' },
  { group: 'onchain', item: 'Dòng tiền vào/ra sàn, hoạt động ví lớn' },
  { group: 'sentiment', item: 'Tin tức, mạng xã hội' }
];

// Brier 3 lớp khi đoán đều 1/3 mỗi kịch bản. Mô hình phải thấp hơn mức này mới có giá trị.
export const UNIFORM_BRIER = 2 / 9;

const TAKER_FEE_PCT = 0.05; // Binance USDT-M taker, mỗi chiều
const DEFAULT_SLIPPAGE_PCT = 0.05; // mỗi chiều, giả định cho BTC/ETH khối lượng nhỏ

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function fmtPrice(p) {
  if (!isNum(p)) return '-';
  return p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 0 : 2 });
}

function pctDistance(from, to) {
  if (!isNum(from) || !isNum(to) || from === 0) return null;
  return round(((to - from) / from) * 100, 2);
}

/* ---------------------------------------------------------------------------
 * 1. Deconstruction: tách bằng chứng theo từng nhóm
 * ------------------------------------------------------------------------- */

function ev(group, family, direction, text, { kind = 'fact', timing = 'coincident', weight = 1 } = {}) {
  return { group, family, direction, weight, kind, timing, text };
}

function priceLongEvidence(tech) {
  const out = [];
  const w = tech?.['1w'];
  const m = tech?.['1M'];
  if (w && isNum(w.ma200)) {
    const above = w.price >= w.ma200;
    out.push(ev('regime', 'price-long', above ? 1 : -1,
      `Giá ${fmtPrice(w.price)} ${above ? 'trên' : 'dưới'} MA200 tuần ${fmtPrice(w.ma200)} (lằn bò/gấu, cách ${pctDistance(w.ma200, w.price)}%).`,
      { timing: 'lagging', weight: 2 }));
  }
  if (w && w.stack !== 'unknown') {
    if (w.stack !== 'mixed') {
      out.push(ev('regime', 'price-long', w.stack === 'bullish' ? 1 : -1,
        `Thứ tự MA tuần ${w.stack === 'bullish' ? 'bullish (50>100>200)' : 'bearish (50<100<200)'}.`, { timing: 'lagging' }));
    } else if (w.ma50 < w.ma100) {
      out.push(ev('regime', 'price-long', -0.5,
        `MA50 tuần ${fmtPrice(w.ma50)} dưới MA100 ${fmtPrice(w.ma100)}: đà trung hạn suy yếu.`, { timing: 'lagging' }));
    }
  }
  if (w && w.cross50x200?.recent) {
    const golden = w.cross50x200.recent.type === 'golden';
    out.push(ev('regime', 'price-long', golden ? 1 : -1,
      `${golden ? 'Golden' : 'Death'} cross MA50/200 tuần cách đây ${w.cross50x200.recent.barsAgo} nến.`, { timing: 'lagging' }));
  }
  if (w && isNum(w.macdHist)) {
    const rising = isNum(w.macdHistPrev) && w.macdHist > w.macdHistPrev;
    out.push(ev('momentum', 'price-long', w.macdHist > 0 ? 0.5 : -0.5,
      `MACD tuần histogram ${round(w.macdHist, 2)} (${w.macdHist > 0 ? 'dương' : 'âm'}, ${rising ? 'đang tăng' : 'đang giảm'} so với nến trước).`,
      { timing: 'lagging' }));
  }
  if (w && isNum(w.rsi)) {
    const dir = w.rsi > 50 && w.rsi > (w.rsiMa ?? 0) ? 0.5 : w.rsi < 50 && w.rsi < (w.rsiMa ?? 100) ? -0.5 : 0;
    out.push(ev('momentum', 'price-long', dir,
      `RSI tuần ${w.rsi} (MA ${w.rsiMa ?? '-'}).`, { timing: 'coincident' }));
  }
  if (m && isNum(m.ma50)) {
    const above = m.price >= m.ma50;
    out.push(ev('regime', 'price-long', above ? 0.5 : -0.5,
      `Giá ${above ? 'trên' : 'dưới'} MA50 tháng ${fmtPrice(m.ma50)}.`, { timing: 'lagging' }));
  }
  return out;
}

function structureText(tfLabel, s) {
  if (!s || s.state === 'unknown') return `${tfLabel}: chưa đủ swing để xác định cấu trúc.`;
  const base = `${tfLabel}: ${s.highs}/${s.lows} (đỉnh ${fmtPrice(s.prevHigh)}→${fmtPrice(s.lastHigh)}, đáy ${fmtPrice(s.prevLow)}→${fmtPrice(s.lastLow)})`;
  if (s.broken === 'down') return `${base}, nến đóng gần nhất đã thủng đáy ${fmtPrice(s.lastLow)}: phá cấu trúc xuống.`;
  if (s.broken === 'up') return `${base}, nến đóng gần nhất đã vượt đỉnh ${fmtPrice(s.lastHigh)}: phá cấu trúc lên.`;
  return `${base}.`;
}

function priceShortEvidence(tech) {
  const out = [];
  const d = tech?.['1d'];
  for (const [tf, label] of [['1d', '1D'], ['4h', '4H'], ['1h', '1H']]) {
    const s = tech?.[tf]?.structure;
    if (!s) continue;
    const dir = s.state === 'bullish' ? 1 : s.state === 'bearish' ? -1 : 0;
    out.push(ev('structure', 'price-short', dir * (tf === '1d' ? 1 : 0.5), structureText(label, s)));
  }
  if (d && isNum(d.ma200)) {
    const above = d.price >= d.ma200;
    out.push(ev('structure', 'price-short', above ? 0.5 : -0.5,
      `Giá ${above ? 'trên' : 'dưới'} MA200 ngày ${fmtPrice(d.ma200)}; MA ngày xếp ${d.stack}.`, { timing: 'lagging' }));
  }
  if (d && isNum(d.rsi)) {
    if (d.rsi < 30) {
      out.push(ev('momentum', 'price-short', 0.5,
        `RSI ngày ${d.rsi} vùng quá bán: dễ có nhịp hồi kỹ thuật, không đồng nghĩa đảo chiều.`, { kind: 'inference' }));
    } else if (d.rsi > 70) {
      out.push(ev('momentum', 'price-short', -0.5,
        `RSI ngày ${d.rsi} vùng quá mua: dễ có nhịp điều chỉnh.`, { kind: 'inference' }));
    } else {
      out.push(ev('momentum', 'price-short', d.rsi > 50 ? 0.5 : -0.5, `RSI ngày ${d.rsi} ${d.rsi > 50 ? 'trên' : 'dưới'} 50.`));
    }
  }
  if (d && isNum(d.macdHist) && isNum(d.macdHistPrev)) {
    const fading = Math.abs(d.macdHist) < Math.abs(d.macdHistPrev);
    let dir = d.macdHist > 0 ? 0.5 : -0.5;
    if (fading) dir = d.macdHist > 0 ? -0.25 : 0.25;
    out.push(ev('momentum', 'price-short', dir,
      `MACD ngày histogram ${round(d.macdHist, 2)} (trước ${round(d.macdHistPrev, 2)}): ${d.macdHist > 0 ? 'đà tăng' : 'đà giảm'} ${fading ? 'đang yếu dần' : 'đang mạnh lên'}.`,
      { timing: 'lagging' }));
  }
  const c = d?.lastClosedCandle;
  if (c && c.shape !== 'normal') {
    const map = {
      long_lower_wick: [0.5, 'râu dưới dài (có lực mua đỡ)'],
      long_upper_wick: [-0.5, 'râu trên dài (bị bán chặn)'],
      strong_bull: [0.5, 'thân tăng mạnh'],
      strong_bear: [-0.5, 'thân giảm mạnh']
    };
    const [dir, txt] = map[c.shape];
    out.push(ev('structure', 'price-short', dir, `Nến ngày đóng gần nhất ${txt}, đóng ở ${Math.round(c.closePositionInRange * 100)}% biên độ nến.`,
      { kind: 'inference' }));
  }
  return out;
}

function volumeEvidence(tech) {
  const out = [];
  const d = tech?.['1d'];
  if (!d) return out;
  const vr = d.lastClosedVolRatio;
  const c = d.lastClosedCandle;
  if (isNum(vr) && c) {
    if (vr >= 1.5 && c.shape === 'long_lower_wick') {
      out.push(ev('volume', 'volume', 1, `Nến ngày gần nhất volume ${vr}× trung bình 20 phiên kèm râu dưới dài: có hấp thụ lực bán.`, { kind: 'inference' }));
    } else if (vr >= 1.5 && c.changePct < 0) {
      out.push(ev('volume', 'volume', -1, `Nến ngày giảm ${c.changePct}% với volume ${vr}× trung bình: lực bán được xác nhận.`));
    } else if (vr >= 1.5 && c.changePct > 0) {
      out.push(ev('volume', 'volume', 1, `Nến ngày tăng ${c.changePct}% với volume ${vr}× trung bình: lực mua được xác nhận.`));
    } else {
      out.push(ev('volume', 'volume', 0, `Volume nến ngày gần nhất ${vr}× trung bình 20 phiên: không có xác nhận đặc biệt.`));
    }
  }
  const lows = d.recentSwings?.lows || [];
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (b.price < a.price && b.volume < a.volume) {
      out.push(ev('volume', 'volume', 0.5,
        `Đáy ngày mới ${fmtPrice(b.price)} thấp hơn đáy cũ ${fmtPrice(a.price)} nhưng volume nhỏ hơn: lực bán có dấu hiệu cạn (phân kỳ).`,
        { kind: 'inference', timing: 'leading' }));
    }
  }
  return out;
}

function derivativesEvidence(m) {
  const out = [];
  if (isNum(m?.fundingRate)) {
    const fr = m.fundingRate * 100;
    if (fr < -0.01) {
      out.push(ev('derivatives', 'funding', 0.5, `Funding ${round(fr, 4)}% âm: phe short đang trả phí, dễ có short squeeze nếu giá bật.`,
        { kind: 'inference', timing: 'leading' }));
    } else if (fr > 0.05) {
      out.push(ev('derivatives', 'funding', -0.5, `Funding ${round(fr, 4)}% cao: phe long đông, dễ bị quét long.`,
        { kind: 'inference', timing: 'leading' }));
    } else {
      out.push(ev('derivatives', 'funding', 0, `Funding ${round(fr, 4)}% trung tính.`, { timing: 'leading' }));
    }
  }
  if (isNum(m?.openInterestChange6h) && isNum(m?.momentum6h)) {
    const oi = round(m.openInterestChange6h, 2);
    const px = round(m.momentum6h, 2);
    let dir = 0;
    let txt = 'không cho tín hiệu rõ';
    if (oi > 2 && px < -0.5) { dir = -1; txt = 'mở short mới theo chiều giảm'; }
    else if (oi > 2 && px > 0.5) { dir = 1; txt = 'mở long mới theo chiều tăng'; }
    else if (oi < -2 && px < -0.5) { dir = 0.5; txt = 'long bị thanh lý / xả đòn bẩy, áp lực bán có thể cạn dần'; }
    else if (oi < -2 && px > 0.5) { dir = 0; txt = 'short đóng lệnh (short covering), nhịp tăng chưa có tiền mới'; }
    out.push(ev('derivatives', 'oi', dir, `OI 6h ${oi > 0 ? '+' : ''}${oi}%, giá 6h ${px > 0 ? '+' : ''}${px}%: ${txt}.`,
      { kind: dir === 0 && txt.startsWith('không') ? 'fact' : 'inference' }));
  }
  if (isNum(m?.longShortRatio)) {
    const r = m.longShortRatio;
    const dir = r > 1.8 ? -0.5 : r < 0.7 ? 0.5 : 0;
    out.push(ev('derivatives', 'positioning', dir,
      `Global L/S ${round(r, 2)}${dir < 0 ? ': đám đông nghiêng long (tín hiệu ngược)' : dir > 0 ? ': đám đông nghiêng short (tín hiệu ngược)' : ' trung tính'}.`,
      { kind: dir ? 'inference' : 'fact', timing: 'leading' }));
  }
  if (isNum(m?.topTraderLongShortRatio)) {
    const r = m.topTraderLongShortRatio;
    const dir = r > 1.5 ? 0.5 : r < 0.8 ? -0.5 : 0;
    out.push(ev('derivatives', 'positioning', dir, `Top trader L/S ${round(r, 2)}.`, { timing: 'leading' }));
  }
  if (isNum(m?.takerBuySellRatio)) {
    const r = m.takerBuySellRatio;
    const dir = r > 1.05 ? 1 : r < 0.95 ? -1 : 0;
    out.push(ev('derivatives', 'flow', dir,
      `Taker buy/sell 1h ${round(r, 3)}${dir > 0 ? ': mua chủ động áp đảo' : dir < 0 ? ': bán chủ động áp đảo' : ': cân bằng'}.`));
  }
  return out;
}

function onchainEvidence(usdcEvents = []) {
  const events = Array.isArray(usdcEvents) ? usdcEvents : [];
  if (!events.length) return [];
  let mint = 0;
  let burn = 0;
  for (const e of events) {
    const amt = isNum(e.amountUsdc) ? e.amountUsdc : 0;
    if (e.type === 'MINT') mint += amt;
    else if (e.type === 'BURN') burn += amt;
  }
  const net = mint - burn;
  const netM = round(net / 1e6, 1);
  const dir = net > 200e6 ? 0.5 : net < -200e6 ? -0.5 : 0;
  return [ev('onchain', 'onchain', dir,
    `USDC treasury 72h: mint ${round(mint / 1e6, 1)}M, burn ${round(burn / 1e6, 1)}M, ròng ${netM > 0 ? '+' : ''}${netM}M${dir > 0 ? ' (thanh khoản stablecoin vào thêm)' : dir < 0 ? ' (thanh khoản stablecoin rút ra)' : ''}.`,
    { kind: dir ? 'inference' : 'fact', timing: 'leading' })];
}

function sentimentEvidence(m) {
  if (!isNum(m?.fearGreed)) return [];
  const v = m.fearGreed;
  const dir = v < 25 ? 0.5 : v > 75 ? -0.5 : 0;
  return [ev('sentiment', 'sentiment', dir,
    `Fear & Greed ${v}${dir > 0 ? ' (sợ hãi cực độ, tín hiệu ngược)' : dir < 0 ? ' (tham lam cực độ, tín hiệu ngược)' : ''}.`,
    { kind: dir ? 'inference' : 'fact' })];
}

export function upcomingHighImpactEvents(calendar = [], nowMs = Date.now(), windowHours = 72) {
  return (Array.isArray(calendar) ? calendar : [])
    .filter((e) => e?.timestamp && e.impact === 'High' && e.currency === 'USD')
    .map((e) => ({ ...e, ts: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.ts) && e.ts >= nowMs && e.ts - nowMs <= windowHours * 3600 * 1000)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({
      title: e.title,
      timestamp: e.timestamp,
      hoursAway: round((e.ts - nowMs) / 3600000, 1),
      forecast: e.forecast,
      previous: e.previous
    }));
}

/* ---------------------------------------------------------------------------
 * 2. Selection: gộp theo nguồn, chọn yếu tố chính
 * ------------------------------------------------------------------------- */

export function aggregateFamilies(evidence) {
  const families = {};
  for (const e of evidence) {
    if (!families[e.family]) families[e.family] = { family: e.family, raw: 0, items: 0 };
    families[e.family].raw += e.direction * e.weight;
    families[e.family].items += 1;
  }
  return Object.values(families).map((f) => {
    const capped = clamp(f.raw, -1, 1);
    const weight = FAMILY_WEIGHTS[f.family] ?? 0.5;
    return {
      family: f.family,
      label: FAMILY_LABELS[f.family] || f.family,
      items: f.items,
      rawScore: round(f.raw, 2),
      cappedScore: round(capped, 2),
      weight,
      contribution: round(capped * weight, 3),
      direction: capped > 0.15 ? 'bullish' : capped < -0.15 ? 'bearish' : 'neutral'
    };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

const GROUP_ORDER = ['macro', 'regime', 'structure', 'momentum', 'liquidity', 'volume', 'derivatives', 'onchain', 'sentiment'];
const GROUP_LABELS = {
  macro: 'Kinh tế vĩ mô',
  regime: 'Market regime',
  structure: 'Market structure',
  momentum: 'Động lượng',
  liquidity: 'Thanh khoản',
  volume: 'Volume',
  derivatives: 'Phái sinh',
  onchain: 'On-chain',
  sentiment: 'Tâm lý'
};

function buildFactorTable(evidence, extra) {
  return GROUP_ORDER.map((group) => {
    const items = evidence.filter((e) => e.group === group);
    const score = items.reduce((s, e) => s + (e.direction * e.weight), 0);
    const missing = MISSING_DATA.filter((x) => x.group === group).map((x) => x.item);
    let status = items.length ? (score > 0.25 ? 'bullish' : score < -0.25 ? 'bearish' : 'neutral') : 'no_data';
    const notes = [];
    if (group === 'macro') {
      status = 'no_data';
      if (extra.events.length) {
        notes.push(...extra.events.map((e) => `${e.title} sau ${e.hoursAway}h (dự báo ${e.forecast || '-'}, kỳ trước ${e.previous || '-'})`));
      } else {
        notes.push('Không có sự kiện USD tác động cao trong 72h tới (theo lịch kinh tế).');
      }
    }
    if (group === 'liquidity') {
      status = extra.liquidity.length ? 'neutral' : 'no_data';
      notes.push(...extra.liquidity);
    }
    return {
      group,
      label: GROUP_LABELS[group],
      status,
      score: round(score, 2),
      evidence: items.map(({ text, kind, timing, direction }) => ({ text, kind, timing, direction })),
      notes,
      missing
    };
  });
}

/* ---------------------------------------------------------------------------
 * Vùng giá: gom MA, fib, swing, mốc tròn; nhiều nguồn trùng nhau thì vùng mạnh hơn
 * ------------------------------------------------------------------------- */

// Bước mốc tròn ~6% giá, chọn trong 1/2/5×10^k: BTC 60k → 5.000, ETH 1.700 → 100.
export function roundStep(price) {
  const target = price * 0.06;
  const mag = 10 ** Math.floor(Math.log10(target));
  const steps = [1, 2, 5, 10].map((s) => s * mag);
  return steps.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), steps[0]);
}

export function buildKeyLevels(tech, price, { tolerancePct = 0.6, maxPerSide = 4 } = {}) {
  if (!isNum(price) || !tech) return { supports: [], resistances: [] };
  const candidates = [];
  const tfName = { '1M': 'M', '1w': 'W', '1d': 'D', '4h': '4H' };
  for (const tf of ['1M', '1w', '1d', '4h']) {
    const t = tech[tf];
    if (!t) continue;
    for (const k of ['ma50', 'ma100', 'ma200']) {
      if (isNum(t[k])) candidates.push({ price: t[k], type: 'ma', label: `${k.toUpperCase()} ${tfName[tf]}` });
    }
  }
  for (const tf of ['1d', '4h']) {
    const t = tech[tf];
    if (!t) continue;
    for (const s of t.recentSwings?.highs || []) candidates.push({ price: s.price, type: 'swing', label: `đỉnh ${tfName[tf]}` });
    for (const s of t.recentSwings?.lows || []) candidates.push({ price: s.price, type: 'swing', label: `đáy ${tfName[tf]}` });
  }
  const fib = tech['1d']?.fib;
  if (fib) {
    for (const l of fib.levels) candidates.push({ price: l.price, type: 'fib', label: `fib ${l.ratio} D` });
    candidates.push({ price: fib.swingLow.price, type: 'swing', label: 'đáy swing D' });
    candidates.push({ price: fib.swingHigh.price, type: 'swing', label: 'đỉnh swing D' });
  }
  const step = roundStep(price);
  for (let p = Math.floor((price * 0.8) / step) * step; p <= price * 1.2; p += step) {
    if (p > 0) candidates.push({ price: p, type: 'round', label: `mốc tròn ${fmtPrice(p)}` });
  }

  const relevant = candidates.filter((c) => isNum(c.price) && Math.abs(c.price - price) / price <= 0.25)
    .sort((a, b) => a.price - b.price);
  const tol = price * (tolerancePct / 100);
  const clusters = [];
  for (const c of relevant) {
    const last = clusters[clusters.length - 1];
    if (last && c.price - last.max <= tol) {
      last.items.push(c);
      last.max = c.price;
    } else {
      clusters.push({ min: c.price, max: c.price, items: [c] });
    }
  }

  const strengthLabel = ['yếu', 'yếu', 'trung bình', 'mạnh', 'rất mạnh'];
  const levels = clusters.map((cl) => {
    const types = new Set(cl.items.map((i) => i.type));
    const nonRound = cl.items.filter((i) => i.type !== 'round').length;
    const score = types.size + Math.min(2, Math.max(0, nonRound - types.size));
    const mid = (cl.min + cl.max) / 2;
    return {
      low: round(cl.min, 2),
      high: round(cl.max, 2),
      mid: round(mid, 2),
      distancePct: pctDistance(price, mid),
      strength: strengthLabel[Math.min(4, score)],
      strengthScore: score,
      reasons: [...new Set(cl.items.map((i) => i.label))]
    };
  }).filter((l) => !(l.reasons.length === 1 && l.reasons[0].startsWith('mốc tròn')));

  const supports = levels.filter((l) => l.high < price).sort((a, b) => b.mid - a.mid).slice(0, maxPerSide);
  const resistances = levels.filter((l) => l.low > price).sort((a, b) => a.mid - b.mid).slice(0, maxPerSide);
  return { supports, resistances };
}

// Vùng xác nhận: vùng gần nhất có ít nhất 2 nguồn trùng nhau và cách giá ≥ minDistancePct,
// để một nến ngày đóng qua đó có ý nghĩa (vùng sát giá chỉ là nhiễu trong ngày).
export function pickConfirmLevel(levels, minDistancePct = 1.5) {
  const far = levels.filter((l) => Math.abs(l.distancePct ?? 0) >= minDistancePct);
  return far.find((l) => l.strengthScore >= 2) || far[0] || levels[levels.length - 1] || null;
}

/* ---------------------------------------------------------------------------
 * 3. Sequencing: ba kịch bản
 * ------------------------------------------------------------------------- */

function confidenceFrom({ agreeing, net, coverage, conflicts }) {
  let level = 'low';
  if (agreeing >= 4 && net >= 1.5 && coverage >= 0.6) level = 'high';
  else if (agreeing >= 3 && net >= 0.75) level = 'medium';
  if (conflicts >= 2 && level === 'high') level = 'medium';
  else if (conflicts >= 2 && level === 'medium') level = 'low';
  return level;
}

function topTexts(evidence, sign, n = 4) {
  return evidence
    .filter((e) => Math.sign(e.direction) === sign && e.direction !== 0)
    .sort((a, b) => Math.abs(b.direction * b.weight) - Math.abs(a.direction * a.weight))
    .slice(0, n)
    .map((e) => e.text);
}

function buildScenarios({ evidence, families, levels, price, coverage, conflicts, stat }) {
  const s1 = pickConfirmLevel(levels.supports);
  const r1 = pickConfirmLevel(levels.resistances);
  const s2 = levels.supports.find((l) => s1 && l.mid < s1.low) || null;
  const r2 = levels.resistances.find((l) => r1 && l.mid > r1.high) || null;
  const bullFam = families.filter((f) => f.direction === 'bullish');
  const bearFam = families.filter((f) => f.direction === 'bearish');
  const bullSum = bullFam.reduce((s, f) => s + f.contribution, 0);
  const bearSum = -bearFam.reduce((s, f) => s + f.contribution, 0);
  const neutralFam = families.filter((f) => f.direction === 'neutral');

  const zone = (l) => (l ? `${fmtPrice(l.low)}–${fmtPrice(l.high)}` : 'chưa xác định');

  const bullish = {
    key: 'bullish',
    name: 'Tăng',
    evidenceFor: topTexts(evidence, 1),
    evidenceAgainst: topTexts(evidence, -1),
    confirmation: r1 ? `Nến ngày đóng trên ${fmtPrice(r1.high)} (vùng ${zone(r1)}: ${r1.reasons.join(', ')}), volume ≥ 1,5× trung bình.` : 'Chưa có vùng kháng cự rõ để xác nhận.',
    invalidation: s1 ? `Nến ngày đóng dưới ${fmtPrice(s1.low)}.` : 'Chưa xác định.',
    watchZones: [r1 && `Kháng cự ${zone(r1)}`, r2 && `Mục tiêu kế tiếp ${zone(r2)}`].filter(Boolean),
    horizon: '1–7 ngày (theo nến ngày)',
    confidence: confidenceFrom({ agreeing: bullFam.length, net: bullSum - bearSum, coverage, conflicts }),
    basis: `${bullFam.length} nguồn độc lập ủng hộ (tổng ${round(bullSum, 2)}) so với ${bearFam.length} nguồn phản đối (tổng ${round(bearSum, 2)}).`
  };
  const bearish = {
    key: 'bearish',
    name: 'Giảm',
    evidenceFor: topTexts(evidence, -1),
    evidenceAgainst: topTexts(evidence, 1),
    confirmation: s1 ? `Nến ngày đóng dưới ${fmtPrice(s1.low)} (vùng ${zone(s1)}: ${s1.reasons.join(', ')}), volume ≥ 1,5× trung bình.` : 'Chưa có vùng hỗ trợ rõ để xác nhận.',
    invalidation: r1 ? `Nến ngày đóng trên ${fmtPrice(r1.high)}.` : 'Chưa xác định.',
    watchZones: [s1 && `Hỗ trợ ${zone(s1)}`, s2 && `Mục tiêu kế tiếp ${zone(s2)}`].filter(Boolean),
    horizon: '1–7 ngày (theo nến ngày)',
    confidence: confidenceFrom({ agreeing: bearFam.length, net: bearSum - bullSum, coverage, conflicts }),
    basis: `${bearFam.length} nguồn độc lập ủng hộ (tổng ${round(bearSum, 2)}) so với ${bullFam.length} nguồn phản đối (tổng ${round(bullSum, 2)}).`
  };

  const sidewaysFor = [];
  if (conflicts > 0) sidewaysFor.push(`${conflicts} mâu thuẫn giữa các nhóm/khung (xem phần tự phản biện).`);
  if (neutralFam.length) sidewaysFor.push(`${neutralFam.length} nguồn trung tính: ${neutralFam.map((f) => f.label).join(', ')}.`);
  if (Math.abs(bullSum - bearSum) < 0.75) sidewaysFor.push(`Chênh lệch tăng/giảm nhỏ (${round(bullSum - bearSum, 2)}).`);
  const sidewaysAgainst = [];
  if (Math.abs(bullSum - bearSum) >= 1.5) sidewaysAgainst.push(`Một phía áp đảo rõ (chênh ${round(bullSum - bearSum, 2)}).`);
  const sideways = {
    key: 'sideways',
    name: 'Đi ngang',
    evidenceFor: sidewaysFor,
    evidenceAgainst: sidewaysAgainst,
    confirmation: s1 && r1 ? `Hai nến ngày liên tiếp đóng trong ${fmtPrice(s1.high)}–${fmtPrice(r1.low)}, volume dưới trung bình.` : 'Chưa xác định biên.',
    invalidation: s1 && r1 ? `Nến ngày đóng ngoài biên ${fmtPrice(s1.low)}–${fmtPrice(r1.high)}.` : 'Chưa xác định.',
    watchZones: s1 && r1 ? [`Biên ${zone(s1)} ↔ ${zone(r1)} (rộng ${round(((r1.mid - s1.mid) / price) * 100, 1)}%)`] : [],
    horizon: '1–7 ngày',
    confidence: confidenceFrom({
      agreeing: neutralFam.length + conflicts,
      net: 1.5 - Math.abs(bullSum - bearSum),
      coverage,
      conflicts: 0
    }),
    basis: 'Đi ngang được ủng hộ khi các nguồn trung tính hoặc mâu thuẫn và chênh lệch tăng/giảm nhỏ.'
  };

  if (stat) {
    for (const s of [bullish, bearish, sideways]) {
      const p = s.key === 'bullish' ? stat.up : s.key === 'bearish' ? stat.down : stat.sideway;
      s.statisticalProbabilityPct = round(p, 1);
    }
  }
  return { list: [bullish, bearish, sideways], s1, r1, s2, r2 };
}

/* ---------------------------------------------------------------------------
 * 4–5. Stakes + tự phản biện
 * ------------------------------------------------------------------------- */

export function statisticalModelCheck(model, tf = '1d') {
  const row = model?.byTimeframe?.[tf];
  if (!row || !isNum(row.up)) return null;
  const bt = row.backtest || null;
  const brier = isNum(bt?.brierScore) ? bt.brierScore : null;
  // Fail closed: chỉ coi là có skill khi hàng đã qua pipeline kiểm định ngoài mẫu so với climatology
  // (row.validation.passed === true). Thắng mức đoán đều không đủ vì lớp Sideway chiếm đa số
  // (docs/SYSTEM_AUDIT.md §4.2). Giai đoạn P0 chưa có pipeline nào tạo trường này.
  const beatsUniform = brier !== null && brier < UNIFORM_BRIER;
  const hasSkill = row.validation?.passed === true;
  return {
    timeframe: tf,
    up: row.up,
    down: row.down,
    sideway: row.sideway,
    samples: row.samples,
    thresholdPct: row.thresholdPct,
    brierScore: brier,
    uniformBrier: round(UNIFORM_BRIER, 4),
    directionalAccuracyPct: bt?.directionalAccuracyPct ?? null,
    testSamples: bt?.testSamples ?? null,
    beatsUniform,
    hasSkill,
    verdict: hasSkill
      ? `Đã qua kiểm định ngoài mẫu so với climatology${row.validation.reference ? ` (${row.validation.reference})` : ''}.`
      : brier === null
      ? 'Chưa qua kiểm định ngoài mẫu so với climatology: không dùng xác suất này.'
      : `Brier ${brier} chỉ là chẩn đoán (chưa kiểm định ngoài mẫu so với climatology): không dùng xác suất này.`
  };
}

function findConflicts(families, tech) {
  const out = [];
  const fam = Object.fromEntries(families.map((f) => [f.family, f]));
  const pl = fam['price-long'];
  const ps = fam['price-short'];
  if (pl && ps && pl.direction !== 'neutral' && ps.direction !== 'neutral' && pl.direction !== ps.direction) {
    out.push(`Giá dài hạn ${pl.direction === 'bullish' ? 'tăng' : 'giảm'} nhưng ngắn hạn ${ps.direction === 'bullish' ? 'tăng' : 'giảm'}: nhịp ngắn hạn có thể chỉ là hồi/điều chỉnh trong trend lớn.`);
  }
  const contrarian = ['funding', 'sentiment', 'positioning'].map((k) => fam[k]).filter((f) => f && f.direction !== 'neutral');
  const trendDir = pl?.direction;
  for (const f of contrarian) {
    if (trendDir && trendDir !== 'neutral' && f.direction !== trendDir) {
      out.push(`${f.label} đang cho tín hiệu ngược trend (${f.direction === 'bullish' ? 'tăng' : 'giảm'}). Tín hiệu đám đông thường đi sớm và có thể sai kéo dài trong trend mạnh.`);
    }
  }
  const d = tech?.['1d'];
  const w = tech?.['1w'];
  if (d && w && isNum(d.rsi) && isNum(w.rsi) && d.rsi < 30 && w.rsi < 50) {
    out.push(`RSI ngày quá bán (${d.rsi}) trong khi RSI tuần dưới 50 (${w.rsi}): quá bán có thể kéo dài trong trend giảm.`);
  }
  return out;
}

function costModel(m, holdDays = 3) {
  const fundingPct = isNum(m?.fundingRate) ? m.fundingRate * 100 : null;
  const periods = holdDays * 3;
  const fees = TAKER_FEE_PCT * 2;
  const slippage = DEFAULT_SLIPPAGE_PCT * 2;
  const fundingLong = fundingPct === null ? null : round(fundingPct * periods, 4);
  return {
    holdDays,
    feesRoundTripPct: round(fees, 3),
    slippageRoundTripPct: round(slippage, 3),
    fundingPerPeriodPct: round(fundingPct, 4),
    fundingPeriods: periods,
    fundingCostLongPct: fundingLong,
    fundingCostShortPct: fundingLong === null ? null : round(-fundingLong, 4),
    totalLongPct: fundingLong === null ? null : round(fees + slippage + fundingLong, 4),
    totalShortPct: fundingLong === null ? null : round(fees + slippage - fundingLong, 4),
    note: `Phí taker ${TAKER_FEE_PCT}%/chiều, trượt giá giả định ${DEFAULT_SLIPPAGE_PCT}%/chiều, funding giữ nguyên mức hiện tại trong ${holdDays} ngày (${periods} kỳ 8h). Funding dương: long trả, short nhận.`
  };
}

// Stop thường đặt ngay ngoài đỉnh/đáy swing gần nhất, nên coi đó là vùng thanh khoản (suy luận).
export function liquidityNotes(tech, price) {
  if (!tech || !isNum(price)) return [];
  const highs = [];
  const lows = [];
  for (const [tf, label] of [['1d', 'D'], ['4h', '4H']]) {
    const sw = tech[tf]?.recentSwings;
    for (const s of sw?.highs || []) if (s.price > price) highs.push({ ...s, label });
    for (const s of sw?.lows || []) if (s.price < price) lows.push({ ...s, label });
  }
  const fib = tech['1d']?.fib;
  if (fib && fib.swingLow.price < price) lows.push({ price: fib.swingLow.price, label: 'D (đáy swing lớn)' });
  if (fib && fib.swingHigh.price > price) highs.push({ price: fib.swingHigh.price, label: 'D (đỉnh swing lớn)' });
  highs.sort((a, b) => a.price - b.price);
  lows.sort((a, b) => b.price - a.price);
  const notes = [];
  if (highs[0]) notes.push(`Stop của phe short có thể nằm trên đỉnh ${highs[0].label} ${fmtPrice(highs[0].price)} (+${pctDistance(price, highs[0].price)}%) [suy luận từ swing].`);
  if (lows[0]) notes.push(`Stop của phe long có thể nằm dưới đáy ${lows[0].label} ${fmtPrice(lows[0].price)} (${pctDistance(price, lows[0].price)}%) [suy luận từ swing].`);
  return notes;
}

function buildMispricing(families, tech, m) {
  const out = [];
  const fam = Object.fromEntries(families.map((f) => [f.family, f]));
  const fr = isNum(m?.fundingRate) ? m.fundingRate * 100 : null;
  const fg = m?.fearGreed;
  if (fam['price-long']?.direction === 'bearish' && fr !== null && fr < -0.01 && isNum(fg) && fg < 25) {
    out.push('Trend giảm, funding âm và sợ hãi cực độ cùng lúc: thị trường có thể đang định giá quá mức kịch bản giảm, rủi ro short squeeze cao hơn bình thường.');
  }
  if (fam['price-long']?.direction === 'bullish' && fr !== null && fr > 0.05 && isNum(fg) && fg > 75) {
    out.push('Trend tăng, funding cao và tham lam cực độ cùng lúc: thị trường có thể đang định giá quá mức kịch bản tăng, rủi ro quét long.');
  }
  const d = tech?.['1d'];
  if (d && isNum(d.ma50) && isNum(d.price)) {
    const stretch = pctDistance(d.ma50, d.price);
    if (Math.abs(stretch) >= 15) {
      out.push(`Giá cách MA50 ngày ${stretch}%: mức kéo giãn lớn, thường đi kèm nhịp hồi về trung bình (suy luận, chưa kiểm định thống kê trong dashboard).`);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Hàm chính
 * ------------------------------------------------------------------------- */

/**
 * Độ sẵn có của từng nguồn độc lập, tách khỏi việc nguồn đó có kích hoạt rule hay không.
 * 'available' = có số liệu mới; 'stale' = có số liệu nhưng nguồn báo cũ; 'missing' = không có.
 * sourceHealth (tuỳ chọn, từ server): { [family]: { ok, stale } }. Riêng on-chain, feed chạy
 * thành công nhưng rỗng vẫn là 'available' (rỗng hợp lệ ≠ thiếu dữ liệu).
 */
export function familyAvailability({ tech, metrics = {}, usdcEvents = [], sourceHealth = {} }) {
  const has = {
    'price-long': Boolean(tech?.['1w']),
    'price-short': Boolean(tech?.['1d']),
    volume: isNum(tech?.['1d']?.lastClosedVolRatio),
    funding: isNum(metrics.fundingRate),
    oi: isNum(metrics.openInterestChange6h) && isNum(metrics.momentum6h),
    positioning: isNum(metrics.longShortRatio) || isNum(metrics.topTraderLongShortRatio),
    flow: isNum(metrics.takerBuySellRatio),
    sentiment: isNum(metrics.fearGreed),
    onchain: sourceHealth.onchain ? sourceHealth.onchain.ok === true || (Array.isArray(usdcEvents) && usdcEvents.length > 0)
      : Array.isArray(usdcEvents) && usdcEvents.length > 0
  };
  return Object.fromEntries(Object.keys(FAMILY_WEIGHTS).map((f) => {
    if (!has[f]) return [f, 'missing'];
    return [f, sourceHealth[f]?.stale ? 'stale' : 'available'];
  }));
}

export function buildMarketReport({
  symbol,
  metrics = {},
  technicals = null,
  calendar = [],
  usdcEvents = [],
  sourceHealth = {},
  errors = [],
  nowMs = Date.now()
}) {
  const tech = technicals?.byTf || null;
  const price = isNum(metrics.price) ? metrics.price : tech?.['1d']?.price ?? null;

  // 1. Deconstruction
  const evidence = [
    ...priceLongEvidence(tech),
    ...priceShortEvidence(tech),
    ...volumeEvidence(tech),
    ...derivativesEvidence(metrics),
    ...onchainEvidence(usdcEvents),
    ...sentimentEvidence(metrics)
  ];
  const events = upcomingHighImpactEvents(calendar, nowMs);
  const levels = buildKeyLevels(tech, price);
  const factorTable = buildFactorTable(evidence, { events, liquidity: liquidityNotes(tech, price) });

  // 2. Selection
  const families = aggregateFamilies(evidence);
  const familyTotal = Object.keys(FAMILY_WEIGHTS).length;
  const availability = familyAvailability({ tech, metrics, usdcEvents, sourceHealth });
  const availableCount = Object.values(availability).filter((v) => v !== 'missing').length;
  const freshCount = Object.values(availability).filter((v) => v === 'available').length;
  // Độ phủ dùng cho kết luận/độ tin cậy = tỷ lệ nguồn có dữ liệu MỚI (không tính nguồn cũ hay thiếu)
  const coverage = freshCount / familyTotal;
  const activeEvidenceShare = families.filter((f) => f.direction !== 'neutral').length / familyTotal;
  const topFactors = families.filter((f) => f.direction !== 'neutral').slice(0, 5);
  const directional = evidence.filter((e) => e.direction !== 0);
  const timingMix = ['leading', 'coincident', 'lagging'].reduce((acc, t) => {
    acc[t] = directional.filter((e) => e.timing === t).length;
    return acc;
  }, {});
  const netScore = round(families.reduce((s, f) => s + f.contribution, 0), 2);
  const maxScore = round(families.reduce((s, f) => s + f.weight, 0), 2);

  // 3. Sequencing
  const conflicts = findConflicts(families, tech);
  const stat = statisticalModelCheck(metrics.historicalScenarioModel, '1d');
  const statForProb = stat?.hasSkill ? stat : null;
  const scenarios = buildScenarios({ evidence, families, levels, price, coverage, conflicts: conflicts.length, stat: statForProb });

  // 4. Stakes
  const missingData = MISSING_DATA.map((x) => x.item);
  const technicalGaps = [];
  if (tech?.['1M'] && tech['1M'].ma200 === null) technicalGaps.push(`MA200 tháng: chỉ có ${tech['1M'].bars} nến tháng.`);
  for (const tf of ['1w', '1d', '4h', '1h']) {
    if (tech && !tech[tf]) technicalGaps.push(`Không lấy được nến khung ${tf}.`);
  }
  if (!tech) technicalGaps.push('Không lấy được dữ liệu kỹ thuật đa khung.');

  const biasDir = netScore >= 1 ? 'bullish' : netScore <= -1 ? 'bearish' : 'neutral';
  const insufficient = coverage < 0.5 || !tech;
  const risks = [];
  if (events.length) risks.push(`Sự kiện vĩ mô USD tác động cao trong ${events[0].hoursAway}h tới (${events[0].title}): biến động có thể vô hiệu hoá mọi vùng kỹ thuật.`);
  if (isNum(metrics.realizedVol24h) && metrics.realizedVol24h > 4.5) risks.push(`Biến động thực tế 24h ${round(metrics.realizedVol24h, 2)}% cao: SL dễ bị quét.`);
  if (isNum(metrics.deribitIv) && metrics.deribitIv > 75) risks.push(`Deribit IV ${round(metrics.deribitIv, 1)}% cao: thị trường kỳ vọng biến động lớn.`);
  if (scenarios.s1 && scenarios.r1) {
    risks.push(`Khoảng cách tới vùng vô hiệu: hỗ trợ ${scenarios.s1.distancePct}%, kháng cự +${scenarios.r1.distancePct}%.`);
  }
  risks.push('Mô hình không đọc được tin tức, thanh lý hàng loạt hay dòng tiền ETF; cú sốc ngoài dữ liệu có thể làm sai toàn bộ phân tích.');

  // 5. Tự phản biện
  const lagShare = directional.length ? timingMix.lagging / directional.length : 0;
  const priceItems = evidence.filter((e) => e.family.startsWith('price')).length;
  const quantChecks = [
    `Dữ liệu: ${freshCount}/${familyTotal} nguồn độc lập có số liệu mới, ${availableCount - freshCount} nguồn cũ, ${familyTotal - availableCount} nguồn thiếu; ${families.filter((f) => f.direction !== 'neutral').length} nguồn đang nghiêng về một phía.`,
    `${priceItems} chỉ báo giá (MA, RSI, MACD, cấu trúc) đều từ cùng một chuỗi giá, đã được gộp thành tối đa 2 nguồn (dài hạn/ngắn hạn).`,
    stat ? `Mô hình thống kê khung 1d (n=${stat.samples}, test=${stat.testSamples ?? '-'}): ${stat.verdict}` : 'Không có mô hình thống kê cho khung 1d.',
    `Cơ cấu bằng chứng có hướng: dẫn dắt ${timingMix.leading}, trùng hợp ${timingMix.coincident}, trễ ${timingMix.lagging}.`
  ];
  const namesWith = (state) => Object.entries(availability).filter(([, v]) => v === state).map(([f]) => FAMILY_LABELS[f] || f);
  if (namesWith('missing').length) quantChecks.push(`Nguồn thiếu dữ liệu: ${namesWith('missing').join(', ')}.`);
  if (namesWith('stale').length) quantChecks.push(`Nguồn có dữ liệu cũ (không tính vào độ phủ): ${namesWith('stale').join(', ')}.`);
  if (errors.length) quantChecks.push(`${errors.length} nguồn dữ liệu lỗi trong lần cập nhật này: ${errors.slice(0, 3).join('; ')}.`);

  const devil = [...conflicts];
  if (lagShare > 0.5) devil.push(`${Math.round(lagShare * 100)}% bằng chứng có hướng là chỉ báo trễ: kết luận phản ánh quá khứ nhiều hơn tương lai.`);
  devil.push('Nhóm vĩ mô không có số liệu (chỉ có lịch sự kiện): nếu vĩ mô là động lực chính lúc này thì phân tích đang bỏ sót.');
  devil.push('Ngưỡng của các rule (RSI 30/70, funding ±0,01–0,05%, L/S 0,7/1,8) là ngưỡng thông dụng, chưa được tối ưu hay kiểm định riêng cho mã này.');

  let finalConfidence = 'low';
  const agreeing = biasDir === 'bullish' ? families.filter((f) => f.direction === 'bullish').length
    : biasDir === 'bearish' ? families.filter((f) => f.direction === 'bearish').length : 0;
  if (!insufficient && biasDir !== 'neutral') {
    finalConfidence = confidenceFrom({ agreeing, net: Math.abs(netScore), coverage, conflicts: conflicts.length });
  }
  const finalStance = insufficient
    ? 'Chưa đủ dữ liệu để xác định xu hướng.'
    : biasDir === 'neutral'
    ? 'Bằng chứng không nghiêng rõ về phía nào: ưu tiên kịch bản đi ngang, chờ giá đóng nến ngoài biên.'
    : `Nghiêng ${biasDir === 'bullish' ? 'TĂNG' : 'GIẢM'} (điểm ròng ${netScore}/${maxScore}), độ tin cậy ${finalConfidence === 'high' ? 'cao' : finalConfidence === 'medium' ? 'trung bình' : 'thấp'}${conflicts.length ? `, đã hạ do ${conflicts.length} mâu thuẫn` : ''}.`;

  const selfCritique = {
    bull: topTexts(evidence, 1, 3),
    bear: topTexts(evidence, -1, 3),
    quant: quantChecks,
    devilsAdvocate: devil,
    riskManager: risks,
    final: finalStance
  };
  if (!selfCritique.bull.length) selfCritique.bull = ['Không có bằng chứng tăng đáng kể trong dữ liệu hiện có.'];
  if (!selfCritique.bear.length) selfCritique.bear = ['Không có bằng chứng giảm đáng kể trong dữ liệu hiện có.'];

  // Điều kiện vô hiệu toàn bộ nhận định
  const w = tech?.['1w'];
  const globalInvalidation = [];
  if (biasDir === 'bearish') {
    if (isNum(w?.ma200)) globalInvalidation.push(`Nến tuần đóng trên MA200 tuần ${fmtPrice(w.ma200)}.`);
    if (scenarios.r2) globalInvalidation.push(`Nến ngày đóng trên ${fmtPrice(scenarios.r2.high)}.`);
  } else if (biasDir === 'bullish') {
    if (isNum(w?.ma200)) globalInvalidation.push(`Nến tuần đóng dưới MA200 tuần ${fmtPrice(w.ma200)}.`);
    if (scenarios.s2) globalInvalidation.push(`Nến ngày đóng dưới ${fmtPrice(scenarios.s2.low)}.`);
  } else if (scenarios.s1 && scenarios.r1) {
    globalInvalidation.push(`Nến ngày đóng ngoài biên ${fmtPrice(scenarios.s1.low)}–${fmtPrice(scenarios.r1.high)} với volume ≥ 1,5× trung bình.`);
  }
  if (!globalInvalidation.length) globalInvalidation.push('Chưa đủ dữ liệu vùng giá để đặt điều kiện vô hiệu.');

  // Tín hiệu cần theo dõi
  const watch = [];
  for (const e of events) watch.push(`${e.title} sau ${e.hoursAway}h.`);
  if (scenarios.r1) watch.push(`Nến ngày đóng trên ${fmtPrice(scenarios.r1.high)} (xác nhận tăng).`);
  if (scenarios.s1) watch.push(`Nến ngày đóng dưới ${fmtPrice(scenarios.s1.low)} (xác nhận giảm).`);
  const d = tech?.['1d'];
  if (d && isNum(d.rsi)) watch.push(`RSI ngày cắt qua 50 (hiện ${d.rsi}).`);
  if (d && isNum(d.macdHist)) watch.push(`MACD ngày cắt signal (histogram hiện ${round(d.macdHist, 2)}).`);
  if (isNum(metrics.fundingRate)) watch.push(`Funding đổi dấu (hiện ${round(metrics.fundingRate * 100, 4)}%).`);
  if (isNum(w?.ma200)) watch.push(`Giá đóng tuần so với MA200 tuần ${fmtPrice(w.ma200)}.`);

  const regime = !w || !isNum(w.ma200)
    ? 'unknown'
    : w.price < w.ma200 ? 'bear' : (w.ma50 > w.ma200 ? 'bull' : 'transition');
  const regimeLabel = { bear: 'Gấu (dưới MA200 tuần)', bull: 'Bò (trên MA200 tuần, MA50 > MA200)', transition: 'Chuyển tiếp', unknown: 'Chưa xác định' }[regime];

  return {
    symbol,
    generatedAt: new Date(nowMs).toISOString(),
    framework: 'DiSSS + First Principles (rule-based, không dùng LLM)',
    summary: {
      price,
      regime,
      regimeLabel,
      bias: insufficient ? 'insufficient' : biasDir,
      netScore,
      maxScore,
      confidence: finalConfidence,
      dataAvailablePct: Math.round((availableCount / familyTotal) * 100),
      freshDataPct: Math.round(coverage * 100),
      activeEvidencePct: Math.round(activeEvidenceShare * 100),
      text: finalStance
    },
    factorTable,
    families,
    availability,
    topFactors,
    timingMix,
    scenarios: scenarios.list,
    statisticalModel: stat,
    keyLevels: levels,
    watchSignals: watch,
    selfCritique,
    mispricing: buildMispricing(families, tech, metrics),
    globalInvalidation,
    stakes: {
      missingData,
      technicalGaps,
      biasRisks: [
        'Thiên kiến xác nhận: chỉ đọc các dòng ủng hộ hướng mình đang giữ lệnh. Hãy đọc phần "phản đối" của từng kịch bản trước.',
        'FOMO: đuổi theo nến đã chạy xa vùng xác nhận. Chỉ vào lệnh tại vùng giá đã liệt kê.',
        'Quá tự tin: độ tin cậy "cao" chỉ có nghĩa là nhiều nguồn đồng thuận, không phải chắc chắn.'
      ],
      validationPlan: [
        'Backtest: lưu snapshot báo cáo mỗi ngày (bias, vùng S1/R1), đo tỷ lệ giá chạm vùng xác nhận trước vùng vô hiệu trong 7 ngày, trừ chi phí bên dưới.',
        'Chia dữ liệu theo thời gian (70% train / 30% test) như mô hình thống kê hiện có; so Brier với mức đoán đều 0,2222.',
        'Paper trading tối thiểu 30 lệnh trước khi tin vào bất kỳ ngưỡng nào; ghi lại lý do vào lệnh theo từng nhóm yếu tố.'
      ],
      costModel: costModel(metrics, 3)
    },
    disclaimer: 'Chỉ phục vụ nghiên cứu, backtest và giao dịch giả lập. Không thực thi lệnh bằng tiền thật.'
  };
}
