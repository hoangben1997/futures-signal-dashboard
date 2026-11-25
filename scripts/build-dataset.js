#!/usr/bin/env node
/**
 * Tải và đóng băng dataset nến (docs/P1_SPEC.md §1).
 *
 *   node scripts/build-dataset.js --symbol BTCUSDT --interval 1d --cutoff 2026-11-24
 *
 * Ghi data/datasets/<SYMBOL>-<interval>-cutoff-<date>.jsonl + .manifest.json.
 * Có conflict thì dừng, không ghi. File đã tồn tại với checksum khác thì báo và không ghi đè.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchKlinesRange,
  buildSeries,
  toJsonl,
  buildManifest,
  datasetBaseName,
  sha256
} from '../lib/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Ngày niêm yết BTCUSDT perpetual; bắt đầu sớm hơn cũng được vì API chỉ trả nến có thật.
const DEFAULT_START = Date.UTC(2019, 0, 1);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'futures-signal-dashboard/dataset' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = args.symbol || 'BTCUSDT';
  const interval = args.interval || '1d';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.cutoff || '')) {
    throw new Error('Cần --cutoff YYYY-MM-DD (mốc 00:00 UTC, chỉ lấy nến đóng trước mốc này)');
  }
  const cutoffMs = Date.parse(`${args.cutoff}T00:00:00Z`);
  if (cutoffMs > Date.now()) throw new Error('Cutoff nằm trong tương lai');

  const raw = await fetchKlinesRange({ fetchJson, symbol, interval, startMs: DEFAULT_START, cutoffMs });
  const series = buildSeries(raw, { interval, cutoffMs });
  if (series.conflicts.length) {
    console.error(JSON.stringify(series.conflicts.slice(0, 5), null, 2));
    throw new Error(`${series.conflicts.length} openTime trùng nhưng khác giá trị: dừng, không ghi file`);
  }

  const jsonl = toJsonl(series.rows);
  const manifest = buildManifest({ symbol, interval, cutoffMs, series, jsonl, fetchedAt: new Date().toISOString() });
  const dir = join(ROOT, 'data', 'datasets');
  const base = join(dir, datasetBaseName(symbol, interval, cutoffMs));
  const dataPath = `${base}.jsonl`;

  if (existsSync(dataPath)) {
    const existing = sha256(await readFile(dataPath, 'utf8'));
    if (existing === manifest.sha256) {
      console.log(`Không đổi: ${dataPath} (sha256 ${existing.slice(0, 12)}…)`);
      return;
    }
    throw new Error(`Dữ liệu tải lại khác file đã có (${existing.slice(0, 12)}… → ${manifest.sha256.slice(0, 12)}…). Không ghi đè; kiểm tra nguồn trước.`);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(dataPath, jsonl);
  await writeFile(`${base}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Đã ghi ${manifest.rows} nến ${manifest.firstOpenTimeUtc} → ${manifest.lastOpenTimeUtc}`);
  console.log(`gaps=${manifest.gaps.length} duplicatesDropped=${manifest.duplicatesDropped} invalidRows=${manifest.invalidRows} sha256=${manifest.sha256}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
