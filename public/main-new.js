import {
  decisionBarView,
  historicalModelStatusText,
  playbookBasisLines,
  scenarioPanelView,
  staleSourceAlerts,
  statisticalNoteText
} from './legacy-view.js';

// Element references
const outlookBadgeEl = document.getElementById('outlook-badge');
const confidenceValueEl = document.getElementById('confidence-value');
const scoreValueEl = document.getElementById('score-value');
const signalsCountEl = document.getElementById('signals-count');
const lastUpdatedEl = document.getElementById('last-updated');
const symbolSelectEl = document.getElementById('symbol-select');
const timeframeSelectorEl = document.getElementById('timeframe-selector');

const scenarioListEl = document.getElementById('scenario-list');
const mappedTrendEl = document.getElementById('mapped-trend');
const backtestTableEl = document.getElementById('backtest-table');
const playbookTextEl = document.getElementById('playbook-text');
const playbookBasisEl = document.getElementById('playbook-basis');
const closeGuidesGridEl = document.getElementById('close-guides-grid');
const chartEl = document.getElementById('price-chart');
const chartNoteEl = document.getElementById('chart-note');
const chartTfEl = document.getElementById('chart-tf');

const usdcMetaEl = document.getElementById('usdc-meta');
const usdcFeedEl = document.getElementById('usdc-feed');
const metricsGridEl = document.getElementById('metrics-grid');
const calendarTableEl = document.getElementById('calendar-table');

const signalBreakdownEl = document.getElementById('signal-breakdown');
const signalsCountDetailEl = document.getElementById('signals-count-detail');
const reasonsCountEl = document.getElementById('reasons-count');
const reasonsListEl = document.getElementById('reasons-list');
const risksCountEl = document.getElementById('risks-count');
const risksListEl = document.getElementById('risks-list');
const sourcesListEl = document.getElementById('sources-list');
const errorsCountEl = document.getElementById('errors-count');
const errorsListEl = document.getElementById('errors-list');
const technicalsTableEl = document.getElementById('technicals-table');
const technicalsMetaEl = document.getElementById('technicals-meta');
const analysisReportEl = document.getElementById('analysis-report');
const analysisMetaEl = document.getElementById('analysis-meta');

let pollTimer = null;
let selectedTf = '1h';
let selectedSymbol = 'BTCUSDT';
let selectedTimeframeHours = 4;
let selectedUsdcFilter = 'MINT';
let latestSnapshot = null;
let eventSource = null;
let lastUsdcData = null;

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
  const { trend } = snapshot;
  const view = decisionBarView(trend);

  // Badge dùng đúng trend.outlook của backend (cùng ngưỡng với playbook)
  outlookBadgeEl.textContent = view.badgeText;
  outlookBadgeEl.setAttribute('data-outlook', view.badgeOutlook);

  // Cường độ điểm (0–1), không phải xác suất
  confidenceValueEl.textContent = view.strengthText;
  confidenceValueEl.title = view.strengthTitle;

  scoreValueEl.textContent = view.scoreText;

  // Signals Count
  const activeRuleSignals = (trend.rules || []).filter((r) => r.pass).length;
  const mappedSignals = Object.values(trend.mappedTrend?.components || {})
    .filter((v) => Number.isFinite(v) && Math.abs(v) >= 0.35).length;
  signalsCountEl.textContent = activeRuleSignals + mappedSignals;

  // Last Updated
  const time = new Date(snapshot.generatedAt);
  lastUpdatedEl.textContent = time.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Render Scenario panel: chỉ còn mức theo dõi; tỷ lệ heuristic không hiển thị (hợp đồng P0)
