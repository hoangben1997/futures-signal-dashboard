#!/usr/bin/env node
/**
 * Chạy replay walk-forward replay-v1 (docs/P1_SPEC.md §7) trên dataset đã đóng băng.
 *
 *   node scripts/run-replay.js --dataset data/datasets/BTCUSDT-1d-cutoff-2026-11-24.jsonl
 *
 * Kiểm sha256 dataset khớp manifest. Ghi report (nội dung tái lập, không có timestamp chạy)
 * vào data/reports/<version>-<sha12>.json và nối một dòng vào data/reports/experiments.jsonl.
 * Holdout bị loại trong lib/replay.js; script này không có cờ nào để chạy holdout.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonl, sha256 } from '../lib/dataset.js';
import { buildObservations, runReplay, summarize, REPLAY_SPEC, SPEC_VERSIONS } from '../lib/replay.js';
import { SPEC } from '../lib/pit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(2)}%`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataset) throw new Error('Cần --dataset <file .jsonl>');
  const dataPath = resolve(args.dataset);
  const text = await readFile(dataPath, 'utf8');
  const manifest = JSON.parse(await readFile(dataPath.replace(/\.jsonl$/, '.manifest.json'), 'utf8'));
  const digest = sha256(text);
  if (digest !== manifest.sha256) throw new Error(`sha256 dataset (${digest}) không khớp manifest (${manifest.sha256})`);

  const bars = parseJsonl(text);
  const observations = buildObservations(bars);
  const { predictions, folds } = runReplay(observations, REPLAY_SPEC);
  const summary = summarize(predictions, folds, REPLAY_SPEC);

  const report = {
    versions: SPEC_VERSIONS,
    spec: { replay: REPLAY_SPEC, pit: SPEC },
    dataset: { file: manifest && dataPath.split('/').pop(), sha256: digest, rows: manifest.rows, cutoffUtc: manifest.cutoffUtc },
    observations: observations.length,
    summary,
    folds
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const dir = join(ROOT, 'data', 'reports');
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, `${REPLAY_SPEC.version}-${digest.slice(0, 12)}.json`);
  await writeFile(reportPath, reportJson);
  await appendFile(join(dir, 'experiments.jsonl'), `${JSON.stringify({
    runAt: new Date().toISOString(),
    versions: SPEC_VERSIONS,
    datasetSha256: digest,
    reportSha256: sha256(reportJson),
    n: summary.n,
    bssM1: summary.byModel.M1.bssVsM0,
    ciM1: summary.ci.M1[`block${REPLAY_SPEC.bootstrap.blockLength}`],
    gatePassed: summary.gate.passed
  })}\n`);

  const s = summary;
  console.log(`Dataset ${manifest.rows} nến, ${observations.length} origin hợp lệ; test ${s.n} origin (${s.firstOrigin} → ${s.lastOrigin}), ${s.folds} fold tháng`);
  console.log(`Tỷ lệ lớp trong tập test: tăng ${pct(s.baseRates.bullish)} · ngang ${pct(s.baseRates.sideways)} · giảm ${pct(s.baseRates.bearish)}`);
  console.log('Mô hình   Brier    LogLoss  BSS vs M0');
  for (const [m, v] of Object.entries(s.byModel)) {
    console.log(`${m.padEnd(8)} ${v.brier.toFixed(4)}   ${v.logLoss.toFixed(4)}   ${pct(v.bssVsM0)}`);
  }
  for (const m of ['M1', 'NULL', 'B2']) {
    console.log(`CI90 BSS ${m}: ${Object.entries(s.ci[m]).map(([k, v]) => `${k} [${pct(v.lower)}, ${pct(v.upper)}]`).join(' · ')}`);
  }
  console.log(`α được chọn: ${JSON.stringify(s.alphaCounts)}`);
  console.log(`BSS M1 theo năm: ${s.byYear.map((y) => `${y.year} (n=${y.n}) ${pct(y.bssM1)}`).join(' · ')}`);
  console.log(`ECE M1: ${JSON.stringify(s.ece.M1)} · ECE M0: ${JSON.stringify(s.ece.M0)}`);
  console.log(`Phân bố p M1: ${JSON.stringify(s.m1Distribution)}`);
  console.log(`Cổng: ${JSON.stringify(s.gate)}`);
  console.log(`Report: ${reportPath} (sha256 ${sha256(reportJson).slice(0, 12)}…)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
