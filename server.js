import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferTrend } from './lib/scoring.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 7000);
const REFRESH_MS = Number(process.env.REFRESH_MS || 5000);
const USDC_REFRESH_MS = Number(process.env.USDC_REFRESH_MS || 60000);
const ETH_RPC_URL = process.env.ETH_RPC_URL || '';
const ETH_RPC_FALLBACKS = (process.env.ETH_RPC_FALLBACKS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

let latestSnapshot = null;
let latestError = null;
let refreshing = false;
const sseClients = new Set();
const usdcEventsCache = {
  events: [],
  source: 'none',
  lastAttemptAt: 0,
  updatedAt: 0
};

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'futures-signal-dashboard/0.2' }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'futures-signal-dashboard/0.2' }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRpcJson(rpcUrl, method, params = [], timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'futures-signal-dashboard/0.2'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      })
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const payload = await res.json();
    if (payload.error) throw new Error(payload.error.message || 'RPC error');
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

function topicAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^0x/, '');
  return `0x${normalized.padStart(64, '0')}`;
}

function parseHexToInt(hex) {
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

async function fetchUSDCMintingEventsFromRpc(rpcUrl) {
  const USDC_TREASURY = '0x55fe002aeff02f77364de339a1292923a15844b8';
  const USDC_CONTRACT = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - (72 * 60 * 60);

  const latestHex = await fetchRpcJson(rpcUrl, 'eth_blockNumber');
  const latestBlock = parseHexToInt(latestHex);
  if (latestBlock === null) return [];

  // Ethereum ~12s/block, cộng thêm buffer để không bỏ sót biên 72h
  const lookbackBlocks = Math.ceil((72 * 60 * 60) / 12) + 1500;
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);
  const fromBlockHex = `0x${fromBlock.toString(16)}`;
  const toBlockHex = `0x${latestBlock.toString(16)}`;

  const zeroTopic = topicAddress(ZERO_ADDRESS);
  const treasuryTopic = topicAddress(USDC_TREASURY);

  const [mintLogs, burnLogs] = await Promise.all([
    fetchRpcJson(rpcUrl, 'eth_getLogs', [{
      fromBlock: fromBlockHex,
      toBlock: toBlockHex,
      address: USDC_CONTRACT,
      topics: [TRANSFER_TOPIC, zeroTopic, treasuryTopic]
    }]),
    fetchRpcJson(rpcUrl, 'eth_getLogs', [{
      fromBlock: fromBlockHex,
      toBlock: toBlockHex,
      address: USDC_CONTRACT,
      topics: [TRANSFER_TOPIC, treasuryTopic, zeroTopic]
    }])
  ]);

  const allLogs = [
    ...(Array.isArray(mintLogs) ? mintLogs : []),
    ...(Array.isArray(burnLogs) ? burnLogs : [])
  ];
  if (!allLogs.length) return [];

  const uniqueBlockHex = [...new Set(allLogs.map((log) => String(log.blockNumber || '').toLowerCase()))];
  const blockTimeEntries = await Promise.all(uniqueBlockHex.map(async (blockHex) => {
    try {
      const block = await fetchRpcJson(rpcUrl, 'eth_getBlockByNumber', [blockHex, false], 12000);
      const ts = parseHexToInt(block?.timestamp);
      return [blockHex, ts];
    } catch {
      return [blockHex, null];
    }
  }));
  const blockTimeMap = new Map(blockTimeEntries);

  const events = [];
  for (const log of allLogs) {
    const blockHex = String(log.blockNumber || '').toLowerCase();
    const blockTs = blockTimeMap.get(blockHex);
    if (!blockTs || blockTs < cutoffTime) continue;

    const from = `0x${String(log.topics?.[1] || '').slice(-40)}`.toLowerCase();
    const to = `0x${String(log.topics?.[2] || '').slice(-40)}`.toLowerCase();
    let type = null;
    if (from === ZERO_ADDRESS && to === USDC_TREASURY) type = 'MINT';
    if (from === USDC_TREASURY && to === ZERO_ADDRESS) type = 'BURN';
    if (!type) continue;

    let amountUsdc = null;
    try {
      const amountRaw = BigInt(String(log.data || '0x0'));
      const normalized = Number(amountRaw) / 1e6;
      amountUsdc = Number.isFinite(normalized) ? normalized : null;
    } catch {
      amountUsdc = null;
    }

    events.push({
      type,
      amountUsdc,
      amountUsd: amountUsdc,
      from,
      to,
      timestamp: new Date(blockTs * 1000).toISOString(),
      txHash: log.transactionHash || '',
      blockNumber: parseHexToInt(log.blockNumber)
    });
  }

  return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function fetchUSDCMintingEventsFromEtherscan() {
  try {
    // USDC Treasury wallet trên Ethereum (theo Whale Alert)
    const USDC_TREASURY = '0x55fe002aeff02f77364de339a1292923a15844b8';
    const USDC_CONTRACT = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

    // Lấy ERC20 transfer events của USDC Treasury rồi suy ra mint/burn:
    // - Mint: from = zero address, to = treasury
    // - Burn: from = treasury, to = zero address
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - (72 * 60 * 60);
    const treasuryLc = USDC_TREASURY.toLowerCase();
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&address=${USDC_TREASURY}&contractaddress=${USDC_CONTRACT}&page=1&offset=100&sort=desc&apikey=${ETHERSCAN_API_KEY}`;

    const response = await fetchJson(url, 10000);

    if (response.status !== '1' || !Array.isArray(response.result)) {
      if (response.result) {
        console.error('USDC events API non-success:', response.result);
      }
      return [];
    }

    const events = [];

    for (const tx of response.result) {
      const timestamp = parseInt(tx.timeStamp, 10);
      if (timestamp < cutoffTime) break;

      const from = String(tx.from || '').toLowerCase();
      const to = String(tx.to || '').toLowerCase();

      let eventType = null;
      if (from === ZERO_ADDRESS && to === treasuryLc) eventType = 'MINT';
      if (from === treasuryLc && to === ZERO_ADDRESS) eventType = 'BURN';
      if (!eventType) continue;

      let amountUsdc = null;
      try {
        const raw = BigInt(tx.value || '0');
        const normalized = Number(raw) / 1e6;
        amountUsdc = Number.isFinite(normalized) ? normalized : null;
      } catch {
        amountUsdc = null;
      }

      events.push({
        type: eventType,
        amountUsdc,
        amountUsd: amountUsdc,
        from,
        to,
        timestamp: new Date(timestamp * 1000).toISOString(),
        txHash: tx.hash,
        blockNumber: parseInt(tx.blockNumber, 10)
      });
    }

    return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (err) {
    console.error('Error fetching USDC events from Etherscan:', err);
    return [];
  }
}

async function fetchUSDCMintingEventsFromWhaleAlert() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - (72 * 60 * 60);
    const url = `https://whale-alert.io/alerts.json?start=${start}&end=${now}`;

    const raw = await fetchText(url, 10000);
    let rows = [];
    try {
      rows = JSON.parse(raw);
    } catch {
      rows = [];
    }
    if (!Array.isArray(rows)) return [];

    const events = [];
    for (const row of rows) {
      const text = String(row?.text || '');
      const textLc = text.toLowerCase();
      const isMint = textLc.includes('minted at usdc treasury');
      const isBurn = textLc.includes('burned at usdc treasury') || textLc.includes('burnt at usdc treasury');
      if (!isMint && !isBurn) continue;

      const timestampSec = Number(row?.timestamp);
      if (!Number.isFinite(timestampSec) || timestampSec < start) continue;

      const usdcAmount = Array.isArray(row?.amounts)
        ? row.amounts.find((a) => String(a?.symbol || '').toUpperCase() === 'USDC')
        : null;

      events.push({
        type: isMint ? 'MINT' : 'BURN',
        amountUsdc: Number.isFinite(Number(usdcAmount?.amount)) ? Number(usdcAmount.amount) : null,
        amountUsd: Number.isFinite(Number(usdcAmount?.value_usd)) ? Number(usdcAmount.value_usd) : null,
        from: isMint ? '0x0000000000000000000000000000000000000000' : 'usdc_treasury',
        to: isMint ? 'usdc_treasury' : '0x0000000000000000000000000000000000000000',
        timestamp: new Date(timestampSec * 1000).toISOString(),
        txHash: row?.link ? `whale:${row.link}` : '',
        blockNumber: null
      });
    }

    return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (err) {
    console.error('Error fetching USDC events from Whale Alert:', err);
    return [];
  }
}

async function fetchUSDCMintingEventsUncached() {
  if (ETH_RPC_URL) {
    try {
      const rpcEvents = await fetchUSDCMintingEventsFromRpc(ETH_RPC_URL);
      return rpcEvents;
    } catch (err) {
      console.error(`Error fetching USDC events from RPC (${ETH_RPC_URL}):`, err);
    }
  }

  if (ETHERSCAN_API_KEY && ETHERSCAN_API_KEY !== 'YourApiKeyToken') {
    const eEvents = await fetchUSDCMintingEventsFromEtherscan();
    return eEvents;
  }

  const whaleEvents = await fetchUSDCMintingEventsFromWhaleAlert();
  if (whaleEvents.length || ETH_RPC_FALLBACKS.length === 0) return whaleEvents;

  for (const rpcUrl of ETH_RPC_FALLBACKS) {
    try {
      const rpcEvents = await fetchUSDCMintingEventsFromRpc(rpcUrl);
      return rpcEvents;
    } catch (err) {
      console.error(`Error fetching USDC events from fallback RPC (${rpcUrl}):`, err);
    }
  }

  return whaleEvents;
}

async function fetchUSDCMintingEvents() {
  const now = Date.now();
  if (usdcEventsCache.lastAttemptAt > 0 && now - usdcEventsCache.lastAttemptAt < USDC_REFRESH_MS) {
    return usdcEventsCache.events;
  }
  usdcEventsCache.lastAttemptAt = now;

  try {
    const events = await fetchUSDCMintingEventsUncached();
    usdcEventsCache.events = Array.isArray(events) ? events : [];
    usdcEventsCache.updatedAt = Date.now();
    return usdcEventsCache.events;
  } catch (err) {
    console.error('Error fetching USDC events (cached wrapper):', err);
    return usdcEventsCache.events;
  }
}

function pctChange(oldValue, newValue) {
  if (!oldValue || !newValue) return null;
  return ((newValue - oldValue) / oldValue) * 100;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function std(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeKlineStats(klines) {
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

function normalizeCandles(klines, limit = 24) {
  if (!Array.isArray(klines)) return [];
  return klines.slice(-limit).map((k) => ({
    time: new Date(k[0]).toISOString(),
    open: num(k[1]),
    high: num(k[2]),
    low: num(k[3]),
    close: num(k[4]),
    volume: num(k[5])
  }));
}

function computeCloseContext(klines) {
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

async function getSnapshot(symbol = 'BTCUSDT', candleLimit = 24) {
  const now = new Date().toISOString();

  // Validate symbol
  const validSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  if (!validSymbols.includes(symbol)) {
    throw new Error(`Invalid symbol. Allowed: ${validSymbols.join(', ')}`);
  }

  // Validate candleLimit
  const validLimits = [24, 48, 96];
  if (!validLimits.includes(candleLimit)) {
    candleLimit = 24;
  }

  // Tính limit cho fetch (cần thêm buffer để tính momentum)
  const fetchLimit1h = Math.max(candleLimit, 48);
  const fetchLimit4h = Math.max(candleLimit, 48);
  const fetchLimit1d = 8;
  const fetchLimit1w = 8;

  // Map symbol cho Deribit (BTC/ETH/SOL)
  const deribitCurrency = symbol.replace('USDT', '');

  const [
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
    coingeckoGlobal,
    usdcEvents
  ] = await Promise.allSettled([
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
    fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=7`),
    fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=5`),
    fetchJson(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=5`),
    fetchJson(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=5`),
    fetchJson(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${fetchLimit1h}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=${fetchLimit4h}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=${fetchLimit1d}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1w&limit=${fetchLimit1w}`),
    fetchJson('https://api.alternative.me/fng/?limit=1'),
    fetchJson(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${deribitCurrency}&kind=future`),
    fetchJson('https://api.coingecko.com/api/v3/global'),
    fetchUSDCMintingEvents()
  ]);

  const errors = [];

  const premiumV = premium.status === 'fulfilled' ? premium.value : null;
  if (!premiumV) errors.push('Binance premiumIndex lỗi');

  const oiNowV = oiNow.status === 'fulfilled' ? oiNow.value : null;
  if (!oiNowV) errors.push('Binance openInterest lỗi');

  const oiHistV = oiHist.status === 'fulfilled' ? oiHist.value : null;
  if (!oiHistV) errors.push('Binance openInterestHist lỗi');

  const lsHistV = lsHist.status === 'fulfilled' ? lsHist.value : null;
  if (!lsHistV) errors.push('Binance globalLongShort ratio lỗi');

  const topTraderLsV = topTraderLs.status === 'fulfilled' ? topTraderLs.value : null;
  if (!topTraderLsV) errors.push('Binance top trader ratio lỗi');

  const takerFlowV = takerFlow.status === 'fulfilled' ? takerFlow.value : null;
  if (!takerFlowV) errors.push('Binance taker flow lỗi');

  const ticker24hV = ticker24h.status === 'fulfilled' ? ticker24h.value : null;
  if (!ticker24hV) errors.push('Binance ticker24h lỗi');

  const kline1hV = kline1h.status === 'fulfilled' ? kline1h.value : null;
  if (!kline1hV) errors.push('Binance klines lỗi');
  const kline4hV = kline4h.status === 'fulfilled' ? kline4h.value : null;
  if (!kline4hV) errors.push('Binance klines 4h lỗi');
  const kline1dV = kline1d.status === 'fulfilled' ? kline1d.value : null;
  if (!kline1dV) errors.push('Binance klines 1d lỗi');
  const kline1wV = kline1w.status === 'fulfilled' ? kline1w.value : null;
  if (!kline1wV) errors.push('Binance klines 1w lỗi');

  const fearGreedV = fearGreed.status === 'fulfilled' ? fearGreed.value : null;
  if (!fearGreedV) errors.push('Fear&Greed API lỗi');

  const deribitV = deribit.status === 'fulfilled' ? deribit.value : null;
  if (!deribitV) errors.push('Deribit API lỗi');

  const cgV = coingeckoGlobal.status === 'fulfilled' ? coingeckoGlobal.value : null;
  if (!cgV) errors.push('CoinGecko global lỗi');

  const usdcEventsV = usdcEvents.status === 'fulfilled' ? usdcEvents.value : [];

  const oiCurrent = num(oiNowV?.openInterest);
  const oiOld = Array.isArray(oiHistV) && oiHistV.length >= 7 ? num(oiHistV[0]?.sumOpenInterest) : null;
  const oiChange6h = pctChange(oiOld, oiCurrent);

  const lsLatest = Array.isArray(lsHistV) && lsHistV.length ? num(lsHistV[lsHistV.length - 1].longShortRatio) : null;
  const topTraderLatest = Array.isArray(topTraderLsV) && topTraderLsV.length
    ? num(topTraderLsV[topTraderLsV.length - 1].longShortRatio)
    : null;
  const takerLatest = Array.isArray(takerFlowV) && takerFlowV.length
    ? num(takerFlowV[takerFlowV.length - 1].buySellRatio)
    : null;

  // Map Deribit instrument name
  const deribitInstrument = `${deribitCurrency}-PERPETUAL`;
  const dSummary = Array.isArray(deribitV?.result)
    ? deribitV.result.find((x) => x.instrument_name === deribitInstrument)
    : null;

  const kStats = computeKlineStats(kline1hV);
  const close1h = computeCloseContext(kline1hV);
  const close4h = computeCloseContext(kline4hV);
  const close1d = computeCloseContext(kline1dV);
  const close1w = computeCloseContext(kline1wV);

  const metrics = {
    asOf: now,
    symbol,
    price: num(ticker24hV?.lastPrice),
    priceChange24h: num(ticker24hV?.priceChangePercent),
    momentum6h: kStats.momentum6h,
    fundingRate: num(premiumV?.lastFundingRate),
    nextFundingTime: premiumV?.nextFundingTime ? new Date(premiumV.nextFundingTime).toISOString() : null,
    markPrice: num(premiumV?.markPrice),
    openInterest: oiCurrent,
    openInterestChange6h: oiChange6h,
    longShortRatio: lsLatest,
    topTraderLongShortRatio: topTraderLatest,
    takerBuySellRatio: takerLatest,
    fearGreed: num(fearGreedV?.data?.[0]?.value),
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
    deribitIv: num(dSummary?.mark_iv),
    deribitOpenInterestUsd: num(dSummary?.open_interest),
    btcMarketCapDominance: num(cgV?.data?.market_cap_percentage?.btc),
    totalMcapUsd: num(cgV?.data?.total_market_cap?.usd),
    totalVolumeUsd: num(cgV?.data?.total_volume?.usd)
  };

  return {
    generatedAt: now,
    metrics,
    trend: inferTrend(metrics),
    usdcMinting: usdcEventsV || [],
    history: {
      candles1h: normalizeCandles(kline1hV, candleLimit),
      candles4h: normalizeCandles(kline4hV, candleLimit),
      oi1h7: Array.isArray(oiHistV)
        ? oiHistV.map((x) => ({ time: new Date(x.timestamp).toISOString(), value: num(x.sumOpenInterest) }))
        : []
    },
    errors,
    dataPages: [
      { name: 'Whale Alert', url: 'https://whale-alert.io/alerts.html' },
      { name: 'CoinGlass Funding', url: 'https://www.coinglass.com/FundingRate' },
      { name: 'CoinGlass Liquidations', url: 'https://www.coinglass.com/liquidations' },
      { name: 'CryptoQuant', url: 'https://cryptoquant.com/' },
      { name: `Deribit ${deribitCurrency} Statistics`, url: `https://www.deribit.com/statistics/${deribitCurrency}` },
      { name: 'Fear & Greed Index', url: 'https://alternative.me/crypto/fear-and-greed-index/' },
      { name: 'USDC Treasury (Etherscan)', url: 'https://etherscan.io/address/0x55fe002aeff02f77364de339a1292923a15844b8' }
    ],
    disclaimer: 'Rule-based dashboard tham khảo cho futures. Không phải khuyến nghị đầu tư.'
  };
}

function sseSend(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function refreshAllClients() {
  if (refreshing) return;
  refreshing = true;
  try {
    // Group clients by their params
    const clientGroups = new Map();
    for (const client of sseClients) {
      const params = client._streamParams || { symbol: 'BTCUSDT', limit: 24 };
      const key = `${params.symbol}:${params.limit}`;
      if (!clientGroups.has(key)) {
        clientGroups.set(key, { params, clients: [] });
      }
      clientGroups.get(key).clients.push(client);
    }

    // Fetch và gửi cho từng nhóm
    for (const [key, group] of clientGroups) {
      try {
        const snapshot = await getSnapshot(group.params.symbol, group.params.limit);
        for (const client of group.clients) {
          sseSend(client, 'snapshot', snapshot);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        for (const client of group.clients) {
          sseSend(client, 'error', { error: errMsg, at: new Date().toISOString() });
        }
      }
    }
  } finally {
    refreshing = false;
  }
}

async function serveStatic(pathname, res) {
  const target = pathname === '/' ? '/index-new.html' : pathname;
  const filePath = join(__dirname, 'public', target);
  const ext = extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  const content = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(content);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/snapshot') {
    try {
      const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
      const limit = parseInt(url.searchParams.get('limit') || '24', 10);

      // Fetch on-demand với params từ client
      const snapshot = await getSnapshot(symbol, limit);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/stream') {
    const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
    const limit = parseInt(url.searchParams.get('limit') || '24', 10);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });

    res.write('retry: 2000\n\n');

    // Store client với params của nó
    res._streamParams = { symbol, limit };
    sseClients.add(res);

    // Gửi snapshot đầu tiên
    (async () => {
      try {
        const snapshot = await getSnapshot(symbol, limit);
        sseSend(res, 'snapshot', snapshot);
      } catch (err) {
        sseSend(res, 'error', { error: err.message, at: new Date().toISOString() });
      }
    })();

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, now: new Date().toISOString(), port: PORT }));
    return;
  }

  try {
    await serveStatic(url.pathname, res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  setInterval(refreshAllClients, REFRESH_MS);
});
