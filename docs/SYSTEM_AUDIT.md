# SYSTEM AUDIT — Futures Signal Dashboard

- Ngày audit: 2026-11-24. Phạm vi: working tree hiện tại (gồm thay đổi chưa commit: `lib/analysis.js`, `lib/indicators.js`, `test/` đều là file mới; `server.js`, `public/*-new.*` đang sửa dở).
- Cách kiểm: đọc toàn bộ `server.js`, `lib/*.js`, các phần render của `public/main-new.js`; chạy `npm test`; chạy server thật ở cổng 7999 và gọi `/api/snapshot`; chạy script tạm (`tmp_audit/`, đã xoá sau audit theo quy ước repo) để backtest mô hình lịch sử bằng dữ liệu public của Binance. Cách tái lập: chép nguyên văn `server.js:632-987`, thêm `function clamp`, chạy `buildHistoricalTfStats` với cửa sổ 380 ngày (4h) và 420 ngày (1d), ngưỡng = p75 của |move| trong 30 ngày gần nhất, rồi so với climatology (tần suất của tập train 70% áp lên tập test 30%).
- Quy ước: **[Đã kiểm]** = có file:line hoặc lệnh đã chạy. **[Suy luận]** = nhận định/đề xuất, chưa đo.

Tài liệu liên quan: [GAP_ANALYSIS](GAP_ANALYSIS.md) · [TARGET_ARCHITECTURE](TARGET_ARCHITECTURE.md) · [PROBABILITY_MODEL_DESIGN](PROBABILITY_MODEL_DESIGN.md) · [VALIDATION_STRATEGY](VALIDATION_STRATEGY.md) · [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md)

---

## 0. Tóm tắt dễ hiểu

Dashboard hiện tại **mô tả thị trường khá tốt** (chỉ báo đa khung khớp TradingView, báo cáo DiSSS có gộp tín hiệu trùng nguồn) nhưng **chưa dự báo được gì có kiểm chứng**:

1. **Con số xác suất to nhất trên màn hình là số tự chế.** Lúc 2026-11-24, BTC khung 1d hiện "Giảm 61,2% / Sideway 24,9% / Tăng 13,9%" và "Confidence 66,4%". Ba con số này lấy từ `33,3 ± pressure × 15` (`lib/scoring.js:176-183`), sau đó chuẩn hoá cho tổng bằng 100. Chúng không có nguồn thống kê nào. Để so sánh: trong 1 năm qua, số ngày BTC giảm quá ngưỡng 2,53% chỉ chiếm khoảng **11–13%**.
2. **Mô hình thống kê lịch sử bị crash mỗi lần chạy.** Hàm `clamp` được gọi ở `server.js:806` nhưng không được định nghĩa trong `server.js`. Kết quả: `historicalScenarioModel = null` và snapshot báo lỗi `Historical scenario model lỗi: clamp is not defined` [Đã kiểm: gọi API thật]. Bảng backtest trên UI vì thế luôn trống.
3. **Kể cả khi sửa crash, mô hình lịch sử cũng không có giá trị dự báo.** Backtest lại bằng chính code đó: Brier gần như bằng baseline "đoán theo tần suất lịch sử" (chênh ±0,003, thua ở 5/15 trường hợp). Mô hình luôn chọn "Sideway" (độ chính xác theo hướng = 0%). Riêng cổng `hasSkill` (so với đoán đều 1/3) thì **luôn qua**, nên sau khi sửa `clamp`, UI sẽ bắt đầu gắn nhãn "Thống kê: x%" như thể đã chứng minh được giá trị.
4. **Không lưu bất kỳ dự báo nào.** Không có DB và không ghi file (grep `writeFile|appendFile|sqlite|pg` không thấy kết quả). Vì vậy không thể đo độ chính xác thực tế và không thể chứng minh dự báo không bị sửa sau khi đã biết kết quả.

Kết luận: việc đầu tiên **không phải** thêm chỉ báo. Việc đầu tiên là (a) ngừng hiển thị xác suất không có cơ sở, (b) dựng pipeline nhãn/baseline/walk-forward, (c) bắt đầu lưu dự báo ngay để có dữ liệu kiểm chứng tương lai.

---

## 1. Cấu trúc repository

