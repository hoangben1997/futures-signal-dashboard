import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateFamilies,
  buildKeyLevels,
  buildMarketReport,
  familyAvailability,
  pickConfirmLevel,
  roundStep,
  statisticalModelCheck,
  upcomingHighImpactEvents,
  UNIFORM_BRIER
} from '../lib/analysis.js';

function tf(overrides = {}) {
  return {
    price: 100,
    bars: 400,
    ma50: 110,
    ma100: 120,
    ma200: 130,
    position: {},
    stack: 'bearish',
    cross50x200: { current: 'death', recent: null },
    rsi: 40,
    rsiMa: 45,
    macd: -1,
    macdSignal: -0.5,
    macdHist: -0.5,
    macdHistPrev: -0.4,
    macdCross: null,
    lastClosedVolRatio: 1,
    lastClosedCandle: { open: 101, high: 102, low: 99, close: 100, changePct: -1, closePositionInRange: 0.33, shape: 'normal' },
    structure: { state: 'bearish', highs: 'LH', lows: 'LL', broken: null, lastHigh: 105, prevHigh: 108, lastLow: 95, prevLow: 97 },
    recentSwings: { highs: [{ price: 105, volume: 10 }], lows: [{ price: 95, volume: 10 }] },
    fib: null,
    ...overrides
  };
}

function bearishTechnicals() {
  return {
    byTf: {
      '1M': tf({ ma200: null }),
      '1w': tf(),
      '1d': tf(),
      '4h': tf(),
      '1h': tf()
    }
  };
}

test('aggregateFamilies: nhiều chỉ báo cùng nguồn giá bị chặn trần, không cộng dồn', () => {
  const evidence = Array.from({ length: 5 }, () => ({ family: 'price-long', direction: -1, weight: 1 }));
  evidence.push({ family: 'funding', direction: 0.5, weight: 1 });
  const fams = aggregateFamilies(evidence);
  const price = fams.find((f) => f.family === 'price-long');
  assert.equal(price.rawScore, -5);
  assert.equal(price.cappedScore, -1);
  assert.equal(price.contribution, -1);
  assert.equal(fams.find((f) => f.family === 'funding').contribution, 0.25);
});

test('roundStep: BTC ~60k → 5.000, ETH ~1.700 → 100', () => {
  assert.equal(roundStep(60000), 5000);
  assert.equal(roundStep(1700), 100);
});

test('buildKeyLevels: gom các mức sát nhau, nhiều nguồn thì mạnh hơn', () => {
  const tech = {
    '1d': tf({ ma50: 110, ma100: 140, ma200: 150, recentSwings: { highs: [{ price: 110.3 }], lows: [{ price: 90 }] } }),
    '4h': tf({ ma50: 110.5, ma100: 160, ma200: 170, recentSwings: { highs: [], lows: [] } })
  };
  const { supports, resistances } = buildKeyLevels(tech, 100);
  const r = resistances.find((l) => l.low <= 110 && l.high >= 110.5);
  assert.ok(r, 'phải có vùng kháng cự 110–110.5');
  assert.ok(r.reasons.includes('MA50 D') && r.reasons.includes('MA50 4H') && r.reasons.includes('đỉnh D'));
  assert.ok(r.strengthScore >= 3);
  assert.ok(supports.some((l) => l.reasons.includes('đáy D')));
});

test('pickConfirmLevel: bỏ vùng quá sát giá', () => {
  const levels = [
    { mid: 100.5, distancePct: 0.5, strengthScore: 3 },
    { mid: 103, distancePct: 3, strengthScore: 1 },
    { mid: 105, distancePct: 5, strengthScore: 2 }
  ];
  assert.equal(pickConfirmLevel(levels).mid, 105);
});

