/**
 * Dựng object `metrics` của snapshot từ dữ liệu thô các nguồn (cùng shape với response API).
 * Chuyển nguyên văn từ server.js để server và audit lịch sử (scripts/run-audit.js) dùng chung
 * đúng một đường tính, chỉ thêm tham số nowMs thay cho Date.now().
 */
import { computeAbsMovePct, num, pctChange, std, summarizeMoves, toClosedKlines } from './stats.js';

export function computeTimeframeVolatility30d(kline4h, kline1d, nowMs = Date.now()) {
  const closed4h = toClosedKlines(kline4h, nowMs);
  const closed1d = toClosedKlines(kline1d, nowMs);
  const close4h = closed4h.map((k) => num(k[4])).filter((x) => x !== null);
  const close1d = closed1d.map((k) => num(k[4])).filter((x) => x !== null);

  const build = (closes, lag) => summarizeMoves(computeAbsMovePct(closes, lag));

  return {
    lookbackDays: 30,
    byTimeframe: {
      '4h': build(close4h, 1),
      '8h': build(close4h, 2),
      '12h': build(close4h, 3),
      '1d': build(close1d, 1),
      '3d': build(close1d, 3),
      '1w': build(close1d, 7)
    }
  };
}

export function computeKlineStats(klines) {
  if (!Array.isArray(klines) || klines.length < 8) {
    return {
      momentum6h: null,
      realizedVol24h: null,
      rangePct24h: null
    };
  }

  const closes = klines.map((k) => num(k[4])).filter((x) => x !== null);
  const highs = klines.map((k) => num(k[2])).filter((x) => x !== null);
  const lows = klines.map((k) => num(k[3])).filter((x) => x !== null);

  const closeNow = closes[closes.length - 1];
  const close6h = closes[closes.length - 7];
  const momentum6h = pctChange(close6h, closeNow);

  const logRets = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      logRets.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  const vol = std(logRets);
  const realizedVol24h = vol === null ? null : vol * Math.sqrt(24) * 100;

  const high24h = Math.max(...highs.slice(-24));
  const low24h = Math.min(...lows.slice(-24));
  const rangePct24h = closeNow ? ((high24h - low24h) / closeNow) * 100 : null;

  return { momentum6h, realizedVol24h, rangePct24h };
}

export function computeCloseContext(klines) {
  if (!Array.isArray(klines) || klines.length < 2) {
    return { closeNow: null, closePrev: null, closeChangePct: null };
  }
  const closeNow = num(klines[klines.length - 1]?.[4]);
  const closePrev = num(klines[klines.length - 2]?.[4]);
  return {
    closeNow,
    closePrev,
    closeChangePct: pctChange(closePrev, closeNow)
  };
}

/**
 * raw: giá trị đã parse của từng nguồn (null nếu lỗi), cùng shape với response API.
 * kline1h đã được cắt theo statsLimit1h trước khi truyền vào.
 */
export function buildMetrics({
  symbol,
  asOf,
  nowMs = Date.now(),
  premium,
  oiNow,
  oiHist,
  lsHist,
  topTraderLs,
  takerFlow,
  ticker24h,
  kline1h,
  kline4h,
  kline1d,
  kline1w,
  fearGreed,
  deribit,
  coingeckoGlobal
}) {
  const deribitCurrency = symbol.replace('USDT', '');
  const oiCurrent = num(oiNow?.openInterest);
  const oiOld = Array.isArray(oiHist) && oiHist.length >= 7 ? num(oiHist[0]?.sumOpenInterest) : null;
  const oiChange6h = pctChange(oiOld, oiCurrent);

  const lsLatest = Array.isArray(lsHist) && lsHist.length ? num(lsHist[lsHist.length - 1].longShortRatio) : null;
  const topTraderLatest = Array.isArray(topTraderLs) && topTraderLs.length
    ? num(topTraderLs[topTraderLs.length - 1].longShortRatio)
    : null;
  const takerLatest = Array.isArray(takerFlow) && takerFlow.length
    ? num(takerFlow[takerFlow.length - 1].buySellRatio)
    : null;

  const deribitInstrument = `${deribitCurrency}-PERPETUAL`;
  const dSummary = Array.isArray(deribit?.result)
    ? deribit.result.find((x) => x.instrument_name === deribitInstrument)
    : null;

  const kStats = computeKlineStats(kline1h);
  const close1h = computeCloseContext(kline1h);
  const close4h = computeCloseContext(kline4h);
  const close1d = computeCloseContext(kline1d);
  const close1w = computeCloseContext(kline1w);

  const tfVol30d = computeTimeframeVolatility30d(kline4h, kline1d, nowMs);
  const tfThresholdMap = {
    '4h': tfVol30d.byTimeframe['4h'].p75MovePct,
    '8h': tfVol30d.byTimeframe['8h'].p75MovePct,
    '12h': tfVol30d.byTimeframe['12h'].p75MovePct,
    '1d': tfVol30d.byTimeframe['1d'].p75MovePct,
    '3d': tfVol30d.byTimeframe['3d'].p75MovePct,
    '1w': tfVol30d.byTimeframe['1w'].p75MovePct
  };

  return {
    asOf,
    symbol,
    price: num(ticker24h?.lastPrice),
    priceChange24h: num(ticker24h?.priceChangePercent),
    momentum6h: kStats.momentum6h,
    fundingRate: num(premium?.lastFundingRate),
    nextFundingTime: premium?.nextFundingTime ? new Date(premium.nextFundingTime).toISOString() : null,
    markPrice: num(premium?.markPrice),
    openInterest: oiCurrent,
    openInterestChange6h: oiChange6h,
    longShortRatio: lsLatest,
    topTraderLongShortRatio: topTraderLatest,
    takerBuySellRatio: takerLatest,
    fearGreed: num(fearGreed?.data?.[0]?.value),
    realizedVol24h: kStats.realizedVol24h,
    rangePct24h: kStats.rangePct24h,
    closeNow1h: close1h.closeNow,
    closePrev1h: close1h.closePrev,
    closeChange1h: close1h.closeChangePct,
    closeNow4h: close4h.closeNow,
    closePrev4h: close4h.closePrev,
    closeChange4h: close4h.closeChangePct,
    closeNow1d: close1d.closeNow,
    closePrev1d: close1d.closePrev,
    closeChange1d: close1d.closeChangePct,
    closeNow1w: close1w.closeNow,
    closePrev1w: close1w.closePrev,
    closeChange1w: close1w.closeChangePct,
    timeframeThresholdBase30d: tfThresholdMap,
    timeframeVolatility30d: tfVol30d,
    deribitIv: num(dSummary?.mark_iv),
    deribitOpenInterestUsd: num(dSummary?.open_interest),
    btcMarketCapDominance: num(coingeckoGlobal?.data?.market_cap_percentage?.btc),
    totalMcapUsd: num(coingeckoGlobal?.data?.total_market_cap?.usd),
    totalVolumeUsd: num(coingeckoGlobal?.data?.total_volume?.usd),
    // Mô hình lịch sử đã cách ly khỏi snapshot (lib/historical.js); giữ key để tương thích.
    historicalScenarioModel: null
  };
}