| Thành phần | File | Dòng | Vai trò |
|---|---|---|---|
| Backend | `server.js` | 1614 | HTTP server Node thuần, gọi API ngoài, mô hình lịch sử, SSE |
| Rule scoring | `lib/scoring.js` | 671 | `inferTrend()`: 7 rule + trend mapping + "xác suất kịch bản" + decision |
| Chỉ báo | `lib/indicators.js` | 331 | SMA/EMA/RSI/MACD theo Pine, swing, cấu trúc HH/HL, fib, đặc điểm nến |
| Báo cáo DiSSS | `lib/analysis.js` | 844 | Bằng chứng → family → kịch bản → vùng giá → tự phản biện |
| Frontend | `public/index-new.html`, `main-new.js`, `styles-new.css` | ~2900 | Vanilla JS, SSE, fallback polling 10s |
| CSS thừa | `public/styles.css` | 707 | Không còn file HTML nào dùng (`index.html` đã xoá ở commit 39bebee) |
| Test | `test/indicators.test.js`, `test/analysis.test.js` | 294 | 20 test, `npm test` → **20 pass / 0 fail** [Đã kiểm] |
| DB / jobs / queue / ML / LLM | — | — | **Không có** |

Hệ thống không có dependency nào (`package.json` không có `dependencies`) và chạy với Node ≥ 18. Nếu dùng `--env-file` thì cần Node ≥ 20.6 (README).

## 2. Luồng dữ liệu hiện tại

```
Trình duyệt ──SSE /api/stream?symbol&timeframe──► server.js
                                                    │ setInterval(refreshAllClients, REFRESH_MS=5s)  (server.js:1613)
                                                    ▼
                                           getSnapshot(symbol, tfHours)  (server.js:1249)
   ┌───────────────────────────────────────────────┼──────────────────────────────────────────┐
   │ 16 request song song (Promise.allSettled, server.js:1282-1316)                            │
   │  Binance fapi: premiumIndex, openInterest, openInterestHist(1h×7), globalLS(1h×5),        │
   │  topTraderLS(1h×5), takerRatio(1h×5), ticker24h, klines 1h/4h/1d/1w                       │
   │  alternative.me F&G · Deribit book summary · CoinGecko global                             │
   │  USDC treasury (RPC→Etherscan→Whale Alert, cache 1h) · lịch kinh tế (ForexFactory, cache 4h)│
   └───────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                    ▼
                         metrics (server.js:1396-1432)
                           ├─► getHistoricalScenarioModel()  ✗ crash "clamp is not defined" (server.js:806)
                           ├─► getTechnicals(): klines 1M(spot)/1w/1d/4h/1h ×400 → summarizeTimeframe (cache 60s)
                           ├─► buildMarketReport()  (lib/analysis.js:669)  → snapshot.analysis
                           └─► inferTrend(metrics, tfHours)  (lib/scoring.js:459) → snapshot.trend
                                                    ▼
                                    JSON snapshot → render() (main-new.js:934)
```

Những điểm quan trọng [Đã kiểm]:
- Mỗi nhóm client (symbol × timeframe) gọi lại toàn bộ `getSnapshot` **mỗi 5 giây**, tức khoảng 16 request ngoài mỗi chu kỳ (chưa tính cache). Riêng CoinGecko global bị gọi khoảng 12 lần/phút. Rate limit của CoinGecko free [Chưa kiểm] có thể làm request bị lỗi định kỳ.
- Không có tầng lưu trữ, nên mọi thứ chỉ sống trong RAM. Restart server là mất cache.
- Hai "bộ não" chạy song song và có thể mâu thuẫn nhau trên cùng một màn hình (xem §4.3).

## 3. Kiểm toán từng module

### 3.1 `lib/indicators.js` — **giữ nguyên, chất lượng tốt**
- SMA/EMA/RMA khởi tạo bằng SMA, giống Pine (`indicators.js:43-73`). Có test khớp TradingView tới 2 chữ số thập phân (`test/indicators.test.js:45`).
- `klinesToCandles` đếm số nến đã đóng theo `closeTime <= now` (`:312-330`). Cấu trúc HH/HL và "nến đóng gần nhất" chỉ dùng nến đã đóng (`:256, 277, 301-302`). Đây là cách làm đúng.
- **Vấn đề 1:** MA, RSI, MACD, cross và vị trí giá so với MA tính **cả nến đang chạy** (`:246-258`, có ghi "giống chart"). Để hiển thị thì ổn, nhưng các giá trị này được đưa thẳng vào bằng chứng của `analysis.js` (ví dụ "giá dưới MA200 tuần" có trọng số 2, `analysis.js:91-96`). Hệ quả: tín hiệu tuần/tháng đổi liên tục trong tuần, trong khi người đọc tưởng đó là kết luận lúc đóng nến. Đây là **incomplete-candle bias** nếu sau này đem dữ liệu này đi huấn luyện.
- **Vấn đề 2:** `findSwings` cần `strength=3` nến bên phải mới xác nhận pivot (`:111-127`). Code có ghi chú điều này, nhưng khi backtest phải dùng thời điểm *xác nhận* chứ không phải thời điểm *xảy ra* pivot, nếu không sẽ dính look-ahead.
- Thiếu: ATR, CLV/body/wick ratio dưới dạng series, relative volume cho mọi khung (đang chỉ có `lastClosedVolRatio`), các khung 15m/8h/12h/3d.

