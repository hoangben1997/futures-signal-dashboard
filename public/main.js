const cardsEl = document.getElementById('metric-cards');
const updatedEl = document.getElementById('last-updated');
const outlookEl = document.getElementById('trend-outlook');
const scoreEl = document.getElementById('trend-score');
const playbookEl = document.getElementById('trend-playbook');
const alertsEl = document.getElementById('trend-alerts');
const reasonsEl = document.getElementById('trend-reasons');
const risksEl = document.getElementById('trend-risks');
const errorsEl = document.getElementById('errors');
const sourceLinksEl = document.getElementById('source-links');
const chartEl = document.getElementById('price-chart');
const chartNoteEl = document.getElementById('chart-note');
const chartTitleEl = document.getElementById('chart-title');
const tfEl = document.getElementById('chart-tf');
const symbolSelectEl = document.getElementById('symbol-select');
const candleLimitEl = document.getElementById('candle-limit');
const signalBreakdownEl = document.getElementById('signal-breakdown');
const closeGuidesEl = document.getElementById('trend-close-guides');
const scenariosEl = document.getElementById('trend-scenarios');

let pollTimer = null;
let selectedTf = '1h';
let selectedSymbol = 'BTCUSDT';
let selectedLimit = 24;
let latestSnapshot = null;
let eventSource = null;

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const nfInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const rtfVi = new Intl.RelativeTimeFormat('vi', { numeric: 'always' });

function money(v) {
  if (v === null || v === undefined) return '-';
  return `$${nf.format(v)}`;
}

function pct(v, digits = 2) {
  if (v === null || v === undefined) return '-';
  return `${Number(v).toFixed(digits)}%`;
}

function signed(v, digits = 2) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

