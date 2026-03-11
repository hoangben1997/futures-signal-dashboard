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

let pollTimer = null;
let selectedTf = '1h';
let selectedSymbol = 'BTCUSDT';
let selectedTimeframeHours = 4;
let selectedUsdcFilter = 'MINT';
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
  const { trend } = snapshot;

  // Outlook Badge
  const scoreForOutlook = Number(trend.decision?.score);
  if (Number.isFinite(scoreForOutlook) && scoreForOutlook >= 0.25) {
    outlookBadgeEl.textContent = 'BULLISH';
    outlookBadgeEl.setAttribute('data-outlook', 'BULLISH BIAS');
  } else if (Number.isFinite(scoreForOutlook) && scoreForOutlook <= -0.25) {
    outlookBadgeEl.textContent = 'BEARISH';
    outlookBadgeEl.setAttribute('data-outlook', 'BEARISH BIAS');
  } else {
    outlookBadgeEl.textContent = 'SIDEWAYS';
    outlookBadgeEl.setAttribute('data-outlook', 'SIDEWAYS');
  }

  // Confidence
  const confidence = Number(trend.confidence);
  confidenceValueEl.textContent = Number.isFinite(confidence)
    ? `${confidence.toFixed(1)}%`
    : '--%';

  // Score
  const score = Number(trend.score);
  scoreValueEl.textContent = Number.isFinite(score) ? score.toFixed(2) : '--';

  // Signals Count
  const activeRuleSignals = (trend.rules || []).filter((r) => r.pass).length;
  const mappedSignals = Object.values(trend.mappedTrend?.components || {})
    .filter((v) => Number.isFinite(v) && Math.abs(v) >= 0.35).length;
  signalsCountEl.textContent = activeRuleSignals + mappedSignals;

  // Last Updated
  const time = new Date(snapshot.generatedAt);
  lastUpdatedEl.textContent = time.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Render Scenario Probabilities
