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

## Lịch sử thay đổi

| Ngày | Version | Thay đổi |
|---|---|---|
| 2026-11-24 | dataset-v1, sigma-ewma-v1, label-ksigma-v1, features-v1 | Bản đầu |
