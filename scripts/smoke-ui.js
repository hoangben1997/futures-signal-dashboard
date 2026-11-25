#!/usr/bin/env node
/**
 * Smoke test UI thật bằng Chrome headless (DevTools Protocol), dữ liệu thị trường thật.
 * Không nằm trong `npm test` vì cần Chrome + mạng; chạy bằng `npm run smoke`.
 *
 * Kiểm: trang render đủ panel, không có exception JS, không hiện tỷ lệ % chưa kiểm định ở panel
 * kịch bản, đổi symbol / horizon thì cập nhật. Bỏ qua (exit 0) nếu máy không có Chrome.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, server } from '../server.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(port) {
  for (let i = 0; i < 20; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
        let id = 0;
        const pending = new Map();
        const exceptions = [];
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data);
          if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || 'exception');
          if (pending.has(m.id)) {
            pending.get(m.id)(m.result);
            pending.delete(m.id);
          }
        });
        const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
        const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
        return { ws, send, evaluate, exceptions };
      }
    } catch {
      // Chrome chưa sẵn sàng
    }
    await sleep(500);
  }
  throw new Error('Không kết nối được Chrome DevTools');
}

async function waitFor(evaluate, expression, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expression)) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  if (!existsSync(CHROME)) {
    console.log(`Bỏ qua smoke test: không thấy Chrome tại ${CHROME} (đặt CHROME_PATH nếu ở chỗ khác)`);
    return;
  }
  await start(0, '127.0.0.1'); // shadow mặc định tắt khi gọi start() từ code
  const appPort = server.address().port;
  const profile = mkdtempSync(join(ROOT, '.smoke-chrome-'));
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  try {
    const { ws, send, evaluate, exceptions } = await cdp(debugPort);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });

    check('Snapshot đầu tiên render (báo cáo DiSSS)', await waitFor(evaluate, "!!document.querySelector('.analysis__summary')"));
    check('Bảng kỹ thuật đa khung ≥ 4 khung', await evaluate("document.querySelectorAll('#technicals-table tbody tr').length >= 4"));
    const badge = await evaluate("document.getElementById('outlook-badge').textContent.trim()");
    check('Badge có trạng thái', ['BULLISH', 'BEARISH', 'SIDEWAYS'].includes(badge), badge);
    check('Panel kịch bản không hiện tỷ lệ %', await evaluate("!/\\d+\\.\\d%/.test(document.getElementById('scenario-list').textContent)"));
    check('Thanh trên không hiện Confidence %', await evaluate("!/%/.test(document.getElementById('confidence-value').textContent)"));

    await evaluate("(() => { const s = document.getElementById('symbol-select'); s.value = 'ETHUSDT'; s.dispatchEvent(new Event('change')); })()");
    check('Đổi symbol sang ETH', await waitFor(evaluate, "/ETH/.test(document.getElementById('metrics-grid').textContent)"));
    await evaluate("(() => { const s = document.getElementById('timeframe-selector'); s.value = '72'; s.dispatchEvent(new Event('change')); })()");
    check('Đổi horizon sang 3d', await waitFor(evaluate, "/3d|3 ngày/i.test(document.getElementById('scenario-list').textContent)"));
    check('Không có exception JS', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
    ws.close();
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
