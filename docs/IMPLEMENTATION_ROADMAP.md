# IMPLEMENTATION ROADMAP

Trạng thái: **chờ duyệt, chưa sửa source code**. Thứ tự sắp theo Pareto: trước hết ngừng hiển thị số sai, sau đó dựng nền đo lường, cuối cùng mới thêm tính năng.

## Quyết định cần anh/chị chốt trước khi code

| # | Quyết định | Đề xuất | Hậu quả nếu không chốt | Cách chạy tạm |
|---|---|---|---|---|
| D1 | Xử lý "Xác suất kịch bản" heuristic và "Confidence %" trên thanh trên | **Đổi nhãn ngay** thành "Điểm xu hướng (chưa phải xác suất)", bỏ ký hiệu %. Xoá hẳn sau khi có ma trận xác suất kiểm định (T8) | Người dùng tiếp tục đọc "Giảm 61%" như xác suất | Giữ nguyên, nhưng thêm dòng cảnh báo |
| D2 | Bắt đầu lưu dữ liệu (ledger dự báo + snapshot OI/LS/funding mỗi giờ) vào `data/*.jsonl` | **Có.** Đây là cách duy nhất để có dữ liệu phái sinh lịch sử và có bằng chứng dự báo live. Mỗi ngày trễ là mất dữ liệu vĩnh viễn | Không bao giờ kiểm được OI/LS; không có forward validation | — |
| D3 | Định nghĩa Bullish/Bearish/Sideways | `r ≥ ±0,5·σ_H` (EWMA, causal), Design §2 | Không dựng được label/validation | Dùng k = 0,5 làm mặc định, cho phép đổi bằng version |
| D4 | Sửa `clamp` (mô hình lịch sử) | Sửa **cùng PR** với cổng climatology (T1). Không sửa riêng | Sửa riêng thì UI bắt đầu hiện "Thống kê: x%" mà không có skill | — |

## Task list

Ký hiệu độ lớn: S ≤ 1 ngày, M 2–4 ngày, L ≥ 1 tuần.

### Giai đoạn 0: Ngừng sai (P0, khoảng 2–3 ngày)

**T1. Cổng skill dùng climatology + vá `clamp` + regression test** (S, P0, deps: D4)
- Files: `server.js` (thêm `clamp`, tính Brier climatology trong `computeBacktestMetrics`), `lib/analysis.js` (`statisticalModelCheck`: `hasSkill = brier < climatologyBrier`, kèm điều kiện số mẫu), `test/analysis.test.js`, `test/historical.test.js` (mới). Để test được, cần tách các hàm mô hình lịch sử ra `lib/historical.js` mà không đổi logic.
- Nghiệm thu: `npm test` pass. Test mới gọi `buildHistoricalTfStats` với ≥ 140 mẫu không throw. Với dữ liệu thật của 2026-11-24 (SYSTEM_AUDIT §4.2), cổng trả `hasSkill = false` cho mọi ô mà mô hình không thắng climatology, và `snapshot.errors` không còn lỗi `clamp`.

**T2. Đổi nhãn số heuristic trên UI** (S, P0, deps: D1)
- Files: `public/main-new.js` (`renderDecisionBar`, `renderScenarios`), `public/index-new.html`.
- Nghiệm thu: không còn ký hiệu % nào gắn với `trend.confidence` hay `trend.scenarioProbabilities`. Badge dùng `trend.outlook` (bỏ hằng 0,25). Header không còn chữ "Thống kê 1 năm" khi nguồn không phải thống kê.

**T3. Bỏ đếm trùng và bias funding trong `scoring.js`** (S, P0)
- Files: `lib/scoring.js`, `test/scoring.test.js` (mới).
- Thay đổi: bỏ `fundingTilt`/`takerTilt` khỏi `pressure`; bỏ `probEdge` khỏi `deriveDecision` (vì đã có trong score); mapping derivatives dùng vùng chết (|funding| ≤ 0,01% thì 0, thống nhất với `analysis.js:219-222`); bỏ `tunedDecisionThresholds` theo symbol.
- Nghiệm thu: test cho thấy funding = +0,01% và taker = 1,0 cho đóng góp derivatives = 0. Mỗi tín hiệu chỉ xuất hiện ở đúng một thành phần (có test liệt kê).
- Lưu ý: đây là **thay đổi business logic** của phần scoring, nên cần duyệt cùng D1.

