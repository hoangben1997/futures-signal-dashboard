# Futures Signal Dashboard (Local)

Dashboard local tổng hợp tín hiệu futures và đưa ra kết luận rule-based:
- `Bearish Bias`
- `Bullish Bias`
- `Sideways / High-Noise`
- **Realtime** qua `SSE` (auto push dữ liệu mới theo chu kỳ)
- **Multi-symbol**: BTCUSDT, ETHUSDT, SOLUSDT
- **Flexible chart**: Chọn timeframe (1h/4h) và số nến (24/48/96)
- **Signal Breakdown**: Chi tiết từng rule với điểm số

## Cài đặt & Chạy

### Yêu cầu
- Node.js >= 20.6 (để hỗ trợ `--env-file` flag)
- Zero dependencies

### Chạy local
```bash
cd /Users/hoangnguyen/workspace/futures-signal-dashboard

# 1. Copy .env.example sang .env (lần đầu)
cp .env.example .env

# 2. Chỉnh sửa .env theo nhu cầu (optional)
# vim .env

# 3. Chạy với env file
pnpm dev
# hoặc
npm run dev

# Hoặc chạy trực tiếp không dùng .env
PORT=7010 REFRESH_MS=5000 npm start
```

Mở trình duyệt: `http://localhost:7010`

## API Endpoints

### `GET /api/health`
Health check endpoint

### `GET /api/snapshot`
Lấy snapshot với query params:
- `symbol`: BTCUSDT | ETHUSDT | SOLUSDT (default: BTCUSDT)
- `limit`: 24 | 48 | 96 (default: 24)

**Example:**
```bash
curl "http://localhost:7010/api/snapshot?symbol=ETHUSDT&limit=48"
```

### `GET /api/stream` (SSE realtime)
Streaming endpoint với params tương tự `/api/snapshot`

**Example:**
```javascript
const es = new EventSource('/api/stream?symbol=BTCUSDT&limit=24');
es.addEventListener('snapshot', (e) => {
  console.log(JSON.parse(e.data));
});
```

## Environment Variables

Tất cả env variables được quản lý trong file `.env` (copy từ `.env.example`).

### Core Settings
- `PORT`: Server port (default: 7000)
- `REFRESH_MS`: Chu kỳ refresh dữ liệu backend (default: 5000ms)
- `USDC_REFRESH_MS`: Chu kỳ refresh riêng cho dữ liệu `USDC TREASURY (72H)` (default: 60000ms)

### USDC On-chain Data (Optional)
- `ETH_RPC_URL`: Ethereum RPC URL (Alchemy/Infura/Ankr) để query on-chain USDC Treasury mint/burn
- `ETH_RPC_FALLBACKS`: Danh sách public RPC (comma-separated) fallback khi cần
- `ETHERSCAN_API_KEY`: Fallback API key Etherscan V2

Thứ tự fallback cho `USDC TREASURY (72H)`:
1. RPC (`ETH_RPC_URL` hoặc `ETH_RPC_FALLBACKS`)
2. Etherscan V2 (nếu có `ETHERSCAN_API_KEY`)
3. Whale Alert JSON (`https://whale-alert.io/alerts.json`) - không cần key

### Database (Future - khi scale)
- `DATABASE_URL`: Postgres connection string
- `DB_POOL_MIN`: Minimum pool size (default: 2)
- `DB_POOL_MAX`: Maximum pool size (default: 10)

**Lưu ý**: File `.env` đã được gitignore, không commit lên git.

## Data inputs

- Binance Futures: funding, OI, long/short ratio, top trader ratio, taker flow, ticker, klines
- Alternative.me: Fear & Greed
- Deribit: BTC perpetual summary
- CoinGecko: market dominance và global context

Ngoài ra UI có link tham chiếu nhanh:
- Whale Alert
- CoinGlass
- CryptoQuant
- Deribit stats

## Scoring Logic (Rule-Based)

