# Lộ trình triển khai sau kiểm định độc lập

**Trạng thái:** gói P0 đã được duyệt và triển khai xong ngày 2026-11-24 (xem [IMPLEMENTATION_PROGRESS](IMPLEMENTATION_PROGRESS.md)). P1 đang chờ quyết định riêng. Đây là thứ tự đề xuất. Chưa có sửa đổi source, thay đổi cấu hình, lưu dữ liệu định kỳ hay công bố dự báo. [Kiểm định độc lập](INDEPENDENT_REVIEW.md)

## Thứ tự triển khai

| Ưu tiên | Gói việc | Giá trị và điều kiện chuyển tiếp |
|---|---|---|
| P0 | Làm rõ hợp đồng UI/API, cách ly historical path lỗi | Dừng trình bày các tỷ lệ chưa kiểm định. Dashboard mô tả vẫn có dữ liệu và tránh tải lại lịch sử sau mỗi lần lỗi. |
| P0 | Sửa độ tin cậy dữ liệu đang phục vụ | Xử lý freshness, lỗi upstream và đầu vào UI. Giảm số lần fetch trùng trước khi thêm collector. |
| P1 | Dataset và replay tối thiểu, BTCUSDT 24h | Có kết quả tái lập trên hai baseline và một ứng viên đơn giản. Chốt câu hỏi, cutoff và nghiệm thu pipeline trước khi xem kết quả. |
| P1 | Shadow forward sau khi có spec ổn định | Đo được dự báo và baseline đã phát trước kết quả khi trình duyệt đóng. Ghi coverage, missed, outcome và late issuance. |
| P2 | Pilot breakout PWH, rồi mới mở rộng nghiên cứu | Có một event study point-in-time đo được. Mở rộng thêm feature/horizon hay nâng model chỉ sau review kết quả. |
| P3 | Công bố giới hạn phạm vi | Chỉ xác suất đúng event và version đạt cổng. Nếu bằng chứng yếu, dashboard tiếp tục mô tả và có thể hiển thị tần suất lịch sử có chú thích. |

## P0 · Gói sửa đầu tiên

1. **Ẩn xác suất heuristic và bỏ ký hiệu % của legacy confidence trên UI.** Giữ rule breakdown nếu hữu ích. Badge và nội dung xác nhận dùng cùng trạng thái backend. Tách outcome đóng kỳ khỏi các mức theo dõi và giải thích horizon của từng panel. Nếu cần tương thích API, đánh dấu field legacy chưa kiểm định trong thời gian chuyển tiếp và kiểm người dùng API trước khi xóa.
2. **Cách ly historical model lỗi khỏi luồng snapshot mặc định khi chưa có use case được duyệt.** Sửa `clamp` trong phạm vi tái lập/debug offline nếu còn cần so sánh, thay vì bật lại forecast cũ. Cổng DiSSS và đường legacy đều cần fail closed. Không chỉnh ngưỡng funding/score chỉ để đạt consistency giả tạo; sửa nhãn và loại bỏ đường phụ thuộc vào số thống kê không hợp lệ trước.
3. **Kiểm tra qua entry point.** Fixture có đủ ≥140 observations đi vào nhánh historical, snapshot tái lập khi nguồn thị trường thành công một phần, coverage thấp và model invalid. UI không có nhãn xác suất ở cả trạng thái heuristic, injected historical row và model missing. Smoke test thêm SSE đổi symbol/horizon và fallback polling.

