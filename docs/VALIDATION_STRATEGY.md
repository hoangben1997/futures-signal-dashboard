# VALIDATION STRATEGY

Trạng thái: **đề xuất, chờ duyệt**. Mục tiêu: mọi tuyên bố "mô hình có giá trị" phải dựa trên kiểm định ngoài mẫu tái lập được. Mọi dự báo live phải được lưu *trước* khi biết kết quả.

## 1. Danh mục rủi ro → biện pháp

| Rủi ro | Hiện trạng (bằng chứng) | Biện pháp | Test tự động |
|---|---|---|---|
| Look-ahead | Pivot cần 3 nến phải; ngưỡng p75 30d gắn nhãn cả năm (`server.js:1387`) | Mọi feature/level/event có `knowableAt`; ngưỡng tính expanding | **Truncation test:** `features(series[0..t]) == features(series_full)[t]` với t ngẫu nhiên |
| Data leakage | `medianVol` trên cả test (`server.js:962`) | Mọi tham số chuẩn hoá (mean/std/percentile/median) chỉ fit trên train của fold | Test fold: đổi dữ liệu test thì tham số không đổi |
| Incomplete candle | `closeChange*` dùng nến đang chạy (`server.js:1195`) | Feature chỉ nhận nến có `closeTime ≤ asOf` | Test: thêm nến đang chạy không làm đổi feature |
| Overfitting | ~25 ngưỡng tay | Tham số chốt trước; số tham số tự do được ghi lại; M2 có L2 | So train vs test gap |
| Selection / survivorship bias | 3 symbol được chọn vì đang lớn | Báo kết quả *cả* 3 symbol, không chọn symbol đẹp; ghi rõ là đánh giá trên coin sống sót | — |
| Multiple testing / data snooping | — | Pre-registration (§7); BH-FDR; holdout cuối không chạm | — |
| Class imbalance | Sideway ~80% | Nhãn k·σ (Design §2); metric dùng Brier/log loss và BSS so với climatology, không dùng accuracy | — |
| Non-stationarity / concept drift | Chỉ 1 năm dữ liệu | Walk-forward nhiều năm; metric theo năm và theo regime; theo dõi BSS trượt 90 ngày trên ledger | Cảnh báo khi BSS trượt < 0 trong 60 ngày |
| Mẫu chồng lấn | Bước 1 bar, horizon h | Purge + embargo; CI bằng block bootstrap; báo n hiệu dụng | — |

## 2. Dữ liệu

- Klines futures USDT-M từ khi niêm yết (BTC/ETH ~2019-09, SOL ~2020-09), khung 4h và 1d, chỉ nến đã đóng. Cache vào `data/cache/` (TARGET_ARCHITECTURE §3).
- **Holdout cuối cùng:** 12 tháng gần nhất *tại ngày chốt pre-registration*. Không dùng để chọn mô hình. Chỉ chạy **một lần** khi đã chốt model. Kết quả được ghi vào report, kể cả khi xấu.

## 3. Walk-forward

- Expanding window. Train khởi đầu 2 năm, bước refit 1 tháng, test là tháng kế tiếp. Sau đó gộp tất cả tháng test lại.
- **Purge:** bỏ khỏi train các mẫu có `[t, t+H]` chồng lên khoảng test. **Embargo:** thêm H bar sau mỗi khoảng test.
- Chọn siêu tham số (α của M1, λ của M2) bằng CV lồng bên trong train, không dùng tập test.

## 4. Metric (theo từng symbol × horizon × regime)

Quy ước Brier: dùng **tổng 3 lớp** `Σ_k (p_k − o_k)²` (chuẩn của Murphy). Đoán đều ra 0,667. Code hiện tại chia cho 3 (`server.js:862`), nên khi so sánh với số cũ cần nhân 3.

