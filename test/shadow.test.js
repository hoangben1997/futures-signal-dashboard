import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS } from '../lib/pit.js';
import { buildObservations, runReplay } from '../lib/replay.js';
import {
  buildForecast,
  forecastId,
  indexLedger,
  parseLedger,
  planCycle,
  resolveOutcome,
  originTimes
} from '../lib/shadow.js';
import { runShadowCycle, loadLedger, ledgerPath } from '../lib/shadow-runner.js';

const T0 = Date.UTC(2021, 0, 1);
const TMP_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-shadow');
after(() => rm(TMP_ROOT, { recursive: true, force: true }));

function makeBars(n, start = T0) {
  const bars = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    close *= Math.exp((0.025 * Math.sin(i * 1.7)) + (0.01 * Math.cos(i * 0.31)));
    const openTime = start + (i * DAY_MS);
    bars.push({ openTime, closeTime: openTime + DAY_MS - 1, open: close * 0.99, high: close * 1.02, low: close * 0.98, close, volume: 10 });
  }
  return bars;
}

function toKline(b) {
  return [b.openTime, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), b.closeTime, '0', 1, '0', '0', '0'];
}

/** Giả lập sàn: giờ sàn điều khiển được, klines trả theo startTime/endTime/limit. */
function mockExchange(allBars, clock) {
  const calls = { time: 0, klines: 0 };
  const fetchJson = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/fapi/v1/time') {
      calls.time += 1;
      return { serverTime: clock.now };
    }
    calls.klines += 1;
    const start = Number(u.searchParams.get('startTime'));
    const end = Number(u.searchParams.get('endTime'));
    const limit = Number(u.searchParams.get('limit'));
    // Sàn chỉ trả nến đã mở trước "bây giờ"
    return allBars.filter((b) => b.openTime >= start && b.openTime <= end && b.openTime <= clock.now).slice(0, limit).map(toKline);
  };
  return { fetchJson, calls };
}