Gói vận hành có thể đi cùng nếu phạm vi nhỏ. Calendar render text, USDC phân biệt lỗi sau khi đã dùng hết fallback với feed rỗng hợp lệ, metadata nguồn gồm observation time và fetch time, chỉ rõ stale. Reuse/single-flight phần fetch theo symbol và tách TTL global feed. Nghiệm thu với fetch mock: hai horizon cùng symbol chia sẻ một lần cập nhật dữ liệu nguồn; lỗi upstream có status rõ và không làm dữ liệu cũ trông như mới. Đo network call count và latency trước/sau. [Bằng chứng vận hành](INDEPENDENT_REVIEW.md#độ-tin-cậy-vận-hành-bị-bỏ-sót)

## P1 · Dataset và thử nghiệm hẹp

**Phạm vi mặc định để phê duyệt:** BTCUSDT perpetual, một phát hành mỗi close ngày UTC, outcome close-to-close sau 24h, dữ liệu OHLCV futures. Trước khi xem thêm kết quả, chốt band theo độ biến động nếu câu hỏi là dịch chuyển tương đối, hoặc band cố định nếu mục tiêu là dịch chuyển có ý nghĩa kinh tế. Nếu chọn EWMA, cố định half-life, warm-up, công thức cập nhật variance, floor, cách xử lý missing và định nghĩa equality. Phạm vi một mã/horizon là đề xuất để kiểm đường đo trước khi nhân chi phí, không suy rộng sang ETH/SOL.

| Bước | Deliverable đề xuất | Nghiệm thu |
|---|---|---|
| 1. Data contract | Dataset OHLCV đóng băng và manifest gồm source, instrument, timestamps UTC, checksum, cutoff, gap, phiên bản transform. Kiểm thử data/ quy tắc ignore trước khi lưu. | Tải lại idempotent. Gap và duplicates được liệt kê, không nén thời gian bằng cách bỏ row lỗi rồi lấy lag theo vị trí. Trùng timestamp có giá trị khác được báo. |
| 2. Point-in-time | Một hàm features gọi chung cho replay và live, label mang origin, target và thời điểm biết outcome. Chọn tối đa 1–2 features price/vol cho ứng viên đầu. | Sửa hoặc thêm dữ liệu sau cutoff không đổi feature/forecast trước đó. Nến mở, pivot chưa xác nhận, gap target và HTF chưa đóng đều có fixture. Cùng input và cutoff cho output giống nhau. |
| 3. Replay | Các fold rolling-origin với fit cutoff rõ. So climatology trượt có smoothing, baseline phân phối empirical normalized return và **một** ứng viên shrinkage; dùng cùng origin/label, ghi mọi thử nghiệm. | Chỉ train bằng nhãn đã biết tại cutoff; transform fit trong fold. Test tay Brier/log loss và đối chứng null. Tái chạy cùng manifest/seed cho cùng kết quả. Báo BSS, chênh loss paired và CI, log loss/reliability, count, phân bố dự báo và fold stability. |
| 4. Kiểm nguồn phái sinh | Lấy mẫu archive metrics theo nhiều ngày/năm và chồng lấn REST, kiểm schema, coverage, timezone, đơn vị và observation lag. | Có bảng khả dụng theo mã và thời gian. Thêm OI/L/S chỉ khi join point-in-time và ablation có thể kiểm. Chỉ mở collector cho dữ liệu có giá trị và thiếu archive hoặc thiếu provenance thời điểm. |

Khóa tập phát triển và một kỳ xác nhận thực sự chưa xem. Nếu cả lịch sử liên quan đã được dùng để chọn spec, xem kết quả lịch sử là exploratory và dùng forward làm xác nhận. Chọn chênh loss tối thiểu đáng quan tâm và quy tắc CI trước khi chạy. Brier là metric chính cho ba lớp, log loss và class reliability là chẩn đoán rủi ro. Báo paired time-block CI với độ dài theo cadence và sensitivity, tránh coi số hàng là số quan sát độc lập. Khi chưa đủ power, kết luận “chưa đủ bằng chứng” và giữ trạng thái shadow.

## P1 · Shadow forward và lưu trữ

Sau khi contract ổn định, ghi baseline ở shadow ngay cả khi chưa có ứng viên qua cổng. Dùng timer độc lập request trong tiến trình local, với stream watermark theo **timestamp nến đóng**. Có thể khởi đầu với JSONL một writer và một CLI resolver hoặc resolver nội bộ. Chọn SQLite khi cần transaction từ nhiều writer hoặc query mà JSONL không đáp ứng được.

- Khóa theo symbol, H, origin, model/label version. Ghi chính xác vector model và baseline, threshold đã biết, data availability, issuedAt, target, version và data fingerprint. Resolver liên kết outcome với forecast ID và label spec nguyên bản. Ghi missed/late rõ ràng và tách replay khỏi tập chấm live.
- Thử restart, duplicate, partial last line, clock/lag và không client. Chứng minh dự báo đã ghi trước target; policy còn cần deadline issuance đủ gần origin để không dùng dữ liệu trong horizon. So sánh scheduled origins với issued/resolved, đừng chỉ chấm các giờ server online có dữ liệu đẹp.
- Hash chain và neo bên ngoài chỉ cần khi có yêu cầu kiểm chứng độc lập hoặc nguy cơ thay đổi ledger. Forecast API history, dashboard calibration và tự động hóa nâng cao chờ đến khi báo cáo offline/forward có người sử dụng.

## P2 · Một pilot nghiên cứu trước khi nhân rộng

- **Event study:** breakout PWH trên 4h, outcome 24h trên cùng lưới 4h, một rule, một độ rộng và một nhóm đối chứng được đăng ký trước. Dùng timestamp khi event biết được, khóa level theo tuần và loại crossing giả ở biên tuần. So với các origin cùng bối cảnh có common support; ghi return distribution, effect size, uncertainty và cách xử lý clusters. Nếu CI quá rộng, dừng ở mô tả. CLV incremental, acceptance, retest và triple barrier cho phần mở rộng có điều kiện.
- **Ứng viên kế tiếp:** chỉ thêm một trục dữ liệu mỗi lượt. Ưu tiên ablation của HTF context hoặc kline flow proxy nếu collection rẻ. Thử logistic L2 với cùng feature và fold nếu bảng shrinkage hạn chế khả năng kết hợp. Giữ tính trung thực ngoài mẫu bằng nested temporal tuning. Yêu cầu thêm vốn nghiên cứu nếu muốn đánh giá PnL sau phí, spread, funding và executable entry.

## Điều kiện công bố và dừng

Công bố theo symbol × horizon × label/model version đã được xác nhận. Trước khi chạy, chọn một baseline quyết định đủ mạnh, margin có ý nghĩa, quy tắc uncertainty và coverage để tránh lựa chọn có lợi sau kết quả. Cần có cải thiện ngoài mẫu trên loss chính, độ bất định tương xứng, reliability và coverage đạt mục đích sử dụng, cùng parity replay/live. Nếu thử nhiều ứng viên hoặc nhiều horizon, đăng ký metric chính và họ so sánh, dùng confirmatory holdout mới hoặc kế hoạch multiplicity phù hợp. Một regime yếu với n nhỏ cần báo uncertainty, không áp quy tắc “thua tối đa một regime” máy móc. Giữ artifact và report khi không đạt. Dừng rollout nếu dữ liệu stale, lệch schema/feature, không đúng model version hoặc mất coverage đã quy định.

## Thay đổi so với lộ trình cũ

| Nhóm cũ | Quyết định |
|---|---|
| T1–T4 | Đưa T2 lên đầu và xử lý cả hai đường ra số. Cách ly T1 khỏi production, chuyển closed-only vào pipeline point-in-time, hoãn retune T3. |
| T5–T7 | Giữ nền tảng causal và walk-forward, thu hẹp một horizon và hai baseline. Dùng archive check trước giả định phải tích dữ liệu nhiều tháng. |
| T8–T11 | Đưa freshness và dedup T11 lên P0. Chạy shadow T9 trước UI T8. T10 chỉ sau xác minh gap hoặc mục tiêu cần chuỗi live. |
| T12–T14 | Pilot một level và một event. Hoãn engine tổng quát và giao diện đến khi có bằng chứng hoặc nhu cầu phân tích rõ. |
| T15–T18 | Giữ logistic và feature expansion dưới dạng thử nghiệm có ablation. Hoãn panel validation và attribution cho đến khi có dữ liệu xác nhận đủ dùng. |
| Các hạng mục nâng cao | Không cam kết 30d probability, ma trận nhiều horizon, similarity, volume profile từ bar, order book, ETF/macro, GBM, ensemble, DB service hoặc API mới. Đưa lại khi một giả thuyết cụ thể có dữ liệu và tiêu chí chấp nhận. |

**Phê duyệt đề xuất:** chỉ bắt đầu gói P0. Quyết định riêng trước P1 về outcome, phạm vi shadow và lưu dữ liệu. Kết quả review này không bật forecast hoặc collector. [Lộ trình cũ](IMPLEMENTATION_ROADMAP.md)
