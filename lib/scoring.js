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

function pickMonthlyThresholdBase(m, key) {
  const base = m?.timeframeThresholdBase30d?.[key];
  return Number.isFinite(base) ? base : null;
}

// Chỉ nhận hàng lịch sử đã qua pipeline kiểm định ngoài mẫu (row.validation.passed === true).
// Giai đoạn P0 chưa có pipeline nào tạo trường này nên luôn trả null (fail closed):
// không trộn số lịch sử vào kịch bản, không dùng Brier / độ đúng hướng chưa kiểm định để chỉnh quyết định.
function validatedHistoricalRow(m, key) {
  const row = m?.historicalScenarioModel?.byTimeframe?.[key];
  return row?.validation?.passed === true ? row : null;
}

// Number(null) = 0 sẽ biến metric thiếu thành 0; chỉ nhận số thật.
function metricOrNaN(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

function pickHistoricalScenario(m, key) {
  const row = validatedHistoricalRow(m, key);
  if (!row) return null;
  if (!Number.isFinite(row.up) || !Number.isFinite(row.down) || !Number.isFinite(row.sideway)) return null;
  return row;
}

function computeCloseGuides(m) {
  if (!Number.isFinite(m.price) || m.price <= 0) return [];

  const volBase = clamp(finiteOr(m.realizedVol24h, 2.4), 1.2, 6.5);
  const tfs = [
    { key: '4h', changeKey: 'closeChange4h', mult: 0.45, min: 0.55, max: 2.5 },
    { key: '1d', changeKey: 'closeChange1d', mult: 0.9, min: 1.1, max: 4.2 },
    { key: '1w', changeKey: 'closeChange1w', mult: 1.7, min: 2.2, max: 8.0 }
  ];

  return tfs.map((tf) => {
    const change = finiteOr(m[tf.changeKey], 0);
    const driftAdj = clamp(Math.abs(change) * 0.35, 0, tf.max * 0.45);
    const monthlyBase = pickMonthlyThresholdBase(m, tf.key);
    const thresholdPct = monthlyBase !== null
      ? clamp(monthlyBase, tf.min, tf.max)
      : clamp(volBase * tf.mult + driftAdj, tf.min, tf.max);
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

function toProbabilityMap(scenarios) {
  const map = { up: 0, down: 0, sideway: 0 };
  for (const s of scenarios || []) {
    if (s.name === 'Tăng') map.up = finiteOr(s.probability, 0);
    else if (s.name === 'Giảm') map.down = finiteOr(s.probability, 0);
    else if (s.name === 'Sideway') map.sideway = finiteOr(s.probability, 0);
  }
  return map;
}

function computeScenarioProbabilities(m, score, timeframeHours = 4) {
  const change1h = finiteOr(m.closeChange1h, 0);
  const change4h = finiteOr(m.closeChange4h, 0);
  const change1d = finiteOr(m.closeChange1d, 0);
  const change1w = finiteOr(m.closeChange1w, 0);

  // Adjust weights based on selected timeframe
  let w1h, w4h, w1d, w1w;
  if (timeframeHours <= 4) {
    w1h = 0.5; w4h = 0.35; w1d = 0.1; w1w = 0.05;
  } else if (timeframeHours <= 8) {
    w1h = 0.35; w4h = 0.4; w1d = 0.15; w1w = 0.1;
  } else if (timeframeHours <= 12) {
    w1h = 0.25; w4h = 0.35; w1d = 0.25; w1w = 0.15;
  } else if (timeframeHours <= 24) {
    w1h = 0.1; w4h = 0.2; w1d = 0.3; w1w = 0.4;
  } else if (timeframeHours <= 72) {
    w1h = 0.05; w4h = 0.15; w1d = 0.4; w1w = 0.4;
  } else {
    w1h = 0.02; w4h = 0.08; w1d = 0.3; w1w = 0.6;
  }

  const weightedChange = (change1h * w1h) + (change4h * w4h) + (change1d * w1d) + (change1w * w1w);

  // Tính pressure từ score, price change, và các chỉ số
  const takerTilt = finiteOr(m.takerBuySellRatio) > 1 ? 0.3 : finiteOr(m.takerBuySellRatio) < 1 ? -0.3 : 0;
  const fundingTilt = finiteOr(m.fundingRate) < 0 ? 0.25 : finiteOr(m.fundingRate) > 0 ? -0.25 : 0;
  const pressure = clamp((score / 5) + (weightedChange / 6) + takerTilt + fundingTilt, -3, 3);

  // Tính breakout levels cho timeframe hiện tại
  let breakoutLevels = null;

  // Chọn giá đóng nến ĐÃ ĐÓNG tương ứng với timeframe
  let basePrice = null;
  if (timeframeHours <= 4) {
    // 4h: dùng nến 4h trước đó đã đóng
    basePrice = finiteOr(m.closePrev4h, m.price);
  } else if (timeframeHours <= 12) {
    // 8h và 12h: dùng nến 4h trước đó đã đóng
    basePrice = finiteOr(m.closePrev4h, m.price);
  } else if (timeframeHours <= 72) {
    // 1d và 3d: dùng nến 1d trước đó đã đóng
    basePrice = finiteOr(m.closePrev1d, m.price);
  } else {
    // 1w: dùng nến 1w trước đó đã đóng
    basePrice = finiteOr(m.closePrev1w, m.price);
  }

  if (Number.isFinite(basePrice) && basePrice > 0) {
    const volBase = clamp(finiteOr(m.realizedVol24h, 2.4), 1.2, 6.5);

    // Map timeframe hours to multiplier (fixed thresholds)
    let mult, minPct, maxPct;
    if (timeframeHours <= 4) {
      mult = 0.45; minPct = 0.55; maxPct = 2.5;
    } else if (timeframeHours <= 8) {
      mult = 0.55; minPct = 0.65; maxPct = 3.0;
    } else if (timeframeHours <= 12) {
      mult = 0.7; minPct = 0.85; maxPct = 3.5;
    } else if (timeframeHours <= 24) {
      mult = 0.9; minPct = 1.1; maxPct = 4.2;
    } else if (timeframeHours <= 72) {
      mult = 1.4; minPct = 1.8; maxPct = 6.0;
    } else {
      mult = 1.7; minPct = 2.2; maxPct = 8.0;
    }

    const timeframeLabel = timeframeHours <= 4 ? '4h' :
                          timeframeHours <= 8 ? '8h' :
                          timeframeHours <= 12 ? '12h' :
                          timeframeHours <= 24 ? '1d' :
                          timeframeHours <= 72 ? '3d' : '1w';
    const monthlyBase = pickMonthlyThresholdBase(m, timeframeLabel);
    const thresholdPct = monthlyBase !== null
      ? clamp(monthlyBase, minPct, maxPct)
      : clamp(volBase * mult, minPct, maxPct);

    breakoutLevels = {
      timeframeLabel,
      bullishAbove: round(basePrice * (1 + thresholdPct / 100), 2),
      bearishBelow: round(basePrice * (1 - thresholdPct / 100), 2),
      thresholdPct: round(thresholdPct, 2),
      currentPrice: round(m.price, 2),
      basePrice: round(basePrice, 2)
    };
  }

  // Tính base probability cho 3 scenarios
  const baseBullish = 33.3;
  const baseBearish = 33.3;
  const baseSideway = 33.3;

  // Điều chỉnh dựa trên pressure
  const bullishRaw = Math.max(5, baseBullish + pressure * 15);
  const bearishRaw = Math.max(5, baseBearish - pressure * 15);
  const sidewayRaw = Math.max(10, baseSideway - Math.abs(pressure) * 8);

  const tfLabel = timeframeHours <= 4 ? '4h' :
                  timeframeHours <= 8 ? '8h' :
                  timeframeHours <= 12 ? '12h' :
                  timeframeHours <= 24 ? '1d' :
                  timeframeHours <= 72 ? '3d' : '1w';
  const historical = pickHistoricalScenario(m, tfLabel);
  const histWeight = historical
    ? historical.samples >= 220 ? 0.72 : historical.samples >= 120 ? 0.58 : 0.45
    : 0;
  const heuristicWeight = 1 - histWeight;

  const blendedBull = historical
    ? (historical.up * histWeight) + (bullishRaw * heuristicWeight)
    : bullishRaw;
  const blendedBear = historical
    ? (historical.down * histWeight) + (bearishRaw * heuristicWeight)
    : bearishRaw;
  const blendedSide = historical
    ? (historical.sideway * histWeight) + (sidewayRaw * heuristicWeight)
    : sidewayRaw;

  const scenarios = [
    {
      name: 'Tăng',
      bias: 'bullish',
      raw: blendedBull
    },
    {
      name: 'Giảm',
      bias: 'bearish',
      raw: blendedBear
    },
    {
      name: 'Sideway',
      bias: 'neutral',
      raw: blendedSide
    }
  ];

  return {
    scenarios: normalizeProbability(scenarios),
    breakoutLevels,
    scenarioMeta: historical
      ? {
          source: 'historical+heuristic',
          timeframe: tfLabel,
          sampleSize: historical.samples,
          mode: historical.mode || 'unconditional',
          historicalWeight: round(histWeight, 2),
          formulaScore: Number.isFinite(historical.formulaScore) ? round(historical.formulaScore, 4) : null,
          drivers: historical.drivers || null
        }
      : {
          source: 'heuristic',
          timeframe: tfLabel
        }
  };
}

function timeframeLabelFromHours(timeframeHours) {
  if (timeframeHours <= 4) return '4h';
  if (timeframeHours <= 8) return '8h';
  if (timeframeHours <= 12) return '12h';
  if (timeframeHours <= 24) return '1d';
  if (timeframeHours <= 72) return '3d';
  return '1w';
}

function timeframeComponentWeights(timeframeHours) {
  if (timeframeHours <= 8) {
    return { structure: 0.35, derivatives: 0.4, regime: 0.15, macroTime: 0.1 };
  }
  if (timeframeHours <= 24) {
    return { structure: 0.4, derivatives: 0.3, regime: 0.2, macroTime: 0.1 };
  }
  return { structure: 0.45, derivatives: 0.2, regime: 0.25, macroTime: 0.1 };
}

function mapTrendByTimeframe(m, timeframeHours) {
  const tfLabel = timeframeLabelFromHours(timeframeHours);

  const primaryChange = tfLabel === '4h' || tfLabel === '8h' || tfLabel === '12h'
    ? finiteOr(m.closeChange4h, 0)
    : tfLabel === '1d' || tfLabel === '3d'
    ? finiteOr(m.closeChange1d, 0)
    : finiteOr(m.closeChange1w, 0);
  const higherTfChange = timeframeHours <= 12
    ? finiteOr(m.closeChange1d, 0)
    : finiteOr(m.closeChange1w, 0);
  const structure = clamp((primaryChange / 1.6) + (higherTfChange / 3.8), -3, 3);

  let derivatives = 0;
  if (Number.isFinite(m.fundingRate)) derivatives += m.fundingRate < 0 ? 0.7 : m.fundingRate > 0 ? -0.7 : 0;
  if (Number.isFinite(m.takerBuySellRatio)) derivatives += m.takerBuySellRatio > 1.03 ? 0.7 : m.takerBuySellRatio < 0.97 ? -0.7 : 0;
  if (Number.isFinite(m.openInterestChange6h)) derivatives += m.openInterestChange6h > 7 ? -0.35 : m.openInterestChange6h < -4 ? 0.25 : 0;
  if (Number.isFinite(m.longShortRatio)) derivatives += m.longShortRatio < 0.9 ? 0.35 : m.longShortRatio > 1.5 ? -0.35 : 0;
  derivatives = clamp(derivatives, -3, 3);

  let regime = 0;
  if (Number.isFinite(m.btcMarketCapDominance)) {
    if (m.symbol === 'BTCUSDT') {
      regime += m.btcMarketCapDominance > 56 ? 0.5 : m.btcMarketCapDominance < 52 ? -0.3 : 0;
    } else {
      regime += m.btcMarketCapDominance > 56 ? -0.5 : m.btcMarketCapDominance < 52 ? 0.4 : 0;
    }
  }
  if (Number.isFinite(m.priceChange24h)) regime += clamp(m.priceChange24h / 10, -1.2, 1.2);
  regime = clamp(regime, -3, 3);

  let macroTime = 0;
  if (Number.isFinite(m.fearGreed)) macroTime += m.fearGreed < 30 ? 0.45 : m.fearGreed > 70 ? -0.45 : 0;
  if (Number.isFinite(m.realizedVol24h)) macroTime += m.realizedVol24h > 5 ? -0.35 : 0;
  macroTime = clamp(macroTime, -3, 3);

  const w = timeframeComponentWeights(timeframeHours);
  const mappedScore = clamp(
    (structure * w.structure)
      + (derivatives * w.derivatives)
      + (regime * w.regime)
      + (macroTime * w.macroTime),
    -3,
    3
  );

  return {
    timeframe: tfLabel,
    components: {
      structure: round(structure, 2),
      derivatives: round(derivatives, 2),
      regime: round(regime, 2),
      macroTime: round(macroTime, 2)
    },
    weights: w,
    score: round(mappedScore, 2)
  };
}

function buildPlaybookBasis(mappedTrend, scenarioMeta, breakoutLevels, rules = []) {
  const factorItems = [];
  for (const key of ['structure', 'derivatives', 'regime', 'macroTime']) {
    const value = Number(mappedTrend?.components?.[key]);
    const weight = Number(mappedTrend?.weights?.[key]);
    if (!Number.isFinite(value) || !Number.isFinite(weight)) continue;
    factorItems.push({
      key,
      component: round(value, 2),
      weight: round(weight, 2),
      contribution: round(value * weight, 3)
    });
  }
  factorItems.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const activeRules = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.pass)
    .sort((a, b) => Math.abs(finiteOr(b.score, 0)) - Math.abs(finiteOr(a.score, 0)))
    .slice(0, 5)
    .map((r) => ({
      name: r.name,
      score: finiteOr(r.score, 0),
      reason: r.reason || ''
    }));

  return {
    factors: factorItems,
    scenario: scenarioMeta || null,
    confirmation: breakoutLevels
      ? {
          timeframe: breakoutLevels.timeframeLabel,
          bullishAbove: breakoutLevels.bullishAbove,
          bearishBelow: breakoutLevels.bearishBelow,
          thresholdPct: breakoutLevels.thresholdPct
        }
      : null,
    activeRules
  };
}

function computeConfirmSignal(breakoutLevels) {
  if (!breakoutLevels) return 0;
  const p = Number(breakoutLevels.currentPrice);
  const up = Number(breakoutLevels.bullishAbove);
  const down = Number(breakoutLevels.bearishBelow);
  if (!Number.isFinite(p) || !Number.isFinite(up) || !Number.isFinite(down) || up <= down) return 0;
  if (p >= up) return 1;
  if (p <= down) return -1;
  const mid = (up + down) / 2;
  const half = (up - down) / 2;
  return clamp(((p - mid) / half) * 0.35, -0.35, 0.35);
}

function computeQualityAdj(m, tfLabel, scenarioMeta) {
  const brier = metricOrNaN(validatedHistoricalRow(m, tfLabel)?.backtest?.brierScore);
  const histWeight = Number(scenarioMeta?.historicalWeight);
  const brierAdj = Number.isFinite(brier) ? clamp(1 - (brier * 2), 0.6, 1.1) : 0.85;
  const histAdj = Number.isFinite(histWeight) ? clamp(histWeight, 0.4, 0.9) : 0.75;
  return brierAdj * histAdj;
}

function tunedDecisionThresholds(m, tfLabel) {
  const bt = validatedHistoricalRow(m, tfLabel)?.backtest;
  const dirAcc = metricOrNaN(bt?.directionalAccuracyPct);
  const brier = metricOrNaN(bt?.brierScore);
  const symbol = String(m?.symbol || '');

  let weak = 0.25;
  let strong = 0.55;

  // Tune by model quality from backtest
  if (Number.isFinite(dirAcc)) {
    if (dirAcc >= 58) {
      weak -= 0.03;
      strong -= 0.04;
    } else if (dirAcc < 52) {
      weak += 0.03;
      strong += 0.05;
    }
  }
  if (Number.isFinite(brier)) {
    if (brier <= 0.17) {
      weak -= 0.02;
      strong -= 0.03;
    } else if (brier > 0.22) {
      weak += 0.03;
      strong += 0.05;
    }
  }

  // Symbol-specific slight tuning
  if (symbol === 'BTCUSDT') {
    weak -= 0.01;
  } else if (symbol === 'SOLUSDT') {
    weak += 0.01;
    strong += 0.02;
  }

  weak = clamp(weak, 0.18, 0.35);
  strong = clamp(strong, weak + 0.2, 0.72);
  return { weak: round(weak, 3), strong: round(strong, 3) };
}

function deriveDecision(finalScore, scenarios, breakoutLevels, scenarioMeta, m, timeframeHours) {
  const probs = toProbabilityMap(scenarios);
  const tfLabel = timeframeHours <= 4 ? '4h' :
                  timeframeHours <= 8 ? '8h' :
                  timeframeHours <= 12 ? '12h' :
                  timeframeHours <= 24 ? '1d' :
                  timeframeHours <= 72 ? '3d' : '1w';
  const scoreNorm = clamp(finiteOr(finalScore, 0) / 4, -1, 1);
  const probEdge = clamp((probs.up - probs.down) / 100, -1, 1);
  const confirmSignal = computeConfirmSignal(breakoutLevels);
  const qualityAdj = computeQualityAdj(m, tfLabel, scenarioMeta);
  const thresholds = tunedDecisionThresholds(m, tfLabel);

  const raw = (scoreNorm * 0.45) + (probEdge * 0.35) + (confirmSignal * 0.2);
  const decisionScore = clamp(raw * qualityAdj, -1, 1);

  let state = 'neutral_wait';
  if (decisionScore >= thresholds.strong && confirmSignal > 0.2) state = 'bullish_strong';
  else if (decisionScore >= thresholds.weak) state = 'bullish_light';
  else if (decisionScore <= -thresholds.strong && confirmSignal < -0.2) state = 'bearish_strong';
  else if (decisionScore <= -thresholds.weak) state = 'bearish_light';

  return {
    timeframe: tfLabel,
    score: round(decisionScore, 3),
    state,
    probEdge: round(probEdge, 3),
    scoreNorm: round(scoreNorm, 3),
    confirmSignal: round(confirmSignal, 3),
    qualityAdj: round(qualityAdj, 3),
    thresholds
  };
}

export function inferTrend(m, timeframeHours = 4) {
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

  const mappedTrend = mapTrendByTimeframe(m, timeframeHours);
  const finalScore = clamp((score * 0.55) + (mappedTrend.score * 1.8), -6, 6);
  const closeGuides = computeCloseGuides(m);
  const { scenarios, breakoutLevels, scenarioMeta } = computeScenarioProbabilities(m, finalScore, timeframeHours);
  const decision = deriveDecision(finalScore, scenarios, breakoutLevels, scenarioMeta, m, timeframeHours);
  const weakTh = Number.isFinite(Number(decision?.thresholds?.weak))
    ? Number(decision.thresholds.weak)
    : 0.25;
  const outlook = decision.score <= -weakTh ? 'Bearish Bias' : decision.score >= weakTh ? 'Bullish Bias' : 'Sideways / High-Noise';
  const playbookBasis = {
    ...buildPlaybookBasis(mappedTrend, scenarioMeta, breakoutLevels, rules),
    decision
  };

  const playbook = decision.state === 'bullish_strong'
    ? 'Xu hướng tăng đã đồng thuận và có xác nhận, có thể ưu tiên long theo nhịp hồi ngắn.'
    : decision.state === 'bullish_light'
    ? 'Nghiêng tăng nhưng xác nhận chưa đủ mạnh, chỉ nên vào vị thế nhỏ và chờ nến xác nhận.'
    : decision.state === 'bearish_strong'
    ? 'Xu hướng giảm đã đồng thuận và có xác nhận, có thể ưu tiên short theo nhịp hồi.'
    : decision.state === 'bearish_light'
    ? 'Nghiêng giảm nhưng xác nhận chưa mạnh, ưu tiên vị thế nhỏ và kiểm soát rủi ro.'
    : 'Xu hướng chưa đủ đồng thuận; ưu tiên đứng ngoài hoặc giữ vị thế nhỏ, chỉ vào lệnh khi có nến đóng xác nhận.';

  return {
    score: round(finalScore, 2),
    baseRuleScore: score,
    mappedTrend,
    decision,
    outlook,
    confidence: Math.min(92, 42 + Math.abs(decision.score) * 58),
    reasons,
    risks,
    alerts,
    rules, // Thêm chi tiết từng rule để frontend hiển thị
    closeGuides,
    scenarioProbabilities: scenarios,
    breakoutLevels,
    scenarioMeta,
    playbookBasis,
    playbook
  };
}
