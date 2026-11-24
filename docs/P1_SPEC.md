# P1 SPEC · Dataset, nhãn và feature point-in-time (BTCUSDT 24h)

**Trạng thái:** chốt ngày 2026-11-24, **trước khi xem bất kỳ kết quả replay nào**. Đổi bất kỳ tham số nào bên dưới thì tăng version và ghi lý do vào mục Lịch sử thay đổi. Phạm vi được duyệt: P1 bước 1–2 của [REVISED_ROADMAP](REVISED_ROADMAP.md). Bước 3 (replay) và shadow forward chưa bắt đầu.

Quyết định đã chốt với người dùng (2026-11-24):
- Outcome dùng band theo biến động k·σ, không dùng band cố định.
- Cho phép ghi dữ liệu vào `data/`. `data/` đã được gitignore trước khi ghi.
- OI/LS: kiểm archive Binance trước (bước 4), chưa mở collector.

## 1. Data contract (`dataset-v1`)

| Mục | Giá trị |
|---|---|
| Instrument | Binance USDT-M perpetual `BTCUSDT`, nến `1d` (open 00:00 UTC) |
| Nguồn | `https://fapi.binance.com/fapi/v1/klines`, phân trang theo `startTime`, 1.500 nến mỗi request |
| Cutoff | Chỉ nhận nến có `closeTime < cutoff`. Cutoff là một mốc 00:00 UTC truyền vào CLI |
| Trường lưu | `openTime, closeTime, open, high, low, close, volume, quoteVolume, trades, takerBuyBase, takerBuyQuote` |
| Trùng lặp | Cùng `openTime`, giá trị giống hệt: giữ 1 bản, đếm vào `duplicatesDropped`. Cùng `openTime`, giá trị khác: ghi vào `conflicts` và **CLI dừng, không ghi file** |
| Gap | Liệt kê mọi khoảng `openTime` thiếu so với lưới 1 ngày. Không xoá, không nội suy |
| File | `data/datasets/<SYMBOL>-<interval>-cutoff-<YYYY-MM-DD>.jsonl` và `.manifest.json` cùng tên |
| Checksum | SHA-256 của nội dung JSONL. Chạy lại cùng cutoff phải cho cùng checksum; nếu khác thì CLI báo và không ghi đè |

## 2. Thời điểm và point-in-time

- **Origin** = lúc một nến ngày đóng, tính bằng `closeTime + 1 ms` (00:00 UTC hôm sau). Tại origin chỉ dùng các nến có `closeTime < origin`.
- Nến đang chạy không bao giờ được dùng.
- Tất cả độ trễ đều tính theo **timestamp**, không theo vị trí trong mảng. Nến cách origin k ngày được tìm bằng `openTime = originOpenTime − k·1d`.
- Feature không dùng pivot hay khung lớn hơn, nên không có rủi ro "pivot chưa xác nhận" hay "HTF chưa đóng". Nếu sau này thêm thì phải bổ sung fixture tương ứng.

## 3. Biến động σ (`sigma-ewma-v1`)

- Log return ngày: `r_t = ln(C_t / C_{t−1d})`.
- Phương sai EWMA kiểu RiskMetrics, giả định mean = 0: `v_t = λ·v_{t−1} + (1 − λ)·r_t²`, với **λ = 0,94** (half-life ≈ 11,2 ngày).
- **Warm-up 60 return:** `v` được khởi tạo bằng trung bình `r²` của 60 return đầu tiên. σ chỉ được định nghĩa từ return thứ 60 trở đi.
- **Sàn:** `σ = max(√v, 1%)`.
- **Gap:** nếu nến trước bị thiếu, return đi qua gap d ngày được chia thành `r²/d` khi cập nhật phương sai. Mọi origin có gap trong 60 ngày gần nhất bị đánh dấu không hợp lệ (`gap_in_window`).

## 4. Nhãn (`label-ksigma-v1`)

