import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferTrend } from './lib/scoring.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 7000);
const REFRESH_MS = Number(process.env.REFRESH_MS || 5000);
const USDC_REFRESH_MS = Number(process.env.USDC_REFRESH_MS || 60000);
const HIST_MODEL_REFRESH_MS = Number(process.env.HIST_MODEL_REFRESH_MS || 6 * 60 * 60 * 1000);
const ETH_RPC_URL = process.env.ETH_RPC_URL || '';
const ETH_RPC_FALLBACKS = (process.env.ETH_RPC_FALLBACKS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
const TRADING_ECONOMICS_API_KEY = process.env.TRADING_ECONOMICS_API_KEY || process.env.TE_API_KEY || 'guest:guest';

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
const historicalScenarioCache = new Map();

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

function decodeHtmlEntities(input = '') {
  return String(input)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(input = '') {
  return decodeHtmlEntities(String(input).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractCellHtml(row = '', cellClass = '') {
  const re = new RegExp(`<td[^>]*class="[^"]*${cellClass}[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
  const m = row.match(re);
  return m?.[1] || '';
}

function extractImpact(row = '') {
  if (/impact--high|ff-impact-red/i.test(row)) return 'High';
  if (/impact--medium|ff-impact-ora|ff-impact-org/i.test(row)) return 'Medium';
  if (/impact--low|ff-impact-yel/i.test(row)) return 'Low';
  return 'Unknown';
}

function mapImpactFromXml(raw = '') {
  const s = String(raw).trim().toLowerCase();
  if (s === 'high') return 'High';
  if (s === 'medium') return 'Medium';
  if (s === 'low') return 'Low';
  return 'Unknown';
}

function parseForexFactoryWeekXml(xml = '') {
  const items = [];
  const eventBlocks = xml.match(/<event>[\s\S]*?<\/event>/g) || [];
  for (const block of eventBlocks) {
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return stripHtml(m?.[1] || '');
    };
    const impact = mapImpactFromXml(getTag('impact'));
    if (impact !== 'High') continue;

    const date = getTag('date');
    const time = getTag('time') || 'All Day';
    const currency = getTag('currency');
    const title = getTag('title');
    if (!date || !currency || !title) continue;

    items.push({
      date,
      time,
      currency,
      title,
      impact,
      actual: getTag('actual') || '-',
      forecast: getTag('forecast') || '-',
      previous: getTag('previous') || '-',
      timestamp: null
    });
  }
  return items;
}

function getWeekRangeUtc(now = new Date()) {
  const utc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0
  ));
  const day = (utc.getUTCDay() + 6) % 7; // Monday=0
  const start = new Date(utc);
  start.setUTCDate(start.getUTCDate() - day);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

function mapImpactFromImportance(v) {
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n >= 3) return 'High';
    if (n === 2) return 'Medium';
    if (n === 1) return 'Low';
  }
  return 'Unknown';
}

async function fetchTradingEconomicsCalendarWeek() {
  const key = encodeURIComponent(TRADING_ECONOMICS_API_KEY);
  const url = `https://api.tradingeconomics.com/calendar?c=${key}&f=json`;
  const rows = await fetchJson(url, 12000);
  if (!Array.isArray(rows)) return [];

  const { start, end } = getWeekRangeUtc(new Date());
  const out = [];

  for (const row of rows) {
    const iso = row?.Date ? new Date(row.Date).toISOString() : null;
    if (!iso) continue;
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    if (ts < start.getTime() || ts >= end.getTime()) continue;

    const impact = mapImpactFromImportance(row?.Importance);
    if (impact !== 'High') continue;

    const currency = stripHtml(row?.Currency || '');
    const title = stripHtml(row?.Event || row?.Category || '');
    if (!currency || !title) continue;

    out.push({
      date: iso.slice(0, 10),
      time: `${iso.slice(11, 16)} UTC`,
      currency,
      title,
      impact,
      actual: row?.Actual ?? '-',
      forecast: row?.Forecast ?? row?.TEForecast ?? '-',
      previous: row?.Previous ?? '-',
      timestamp: iso
    });
  }

  out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return out.slice(0, 80);
}

function parseForexFactoryWeekJsonRows(rows) {
  if (!Array.isArray(rows)) return [];
  const { start, end } = getWeekRangeUtc(new Date());
  const events = [];

  for (const row of rows) {
    const iso = row?.date ? new Date(row.date).toISOString() : null;
    if (!iso) continue;
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    if (ts < start.getTime() || ts >= end.getTime()) continue;

    const impactRaw = stripHtml(row?.impact || '');
    const impact = /high/i.test(impactRaw) ? 'High' : /medium/i.test(impactRaw) ? 'Medium' : /low/i.test(impactRaw) ? 'Low' : impactRaw || 'Unknown';
    if (impact !== 'High') continue;

    const title = stripHtml(row?.title || row?.event || '');
    const currency = stripHtml(row?.country || row?.currency || '');
    if (!title || !currency) continue;

    events.push({
      date: iso.slice(0, 10),
      time: `${iso.slice(11, 16)} UTC`,
      currency,
      title,
      impact,
      actual: row?.actual ?? '-',
      forecast: row?.forecast ?? '-',
      previous: row?.previous ?? '-',
      timestamp: iso
    });
  }

  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return events.slice(0, 80);
}

async function fetchForexFactoryWeekJson() {
  const endpoint = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  ];

  let lastErr = null;
  for (let i = 0; i < userAgents.length; i += 1) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          'User-Agent': userAgents[i],
          'Accept': 'application/json,text/plain,*/*',
          'Referer': 'https://www.forexfactory.com/calendar',
          'Cache-Control': 'no-cache'
        }
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = await res.text();
      const rows = JSON.parse(text);
      const parsed = parseForexFactoryWeekJsonRows(rows);
      if (parsed.length) return parsed;
      throw new Error('ForexFactory JSON parsed but no high-impact events');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('ForexFactory JSON fetch failed');
}

// Economic Calendar Cache
const calendarCache = {
  events: [],
  lastAttemptAt: 0,
  updatedAt: 0
};

async function fetchEconomicCalendar() {
  const now = Date.now();
  // Cache policy:
  // - If have cached events: reuse up to 4h
  // - If empty cache (last attempt failed/empty): retry every 2m
  const hasCachedEvents = Array.isArray(calendarCache.events) && calendarCache.events.length > 0;
  const minRetryMs = hasCachedEvents ? 4 * 60 * 60 * 1000 : 2 * 60 * 1000;
  if (calendarCache.lastAttemptAt > 0 && now - calendarCache.lastAttemptAt < minRetryMs) {
    return calendarCache.events;
  }
  calendarCache.lastAttemptAt = now;

  try {
    // Primary source: ForexFactory weekly JSON
    try {
      const ffJsonEvents = await fetchForexFactoryWeekJson();
      if (ffJsonEvents.length) {
        calendarCache.events = ffJsonEvents;
        calendarCache.updatedAt = Date.now();
        console.log(`Fetched ${calendarCache.events.length} high-impact calendar events (ForexFactory JSON)`);
        return calendarCache.events;
      }
    } catch (err) {
      console.warn('ForexFactory JSON calendar failed:', err.message);
    }

    // Secondary source: TradingEconomics API only when user provides real API key
    const hasRealTeKey = Boolean(TRADING_ECONOMICS_API_KEY) && TRADING_ECONOMICS_API_KEY !== 'guest:guest';
    try {
      if (hasRealTeKey) {
        const teEvents = await fetchTradingEconomicsCalendarWeek();
        if (teEvents.length) {
          calendarCache.events = teEvents;
          calendarCache.updatedAt = Date.now();
          console.log(`Fetched ${calendarCache.events.length} high-impact calendar events (TradingEconomics)`);
          return calendarCache.events;
        }
      }
    } catch (err) {
      console.warn('TradingEconomics calendar fallback failed:', err.message);
    }
  } catch (err) {
    console.error('Error fetching economic calendar:', err.message);
    return calendarCache.events; // Return cached data on error
  }

  return calendarCache.events;
}

function pctChange(oldValue, newValue) {
  if (!oldValue || !newValue) return null;
  return ((newValue - oldValue) / oldValue) * 100;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function finiteOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function std(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function toClosedKlines(klines, nowMs = Date.now()) {
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

function percentile(values, pct) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function computeAbsMovePct(closes, lag = 1) {
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

function summarizeMoves(moves) {
  return {
    samples: moves.length,
    p50MovePct: num(percentile(moves, 50)?.toFixed(4)),
    p75MovePct: num(percentile(moves, 75)?.toFixed(4))
  };
}

function signBucket(value, eps = 0.02) {
  if (!Number.isFinite(value)) return 'flat';
  if (value > eps) return 'up';
  if (value < -eps) return 'down';
  return 'flat';
}

function classifyOutcome(futureChangePct, thresholdPct) {
  if (!Number.isFinite(futureChangePct) || !Number.isFinite(thresholdPct) || thresholdPct <= 0) return 'sideway';
  if (futureChangePct >= thresholdPct) return 'up';
  if (futureChangePct <= -thresholdPct) return 'down';
  return 'sideway';
}

function incrementOutcome(target, outcome) {
  if (outcome === 'up') target.up += 1;
  else if (outcome === 'down') target.down += 1;
  else target.sideway += 1;
}

function emptyOutcomeCounts() {
  return { up: 0, down: 0, sideway: 0 };
}

function probsFromCounts(counts) {
  const total = (counts.up || 0) + (counts.down || 0) + (counts.sideway || 0);
  if (!total) return null;
  return {
    samples: total,
    up: (counts.up / total) * 100,
    down: (counts.down / total) * 100,
    sideway: (counts.sideway / total) * 100
  };
}

function normalize3(up, down, sideway) {
  let a = Number.isFinite(up) ? up : 0;
  let b = Number.isFinite(down) ? down : 0;
  let c = Number.isFinite(sideway) ? sideway : 0;
  a = Math.max(0.5, a);
  b = Math.max(0.5, b);
  c = Math.max(0.5, c);
  const total = a + b + c;
  return { up: (a / total) * 100, down: (b / total) * 100, sideway: (c / total) * 100 };
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || !values.length || period <= 1) return [];
  const out = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    const v = values[i];
    prev = (v * k) + (prev * (1 - k));
    out.push(prev);
  }
  return out;
}

function latestPositionState(closes, lookback = 90) {
  if (!Array.isArray(closes) || closes.length < Math.max(lookback, 3)) return 'mid';
  const window = closes.slice(-lookback);
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  const last = closes[closes.length - 1];
  const r = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  if (r >= 0.7) return 'high';
  if (r <= 0.3) return 'low';
  return 'mid';
}

function stateEdge(counts, state) {
  const row = counts?.[state];
  if (!row) return { edge: 0, samples: 0 };
  const total = (row.up || 0) + (row.down || 0) + (row.sideway || 0);
  if (!total) return { edge: 0, samples: 0 };
  const rawEdge = ((row.up || 0) - (row.down || 0)) / total;
  const shrink = Math.min(1, total / 80);
  return { edge: rawEdge * shrink, samples: total };
}

function buildFeatureCountsStructure() {
  return {
    trend: { bull: emptyOutcomeCounts(), bear: emptyOutcomeCounts() },
    momentum: { up: emptyOutcomeCounts(), down: emptyOutcomeCounts(), flat: emptyOutcomeCounts() },
    position: { high: emptyOutcomeCounts(), mid: emptyOutcomeCounts(), low: emptyOutcomeCounts() },
    volatility: { high: emptyOutcomeCounts(), low: emptyOutcomeCounts() }
  };
}

function computeScenarioProbsFromState(countsAll, buckets, featureCounts, sampleState) {
  const all = probsFromCounts(countsAll);
  if (!all) return null;

  const sign = sampleState.momentumState || 'flat';
  const volState = sampleState.volState || 'low';
  const conditional = probsFromCounts(buckets?.[`${sign}_${volState}`] || emptyOutcomeCounts());
  const base = (!conditional || conditional.samples < 35)
    ? { ...all, mode: 'unconditional' }
    : { ...conditional, mode: 'conditional' };

  const trendState = sampleState.trendState === 'bull' ? 'bull' : 'bear';
  const positionState = ['high', 'mid', 'low'].includes(sampleState.positionState) ? sampleState.positionState : 'mid';

  const eTrend = stateEdge(featureCounts?.trend, trendState);
  const eMomentum = stateEdge(featureCounts?.momentum, sign);
  const ePosition = stateEdge(featureCounts?.position, positionState);
  const eVol = stateEdge(featureCounts?.volatility, volState);

  const formulaScore = clamp(
    (eTrend.edge * 0.4) + (eMomentum.edge * 0.3) + (ePosition.edge * 0.2) + (eVol.edge * 0.1),
    -1,
    1
  );
  const tilt = formulaScore * 12;
  const adjusted = normalize3(
    base.up + tilt,
    base.down - tilt,
    base.sideway - Math.abs(formulaScore) * 4
  );

  return {
    ...adjusted,
    mode: base.mode,
    formulaScore
  };
}

function computeBacktestMetrics(samples) {
  if (!Array.isArray(samples) || samples.length < 140) return null;
  const split = Math.floor(samples.length * 0.7);
  const train = samples.slice(0, split);
  const test = samples.slice(split);
  if (train.length < 80 || test.length < 40) return null;

  const countsAll = emptyOutcomeCounts();
  const buckets = {};
  const featureCounts = buildFeatureCountsStructure();

  for (const s of train) {
    incrementOutcome(countsAll, s.outcome);
    const key = `${s.momentumState}_${s.volState}`;
    if (!buckets[key]) buckets[key] = emptyOutcomeCounts();
    incrementOutcome(buckets[key], s.outcome);
    incrementOutcome(featureCounts.trend[s.trendState], s.outcome);
    incrementOutcome(featureCounts.momentum[s.momentumState], s.outcome);
    incrementOutcome(featureCounts.position[s.positionState], s.outcome);
    incrementOutcome(featureCounts.volatility[s.volState], s.outcome);
  }

  let brier = 0;
  let top1Hits = 0;
  let dirHits = 0;
  let dirTotal = 0;

  for (const s of test) {
    const probs = computeScenarioProbsFromState(countsAll, buckets, featureCounts, s);
    if (!probs) continue;

    const pUp = probs.up / 100;
    const pDown = probs.down / 100;
    const pSide = probs.sideway / 100;
    const oUp = s.outcome === 'up' ? 1 : 0;
    const oDown = s.outcome === 'down' ? 1 : 0;
    const oSide = s.outcome === 'sideway' ? 1 : 0;
    brier += (((pUp - oUp) ** 2) + ((pDown - oDown) ** 2) + ((pSide - oSide) ** 2)) / 3;

    const pred = pUp >= pDown && pUp >= pSide ? 'up' : pDown >= pUp && pDown >= pSide ? 'down' : 'sideway';
    if (pred === s.outcome) top1Hits += 1;
    if (s.outcome === 'up' || s.outcome === 'down') {
      dirTotal += 1;
      if (pred === s.outcome) dirHits += 1;
    }
  }

  const n = test.length || 1;
  return {
    testSamples: test.length,
    brierScore: num((brier / n).toFixed(4)),
    top1AccuracyPct: num(((top1Hits * 100) / n).toFixed(2)),
    directionalAccuracyPct: dirTotal ? num(((dirHits * 100) / dirTotal).toFixed(2)) : null
  };
}

function klineIntervalMs(interval) {
  if (interval === '4h') return 4 * 60 * 60 * 1000;
  if (interval === '1d') return 24 * 60 * 60 * 1000;
  throw new Error(`Unsupported interval: ${interval}`);
}

async function fetchBinanceKlinesRange(symbol, interval, startTimeMs, endTimeMs, limit = 1000, maxPages = 6) {
  const rows = [];
  const seen = new Set();
  const stepMs = klineIntervalMs(interval);
  let cursor = startTimeMs;

  for (let page = 0; page < maxPages && cursor < endTimeMs; page += 1) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTimeMs}&limit=${limit}`;
    const batch = await fetchJson(url, 12000);
    if (!Array.isArray(batch) || !batch.length) break;

    for (const k of batch) {
      const openTime = num(k?.[0]);
      if (!Number.isFinite(openTime) || seen.has(openTime)) continue;
      seen.add(openTime);
      rows.push(k);
    }

    const lastOpen = num(batch[batch.length - 1]?.[0]);
    if (!Number.isFinite(lastOpen)) break;
    const nextCursor = lastOpen + stepMs;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }

  rows.sort((a, b) => num(a?.[0]) - num(b?.[0]));
  return rows;
}

function buildHistoricalTfStats(closes, horizonBars, thresholdPct, volWindowBars = 24) {
  const countsAll = { up: 0, down: 0, sideway: 0 };
  const samples = [];
  if (!Array.isArray(closes) || closes.length < horizonBars + volWindowBars + 3) {
    return { countsAll, buckets: {}, medianVol: null, samples: 0, featureCounts: {} };
  }

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);

  for (let i = volWindowBars; i + horizonBars < closes.length; i += 1) {
    const nowPrice = closes[i];
    const prevPrice = closes[i - horizonBars];
    const nextPrice = closes[i + horizonBars];
    if (!nowPrice || !prevPrice || !nextPrice) continue;

    const momentum = ((nowPrice - prevPrice) / prevPrice) * 100;
    const futureChange = ((nextPrice - nowPrice) / nowPrice) * 100;
    const outcome = classifyOutcome(futureChange, thresholdPct);

    const logRets = [];
    for (let j = i - volWindowBars + 1; j <= i; j += 1) {
      const a = closes[j - 1];
      const b = closes[j];
      if (a > 0 && b > 0) logRets.push(Math.log(b / a));
    }
    const vol = std(logRets);
    if (!Number.isFinite(vol)) continue;

    const hi = Math.max(...closes.slice(Math.max(0, i - 89), i + 1));
    const lo = Math.min(...closes.slice(Math.max(0, i - 89), i + 1));
    const posRatio = hi > lo ? (nowPrice - lo) / (hi - lo) : 0.5;
    const positionState = posRatio >= 0.7 ? 'high' : posRatio <= 0.3 ? 'low' : 'mid';
    const trendState = (Number.isFinite(ema20[i]) && Number.isFinite(ema50[i]) && ema20[i] >= ema50[i]) ? 'bull' : 'bear';

    samples.push({
      momentum,
      momentumState: signBucket(momentum),
      vol: vol * 100,
      positionState,
      trendState,
      outcome
    });
    incrementOutcome(countsAll, outcome);
  }

  const medianVol = percentile(samples.map((x) => x.vol), 50);
  const buckets = {};
  const featureCounts = buildFeatureCountsStructure();

  for (const s of samples) {
    const sign = s.momentumState;
    const volState = Number.isFinite(medianVol) && s.vol >= medianVol ? 'high' : 'low';
    s.volState = volState;
    const key = `${sign}_${volState}`;
    if (!buckets[key]) buckets[key] = { up: 0, down: 0, sideway: 0 };
    incrementOutcome(buckets[key], s.outcome);
    incrementOutcome(featureCounts.trend[s.trendState], s.outcome);
    incrementOutcome(featureCounts.momentum[sign], s.outcome);
    incrementOutcome(featureCounts.position[s.positionState], s.outcome);
    incrementOutcome(featureCounts.volatility[volState], s.outcome);
  }

  return {
    countsAll,
    buckets,
    featureCounts,
    medianVol: Number.isFinite(medianVol) ? medianVol : null,
    samples: samples.length,
    backtest: computeBacktestMetrics(samples)
  };
}

function pickHistoricalProbs(stats, context) {
  if (!stats) return null;
  const all = probsFromCounts(stats.countsAll);
  if (!all) return null;

  const sign = signBucket(context?.momentumPct);
  const volState = Number.isFinite(stats.medianVol) && Number.isFinite(context?.volPct) && context.volPct >= stats.medianVol ? 'high' : 'low';
  const trendState = context?.trendState === 'bull' ? 'bull' : 'bear';
  const positionState = ['high', 'mid', 'low'].includes(context?.positionState) ? context.positionState : 'mid';
  const probs = computeScenarioProbsFromState(stats.countsAll, stats.buckets, stats.featureCounts, {
    momentumState: sign,
    volState,
    trendState,
    positionState
  });
  if (!probs) return { ...all, mode: 'unconditional' };

  const eTrend = stateEdge(stats.featureCounts?.trend, trendState);
  const eMomentum = stateEdge(stats.featureCounts?.momentum, sign);
  const ePosition = stateEdge(stats.featureCounts?.position, positionState);
  const eVol = stateEdge(stats.featureCounts?.volatility, volState);

  return {
    samples: probsFromCounts(stats.buckets?.[`${sign}_${volState}`] || emptyOutcomeCounts())?.samples
      || probsFromCounts(stats.countsAll)?.samples
      || 0,
    up: probs.up,
    down: probs.down,
    sideway: probs.sideway,
    mode: probs.mode || 'unconditional',
    formulaScore: probs.formulaScore,
    drivers: {
      trend: { state: trendState, edge: eTrend.edge, samples: eTrend.samples },
      momentum: { state: sign, edge: eMomentum.edge, samples: eMomentum.samples },
      position: { state: positionState, edge: ePosition.edge, samples: ePosition.samples },
      volatility: { state: volState, edge: eVol.edge, samples: eVol.samples }
    }
  };
}

async function getHistoricalScenarioModel(symbol, tfThresholdMap, metrics) {
  const nowMs = Date.now();
  const cached = historicalScenarioCache.get(symbol);
  if (cached && (nowMs - cached.updatedAt) < HIST_MODEL_REFRESH_MS) {
    return cached.model;
  }

  const start4h = nowMs - (380 * 24 * 60 * 60 * 1000);
  const start1d = nowMs - (420 * 24 * 60 * 60 * 1000);
  const [k4h, k1d] = await Promise.all([
    fetchBinanceKlinesRange(symbol, '4h', start4h, nowMs, 1000, 6),
    fetchBinanceKlinesRange(symbol, '1d', start1d, nowMs, 1000, 2)
  ]);

  const close4h = toClosedKlines(k4h, nowMs).map((k) => num(k[4])).filter((x) => x !== null);
  const close1d = toClosedKlines(k1d, nowMs).map((k) => num(k[4])).filter((x) => x !== null);

  const fallbackThr = {
    '4h': 1.0, '8h': 1.2, '12h': 1.4, '1d': 2.0, '3d': 3.5, '1w': 5.0
  };
  const thresholds = {
    '4h': finiteOr(tfThresholdMap?.['4h'], fallbackThr['4h']),
    '8h': finiteOr(tfThresholdMap?.['8h'], fallbackThr['8h']),
    '12h': finiteOr(tfThresholdMap?.['12h'], fallbackThr['12h']),
    '1d': finiteOr(tfThresholdMap?.['1d'], fallbackThr['1d']),
    '3d': finiteOr(tfThresholdMap?.['3d'], fallbackThr['3d']),
    '1w': finiteOr(tfThresholdMap?.['1w'], fallbackThr['1w'])
  };

  const stats = {
    '4h': buildHistoricalTfStats(close4h, 1, thresholds['4h'], 18),
    '8h': buildHistoricalTfStats(close4h, 2, thresholds['8h'], 18),
    '12h': buildHistoricalTfStats(close4h, 3, thresholds['12h'], 18),
    '1d': buildHistoricalTfStats(close1d, 1, thresholds['1d'], 14),
    '3d': buildHistoricalTfStats(close1d, 3, thresholds['3d'], 14),
    '1w': buildHistoricalTfStats(close1d, 7, thresholds['1w'], 14)
  };

  const momentumNow = {
    '4h': finiteOr(metrics.closeChange4h, 0),
    '8h': finiteOr(metrics.closeChange4h, 0),
    '12h': finiteOr(metrics.closeChange4h, 0),
    '1d': finiteOr(metrics.closeChange1d, 0),
    '3d': finiteOr(metrics.closeChange1d, 0),
    '1w': finiteOr(metrics.closeChange1w, 0)
  };
  const currentVol = {
    '4h': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(4 / 24),
    '8h': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(8 / 24),
    '12h': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(12 / 24),
    '1d': finiteOr(metrics.realizedVol24h, 2.4),
    '3d': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(3),
    '1w': finiteOr(metrics.realizedVol24h, 2.4) * Math.sqrt(7)
  };
  const currentPosition4h = latestPositionState(close4h, 90);
  const currentPosition1d = latestPositionState(close1d, 90);
  const ema204h = emaSeries(close4h, 20);
  const ema504h = emaSeries(close4h, 50);
  const ema201d = emaSeries(close1d, 20);
  const ema501d = emaSeries(close1d, 50);
  const trendState4h = (ema204h.length && ema504h.length && ema204h[ema204h.length - 1] >= ema504h[ema504h.length - 1]) ? 'bull' : 'bear';
  const trendState1d = (ema201d.length && ema501d.length && ema201d[ema201d.length - 1] >= ema501d[ema501d.length - 1]) ? 'bull' : 'bear';

  const model = {};
  for (const tf of ['4h', '8h', '12h', '1d', '3d', '1w']) {
    const context = {
      momentumPct: momentumNow[tf],
      volPct: currentVol[tf],
      trendState: tf === '4h' || tf === '8h' || tf === '12h' ? trendState4h : trendState1d,
      positionState: tf === '4h' || tf === '8h' || tf === '12h' ? currentPosition4h : currentPosition1d
    };
    const probs = pickHistoricalProbs(stats[tf], context);
    if (!probs) continue;
    model[tf] = {
      up: num(probs.up?.toFixed(2)),
      down: num(probs.down?.toFixed(2)),
      sideway: num(probs.sideway?.toFixed(2)),
      samples: probs.samples,
      mode: probs.mode || 'unconditional',
      thresholdPct: thresholds[tf],
      formulaScore: num(probs.formulaScore?.toFixed(4)),
      drivers: probs.drivers,
      backtest: stats[tf].backtest || null
    };
  }

  const payload = {
    lookbackDays: 365,
    generatedAt: new Date(nowMs).toISOString(),
    byTimeframe: model
  };
  historicalScenarioCache.set(symbol, { updatedAt: nowMs, model: payload });
  return payload;
}

function computeTimeframeVolatility30d(kline4h, kline1d, nowMs = Date.now()) {
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

async function getSnapshot(symbol = 'BTCUSDT', timeframeHours = 4) {
  const now = new Date().toISOString();

  // Validate symbol
  const validSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  if (!validSymbols.includes(symbol)) {
    throw new Error(`Invalid symbol. Allowed: ${validSymbols.join(', ')}`);
  }

  // Validate timeframeHours
  const validTimeframes = [4, 8, 12, 24, 72, 168];
  if (!validTimeframes.includes(timeframeHours)) {
    timeframeHours = 4;
  }

  // Calculate candle limit based on timeframe for display
  const candleLimit = Math.min(timeframeHours, 96);

  // Chart luôn hiển thị 3 ngày, không phụ thuộc vào timeframe selector
  const chartLimit1h = 72; // 72 nến 1h = 3 ngày
  const chartLimit4h = 18; // 18 nến 4h = 3 ngày

  // Tính limit cho fetch (cần thêm buffer để tính momentum và chart)
  const monthCandles4h = Math.ceil((30 * 24) / 4) + 3;
  const monthCandles1d = 30 + 7;
  const fetchLimit1h = Math.max(candleLimit, chartLimit1h, 48);
  const fetchLimit4h = Math.max(candleLimit, chartLimit4h, 48, monthCandles4h);
  const fetchLimit1d = Math.max(8, monthCandles1d);
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
    usdcEvents,
    economicCalendar
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
    fetchUSDCMintingEvents(),
    fetchEconomicCalendar()
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
  const calendarV = economicCalendar.status === 'fulfilled' ? economicCalendar.value : [];

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

  const tfVol30d = computeTimeframeVolatility30d(kline4hV, kline1dV);
  const tfThresholdMap = {
    '4h': tfVol30d.byTimeframe['4h'].p75MovePct,
    '8h': tfVol30d.byTimeframe['8h'].p75MovePct,
    '12h': tfVol30d.byTimeframe['12h'].p75MovePct,
    '1d': tfVol30d.byTimeframe['1d'].p75MovePct,
    '3d': tfVol30d.byTimeframe['3d'].p75MovePct,
    '1w': tfVol30d.byTimeframe['1w'].p75MovePct
  };

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
    timeframeThresholdBase30d: tfThresholdMap,
    timeframeVolatility30d: tfVol30d,
    deribitIv: num(dSummary?.mark_iv),
    deribitOpenInterestUsd: num(dSummary?.open_interest),
    btcMarketCapDominance: num(cgV?.data?.market_cap_percentage?.btc),
    totalMcapUsd: num(cgV?.data?.total_market_cap?.usd),
    totalVolumeUsd: num(cgV?.data?.total_volume?.usd)
  };

  try {
    metrics.historicalScenarioModel = await getHistoricalScenarioModel(symbol, tfThresholdMap, metrics);
  } catch (err) {
    errors.push(`Historical scenario model lỗi: ${err.message}`);
    metrics.historicalScenarioModel = null;
  }

  return {
    generatedAt: now,
    metrics,
    trend: inferTrend(metrics, timeframeHours),
    usdcMinting: usdcEventsV || [],
    economicCalendar: calendarV || [],
    history: {
      candles1h: normalizeCandles(kline1hV, chartLimit1h),
      candles4h: normalizeCandles(kline4hV, chartLimit4h),
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
      { name: 'ForexFactory Calendar', url: 'https://www.forexfactory.com/calendar' },
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
      const params = client._streamParams || { symbol: 'BTCUSDT', timeframe: 4 };
      const key = `${params.symbol}:${params.timeframe}`;
      if (!clientGroups.has(key)) {
        clientGroups.set(key, { params, clients: [] });
      }
      clientGroups.get(key).clients.push(client);
    }

    // Fetch và gửi cho từng nhóm
    for (const [key, group] of clientGroups) {
      try {
        const snapshot = await getSnapshot(group.params.symbol, group.params.timeframe);
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
      const timeframe = parseInt(url.searchParams.get('timeframe') || '4', 10);

      // Fetch on-demand với params từ client
      const snapshot = await getSnapshot(symbol, timeframe);

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
    const timeframe = parseInt(url.searchParams.get('timeframe') || '4', 10);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });

    res.write('retry: 2000\n\n');

    // Store client với params của nó
    res._streamParams = { symbol, timeframe };
    sseClients.add(res);

    // Gửi snapshot đầu tiên
    (async () => {
      try {
        const snapshot = await getSnapshot(symbol, timeframe);
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