### 3.2 `lib/analysis.js` — **giữ phần cấu trúc, sửa cổng xác suất**
Điểm tốt [Đã kiểm]:
- Mỗi bằng chứng có gắn `kind` (fact/inference) và `timing` (`:83-85`).
- Gộp theo family và chặn trần ±1 (`aggregateFamilies`, `:308-329`). Ví dụ 5 chỉ báo giá cùng giảm chỉ tính là −1. Cách này trực tiếp chống đếm trùng tín hiệu, có test ở `test/analysis.test.js:52`.
- Mức tin cậy dùng nhãn thấp/trung bình/cao chứ không dùng %. Có liệt kê dữ liệu còn thiếu (`MISSING_DATA`, `:39-47`) và có phần tự phản biện.

Vấn đề:
- **Cổng giá trị dự báo sai baseline (P0).** `hasSkill = brier < UNIFORM_BRIER (2/9)` (`:50, :559`). Vì nhãn Sideway chiếm 75–85% (do ngưỡng = p75 biến động, xem §4.2), baseline "đoán đều" là quá dễ. Đo thực tế: mô hình đạt Brier 0,08–0,14, nhưng baseline tần suất cũng đạt 0,08–0,13 (§4.2). Nghĩa là cổng này *luôn* qua, nên `statisticalProbabilityPct` (`:541-546`) sẽ luôn hiện ra khi `clamp` được sửa.
- Bằng chứng được "lượng hoá" bằng trọng số tay (`FAMILY_WEIGHTS`, `:14-24`), ngưỡng RSI 30/70, funding −0,01%/0,05%, L/S 0,7/1,8. Code tự thừa nhận các ngưỡng này chưa được kiểm định (`:746`). Mặt tốt là chúng chỉ dùng cho nhãn tin cậy định tính.
- Ngưỡng funding ở đây (−0,01% / 0,05%, `:219-222`) **khác** ngưỡng ở `scoring.js` (±0,08%, `scoring.js:468-475`). Cùng một dữ liệu nhưng hai bộ não diễn giải khác nhau.
- `regime` chỉ là giá so với MA200 tuần cộng thứ tự MA50/200 (`:796-799`), không có volatility regime.
- `buildKeyLevels` (`:387-449`): vùng giá gom từ MA, swing, fib, mốc tròn, và độ mạnh = số loại nguồn trùng nhau. Không có PDH/PDL/PWH/PWL/PMH/PML, open ngày/tuần/tháng, VWAP, volume profile, không đếm số lần chạm, độ rộng vùng không chuẩn hoá theo ATR.
- `validationPlan` (`:835-839`) chỉ là chữ, chưa được hiện thực.

### 3.3 `lib/scoring.js` — **nguồn chính của sai lệch, cần refactor**
Luồng tính [Đã kiểm]:
1. Rule score (`:466-615`): 7 rule, mỗi rule ±1/±2, tổng lại thành `score`.
2. `mapTrendByTimeframe` (`:263-320`): structure (close change), derivatives (funding, taker, OI, L/S), regime (BTC dominance, giá 24h), macroTime (F&G, vol).
3. `finalScore = score × 0.55 + mapped × 1.8` (`:630`).
4. `computeScenarioProbabilities` (`:88-242`): `pressure = score/5 + weightedChange/6 + takerTilt + fundingTilt`, sau đó `bull = 33,3 + 15·pressure`, `bear = 33,3 − 15·pressure`, `side = 33,3 − 8·|pressure|`, rồi chuẩn hoá. Nếu có mô hình lịch sử thì trộn với trọng số 0,45–0,72 theo số mẫu (`:191-204`). Hiện tại mô hình lịch sử crash nên chỉ còn heuristic.
5. `deriveDecision` (`:425-457`): `0,45·scoreNorm + 0,35·probEdge + 0,2·confirmSignal`, nhân với `qualityAdj`.
6. `confidence = min(92, 42 + |decision| × 58)` (`:659`), hiển thị trên UI là **"66,4%"** (`main-new.js:99-101`).