function timeAgoVi(input) {
  const time = new Date(input);
  if (Number.isNaN(time.getTime())) return '-';
  const diffSec = Math.round((time.getTime() - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return rtfVi.format(diffSec, 'second');
  if (absSec < 3600) return rtfVi.format(Math.round(diffSec / 60), 'minute');
  if (absSec < 86400) return rtfVi.format(Math.round(diffSec / 3600), 'hour');
  return rtfVi.format(Math.round(diffSec / 86400), 'day');
}

function list(el, items, fallback) {
  el.innerHTML = '';
  if (!items || !items.length) {
    const li = document.createElement('li');
    li.textContent = fallback;
    el.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    el.appendChild(li);
  }
}

function renderUSDCMinting(events) {
  alertsEl.innerHTML = '';
  if (!events || !events.length) {
    const li = document.createElement('li');
    li.className = 'alert info';
    li.textContent = '[USDC TREASURY] No minting/burning events in last 72h.';
    alertsEl.appendChild(li);
    return;
  }

  for (const event of events) {
    const li = document.createElement('li');
    const isMint = event.type === 'MINT';
    li.className = `alert ${isMint ? 'info' : 'warn'}`;

    const time = new Date(event.timestamp);
    const timeAgo = timeAgoVi(event.timestamp);
    const timeStr = time.toISOString().replace('T', ' ').slice(0, 19);
    const amountUsdc = Number.isFinite(event.amountUsdc)
      ? event.amountUsdc
      : (Number.isFinite(event.amount) ? event.amount : null);
    const amountUsd = Number.isFinite(event.amountUsd) ? Number(event.amountUsd) : amountUsdc;
    const amountStr = amountUsdc === null
      ? 'Unknown #USDC'
      : `${nfInt.format(amountUsdc)} #USDC`;
    const usdStr = amountUsd === null ? 'Unknown USD' : `${nfInt.format(amountUsd)} USD`;
    const txShort = event.txHash ? event.txHash.slice(0, 10) + '...' : '';

    li.textContent = `[${event.type}] ${amountStr} (${usdStr}) | ${timeAgo}`;
    li.title = `Block: ${event.blockNumber ?? '-'} | From: ${event.from || '-'} | To: ${event.to || '-'} | TX: ${event.txHash || '-'}`;
    if (txShort) li.title += ` | Short: ${txShort}`;
    li.title += ` | Time: ${timeStr} UTC`;
    alertsEl.appendChild(li);
  }
}

function drawCandleChart(candles) {
  chartEl.innerHTML = '';
  if (!Array.isArray(candles) || candles.length < 2) {
    chartNoteEl.textContent = 'INSUFFICIENT DATA';
    return;
  }

  const width = 480;
  const height = 180;
  const pad = 10;

  const lows = candles.map((c) => c.low).filter((n) => Number.isFinite(n));
  const highs = candles.map((c) => c.high).filter((n) => Number.isFinite(n));
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = Math.max(max - min, 1);

  const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baseline.setAttribute('x1', String(pad));
  baseline.setAttribute('x2', String(width - pad));
  baseline.setAttribute('y1', String(height - pad));
  baseline.setAttribute('y2', String(height - pad));
  baseline.setAttribute('stroke', '#1a3a4a');
  baseline.setAttribute('stroke-width', '1');
  chartEl.appendChild(baseline);

  const step = (width - pad * 2) / candles.length;
  const bodyWidth = Math.max(2, step * 0.58);

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if ([c.open, c.high, c.low, c.close].some((x) => !Number.isFinite(x))) continue;

    const xCenter = pad + step * (i + 0.5);
    const toY = (price) => pad + ((max - price) / range) * (height - pad * 2);
    const yHigh = toY(c.high);
    const yLow = toY(c.low);
    const yOpen = toY(c.open);
    const yClose = toY(c.close);
    const top = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1.4, Math.abs(yOpen - yClose));
    const isUp = c.close >= c.open;
    const color = isUp ? '#00ff88' : '#ff4444';

    const wick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    wick.setAttribute('x1', xCenter.toFixed(2));
    wick.setAttribute('x2', xCenter.toFixed(2));
    wick.setAttribute('y1', yHigh.toFixed(2));
    wick.setAttribute('y2', yLow.toFixed(2));
    wick.setAttribute('stroke', color);
    wick.setAttribute('stroke-width', '1.2');
    chartEl.appendChild(wick);

    const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    body.setAttribute('x', (xCenter - bodyWidth / 2).toFixed(2));
    body.setAttribute('y', top.toFixed(2));
    body.setAttribute('width', bodyWidth.toFixed(2));
    body.setAttribute('height', bodyHeight.toFixed(2));
    body.setAttribute('fill', isUp ? 'rgba(0, 255, 136, 0.25)' : 'rgba(255, 68, 68, 0.25)');
    body.setAttribute('stroke', color);
    body.setAttribute('stroke-width', '1');
    chartEl.appendChild(body);
  }

  const last = candles[candles.length - 1];
  chartNoteEl.textContent = `LOW: ${money(min)} | HIGH: ${money(max)} | LAST: ${money(last?.close)}`;
}

function renderChart(snapshot) {
  const tfMap = {
    '1h': snapshot.history?.candles1h || [],
    '4h': snapshot.history?.candles4h || []
  };
  const candles = tfMap[selectedTf] || [];
  const numCandles = candles.length;
  chartTitleEl.textContent = `PRICE CANDLES (${selectedTf.toUpperCase()}, ${numCandles})`;
  drawCandleChart(candles);
}

