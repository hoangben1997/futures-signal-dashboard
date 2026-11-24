import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferTrend } from './lib/scoring.js';
import { klinesToCandles, summarizeTimeframe } from './lib/indicators.js';
import { buildMarketReport } from './lib/analysis.js';
import { buildMetrics } from './lib/metrics.js';
import { runShadowCycle } from './lib/shadow-runner.js';
import { num } from './lib/stats.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 7000);
// Mặc định chỉ nhận kết nối từ máy này (dashboard không có xác thực). Đặt HOST=0.0.0.0 để mở ra mạng LAN.
const HOST = process.env.HOST || '127.0.0.1';
// Shadow forward (docs/P1_SPEC.md, REVISED_ROADMAP P1): ghi dự báo baseline mỗi lần nến ngày đóng vào data/shadow/.
// Chỉ chạy khi start server trực tiếp; SHADOW_ENABLED=0 để tắt.
const SHADOW_ENABLED = process.env.SHADOW_ENABLED !== '0';
const SHADOW_INTERVAL_MS = Number(process.env.SHADOW_INTERVAL_MS || 5 * 60 * 1000);
const SHADOW_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'data', 'shadow');
const REFRESH_MS = Number(process.env.REFRESH_MS || 5000);
const USDC_REFRESH_MS = Number(process.env.USDC_REFRESH_MS || 3600000);
const TECHNICALS_REFRESH_MS = Number(process.env.TECHNICALS_REFRESH_MS || 60 * 1000);
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
  ok: false,
  error: null,
  inflight: null,
  lastAttemptAt: 0,
  updatedAt: 0
};
const technicalsCache = new Map();

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

  const sorted = events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  console.log(`Fetched ${sorted.length} USDC events from RPC (72H)`);
  return sorted;
}

async function fetchUSDCMintingEventsFromEtherscan() {
  {
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
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokentx&address=${USDC_TREASURY}&contractaddress=${USDC_CONTRACT}&page=1&offset=500&sort=desc&apikey=${ETHERSCAN_API_KEY}`;

    const response = await fetchJson(url, 10000);

    // status '0' + "No transactions found" là kết quả rỗng hợp lệ; mọi trường hợp khác là lỗi nguồn
    if (response.status === '0' && /no transactions found/i.test(String(response.message || ''))) return [];
    if (response.status !== '1' || !Array.isArray(response.result)) {
      throw new Error(`Etherscan non-success: ${typeof response.result === 'string' ? response.result : response.message || 'unknown'}`);
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

    const sorted = events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    console.log(`Fetched ${sorted.length} USDC events from Etherscan (72H)`);
    return sorted;
  }
}

async function fetchUSDCMintingEventsFromWhaleAlert() {
  {
    const now = Math.floor(Date.now() / 1000);
    const start = now - (72 * 60 * 60);
    const url = `https://whale-alert.io/alerts.json?start=${start}&end=${now}`;

    const raw = await fetchText(url, 10000);
    let rows;
    try {
      rows = JSON.parse(raw);
    } catch {
      throw new Error('Whale Alert trả dữ liệu không phải JSON');
    }
    if (!Array.isArray(rows)) throw new Error('Whale Alert trả dữ liệu sai định dạng');

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

    const sorted = events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    console.log(`Fetched ${sorted.length} USDC events from Whale Alert (72H)`);
    return sorted;
  }
}

// Thử lần lượt các nguồn; nguồn lỗi thì chuyển nguồn kế tiếp. Chỉ throw khi đã thử hết.
// Mảng rỗng từ một nguồn chạy thành công là kết quả hợp lệ ("không có sự kiện"), không phải lỗi.
async function fetchUSDCMintingEventsUncached() {
  const attempts = [];
  if (ETH_RPC_URL) attempts.push(['rpc', () => fetchUSDCMintingEventsFromRpc(ETH_RPC_URL)]);
  if (ETHERSCAN_API_KEY && ETHERSCAN_API_KEY !== 'YourApiKeyToken') attempts.push(['etherscan', fetchUSDCMintingEventsFromEtherscan]);
  for (const rpcUrl of ETH_RPC_FALLBACKS) attempts.push(['rpc-fallback', () => fetchUSDCMintingEventsFromRpc(rpcUrl)]);
  attempts.push(['whale-alert', fetchUSDCMintingEventsFromWhaleAlert]);

  const failures = [];
  for (const [source, run] of attempts) {
    try {
      const events = await run();
      return { events: Array.isArray(events) ? events : [], source };
    } catch (err) {
      console.error(`Error fetching USDC events from ${source}:`, err.message);
      failures.push(`${source}: ${err.message}`);
    }
  }
  throw new Error(failures.join('; '));
}

