#!/usr/bin/env node
/**
 * Shadow forward CLI (cùng ledger với timer trong server, có lock nên chạy song song an toàn).
 *
 *   node scripts/shadow.js status   # lịch so với đã phát hành / trễ / bỏ lỡ / đã chấm, điểm trên dự báo đúng hạn
 *   node scripts/shadow.js run      # chạy một chu kỳ ngay
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShadowCycle, loadLedger } from '../lib/shadow-runner.js';
import { ledgerStatus } from '../lib/shadow.js';
import { DAY_MS } from '../lib/pit.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'shadow');
const SYMBOL = 'BTCUSDT';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'futures-signal-dashboard/shadow' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return res.json();
}

function printStatus(s, extra = {}) {
  console.log(JSON.stringify({ ...extra, ...s }, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v), 2));
  if (s.scoredOnTime < 30) {
    console.log(`Mới có ${s.scoredOnTime} dự báo đúng hạn đã chấm: chưa đủ để kết luận gì.`);
  }
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'run') {
    const r = await runShadowCycle({ fetchJson, dir: DIR, symbol: SYMBOL });
    if (r.skipped) {
      console.log(`Bỏ qua: ${r.skipped} (một tiến trình khác đang chạy chu kỳ)`);
      return;
    }
    console.log(`Hành động: ${r.actions.join(', ') || 'không có'} · ghi ${r.written} bản ghi · lệch đồng hồ ${r.clockOffsetMs} ms`);
    printStatus(r.status);
    return;
  }
  if (cmd === 'status') {
    const { idx, partialTail, corruptLines } = await loadLedger(DIR, SYMBOL);
    const latestClosedOpen = (Math.floor(Date.now() / DAY_MS) * DAY_MS) - DAY_MS;
    printStatus(ledgerStatus(idx, { latestClosedOpen }), { partialTail, corruptLines });
    return;
  }
  throw new Error(`Lệnh không hỗ trợ: ${cmd} (dùng status | run)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