test('statisticalModelCheck: fail closed — thắng mức đoán đều không đủ, phải có validation.passed', () => {
  const model = (brier, validation) => ({
    byTimeframe: { '1d': { up: 30, down: 40, sideway: 30, samples: 300, backtest: { brierScore: brier, testSamples: 90 }, validation } }
  });
  // Brier 0,10 thắng đoán đều (0,2222) nhưng chưa qua kiểm định ngoài mẫu → không có skill
  const diag = statisticalModelCheck(model(0.1));
  assert.equal(diag.beatsUniform, true);
  assert.equal(diag.hasSkill, false);
  assert.match(diag.verdict, /chưa kiểm định/);
  assert.equal(statisticalModelCheck(model(0.25)).hasSkill, false);
  assert.equal(statisticalModelCheck(model(0.1, { passed: false })).hasSkill, false);
  assert.equal(statisticalModelCheck(model(0.1, { passed: true })).hasSkill, true);
  assert.ok(UNIFORM_BRIER > 0.222 && UNIFORM_BRIER < 0.2223);
  assert.equal(statisticalModelCheck(null), null);
});

test('buildMarketReport: chỉ gắn xác suất bằng số khi hàng lịch sử đã qua kiểm định', () => {
  const base = { symbol: 'BTCUSDT', metrics: { price: 100 }, technicals: bearishTechnicals() };
  const row = (extra) => ({ byTimeframe: { '1d': { up: 20, down: 50, sideway: 30, samples: 300, backtest: { brierScore: 0.09 }, ...extra } } });
  const report = (model) => buildMarketReport({ ...base, metrics: { ...base.metrics, historicalScenarioModel: model } });

  const unvalidated = report(row());
  assert.ok(unvalidated.scenarios.every((s) => s.statisticalProbabilityPct === undefined));
  assert.equal(unvalidated.statisticalModel.hasSkill, false);

  const validated = report(row({ validation: { passed: true } }));
  assert.equal(validated.scenarios.find((s) => s.key === 'bearish').statisticalProbabilityPct, 50);
});

test('buildMarketReport: không có dữ liệu kỹ thuật → "chưa đủ dữ liệu", không đoán hướng', () => {
  const r = buildMarketReport({ symbol: 'ETHUSDT', metrics: { price: 1700, fearGreed: 10 }, technicals: null });
  assert.equal(r.summary.bias, 'insufficient');
  assert.equal(r.summary.text, 'Chưa đủ dữ liệu để xác định xu hướng.');
  assert.ok(r.stakes.technicalGaps.length > 0);
  assert.equal(r.factorTable.find((f) => f.group === 'macro').status, 'no_data');
});

test('buildMarketReport: trend giảm đồng thuận → nghiêng giảm, vô hiệu khi đóng tuần trên MA200', () => {
  const r = buildMarketReport({
    symbol: 'BTCUSDT',
    metrics: { price: 100, takerBuySellRatio: 0.9, fundingRate: 0.0001, fearGreed: 50 },
    technicals: bearishTechnicals()
  });
  assert.equal(r.summary.bias, 'bearish');
  assert.equal(r.summary.regime, 'bear');
  assert.ok(r.globalInvalidation.some((t) => t.includes('MA200 tuần 130')));
  assert.ok(r.topFactors.every((f) => f.direction !== 'neutral'));
});

test('mispricing: funding âm rất nhỏ không bị coi là đám đông short', () => {
  const metrics = { price: 100, fearGreed: 10 };
  const tiny = buildMarketReport({ symbol: 'ETHUSDT', metrics: { ...metrics, fundingRate: -0.00001 }, technicals: bearishTechnicals() });
  assert.ok(!tiny.mispricing.some((t) => t.includes('short squeeze')));
  const deep = buildMarketReport({ symbol: 'ETHUSDT', metrics: { ...metrics, fundingRate: -0.0003 }, technicals: bearishTechnicals() });
  assert.ok(deep.mispricing.some((t) => t.includes('short squeeze')));
});

test('costModel: funding dương 0,01%/8h giữ 3 ngày → long tốn thêm 0,09%', () => {
  const r = buildMarketReport({ symbol: 'BTCUSDT', metrics: { price: 100, fundingRate: 0.0001 }, technicals: bearishTechnicals() });
  const c = r.stakes.costModel;
  assert.equal(c.fundingCostLongPct, 0.09);
  assert.equal(c.totalLongPct, 0.29);
  assert.equal(c.totalShortPct, 0.11);
});