Logic tính điểm được tách riêng trong `lib/scoring.js` với ~7-10 rules:

1. **Funding Rate**: High (> 0.08%) = -1 | Low (< -0.08%) = +1
2. **OI Change + Funding**: OI surge + funding → điều chỉnh điểm
3. **Long/Short Ratio (Global)**: Crowd positioning → cộng/trừ điểm
4. **Top Trader L/S**: Top trader bias → signal
5. **Taker Buy/Sell Ratio**: Aggressive flow → cộng/trừ điểm
6. **Fear & Greed**: Extreme levels → contrarian signal
7. **Price Change + Funding**: Pump/dump nóng → pullback risk

**Outlook:**
- Score ≤ -2: **Bearish Bias**
- Score ≥ 2: **Bullish Bias**
- Else: **Sideways / High-Noise**

**Confidence:** `min(90, 45 + |score| × 10)`

## UI Features

### Controls
- **Symbol Selector**: Dropdown chọn BTCUSDT/ETHUSDT/SOLUSDT
- **Candle Limit**: Buttons chọn 24/48/96 nến
- **Timeframe Toggle**: 1h ↔ 4h cho chart

### Sections
- **Metrics Cards**: Price, Funding, OI, L/S ratios, Fear & Greed, etc.
- **Trend Panel**: Outlook + Score + Confidence + Playbook
- **Trade Alerts**: Cảnh báo với level (danger/warn/info)
- **Signal Breakdown**: Chi tiết từng rule (pass/fail + score + reason)
- **Price Chart**: SVG candlestick chart
- **Risk Notes**: Ghi chú rủi ro (volatility, IV cao, etc.)
- **Source Links**: Links tham chiếu nhanh (Whale Alert, CoinGlass, ...)

### Responsive
- Desktop: Full grid layout
- Mobile: Stack layout, tối ưu màn hình nhỏ

## Cấu trúc Project

```
futures-signal-dashboard/
├── server.js              # Backend Node.js thuần
├── lib/
│   └── scoring.js         # Logic tính điểm (rule-based)
├── public/
│   ├── index.html         # UI structure
│   ├── main.js            # Frontend logic
│   └── styles.css         # Styling
├── package.json
└── README.md
```

## Testing

### Quick Test
```bash
# 1. Syntax check
node --check server.js
node --check lib/scoring.js

# 2. Start server
PORT=7010 REFRESH_MS=5000 npm start

# 3. Test endpoints
curl http://localhost:7010/api/health
curl "http://localhost:7010/api/snapshot?symbol=ETHUSDT&limit=48"

# 4. Test UI
# - Mở http://localhost:7010
# - Thử đổi symbol
# - Thử đổi số nến
# - Kiểm tra Signal Breakdown
```

## Mở rộng

### Thêm symbol mới
1. Sửa `server.js` → thêm vào `validSymbols` array
2. Sửa `public/index.html` → thêm `<option>` trong dropdown

### Thêm rule mới
1. Mở `lib/scoring.js`
2. Thêm logic trong hàm `inferTrend()`
3. Push vào `rules` array với format:
   ```javascript
   rules.push({
     name: 'Rule Name',
     pass: true/false,
     score: +1/-1/0,
     reason: 'Explanation'
   });
   ```

## Error Handling

- Backend: `Promise.allSettled()` → không crash khi 1-2 API lỗi
- Frontend: Try-catch wrapper → hiển thị lỗi trong UI
- SSE fallback: Tự chuyển sang polling 10s nếu connection mất

## Lưu ý

- Đây là **rule-based dashboard** phục vụ tham khảo quyết định trade
- **Không phải lời khuyên đầu tư**
- Chưa có backtesting cho scoring logic
- Binance có rate limit → cân nhắc giảm REFRESH_MS nếu dùng lâu dài

---

**Version**: 0.2.0
**Last Updated**: 2026-03-11
