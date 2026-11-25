#!/usr/bin/env node
/**
 * Chạy replay-v2-oi (docs/P1_SPEC.md §9).
 *
 *   node scripts/run-replay-oi.js [--cutoff 2026-11-24]
 *
 * Giai đoạn phát triển trước; CHỈ khi qua cổng mới chạy holdout (một lần, ghi lại dù kết quả ra sao).
 * Holdout đã chạy rồi thì script từ chối chạy lại.
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonl, sha256 } from '../lib/dataset.js';
import { buildObservations, summarize } from '../lib/replay.js';
import { attachOiCells, runDevelopment, runHoldout, REPLAY_OI_SPEC } from '../lib/replay-oi.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pct = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(2)}%`);

async function load(name, cutoff) {
  const path = join(ROOT, 'data', 'datasets', `${name}-cutoff-${cutoff}.jsonl`);
  const text = await readFile(path, 'utf8');
  const manifest = JSON.parse(await readFile(path.replace(/\.jsonl$/, '.manifest.json'), 'utf8'));
  if (sha256(text) !== manifest.sha256) throw new Error(`${name}: sha256 không khớp manifest`);
  return { rows: parseJsonl(text), sha256: manifest.sha256 };
}

function printSummary(title, s) {
  console.log(`\n== ${title}: ${s.n} origin (${s.firstOrigin} → ${s.lastOrigin}), ${s.folds} fold`);
  console.log(`Tỷ lệ lớp: tăng ${pct(s.baseRates.bullish)} · ngang ${pct(s.baseRates.sideways)} · giảm ${pct(s.baseRates.bearish)}`);
  for (const [m, v] of Object.entries(s.byModel)) {
    if (m === 'M0') continue; // expanding: M0 ≡ B2
    console.log(`${m.padEnd(5)} Brier ${v.brier.toFixed(4)} · LogLoss ${v.logLoss.toFixed(4)} · BSS vs B2 ${pct(v.bssVsM0)}`);
  }
  console.log(`CI90 BSS M1: ${Object.entries(s.ci.M1).map(([k, v]) => `${k} [${pct(v.lower)}, ${pct(v.upper)}]`).join(' · ')}`);
  console.log(`CI90 BSS NULL: ${Object.entries(s.ci.NULL).map(([k, v]) => `${k} [${pct(v.lower)}, ${pct(v.upper)}]`).join(' · ')}`);
  console.log(`α: ${JSON.stringify(s.alphaCounts)} · BSS M1 theo năm: ${s.byYear.map((y) => `${y.year} ${pct(y.bssM1)} (n=${y.n})`).join(' · ')}`);
  console.log(`ECE M1: ${JSON.stringify(s.ece.M1)} · Cổng: ${JSON.stringify(s.gate)}`);
}

async function main() {
  const i = process.argv.indexOf('--cutoff');
  const cutoff = i >= 0 ? process.argv[i + 1] : '2026-11-24';
  const daily = await load('BTCUSDT-1d', cutoff);
  const metrics = await load('BTCUSDT-metrics5m', cutoff);
  const obs = attachOiCells(buildObservations(daily.rows), metrics.rows, REPLAY_OI_SPEC);

  const dev = runDevelopment(obs, REPLAY_OI_SPEC);
  const devSummary = summarize(dev.predictions, dev.folds, REPLAY_OI_SPEC);
  printSummary('Giai đoạn phát triển (thăm dò)', devSummary);

  const dir = join(ROOT, 'data', 'reports');
  await mkdir(dir, { recursive: true });
  const holdoutPath = join(dir, `${REPLAY_OI_SPEC.version}-holdout.json`);
  let holdout = null;
  if (devSummary.gate.passed) {
    if (existsSync(holdoutPath)) throw new Error(`Holdout đã chạy (${holdoutPath}); không chạy lại.`);
    const h = runHoldout(obs, REPLAY_OI_SPEC);
    holdout = summarize(h.predictions, h.folds, REPLAY_OI_SPEC);
    printSummary('HOLDOUT (xác nhận, chạy một lần)', holdout);
    await writeFile(holdoutPath, `${JSON.stringify({ version: REPLAY_OI_SPEC.version, datasets: { daily: daily.sha256, metrics5m: metrics.sha256 }, summary: holdout }, null, 2)}\n`);
  } else {
    console.log('\nKhông qua cổng ở giai đoạn phát triển → không chạy holdout (theo spec).');
  }

  const report = { version: REPLAY_OI_SPEC.version, spec: { ...REPLAY_OI_SPEC, windowDays: 'expanding' }, datasets: { daily: daily.sha256, metrics5m: metrics.sha256 }, observationsWithOi: obs.length, development: devSummary, holdoutRun: Boolean(holdout), folds: dev.folds };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(dir, `${REPLAY_OI_SPEC.version}.json`), json);
  await appendFile(join(dir, 'experiments.jsonl'), `${JSON.stringify({ runAt: new Date().toISOString(), version: REPLAY_OI_SPEC.version, reportSha256: sha256(json), n: devSummary.n, bssM1: devSummary.byModel.M1.bssVsM0, gatePassed: devSummary.gate.passed, holdoutRun: Boolean(holdout), holdoutGate: holdout?.gate ?? null })}\n`);
  console.log(`\nReport: data/reports/${REPLAY_OI_SPEC.version}.json (sha256 ${sha256(json).slice(0, 12)}…)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
