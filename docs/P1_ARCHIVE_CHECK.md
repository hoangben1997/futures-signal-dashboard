# P1-4 · Kiểm tra archive dữ liệu phái sinh Binance (BTCUSDT)

**Ngày kiểm:** 2026-11-24. **Kết luận ngắn:**
- **Không cần mở collector** cho OI, Global L/S và taker flow: archive công khai đủ dùng từ 09/2020.
- Top trader L/S thiếu gần hết năm 2022, nên loại khỏi ứng viên.
- Funding lấy được qua REST từ 09/2019.

Script kiểm là script tạm, đã xoá sau khi chạy. Phương pháp ghi ở bên dưới để chạy lại được.

## Nguồn

| Dữ liệu | Nguồn lịch sử | Bắt đầu | Độ phân giải |
|---|---|---|---|
| OI, 3 tỷ lệ L/S, taker ratio | `data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-YYYY-MM-DD.zip` | 2020-09-01 | 5 phút |
| Funding | REST `fapi/v1/fundingRate` (phân trang theo `startTime`) | 2019-09-10 | 8 giờ |
| Taker buy volume | Cột 9 của klines (đã có trong dataset-v1) | 2019-09-08 | theo nến |
| REST `futures/data/*` (OI hist, L/S, taker) | Chỉ khoảng 30 ngày gần nhất | — | 5m–1d |

## Schema archive metrics

`create_time, symbol, sum_open_interest, sum_open_interest_value, count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio, count_long_short_ratio, sum_taker_long_short_vol_ratio`

Đối chiếu từng mốc 5 phút với REST trên ngày 2026-11-23 (288 mốc):

| Cột archive | Tương ứng REST | Kết quả |
|---|---|---|
| `sum_open_interest`, `…_value` | `openInterestHist` (BTC, USD) | **Khớp tuyệt đối** 288/288. `create_time` là **UTC**, cùng đơn vị |
| `count_toptrader_long_short_ratio` | `topLongShortAccountRatio` | Lệch ≤ 0,03% (REST làm tròn 4 chữ số) |
| `sum_toptrader_long_short_ratio` | `topLongShortPositionRatio` | Lệch ≤ 0,003% |
| `count_long_short_ratio` | `globalLongShortAccountRatio` | Lệch ≤ 0,03% |
| `sum_taker_long_short_vol_ratio` | `takerlongshortRatio` | **Lệch một mốc:** archive tại `t` = REST tại `t − 5m` (tương quan 1,0000 khi dời; 0,002 khi không dời). Archive gắn nhãn theo **thời điểm kết thúc** cửa sổ 5 phút, REST theo thời điểm bắt đầu. Khớp với kline 5m `takerBuy/(volume − takerBuy)` (tương quan 0,997) |

## Độ phủ (% mốc 5 phút có giá trị hợp lệ)

Quét toàn bộ 2.275 file ngày (2020-09-01 → 2026-11-23). Không thiếu file ngày nào.

| Năm | Ngày | OI | Global L/S | Taker | Top trader (acc/pos) |
|---|---|---|---|---|---|
| 2020 (từ 09-01) | 122 | 99,9 | 99,9 | 99,9 | 99,9 |
| 2021 | 365 | 99,6 | 99,2 | 99,2 | 99,2 |
| **2022** | 365 | 100 | 94,9 | **64,9** | **12,7** |
| 2023 | 365 | 100 | 100 | 100 | 100 |
| 2024 | 366 | 99,9 | 99,9 | 99,9 | 99,9 |
| 2025 | 365 | 100 | 100 | 100 | 99,9 |
| 2026 (tới 11-23) | 327 | 100 | 100 | 100 | 100 |

Khoảng ngày top trader thiếu (< 50% mốc): 2021-06-22; 2021-12-31 → 2022-01-29; 2022-01-31 → 2022-05-27; 2022-06-25 → 2022-12-14. Trong các ngày này, ô trống được ghi bằng chuỗi `""` chứ không phải bỏ trống.

## Lỗi dữ liệu cần xử lý khi nạp

- **Dòng trùng giống hệt:** toàn bộ 122 ngày năm 2020 và 141 ngày năm 2021 (mỗi mốc xuất hiện 2 lần). Không có conflict (cùng mốc khác giá trị).
- **Dòng không sắp theo thời gian** trong file, nên phải sort sau khi nạp.
- **Lỗ trong ngày:** ví dụ 2021-06-22 chỉ có 126/288 mốc, lỗ dài nhất 265 phút. Có 4 ngày năm 2021 dưới 90% số mốc.
- Giá trị trống `""` ở các cột tỷ lệ (chủ yếu năm 2022).

## Hệ quả cho thiết kế

| Dữ liệu | Quyết định đề xuất | Lý do |
|---|---|---|
| OI (thay đổi OI theo ngày) | **Dùng được** cho ứng viên kế tiếp, từ 2020-09 | Đầy đủ, khớp REST, là snapshot tại `create_time` |
| Global L/S account | Dùng được, cần quy tắc cho ngày thiếu | ≥ 94,9% mọi năm |
| Taker flow | **Lấy từ klines** thay vì archive | Klines đủ từ 2019, cùng nội dung, archive thiếu 35% năm 2022 |
| Top trader L/S | **Loại** | Thiếu khoảng 11 tháng năm 2022; không lấp lại được |
| Funding | Dùng được qua REST | Đủ từ 2019-09-10 |
| Collector tự thu | **Không mở** | Không có dữ liệu giá trị nào chỉ thu được bằng collector |

**Quy tắc point-in-time** (khi đưa vào spec phiên bản sau):
- Tại origin 00:00 UTC chỉ dùng các mốc có `create_time < origin`.
- Taker trong archive tại `t` là cửa sổ `[t − 5m, t)`, nên dùng được tại `t`.
- Bản archive ngày D được phát hành sau D. Vì vậy với live/shadow phải lấy từ REST (30 ngày gần nhất); archive chỉ dùng cho replay.

**Ảnh hưởng tới cỡ mẫu:** dữ liệu OI bắt đầu từ 2020-09, muộn hơn giá 1 năm. Nếu ứng viên dùng OI và giữ nguyên walk-forward 730 ngày cùng holdout từ 2025-11-24, tập test còn khoảng **1.150 origin** (khoảng 09/2022 → 11/2025), so với 1.455 của replay-v1.

## Cách chạy lại

1. Liệt kê file: `https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/futures/um/daily/metrics/BTCUSDT/`, phân trang theo `marker`.
2. Tải từng file zip vào một thư mục riêng, rồi đọc bằng `unzip -p`.
3. Với mỗi cột, đếm số `create_time` duy nhất có giá trị số hợp lệ.
4. Đối chiếu với REST `futures/data/{openInterestHist,topLongShortAccountRatio,topLongShortPositionRatio,globalLongShortAccountRatio,takerlongshortRatio}?period=5m` cho một ngày trong 30 ngày gần nhất.
