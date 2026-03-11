/**
 * Trend scoring logic với rule-based system
 * Mỗi rule trả về { name, pass, score, reason }
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function computeCloseGuides(m) {
  if (!Number.isFinite(m.price) || m.price <= 0) return [];

  const volBase = clamp(finiteOr(m.realizedVol24h, 2.4), 1.2, 6.5);
  const tfs = [
    { key: '1h', changeKey: 'closeChange1h', mult: 0.22, min: 0.25, max: 1.4 },
    { key: '4h', changeKey: 'closeChange4h', mult: 0.45, min: 0.55, max: 2.5 },
    { key: '1d', changeKey: 'closeChange1d', mult: 0.9, min: 1.1, max: 4.2 },
    { key: '1w', changeKey: 'closeChange1w', mult: 1.7, min: 2.2, max: 8.0 }
  ];

  return tfs.map((tf) => {
    const change = finiteOr(m[tf.changeKey], 0);
    const driftAdj = clamp(Math.abs(change) * 0.35, 0, tf.max * 0.45);
    const thresholdPct = clamp(volBase * tf.mult + driftAdj, tf.min, tf.max);
    const bullishAbove = m.price * (1 + thresholdPct / 100);
    const bearishBelow = m.price * (1 - thresholdPct / 100);
    const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    const clarity = Math.abs(change) >= thresholdPct ? 'clear' : 'developing';

    return {
      timeframe: tf.key,
      thresholdPct: round(thresholdPct, 2),
      bullishAbove: round(bullishAbove, 2),
      bearishBelow: round(bearishBelow, 2),
      currentCloseChangePct: round(change, 2),
      direction,
      clarity
    };
  });
}

function normalizeProbability(scenarios) {
  const rawTotal = scenarios.reduce((sum, s) => sum + finiteOr(s.raw, 0), 0);
  if (!rawTotal) {
    return scenarios
      .map(({ raw, ...rest }) => ({ ...rest, probability: 0 }))
      .sort((a, b) => b.probability - a.probability);
  }
  return scenarios
    .map(({ raw, ...rest }) => ({ ...rest, probability: Math.round((raw / rawTotal) * 1000) / 10 }))
    .sort((a, b) => b.probability - a.probability);
}

function computeScenarioProbabilities(m, score) {
  const change1h = finiteOr(m.closeChange1h, 0);
  const change4h = finiteOr(m.closeChange4h, 0);
  const change1d = finiteOr(m.closeChange1d, 0);
  const change1w = finiteOr(m.closeChange1w, 0);
  const weightedChange = (change1h * 0.1) + (change4h * 0.2) + (change1d * 0.3) + (change1w * 0.4);

  const takerTilt = finiteOr(m.takerBuySellRatio) > 1 ? 0.22 : finiteOr(m.takerBuySellRatio) < 1 ? -0.22 : 0;
  const fundingTilt = finiteOr(m.fundingRate) < 0 ? 0.18 : finiteOr(m.fundingRate) > 0 ? -0.18 : 0;
  const pressure = clamp((score / 6) + (weightedChange / 8) + takerTilt + fundingTilt, -2.5, 2.5);

  const shortCrowded = (finiteOr(m.fundingRate) < 0 ? 1.2 : 0)
    + (finiteOr(m.longShortRatio, 1) < 0.95 ? 0.8 : 0)
    + (finiteOr(m.openInterestChange6h) > 6 ? 0.8 : 0);
  const longCrowded = (finiteOr(m.fundingRate) > 0 ? 1.2 : 0)
    + (finiteOr(m.longShortRatio, 1) > 1.35 ? 0.8 : 0)
    + (finiteOr(m.openInterestChange6h) > 6 ? 0.8 : 0);

  const extreme24h = Math.abs(finiteOr(m.priceChange24h)) > 4;

  const scenarios = [
    {
      name: 'Bullish Continuation',
      bias: 'bullish',
      note: 'Đà tăng duy trì nếu đóng nến các khung lớn vượt mức xác nhận.',
      raw: Math.max(8, 44 + pressure * 18)
    },
    {
      name: 'Bearish Continuation',
      bias: 'bearish',
      note: 'Đà giảm duy trì nếu đóng nến liên tiếp dưới vùng xác nhận.',
      raw: Math.max(8, 44 - pressure * 18)
    },
    {
      name: 'Sideways / Chop',
      bias: 'neutral',
      note: 'Giá dao động nhiễu khi score thấp và chưa có break xác nhận.',
      raw: Math.max(10, 42 - Math.abs(score) * 7 - Math.abs(weightedChange) * 2.2)
    },
    {
      name: 'Short Squeeze Up',
      bias: 'bullish',
      note: 'Xác suất tăng mạnh khi crowd short dồn và bị ép đóng vị thế.',
      raw: 8 + shortCrowded * 8
    },
    {
      name: 'Long Squeeze Down',
      bias: 'bearish',
      note: 'Xác suất giảm mạnh khi crowd long cao và bị ép thanh lý.',
      raw: 8 + longCrowded * 8
    },
    {
      name: 'Mean-Reversion Whipsaw',
      bias: 'neutral',
      note: 'Sau biến động mạnh, giá dễ giật ngược hai chiều.',
      raw: 8 + (extreme24h ? 10 : 2) + (Math.abs(score) <= 1 ? 4 : 0)
    }
  ];

  return normalizeProbability(scenarios);
}

export function inferTrend(m) {
  const rules = [];
  let score = 0;
  const reasons = [];
  const risks = [];
  const alerts = [];

  // Rule 1: Funding Rate
  if (m.fundingRate !== null) {
    if (m.fundingRate > 0.0008) {
      const delta = -1;
      score += delta;
      const reason = 'Funding cao (crowded long), dễ quét long.';
      reasons.push(reason);
      alerts.push({ level: 'warn', type: 'Derivatives', text: 'Funding dương cao: hạn chế đuổi long.' });
      rules.push({ name: 'Funding Rate High', pass: true, score: delta, reason });
    } else if (m.fundingRate < -0.0008) {
      const delta = 1;
      score += delta;
      const reason = 'Funding âm sâu (crowded short), dễ short squeeze.';
      reasons.push(reason);
      alerts.push({ level: 'info', type: 'Derivatives', text: 'Funding âm sâu: để ý short squeeze.' });
      rules.push({ name: 'Funding Rate Low', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'Funding Rate Neutral', pass: false, score: 0, reason: 'Funding trong vùng trung tính.' });
    }
  } else {
    rules.push({ name: 'Funding Rate', pass: false, score: 0, reason: 'Không có dữ liệu funding.' });
  }

  // Rule 2: OI Change + Funding
  if (m.openInterestChange6h !== null) {
    if (m.openInterestChange6h > 8 && m.fundingRate > 0) {
      const delta = -2;
      score += delta;
      const reason = 'OI tăng nhanh + funding dương: rủi ro đạp long ngắn hạn.';
      reasons.push(reason);
      alerts.push({ level: 'danger', type: 'Positioning', text: 'OI tăng nóng cùng long crowd: nguy cơ long squeeze.' });
      rules.push({ name: 'OI Surge + Long Crowded', pass: true, score: delta, reason });
    } else if (m.openInterestChange6h > 8 && m.fundingRate < 0) {
      const delta = 1;
      score += delta;
      const reason = 'OI tăng nhanh + funding âm: có thể build vị thế short, dễ squeeze ngược.';
      reasons.push(reason);
      rules.push({ name: 'OI Surge + Short Crowded', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'OI Change', pass: false, score: 0, reason: 'OI change không đủ mạnh để đưa ra tín hiệu.' });
    }
  } else {
    rules.push({ name: 'OI Change', pass: false, score: 0, reason: 'Không có dữ liệu OI change.' });
  }

  // Rule 3: Long/Short Ratio
  if (m.longShortRatio !== null) {
    if (m.longShortRatio > 1.8) {
      const delta = -1;
      score += delta;
      const reason = 'Tỷ lệ long/short toàn thị trường cao, crowd nghiêng long.';
      reasons.push(reason);
      rules.push({ name: 'Global L/S Ratio High', pass: true, score: delta, reason });
    } else if (m.longShortRatio < 0.7) {
      const delta = 1;
      score += delta;
      const reason = 'Tỷ lệ long/short thấp, crowd nghiêng short.';
      reasons.push(reason);
      rules.push({ name: 'Global L/S Ratio Low', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'Global L/S Ratio', pass: false, score: 0, reason: 'L/S ratio ở vùng trung tính.' });
    }
  } else {
    rules.push({ name: 'Global L/S Ratio', pass: false, score: 0, reason: 'Không có dữ liệu L/S ratio.' });
  }

  // Rule 4: Top Trader L/S Ratio
  if (m.topTraderLongShortRatio !== null) {
    if (m.topTraderLongShortRatio > 2.0 && m.fundingRate > 0) {
      const delta = -1;
      score += delta;
      const reason = 'Top trader ratio nghiêng long mạnh khi funding dương.';
      reasons.push(reason);
      rules.push({ name: 'Top Trader L/S High + Funding+', pass: true, score: delta, reason });
    } else if (m.topTraderLongShortRatio < 0.65 && m.fundingRate < 0) {
      const delta = 1;
      score += delta;
      const reason = 'Top trader ratio nghiêng short mạnh khi funding âm.';
      reasons.push(reason);
      rules.push({ name: 'Top Trader L/S Low + Funding-', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'Top Trader L/S', pass: false, score: 0, reason: 'Top trader không cho tín hiệu mạnh.' });
    }
  } else {
    rules.push({ name: 'Top Trader L/S', pass: false, score: 0, reason: 'Không có dữ liệu top trader.' });
  }

  // Rule 5: Taker Buy/Sell Ratio
  if (m.takerBuySellRatio !== null) {
    if (m.takerBuySellRatio < 0.92) {
      const delta = -1;
      score += delta;
      const reason = 'Taker flow nghiêng sell chủ động.';
      reasons.push(reason);
      alerts.push({ level: 'warn', type: 'Orderflow', text: 'Aggressive sellers chiếm ưu thế.' });
      rules.push({ name: 'Taker Flow Sell Heavy', pass: true, score: delta, reason });
    } else if (m.takerBuySellRatio > 1.08) {
      const delta = 1;
      score += delta;
      const reason = 'Taker flow nghiêng buy chủ động.';
      reasons.push(reason);
      rules.push({ name: 'Taker Flow Buy Heavy', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'Taker Flow', pass: false, score: 0, reason: 'Taker flow cân bằng.' });
    }
  } else {
    rules.push({ name: 'Taker Flow', pass: false, score: 0, reason: 'Không có dữ liệu taker flow.' });
  }

  // Rule 6: Fear & Greed
  if (m.fearGreed !== null) {
    if (m.fearGreed > 75) {
      const delta = -1;
      score += delta;
      const reason = 'Fear & Greed ở vùng tham lam cao.';
      reasons.push(reason);
      rules.push({ name: 'Fear & Greed Extreme Greed', pass: true, score: delta, reason });
    } else if (m.fearGreed < 25) {
      const delta = 1;
      score += delta;
      const reason = 'Fear & Greed ở vùng sợ hãi cao.';
      reasons.push(reason);
      rules.push({ name: 'Fear & Greed Extreme Fear', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'Fear & Greed', pass: false, score: 0, reason: 'Sentiment ở vùng trung tính.' });
    }
  } else {
    rules.push({ name: 'Fear & Greed', pass: false, score: 0, reason: 'Không có dữ liệu Fear & Greed.' });
  }

  // Rule 7: Price Change + Funding
  if (m.priceChange24h !== null) {
    if (m.priceChange24h > 4 && m.fundingRate > 0.0006) {
      const delta = -1;
      score += delta;
      const reason = 'Giá tăng nóng kèm funding dương, rủi ro pullback.';
      reasons.push(reason);
      rules.push({ name: 'Price Pump + Funding+', pass: true, score: delta, reason });
    } else if (m.priceChange24h < -4 && m.fundingRate < -0.0006) {
      const delta = 1;
      score += delta;
      const reason = 'Giá giảm mạnh kèm funding âm, dễ có nhịp hồi kỹ thuật.';
      reasons.push(reason);
      rules.push({ name: 'Price Dump + Funding-', pass: true, score: delta, reason });
    } else {
      rules.push({ name: 'Price Momentum', pass: false, score: 0, reason: 'Price change không đủ cực đoan.' });
    }
  } else {
    rules.push({ name: 'Price Momentum', pass: false, score: 0, reason: 'Không có dữ liệu price change.' });
  }

  // Risk checks (không ảnh hưởng score nhưng tạo cảnh báo)
  if (m.realizedVol24h !== null && m.realizedVol24h > 4.5) {
    risks.push('Biến động thực tế 24h cao, giảm đòn bẩy để tránh quét nhiễu.');
    alerts.push({ level: 'warn', type: 'Volatility', text: 'Biến động nội ngày cao bất thường.' });
    rules.push({ name: 'High Volatility Warning', pass: true, score: 0, reason: 'Realized vol 24h > 4.5%' });
  }

  if (m.deribitIv !== null && m.deribitIv > 75) {
    risks.push('Biến động kỳ vọng cao (Deribit IV cao), nên giảm size.');
    rules.push({ name: 'High IV Warning', pass: true, score: 0, reason: 'Deribit IV > 75%' });
  }

  const outlook = score <= -2 ? 'Bearish Bias' : score >= 2 ? 'Bullish Bias' : 'Sideways / High-Noise';
  const closeGuides = computeCloseGuides(m);
  const scenarioProbabilities = computeScenarioProbabilities(m, score);

  return {
    score,
    outlook,
    confidence: Math.min(90, 45 + Math.abs(score) * 10),
    reasons,
    risks,
    alerts,
    rules, // Thêm chi tiết từng rule để frontend hiển thị
    closeGuides,
    scenarioProbabilities,
    playbook: score <= -2
      ? 'Ưu tiên chờ setup short theo hồi; tránh đuổi nến đỏ, quản trị SL chặt.'
      : score >= 2
      ? 'Ưu tiên canh long sau nhịp quét xuống; tránh FOMO breakout yếu.'
      : 'Thị trường nhiễu, ưu tiên position nhỏ hoặc đứng ngoài chờ xác nhận.'
  };
}
