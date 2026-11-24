#!/usr/bin/env node
/**
 * Chạy dashboard audit (docs/AUDIT_SPEC.md) trên dữ liệu thật đã đóng băng.
 *
 *   node scripts/run-audit.js [--cutoff 2026-11-24]
 *
 * Cần các dataset trong data/datasets/ (scripts/build-dataset.js cho 1h/4h/1d/1w/1M,
 * scripts/fetch-audit-inputs.js cho funding/FNG/metrics5m). Ghi report vào data/reports/.
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonl, sha256 } from '../lib/dataset.js';
import { runAudit, evaluateAll, AUDIT_SPEC } from '../lib/audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DS = join(ROOT, 'data', 'datasets');

async function load(name, cutoff) {
  const path = join(DS, `${name}-cutoff-${cutoff}.jsonl`);
  const text = await readFile(path, 'utf8');
  const manifest = JSON.parse(await readFile(path.replace(/\.jsonl$/, '.manifest.json'), 'utf8'));
  const digest = sha256(text);
  if (digest !== manifest.sha256) throw new Error(`${name}: sha256 không khớp manifest`);
  return { rows: parseJsonl(text), sha256: digest };
}

const f = (v, d = 3) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
const pct = (v) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);

async function main() {
  const i = process.argv.indexOf('--cutoff');
  const cutoff = i >= 0 ? process.argv[i + 1] : '2026-11-24';
  const inputs = {};
  const shas = {};
  for (const [key, name] of [['1h', 'BTCUSDT-1h'], ['4h', 'BTCUSDT-4h'], ['1d', 'BTCUSDT-1d'], ['1w', 'BTCUSDT-1w'], ['1M', 'BTCUSDT-1M'],
    ['funding', 'BTCUSDT-funding'], ['fng', 'FNG'], ['metrics5m', 'BTCUSDT-metrics5m']]) {
    const d = await load(name, cutoff);
    inputs[key] = d.rows;
    shas[name] = d.sha256;
  }
  const data = {
    bars: { '1h': inputs['1h'], '4h': inputs['4h'], '1d': inputs['1d'], '1w': inputs['1w'], '1M': inputs['1M'] },
    funding: inputs.funding,
    fng: inputs.fng,
    metrics5m: inputs.metrics5m
  };

  const t0 = Date.now();
  const rows = runAudit(data, AUDIT_SPEC);
  const result = evaluateAll(rows, AUDIT_SPEC);
  const coverage = Object.fromEntries(Object.keys(rows[0].inputsPresent).map((k) => [k, rows.filter((r) => r.inputsPresent[k]).length / rows.length]));

  const report = { version: AUDIT_SPEC.version, spec: AUDIT_SPEC, datasets: shas, origins: rows.length, inputCoverage: coverage, ...result };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(join(ROOT, 'data', 'reports'), { recursive: true });
  const out = join(ROOT, 'data', 'reports', `${AUDIT_SPEC.version}.json`);
  await writeFile(out, json);
  await writeFile(join(ROOT, 'data', 'reports', `${AUDIT_SPEC.version}-rows.json`), JSON.stringify(rows));
  await appendFile(join(ROOT, 'data', 'reports', 'experiments.jsonl'), `${JSON.stringify({ runAt: new Date().toISOString(), version: AUDIT_SPEC.version, reportSha256: sha256(json), origins: rows.length })}\n`);

  console.log(`${rows.length} origin (discovery ${result.periods.discovery}, confirmation ${result.periods.confirmation}) · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`Độ phủ đầu vào: ${Object.entries(coverage).map(([k, v]) => `${k} ${pct(v)}`).join(' · ')}`);
  console.log('\nTín hiệu                 | kích hoạt D/C | edge D [CI95]             | edge C  | edge toàn kỳ | quyết định');
  for (const [key, v] of Object.entries(result.signals)) {
    const d = v.discovery;
    const c = v.confirmation;
    console.log(`${key.padEnd(24)} | ${String(d.fired).padStart(4)}/${String(c.fired).padEnd(4)}     | ${f(d.edge).padStart(6)} [${f(d.ci?.lower)}, ${f(d.ci?.upper)}] | ${f(c.edge).padStart(6)}  | ${f(v.all.edge).padStart(6)}       | ${v.decision}`);
  }
  console.log(`\nReport: ${out} (sha256 ${sha256(json).slice(0, 12)}…)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