async function freshDir(name) {
  const dir = join(TMP_ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

test('parity: dự báo shadow cho một origin lịch sử = dự báo của replay cùng origin', () => {
  const bars = makeBars(1000);
  const { predictions } = runReplay(buildObservations(bars));
  const pick = predictions[predictions.length - 40];
  const f = buildForecast({ symbol: 'BTCUSDT', bars, originOpenTime: pick.originOpenTime, issuedAtMs: pick.originOpenTime + DAY_MS + 1000 });
  assert.deepEqual(f.probs.M0, pick.p.M0);
  assert.deepEqual(f.probs.B2, pick.p.B2);
  assert.deepEqual(f.probs.M1, pick.p.M1);
  assert.equal(f.late, false);
  assert.equal(f.published, false);
});

test('buildForecast: không dùng nến sau origin; thiếu nến origin → null', () => {
  const bars = makeBars(300);
  const origin = bars[250].openTime;
  const a = buildForecast({ symbol: 'BTCUSDT', bars, originOpenTime: origin, issuedAtMs: origin + DAY_MS });
  const b = buildForecast({ symbol: 'BTCUSDT', bars: bars.slice(0, 251), originOpenTime: origin, issuedAtMs: origin + DAY_MS });
  assert.deepEqual(a, b);
  assert.equal(buildForecast({ symbol: 'BTCUSDT', bars: bars.slice(0, 250), originOpenTime: origin, issuedAtMs: origin + DAY_MS }), null);
});

test('planCycle: đúng hạn / trễ / bỏ lỡ / chấm khi nến target đã đóng', () => {
  const o1 = Date.UTC(2024, 0, 1);
  const idx = indexLedger([{ type: 'start', firstOrigin: new Date(o1).toISOString() }]);
  const latest = o1 + (2 * DAY_MS);
  const now = originTimes(latest).asOf + (5 * 60 * 1000);
  const actions = planCycle({ idx, symbol: 'BTCUSDT', latestClosedOpen: latest, nowMs: now });
  // now = 04/01 00:05. Origin 01/01 và 02/01: nến target (02/01, 03/01) đã đóng → missed. 03/01: target 04/01 còn mở → issue
  assert.deepEqual(actions.map((a) => [a.type, new Date(a.originOpenTime).toISOString().slice(0, 10)]), [
    ['missed', '2024-01-01'], ['missed', '2024-01-02'], ['issue', '2024-01-03']
  ]);

  const f = { type: 'forecast', id: forecastId('BTCUSDT', o1), targetOpenTime: new Date(o1 + DAY_MS).toISOString() };
  const idx2 = indexLedger([{ type: 'start', firstOrigin: new Date(o1).toISOString() }, f]);
  const r = planCycle({ idx: idx2, symbol: 'BTCUSDT', latestClosedOpen: o1, nowMs: now });
  assert.ok(!r.some((a) => a.type === 'resolve'), 'target chưa đóng thì chưa chấm');
  const r2 = planCycle({ idx: idx2, symbol: 'BTCUSDT', latestClosedOpen: o1 + DAY_MS, nowMs: now });
  assert.ok(r2.some((a) => a.type === 'resolve' && a.id === f.id));
});

test('resolveOutcome: phát hành sau khi biết kết quả → invalid', () => {
  const bars = makeBars(300);
  const origin = bars[250].openTime;
  const t = originTimes(origin);
  const good = buildForecast({ symbol: 'BTCUSDT', bars, originOpenTime: origin, issuedAtMs: t.asOf + 1000 });
  const o = resolveOutcome(good, bars, t.targetKnownAt + 1000);
  assert.equal(o.valid, true);
  assert.ok(o.scores.M0.brier >= 0);
  const bad = { ...good, issuedAt: new Date(t.targetKnownAt + 1).toISOString() };
  const ob = resolveOutcome(bad, bars, t.targetKnownAt + 1000);
  assert.equal(ob.valid, false);
  assert.equal(ob.invalidReason, 'issued_after_target_known');
  assert.equal(resolveOutcome(good, bars.slice(0, 251), t.targetKnownAt), null);
});

test('parseLedger: bỏ dòng cuối dở dang, đếm dòng hỏng giữa file, bỏ bản ghi trùng id', () => {
  const text = '{"type":"start","firstOrigin":"2024-01-01T00:00:00.000Z"}\n{"type":"forecast","id":"a"}\nGARBAGE\n{"type":"forecast","id":"a"}\n{"type":"forec';
  const p = parseLedger(text);
  assert.equal(p.partialTail, true);
  assert.equal(p.corruptLines, 1);
  const idx = indexLedger(p.records);
  assert.equal(idx.forecasts.size, 1);
  assert.equal(idx.duplicates, 1);
});

test('runShadowCycle: chạy lần đầu → start + dự báo; chạy lại → không ghi trùng, không tải nến', async () => {
  const dir = await freshDir('first');
  const bars = makeBars(900);
  const clock = { now: bars[800].closeTime + 1 + (10 * 60 * 1000) }; // 10 phút sau khi nến 800 đóng
  const ex = mockExchange(bars, clock);
  const r1 = await runShadowCycle({ fetchJson: ex.fetchJson, dir });
  assert.deepEqual(r1.actions, ['start', 'issue']);
  assert.equal(r1.status.onTime, 1);
  const klinesAfterFirst = ex.calls.klines;

  const r2 = await runShadowCycle({ fetchJson: ex.fetchJson, dir });
  assert.deepEqual(r2.actions, []);
  assert.equal(ex.calls.klines, klinesAfterFirst, 'không có việc thì không tải nến');
  const { idx } = await loadLedger(dir, 'BTCUSDT');
  assert.equal(idx.forecasts.size, 1);
  const f = [...idx.forecasts.values()][0];
  assert.equal(f.originOpenTime, new Date(bars[800].openTime).toISOString());
  assert.ok(Date.parse(f.issuedAt) < Date.parse(f.targetKnownAt));
});

test('runShadowCycle: tắt máy 3 ngày → ghi missed cho origin đã biết kết quả, trễ cho origin còn mở, chấm dự báo cũ', async () => {
  const dir = await freshDir('restart');
  const bars = makeBars(900);
  const clock = { now: bars[800].closeTime + 1 + 60_000 };
  const ex = mockExchange(bars, clock);
  await runShadowCycle({ fetchJson: ex.fetchJson, dir });

  // 3 ngày sau, 2 giờ sau khi nến 803 đóng (quá deadline 1 giờ của origin 803)
  clock.now = bars[803].closeTime + 1 + (2 * 3600 * 1000);
  const r = await runShadowCycle({ fetchJson: ex.fetchJson, dir });
  const s = r.status;
  // origin 801, 802: kết quả đã biết → missed; 803: còn mở nhưng quá deadline → late
  assert.equal(s.missed, 2);
  assert.equal(s.late, 1);
  assert.equal(s.onTime, 1);
  assert.equal(s.scheduled, 4);
  assert.equal(s.resolved, 1, 'dự báo origin 800 đã được chấm');
  assert.equal(s.scoredOnTime, 1);
  assert.ok(s.models.M0.n === 1 && s.models.M0.brier >= 0);
});

test('runShadowCycle: ledger có dòng cuối dở dang vẫn chạy tiếp, bản ghi mới không dính vào dòng hỏng', async () => {
  const dir = await freshDir('partial');
  const bars = makeBars(900);
  const clock = { now: bars[800].closeTime + 1 + 60_000 };
  const ex = mockExchange(bars, clock);
  await runShadowCycle({ fetchJson: ex.fetchJson, dir });
  await appendFile(ledgerPath(dir, 'BTCUSDT'), '{"type":"forecast","id":"crash-');
  clock.now = bars[801].closeTime + 1 + 60_000;
  const r = await runShadowCycle({ fetchJson: ex.fetchJson, dir });
  assert.equal(r.partialTail, true);
  const after = await loadLedger(dir, 'BTCUSDT');
  assert.equal(after.corruptLines, 1, 'dòng hỏng bị cô lập thành một dòng riêng');
  assert.equal(after.partialTail, false);
  assert.equal(after.idx.forecasts.size, 2);
});

test('runShadowCycle: đang có lock → bỏ qua, không ghi', async () => {
  const dir = await freshDir('locked');
  await writeFile(join(dir, '.lock'), '123');
  const bars = makeBars(900);
  const ex = mockExchange(bars, { now: bars[800].closeTime + 1 });
  const r = await runShadowCycle({ fetchJson: ex.fetchJson, dir });
  assert.deepEqual(r, { skipped: 'locked' });
  await assert.rejects(readFile(ledgerPath(dir, 'BTCUSDT')));
});
