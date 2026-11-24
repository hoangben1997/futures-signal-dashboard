/**
 * Một chu kỳ shadow forward: đọc ledger, lấy giờ sàn, nếu có việc thì tải nến ngày đã đóng,
 * phát hành / đánh dấu bỏ lỡ / chấm kết quả, rồi append vào ledger.
 * Một writer: khoá bằng file `.lock` (tạo độc quyền); lock quá 10 phút coi là treo và được gỡ.
 */
import { appendFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DAY_MS } from './pit.js';
import { buildSeries, fetchKlinesRange } from './dataset.js';
import {
  buildForecast,
  indexLedger,
  ledgerStatus,
  parseLedger,
  planCycle,
  resolveOutcome,
  SHADOW_SPEC
} from './shadow.js';

const LOCK_STALE_MS = 10 * 60 * 1000;
const HISTORY_START = Date.UTC(2019, 0, 1);
const TIME_URL = 'https://fapi.binance.com/fapi/v1/time';

export function ledgerPath(dir, symbol) {
  return join(dir, `${symbol}-1d-shadow.jsonl`);
}

async function acquireLock(dir) {
  const lockFile = join(dir, '.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fh = await open(lockFile, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return async () => rm(lockFile, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const info = await stat(lockFile).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockFile, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function loadLedger(dir, symbol) {
  const text = await readFile(ledgerPath(dir, symbol), 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  const parsed = parseLedger(text);
  return { text, ...parsed, idx: indexLedger(parsed.records) };
}

async function appendRecords(dir, symbol, text, records) {
  if (!records.length) return;
  // Dòng cuối dở dang (crash lúc ghi) được tách riêng bằng một newline để không dính vào bản ghi mới
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  await appendFile(ledgerPath(dir, symbol), prefix + records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * fetchJson(url) → JSON. dir = thư mục ledger (vd. data/shadow).
 * Trả { skipped } hoặc { actions, written, status, clockOffsetMs }.
 */
export async function runShadowCycle({ fetchJson, dir, symbol = 'BTCUSDT', localNow = () => Date.now() }) {
  await mkdir(dir, { recursive: true });
  const release = await acquireLock(dir);
  if (!release) return { skipped: 'locked' };
  try {
    const ledger = await loadLedger(dir, symbol);
    const local = localNow();
    const serverTime = Number((await fetchJson(TIME_URL))?.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error('Không lấy được giờ sàn');
    const clockOffsetMs = serverTime - local;
    const todayOpen = Math.floor(serverTime / DAY_MS) * DAY_MS;

    // Kế hoạch sơ bộ theo đồng hồ sàn; không có việc thì không tải nến
    const expectedLatest = todayOpen - DAY_MS;
    const prelim = planCycle({ idx: ledger.idx, symbol, latestClosedOpen: expectedLatest, nowMs: serverTime });
    if (!prelim.length) {
      return { actions: [], written: 0, clockOffsetMs, status: ledgerStatus(ledger.idx, { latestClosedOpen: expectedLatest }), partialTail: ledger.partialTail };
    }

    // Watermark = nến ngày đã đóng gần nhất mà sàn trả về (không dựa vào đồng hồ máy)
    const raw = await fetchKlinesRange({ fetchJson, symbol, interval: '1d', startMs: HISTORY_START, cutoffMs: todayOpen });
    const { rows: bars } = buildSeries(raw, { interval: '1d', cutoffMs: todayOpen });
    if (!bars.length) throw new Error('Không có nến ngày đã đóng');
    const latestClosedOpen = bars[bars.length - 1].openTime;
    const actions = planCycle({ idx: ledger.idx, symbol, latestClosedOpen, nowMs: serverTime });

    const records = [];
    for (const a of actions) {
      if (a.type === 'start') {
        records.push({ type: 'start', symbol, firstOrigin: new Date(a.firstOrigin).toISOString(), startedAt: new Date(serverTime).toISOString(), version: SHADOW_SPEC.version });
      } else if (a.type === 'issue') {
        const f = buildForecast({ symbol, bars, originOpenTime: a.originOpenTime, issuedAtMs: serverTime });
        if (f) records.push({ ...f, clockOffsetMs });
        else records.push({ type: 'missed', id: a.id, originOpenTime: new Date(a.originOpenTime).toISOString(), reason: 'origin_bar_missing', recordedAt: new Date(serverTime).toISOString() });
      } else if (a.type === 'missed') {
        records.push({ type: 'missed', id: a.id, originOpenTime: new Date(a.originOpenTime).toISOString(), reason: 'not_issued_before_target_known', recordedAt: new Date(serverTime).toISOString() });
      } else if (a.type === 'resolve') {
        const o = resolveOutcome(ledger.idx.forecasts.get(a.id), bars, serverTime);
        if (o) records.push(o);
      }
    }
    await appendRecords(dir, symbol, ledger.text, records);

    const after = await loadLedger(dir, symbol);
    return {
      actions: actions.map((a) => a.type),
      written: records.length,
      clockOffsetMs,
      status: ledgerStatus(after.idx, { latestClosedOpen }),
      partialTail: ledger.partialTail
    };
  } finally {
    await release();
  }
}
