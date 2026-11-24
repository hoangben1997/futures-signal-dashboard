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
- `timeframe`: horizon (giờ) cho phần rule-based: 4 | 8 | 12 | 24 | 72 | 168 (default: 4)

**Example:**
```bash
curl "http://localhost:7010/api/snapshot?symbol=ETHUSDT&timeframe=24"
```

Các field mới từ gói P0 (xem `docs/IMPLEMENTATION_PROGRESS.md`):
- `contract`: hợp đồng hiển thị. `validatedProbabilities: false`, `historicalModel: "disabled"`. `unverifiedFields` liệt kê các field legacy chưa kiểm định (`trend.scenarioProbabilities`, `trend.confidence`, …). Các field này vẫn trả về để tương thích, nhưng **không phải xác suất** và UI không hiển thị chúng dạng %.
- `sources[]`: trạng thái từng nguồn `{ name, ok, fetchedAt, observedAt, stale, error }`. `observedAt` là thời điểm của điểm dữ liệu mới nhất theo nguồn, `fetchedAt` là lúc server nhận. Nguồn USDC/lịch kinh tế lỗi sau khi thử hết fallback thì `ok: false` và, nếu còn dữ liệu cũ, `stale: true`.
- `metrics.historicalScenarioModel` luôn `null`: mô hình lịch sử cũ đã được cách ly vào `lib/historical.js` và chỉ dùng để tái lập/debug offline.

Dữ liệu nguồn được cache theo symbol (TTL = `REFRESH_MS`, gộp request trùng). Các horizon và client cùng symbol dùng chung một lần fetch. Fear & Greed và CoinGecko có TTL riêng 5 phút (nguồn lỗi thì chỉ giữ một chu kỳ `REFRESH_MS`).

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
- `HOST`: Interface để listen (default: `127.0.0.1`, chỉ máy này truy cập được). Đặt `0.0.0.0` để mở cho mạng LAN; dashboard không có xác thực.
- `REFRESH_MS`: Chu kỳ refresh dữ liệu backend (default: 5000ms)
- `USDC_REFRESH_MS`: Chu kỳ refresh riêng cho dữ liệu `USDC TREASURY (72H)` (default: 60000ms)
- `TECHNICALS_REFRESH_MS`: Chu kỳ lấy lại nến đa khung cho phần kỹ thuật + phân tích DiSSS (default: 60000ms)

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

## Kỹ thuật đa khung (`lib/indicators.js`)

- Khung W/D/4H/1H lấy 400 nến từ Binance USDT-M futures. Khung tháng lấy từ **spot**, vì perpetual mới có từ 2019 (~85 nến tháng), còn spot có ~112 nến, đủ MA100 tháng. MA200 tháng không tính được.
- Mỗi khung có: MA50/100/200, thứ tự MA, golden/death cross 50/200, RSI 14 + RSI-MA 14, MACD 12/26/9, volume nến đóng so với trung bình 20 phiên, cấu trúc HH/HL/LH/LL (pivot 3 nến, có phát hiện phá cấu trúc) và Fibonacci theo swing 90 nến.
- Công thức bám theo Pine Script (EMA/RMA khởi tạo bằng SMA). Đã đối chiếu với TradingView: khớp tới 2 chữ số thập phân (test `khớp TradingView` trong `test/indicators.test.js`).
- Có cache theo `TECHNICALS_REFRESH_MS`, không gọi lại Binance mỗi lần SSE refresh.

## Phân tích xu hướng DiSSS (`lib/analysis.js`)

Snapshot có thêm `technicals` và `analysis`. `analysis` là báo cáo rule-based (không dùng LLM) theo khung DiSSS: tóm tắt → bảng nhóm yếu tố → yếu tố chính → 3 kịch bản → vùng giá → tín hiệu theo dõi → tự phản biện → định giá sai → điều kiện vô hiệu → kết luận.

Quy tắc chính:
- Mỗi bằng chứng ghi rõ `fact`/`inference` và `leading`/`coincident`/`lagging`.
- Bằng chứng cùng nguồn dữ liệu được gộp thành một family, mỗi family chỉ góp tối đa ±1 × trọng số (`FAMILY_WEIGHTS`). Ví dụ 5 chỉ báo giá giảm chỉ tính là −1 cho family "giá dài hạn", không phải −5.
- **Xác suất bằng số** chỉ hiển thị khi mô hình thống kê lịch sử có Brier thấp hơn mức đoán đều (0,2222). Ngoài trường hợp đó chỉ dùng mức tin cậy thấp / trung bình / cao.
- Không có nguồn: vĩ mô (DXY, lợi suất, FED), CVD, liquidation heatmap, dòng tiền sàn, tin tức. Các mục này được liệt kê trong `stakes.missingData`, và nhóm vĩ mô luôn ở trạng thái `no_data`.
- Vùng thanh khoản là suy luận từ đỉnh/đáy swing, không phải heatmap thật.

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

**Confidence (`trend.confidence`):** biến đổi của độ lớn điểm quyết định, **không phải xác suất**. Từ gói P0, UI không hiển thị field này. Thanh trên cùng hiển thị "Cường độ điểm" = |`trend.decision.score`| (0–1), và badge lấy đúng `trend.outlook`.

**Xác suất kịch bản (`trend.scenarioProbabilities`):** điểm heuristic được chuẩn hoá cho tổng 100, chưa có định nghĩa outcome và chưa được backtest. UI đã ẩn, panel kịch bản chỉ còn "mức theo dõi" (xem `docs/SYSTEM_AUDIT.md` §3.3).

## UI Features

### Controls
- **Symbol Selector**: Dropdown chọn BTCUSDT/ETHUSDT/SOLUSDT
- **Candle Limit**: Buttons chọn 24/48/96 nến
- **Timeframe Toggle**: 1h ↔ 4h cho chart

### Sections
- **Metrics Cards**: Price, Funding, OI, L/S ratios, Fear & Greed, etc.
- **Trend Panel**: Outlook + Score + Cường độ điểm + mức theo dõi + Playbook (không có xác suất)
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
│   ├── scoring.js         # Logic tính điểm (rule-based, chưa kiểm định)
│   ├── indicators.js      # MA/RSI/MACD/swing/fib (công thức theo TradingView)
│   ├── analysis.js        # Báo cáo DiSSS + tự phản biện
│   ├── stats.js           # Hàm thống kê nhỏ dùng chung
│   └── historical.js      # Mô hình kịch bản lịch sử cũ — đã cách ly, chỉ debug offline
├── test/                  # node --test (npm test), có test qua entry point với fetch giả lập
├── public/
│   ├── index-new.html     # UI structure
│   ├── main-new.js        # Frontend logic (ES module)
│   ├── legacy-view.js     # Dựng text hiển thị phần rule-based (hàm thuần, có test)
│   └── styles-new.css     # Styling
├── package.json
└── README.md
```

## Testing

### Dataset P1 (BTCUSDT 1d, đóng băng theo cutoff)
```bash
node scripts/build-dataset.js --symbol BTCUSDT --interval 1d --cutoff 2026-11-24
```
Ghi vào `data/datasets/` (đã gitignore), kèm manifest có checksum. Spec: `docs/P1_SPEC.md`.

Replay walk-forward (không chạm holdout):
```bash
node scripts/run-replay.js --dataset data/datasets/BTCUSDT-1d-cutoff-2026-11-24.jsonl
```
Report vào `data/reports/`, kết quả hiện tại ở `docs/IMPLEMENTATION_PROGRESS.md`.

### Unit test
```bash
npm test   # node --test, zero dependency
```

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
**Last Updated**: 2026-11-24