Vấn đề:
- **Điểm tuỳ ý bị đổi thành xác suất (P0).** Bước 4 và bước 6 tạo ra con số có ký hiệu % mà không có định nghĩa outcome và không được backtest. Header UI còn ghi "Xác suất kịch bản (Thống kê 1 năm …)" khi có mô hình lịch sử (`main-new.js:156-163`), dù phần được backtest chỉ là thành phần lịch sử chứ không phải con số sau khi trộn.
- **Đếm trùng (P0).** Funding được tính 3 lần: rule 1 (`:467`), `derivatives` trong mapping (`:277`), `fundingTilt` (`:114`). Taker cũng tính 3 lần (rule 5, mapping `:278`, `takerTilt` `:113`). `score` vào `finalScore`, `finalScore` vào `pressure` rồi thành `probEdge`, và `deriveDecision` cộng *cả* `scoreNorm` *lẫn* `probEdge` (`:438`). Tức là cùng một thông tin đi qua hai đường rồi được cộng lại.
- **Thiên lệch cấu trúc về phía giảm (P0).** `fundingTilt = −0,25` và `derivatives −0,7` cho **mọi** funding dương (`:114, :277`). Funding Binance mặc định khoảng +0,01%/8h và phần lớn thời gian là dương [Suy luận, cần đo tần suất bằng `fapi/v1/fundingRate`]. Vì vậy hệ thống có sẵn một lực đẩy về phía giảm ngay cả khi thị trường trung tính. Snapshot lúc audit: funding +0,0023% (gần như 0) vẫn tính thành −0,7.
- Ngưỡng theo symbol được chỉnh tay (`tunedDecisionThresholds`, `:412-418`: BTC −0,01, SOL +0,01/+0,02) mà không có dữ liệu nào chứng minh.
- `outlook` dùng ngưỡng `weakTh` đã "tune" (`:637`), còn badge trên UI dùng hằng số 0,25 (`main-new.js:86-91`). Hai bên có thể hiển thị khác nhau.
- "Momentum" của khung 8h/12h là `closeChange4h`, tức thay đổi của **nến 4h đang chạy** (`server.js:1195-1200` lấy kline cuối chưa đóng). Đây là incomplete-candle bias.

### 3.4 `server.js` — mô hình lịch sử (`:632-1122`)
Thiết kế: ngưỡng = p75 của |biến động| trong 30 ngày gần nhất (`:1387-1394`). Mẫu là mọi nến trong khoảng 365 ngày, gắn nhãn up/down/sideway theo forward return (`:916-987`). State gồm momentum sign, vol cao/thấp, trend EMA20/50, vị trí trong range 90 nến. Xác suất = tần suất có điều kiện, cộng thêm `tilt = formulaScore × 12` (`:811`).

Lỗi và rủi ro [Đã kiểm trừ khi ghi khác]:

| # | Vấn đề | Bằng chứng | Hậu quả |
|---|---|---|---|
| H1 | `clamp` không được định nghĩa | `server.js:806`; API trả `errors: ['Historical scenario model lỗi: clamp is not defined']` | Toàn bộ mô hình lịch sử và backtest không bao giờ chạy |
| H2 | Không thắng baseline tần suất | Backtest tái lập, xem §4.2 | Kể cả khi sửa H1, xác suất có điều kiện không có thêm thông tin |
| H3 | Nhãn dùng ngưỡng tính từ 30 ngày gần nhất áp cho cả năm | `:1387-1394` → `:1058-1065` | Nhãn quá khứ phụ thuộc dữ liệu tương lai (leakage nhẹ). Tỉ lệ lớp bị quyết định bởi giai đoạn vol gần nhất |
| H4 | `medianVol` tính trên toàn bộ mẫu, gồm cả tập test | `:962` | Leakage vào backtest |
| H5 | Split 70/30 duy nhất, không purge/embargo, mẫu chồng lấn | `:827`; horizon 7 bar với bước 1 bar | Khung 1w: 120 mẫu test thực chất chỉ ~17 mẫu độc lập. Brier không đáng tin |
| H6 | Lệch đặc trưng giữa lúc train và lúc dùng (train/serve skew) | Train: momentum = thay đổi `horizonBars` nến (`:932`), vol = std theo nến gốc (`:942`). Live: 8h/12h dùng `closeChange4h`, 3d dùng `closeChange1d`, 1w dùng `closeChange1w` của **nến tuần đang chạy** (`:1067-1073`); vol live nhân `√(h/24)` (`:1075-1082`) trong khi train không nhân | State live gần như luôn rơi vào "vol cao" ở khung 3d/1w. Xác suất tra sai ô |
| H7 | `tilt × 12` và `normalize3` sàn 0,5% | `:731-740, :811-816` | Lại thêm một bước biến điểm thành xác suất |
| H8 | `directionalAccuracyPct` = 0 ở mọi khung | eval §4.2 | Mô hình luôn đoán Sideway. Ngưỡng tune theo `dirAcc` ở `scoring.js:393-401` đang dựa trên một số vô nghĩa |
| H9 | `emaSeries` khởi tạo bằng giá trị đầu, khác `indicators.ema` khởi tạo bằng SMA | `server.js:742-754` vs `indicators.js:67` | Hai định nghĩa EMA trong cùng hệ thống |
| H10 | `realizedVol24h` thực chất tính trên 72 nến 1h | `:1162-1170` (đầu vào là `kline1hV` với limit 72) | Tên gây hiểu nhầm, nhưng không sai nghiêm trọng |
| H11 | Chỉ có 1 năm dữ liệu | `:1036-1041` | Gần như chỉ một regime, không đánh giá được theo regime |