test('upcomingHighImpactEvents: chỉ lấy sự kiện USD High trong 72h tới', () => {
  const now = Date.parse('2026-11-24T00:00:00Z');
  const events = [
    { title: 'CPI', currency: 'USD', impact: 'High', timestamp: '2026-11-25T13:30:00Z' },
    { title: 'Past', currency: 'USD', impact: 'High', timestamp: '2026-11-23T13:30:00Z' },
    { title: 'Far', currency: 'USD', impact: 'High', timestamp: '2026-11-28T13:30:00Z' },
    { title: 'EUR', currency: 'EUR', impact: 'High', timestamp: '2026-11-25T09:00:00Z' },
    { title: 'NoTs', currency: 'USD', impact: 'High', timestamp: null }
  ];
  const out = upcomingHighImpactEvents(events, now);
  assert.deepEqual(out.map((e) => e.title), ['CPI']);
  assert.equal(out[0].hoursAway, 37.5);
});

test('độ phủ: feed USDC chạy thành công nhưng rỗng là có dữ liệu, không phải thiếu', () => {
  const metrics = { price: 100, fundingRate: 0.0001, openInterestChange6h: 1, momentum6h: 0.1, longShortRatio: 1.2, takerBuySellRatio: 1, fearGreed: 50 };
  const tech = bearishTechnicals().byTf;
  const ok = familyAvailability({ tech, metrics, usdcEvents: [], sourceHealth: { onchain: { ok: true, stale: false } } });
  assert.equal(ok.onchain, 'available');
  const failed = familyAvailability({ tech, metrics, usdcEvents: [], sourceHealth: { onchain: { ok: false, stale: false } } });
  assert.equal(failed.onchain, 'missing');

  const r = buildMarketReport({ symbol: 'BTCUSDT', metrics, technicals: { byTf: tech }, usdcEvents: [], sourceHealth: { onchain: { ok: true, stale: false } } });
  assert.equal(r.summary.dataAvailablePct, 100);
  assert.equal(r.summary.freshDataPct, 100);
  // Nguồn trung tính (funding 0,01%, F&G 50, USDC rỗng...) không làm giảm độ phủ dữ liệu
  assert.ok(r.summary.activeEvidencePct < r.summary.dataAvailablePct);
});

test('độ phủ: nguồn báo stale không tính vào dữ liệu mới, và được nêu tên', () => {
  const metrics = { price: 100, fearGreed: 50, fundingRate: 0.0001 };
  const r = buildMarketReport({
    symbol: 'BTCUSDT',
    metrics,
    technicals: bearishTechnicals(),
    sourceHealth: { sentiment: { ok: true, stale: true } }
  });
  assert.equal(r.availability.sentiment, 'stale');
  assert.equal(r.availability.funding, 'available');
  assert.ok(r.summary.freshDataPct < r.summary.dataAvailablePct);
  assert.ok(r.selfCritique.quant.some((t) => t.includes('dữ liệu cũ') && t.includes('Fear & Greed')));
});

test('độ phủ: phần lớn nguồn thiếu → chưa đủ dữ liệu dù có kỹ thuật', () => {
  const r = buildMarketReport({ symbol: 'BTCUSDT', metrics: { price: 100 }, technicals: bearishTechnicals() });
  // Chỉ có price-long, price-short, volume → 3/9 < 50%
  assert.equal(r.summary.freshDataPct, 33);
  assert.equal(r.summary.bias, 'insufficient');
});

test('audit 2026-11-25: Fear & Greed và volume chỉ còn thông tin, không có hướng', () => {
  const tech = bearishTechnicals().byTf;
  tech['1d'] = { ...tech['1d'], lastClosedVolRatio: 2.5, lastClosedCandle: { ...tech['1d'].lastClosedCandle, changePct: -4, shape: 'strong_bear' } };
  for (const fearGreed of [5, 50, 95]) {
    const r = buildMarketReport({ symbol: 'BTCUSDT', metrics: { price: 100, fearGreed }, technicals: { byTf: tech } });
    const sentiment = r.factorTable.find((f) => f.group === 'sentiment');
    const volume = r.factorTable.find((f) => f.group === 'volume');
    assert.ok(sentiment.evidence.length === 1 && sentiment.evidence[0].direction === 0);
    assert.ok(volume.evidence.every((e) => e.direction === 0));
    assert.equal(r.families.find((f) => f.family === 'sentiment').direction, 'neutral');
    assert.equal(r.families.find((f) => f.family === 'volume').direction, 'neutral');
  }
});
