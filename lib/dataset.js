/**
 * Data contract dataset-v1 (docs/P1_SPEC.md §1): tải nến Binance futures theo trang,
 * chuẩn hoá, kiểm gap / duplicate / conflict, tạo JSONL + manifest có checksum.
 * Hàm ở đây thuần (trừ fetchKlinesRange nhận fetchJson từ ngoài) để test không cần mạng.
 */
import { createHash } from 'node:crypto';

export const DATASET_VERSION = 'dataset-v1';
export const FAPI_KLINES = 'https://fapi.binance.com/fapi/v1/klines';
const PAGE_LIMIT = 1500;

const INTERVAL_MS = {
  '1h': 3600 * 1000,
  '4h': 4 * 3600 * 1000,
  '1d': 24 * 3600 * 1000,
  '1w': 7 * 24 * 3600 * 1000,
  // Tháng dài không đều: chỉ dùng làm bước phân trang tối thiểu; kiểm gap theo tháng lịch (nextOpenTime)
  '1M': 28 * 24 * 3600 * 1000
};

/** openTime kỳ vọng của nến kế tiếp. Tháng tính theo lịch UTC, các khung khác theo bước cố định. */
export function nextOpenTime(openTime, interval) {
  if (interval === '1M') {
    const d = new Date(openTime);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return openTime + intervalMs(interval);
}

export function intervalMs(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) throw new Error(`Unsupported interval: ${interval}`);
  return ms;
}

// Thứ tự field cố định để JSONL (và checksum) không phụ thuộc thứ tự key.
const FIELDS = ['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'trades', 'takerBuyBase', 'takerBuyQuote'];

export function normalizeKline(k) {
  if (!Array.isArray(k) || k.length < 11) return null;
  const row = {
    openTime: Number(k[0]),
    closeTime: Number(k[6]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
    takerBuyBase: Number(k[9]),
    takerBuyQuote: Number(k[10])
  };
  return FIELDS.every((f) => Number.isFinite(row[f])) ? row : null;
}

/** Tải toàn bộ nến trong [startMs, cutoffMs) theo trang. Dừng khi trang rỗng hoặc vượt cutoff. */
export async function fetchKlinesRange({ fetchJson, symbol, interval, startMs, cutoffMs, maxPages = 50 }) {
  const step = intervalMs(interval);
  const raw = [];
  let cursor = startMs;
  for (let page = 0; page < maxPages && cursor < cutoffMs; page += 1) {
    const url = `${FAPI_KLINES}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${cutoffMs - 1}&limit=${PAGE_LIMIT}`;
    const batch = await fetchJson(url);
    if (!Array.isArray(batch) || !batch.length) break;
    raw.push(...batch);
    const lastOpen = Number(batch[batch.length - 1][0]);
    if (!Number.isFinite(lastOpen) || lastOpen + step <= cursor) break;
    cursor = lastOpen + step;
    if (batch.length < PAGE_LIMIT) break;
  }
  return raw;
}

function sameValues(a, b) {
  return FIELDS.every((f) => a[f] === b[f]);
}

/**
 * Lọc nến đã đóng trước cutoff, sắp xếp, gộp trùng giống hệt, báo conflict và gap.
 * Không xoá hay nội suy nến; gap chỉ được liệt kê.
 */
export function buildSeries(rawKlines, { interval, cutoffMs }) {
  intervalMs(interval);
  const byOpen = new Map();
  const conflicts = [];
  let duplicatesDropped = 0;
  let invalidRows = 0;
  for (const k of rawKlines) {
    const row = normalizeKline(k);
    if (!row) {
      invalidRows += 1;
      continue;
    }
    if (row.closeTime >= cutoffMs) continue;
    const prev = byOpen.get(row.openTime);
    if (!prev) {
      byOpen.set(row.openTime, row);
    } else if (sameValues(prev, row)) {
      duplicatesDropped += 1;
    } else {
      conflicts.push({ openTime: row.openTime, first: prev, second: row });
    }
  }
  const rows = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const expected = nextOpenTime(rows[i - 1].openTime, interval);
    if (rows[i].openTime !== expected) {
      let missingBars = 0;
      let last = expected;
      for (let t = expected; t < rows[i].openTime; t = nextOpenTime(t, interval)) {
        missingBars += 1;
        last = t;
      }
      gaps.push({ from: expected, to: last, missingBars });
    }
  }
  return { rows, gaps, conflicts, duplicatesDropped, invalidRows };
}

export function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, r[f]])))).join('\n') + (rows.length ? '\n' : '');
}

export function parseJsonl(text) {
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function buildManifest({ symbol, interval, cutoffMs, series, jsonl, fetchedAt }) {
  const { rows, gaps, conflicts, duplicatesDropped, invalidRows } = series;
  return {
    version: DATASET_VERSION,
    source: FAPI_KLINES,
    instrument: { venue: 'binance-usdm', symbol, contractType: 'PERPETUAL' },
    interval,
    cutoffUtc: new Date(cutoffMs).toISOString(),
    firstOpenTimeUtc: rows.length ? new Date(rows[0].openTime).toISOString() : null,
    lastOpenTimeUtc: rows.length ? new Date(rows[rows.length - 1].openTime).toISOString() : null,
    rows: rows.length,
    gaps,
    duplicatesDropped,
    invalidRows,
    conflicts: conflicts.length,
    fields: FIELDS,
    sha256: sha256(jsonl),
    fetchedAt
  };
}

export function datasetBaseName(symbol, interval, cutoffMs) {
  return `${symbol}-${interval}-cutoff-${new Date(cutoffMs).toISOString().slice(0, 10)}`;
}
