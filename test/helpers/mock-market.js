/**
 * Giả lập các API thị trường cho test qua entry point (getSnapshot / HTTP).
 * Thay globalThis.fetch; request tới localhost đi qua fetch thật.
 */

const realFetch = globalThis.fetch;

const INTERVAL_MS = {
  '1h': 3600e3,
  '4h': 4 * 3600e3,
  '1d': 86400e3,
  '1w': 7 * 86400e3,
  '1M': 30 * 86400e3
};

// Nến tất định: giá dao động quanh `base`, nến cuối là nến đang chạy (closeTime > now).
export function makeKlines(interval, limit, { base = 60000, nowMs = Date.now() } = {}) {
  const step = INTERVAL_MS[interval];
  const lastOpen = Math.floor(nowMs / step) * step;
  const rows = [];
  for (let i = limit - 1; i >= 0; i -= 1) {
    const openTime = lastOpen - (i * step);
    const k = limit - i;
    const close = base * (1 + 0.05 * Math.sin(k / 7) + 0.01 * Math.cos(k / 2));
    const open = base * (1 + 0.05 * Math.sin((k - 1) / 7) + 0.01 * Math.cos((k - 1) / 2));
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    rows.push([openTime, String(open), String(high), String(low), String(close), String(1000 + (k % 13) * 50), openTime + step - 1, '0', 100, '500', '0', '0']);
  }
  return rows;
}

export function defaultResponses(nowMs = Date.now()) {
  const hourly = (n, f) => Array.from({ length: n }, (_, i) => ({ timestamp: nowMs - ((n - i) * 3600e3), ...f(i) }));
  return {
    'fapi.binance.com/fapi/v1/premiumIndex': () => ({ lastFundingRate: '0.0001', markPrice: '60000', nextFundingTime: nowMs + 3600e3, time: nowMs }),
    'fapi.binance.com/fapi/v1/openInterest': () => ({ openInterest: '100000', time: nowMs }),
    'fapi.binance.com/futures/data/openInterestHist': () => hourly(7, (i) => ({ sumOpenInterest: String(98000 + i * 300) })),
    'fapi.binance.com/futures/data/globalLongShortAccountRatio': () => hourly(5, () => ({ longShortRatio: '1.2' })),
    'fapi.binance.com/futures/data/topLongShortPositionRatio': () => hourly(5, () => ({ longShortRatio: '1.1' })),
    'fapi.binance.com/futures/data/takerlongshortRatio': () => hourly(5, () => ({ buySellRatio: '1.0' })),
    'fapi.binance.com/fapi/v1/ticker/24hr': () => ({ lastPrice: '60000', priceChangePercent: '-1.2', closeTime: nowMs }),
    'fapi.binance.com/fapi/v1/klines': (u) => makeKlines(u.searchParams.get('interval'), Number(u.searchParams.get('limit')), { nowMs }),
    'api.binance.com/api/v3/klines': (u) => makeKlines(u.searchParams.get('interval'), Math.min(112, Number(u.searchParams.get('limit'))), { nowMs }),
    'api.alternative.me/fng/': () => ({ data: [{ value: '40', timestamp: String(Math.floor(nowMs / 1000) - 3600) }] }),
    'www.deribit.com/api/v2/public/get_book_summary_by_currency': (u) => ({
      result: [{ instrument_name: `${u.searchParams.get('currency')}-PERPETUAL`, mark_iv: 50, open_interest: 1e9, creation_timestamp: nowMs }]
    }),
    'api.coingecko.com/api/v3/global': () => ({
      data: { market_cap_percentage: { btc: 55 }, total_market_cap: { usd: 2e12 }, total_volume: { usd: 1e11 }, updated_at: Math.floor(nowMs / 1000) - 60 }
    }),
    'whale-alert.io/alerts.json': () => [],
    'nfs.faireconomy.media/ff_calendar_thisweek.json': () => [
      { date: new Date(nowMs + 3600e3).toISOString(), impact: 'High', title: 'CPI m/m <b>test</b>', country: 'USD', forecast: '0.3%', previous: '0.2%' }
    ]
  };
}

/**
 * Cài mock. `overrides[key]` = hàm (URL) → body, hoặc { status } để giả lập lỗi HTTP.
 * Trả { calls, restore } với calls = danh sách URL đã gọi (không gồm localhost).
 */
export function installMockMarket(overrides = {}, nowMs = Date.now()) {
  const routes = { ...defaultResponses(nowMs), ...overrides };
  const calls = [];
  globalThis.fetch = async (input, opts) => {
    const u = new URL(String(input));
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return realFetch(input, opts);
    calls.push(u);
    const route = routes[`${u.hostname}${u.pathname}`];
    if (!route) return new Response('not mocked', { status: 404, statusText: 'Not Found' });
    if (typeof route === 'object' && route.status) {
      return new Response('error', { status: route.status, statusText: 'Mock Error' });
    }
    const body = route(u);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  return {
    calls,
    count: (key) => calls.filter((u) => `${u.hostname}${u.pathname}` === key).length,
    restore: () => { globalThis.fetch = realFetch; }
  };
}