### 3.5 Nguồn dữ liệu (Market Intelligence)

| Nhóm | Hiện có | Nguồn | Lịch sử để backtest? | Ghi chú |
|---|---|---|---|---|
| Spot/Futures OHLCV | Có | Binance fapi + spot (1M) | Có, đầy đủ (futures từ 2019-09) | 1M lấy từ spot, các khung khác lấy từ futures: trộn hai nguồn, đã ghi trong README |
| Funding | Có (giá trị tức thời) | `premiumIndex.lastFundingRate` | Có, `fapi/v1/fundingRate` cho lịch sử đầy đủ [Suy luận từ tài liệu Binance, chưa gọi] | Chưa dùng lịch sử |
| Open Interest | Có (6h) | `openInterestHist` 1h×7 | **Không**: Binance chỉ giữ ~30 ngày cho nhóm `futures/data/*` [Theo tài liệu, cần kiểm lại] | Muốn backtest thì phải **tự lưu từ bây giờ** |
| L/S ratio, top trader, taker ratio | Có (1h) | `futures/data/*` | Không (~30 ngày, như trên) | Như trên |
| CVD | Không | — | **Proxy có được**: kline cột `[9]` taker buy base volume → delta = 2·takerBuy − volume | Giá trị cao, chi phí thấp, chưa dùng |
| Liquidations | Không | — | Không miễn phí (chỉ có WS `forceOrder` realtime) | Chỉ có link CoinGlass |
| Order book imbalance | Không | — | Chỉ realtime | Chi phí cao (WS + lưu trữ), giá trị cho horizon ≥ 4h thấp [Suy luận] |
| Spot/Futures divergence, basis | Một phần (`markPrice`, chưa dùng) | — | Có (klines spot + futures) | Rẻ |
| BTC Dominance | Có (tức thời) | CoinGecko | Không (bản miễn phí không có lịch sử) | Đang dùng trong `scoring.js:284-290` với ngưỡng tay 52/56 |
| Stablecoin | USDC treasury mint/burn 72h | RPC / Etherscan / Whale Alert | Có qua RPC, nhưng chậm | Proxy hẹp. DefiLlama stablecoins có lịch sử tổng cung [Suy luận] |
| ETF flow | Không | — | Có dạng daily (scrape) | Horizon ≥ 3d |
| Macro (DXY, yields, CPI) | Chỉ có lịch sự kiện | ForexFactory JSON | FRED có lịch sử daily (cần key miễn phí) | Giá trị cho horizon ≤ 24h thấp [Suy luận] |
| Sentiment | Fear & Greed | alternative.me | Có lịch sử (`?limit=0`) [Suy luận] | Cập nhật daily |
| Options IV | Deribit mark_iv của **future** perpetual | Deribit | — | `mark_iv` trên instrument future có thể không có nghĩa. DVOL mới là chỉ số IV đúng [Chưa kiểm] |

## 4. Kiểm chứng định lượng

### 4.1 Snapshot thật (BTCUSDT, timeframe 24h, 2026-11-24)
Lệnh: `PORT=7999 node server.js` rồi `curl /api/snapshot?symbol=BTCUSDT&timeframe=24`.
- `errors`: `["Historical scenario model lỗi: clamp is not defined"]`
- `trend.scenarioProbabilities`: Giảm 61,2 · Sideway 24,9 · Tăng 13,9 (`scenarioMeta.source = "heuristic"`)
- `trend.confidence` = 66,36. `analysis.summary.confidence` = `"low"` ("độ tin cậy thấp, đã hạ do 2 mâu thuẫn")
- `mappedTrend.components.derivatives` = −1,75, với funding = +0,0023% và taker = 0,93

