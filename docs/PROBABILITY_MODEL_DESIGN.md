# PROBABILITY MODEL DESIGN

Trạng thái: **đề xuất, chờ duyệt**. Mục tiêu: mọi con số % trên dashboard phải (1) có định nghĩa outcome kiểm chứng được, (2) được tính từ dữ liệu, không phải từ điểm tuỳ ý, (3) đã thắng baseline đơn giản trong kiểm định ngoài mẫu.

## 1. Phân biệt ba loại con số

| Loại | Ví dụ | Được gọi là "xác suất"? | Hiển thị |
|---|---|---|---|
| Điểm (score) | `trend.score = −2,61`, DiSSS `netScore` | Không | Số không đơn vị, hoặc nhãn định tính |
| Tần suất lịch sử | "Trong 412 lần 4H đóng trên PWH, 38% sau 24h tăng ≥ 0,5σ" | Không: là mô tả quá khứ | Kèm n, n hiệu dụng, CI |
| Xác suất dự báo đã hiệu chuẩn | P(bull, 24h) = 31% | Có, **chỉ khi** qua cổng skill (§5) | Kèm baseline, BSS, model version |

Tình trạng hiện tại: `trend.scenarioProbabilities` và `trend.confidence` thuộc loại 1 nhưng lại được hiển thị như loại 3 (SYSTEM_AUDIT §3.3).

## 2. Định nghĩa outcome

Tại thời điểm t là **lúc đóng** một nến (ví dụ đóng nến 4H lúc 08:00 UTC), với horizon H:

- `r = ln(C_{t+H} / C_t)`. C lấy từ nến đóng tại t+H trên khung có H chia hết (4h/12h dùng nến 4h; 24h/3d/7d/30d dùng nến 1d).
- `σ_H = σ_1 · √(H/Δ)`, với `σ_1` = EWMA(λ = 0,94) của log return trên khung Δ, **chỉ dùng dữ liệu đến t**.
- **Bullish** nếu `r ≥ +k·σ_H`, **Bearish** nếu `r ≤ −k·σ_H`, còn lại là **Sideways**.
- `k = 0,5` cố định trước khi xem kết quả test. Với phân phối gần chuẩn, cách này cho base rate khoảng 31/38/31 [Suy luận, sẽ đo lại]. So với hiện tại khoảng 10/80/10 (ngưỡng p75 lấy từ 30 ngày gần nhất), các lớp cân hơn nhiều. Nhờ đó Brier và accuracy không còn bị lớp Sideways chi phối.

Ví dụ số: BTC 60.000, σ ngày = 2,4%, H = 24h, nên k·σ_H = 1,2%. Bullish nếu sau 24h giá ≥ 60.724 (`60.000·e^{0,012}`). Bearish nếu ≤ 59.284.

Phương án thay thế (P3): triple-barrier, tức chạm +kσ hay −kσ trước trong H. Cách này gần với giao dịch thực hơn, nhưng cần dữ liệu nội khung để xác định thứ tự chạm.

**Vì sao không dùng định nghĩa hiện tại:** ngưỡng p75 của 30 ngày gần nhất làm nhãn của cả năm phụ thuộc vào vol hiện tại (leakage, H3). Nó cũng làm Sideways chiếm ~80%, nên "luôn đoán Sideway" đã đạt độ chính xác 80% (SYSTEM_AUDIT §4.2).

## 3. Đặc trưng (ít, độc lập, có lý do)

Theo First Principles: trong horizon 4h–7d, những thứ có cơ chế giải thích gồm xu hướng/động lượng, trạng thái biến động, vị trí so với giá trị/level, positioning đòn bẩy và dòng lệnh chủ động. Mỗi trục chỉ lấy 1–2 đặc trưng để tránh lặp thông tin.

| Trục | Đặc trưng (closed-only, causal) | Có lịch sử để train? |
|---|---|---|
| Xu hướng | `trend = (C − SMA50)/ATR14`; `slopeMA50/ATR` | Có |
| Động lượng | `mom_H = ln(C_t/C_{t−H})/σ_H` (cùng H với horizon) | Có |
| Biến động | `volPct = percentile(σ_1, expanding)`; `compression = ATR5/ATR50` | Có |
| Vị trí | `rangePos90 = (C − min90)/(max90 − min90)`; `distPWH_ATR`, `distPWL_ATR` | Có |
| Nến | `CLV`, `relVol = V/SMA20(V)` | Có |
| Dòng lệnh | `delta = (2·takerBuy − V)/V` trên nến; `cvdSlope` | Có (kline cột 9) |
| Positioning | `fundingZ` (z-score 90 ngày) | Có (lịch sử funding) |
| Positioning | OI change, L/S | **Không**: chỉ dùng sau khi đã tự lưu ≥ 6 tháng |
| HTF context | `trend` của khung lớn hơn kế tiếp | Có |

Sau khi đã có model bậc 1 và đánh giá được, mới xét bổ sung các đặc trưng từ event (breakout/acceptance/rejection...).

## 4. Bậc thang mô hình (chỉ lên bậc khi bậc dưới đã được đánh giá)