function renderScenarios(trend) {
  scenarioListEl.innerHTML = '';
  const view = scenarioPanelView(trend, selectedTimeframeHours);

  const horizon = document.createElement('p');
  horizon.className = 'scenario-probability-header';
  horizon.textContent = view.horizonNote;
  scenarioListEl.appendChild(horizon);

  if (view.monitoring) {
    const mv = view.monitoring;
    const levelsBox = document.createElement('div');
    levelsBox.className = 'breakout-levels';
    const header = document.createElement('div');
    header.className = 'breakout-levels__header';
    header.textContent = mv.header;
    const grid = document.createElement('div');
    grid.className = 'breakout-levels__grid';
    for (const [cls, label, price] of [['bullish', mv.aboveLabel, mv.above], ['bearish', mv.belowLabel, mv.below]]) {
      const cell = document.createElement('div');
      cell.className = `breakout-level ${cls}`;
      const l = document.createElement('div');
      l.className = 'breakout-level__label';
      l.textContent = label;
      const p = document.createElement('div');
      p.className = 'breakout-level__price';
      p.textContent = price;
      cell.append(l, p);
      grid.appendChild(cell);
    }
    const footer = document.createElement('div');
    footer.className = 'breakout-levels__footer';
    footer.textContent = mv.footer;
    const note = document.createElement('div');
    note.className = 'breakout-levels__footer';
    note.textContent = mv.note;
    levelsBox.append(header, grid, footer, note);
    scenarioListEl.appendChild(levelsBox);
  }

  const notice = document.createElement('p');
  notice.className = 'scenario-probability-header';
  notice.textContent = view.probabilityNotice;
  scenarioListEl.appendChild(notice);
}

// Render Playbook
function renderPlaybook(playbook, basis) {
  playbookTextEl.textContent = playbook || 'No playbook available.';
  if (!playbookBasisEl) return;
  playbookBasisEl.innerHTML = '';
  for (const line of playbookBasisLines(basis)) {
    const item = document.createElement('div');
    item.className = 'playbook-basis__item';
    item.textContent = line;
    playbookBasisEl.appendChild(item);
  }
}

// Render mapped trend components
function renderMappedTrend(mappedTrend, baseRuleScore) {
  if (!mappedTrendEl) return;
  mappedTrendEl.innerHTML = '';
  if (!mappedTrend || !mappedTrend.components) {
    mappedTrendEl.innerHTML = '<p style="color: var(--color-text-tertiary);">No trend mapping</p>';
    return;
  }

  const mapScore = Number(mappedTrend.score || 0);
  const tone = mapScore > 0.35 ? 'bullish' : mapScore < -0.35 ? 'bearish' : 'neutral';
  const title = document.createElement('div');
  title.className = 'mapped-trend__title';
  title.textContent = `Trend Mapping (${String(mappedTrend.timeframe || '').toUpperCase()})`;

  const head = document.createElement('div');
  head.className = 'mapped-trend__head';
  head.innerHTML = `
    <span class="mapped-trend__chip mapped-trend__chip--${tone}">Mapped ${signed(mapScore)}</span>
    <span class="mapped-trend__chip">Rule ${signed(baseRuleScore || 0)}</span>
  `;

  const list = document.createElement('div');
  list.className = 'mapped-trend__list';
  const labels = {
    structure: 'Structure',
    derivatives: 'Derivatives',
    regime: 'Market Regime',
    macroTime: 'Macro/Time'
  };

  const components = ['structure', 'derivatives', 'regime', 'macroTime']
    .map((key) => {
      const value = Number(mappedTrend.components[key] || 0);
      const weight = Number(mappedTrend.weights?.[key] || 0);
      return { key, value, weight, contribution: value * weight };
    })
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  for (const c of components) {
    const { key, value, weight, contribution } = c;
    const pctWidth = Math.min(50, Math.abs(contribution) * 16);
    const directionClass = contribution > 0 ? 'pos' : contribution < 0 ? 'neg' : 'flat';
    const item = document.createElement('div');
    item.className = 'mapped-trend__item';
    item.innerHTML = `
      <div class="mapped-trend__label">${labels[key] || key}</div>
      <div class="mapped-trend__meta">${signed(value)} × ${weight.toFixed(2)} = ${signed(contribution, 3)}</div>
      <div class="mapped-trend__bar">
        <span class="mapped-trend__bar-axis"></span>
        <span class="mapped-trend__bar-fill mapped-trend__bar-fill--${directionClass}" style="width:${pctWidth}%;"></span>
      </div>
    `;
    list.appendChild(item);
  }

  mappedTrendEl.appendChild(title);
  mappedTrendEl.appendChild(head);
  mappedTrendEl.appendChild(list);
}