Theo [PROBABILITY_MODEL_DESIGN §2](PROBABILITY_MODEL_DESIGN.md):
- `r = ln(C_target / C_origin)`, với target là nến có `openTime = originOpenTime + 1d`.
- `band = k·σ_origin`, **k = 0,5** (H = 1 ngày nên σ_H = σ_1).
- **Bullish** nếu `r ≥ +band`, **Bearish** nếu `r ≤ −band`, còn lại là **Sideways**. Ranh giới thuộc về tăng/giảm.
- `knownAt = target.closeTime + 1 ms`. Thiếu nến target thì nhãn là `null`, lý do `target_missing`; không lấy nến kế tiếp thay thế.
- Ví dụ số: C_origin = 60.000 và σ = 2,4%, nên band = 1,2%. Bullish nếu C_target ≥ 60.724 (`60.000·e^{0,012}`), Bearish nếu ≤ 59.284.

## 5. Feature cho ứng viên đầu (`features-v1`)

Tối đa 2 feature, cả hai chỉ dùng nến đã đóng tại origin:

| Feature | Công thức | Cần tối thiểu |
|---|---|---|
| `mom1z` | `r_origin / σ_origin` (return ngày vừa đóng, chuẩn hoá theo σ) | 61 nến |
| `trend50` | `(C − SMA50(C)) / ATR14`, với ATR là trung bình Wilder (RMA) của True Range 14 ngày, khởi tạo bằng SMA | 50 nến |

`σ_origin` cũng được lưu, vì nó là input của band nhãn chứ không phải feature tự do.

## 6. Nghiệm thu bước 1–2 (test tự động)

- Tải lại idempotent: cùng input cho cùng checksum. Phát hiện gap, duplicate, conflict.
- Truncation: `featuresAt(dữ liệu cắt tại t) == featuresAt(dữ liệu đầy đủ, asOf = t)`.
- Sửa dữ liệu sau cutoff không đổi feature tại cutoff. Thêm nến đang chạy không đổi feature.
- Thiếu nến target cho nhãn `null`. Ranh giới `r = ±band` cho đúng lớp. Cùng input cho cùng output.

## 7. Replay (`replay-v1`), đăng ký trước khi chạy

Chốt với người dùng ngày 2026-11-24, trước lần chạy replay đầu tiên.

**Tập dữ liệu**
- Dùng dataset `BTCUSDT-1d-cutoff-2026-11-24` (sha256 `4d813d15…`). Chỉ lấy các origin có feature hợp lệ và có nhãn.
- **Holdout xác nhận:** origin có `originOpenTime ≥ 2025-11-24` (khoảng 365 ngày). Code replay loại các origin này hoàn toàn. Chỉ chạy một lần, sau khi đã chọn xong mô hình, và cần quyết định riêng.

**Walk-forward**
- Refit vào 00:00 UTC ngày 1 mỗi tháng (cutoff). Train chỉ dùng nhãn có `knownAt ≤ cutoff`; đây là purge cho H = 1 ngày.
- Train là cửa sổ trượt 730 ngày: `originOpenTime ≥ cutoff − 730 ngày`.
- Test là các origin có `asOf` (= `closeTime + 1`) nằm trong `[cutoff, cutoff tháng sau)`. Tham số mô hình giữ cố định trong tháng.
- Tháng test đầu tiên là tháng đầu có đủ 730 ngày nhãn hợp lệ trước cutoff.

**Mô hình** (p là vector 3 lớp bullish / sideways / bearish)

| Mô hình | Công thức |
|---|---|
| M0 climatology (baseline quyết định) | `p_k = (n_k + 1)/(N + 3)` trên cửa sổ train 730 ngày |
| B2 phân phối return chuẩn hoá | Tần suất `z = r/σ` vượt ±k trên **toàn bộ** lịch sử đã biết (expanding), làm mượt như M0. Vì nhãn được định nghĩa bằng chính z, B2 tương đương climatology expanding. Đây là baseline phụ |
| G tham chiếu Gauss | `p_side = Φ(k) − Φ(−k) = 0,3829`, `p_bull = p_bear = 0,3085`. Không fit; chỉ để chẩn đoán |
| M1 ứng viên shrinkage | Ô `s = [trend50 ≥ 0] × [mom1z ≥ 0]` (4 ô). `p_k(s) = (n_k(s) + α·p0_k)/(N(s) + α)` trên cửa sổ train, với p0 là M0 |