**T4. Feature closed-only cho momentum** (S, P0)
- Files: `server.js` (`computeCloseContext` chỉ lấy nến đã đóng cho `closeChange*`; giữ `closeNow*` cho hiển thị), test.
- Nghiệm thu: test thêm nến đang chạy vào input không làm đổi `closeChange4h/1d/1w`.

### Giai đoạn 1: Nền đo lường (P1, khoảng 1,5–2 tuần)

**T5. History loader + cache + pre-registration** (M, deps: D2, D3)
- Files: `lib/history.js` (tải và cache klines 4h/1d + funding history, chỉ nến đóng, idempotent), `scripts/fetch-history.js`, `.gitignore` (`data/`), `docs/PREREGISTRATION.md`.
- Nghiệm thu: chạy 2 lần liên tiếp không tạo dòng trùng. Số nến khớp với `(now − listing)/interval` sai lệch ±2. Pre-registration có ngày chốt, danh sách feature/label/model/gate.

**T6. `lib/features.js` + `lib/labels.js` (dùng chung train và live)** (M, deps: T5)
- Tái sử dụng `lib/indicators.js` (sma/ema/rsi), thêm `atr`, `ewmaVol`, percentile expanding.
- Nghiệm thu: truncation test và closed-only test pass (VALIDATION_STRATEGY §1). Label k·σ khớp ví dụ tính tay trong Design §2.

**T7. `lib/validation.js` + CLI `npm run backtest`** (M, deps: T6)
- Walk-forward có purge/embargo; M0, M0', M1 (Dirichlet); metric Brier/BSS/logloss/ECE/confusion/sharpness; block bootstrap CI; phân tầng theo regime/năm. Ghi `data/reports/{version}.json` và `data/models/{version}.json`.
- Nghiệm thu: test metric với số tính tay. Report có đủ symbol × horizon × regime. Một test cố ý đưa leakage vào phải làm BSS tăng bất thường (kiểm tra pipeline có phát hiện được leakage).

**T8. `lib/forecast.js` + ma trận xác suất trên UI** (M, deps: T7)
- Server load model version, tính xác suất cho mỗi horizon, gắn `published` theo report. UI hiện ma trận horizon × lớp kèm baseline, n, BSS, model version (TARGET_ARCHITECTURE §7). Thay thế panel scenario cũ.
- Nghiệm thu: horizon không qua cổng hiện baseline với nhãn "chưa có edge". Snapshot có `forecast.modelVersion`. Train và live cho cùng feature tại cùng t (test).

**T9. Ledger + resolver** (M, deps: T6, D2)
- Files: `lib/ledger.js`, hook "nến đóng" trong `server.js`, `GET /api/forecast/history`.
- Nghiệm thu: test append/trùng/hash chain (sửa 1 byte thì verify fail). Restart server không ghi trùng. Outcome được ghi đúng sau H.
- Ghi chú: **T9 có thể làm song song với T5 ngay sau T6** để sớm bắt đầu tích dữ liệu. Có thể ghi xác suất M0 trước, chưa cần T8.

**T10. Snapshot phái sinh mỗi giờ** (S, deps: D2)
- Ghi OI, L/S, top L/S, taker ratio, funding, F&G vào `data/snapshots/`. Tái sử dụng fetch hiện có.
- Nghiệm thu: mỗi giờ 1 dòng/symbol, không trùng khi restart.

**T11. Data freshness + hạ tải polling** (S)
- `sources[{name, ok, asOf}]` trong snapshot; cache theo symbol; CoinGecko/F&G TTL 5 phút.
- Nghiệm thu: với 2 client cùng symbol khác timeframe, mỗi chu kỳ chỉ có 1 lượt fetch nguồn.