// Trạng thái trả cho snapshot: lỗi sau khi thử hết nguồn thì giữ dữ liệu cũ và đánh dấu stale.
function usdcStatus() {
  const c = usdcEventsCache;
  return {
    ok: c.ok,
    events: c.events,
    source: c.source,
    error: c.error,
    stale: !c.ok && c.events.length > 0,
    fetchedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null
  };
}

async function fetchUSDCMintingEvents() {
  const c = usdcEventsCache;
  if (c.inflight) return c.inflight;
  if (c.lastAttemptAt > 0 && Date.now() - c.lastAttemptAt < USDC_REFRESH_MS) return usdcStatus();
  c.lastAttemptAt = Date.now();
  c.inflight = (async () => {
    try {
      const { events, source } = await fetchUSDCMintingEventsUncached();
      Object.assign(c, { events, source, ok: true, error: null, updatedAt: Date.now() });
    } catch (err) {
      Object.assign(c, { ok: false, error: err.message });
    } finally {
      c.inflight = null;
    }
    return usdcStatus();
  })();
  return c.inflight;
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
  ok: false,
  error: null,
  inflight: null,
  lastAttemptAt: 0,
  updatedAt: 0
};

function calendarStatus() {
  const c = calendarCache;
  return {
    ok: c.ok,
    events: c.events,
    error: c.error,
    stale: !c.ok && c.events.length > 0,
    fetchedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : null
  };
}

async function fetchEconomicCalendarUncached() {
  const failures = [];
  // Primary source: ForexFactory weekly JSON
  try {
    const ffJsonEvents = await fetchForexFactoryWeekJson();
    console.log(`Fetched ${ffJsonEvents.length} high-impact calendar events (ForexFactory JSON)`);
    return ffJsonEvents;
  } catch (err) {
    console.warn('ForexFactory JSON calendar failed:', err.message);
    failures.push(`ForexFactory: ${err.message}`);
  }

  // Secondary source: TradingEconomics API only when user provides real API key
  const hasRealTeKey = Boolean(TRADING_ECONOMICS_API_KEY) && TRADING_ECONOMICS_API_KEY !== 'guest:guest';
  if (hasRealTeKey) {
    try {
      const teEvents = await fetchTradingEconomicsCalendarWeek();
      console.log(`Fetched ${teEvents.length} high-impact calendar events (TradingEconomics)`);
      return teEvents;
    } catch (err) {
      console.warn('TradingEconomics calendar fallback failed:', err.message);
      failures.push(`TradingEconomics: ${err.message}`);
    }
  }
  throw new Error(failures.join('; '));
}

async function fetchEconomicCalendar() {
  const c = calendarCache;
  if (c.inflight) return c.inflight;
  // Cache policy:
  // - If have cached events: reuse up to 4h
  // - If empty cache (last attempt failed/empty): retry every 2m
  const minRetryMs = c.events.length > 0 ? 4 * 60 * 60 * 1000 : 2 * 60 * 1000;
  if (c.lastAttemptAt > 0 && Date.now() - c.lastAttemptAt < minRetryMs) return calendarStatus();
  c.lastAttemptAt = Date.now();
  c.inflight = (async () => {
    try {
      const events = await fetchEconomicCalendarUncached();
      Object.assign(c, { events, ok: true, error: null, updatedAt: Date.now() });
    } catch (err) {
      Object.assign(c, { ok: false, error: err.message });
    } finally {
      c.inflight = null;
    }
    return calendarStatus();
  })();
  return c.inflight;
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


// Cache theo khoá, gộp các lần gọi trùng khi đang tải (single-flight).
// `loader` trả { value, ttlMs }; lỗi không được cache để lần sau thử lại.
async function cachedLoad(cache, key, loader) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry?.inflight) return entry.inflight;
  if (entry && now - entry.at < entry.ttlMs) return entry.value;
  const inflight = (async () => {
    try {
      const { value, ttlMs } = await loader();
      cache.set(key, { value, ttlMs, at: Date.now() });
      return value;
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  })();
  cache.set(key, { ...entry, inflight });
  return inflight;
}