function renderBacktestTable(contract) {
  if (!backtestTableEl) return;
  backtestTableEl.innerHTML = '';
  const p = document.createElement('p');
  p.style.color = 'var(--color-text-tertiary)';
  p.textContent = historicalModelStatusText(contract);
  backtestTableEl.appendChild(p);
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
  const height = 180;
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
  // Chart luôn hiển thị 3 ngày, không phụ thuộc timeframe selector
  const tfMap = {
    '1h': snapshot.history?.candles1h || [],
    '4h': snapshot.history?.candles4h || []
  };
  const candles = tfMap[selectedTf] || [];
  drawCandleChart(candles);
}

// Render USDC Feed
function renderUSDCFeed(events) {
  // Filter by amount > 100M USDC
  const largeEvents = events.filter((e) => {
    const amount = Number.isFinite(e.amountUsdc) ? e.amountUsdc : 0;
    return amount > 100000000;
  });

  const filtered = selectedUsdcFilter === 'all'
    ? largeEvents
    : largeEvents.filter((e) => e.type === selectedUsdcFilter);

  // Panel chỉ hiện sự kiện > 100M; DiSSS (nhóm on-chain) tính mint/burn ròng trên toàn bộ feed 72h.
  usdcMetaEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''} > 100M / ${events.length} tổng (DiSSS tính toàn bộ)`;
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

  // Auto scroll to top to show newest events
  usdcFeedEl.scrollTop = 0;
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

// Render Economic Calendar
function renderCalendar(events) {
  calendarTableEl.innerHTML = '';
  if (!events || !events.length) {
    calendarTableEl.innerHTML = '<p style="color: var(--color-text-tertiary);">No economic events found</p>';
    return;
  }

  const table = document.createElement('table');

  // Header
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Time</th>
      <th>Currency</th>
      <th>Event</th>
      <th>Impact</th>
      <th>Actual</th>
      <th>Forecast</th>
      <th>Previous</th>
    </tr>
  `;
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  for (const event of events) {
    const row = document.createElement('tr');
    const cells = [
      ['calendar-table__date', event.date],
      ['calendar-table__time', event.time],
      ['', event.currency, 'calendar-table__currency'],
      ['calendar-table__title', event.title],
      ['calendar-table__impact', event.impact],
      ['calendar-table__value calendar-table__value--actual', event.actual],
      ['calendar-table__value', event.forecast],
      ['calendar-table__value', event.previous]
    ];
    for (const [tdClass, value, spanClass] of cells) {
      const td = document.createElement('td');
      if (tdClass) td.className = tdClass;
      const text = value === null || value === undefined || value === '' ? '-' : String(value);
      if (spanClass) {
        const span = document.createElement('span');
        span.className = spanClass;
        span.textContent = text;
        td.appendChild(span);
      } else {
        td.textContent = text;
      }
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  calendarTableEl.appendChild(table);
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

// Escape text trước khi ghép vào innerHTML (một số text đến từ nguồn ngoài, vd. tiêu đề lịch kinh tế)
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function priceText(v) {
  if (!Number.isFinite(v)) return '-';
  return nf.format(v >= 1000 ? Math.round(v) : v);
}

const STRUCTURE_LABEL = { bullish: 'Tăng', bearish: 'Giảm', mixed: 'Lẫn lộn', unknown: '-' };
const STACK_LABEL = { bullish: 'Bullish', bearish: 'Bearish', mixed: 'Lẫn lộn', unknown: '-' };
const TONE_BY_DIRECTION = { bullish: 'bullish', bearish: 'bearish', neutral: 'neutral', no_data: 'neutral' };

// Render bảng kỹ thuật đa khung
function renderTechnicals(technicals) {
  if (!technicalsTableEl) return;
  const byTf = technicals?.byTf || {};
  const rows = [['1M', 'M'], ['1w', 'W'], ['1d', 'D'], ['4h', '4H'], ['1h', '1H']]
    .filter(([key]) => byTf[key]);
  if (!rows.length) {
    technicalsTableEl.innerHTML = '<p style="color: var(--color-text-tertiary);">Chưa có dữ liệu kỹ thuật</p>';
    technicalsMetaEl.textContent = '--';
    return;
  }
  const maCell = (t, key) => {
    const v = t[key];
    if (!Number.isFinite(v)) return '<td>n/a</td>';
    const tone = t.price >= v ? 'bullish' : 'bearish';
    return `<td class="tech-table__ma tech-table__ma--${tone}">${priceText(v)}</td>`;
  };
  technicalsTableEl.innerHTML = `
    <table class="tech-table tech-table--nowrap">
      <thead>
        <tr>
          <th>TF</th><th>Giá</th><th>MA50</th><th>MA100</th><th>MA200</th><th>Thứ tự MA</th>
          <th>RSI / MA</th><th>MACD hist</th><th>Cấu trúc</th><th>Vol nến đóng</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(([key, label]) => {
          const t = byTf[key];
          const s = t.structure || {};
          const histUp = Number.isFinite(t.macdHist) && Number.isFinite(t.macdHistPrev) && t.macdHist > t.macdHistPrev;
          const structure = s.state === 'unknown' || !s.highs
            ? '-'
            : `${s.highs}/${s.lows}${s.broken === 'down' ? ' · thủng đáy' : s.broken === 'up' ? ' · vượt đỉnh' : ''}`;
          return `
            <tr>
              <td><strong>${label}</strong></td>
              <td>${priceText(t.price)}</td>
              ${maCell(t, 'ma50')}${maCell(t, 'ma100')}${maCell(t, 'ma200')}
              <td>${STACK_LABEL[t.stack] || '-'}${t.cross50x200?.recent ? ` · ${t.cross50x200.recent.type === 'golden' ? 'golden' : 'death'} cross ${t.cross50x200.recent.barsAgo} nến trước` : ''}</td>
              <td>${Number.isFinite(t.rsi) ? t.rsi.toFixed(1) : '-'} / ${Number.isFinite(t.rsiMa) ? t.rsiMa.toFixed(1) : '-'}</td>
              <td class="tech-table__ma--${t.macdHist >= 0 ? 'bullish' : 'bearish'}">${Number.isFinite(t.macdHist) ? signed(t.macdHist) : '-'} ${histUp ? '↑' : '↓'}</td>
              <td class="tech-table__ma--${TONE_BY_DIRECTION[s.state] || 'neutral'}">${esc(structure)} (${STRUCTURE_LABEL[s.state] || '-'})</td>
              <td>${Number.isFinite(t.lastClosedVolRatio) ? `${t.lastClosedVolRatio.toFixed(2)}×` : '-'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  const sources = Object.entries(technicals.sources || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
  technicalsMetaEl.textContent = `Cập nhật ${timeAgoVi(technicals.generatedAt)} · ${sources}`;
}

const STATUS_LABEL = { bullish: 'Tăng', bearish: 'Giảm', neutral: 'Trung tính', no_data: 'Thiếu dữ liệu' };
const KIND_LABEL = { fact: 'dữ liệu', inference: 'suy luận' };
const TIMING_LABEL = { leading: 'dẫn dắt', coincident: 'trùng hợp', lagging: 'trễ' };
const CONFIDENCE_LABEL = { low: 'Thấp', medium: 'Trung bình', high: 'Cao' };
const BIAS_LABEL = { bullish: 'NGHIÊNG TĂNG', bearish: 'NGHIÊNG GIẢM', neutral: 'ĐI NGANG', insufficient: 'CHƯA ĐỦ DỮ LIỆU' };

function listHtml(items, emptyText = 'Không có') {
  if (!Array.isArray(items) || !items.length) return `<p class="analysis__empty">${esc(emptyText)}</p>`;
  return `<ul class="analysis__list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
}

function chip(text, tone = 'neutral') {
  return `<span class="scenario-meta__chip scenario-meta__chip--${tone}">${esc(text)}</span>`;
}

function levelRows(levels, side) {
  return (levels || []).map((l) => `
    <tr>
      <td>${side}</td>
      <td>${priceText(l.low)}${l.high !== l.low ? `–${priceText(l.high)}` : ''}</td>
      <td>${signed(l.distancePct)}%</td>
      <td>${esc(l.strength)}</td>
      <td>${esc(l.reasons.join(', '))}</td>
    </tr>`).join('');
}

// Render báo cáo DiSSS. Giữ trạng thái mở/đóng của các <details> qua mỗi lần cập nhật.
function renderAnalysis(analysis) {
  if (!analysisReportEl) return;
  if (!analysis) {
    analysisReportEl.innerHTML = '<p style="color: var(--color-text-tertiary);">Chưa có báo cáo phân tích</p>';
    analysisMetaEl.textContent = '--';
    return;
  }
  const prevDetails = [...analysisReportEl.querySelectorAll('details[data-key]')];
  const openKeys = new Set(prevDetails.filter((d) => d.open).map((d) => d.dataset.key));
  const s = analysis.summary;
  const biasTone = s.bias === 'bullish' ? 'bullish' : s.bias === 'bearish' ? 'bearish' : 'neutral';

  const factorRows = analysis.factorTable.map((f) => `
    <tr>
      <td><strong>${esc(f.label)}</strong></td>
      <td>${chip(STATUS_LABEL[f.status] || f.status, TONE_BY_DIRECTION[f.status])}</td>
      <td>
        ${f.evidence.map((e) => `
          <div class="analysis__evidence">
            ${esc(e.text)}
            <span class="analysis__tag">${KIND_LABEL[e.kind] || e.kind} · ${TIMING_LABEL[e.timing] || e.timing}</span>
          </div>`).join('')}
        ${f.notes.map((n) => `<div class="analysis__evidence analysis__evidence--note">${esc(n)}</div>`).join('')}
        ${f.missing.length ? `<div class="analysis__missing">Thiếu: ${esc(f.missing.join('; '))}</div>` : ''}
      </td>
    </tr>`).join('');

  const scenarioCards = analysis.scenarios.map((sc) => `
    <div class="analysis__scenario analysis__scenario--${sc.key}">
      <div class="analysis__scenario-head">
        <strong>${esc(sc.name)}</strong>
        ${chip(`Tin cậy: ${CONFIDENCE_LABEL[sc.confidence] || sc.confidence}`, sc.key === 'bullish' ? 'bullish' : sc.key === 'bearish' ? 'bearish' : 'neutral')}
        ${Number.isFinite(sc.statisticalProbabilityPct) ? chip(`Thống kê: ${sc.statisticalProbabilityPct}%`) : ''}
      </div>
      <div class="analysis__label">Ủng hộ</div>${listHtml(sc.evidenceFor)}
      <div class="analysis__label">Phản đối</div>${listHtml(sc.evidenceAgainst)}
      <div class="analysis__label">Xác nhận</div><p>${esc(sc.confirmation)}</p>
      <div class="analysis__label">Vô hiệu</div><p>${esc(sc.invalidation)}</p>
      <div class="analysis__label">Vùng quan sát</div>${listHtml(sc.watchZones, 'Chưa xác định')}
      <div class="analysis__foot">${esc(sc.horizon)} · ${esc(sc.basis)}</div>
    </div>`).join('');

  const stat = analysis.statisticalModel;
  const critique = analysis.selfCritique;
  const cost = analysis.stakes.costModel;

  analysisReportEl.innerHTML = `
    <div class="analysis__summary">
      ${chip(BIAS_LABEL[s.bias] || s.bias, biasTone)}
      ${chip(`Regime: ${s.regimeLabel}`)}
      ${chip(`Điểm ròng ${signed(s.netScore)} / ±${s.maxScore}`, biasTone)}
      ${chip(`Tin cậy: ${CONFIDENCE_LABEL[s.confidence] || s.confidence}`)}
      ${chip(`Dữ liệu mới ${s.freshDataPct}% · có dữ liệu ${s.dataAvailablePct}% · nghiêng một phía ${s.activeEvidencePct}%`)}
      <p class="analysis__summary-text">${esc(s.text)}</p>
    </div>

    <h3 class="analysis__heading">1–3. Các yếu tố có ảnh hưởng lớn nhất</h3>
    ${analysis.topFactors.length
      ? `<div class="scenario-meta">${analysis.topFactors.map((f) => chip(`${f.label}: ${signed(f.contribution, 2)}`, f.direction)).join('')}</div>`
      : '<p class="analysis__empty">Không có nguồn nào nghiêng rõ.</p>'}
    <p class="analysis__note">Mỗi nguồn dữ liệu độc lập chỉ góp tối đa ±1 × trọng số; ${analysis.timingMix.leading} dẫn dắt · ${analysis.timingMix.coincident} trùng hợp · ${analysis.timingMix.lagging} trễ.</p>

    <details class="analysis__block" data-key="factors" open>
      <summary>2. Bảng đánh giá từng nhóm yếu tố</summary>
      <div class="calendar-table">
        <table class="tech-table"><thead><tr><th>Nhóm</th><th>Trạng thái</th><th>Bằng chứng</th></tr></thead><tbody>${factorRows}</tbody></table>
      </div>
    </details>

    <h3 class="analysis__heading">4. Ba kịch bản (1–7 ngày)</h3>
    <div class="analysis__scenarios">${scenarioCards}</div>
    <p class="analysis__note">${esc(statisticalNoteText(stat))}</p>

    <details class="analysis__block" data-key="levels" open>
      <summary>5. Các vùng giá quan trọng</summary>
      <div class="calendar-table">
        <table class="tech-table">
          <thead><tr><th></th><th>Vùng</th><th>Cách giá</th><th>Cấp độ</th><th>Lý do</th></tr></thead>
          <tbody>${levelRows([...analysis.keyLevels.resistances].reverse(), 'Kháng cự')}${levelRows(analysis.keyLevels.supports, 'Hỗ trợ')}</tbody>
        </table>
      </div>
    </details>

    <details class="analysis__block" data-key="watch">
      <summary>6. Tín hiệu cần theo dõi</summary>
      ${listHtml(analysis.watchSignals)}
    </details>

    <details class="analysis__block" data-key="critique">
      <summary>7. Tự phản biện</summary>
      <div class="analysis__critique">
        <div><div class="analysis__label">Bull Analyst</div>${listHtml(critique.bull)}</div>
        <div><div class="analysis__label">Bear Analyst</div>${listHtml(critique.bear)}</div>
        <div><div class="analysis__label">Quant Analyst</div>${listHtml(critique.quant)}</div>
        <div><div class="analysis__label">Devil's Advocate</div>${listHtml(critique.devilsAdvocate)}</div>
        <div><div class="analysis__label">Risk Manager</div>${listHtml(critique.riskManager)}</div>
        <div><div class="analysis__label">Final Analyst</div><p>${esc(critique.final)}</p></div>
      </div>
    </details>

    <details class="analysis__block" data-key="mispricing">
      <summary>8. Điều thị trường có thể đang định giá sai</summary>
      ${listHtml(analysis.mispricing, 'Không phát hiện dấu hiệu định giá sai rõ ràng từ dữ liệu hiện có.')}
    </details>

    <details class="analysis__block" data-key="invalidation" open>
      <summary>9. Điều kiện khiến toàn bộ nhận định mất hiệu lực</summary>
      ${listHtml(analysis.globalInvalidation)}
    </details>

    <details class="analysis__block" data-key="stakes">
      <summary>Kỷ luật &amp; kiểm chứng</summary>
      <div class="analysis__label">Dữ liệu còn thiếu</div>${listHtml([...analysis.stakes.missingData, ...analysis.stakes.technicalGaps])}
      <div class="analysis__label">Rủi ro thiên kiến</div>${listHtml(analysis.stakes.biasRisks)}
      <div class="analysis__label">Cách kiểm chứng</div>${listHtml(analysis.stakes.validationPlan)}
      <div class="analysis__label">Chi phí giả lập (giữ ${cost.holdDays} ngày)</div>
      <p>Phí ${cost.feesRoundTripPct}% + trượt giá ${cost.slippageRoundTripPct}% + funding (long ${cost.fundingCostLongPct ?? '-'}%, short ${cost.fundingCostShortPct ?? '-'}%) → tổng long ${cost.totalLongPct ?? '-'}%, short ${cost.totalShortPct ?? '-'}%.</p>
      <p class="analysis__note">${esc(cost.note)}</p>
    </details>

    <p class="analysis__note">10. ${esc(s.text)} — ${esc(analysis.disclaimer)}</p>
  `;

  // Lần render đầu giữ mặc định trong HTML; các lần sau giữ đúng trạng thái người dùng đã chọn
  if (prevDetails.length) {
    for (const d of analysisReportEl.querySelectorAll('details[data-key]')) {
      d.open = openKeys.has(d.dataset.key);
    }
  }
  analysisMetaEl.textContent = `${analysis.framework} · nến ngày, 1–7 ngày (không đổi theo bộ chọn horizon) · ${new Date(analysis.generatedAt).toISOString().slice(11, 19)} UTC`;
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
    renderScenarios(snapshot.trend);
    renderMappedTrend(snapshot.trend.mappedTrend, snapshot.trend.baseRuleScore);
    renderBacktestTable(snapshot.contract);
    renderPlaybook(snapshot.trend.playbook, snapshot.trend.playbookBasis);
    renderChart(snapshot);

    // Only re-render USDC if data changed
    const currentUsdcData = JSON.stringify(snapshot.usdcMinting || []);
    if (currentUsdcData !== lastUsdcData) {
      renderUSDCFeed(snapshot.usdcMinting || []);
      lastUsdcData = currentUsdcData;
    }

    renderMetrics(snapshot.metrics);
    renderTechnicals(snapshot.technicals);
    renderAnalysis(snapshot.analysis);
    renderCalendar(snapshot.economicCalendar || []);
    renderSignalBreakdown(snapshot.trend.rules || []);

    renderInfoList(reasonsListEl, reasonsCountEl, snapshot.trend.reasons, 'No strong signals detected.');
    renderInfoList(risksListEl, risksCountEl, snapshot.trend.risks, 'No significant warnings.');
    renderInfoList(errorsListEl, errorsCountEl, [...(snapshot.errors || []), ...staleSourceAlerts(snapshot.sources)], 'No errors.');

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

function bindTimeframeButtons() {
  if (!timeframeSelectorEl) return;
  timeframeSelectorEl.addEventListener('change', () => {
    const hours = parseInt(timeframeSelectorEl.value, 10);
    if (!hours || hours === selectedTimeframeHours) return;
    selectedTimeframeHours = hours;
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
      // Update lastUsdcData to reflect current filter state
      lastUsdcData = JSON.stringify(latestSnapshot.usdcMinting || []);
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
    const url = `/api/snapshot?symbol=${selectedSymbol}&timeframe=${selectedTimeframeHours}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fetch failed');
    render(data);
  } catch (err) {
    lastUpdatedEl.textContent = `Error: ${err.message}`;
  }
}

function connectRealtime() {
  const url = `/api/stream?symbol=${selectedSymbol}&timeframe=${selectedTimeframeHours}`;
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
bindTimeframeButtons();
bindUSDCFilters();
connectRealtime();
