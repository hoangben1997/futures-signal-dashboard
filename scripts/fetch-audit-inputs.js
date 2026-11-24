#!/usr/bin/env node
/**
 * Lấy và đóng băng đầu vào lịch sử cho dashboard audit (docs/AUDIT_SPEC.md §3):
 * - funding: REST fapi/v1/fundingRate, phân trang
 * - Fear & Greed: api.alternative.me/fng/?limit=0
 * - metrics 5m (OI, L/S): data.binance.vision daily zip (quy tắc nạp theo docs/P1_ARCHIVE_CHECK.md:
 *   bỏ dòng trùng giống hệt, sort, "" → null, cảnh báo conflict)
 *
 *   node scripts/fetch-audit-inputs.js --cutoff 2026-11-24
 *
 * Ghi data/datasets/<name>-cutoff-<date>.jsonl + .manifest.json (sha256). Zip thô lưu ở
 * data/raw/binance-metrics/ và chỉ được đọc qua `unzip -p`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'datasets');
const RAW = join(ROOT, 'data', 'raw', 'binance-metrics');
const DAY = 86400000;
const SYMBOL = 'BTCUSDT';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'futures-signal-dashboard/audit' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return res.json();
}

async function writeDataset(name, cutoffMs, rows, extra = {}) {
  const base = join(OUT, `${name}-cutoff-${new Date(cutoffMs).toISOString().slice(0, 10)}`);
  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const digest = sha256(jsonl);
  if (existsSync(`${base}.jsonl`)) {
    const prev = sha256(await readFile(`${base}.jsonl`, 'utf8'));
    if (prev === digest) {
      console.log(`Không đổi: ${name} (${rows.length} dòng, sha256 ${digest.slice(0, 12)}…)`);
      return;
    }
    throw new Error(`${name}: dữ liệu tải lại khác file đã có (${prev.slice(0, 12)}… → ${digest.slice(0, 12)}…), không ghi đè`);
  }
  await writeFile(`${base}.jsonl`, jsonl);
  await writeFile(`${base}.manifest.json`, `${JSON.stringify({ name, cutoffUtc: new Date(cutoffMs).toISOString(), rows: rows.length, sha256: digest, fetchedAt: new Date().toISOString(), ...extra }, null, 2)}\n`);
  console.log(`Đã ghi ${name}: ${rows.length} dòng, sha256 ${digest.slice(0, 12)}…`, JSON.stringify(extra.summary || {}));
}

async function funding(cutoffMs) {
  const rows = [];
  let cursor = Date.UTC(2019, 8, 1);
  for (let page = 0; page < 20 && cursor < cutoffMs; page += 1) {
    const batch = await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&startTime=${cursor}&endTime=${cutoffMs - 1}&limit=1000`);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const x of batch) rows.push({ fundingTime: Number(x.fundingTime), fundingRate: Number(x.fundingRate) });
    cursor = Number(batch[batch.length - 1].fundingTime) + 1;
    if (batch.length < 1000) break;
  }
  const seen = new Set();
  const out = rows.filter((r) => r.fundingTime < cutoffMs && Number.isFinite(r.fundingRate) && !seen.has(r.fundingTime) && seen.add(r.fundingTime))
    .sort((a, b) => a.fundingTime - b.fundingTime);
  await writeDataset(`${SYMBOL}-funding`, cutoffMs, out, {
    source: 'https://fapi.binance.com/fapi/v1/fundingRate',
    summary: { first: new Date(out[0].fundingTime).toISOString(), last: new Date(out.at(-1).fundingTime).toISOString() }
  });
}

async function fearGreed(cutoffMs) {
  const res = await getJson('https://api.alternative.me/fng/?limit=0&format=json');
  const out = (res.data || [])
    .map((x) => ({ timestamp: Number(x.timestamp) * 1000, value: Number(x.value) }))
    .filter((r) => r.timestamp < cutoffMs && Number.isFinite(r.value))
    .sort((a, b) => a.timestamp - b.timestamp);
  await writeDataset('FNG', cutoffMs, out, {
    source: 'https://api.alternative.me/fng/?limit=0',
    summary: { first: new Date(out[0].timestamp).toISOString(), last: new Date(out.at(-1).timestamp).toISOString() }
  });
}

const numOrNull = (v) => {
  if (v === undefined || v === '' || v === '""') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function metrics(cutoffMs) {
  await mkdir(RAW, { recursive: true });
  const days = [];
  for (let t = Date.UTC(2020, 8, 1); t < cutoffMs; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  const queue = [...days];
  const missingFiles = [];
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (queue.length) {
      const d = queue.shift();
      const p = join(RAW, `${d}.zip`);
      if (existsSync(p)) continue;
      const r = await fetch(`https://data.binance.vision/data/futures/um/daily/metrics/${SYMBOL}/${SYMBOL}-metrics-${d}.zip`);
      if (!r.ok) {
        missingFiles.push(d);
        continue;
      }
      await writeFile(p, Buffer.from(await r.arrayBuffer()));
    }
  }));
  const byTime = new Map();
  let duplicates = 0;
  let conflicts = 0;
  for (const d of days) {
    const p = join(RAW, `${d}.zip`);
    if (!existsSync(p)) continue;
    const lines = execFileSync('unzip', ['-p', p]).toString().trim().split('\n').slice(1);
    for (const line of lines) {
      const c = line.split(',');
      if (c.length !== 8 || c[1] !== SYMBOL) continue;
      const t = Date.parse(`${c[0].replace(' ', 'T')}Z`);
      if (!Number.isFinite(t) || t >= cutoffMs) continue;
      const row = {
        t,
        oi: numOrNull(c[2]),
        oiValue: numOrNull(c[3]),
        topAcc: numOrNull(c[4]),
        topPos: numOrNull(c[5]),
        globalAcc: numOrNull(c[6]),
        takerEnd: numOrNull(c[7])
      };
      const prev = byTime.get(t);
      if (!prev) byTime.set(t, row);
      else if (JSON.stringify(prev) === JSON.stringify(row)) duplicates += 1;
      else conflicts += 1;
    }
  }
  const out = [...byTime.values()].sort((a, b) => a.t - b.t);
  await writeDataset(`${SYMBOL}-metrics5m`, cutoffMs, out, {
    source: 'https://data.binance.vision/data/futures/um/daily/metrics/',
    note: 'takerEnd: archive gắn nhãn theo thời điểm KẾT THÚC cửa sổ 5 phút (docs/P1_ARCHIVE_CHECK.md)',
    summary: { days: days.length, missingFiles: missingFiles.length, duplicatesDropped: duplicates, conflicts }
  });
}

async function main() {
  const i = process.argv.indexOf('--cutoff');
  const cutoff = process.argv[i + 1];
  if (i < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff || '')) throw new Error('Cần --cutoff YYYY-MM-DD');
  const cutoffMs = Date.parse(`${cutoff}T00:00:00Z`);
  await mkdir(OUT, { recursive: true });
  await funding(cutoffMs);
  await fearGreed(cutoffMs);
  await metrics(cutoffMs);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