// Một nguồn dữ liệu: không throw, luôn trả trạng thái để snapshot biết nguồn nào lỗi / cũ.
// observedAt = thời điểm của điểm dữ liệu mới nhất theo nguồn; fetchedAt = lúc server nhận.
async function loadSource(name, url, { maxAgeMs, observedAt }) {
  const fetchedAt = Date.now();
  try {
    const value = await fetchJson(url);
    const obs = observedAt ? observedAt(value) : null;
    const observed = Number.isFinite(obs) ? Math.min(obs, fetchedAt) : null;
    return {
      name,
      ok: true,
      value,
      fetchedAt,
      observedAt: observed,
      stale: observed !== null && fetchedAt - observed > maxAgeMs,
      error: null
    };
  } catch (err) {
    return { name, ok: false, value: null, fetchedAt, observedAt: null, stale: false, error: err.message };
  }
}

const lastRowTime = (field) => (rows) => (Array.isArray(rows) && rows.length ? Number(rows[rows.length - 1]?.[field]) : null);
const lastKlineCloseTime = (rows) => (Array.isArray(rows) && rows.length ? Number(rows[rows.length - 1]?.[6]) : null);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Giới hạn nến theo symbol, cố định cho mọi horizon để các horizon dùng chung một lần fetch.
// 1h lấy 96 (mức lớn nhất trước đây, horizon 1w); mỗi horizon cắt lại đúng số nến như logic cũ.
const FETCH_LIMIT_1H = 96;
const FETCH_LIMIT_4H = Math.ceil((30 * 24) / 4) + 3;
const FETCH_LIMIT_1D = 30 + 7;
const FETCH_LIMIT_1W = 8;
const GLOBAL_FEED_TTL_MS = 5 * MIN;

const symbolSourceCache = new Map();
const globalSourceCache = new Map();