**Chọn α cho M1:** α thuộc {20, 50, 100}, chọn bằng CV lồng trong tập train.
- Validation là 180 origin cuối của tập train; fit trên cửa sổ 730 ngày kết thúc trước validation.
- Chọn α có Brier thấp nhất. Nếu hoà thì lấy α lớn hơn (co nhiều hơn).

**Metric và cổng**
- Brier là tổng trên 3 lớp `Σ_k (p_k − o_k)²`; log loss kẹp p ≥ 1e-6.
- `BSS = 1 − mean(Brier_M1)/mean(Brier_M0)`.
- Khoảng tin cậy: circular block bootstrap ghép cặp, **block 7 origin**, 2.000 lần lặp, seed 12345, lấy percentile CI 90%. Sensitivity với block 1 và 30.
- **Cổng đạt** (chỉ để quyết định có đi tiếp tới holdout hay không): BSS > 0, cận dưới CI 90% > 0, và log loss của M1 ≤ M0.
- Báo thêm: BSS theo từng năm, độ hiệu chuẩn (reliability, ECE 10 bin), phân bố xác suất dự báo, số mẫu, α được chọn ở từng fold.
- **Đối chứng null:** M1 với ô bị xáo ngẫu nhiên (seed 12345), kỳ vọng BSS ≤ 0.

**Tái lập:** report ghi sha256 dataset, version spec và seed. Chạy lại phải ra cùng số. Mọi lần chạy được ghi một dòng vào `data/reports/experiments.jsonl`.

## 8. Shadow forward (`shadow-v1`)

Duyệt ngày 2026-11-24. Chỉ ghi vào `data/shadow/`, **không hiển thị lên dashboard** (`published: false`).

- **Phạm vi:** BTCUSDT, mỗi nến ngày đóng (origin), horizon 24h, nhãn `label-ksigma-v1`. Ghi xác suất M0, B2, G và M1. M1 là ứng viên đã trượt cổng ở replay-v1, chỉ để theo dõi.
- **Parity:** dùng đúng `featuresAt` và `fitModelsAtCutoff` của replay. Có test khẳng định dự báo shadow cho một origin lịch sử bằng dự báo replay của origin đó.
- **Thời gian:** mọi mốc so sánh dùng giờ sàn (`/fapi/v1/time`), lưu kèm độ lệch đồng hồ máy. Watermark là nến ngày đóng gần nhất mà sàn trả về.
- **Hạn phát hành:** 1 giờ sau origin.
  - Ghi trong hạn: dự báo đúng hạn, được chấm.
  - Quá hạn nhưng chưa biết kết quả: vẫn ghi, kèm `late: true`, **không chấm**.
  - Đã biết kết quả mà chưa ghi: ghi bản `missed`.
- **Ledger:** `data/shadow/BTCUSDT-1d-shadow.jsonl`, chỉ append, một writer (file `.lock`, lock quá 10 phút coi là treo).
  - Khoá theo `symbol:1d:origin:shadow-version:label-version`. Bản ghi trùng id bị bỏ qua.
  - Dòng cuối dở dang do crash được cô lập thành một dòng riêng.
- **Resolver:** chấm khi nến target đã đóng. Nếu `issuedAt ≥ knownAt` thì bản ghi bị đánh dấu không hợp lệ.
- **Vận hành:** timer chạy trong server mỗi 5 phút (`SHADOW_INTERVAL_MS`). Chỉ chạy khi start bằng `node server.js`; tắt bằng `SHADOW_ENABLED=0`. Máy tắt hoặc ngủ thì các origin đó thành late hoặc missed và được ghi rõ, không bị bỏ qua lặng lẽ.

## Lịch sử thay đổi

| Ngày | Version | Thay đổi |
|---|---|---|
| 2026-11-24 | dataset-v1, sigma-ewma-v1, label-ksigma-v1, features-v1 | Bản đầu |
| 2026-11-24 | shadow-v1 | Shadow forward baseline, hạn phát hành 1 giờ |
| 2026-11-24 | replay-v1 | Đăng ký trước walk-forward, baseline, ứng viên M1, metric, cổng (trước lần chạy đầu) |