Như vậy cùng một màn hình đang nói "tin cậy 66%" ở thanh trên và "tin cậy thấp" ở báo cáo.

### 4.2 Backtest mô hình lịch sử sau khi vá `clamp` (script tạm, không sửa code chính)
Script chép nguyên văn `server.js:632-987` và thêm `clamp`. Dữ liệu là cửa sổ 380/420 ngày giống production, chạy lúc 2026-11-24. Brier theo quy ước của code (trung bình 3 lớp). Đoán đều = 0,2222.

| Symbol | Horizon | Ngưỡng % | Brier mô hình | Brier climatology | Tần suất test U/D/S % | Mẫu test (≈ độc lập) |
|---|---|---|---|---|---|---|
| BTC | 4h | 0,91 | 0,0925 | 0,0949 | 6,2 / 9,4 / 84,4 | 678 (678) |
| BTC | 12h | 1,60 | 0,1004 | 0,1022 | 7,7 / 9,4 / 82,9 | 678 (226) |
| BTC | 1d | 2,35 | **0,1041** | 0,1014 | 6,6 / 10,7 / 82,8 | 122 (122) |
| BTC | 3d | 4,50 | 0,0949 | 0,0983 | 8,3 / 8,3 / 83,5 | 121 (40) |
| BTC | 1w | 9,47 | 0,0984 | 0,1022 | 10,0 / 6,7 / 83,3 | 120 (17) |
| ETH | 4h | 1,11 | 0,1047 | 0,1048 | 7,8 / 9,7 / 82,4 | 678 (678) |
| ETH | 12h | 2,08 | 0,1068 | 0,1072 | 7,7 / 10,6 / 81,7 | 678 (226) |
| ETH | 1d | 3,75 | 0,0900 | 0,0925 | 6,6 / 9,0 / 84,4 | 122 (122) |
| ETH | 3d | 5,41 | **0,1083** | 0,1070 | 9,1 / 8,3 / 82,6 | 121 (40) |
| ETH | 1w | 12,52 | 0,0795 | 0,0813 | 6,7 / 6,7 / 86,7 | 120 (17) |
| SOL | 4h | 1,47 | 0,1013 | 0,1021 | 8,1 / 9,4 / 82,4 | 678 (678) |
| SOL | 12h | 2,45 | 0,1151 | 0,1158 | 10,8 / 9,6 / 79,6 | 678 (226) |
| SOL | 1d | 3,18 | **0,1381** | 0,1326 | 12,3 / 11,5 / 76,2 | 122 (122) |
| SOL | 3d | 5,98 | **0,1214** | 0,1183 | 10,7 / 9,9 / 79,3 | 121 (40) |
| SOL | 1w | 10,43 | **0,1259** | 0,1240 | 13,3 / 8,3 / 78,3 | 120 (17) |

(Số **đậm** = mô hình thua climatology.)

Cách đọc bảng:
- Climatology nghĩa là "luôn đoán theo tỉ lệ up/down/sideway của tập train". Mô hình chỉ hơn baseline này 0,001–0,004 ở một số ô, thua ở 5/15 ô. Không có khoảng tin cậy, và với 17–40 mẫu độc lập thì chênh lệch cỡ này nằm trong nhiễu.
- `directionalAccuracyPct = 0` ở mọi khung, `top1Accuracy` = tần suất Sideway: mô hình luôn đoán Sideway.
- Kết luận: **thành phần "historical" không có giá trị dự báo đo được**. Sửa `clamp` mà không đổi cổng kiểm định sẽ biến một lỗi đang "im lặng" thành một tuyên bố sai.
- Lưu ý: số liệu thay đổi theo ngày chạy (cửa sổ trượt). Đây là một lần đo, chưa phải walk-forward.

### 4.3 Sơ bộ: vị trí đóng nến (CLV) có thông tin dự báo không? (script tạm)
CLV nến ngày đã đóng, so với lợi nhuận ngày kế tiếp (không chồng lấn), dữ liệu futures từ khi niêm yết. In-sample, 15 nhóm được kiểm, **chưa hiệu chỉnh multiple testing**.

