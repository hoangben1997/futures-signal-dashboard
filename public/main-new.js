// Element references
const outlookBadgeEl = document.getElementById('outlook-badge');
const confidenceValueEl = document.getElementById('confidence-value');
const scoreValueEl = document.getElementById('score-value');
const signalsCountEl = document.getElementById('signals-count');
const lastUpdatedEl = document.getElementById('last-updated');
const symbolSelectEl = document.getElementById('symbol-select');
const candleLimitEl = document.getElementById('candle-limit');

const scenarioListEl = document.getElementById('scenario-list');
const playbookTextEl = document.getElementById('playbook-text');
const closeGuidesGridEl = document.getElementById('close-guides-grid');
const chartEl = document.getElementById('price-chart');
const chartNoteEl = document.getElementById('chart-note');
const chartTfEl = document.getElementById('chart-tf');

const usdcMetaEl = document.getElementById('usdc-meta');
const usdcFeedEl = document.getElementById('usdc-feed');
const metricsGridEl = document.getElementById('metrics-grid');

const signalBreakdownEl = document.getElementById('signal-breakdown');
const signalsCountDetailEl = document.getElementById('signals-count-detail');
const reasonsCountEl = document.getElementById('reasons-count');
const reasonsListEl = document.getElementById('reasons-list');
const risksCountEl = document.getElementById('risks-count');
const risksListEl = document.getElementById('risks-list');
const sourcesListEl = document.getElementById('sources-list');
const errorsCountEl = document.getElementById('errors-count');
const errorsListEl = document.getElementById('errors-list');

let pollTimer = null;
let selectedTf = '1h';
let selectedSymbol = 'BTCUSDT';
let selectedLimit = 24;
let selectedUsdcFilter = 'all';
let latestSnapshot = null;
let eventSource = null;

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const nfInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const rtfVi = new Intl.RelativeTimeFormat('vi', { numeric: 'always' });

// Utility functions
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

