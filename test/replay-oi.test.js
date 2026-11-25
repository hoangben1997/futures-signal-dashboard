import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachOiCells, runDevelopment, runHoldout, REPLAY_OI_SPEC } from '../lib/replay-oi.js';
import { rng } from '../lib/replay.js';
import { DAY_MS } from '../lib/pit.js';

const H = 3600 * 1000;

test('attachOiCells: OI trước origin (strict) và tại/trước origin − 24h; thiếu hoặc quá cũ thì loại', () => {
  const asOf = Date.UTC(2023, 0, 10);
  const metrics5m = [
    { t: asOf - DAY_MS - (30 * 60 * 1000), oi: 100 },
    { t: asOf - (10 * 60 * 1000), oi: 110 },
    { t: asOf, oi: 999 } // tại origin: không được dùng
  ];
  const obs = [
    { asOf, mom1z: -0.5, label: 'bullish' },
    { asOf: asOf + (5 * DAY_MS), mom1z: 1, label: 'bearish' } // không có OI gần → loại
  ];
  const out = attachOiCells(obs, metrics5m);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].oiChg24 - Math.log(1.1)) < 1e-12);
  assert.equal(out[0].cell, 1); // giá giảm × OI tăng
  assert.equal(obs[0].cell, undefined, 'không đổi input');

  // Snapshot 24h trước cũ hơn 1h → loại
  const stale = [{ t: asOf - DAY_MS - (2 * H), oi: 100 }, { t: asOf - (10 * 60 * 1000), oi: 110 }];
  assert.equal(attachOiCells(obs.slice(0, 1), stale).length, 0);
});

function series(startUtc, endUtc, seed = 3) {
  const r = rng(seed);
  const labels = ['bullish', 'sideways', 'bearish'];
  const out = [];
  for (let t = Date.parse(startUtc); t < Date.parse(endUtc); t += DAY_MS) {
    const o = { originOpenTime: t, asOf: t + DAY_MS, knownAt: t + (2 * DAY_MS), label: labels[Math.floor(r() * 3)], mom1z: r() - 0.5, oiChg24: r() - 0.5 };
    o.cell = (o.mom1z >= 0 ? 2 : 0) + (o.oiChg24 >= 0 ? 1 : 0);
    out.push(o);
  }
  return out;
}

test('runDevelopment: expanding → M0 ≡ B2, cần ≥ 730 ngày lịch sử, không có origin holdout', () => {
  const obs = series('2020-09-02', '2026-11-20');
  const { predictions, folds } = runDevelopment(obs);
  const holdout = Date.parse(REPLAY_OI_SPEC.holdoutStartUtc);
  assert.ok(predictions.every((p) => p.originOpenTime < holdout));
  assert.ok(predictions.every((p) => JSON.stringify(p.p.M0) === JSON.stringify(p.p.B2)));
  assert.ok(Date.parse(folds[0].cutoff) >= Date.parse('2020-09-02') + (730 * DAY_MS));
  // expanding: train của fold sau lớn hơn fold trước
  assert.ok(folds[folds.length - 1].trainSize > folds[0].trainSize);
});

test('runHoldout: chỉ trả dự báo origin ≥ holdout; train chỉ dùng nhãn đã biết tại cutoff', () => {
  const obs = series('2020-09-02', '2026-11-20');
  const { predictions, folds } = runHoldout(obs);
  const holdout = Date.parse(REPLAY_OI_SPEC.holdoutStartUtc);
  assert.ok(predictions.length > 300);
  assert.ok(predictions.every((p) => p.originOpenTime >= holdout));
  for (const f of folds) assert.ok(Date.parse(f.maxTrainKnownAt) <= Date.parse(f.cutoff));
});