| CLV | BTC P(up) | ETH P(up) | SOL P(up) |
|---|---|---|---|
| 0,0–0,2 (đóng sát đáy) | 55,4% (n=332) | 56,5% (n=331) | 51,3% |
| 0,4–0,6 | 51,3% | 53,6% | 47,1% |
| 0,8–1,0 (đóng sát đỉnh) | 46,5% (n=510) | 46,7% (n=533) | 48,1% |

- Lợi nhuận chuẩn hoá theo vol không khác 0 có ý nghĩa ở nhóm nào (|t| < 2).
- Có một xu hướng **hồi về** yếu nhưng nhất quán ở BTC/ETH về *hướng* (đóng sát đáy → hôm sau tăng nhiều hơn). Ở nhóm cực, chênh khoảng ±4–5 điểm %, tương đương ~1,5 sai số chuẩn. SOL không thấy.
- Kết luận tạm: CLV **đứng riêng** gần như không có edge về biên độ. Nếu có giá trị thì nhiều khả năng là khi kết hợp với vị trí so với key level (ví dụ đóng trên PWH với CLV > 0,7), và phải kiểm bằng event study có baseline (xem VALIDATION_STRATEGY §6). Rule hiện tại "râu dưới dài = +0,5 bullish" (`analysis.js:174`) chưa có bằng chứng.

## 5. Đánh giá theo các framework nghiên cứu (Phase 3)

| Framework | Giải quyết vấn đề gì | Hệ thống đang dùng? | Kiểm chứng thế nào | Cần không |
|---|---|---|---|---|
| DiSSS | Cấu trúc cách *trình bày* lập luận | Có (`analysis.js`) | Không kiểm được, vì nó không phải mô hình | Giữ làm layout báo cáo. Không coi là nguồn dự báo |
| First Principles | Hỏi "trong horizon H, cái gì thực sự làm giá đi?" (dòng lệnh, đòn bẩy, thanh khoản) | Ngầm (family) | Chỉ giữ đặc trưng có cơ chế giải thích *và* vượt baseline | Có: dùng để cắt bớt chỉ báo trùng thông tin |
| Bayesian Thinking | Kết hợp tần suất mẫu nhỏ với prior (base rate) | Gần đúng (`stateEdge` co về 0 khi n < 80, `server.js:774`) nhưng co sai đích (về 0 chứ không về base rate) | So Brier/log loss trước và sau khi shrink | **Có (P1)**: Dirichlet shrinkage về climatology |
| Auction Market Theory | Acceptance/rejection quanh giá trị (POC/VA) | Không | Event study: sau khi đóng ngoài VA, xác suất quay về POC so với baseline | P3: cần volume-at-price (dựng từ nến 1m/15m) |
| Multi-Timeframe | Tránh nhầm hồi ngắn với đảo chiều dài | Có mô tả (`findConflicts`, `analysis.js:580`) | Kiểm xem đặc trưng HTF có tăng skill cho horizon dài không | Có, nhưng dưới dạng đặc trưng, không cộng điểm |
| Market Regime | Hiệu suất khác nhau theo regime | Một phần (MA200 tuần) | Chia metric theo regime vol/trend | **Có (P1)** làm biến phân tầng khi đánh giá |
| Event Study | Trả lời "nếu X thì sao" | Không | CAR/forward return so với baseline cùng regime, có CI | **Có (P1)**: lõi của Conditional Scenario Engine |
| Quantitative Analysis | Đo thay vì kể | Một phần | — | Có |
| Statistical Learning | Kết hợp nhiều đặc trưng có kiểm soát | Không | Walk-forward, BSS so với climatology | P2: logistic đa lớp trước, GBM sau |
| Falsification | Đặt điều kiện để bác bỏ mô hình | Có ý (cổng `hasSkill`) nhưng sai baseline | Cổng: BSS > 0 và CI không chứa 0 | **Có (P0)** |
| Explainable AI | Cho biết vì sao xác suất đổi | Có dạng "contribution" cho điểm | Logistic: hệ số × đặc trưng. Tần suất: ô điều kiện nào đổi | P2 |
| Ensemble | Giảm phương sai khi có ≥ 2 mô hình *đã có skill* | Không (blend heuristic + lịch sử ở `scoring.js:191` là "ensemble" giả) | Stacking trên tập validation riêng | P4: chỉ làm sau khi có ít nhất 2 mô hình qua cổng |

## 6. Phản biện độc lập (Phase 5)

