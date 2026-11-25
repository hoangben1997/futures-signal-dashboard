import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sma,
  ema,
  rsi,
  macd,
  findSwings,
  classifyStructure,
  fibRetracement,
  summarizeTimeframe,
  klinesToCandles
} from '../lib/indicators.js';

const near = (actual, expected, eps = 0.01) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected} (±${eps})`);
};

test('sma: trả null khi chưa đủ dữ liệu, reset khi gặp null', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(sma([null, 2, 4, null, 6, 8], 2), [null, null, 3, null, null, 7]);
});

test('ema: khởi tạo bằng SMA của `period` giá trị đầu', () => {
  // seed = (1+2+3)/3 = 2, k = 0.5 → 4*0.5+2*0.5 = 3 → 5*0.5+3*0.5 = 4
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('rsi: Wilder, tính tay với period 2', () => {
  // thay đổi +1, +1, -1 → seed avgUp=1, avgDown=0 → 100; sau đó avgUp=0.5, avgDown=0.5 → 50
  assert.deepEqual(rsi([1, 2, 3, 2], 2), [null, null, 100, 50]);
});

test('macd: hist = line − signal, null cho tới khi đủ slow + signal − 1 nến', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const m = macd(closes);
  assert.equal(m.line[24], null);
  assert.notEqual(m.line[25], null);
  assert.equal(m.signal[32], null);
  assert.notEqual(m.signal[33], null);
  near(m.hist[59], m.line[59] - m.signal[59], 1e-9);
});

test('khớp TradingView: ETHUSDT spot khung D lúc giá 1697.32', () => {
  // Số đọc từ bảng Pine (ta.sma/ta.rsi/ta.macd) trên TradingView Desktop ngày 2026-11-24.
  const { closes } = JSON.parse(readFileSync(new URL('./fixtures/ethusdt-1d-closes.json', import.meta.url)));
  const last = (arr) => arr[arr.length - 1];
  near(last(sma(closes, 50)), 2208.02);
  near(last(sma(closes, 100)), 2363.12);
  near(last(sma(closes, 200)), 2117.95);
  const r = rsi(closes, 14);
  near(last(r), 28.62);
  near(last(sma(r, 14)), 25.68);
  const m = macd(closes);
  near(last(m.line), -161.59, 0.01);
  near(last(m.signal), -155.0, 0.01);
  near(last(m.hist), -6.6, 0.01);
});

function candlesFromLows(lows, highs) {
  return lows.map((low, i) => ({
    time: i * 1000,
    open: (low + highs[i]) / 2,
    high: highs[i],
    low,
    close: (low + highs[i]) / 2,
    volume: 100
  }));
}

test('findSwings + classifyStructure: nhận diện LH/LL và phá cấu trúc', () => {
  //            0    1    2    3    4    5    6    7    8    9   10   11   12
  const highs = [10, 12, 15, 12, 11, 12, 13, 12, 11, 10, 9, 10, 9];
  const lows = [8, 9, 11, 9, 7, 8, 10, 9, 8, 6, 5, 7, 6];
  const candles = candlesFromLows(lows, highs);
  const sw = findSwings(candles, 2);
  assert.deepEqual(sw.highs.map((s) => s.price), [15, 13]);
  assert.deepEqual(sw.lows.map((s) => s.price), [7, 5]);

  const s = classifyStructure(sw, 6);
  assert.equal(s.highs, 'LH');
  assert.equal(s.lows, 'LL');
  assert.equal(s.state, 'bearish');
  assert.equal(s.broken, null);

  // Cấu trúc HH/HL nhưng nến đóng thủng đáy xác nhận gần nhất → bearish, broken down
  const bullishSwings = { highs: [{ price: 10 }, { price: 12 }], lows: [{ price: 8 }, { price: 9 }] };
  assert.equal(classifyStructure(bullishSwings, 10).state, 'bullish');
  const broken = classifyStructure(bullishSwings, 8.5);
  assert.equal(broken.state, 'bearish');
  assert.equal(broken.broken, 'down');
});

test('fibRetracement: đỉnh trước đáy → đo hồi lên từ đáy', () => {
  const candles = [
    { time: 1, high: 200, low: 190 },
    { time: 2, high: 180, low: 150 },
    { time: 3, high: 120, low: 100 },
    { time: 4, high: 130, low: 110 }
  ];
  const fib = fibRetracement(candles, 10);
  assert.equal(fib.direction, 'down');
  assert.equal(fib.levels.find((l) => l.ratio === 0.5).price, 150);
  assert.equal(fib.levels.find((l) => l.ratio === 0.236).price, 123.6);
});

test('klinesToCandles: đếm nến đã đóng theo closeTime', () => {
  const now = 10_000;
  const k = [
    [0, '1', '2', '0.5', '1.5', '10', 4999],
    [5000, '1.5', '3', '1', '2', '12', 9999],
    [10000, '2', '2.5', '1.8', '2.2', '3', 14999]
  ];
  const { candles, closedCount } = klinesToCandles(k, now);
  assert.equal(candles.length, 3);
  assert.equal(closedCount, 2);
});

test('summarizeTimeframe: nến đóng gần nhất bỏ qua nến đang chạy', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    time: i, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10
  }));
  candles.push({ time: 30, open: 131, high: 140, low: 120, close: 125, volume: 1 });
  const s = summarizeTimeframe(candles, { closedCount: 30 });
  assert.equal(s.price, 125);
  assert.equal(s.lastClosedCandle.close, 130);
  assert.equal(s.ma50, null);
  assert.equal(s.stack, 'unknown');
  assert.equal(s.lastClosedVolRatio, 1);
});
