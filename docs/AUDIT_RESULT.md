# AUDIT RESULT · dashboard-audit-v1 (chạy 2026-11-25)

Spec đăng ký trước: [AUDIT_SPEC](AUDIT_SPEC.md) (commit `f4fac92`). Code: `lib/audit.js`, `scripts/run-audit.js`. Report: `data/reports/dashboard-audit-v1.json` (sha256 `6e3fd77818c9…`); chạy 2 lần cho cùng kết quả.

**Phạm vi:** 1.909 ngày (2020-09-02 → 2025-11-23): khám phá 1.216, xác nhận 693. Độ phủ đầu vào: funding 100%, OI 99,8%, Global L/S 98,8%, top trader 83,2% (thiếu năm 2022), taker 100%, F&G 100%. Deribit IV, dominance, USDC và lịch kinh tế không có lịch sử nên không được đánh giá.

## Kết luận

1. **Theo quy tắc đăng ký trước, không có tín hiệu nào bị bỏ.** Không tín hiệu nào sai hướng có ý nghĩa ở giai đoạn khám phá *và* lặp lại ở giai đoạn xác nhận.
2. **Badge outlook có ích nhưng yếu, và ổn định ở cả hai giai đoạn** (edge +0,073 / +0,078):

   | | P(tăng) | P(giảm) | Số ngày |
   |---|---|---|---|
   | Tần suất chung | 27,2% | 24,1% | 1.909 |
   | Badge báo **Bullish** | **31,5%** | **19,4%** | 279 |
   | Badge báo **Bearish** | 26,0% | **29,3%** | 423 |

   Badge đúng hướng nhiều hơn bình thường khoảng 4–5 điểm %, chưa đủ để coi là xác suất. Badge vẫn gắn nhãn "chưa kiểm định".
3. Các tín hiệu khác có bằng chứng đúng hướng (`keep_verified`): Global L/S (đọc ngược đám đông), DiSSS OI, DiSSS positioning, DiSSS giá ngắn hạn, kết luận DiSSS ở horizon 24h. Riêng kết luận DiSSS: edge ở giai đoạn xác nhận chỉ +0,001 (gần 0), và ở horizon 7 ngày (đúng horizon DiSSS ghi) **không có bằng chứng**.

## Bảng đầy đủ (edge có dấu; D = khám phá, C = xác nhận)

| Tín hiệu | Kích hoạt D/C | Edge D [CI95] | Edge C | Quyết định |
|---|---|---|---|---|
| rule: Global L/S | 487/253 | +0,072 [+0,014, +0,127] | +0,025 | giữ: đúng hướng |
| rule: Taker flow | 746/473 | +0,044 [−0,009, +0,094] | +0,020 | chưa có bằng chứng |
| rule: Fear & Greed (đọc ngược) | 400/130 | **−0,063** [−0,130, +0,006] | +0,004 | chưa có bằng chứng, **nghiêng sai** |
| rule: Funding | 37/0 | +0,115 [−0,118, +0,393] | – | chưa đủ mẫu |
| rule: OI + funding | 1/0 | – | – | chưa đủ mẫu |
| rule: Top trader | 0/81 | – | +0,099 | chưa đủ mẫu (năm 2022 thiếu dữ liệu) |
| rule: Pump/dump + funding | 16/2 | – | – | chưa đủ mẫu |
| mapped: structure | 1052/594 | +0,023 [−0,017, +0,063] | +0,030 | chưa có bằng chứng |
| mapped: derivatives | 995/596 | +0,038 [−0,007, +0,081] | +0,005 | chưa có bằng chứng |
| mapped: regime | 265/107 | −0,027 [−0,108, +0,056] | −0,003 | chưa có bằng chứng |
| mapped: macroTime | 623/332 | **−0,056** [−0,109, −0,004] | +0,004 | sai ở D nhưng không lặp lại ở C (và là thành phần tổng hợp) |
| **badge outlook** | 456/246 | **+0,073** [+0,010, +0,135] | **+0,078** | đúng hướng |
| DiSSS giá dài hạn | 1111/693 | +0,019 [−0,024, +0,063] | 0,000 | chưa có bằng chứng |
| DiSSS giá ngắn hạn | 1187/667 | +0,044 [+0,007, +0,081] | +0,024 | giữ: đúng hướng |
| DiSSS volume | 304/220 | **−0,074** [−0,159, +0,009] | −0,006 | chưa có bằng chứng, **nghiêng sai** ở cả hai kỳ |
| DiSSS funding | 113/8 | +0,111 [−0,033, +0,276] | +0,006 | chưa có bằng chứng |
| DiSSS OI | 177/70 | +0,146 [+0,041, +0,254] | +0,050 | giữ: đúng hướng |
| DiSSS positioning | 493/392 | +0,077 [+0,020, +0,132] | +0,007 | giữ: đúng hướng |
| DiSSS taker flow | 921/550 | +0,041 [−0,006, +0,083] | −0,001 | chưa có bằng chứng |
| DiSSS sentiment (F&G) | 400/130 | −0,063 [−0,130, +0,006] | +0,004 | chưa có bằng chứng, nghiêng sai |
| kết luận DiSSS (24h) | 769/447 | +0,060 [+0,013, +0,109] | +0,001 | giữ (C gần 0) |
| kết luận DiSSS (7 ngày) | 769/447 | +0,036 [−0,084, +0,151] | −0,026 | chưa có bằng chứng |