1. **Đang dự báo hay chỉ mô tả?** Đang mô tả. Mọi bằng chứng là trạng thái hiện tại. Thứ duy nhất có dạng dự báo (mô hình lịch sử) thì crash, và nếu chạy được cũng không thắng baseline (§4.2).
2. **Xác suất hiển thị có ý nghĩa thống kê không?** Không. `scenarioProbabilities` và `confidence` là biến đổi tuyến tính của điểm (§3.3). Không có định nghĩa outcome cho "Tăng/Giảm" của phần heuristic.
3. **Có đếm trùng giữa timeframe không?** `analysis.js` đã chống được đếm trùng trong cùng một chuỗi giá. `scoring.js` thì đếm trùng funding/taker 3 lần và đếm score 2 lần (§3.3). Giữa các khung: structure 1d/4h/1h cùng cộng vào `price-short` rồi chặn trần, như vậy là ổn.
4. **Chỉ báo có cùng loại thông tin không?** Có. MA50/100/200, cross, RSI, MACD, cấu trúc, fib đều là hàm của cùng một chuỗi close. Sau khi gộp, thông tin độc lập thực sự chỉ còn khoảng 4–5 trục: xu hướng/giá, biến động, volume/flow, positioning (funding/OI/LS), sentiment.
5. **Có dùng dữ liệu chưa tồn tại không?** Có. H3, H4 (leakage nhẹ trong backtest), nến đang chạy trong momentum (§3.3, H6), MA tính cả nến đang chạy (§3.1).
6. **Nhầm tương quan với nhân quả?** Các câu như "funding âm → dễ short squeeze" và "râu dưới dài → có lực mua đỡ" được trình bày như cơ chế, nhưng chưa có số liệu nào cho thấy chúng *dự báo* được. Ít nhất `kind: 'inference'` có gắn nhãn đúng.
7. **Quá nhiều chỉ báo mà thiếu kiểm chứng?** Đúng. Khoảng 25 rule/ngưỡng tay và không có cái nào được backtest.
8. **Có tốt hơn baseline không?** Phần đo được (mô hình lịch sử) thì không (§4.2). Phần heuristic không đo được vì không lưu lại.
9. **Module nên loại bỏ:** phần "xác suất" và "confidence %" trong `scoring.js`, `tunedDecisionThresholds`, phần `tilt/formulaScore` của mô hình lịch sử, `public/styles.css` không còn dùng. (Loại bỏ cần được duyệt, xem ROADMAP.)
10. **Điều gì làm toàn bộ mô hình thất bại?** (a) Thị trường crypto gần như hiệu quả ở horizon 4h–7d với đặc trưng công khai, nên edge thật nếu có thì rất nhỏ: kỳ vọng thực tế là BSS cỡ 0,5–3%, không phải "70% thắng". (b) Đổi regime (2026 khác 2021). (c) Ít mẫu độc lập ở horizon dài (30d trên ~7 năm dữ liệu chỉ có khoảng 85 mẫu độc lập). (d) Dữ liệu phái sinh không có lịch sử (OI, L/S) nên không kiểm được nếu không tự lưu.

**Phản biện yêu cầu mục tiêu:**
- *Xác suất cho 30 ngày tới:* với khoảng 85 mẫu độc lập, CI ±10 điểm %. Đề xuất: chỉ hiện phân phối lợi nhuận lịch sử theo regime, không hiện P(bull) như một dự báo có skill.
- *Bullish/Bearish/Sideways theo ngưỡng p75:* tạo mất cân bằng lớp 80/10/10, khiến mô hình nào cũng "đúng 80%" khi chỉ đoán Sideway. Đề xuất dùng ngưỡng theo vol trượt và hệ số k cố định ex-ante (PROBABILITY_MODEL_DESIGN §2).
- *Order book imbalance, liquidation heatmap:* chi phí cao, không có lịch sử miễn phí, giá trị ở horizon ≥ 4h chưa rõ. Xếp P4.
- *Historical Similarity (kNN) song song với Event Study:* hai thứ này trùng mục tiêu. Event study trên điều kiện rõ ràng dễ kiểm và dễ giải thích hơn. Similarity để P3.
- *Absorption:* không suy ra được tin cậy từ OHLCV + taker volume. Để P4.

## 7. Phần không kiểm tra được
- Dashboard trên trình duyệt: chưa mở UI, chỉ đọc code render và JSON API.
- Rate limit thực tế của CoinGecko/Binance khi chạy liên tục 5 giây.
- Giới hạn lịch sử 30 ngày của `futures/data/*` và lịch sử funding đầy đủ: chưa gọi API để xác nhận.
- Chất lượng `deribitIv` (mark_iv của perpetual).
- Nội dung `.env` (không đọc, theo ràng buộc về secrets).