| Bậc | Mô hình | Công thức | Vai trò |
|---|---|---|---|
| M0 | Climatology | `p_k` = tần suất lớp k trong cửa sổ train trượt (ví dụ 2 năm) | **Baseline bắt buộc** |
| M0' | Persistence | Lớp của horizon vừa kết thúc, làm mượt `0,5·onehot + 0,5·p0` | Baseline phụ |
| M1 | Tần suất có điều kiện + Dirichlet shrinkage | Ô `s` (2–3 biến rời rạc, ví dụ regime × mom sign): `p_k(s) = (n_k(s) + α·p0_k)/(N(s) + α)`, α chọn bằng CV trên tập train (ví dụ 20–100) | Thay cho mô hình hiện tại. Dễ giải thích |
| M2 | Logistic đa lớp (softmax) + L2 | `p = softmax(Wx + b)`, x đã chuẩn hoá trên train; viết bằng JS thuần (gradient descent), khoảng 8–12 đặc trưng | Dùng nhiều đặc trưng liên tục |
| M2c | Hiệu chuẩn | Temperature scaling trên tập validation (1 tham số) | Chỉ khi reliability lệch |
| M3 | GBM (LightGBM qua Python offline) | — | P4: chỉ khi M2 có BSS > 0 và còn dư địa |
| Ens | Trung bình có trọng số M1 + M2 | Trọng số học trên validation | P4 |

**Thay thế** cho phần `tilt`/`formulaScore` (`server.js:806-816`) và cho blend heuristic (`scoring.js:191-204`). Hai phần này không thuộc bậc nào ở trên vì chúng biến điểm thành xác suất.

## 5. Cổng công bố (falsification gate)

Một (symbol, horizon, model version) chỉ được hiển thị xác suất như dự báo khi **tất cả** điều kiện sau đúng trên walk-forward ngoài mẫu (VALIDATION_STRATEGY):
1. `BSS = 1 − Brier_model/Brier_M0 > 0`, và cận dưới CI 90% (block bootstrap, block = H) > 0.
2. Log loss ≤ log loss M0.
3. ECE ≤ 0,05 (hoặc reliability nằm trong dải CI).
4. Số mẫu độc lập (≈ n/H) ≥ 200 trong tập test gộp.
5. Không thua M0 ở quá 1 trong các regime chính (trend × vol).

Không qua cổng thì UI hiện **baseline M0** với nhãn "tần suất lịch sử, chưa có edge kiểm chứng". Đây vẫn là thông tin hữu ích (ví dụ "24h: 31/38/31"), nhưng không tuyên bố là dự báo.

Kỳ vọng thực tế [Suy luận]: với dữ liệu công khai, BSS tốt nhất có thể đạt cỡ 0–3% cho 4h–3d. Nhiều khả năng một số horizon sẽ **không** qua cổng. Đó là kết quả đúng, không phải thất bại của hệ thống.

## 6. Conditional Scenario Engine (event study)

Câu hỏi mẫu: "Nếu nến 4H đóng trên Previous Week High thì 12H/24H/7D thay đổi thế nào?"

1. **Định nghĩa event** theo TARGET_ARCHITECTURE §4 (Breakout của level PWH trên khung 4H). Tham số chốt trước.
2. **Thu mẫu:** mọi t trong lịch sử có event. **De-cluster:** chỉ lấy event đầu tiên trong mỗi cửa sổ H (tránh chồng lấn).
3. **Outcome:** nhãn §2, cộng thêm `r/σ_H`, MFE/MAE (đơn vị σ) trong H.
4. **Baseline so sánh:** tất cả t *không* có event nhưng **cùng regime** (trend × vol). Nếu không làm vậy, ta sẽ đo lẫn hiệu ứng regime.
5. **Thống kê:** n, n hiệu dụng; tần suất 3 lớp; CI Wilson; median/p10/p25/p75/p90 của r/σ; MFE/MAE; chênh so với baseline kèm CI bootstrap; p-value sau khi hiệu chỉnh BH trên toàn bộ danh mục event đã đăng ký trước.
6. **Câu chữ:** "Trong quá khứ (2019-09 → nay, n = 143 sự kiện độc lập), sau khi 4H đóng trên PWH, 24h sau: tăng ≥ 0,5σ 36% (CI 29–44%) so với 31% ở các thời điểm cùng regime." **Không** viết "sẽ", "do đó", "vì vậy giá tăng".
7. Các câu hỏi ghép (8H breakout nhưng 1D không xác nhận) = giao của hai điều kiện. n sẽ giảm nhanh, nên nếu n hiệu dụng < 30 thì chỉ hiện "không đủ mẫu".
8. "Giá tăng nhưng OI/Volume không xác nhận": phần volume làm được ngay. Phần OI chờ có dữ liệu tự lưu.

## 7. Historical Similarity (P3)

Sau event study: kNN trên vector đặc trưng §3 đã chuẩn hoá, khoảng cách Mahalanobis. Ràng buộc: hàng xóm cách nhau ≥ H (không chồng lấn) và chỉ lấy dữ liệu trước t. Output giống §6.5. Chỉ làm khi event study đã chạy ổn, vì similarity khó giải thích hơn và dễ data-snooping (chọn k, chọn metric).

## 8. Horizon 30 ngày

Dữ liệu futures từ 2019-09 (~7 năm) chỉ cho khoảng 85 mẫu độc lập (spot từ 2017-08: ~110). CI cho một tần suất khoảng ±10 điểm %. Đề xuất: chỉ hiển thị phân phối r/σ lịch sử theo regime hiện tại (quantile), ghi rõ n. Không đưa vào cổng skill.

## 9. Giải thích (XAI)

- M1: "Ô điều kiện: Bear trend × Vol cao × Mom âm (n = 214). So với lần đóng nến trước (ô Bear × Vol thấp × Mom âm), P(bear) đổi 29% → 34%."
- M2: đóng góp vào log-odds `β_j·(x_j − x̄_j)` cho từng lớp; hiển thị top 3 đặc trưng làm xác suất đổi so với lần trước.
- Không dùng LLM để sinh hay "giải thích lại" con số.
