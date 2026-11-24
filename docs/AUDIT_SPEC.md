# AUDIT SPEC · Dashboard dự báo đúng hay sai trên dữ liệu thật (`dashboard-audit-v1`)

**Trạng thái:** đăng ký ngày 2026-11-25, **trước khi chạy**. Yêu cầu của người dùng: chạy dữ liệu thật qua dashboard, xem có dự báo đúng không, tín hiệu nào làm sai thì bỏ.

## 1. Câu hỏi

Tại mỗi lần đóng nến ngày (00:00 UTC), nếu mở dashboard và đọc các tín hiệu (badge outlook, từng rule, từng nhóm DiSSS, kết luận DiSSS), thì 24h sau giá có đi theo hướng tín hiệu nói nhiều hơn bình thường không?

## 2. Dữ liệu và giai đoạn

- **Mã:** BTCUSDT perpetual. **Origin:** mỗi ngày 00:00 UTC.
- **Giai đoạn đánh giá:** origin 2020-09-02 → 2025-11-23. Bắt đầu từ 2020-09-02 vì archive OI/LS bắt đầu 2020-09-01.
  - **Khám phá (discovery):** 2020-09-02 → 2023-12-31.
  - **Xác nhận (confirmation):** 2024-01-01 → 2025-11-23.
- **Holdout P1** (origin ≥ 2025-11-24) **không dùng**.

## 3. Tái hiện dashboard tại origin t (chỉ dữ liệu có trước t)

Chạy **đúng code dashboard**: `buildMetrics` (lib/metrics.js, cùng hàm server dùng), `inferTrend(metrics, 24)`, `summarizeTimeframe` và `buildMarketReport`. Đầu vào được dựng lại với cùng shape như response API:

| Nguồn live | Dựng lại từ lịch sử |
|---|---|
| klines 1h/4h/1d/1w | Dataset futures đã đóng băng, chỉ nến đóng trước t, cùng số nến như server (1h: 72 cho horizon 24h, 4h: 183, 1d: 37, 1w: 8) |
| ticker24h | `lastPrice` = close nến 1h cuối; `priceChangePercent` = thay đổi % so với close 24h trước |
| premiumIndex `lastFundingRate` | Funding đã chốt gần nhất có `fundingTime ≤ t` (REST fundingRate) |
| openInterest / openInterestHist(1h, 7) | Archive OI: snapshot mới nhất `< t` và snapshot tại `t − 6h` |
| globalLongShort / topTraderLongShort | Archive `count_long_short_ratio` / `sum_toptrader_long_short_ratio`, mốc mới nhất `< t` (top trader trống năm 2022 thì null) |
| takerlongshortRatio (1h, dòng cuối) | Nến 1h vừa đóng: `takerBuy / (volume − takerBuy)` |
| Fear & Greed | Giá trị có timestamp `< t` (ngày trước, cho chắc không dùng số công bố sau t) |
| Technicals DiSSS | `summarizeTimeframe` trên 400 nến đóng của futures 1M/1w/1d/4h/1h |
| Deribit IV, CoinGecko dominance, USDC, lịch kinh tế | **Không có lịch sử, nên là null / rỗng**. Rule IV, thành phần dominance và nhóm on-chain không được đánh giá |

**Khác biệt có chủ ý so với live:** live có dùng nến đang chạy cho `closeChange*` và momentum (tồn đọng đã ghi nhận); audit chỉ dùng nến đã đóng. Khung tháng dùng futures thay vì spot.

## 4. Kết quả (outcome)

- **Chính:** nhãn `label-ksigma-v1` (P1_SPEC §4): `d = +1` nếu tăng ≥ 0,5σ trong 24h, `−1` nếu giảm ≤ −0,5σ, `0` nếu đi ngang.
- **Phụ** (chỉ cho kết luận DiSSS, vốn ghi horizon 1–7 ngày): dấu của `ln(C_{t+7d}/C_t)`.

## 5. Tín hiệu được chấm (s ∈ {−1, 0, +1})

| Nhóm | Tín hiệu |
|---|---|
| Rule `scoring.js` | Funding, OI change + funding, Global L/S, Top trader L/S, Taker flow, Fear & Greed, Price pump/dump + funding: dấu điểm của rule khi rule kích hoạt |
| Thành phần mapped trend | structure, derivatives, regime, macroTime: dấu khi \|giá trị\| ≥ 0,35 (ngưỡng UI dùng) |
| Badge | `trend.outlook`: Bullish = +1, Bearish = −1, Sideways = 0 |
| Nhóm DiSSS | price-long, price-short, volume, funding, oi, positioning, flow, sentiment: hướng của family |
| Kết luận DiSSS | `summary.bias` (bullish / bearish / neutral; insufficient = 0) |

## 6. Metric

- **Edge có dấu:** `E = Σ s·(d − d̄) / Σ|s|`, với d̄ là trung bình d trên mọi origin của cùng giai đoạn. E > 0 nghĩa là tín hiệu đúng hướng nhiều hơn bình thường.
  - Ví dụ: d̄ = 0,02; tín hiệu nói "tăng" 100 ngày, trung bình d của các ngày đó là 0,10, thì E = 0,08.
- **Khoảng tin cậy:** circular block bootstrap, block 7 ngày, 2.000 lần lặp, seed 12345. Báo CI 95%.
- **Báo kèm:** số ngày kích hoạt theo từng chiều, P(tăng)/P(giảm) khi tín hiệu báo tăng và khi báo giảm, so với tần suất chung.

## 7. Quy tắc quyết định (chốt trước)

| Kết luận | Điều kiện |
|---|---|
| **BỎ: sai hướng** | Discovery: CI 95% của E nằm **hoàn toàn dưới 0**, **và** confirmation: E < 0. Cả hai giai đoạn đều phải có ≥ 30 ngày kích hoạt |
| **GIỮ: đúng hướng có bằng chứng** | Discovery: CI 95% hoàn toàn trên 0, và confirmation: E > 0 |
| **CHƯA CÓ BẰNG CHỨNG** | Các trường hợp còn lại, kể cả kích hoạt < 30 ngày. Giữ nguyên, ghi rõ trong report |

- Chỉ **rule và nhóm DiSSS** bị bỏ.
- Badge, thành phần mapped trend và kết luận DiSSS là tổng hợp, nên không bỏ trực tiếp; chúng tự thay đổi khi rule bị bỏ. Hiệu quả trước/sau được báo trên toàn giai đoạn và **ghi rõ là in-sample** (lạc quan).
- Bỏ nghĩa là tắt rule hoặc evidence trong code (điểm = 0, có comment trỏ về report), kèm test.
- Khoảng 25 tín hiệu được thử cùng lúc, nên dùng CI 95% cộng điều kiện lặp lại ở giai đoạn xác nhận để hạn chế bỏ nhầm.