// Render Decision Bar
function renderDecisionBar(snapshot) {
  const { trend, metrics } = snapshot;

  // Outlook Badge
  outlookBadgeEl.textContent = trend.outlook.toUpperCase();
  if (trend.outlook.includes('Bullish')) {
    outlookBadgeEl.setAttribute('data-outlook', 'BULLISH BIAS');
  } else if (trend.outlook.includes('Bearish')) {
    outlookBadgeEl.setAttribute('data-outlook', 'BEARISH BIAS');
  } else {
    outlookBadgeEl.setAttribute('data-outlook', 'SIDEWAYS');
  }

  // Confidence
  confidenceValueEl.textContent = `${trend.confidence}%`;

  // Score
  scoreValueEl.textContent = trend.score;

  // Signals Count
  const activeSignals = (trend.rules || []).filter((r) => r.pass).length;
  signalsCountEl.textContent = activeSignals;

  // Last Updated
  const time = new Date(snapshot.generatedAt);
  lastUpdatedEl.textContent = time.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Render Scenario Probabilities
function renderScenarios(scenarios) {
  scenarioListEl.innerHTML = '';
  if (!Array.isArray(scenarios) || !scenarios.length) {
    scenarioListEl.innerHTML = '<p style="color: var(--color-text-tertiary);">No scenario data</p>';
    return;
  }

  const severityMap = {
    'Strong Bull Run': 'low',
    'Moderate Rally': 'low',
    'Sideways Ranging': 'info',
    'Moderate Correction': 'high',
    'Sharp Selloff': 'critical'
  };

  for (const s of scenarios) {
    const item = document.createElement('div');
    item.className = 'scenario-item';

    const label = document.createElement('div');
    label.className = 'scenario-item__label';
    label.textContent = s.name;

    const barWrapper = document.createElement('div');
    barWrapper.className = 'scenario-item__bar-wrapper';

    const bar = document.createElement('div');
    bar.className = 'scenario-item__bar';

    const fill = document.createElement('div');
    fill.className = 'scenario-item__fill';
    fill.style.width = `${s.probability || 0}%`;
    fill.setAttribute('data-severity', severityMap[s.name] || 'info');

    const percentage = document.createElement('span');
    percentage.className = 'scenario-item__percentage';
    percentage.textContent = `${Number(s.probability || 0).toFixed(1)}%`;

    bar.appendChild(fill);
    bar.appendChild(percentage);
    barWrapper.appendChild(bar);

    item.appendChild(label);
    item.appendChild(barWrapper);
    scenarioListEl.appendChild(item);
  }
}

// Render Playbook
function renderPlaybook(playbook) {
  playbookTextEl.textContent = playbook || 'No playbook available.';
}

// Render Close Guides Grid
function renderCloseGuides(guides) {
  closeGuidesGridEl.innerHTML = '';
  if (!Array.isArray(guides) || !guides.length) {
    closeGuidesGridEl.innerHTML = '<p style="color: var(--color-text-tertiary); grid-column: 1/-1;">No confirmation data</p>';
    return;
  }

  for (const guide of guides) {
    const card = document.createElement('div');
    card.className = 'close-guide';

    const tf = document.createElement('div');
    tf.className = 'close-guide__tf';
    tf.textContent = guide.timeframe.toUpperCase();

    const value = document.createElement('div');
    value.className = 'close-guide__value';
    value.textContent = money(guide.bullishAbove);

    const distance = document.createElement('div');
    distance.className = 'close-guide__distance';
    distance.textContent = `±${guide.thresholdPct}%`;

    card.appendChild(tf);
    card.appendChild(value);
    card.appendChild(distance);
    closeGuidesGridEl.appendChild(card);
  }
}

// Render Price Chart
function drawCandleChart(candles) {
  chartEl.innerHTML = '';
  if (!Array.isArray(candles) || candles.length < 2) {
    chartNoteEl.textContent = 'Insufficient data';
    return;
  }

  const width = 480;
  const height = 240;
  const pad = 10;

  const lows = candles.map((c) => c.low).filter((n) => Number.isFinite(n));
  const highs = candles.map((c) => c.high).filter((n) => Number.isFinite(n));
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = Math.max(max - min, 1);

  const step = (width - pad * 2) / candles.length;
  const bodyWidth = Math.max(2, step * 0.6);

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
    const bodyHeight = Math.max(1.5, Math.abs(yOpen - yClose));
    const isUp = c.close >= c.open;
    const color = isUp ? '#10b981' : '#ef4444';

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
    body.setAttribute('fill', isUp ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)');
    body.setAttribute('stroke', color);
    body.setAttribute('stroke-width', '1.2');
    chartEl.appendChild(body);
  }

  const last = candles[candles.length - 1];
  chartNoteEl.textContent = `Low: ${money(min)} | High: ${money(max)} | Last: ${money(last?.close)}`;
}

function renderChart(snapshot) {
  const tfMap = {
    '1h': snapshot.history?.candles1h || [],
    '4h': snapshot.history?.candles4h || []
  };
  const candles = tfMap[selectedTf] || [];
  drawCandleChart(candles);
}