function renderScenarios(scenarios, breakoutLevels, scenarioMeta) {
  scenarioListEl.innerHTML = '';
  if (!Array.isArray(scenarios) || !scenarios.length) {
    scenarioListEl.innerHTML = '<p style="color: var(--color-text-tertiary);">No scenario data</p>';
    return;
  }

  // Render breakout levels first if available
  if (breakoutLevels && breakoutLevels.currentPrice) {
    const levelsBox = document.createElement('div');
    levelsBox.className = 'breakout-levels';
    levelsBox.innerHTML = `
      <div class="breakout-levels__header">Ngưỡng xác nhận ${breakoutLevels.timeframeLabel} tiếp theo</div>
      <div class="breakout-levels__grid">
        <div class="breakout-level bullish">
          <div class="breakout-level__label">Đóng trên</div>
          <div class="breakout-level__price">$${nf.format(breakoutLevels.bullishAbove)}</div>
          <div class="breakout-level__note">→ Xu hướng tăng</div>
        </div>
        <div class="breakout-level bearish">
          <div class="breakout-level__label">Đóng dưới</div>
          <div class="breakout-level__price">$${nf.format(breakoutLevels.bearishBelow)}</div>
          <div class="breakout-level__note">→ Xu hướng giảm</div>
        </div>
      </div>
      <div class="breakout-levels__footer">
        Nến đóng: $${nf.format(breakoutLevels.basePrice)} | Giá hiện tại: $${nf.format(breakoutLevels.currentPrice)} | Ngưỡng: ±${breakoutLevels.thresholdPct}%
      </div>
    `;
    scenarioListEl.appendChild(levelsBox);
  }

  // Render probability bars
  const probabilityHeader = document.createElement('div');
  probabilityHeader.className = 'scenario-probability-header';
  let headerText = 'Xác suất kịch bản';
  if (scenarioMeta?.source === 'historical+heuristic') {
    const n = Number(scenarioMeta.sampleSize || 0);
    const mode = scenarioMeta.mode === 'conditional' ? 'có điều kiện' : 'không điều kiện';
    const w = Number(scenarioMeta.historicalWeight || 0);
    const f = Number(scenarioMeta.formulaScore || 0);
    headerText += ` (Thống kê 1 năm: n=${n}, ${mode}, w=${w}, f=${f.toFixed(3)})`;
  }
  probabilityHeader.textContent = headerText;
  scenarioListEl.appendChild(probabilityHeader);

  if (scenarioMeta?.drivers) {
    const metaBox = document.createElement('div');
    metaBox.className = 'scenario-meta';
    const driverOrder = ['trend', 'momentum', 'position', 'volatility'];
    const labels = { trend: 'Trend', momentum: 'Momentum', position: 'Position', volatility: 'Volatility' };
    const chips = driverOrder.map((k) => {
      const d = scenarioMeta.drivers[k];
      if (!d) return null;
      const edge = Number(d.edge || 0);
      const tone = edge > 0.01 ? 'bullish' : edge < -0.01 ? 'bearish' : 'neutral';
      return `<span class="scenario-meta__chip scenario-meta__chip--${tone}">${labels[k]}:${d.state} (${signed(edge, 3)})</span>`;
    }).filter(Boolean).join('');
    metaBox.innerHTML = chips;
    scenarioListEl.appendChild(metaBox);
  }

  const severityMap = {
    'Tăng': 'low',
    'Giảm': 'high',
    'Sideway': 'info'
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
function renderPlaybook(playbook, basis) {
  playbookTextEl.textContent = playbook || 'No playbook available.';
  if (!playbookBasisEl) return;
  playbookBasisEl.innerHTML = '';

  if (!basis) return;

  const labels = {
    structure: 'Cấu trúc',
    derivatives: 'Phái sinh',
    regime: 'Bối cảnh thị trường',
    macroTime: 'Vĩ mô/Thời điểm'
  };

  const lines = [];
  if (Array.isArray(basis.factors) && basis.factors.length) {
    const top = basis.factors.slice(0, 3).map((f) =>
      `${labels[f.key] || f.key}: ${signed(f.component)} × ${f.weight.toFixed(2)} = ${signed(f.contribution, 3)}`
    );
    lines.push(`Yếu tố chính: ${top.join(' | ')}`);
  }

  if (basis.scenario?.source === 'historical+heuristic') {
    lines.push(
      `Xác suất: thống kê 1 năm (${basis.scenario.mode === 'conditional' ? 'có điều kiện' : 'không điều kiện'}, n=${basis.scenario.sampleSize}, trọng số=${basis.scenario.historicalWeight})`
    );
  } else if (basis.scenario?.source) {
    lines.push(`Xác suất: ${basis.scenario.source}`);
  }

  if (basis.confirmation) {
    lines.push(
      `Ngưỡng xác nhận ${String(basis.confirmation.timeframe || '').toUpperCase()}: đóng trên ${money(basis.confirmation.bullishAbove)}, đóng dưới ${money(basis.confirmation.bearishBelow)}, ngưỡng ±${basis.confirmation.thresholdPct}%`
    );
  }

  if (Array.isArray(basis.activeRules) && basis.activeRules.length) {
    const ruleText = basis.activeRules
      .slice(0, 3)
      .map((r) => `${r.name} (${signed(Number(r.score || 0), 0)})`)
      .join(' | ');
    lines.push(`Quy tắc đang tác động: ${ruleText}`);
  }

  if (basis.decision) {
    lines.push(
      `Điểm quyết định: ${signed(Number(basis.decision.score || 0), 3)} | Chênh xác suất (Tăng-Giảm): ${signed(Number(basis.decision.probEdge || 0), 3)} | Tín hiệu xác nhận: ${signed(Number(basis.decision.confirmSignal || 0), 3)} | Hệ số chất lượng: ${Number(basis.decision.qualityAdj || 0).toFixed(3)} | Ngưỡng nhẹ/mạnh: ${Number(basis.decision.thresholds?.weak || 0).toFixed(3)}/${Number(basis.decision.thresholds?.strong || 0).toFixed(3)}`
    );
  }

  for (const line of lines) {
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

function renderBacktestTable(model) {
  if (!backtestTableEl) return;
  backtestTableEl.innerHTML = '';
  const byTf = model?.byTimeframe || {};
  const rows = ['4h', '8h', '12h', '1d', '3d', '1w']
    .map((tf) => ({ tf, bt: byTf[tf]?.backtest || null }))
    .filter((x) => x.bt && Number.isFinite(x.bt.testSamples));

  if (!rows.length) {
    backtestTableEl.innerHTML = '<p style="color: var(--color-text-tertiary);">No backtest stats</p>';
    return;
  }

  const box = document.createElement('div');
  box.className = 'backtest-box';
  const title = document.createElement('div');
  title.className = 'backtest-box__title';
  title.textContent = 'Kiểm định (1 năm, chia theo thời gian)';
  box.appendChild(title);

  const table = document.createElement('table');
  table.className = 'backtest-box__table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>TF</th>
        <th>Mẫu test</th>
        <th>Độ đúng%</th>
        <th>Độ đúng hướng%</th>
        <th>Brier</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td>${String(r.tf).toUpperCase()}</td>
          <td>${r.bt.testSamples}</td>
          <td>${Number(r.bt.top1AccuracyPct || 0).toFixed(1)}</td>
          <td>${Number(r.bt.directionalAccuracyPct || 0).toFixed(1)}</td>
          <td>${Number(r.bt.brierScore || 0).toFixed(4)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
  box.appendChild(table);
  backtestTableEl.appendChild(box);
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
    row.innerHTML = `
      <td class="calendar-table__date">${event.date || '-'}</td>
      <td class="calendar-table__time">${event.time || '-'}</td>
      <td><span class="calendar-table__currency">${event.currency || '-'}</span></td>
      <td class="calendar-table__title">${event.title || '-'}</td>
      <td class="calendar-table__impact">${event.impact || '-'}</td>
      <td class="calendar-table__value calendar-table__value--actual">${event.actual || '-'}</td>
      <td class="calendar-table__value">${event.forecast || '-'}</td>
      <td class="calendar-table__value">${event.previous || '-'}</td>
    `;
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
    renderScenarios(
      snapshot.trend.scenarioProbabilities || [],
      snapshot.trend.breakoutLevels,
      snapshot.trend.scenarioMeta
    );
    renderMappedTrend(snapshot.trend.mappedTrend, snapshot.trend.baseRuleScore);
    renderBacktestTable(snapshot.metrics?.historicalScenarioModel);
    renderPlaybook(snapshot.trend.playbook, snapshot.trend.playbookBasis);
    renderChart(snapshot);
    renderUSDCFeed(snapshot.usdcMinting || []);
    renderMetrics(snapshot.metrics);
    renderCalendar(snapshot.economicCalendar || []);
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