## Nhóm "nghiêng sai nhưng chưa chắc" (không bỏ theo quy tắc)

- **Fear & Greed đọc ngược** (rule 6 của `scoring.js`, phần F&G của thành phần macroTime, nhóm sentiment của DiSSS).
  - Sợ hãi cực độ, dashboard báo tăng: thực tế tăng 24,7%, giảm 26,8%, tức tệ hơn tần suất chung.
  - Tham lam cực độ, dashboard báo giảm: thực tế tăng 33,5%.
  - Như vậy trong dữ liệu này, F&G cực đoan đi **theo** xu hướng chứ không đảo chiều. Hiệu ứng rõ ở giai đoạn khám phá (CI chạm 0), nhưng bằng 0 ở giai đoạn xác nhận.
- **DiSSS volume.** Khi báo giảm, thực tế tăng 35,3% và giảm 15,7% (n = 102). Edge âm ở cả hai giai đoạn, nhưng CI của giai đoạn khám phá vẫn chạm 0.

Bỏ hai nhóm này là quyết định **sau khi đã xem kết quả** (không nằm trong quy tắc đăng ký trước). Nếu bỏ thì phải ghi rõ là post-hoc.

## Quyết định sau audit (2026-11-25, **post-hoc**)

Người dùng chọn bỏ cả hai nhóm "nghiêng sai". Sau khi chạy lại audit với code đã sửa (`data/reports/dashboard-audit-v1-after-removal.json`):

| Thay đổi | Ảnh hưởng tới tín hiệu người dùng thấy | Quyết định |
|---|---|---|
| Bỏ F&G khỏi `scoring.js` (rule 6 + phần F&G của macroTime) | **Badge kém đi ở cả hai giai đoạn:** edge D +0,073 → +0,053, C +0,078 → +0,060. Đứng riêng thì F&G nghiêng sai, nhưng trong tổ hợp của badge nó lại có ích | **Hoàn tác**: `scoring.js` giữ nguyên như trước audit |
| Bỏ hướng của nhóm sentiment (F&G) và volume trong DiSSS | Kết luận DiSSS 24h: D +0,060 → +0,060, C +0,001 → +0,010, toàn kỳ +0,037 → +0,040. 7 ngày: không đổi đáng kể | **Giữ**: hai nhóm chỉ còn hiển thị, không tính điểm |
| Bỏ điều kiện F&G trong mục "định giá sai" của DiSSS | Chỉ là text, không có điểm | Giữ cho nhất quán (không dùng logic đọc ngược F&G) |

Các con số trước/sau đều **in-sample** (cùng dữ liệu dùng để quyết định), nên lạc quan. Bằng chứng ngoài mẫu sẽ đến từ audit lần sau trên dữ liệu mới.

## Giới hạn

- Audit dùng nến đã đóng, còn dashboard live dùng nến đang chạy cho `closeChange*` và momentum. Kết quả mô tả dashboard *nếu* chỉ dùng nến đóng.
- Khoảng 25 tín hiệu được thử cùng lúc, và hai giai đoạn ngắn (khoảng 3,3 năm và 1,9 năm). Edge cỡ ±0,05 nằm trong vùng nhiễu.
- Deribit IV, dominance, USDC và lịch kinh tế chưa được kiểm.