| Metric | Công thức / mô tả |
|---|---|
| Brier, BSS | `BSS = 1 − Brier/Brier_M0` |
| Log loss | `−mean(ln p_{true})`, kẹp p ≥ 1e-6 |
| Reliability / ECE | 10 bin theo p dự báo của từng lớp; ECE = Σ (n_b/N)·\|mean p − tần suất\| |
| Confusion matrix | Argmax, kèm tỉ lệ dự báo mỗi lớp (để phát hiện "luôn đoán Sideway") |
| Sharpness | Độ lệch chuẩn của p dự báo (mô hình mà luôn ra base rate thì sharpness = 0) |
| CI | Block bootstrap (block = H bar, 1000 lần) cho BSS và log loss |
| Phân tầng | Theo regime (trend bull/bear × vol thấp/vừa/cao), theo năm |
| Kinh tế (phụ) | Hit rate theo xác suất bucket. Không tối ưu theo PnL ở giai đoạn này |

Ví dụ đọc kết quả: Brier_M0 = 0,640 và Brier_model = 0,628 cho BSS = 1,9%. Nếu CI 90% là [−0,4%, 4,1%] thì **không qua cổng** (cận dưới < 0).

## 5. Forward validation (ledger)

Đây là nguồn bằng chứng mạnh nhất vì không thể bị data-snooping.
1. **Khi nào ghi:** ngay khi nến của khung gốc đóng (4h cho 4h/12h, 1d cho 24h/3d/7d) và server có dữ liệu nến đó. Ghi một dòng cho mỗi (symbol, horizon), **kể cả horizon chưa qua cổng** (`published: false`), để sau này đo được.
2. **Ghi gì:** xem TARGET_ARCHITECTURE §3 (`forecasts.jsonl`). Gồm `asOfBarClose`, `modelVersion`, `features`, `featureHash`, `probs`, `prevHash`, `hash`.
3. **Bất biến:** file chỉ append. Kết quả được ghi vào `outcomes.jsonl` riêng. `verifyLedger()` kiểm tra hash chain khi khởi động và hiển thị trạng thái trên UI.
4. **Resolver:** khi `now ≥ asOfBarClose + H` và nến đích đã đóng thì tính outcome theo đúng `labelSpec` của model version đó.
5. **Trùng lặp:** khoá `(symbol, horizon, asOfBarClose, modelVersion)`. Đã có thì không ghi lại.
6. **Báo cáo live:** cùng bộ metric §4 trên ledger, cập nhật hằng ngày. Hiển thị "n dự báo đã có kết quả" để người dùng biết bằng chứng còn mỏng (ví dụ horizon 7d cần khoảng 1 năm mới có khoảng 50 mẫu độc lập).

## 6. Event study validation

- Danh mục event, tham số và horizon được **đăng ký trước** trong `docs/PREREGISTRATION.md` (sẽ tạo ở task T5), có ngày chốt.
- Mỗi kết quả báo: n, n hiệu dụng, chênh so với baseline cùng regime, CI, p-value thô và q-value BH.
- Câu hỏi CLV (SYSTEM_AUDIT §4.3) là ứng viên đầu tiên: CLV quintile × {đóng trên/dưới PDH/PDL}, horizon 24h.

## 7. Chống data snooping (quy trình)

1. Chốt nhãn, đặc trưng, model và cổng trong pre-registration **trước** khi chạy walk-forward.
2. Mỗi lần thay đổi spec thì tăng version và ghi lý do. Report giữ lại cả các version thất bại (số lần thử = bằng chứng về mức độ snooping).
3. Holdout chỉ chạy một lần cho mỗi version ứng viên cuối.
4. Nếu đã thử > 10 spec, nâng ngưỡng cổng: cận dưới CI 95% thay vì 90%.

## 8. Testing strategy (code)

| Lớp | Nội dung | Công cụ |
|---|---|---|
| Unit | indicators (đã có), ATR, levels PD/PW/PM, mỗi reaction event với fixture nến tay, label k·σ, Brier/logloss/ECE với số tính tay | `node --test` |
| Invariance | Truncation test, closed-only test, fold leakage test | `node --test` |
| Golden | Fixture `test/fixtures/*.json` (đã có `ethusdt-1d-closes.json`) → snapshot features/labels | `node --test` |
| Ledger | Append, chống trùng, phát hiện sửa (sửa 1 byte thì verify fail) | `node --test` |
| Integration | `getSnapshot` với fetch được mock (inject `fetchJson`) để test không cần mạng | `node --test` |
| Regression | Một test bắt được lỗi `clamp` (gọi `buildHistoricalTfStats` với ≥ 140 mẫu) | `node --test` |