// Render USDC Feed
function renderUSDCFeed(events) {
  const filtered = selectedUsdcFilter === 'all'
    ? events
    : events.filter((e) => e.type === selectedUsdcFilter);

  usdcMetaEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;
  usdcFeedEl.innerHTML = '';

  if (!filtered || !filtered.length) {
    const notice = document.createElement('p');
    notice.style.color = 'var(--color-text-tertiary)';
    notice.textContent = 'No USDC events found.';
    usdcFeedEl.appendChild(notice);
    return;
  }

  for (const event of filtered) {
    const item = document.createElement('div');
    item.className = 'event-item';
    item.setAttribute('data-type', event.type);

    const typeEl = document.createElement('span');
    typeEl.className = 'event-item__type';
    typeEl.setAttribute('data-type', event.type);
    typeEl.textContent = event.type;

    const content = document.createElement('div');
    content.className = 'event-item__content';

    const amountUsdc = Number.isFinite(event.amountUsdc)
      ? event.amountUsdc
      : (Number.isFinite(event.amount) ? event.amount : null);
    const amountUsd = Number.isFinite(event.amountUsd) ? Number(event.amountUsd) : amountUsdc;
    const amountStr = amountUsdc === null
      ? 'Unknown USDC'
      : `${nfInt.format(amountUsdc)} USDC`;
    const usdStr = amountUsd === null ? '' : ` (${nfInt.format(amountUsd)} USD)`;

    const amount = document.createElement('div');
    amount.className = 'event-item__amount';
    amount.textContent = amountStr + usdStr;

    const timeAgo = timeAgoVi(event.timestamp);
    const time = document.createElement('div');
    time.className = 'event-item__time';
    time.textContent = timeAgo;

    content.appendChild(amount);
    content.appendChild(time);

    item.appendChild(typeEl);
    item.appendChild(content);

    const txShort = event.txHash ? event.txHash.slice(0, 10) + '...' : '';
    const timeStr = new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    item.title = `Block: ${event.blockNumber ?? '-'} | From: ${event.from || '-'} | To: ${event.to || '-'} | TX: ${txShort} | Time: ${timeStr} UTC`;

    usdcFeedEl.appendChild(item);
  }
}

// Render Metrics Grid
function renderMetrics(metrics) {
  const symbolLabel = metrics.symbol.replace('USDT', '');

  const cards = [
    { label: `${symbolLabel} Price`, value: money(metrics.price) },
    { label: '24H Change', value: `${signed(metrics.priceChange24h)}%` },
    { label: 'Momentum 6H', value: `${signed(metrics.momentum6h)}%` },
    { label: 'Funding Rate', value: pct(metrics.fundingRate * 100, 4) },
    { label: 'Open Interest', value: nfInt.format(metrics.openInterest) },
    { label: 'OI Change 6H', value: pct(metrics.openInterestChange6h) },
    { label: 'Global L/S', value: metrics.longShortRatio ? metrics.longShortRatio.toFixed(2) : '-' },
    { label: 'Top Trader L/S', value: metrics.topTraderLongShortRatio ? metrics.topTraderLongShortRatio.toFixed(2) : '-' },
    { label: 'Taker B/S', value: metrics.takerBuySellRatio ? metrics.takerBuySellRatio.toFixed(3) : '-' },
    { label: 'Fear & Greed', value: metrics.fearGreed ?? '-' },
    { label: 'Realized Vol 24H', value: pct(metrics.realizedVol24h) },
    { label: 'BTC Dominance', value: pct(metrics.btcMarketCapDominance) }
  ];

  metricsGridEl.innerHTML = cards.map((card) => `
    <div class="metric-card">
      <div class="metric-card__label">${card.label}</div>
      <div class="metric-card__value">${card.value}</div>
    </div>
  `).join('');
}

// Render Signal Breakdown
function renderSignalBreakdown(rules) {
  signalBreakdownEl.innerHTML = '';
  if (!rules || !rules.length) {
    signalBreakdownEl.innerHTML = '<p style="color: var(--color-text-tertiary);">No signal data</p>';
    return;
  }

  const activeCount = rules.filter((r) => r.pass).length;
  signalsCountDetailEl.textContent = `${activeCount} active`;

  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = `signal-card ${rule.pass ? 'signal-card--pass' : 'signal-card--fail'}`;

    const header = document.createElement('div');
    header.className = 'signal-card__header';

    const name = document.createElement('div');
    name.className = 'signal-card__name';
    name.textContent = rule.name;

    const score = document.createElement('div');
    score.className = 'signal-card__score';
    if (rule.score > 0) {
      score.classList.add('signal-card__score--positive');
      score.textContent = `+${rule.score}`;
    } else if (rule.score < 0) {
      score.classList.add('signal-card__score--negative');
      score.textContent = `${rule.score}`;
    } else {
      score.classList.add('signal-card__score--neutral');
      score.textContent = '0';
    }

    header.appendChild(name);
    header.appendChild(score);

    const reason = document.createElement('div');
    reason.className = 'signal-card__reason';
    reason.textContent = rule.reason || '-';

    card.appendChild(header);
    card.appendChild(reason);
    signalBreakdownEl.appendChild(card);
  }
}