### Giai đoạn 2: Key level, reaction, event study (P1–P2, khoảng 2 tuần)

**T12. `lib/levels.js`**: PD/PW/PM O-H-L-C, D/W/M open, ATR-width, touches (S–M, deps: T6). Nghiệm thu: fixture tay cho từng level, kể cả biên tuần (thứ Hai 00:00 UTC) và biên tháng.

**T13. `lib/reactions.js`**: các event ở TARGET_ARCHITECTURE §4 kèm `knowableAt` (M, deps: T12). Nghiệm thu: mỗi event có ít nhất 1 fixture dương và 1 fixture âm. Failed breakout có `knowableAt > occurredAt`.

**T14. Event study engine + panel Conditional Scenarios** (M, deps: T7, T13). Nghiệm thu: báo n, n hiệu dụng, baseline cùng regime, CI, q-value BH. Câu chữ theo template Design §6.6. Chạy danh mục đã pre-register, gồm câu hỏi CLV.

### Giai đoạn 3: Cải thiện dự báo (P2)

**T15. M2 logistic + temperature scaling** (M, deps: T7). Nghiệm thu: chỉ được publish nếu qua cổng. Report so sánh M1 và M2.
**T16. CVD proxy, CLV, wick, relVol, fundingZ vào feature set** (S, deps: T6). Chỉ đưa vào model khi đã tăng version và cập nhật pre-registration.
**T17. Panel validation:** reliability diagram, lịch sử dự báo, BSS trượt (M, deps: T9).
**T18. "Vì sao xác suất đổi"** (S, deps: T8/T15).

### Giai đoạn 4: Nâng cao (P3–P4, chỉ khi giai đoạn 1–3 đã có kết quả)
VWAP/AVWAP, volume profile xấp xỉ, similarity kNN, khung 15m/8h/12h/3d, basis spot/futures, stablecoin DefiLlama. Order book, liquidation, ETF, macro số liệu, GBM, ensemble: chưa cần.

## Sơ đồ phụ thuộc

```
D4→T1   D1→T2   T3   T4            (song song, giai đoạn 0)
D2,D3→T5→T6→T7→T8→T15→T18
            ├→T9 (sớm nhất có thể)→T17
            ├→T12→T13→T14
            └→T16
D2→T10       T11 (độc lập)
```

## Migration Strategy
- Không có DB nên không có migration phá huỷ. `data/` mới hoàn toàn và đã được gitignore.
- Giữ shape cũ của snapshot (`trend.*`, `analysis.*`) trong suốt giai đoạn 0–1. Chỉ thêm field mới (`forecast`, `sources`, `levels`, `events`). Xoá `trend.scenarioProbabilities`/`confidence` sau T8 khi đã được duyệt.
- Tách `server.js` theo nhu cầu: mô hình lịch sử chuyển sang `lib/historical.js` (T1), sau đó được thay bằng `lib/forecast.js` (T8). Code fetch nguồn giữ nguyên chỗ cũ cho đến khi có lý do để tách.
- `public/styles.css` không còn dùng: đề xuất xoá (chờ duyệt).

## Task đầu tiên nên làm
**T1 + T2 trong cùng một PR** (khoảng 1 ngày). Lý do:
1. Chi phí thấp nhất mà rủi ro gây hiểu sai giảm nhiều nhất. Hiện con số nổi bật nhất trên màn hình ("Giảm 61%", "66%") là số tự chế.
2. T1 sửa một lỗi crash thật, nhưng **phải đi kèm** cổng climatology. Nếu không, khi sửa xong UI sẽ bắt đầu khẳng định mô hình "có giá trị" trong khi đo thực tế cho thấy không có (SYSTEM_AUDIT §4.2).
3. Ngay sau đó là **T9 (ledger)**: mỗi ngày chưa lưu là mất đi một ngày bằng chứng forward và dữ liệu OI/LS không thể lấy lại.