function renderSignalBreakdown(rules) {
  signalBreakdownEl.innerHTML = '';
  if (!rules || !rules.length) {
    signalBreakdownEl.innerHTML = '<p class="subtle">Không có rule details.</p>';
    return;
  }

  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = `rule-card ${rule.pass ? 'pass' : 'fail'}`;

    const name = document.createElement('div');
    name.className = 'rule-name';
    name.textContent = rule.name;

    const scoreDiv = document.createElement('div');
    scoreDiv.className = 'rule-score';
    if (rule.score > 0) {
      scoreDiv.classList.add('positive');
      scoreDiv.textContent = `+${rule.score}`;
    } else if (rule.score < 0) {
      scoreDiv.classList.add('negative');
      scoreDiv.textContent = `${rule.score}`;
    } else {
      scoreDiv.classList.add('neutral');
      scoreDiv.textContent = '0';
    }

    const reasonDiv = document.createElement('div');
    reasonDiv.className = 'rule-reason';
    reasonDiv.textContent = rule.reason || '-';

    card.appendChild(name);
    card.appendChild(scoreDiv);
    card.appendChild(reasonDiv);
    signalBreakdownEl.appendChild(card);
  }
}

function renderCloseGuides(guides) {
  if (!closeGuidesEl) return;
  closeGuidesEl.innerHTML = '';
  if (!Array.isArray(guides) || !guides.length) {
    closeGuidesEl.textContent = 'Chưa có mốc xác nhận đóng nến.';
    return;
  }

  for (const guide of guides) {
    const row = document.createElement('div');
    row.className = 'close-guide-row';

    const tf = document.createElement('span');
    tf.className = 'close-guide-tf';
    tf.textContent = guide.timeframe.toUpperCase();

    const line = document.createElement('span');
    line.className = 'close-guide-line';
    line.textContent = `Đóng trên ${money(guide.bullishAbove)} hoặc dưới ${money(guide.bearishBelow)} | ±${guide.thresholdPct}%`;

    const badge = document.createElement('span');
    badge.className = `close-guide-badge ${guide.clarity === 'clear' ? 'clear' : 'dev'}`;
    badge.textContent = guide.clarity === 'clear' ? 'RÕ XU HƯỚNG' : 'CHƯA RÕ';

    row.appendChild(tf);
    row.appendChild(line);
    row.appendChild(badge);
    closeGuidesEl.appendChild(row);
  }
}

function renderScenarioProbabilities(scenarios) {
  if (!scenariosEl) return;
  scenariosEl.innerHTML = '';
  if (!Array.isArray(scenarios) || !scenarios.length) {
    const li = document.createElement('li');
    li.textContent = 'Chưa có dữ liệu xác suất kịch bản.';
    scenariosEl.appendChild(li);
    return;
  }

  for (const s of scenarios) {
    const li = document.createElement('li');
    li.className = `scenario-item ${s.bias || 'neutral'}`;
    li.textContent = `${s.name}: ${Number(s.probability || 0).toFixed(1)}%`;
    li.title = s.note || '';
    scenariosEl.appendChild(li);
  }
}

function card(label, value) {
  return `<article class="card"><div class="label">${label}</div><div class="value">${value}</div></article>`;
}