// Render Info Lists
function renderInfoList(el, countEl, items, fallback) {
  el.innerHTML = '';
  if (!items || !items.length) {
    const li = document.createElement('li');
    li.textContent = fallback;
    li.style.color = 'var(--color-text-tertiary)';
    el.appendChild(li);
    if (countEl) countEl.textContent = '0';
    return;
  }
  if (countEl) countEl.textContent = items.length;
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    el.appendChild(li);
  }
}

// Main render function
function render(snapshot) {
  try {
    latestSnapshot = snapshot;

    renderDecisionBar(snapshot);
    renderScenarios(snapshot.trend.scenarioProbabilities || []);
    renderPlaybook(snapshot.trend.playbook);
    renderCloseGuides(snapshot.trend.closeGuides || []);
    renderChart(snapshot);
    renderUSDCFeed(snapshot.usdcMinting || []);
    renderMetrics(snapshot.metrics);
    renderSignalBreakdown(snapshot.trend.rules || []);

    renderInfoList(reasonsListEl, reasonsCountEl, snapshot.trend.reasons, 'No strong signals detected.');
    renderInfoList(risksListEl, risksCountEl, snapshot.trend.risks, 'No significant warnings.');
    renderInfoList(errorsListEl, errorsCountEl, snapshot.errors, 'No errors.');

    // Data Sources
    sourcesListEl.innerHTML = '';
    for (const s of snapshot.dataPages || []) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = s.name;
      li.appendChild(a);
      sourcesListEl.appendChild(li);
    }
  } catch (err) {
    console.error('Render error:', err);
    lastUpdatedEl.textContent = `ERROR: ${err.message}`;
  }
}

// Event Bindings
function bindChartTfButtons() {
  if (!chartTfEl) return;
  chartTfEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-tf]');
    if (!btn) return;
    const tf = btn.dataset.tf;
    if (!tf || tf === selectedTf) return;
    selectedTf = tf;
    for (const el of chartTfEl.querySelectorAll('button')) {
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

function bindUSDCFilters() {
  const panel = document.querySelector('.panel--usdc');
  if (!panel) return;
  panel.addEventListener('click', (event) => {
    const btn = event.target.closest('.filter-btn');
    if (!btn) return;
    const filter = btn.dataset.filter;
    if (!filter || filter === selectedUsdcFilter) return;
    selectedUsdcFilter = filter;
    for (const el of panel.querySelectorAll('.filter-btn')) {
      el.classList.toggle('filter-btn--active', el.dataset.filter === selectedUsdcFilter);
    }
    if (latestSnapshot) {
      renderUSDCFeed(latestSnapshot.usdcMinting || []);
    }
  });
}

function reconnect() {
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
    lastUpdatedEl.textContent = `Error: ${err.message}`;
  }
}

function connectRealtime() {
  const url = `/api/stream?symbol=${selectedSymbol}&limit=${selectedLimit}`;
  eventSource = new EventSource(url);
  lastUpdatedEl.textContent = 'CONNECTING...';

  eventSource.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    render(data);
  });

  eventSource.addEventListener('error', () => {
    eventSource.close();
    eventSource = null;
    lastUpdatedEl.textContent = 'CONNECTION LOST - POLLING MODE';
    if (!pollTimer) {
      load();
      pollTimer = setInterval(load, 10_000);
    }
  });
}

// Initialize
bindChartTfButtons();
bindSymbolSelect();
bindCandleLimitButtons();
bindUSDCFilters();
connectRealtime();