function symbolSourceSpecs(symbol) {
  const deribitCurrency = symbol.replace('USDT', '');
  const kl = (interval, limit) => `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return {
    premium: ['Binance premiumIndex', `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { maxAgeMs: 5 * MIN, observedAt: (v) => Number(v?.time) }],
    oiNow: ['Binance openInterest', `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, { maxAgeMs: 5 * MIN, observedAt: (v) => Number(v?.time) }],
    oiHist: ['Binance openInterestHist', `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=7`, { maxAgeMs: 2 * HOUR, observedAt: lastRowTime('timestamp') }],
    lsHist: ['Binance globalLongShort', `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=5`, { maxAgeMs: 2 * HOUR, observedAt: lastRowTime('timestamp') }],
    topTraderLs: ['Binance topTraderLongShort', `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=5`, { maxAgeMs: 2 * HOUR, observedAt: lastRowTime('timestamp') }],
    takerFlow: ['Binance takerRatio', `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=5`, { maxAgeMs: 2 * HOUR, observedAt: lastRowTime('timestamp') }],
    ticker24h: ['Binance ticker24h', `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`, { maxAgeMs: 5 * MIN, observedAt: (v) => Number(v?.closeTime) }],
    kline1h: ['Binance klines 1h', kl('1h', FETCH_LIMIT_1H), { maxAgeMs: 2 * HOUR, observedAt: lastKlineCloseTime }],
    kline4h: ['Binance klines 4h', kl('4h', FETCH_LIMIT_4H), { maxAgeMs: 8 * HOUR, observedAt: lastKlineCloseTime }],
    kline1d: ['Binance klines 1d', kl('1d', FETCH_LIMIT_1D), { maxAgeMs: 48 * HOUR, observedAt: lastKlineCloseTime }],
    kline1w: ['Binance klines 1w', kl('1w', FETCH_LIMIT_1W), { maxAgeMs: 14 * 24 * HOUR, observedAt: lastKlineCloseTime }],
    deribit: ['Deribit book summary', `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${deribitCurrency}&kind=future`, {
      maxAgeMs: 10 * MIN,
      observedAt: (v) => Number(v?.result?.find((x) => x.instrument_name === `${deribitCurrency}-PERPETUAL`)?.creation_timestamp)
    }]
  };
}

const GLOBAL_SOURCE_SPECS = {
  fearGreed: ['Fear & Greed', 'https://api.alternative.me/fng/?limit=1', { maxAgeMs: 48 * HOUR, observedAt: (v) => Number(v?.data?.[0]?.timestamp) * 1000 }],
  coingeckoGlobal: ['CoinGecko global', 'https://api.coingecko.com/api/v3/global', { maxAgeMs: HOUR, observedAt: (v) => Number(v?.data?.updated_at) * 1000 }]
};

async function loadSourceGroup(specs) {
  const entries = Object.entries(specs);
  const results = await Promise.all(entries.map(([, [name, url, opts]]) => loadSource(name, url, opts)));
  return Object.fromEntries(entries.map(([key], i) => [key, results[i]]));
}

// Nguồn theo symbol: TTL = REFRESH_MS, mọi horizon / client của cùng symbol dùng chung.
function getSymbolSources(symbol) {
  return cachedLoad(symbolSourceCache, symbol, async () => ({
    value: await loadSourceGroup(symbolSourceSpecs(symbol)),
    ttlMs: REFRESH_MS
  }));
}

// Nguồn toàn thị trường cập nhật chậm: TTL riêng 5 phút; có nguồn lỗi thì chỉ giữ một chu kỳ REFRESH_MS.
function getGlobalSources() {
  return cachedLoad(globalSourceCache, 'global', async () => {
    const value = await loadSourceGroup(GLOBAL_SOURCE_SPECS);
    const allOk = Object.values(value).every((s) => s.ok);
    return { value, ttlMs: allOk ? GLOBAL_FEED_TTL_MS : REFRESH_MS };
  });
}

function sourceStatus(s) {
  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  return {
    name: s.name,
    ok: s.ok,
    fetchedAt: iso(s.fetchedAt),
    observedAt: iso(s.observedAt),
    stale: Boolean(s.stale),
    error: s.error || null
  };
}

// Hợp đồng snapshot ở giai đoạn P0 (docs/REVISED_ROADMAP.md): chưa có xác suất nào qua kiểm định.
const SNAPSHOT_CONTRACT = {
  version: 'p0',
  validatedProbabilities: false,
  historicalModel: 'disabled',
  unverifiedFields: {
    'trend.scenarioProbabilities': 'Điểm heuristic đã chuẩn hoá, không phải xác suất. UI không hiển thị.',
    'trend.confidence': 'Biến đổi của độ lớn điểm quyết định, không phải xác suất. UI không hiển thị dạng %.',
    'trend.score': 'Điểm rule-based chưa kiểm định.',
    'trend.decision': 'Trạng thái từ điểm rule-based chưa kiểm định.',
    'trend.breakoutLevels': 'Mức theo dõi = close nến trước ± ngưỡng biến động 30 ngày; không phải outcome dự báo.'
  },
  note: 'Mô hình kịch bản lịch sử đang tắt (lib/historical.js) vì có leakage và chưa chứng minh skill ngoài mẫu.'
};

// Kỹ thuật đa khung: W/D/4H/1H lấy từ futures (cùng nguồn với dashboard), khung tháng lấy từ spot
// vì perpetual mới có từ 2019 (~85 nến tháng), spot có từ 2017 (~112 nến, đủ MA100 tháng).
const TECHNICAL_FEEDS = [
  { tf: '1M', base: 'https://api.binance.com/api/v3/klines', interval: '1M', limit: 1000, source: 'Binance spot' },
  { tf: '1w', base: 'https://fapi.binance.com/fapi/v1/klines', interval: '1w', limit: 400, source: 'Binance USDT-M futures' },
  { tf: '1d', base: 'https://fapi.binance.com/fapi/v1/klines', interval: '1d', limit: 400, source: 'Binance USDT-M futures' },
  { tf: '4h', base: 'https://fapi.binance.com/fapi/v1/klines', interval: '4h', limit: 400, source: 'Binance USDT-M futures' },
  { tf: '1h', base: 'https://fapi.binance.com/fapi/v1/klines', interval: '1h', limit: 400, source: 'Binance USDT-M futures' }
];

async function loadTechnicals(symbol) {
  const nowMs = Date.now();
  const results = await Promise.allSettled(
    TECHNICAL_FEEDS.map((f) => fetchJson(`${f.base}?symbol=${symbol}&interval=${f.interval}&limit=${f.limit}`, 10000))
  );

  const byTf = {};
  const sources = {};
  const errors = [];
  TECHNICAL_FEEDS.forEach((feed, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled') {
      errors.push(`Binance klines ${feed.tf} (kỹ thuật) lỗi`);
      return;
    }
    const { candles, closedCount } = klinesToCandles(r.value, nowMs);
    const summary = summarizeTimeframe(candles, { closedCount });
    if (!summary) return;
    byTf[feed.tf] = summary;
    sources[feed.tf] = feed.source;
  });

  const payload = { generatedAt: new Date(nowMs).toISOString(), byTf, sources, errors };
  // Lỗi toàn bộ thì không cache để lần sau thử lại ngay
  return { value: payload, ttlMs: Object.keys(byTf).length ? TECHNICALS_REFRESH_MS : 0 };
}

function getTechnicals(symbol) {
  return cachedLoad(technicalsCache, symbol, () => loadTechnicals(symbol));
}

const VALID_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const VALID_TIMEFRAMES = [4, 8, 12, 24, 72, 168];

async function getSnapshot(symbol = 'BTCUSDT', timeframeHours = 4) {
  const now = new Date().toISOString();

  if (!VALID_SYMBOLS.includes(symbol)) {
    throw new Error(`Invalid symbol. Allowed: ${VALID_SYMBOLS.join(', ')}`);
  }
  if (!VALID_TIMEFRAMES.includes(timeframeHours)) {
    timeframeHours = 4;
  }

  // Chart luôn hiển thị 3 ngày, không phụ thuộc vào timeframe selector
  const chartLimit1h = 72; // 72 nến 1h = 3 ngày
  const chartLimit4h = 18; // 18 nến 4h = 3 ngày
  // Số nến 1h dùng cho momentum / realized vol, giữ đúng như trước khi gộp fetch theo symbol
  const statsLimit1h = Math.max(Math.min(timeframeHours, 96), chartLimit1h, 48);
  const deribitCurrency = symbol.replace('USDT', '');

  const [src, globalSrc, usdc, calendar] = await Promise.all([
    getSymbolSources(symbol),
    getGlobalSources(),
    fetchUSDCMintingEvents(),
    fetchEconomicCalendar()
  ]);

  const errors = [];
  const pick = (s, label) => {
    if (!s.ok) errors.push(label);
    return s.value;
  };

  const premiumV = pick(src.premium, 'Binance premiumIndex lỗi');
  const oiNowV = pick(src.oiNow, 'Binance openInterest lỗi');
  const oiHistV = pick(src.oiHist, 'Binance openInterestHist lỗi');
  const lsHistV = pick(src.lsHist, 'Binance globalLongShort ratio lỗi');
  const topTraderLsV = pick(src.topTraderLs, 'Binance top trader ratio lỗi');
  const takerFlowV = pick(src.takerFlow, 'Binance taker flow lỗi');
  const ticker24hV = pick(src.ticker24h, 'Binance ticker24h lỗi');
  const kline1hAll = pick(src.kline1h, 'Binance klines lỗi');
  const kline4hV = pick(src.kline4h, 'Binance klines 4h lỗi');
  const kline1dV = pick(src.kline1d, 'Binance klines 1d lỗi');
  const kline1wV = pick(src.kline1w, 'Binance klines 1w lỗi');
  const fearGreedV = pick(globalSrc.fearGreed, 'Fear&Greed API lỗi');
  const deribitV = pick(src.deribit, 'Deribit API lỗi');
  const cgV = pick(globalSrc.coingeckoGlobal, 'CoinGecko global lỗi');
  if (!usdc.ok) errors.push(`USDC treasury lỗi (đã thử hết nguồn): ${usdc.error}`);
  if (!calendar.ok) errors.push(`Lịch kinh tế lỗi: ${calendar.error}`);

  const kline1hV = Array.isArray(kline1hAll) ? kline1hAll.slice(-statsLimit1h) : null;
  const usdcEventsV = usdc.events;
  const calendarV = calendar.events;

  const metrics = buildMetrics({
    symbol,
    asOf: now,
    premium: premiumV,
    oiNow: oiNowV,
    oiHist: oiHistV,
    lsHist: lsHistV,
    topTraderLs: topTraderLsV,
    takerFlow: takerFlowV,
    ticker24h: ticker24hV,
    kline1h: kline1hV,
    kline4h: kline4hV,
    kline1d: kline1dV,
    kline1w: kline1wV,
    fearGreed: fearGreedV,
    deribit: deribitV,
    coingeckoGlobal: cgV
  });

  let technicals = null;
  try {
    technicals = await getTechnicals(symbol);
    errors.push(...technicals.errors);
  } catch (err) {
    errors.push(`Technicals lỗi: ${err.message}`);
  }

  // Tình trạng nguồn theo family của DiSSS: ok nếu ít nhất một nguồn chạy được, stale nếu có nguồn báo cũ.
  const health = (...list) => ({ ok: list.some((x) => x?.ok), stale: list.some((x) => x?.stale) });
  const sourceHealth = {
    funding: health(src.premium),
    oi: health(src.oiNow, src.oiHist),
    positioning: health(src.lsHist, src.topTraderLs),
    flow: health(src.takerFlow),
    sentiment: health(globalSrc.fearGreed),
    onchain: { ok: usdc.ok, stale: usdc.stale }
  };

  let analysis = null;
  try {
    analysis = buildMarketReport({
      symbol,
      metrics,
      technicals,
      calendar: calendarV || [],
      usdcEvents: usdcEventsV || [],
      sourceHealth,
      errors
    });
  } catch (err) {
    errors.push(`Analysis lỗi: ${err.message}`);
  }

  const sources = [
    ...Object.values(src).map(sourceStatus),
    ...Object.values(globalSrc).map(sourceStatus),
    { name: `USDC treasury (${usdc.source})`, ok: usdc.ok, fetchedAt: usdc.fetchedAt, observedAt: null, stale: usdc.stale, error: usdc.error },
    { name: 'Lịch kinh tế', ok: calendar.ok, fetchedAt: calendar.fetchedAt, observedAt: null, stale: calendar.stale, error: calendar.error }
  ];

  return {
    generatedAt: now,
    contract: SNAPSHOT_CONTRACT,
    sources,
    metrics,
    technicals,
    analysis,
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
    res.end(JSON.stringify({ ok: true, now: new Date().toISOString(), port: PORT, shadow: shadowState }));
    return;
  }

  try {
    await serveStatic(url.pathname, res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

// Xoá cache trong bộ nhớ (dùng cho test).
function resetCaches() {
  symbolSourceCache.clear();
  globalSourceCache.clear();
  technicalsCache.clear();
  Object.assign(usdcEventsCache, { events: [], source: 'none', ok: false, error: null, inflight: null, lastAttemptAt: 0, updatedAt: 0 });
  Object.assign(calendarCache, { events: [], ok: false, error: null, inflight: null, lastAttemptAt: 0, updatedAt: 0 });
}

// Trạng thái chu kỳ shadow gần nhất, trả qua /api/health. Timer độc lập với request/SSE.
const shadowState = { enabled: false, lastRunAt: null, lastResult: null, error: null };

async function shadowTick() {
  try {
    const result = await runShadowCycle({ fetchJson: (url) => fetchJson(url, 15000), dir: SHADOW_DIR, symbol: 'BTCUSDT' });
    shadowState.lastResult = result.skipped ? { skipped: result.skipped } : { actions: result.actions, written: result.written, status: result.status };
    shadowState.error = null;
    if (result.written) console.log(`Shadow: ghi ${result.written} bản ghi (${result.actions.join(', ')})`);
  } catch (err) {
    shadowState.error = err.message;
    console.error('Shadow cycle lỗi:', err.message);
  } finally {
    shadowState.lastRunAt = new Date().toISOString();
  }
}

function start(port = PORT, host = HOST, { shadow = false } = {}) {
  const timer = setInterval(refreshAllClients, REFRESH_MS);
  server.once('close', () => clearInterval(timer));
  if (shadow) {
    shadowState.enabled = true;
    shadowTick();
    const shadowTimer = setInterval(shadowTick, SHADOW_INTERVAL_MS);
    server.once('close', () => clearInterval(shadowTimer));
  }
  return new Promise((done) => {
    server.listen(port, host, () => {
      const { address, port: boundPort } = server.address();
      console.log(`Dashboard running at http://${address}:${boundPort}`);
      done(server);
    });
  });
}

// Chỉ tự listen khi chạy trực tiếp `node server.js`; import từ test thì không.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  start(PORT, HOST, { shadow: SHADOW_ENABLED });
}

export { getSnapshot, resetCaches, start, server, sseClients };