function render(snapshot) {
  try {
    latestSnapshot = snapshot;
    const m = snapshot.metrics;

    // Update timestamp with tactical format
    const time = new Date(snapshot.generatedAt);
    updatedEl.textContent = `${time.toISOString().replace('T', ' ').slice(0, 19)} UTC`;

    const symbolLabel = m.symbol.replace('USDT', '');

    cardsEl.innerHTML = [
      card(`${symbolLabel} PRICE`, money(m.price)),
      card('24H CHANGE', `${signed(m.priceChange24h)}%`),
      card('MOMENTUM 6H', `${signed(m.momentum6h)}%`),
      card('FUNDING RATE', pct(m.fundingRate * 100, 4)),
      card('OPEN INTEREST', nf.format(m.openInterest)),
      card('OI CHANGE 6H', pct(m.openInterestChange6h)),
      card('GLOBAL L/S', m.longShortRatio ? m.longShortRatio.toFixed(2) : '-'),
      card('TOP TRADER L/S', m.topTraderLongShortRatio ? m.topTraderLongShortRatio.toFixed(2) : '-'),
      card('TAKER B/S', m.takerBuySellRatio ? m.takerBuySellRatio.toFixed(3) : '-'),
      card('FEAR & GREED', m.fearGreed ?? '-'),
      card('REALIZED VOL 24H', pct(m.realizedVol24h)),
      card('BTC DOMINANCE', pct(m.btcMarketCapDominance))
    ].join('');

    outlookEl.textContent = snapshot.trend.outlook;
    outlookEl.className = 'outlook-tactical';
    if (snapshot.trend.outlook.includes('Bearish')) outlookEl.classList.add('down');
    else if (snapshot.trend.outlook.includes('Bullish')) outlookEl.classList.add('up');
    else outlookEl.classList.add('flat');

    scoreEl.textContent = `SCORE: ${snapshot.trend.score} | CONFIDENCE: ${snapshot.trend.confidence}%`;
    playbookEl.textContent = snapshot.trend.playbook;
    renderCloseGuides(snapshot.trend.closeGuides || []);
    renderScenarioProbabilities(snapshot.trend.scenarioProbabilities || []);

    renderUSDCMinting(snapshot.usdcMinting || []);
    renderSignalBreakdown(snapshot.trend.rules);
    list(reasonsEl, snapshot.trend.reasons, 'No strong signals detected.');
    list(risksEl, snapshot.trend.risks, 'No significant warnings.');
    list(errorsEl, snapshot.errors, 'No data errors.');

    renderChart(snapshot);

    sourceLinksEl.innerHTML = '';
    for (const s of snapshot.dataPages) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = s.name;
      li.appendChild(a);
      sourceLinksEl.appendChild(li);
    }
  } catch (err) {
    console.error('Render error:', err);
    updatedEl.textContent = `ERROR: ${err.message}`;
  }
}

function bindTfButtons() {
  if (!tfEl) return;
  tfEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-tf]');
    if (!btn) return;
    const tf = btn.dataset.tf;
    if (!tf || tf === selectedTf) return;
    selectedTf = tf;
    for (const el of tfEl.querySelectorAll('button')) {
      el.classList.toggle('active', el.dataset.tf === selectedTf);
    }
    if (latestSnapshot) {
      renderChart(latestSnapshot);
    }
  });
}

function bindSymbolSelect() {
  if (!symbolSelectEl) return;
  symbolSelectEl.addEventListener('change', () => {
    selectedSymbol = symbolSelectEl.value;
    reconnect();
  });
}

function bindCandleLimitButtons() {
  if (!candleLimitEl) return;
  candleLimitEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-limit]');
    if (!btn) return;
    const limit = parseInt(btn.dataset.limit, 10);
    if (!limit || limit === selectedLimit) return;
    selectedLimit = limit;
    for (const el of candleLimitEl.querySelectorAll('button')) {
      el.classList.toggle('active', parseInt(el.dataset.limit, 10) === selectedLimit);
    }
    reconnect();
  });
}

function reconnect() {
  // Đóng SSE cũ và reconnect với params mới
  if (eventSource) {
    eventSource.close();
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  connectRealtime();
}

async function load() {
  try {
    const url = `/api/snapshot?symbol=${selectedSymbol}&limit=${selectedLimit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fetch failed');
    render(data);
  } catch (err) {
    updatedEl.textContent = `Lỗi tải dữ liệu: ${err.message}`;
  }
}

function connectRealtime() {
  const url = `/api/stream?symbol=${selectedSymbol}&limit=${selectedLimit}`;
  eventSource = new EventSource(url);
  updatedEl.textContent = 'CONNECTING...';

  eventSource.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    render(data);
  });

  eventSource.addEventListener('error', () => {
    eventSource.close();
    eventSource = null;
    updatedEl.textContent = 'CONNECTION LOST - POLLING MODE';
    if (!pollTimer) {
      load();
      pollTimer = setInterval(load, 10_000);
    }
  });
}

bindTfButtons();
bindSymbolSelect();
bindCandleLimitButtons();
connectRealtime();
