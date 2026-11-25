# IMPLEMENTATION PROGRESS

Lộ trình đang theo: [REVISED_ROADMAP](REVISED_ROADMAP.md). Phạm vi được duyệt: **chỉ gói P0**. P1 (outcome, phạm vi shadow, lưu dữ liệu) cần quyết định riêng trước khi bắt đầu.

| Gói | Trạng thái | Cập nhật |
|---|---|---|
| P0-A. Hợp đồng UI/API: ngừng trình bày tỷ lệ chưa kiểm định | **Xong** | 2026-11-24 |
| P0-B. Cách ly historical model, fail closed cả hai đường | **Xong** | 2026-11-24 |
| P0-C. Kiểm tra qua entry point (+ smoke trình duyệt) | **Xong** | 2026-11-24 |
| P0-D. Vận hành: freshness, lỗi upstream, dedup fetch, render calendar | **Xong** | 2026-11-24 |
| P1-1. Data contract (dataset-v1) | **Xong** | 2026-11-24 |
| P1-2. Feature/nhãn point-in-time (features-v1, label-ksigma-v1) | **Xong** | 2026-11-24 |
| P1-3. Replay rolling-origin + baseline (replay-v1) | **Xong**: ứng viên M1 **không qua cổng** | 2026-11-24 |
| P1-4. Kiểm archive metrics Binance (OI/LS) | **Xong**: OI/Global L/S/taker đủ từ 2020-09, top trader loại, **không cần collector** ([P1_ARCHIVE_CHECK](P1_ARCHIVE_CHECK.md)) | 2026-11-24 |
| Audit dashboard trên dữ liệu thật (dashboard-audit-v1) | **Xong**: không tín hiệu nào sai có ý nghĩa; badge đúng hướng yếu nhưng ổn định. Post-hoc: bỏ hướng của sentiment/volume trong DiSSS; giữ F&G ở badge vì bỏ đi làm badge kém hơn ([AUDIT_RESULT](AUDIT_RESULT.md)) | 2026-11-25 |
| P2. Ứng viên giá × OI (replay-v2-oi) | **Xong**: **không qua cổng**, holdout chưa chạm | 2026-11-25 |
| P1 shadow forward (shadow-v1) | **Đang chạy** từ origin 2026-11-23 (dự báo đầu là late vì bật lúc 17h UTC) | 2026-11-24 |

Lưu ý: working tree đã có thay đổi chưa commit từ trước phiên này (README, `server.js`, `public/*-new.*`, `lib/analysis.js`, `lib/indicators.js`, `test/`). `git diff` vì vậy gộp cả hai phần. Chưa commit theo quy ước repo.

---

## P0-A. Hợp đồng UI/API

**Hiện trạng trước khi sửa** (SYSTEM_AUDIT §3.3, INDEPENDENT_REVIEW §2–3):
- Thanh trên cùng hiện `trend.confidence` dạng "66.4%".
- Panel "Scenario Probabilities" hiện `trend.scenarioProbabilities` dạng thanh %.
- Badge dùng ngưỡng cứng 0,25 (`main-new.js:86`) trong khi `trend.outlook` dùng ngưỡng weak đã tune, nên hai bên có thể lệch nhau.
- Mức breakout được ghi "→ Xu hướng tăng/giảm", trông như một outcome.

**Thay đổi:**
- `public/legacy-view.js` (mới): hàm thuần dựng text cho thanh trên, panel kịch bản, playbook, ghi chú mô hình thống kê, cảnh báo nguồn cũ. `main-new.js` gọi các hàm này.
- Thanh trên: badge lấy đúng `trend.outlook`. "Confidence %" được thay bằng "Cường độ điểm" = |`decision.score`| (0–1), có tooltip "chưa kiểm định, không phải xác suất".
- Panel đổi tên thành "Kịch bản & mức theo dõi". Panel giờ hiện horizon đang chọn, mức theo dõi kèm giải thích cách tính, và thông báo "chưa có xác suất kịch bản nào qua kiểm định". **Không còn thanh xác suất.**
- Playbook: bỏ dòng "Xác suất: …". "Chênh xác suất" đổi thành "Chênh điểm kịch bản heuristic". Thêm dòng ghi chú "chưa kiểm định".
- DiSSS: ghi chú mô hình thống kê chỉ hiện số khi `stat.hasSkill`. Meta ghi rõ "nến ngày, 1–7 ngày (không đổi theo bộ chọn horizon)".
- Bảng backtest được thay bằng câu trạng thái "mô hình lịch sử đang tắt".
- API: thêm `snapshot.contract` (`validatedProbabilities: false`, `historicalModel: 'disabled'`, `unverifiedFields` kèm giải thích từng field). Các field legacy **vẫn trả về** để tương thích. Trong repo chỉ có UI này dùng chúng.

**Không đổi** (đúng phạm vi): công thức của `inferTrend` (score, decision, ngưỡng funding, đếm trùng). Roadmap ghi "hoãn retune T3".

## P0-B. Cách ly historical model, fail closed

**Thay đổi:**
- `lib/historical.js` (mới): chuyển nguyên văn mô hình lịch sử từ `server.js`, thêm import `clamp` (gốc lỗi crash). Fetch và cache được truyền vào qua tham số. Module này **không còn được gọi** từ snapshot.
- `lib/stats.js` (mới): các helper dùng chung (`clamp`, `num`, `pctChange`, `std`, `percentile`, …), chuyển nguyên văn.
- `server.js`: `metrics.historicalScenarioModel = null`. Bỏ cache, env `HIST_MODEL_REFRESH_MS` và lời gọi tải lịch sử 1 năm.
- Fail closed, `lib/scoring.js`: thêm `validatedHistoricalRow()`, chỉ nhận hàng có `validation.passed === true`. Hàm này được dùng cho blend kịch bản, `computeQualityAdj` và `tunedDecisionThresholds`. Thêm `metricOrNaN` để `Number(null)` không còn thành 0.
- Fail closed, `lib/analysis.js`: `statisticalModelCheck.hasSkill = row.validation?.passed === true`. Thắng mức đoán đều giờ chỉ là chẩn đoán (`beatsUniform`), verdict ghi rõ "chưa kiểm định ngoài mẫu so với climatology".

**Quyết định kỹ thuật:** `validation.passed` là hợp đồng chờ cho pipeline P1. Ở P0 chưa có gì sinh ra trường này, nên cả hai đường đều không bao giờ dùng số lịch sử.

## P0-C. Kiểm tra qua entry point

- `server.js` import được từ test: chỉ `listen` khi chạy trực tiếp, và export `getSnapshot`, `start`, `server`, `resetCaches`.
- `test/helpers/mock-market.js`: giả lập toàn bộ API ngoài bằng cách thay `globalThis.fetch`.
- `test/snapshot.test.js` (10 test):
  - Historical bị cách ly và không còn request tải lịch sử.
  - Single-flight: hai horizon cùng symbol → mỗi endpoint gọi 1 lần.
  - Giữ nguyên cửa sổ 1h 72/96 nến cho realized vol.
  - Nguồn lỗi một phần.
  - Nguồn global lỗi không bị cache 5 phút.
  - Stale có `observedAt`/`fetchedAt`.
  - Coverage thấp → `insufficient`.
  - USDC lỗi khác với rỗng hợp lệ.
  - Lịch kinh tế lỗi.
  - Hàng lịch sử ≥ 140 mẫu chưa kiểm định không đổi kịch bản/quyết định.
  - HTTP: SSE đổi symbol/horizon, `/api/snapshot` cho polling, symbol sai → 500.
- `test/historical.test.js`: regression `clamp` (≥ 140 mẫu đi qua nhánh backtest).
- `test/legacy-view.test.js`: không có nhãn xác suất ở 3 trạng thái (heuristic, hàng lịch sử chèn vào, thiếu mô hình). Badge theo `outlook`. Số chỉ hiện khi đã kiểm định. Cảnh báo stale.
- Smoke trình duyệt thật (Chrome headless qua DevTools Protocol, script tạm đã xoá), kết quả mục "Kết quả kiểm chứng".

## P0-D. Vận hành

- **Dedup fetch:** `cachedLoad()` (cache + single-flight) cho nguồn theo symbol (TTL `REFRESH_MS`), nguồn global F&G/CoinGecko (TTL 5 phút; có lỗi thì chỉ giữ `REFRESH_MS`) và technicals.
  - Để các horizon dùng chung dữ liệu, 1h luôn fetch 96 nến (trước đây 72 hoặc 96 tuỳ horizon). Mỗi horizon cắt lại đúng số nến như cũ, nên `realizedVol24h`/`momentum6h` không đổi.
  - 4h/1d/1w vốn đã có limit cố định.
- **Metadata nguồn:** `snapshot.sources[]` gồm `fetchedAt` và `observedAt` (lấy theo field thời gian của từng API), cùng `stale` theo ngưỡng tuổi tối đa mỗi nguồn (ví dụ F&G 48h, ticker 5 phút). UI đưa các nguồn stale vào danh sách lỗi.
- **USDC:** mỗi nguồn throw khi lỗi, kể cả Etherscan non-success và Whale Alert trả không phải JSON. Chuỗi fallback chạy tiếp sau lỗi; trước đây khi có key Etherscan thì trả `[]` và dừng luôn. Chỉ báo lỗi khi đã thử hết nguồn, và khi đó giữ dữ liệu cũ kèm `stale`. Mảng rỗng từ nguồn chạy thành công là hợp lệ. Có single-flight.
- **Lịch kinh tế:** trạng thái `ok/error/stale`. Lỗi được đưa vào `snapshot.errors` (trước đây im lặng). Bảng render bằng `textContent` thay vì `innerHTML`.

---

## Kết quả kiểm chứng

| Hạng mục | Trước | Sau | Cách đo |
|---|---|---|---|
| `npm test` | 20 pass | **37 pass / 0 fail** | `node --test` |
| Lỗi `clamp is not defined` trong snapshot | Có | Không | Gọi API thật, test snapshot |
| Request ngoài: 2 client SSE cùng BTC, horizon 4h và 1d, 25 giây, `REFRESH_MS=10s` | **115** (klines 52) | **33** (klines 12) | Preload bọc `fetch`, mạng thật |
| Thời gian tới snapshot đầu | 1,73 s | 1,32 s | Như trên (1 lần đo, có nhiễu mạng) |
| Request tải lịch sử 1 năm mỗi snapshot | 4 (do crash nên không bao giờ được cache) | 0 | Như trên |
| UI hiện % cho xác suất heuristic / confidence | Có ("Giảm 61,2%", "66,4%") | Không | Chrome headless: `#scenario-list` không có chuỗi dạng `x.y%`, thanh trên "Cường độ điểm 0.15" |
| Đổi horizon → panel cập nhật | — | 4h → 3d đúng | CDP: đổi `#timeframe-selector` |
| Đổi symbol | — | BTC → ETH đúng | CDP: đổi `#symbol-select` |
| Fallback polling khi server chết rồi sống lại | — | "Error: Failed to fetch" rồi tự cập nhật lại sau khi server bật | CDP: kill/restart server |
| Calendar có tiêu đề `&lt;img onerror…&gt;` | Lọt vào `innerHTML` (suy luận từ code: `decodeHtmlEntities` rồi `innerHTML`) | Hiện dạng text, không tạo `<img>`, `onerror` không chạy | CDP + preload giả lập ForexFactory |
| Lỗi JS trên trang | — | 0 exception | CDP `Runtime.exceptionThrown` |

**So sánh kết quả nghiệp vụ trước/sau:** `inferTrend` và `buildMarketReport` cho cùng output với metrics không có hàng lịch sử đã kiểm định. Production trước đây luôn ở trạng thái này vì crash. Lý do:
- `validatedHistoricalRow()` trả `null`, tương đương `historicalScenarioModel = null` cũ, nên `qualityAdj` và ngưỡng giữ giá trị mặc định cũ.
- Cửa sổ 1h được cắt lại đúng như cũ.

Test `fail closed …` khẳng định thêm: chèn một hàng chưa kiểm định thì `scenarioProbabilities` và `decision` giữ nguyên.

**Không có cải tiến dự báo nào** trong P0, nên không có số đo ngoài mẫu để so sánh hay đề xuất rollback.

## Vấn đề chưa giải quyết (ghi nhận, ngoài phạm vi P0)

1. **Logic `scoring.js` vẫn đếm trùng funding/taker và có thiên lệch dấu funding.** Badge và playbook vẫn dựa trên điểm này (đã gắn nhãn "chưa kiểm định"). Roadmap: hoãn retune T3, chỉ làm sau khi có pipeline đo.
2. **Field legacy vẫn có trong API** (`trend.scenarioProbabilities`, `trend.confidence`) và được đánh dấu trong `contract.unverifiedFields`. Chưa biết có consumer nào ngoài repo hay không. Đề xuất: xoá khi có ma trận xác suất kiểm định (P3).
3. **Momentum và closeChange vẫn dùng nến đang chạy** (incomplete candle). Theo roadmap, việc này chuyển vào pipeline point-in-time của P1 thay vì sửa lẻ ở legacy.
4. **Ingestion vẫn gắn với request/SSE:** không có client thì không fetch, các nhóm SSE vẫn xử lý tuần tự. Việc tách timer và watermark nến đóng thuộc P1 (shadow forward).
5. USDC khi stale vẫn dùng sự kiện của cửa sổ 72h tại lần fetch thành công cuối. ~~Ngưỡng > 100M chỉ áp ở frontend mà không nói rõ.~~ **Đã xử lý 2026-11-25:** panel ghi rõ "N event > 100M / M tổng (DiSSS tính toàn bộ)".
6. ~~DiSSS "độ phủ dữ liệu" lẫn thiếu dữ liệu với dữ liệu trung tính.~~ **Đã xử lý 2026-11-24:** `familyAvailability()` đo độ sẵn có riêng (available/stale/missing, lấy từ `sourceHealth` server truyền vào; feed USDC rỗng hợp lệ vẫn tính là có dữ liệu). Summary tách thành `dataAvailablePct`, `freshDataPct` và `activeEvidencePct`; key `coveragePct` cũ đã bỏ (chỉ UI trong repo dùng). Kết luận "chưa đủ dữ liệu" và độ tin cậy dựa trên `freshDataPct`. Ví dụ BTC lúc kiểm: dữ liệu mới 100%, nghiêng một phía 44%.
7. ~~Server `listen` trên mọi interface.~~ **Đã xử lý 2026-11-24:** mặc định bind `127.0.0.1`, đổi bằng env `HOST`. Test HTTP kiểm `server.address().address`.
8. Ngưỡng stale theo nguồn (ví dụ F&G 48h, oiHist 2h) là lựa chọn vận hành, dễ đổi (`symbolSourceSpecs`/`GLOBAL_SOURCE_SPECS` trong `server.js`).
9. Trong lúc kiểm thử, ForexFactory trả 429 do server bị khởi động lại nhiều lần. Lỗi này giờ hiện trong `errors`. Khi lịch đang rỗng, cache thử lại sau 2 phút như cũ.
10. Smoke trình duyệt chạy bằng script tạm (Chrome + CDP), chưa nằm trong `npm test` (repo zero-dependency, không có browser runner).

## P1 bước 1–2 (2026-11-24)

**Quyết định đã chốt:** band k·σ; cho phép ghi `data/` (đã gitignore trước khi ghi); OI/LS kiểm archive trước, chưa mở collector. Spec đóng băng **trước khi xem kết quả**: [P1_SPEC](P1_SPEC.md).

**Thay đổi:**
- `lib/dataset.js` + `scripts/build-dataset.js`: tải klines futures theo trang, chỉ nến đóng trước cutoff. Có conflict thì dừng, không ghi. Gap được liệt kê, không xoá. Checksum SHA-256; chạy lại với checksum khác thì không ghi đè.
- `lib/pit.js`: `featuresAt(bars, asOf)` (σ EWMA, `mom1z`, `trend50`) và `labelFor()`. Mọi độ trễ tính theo timestamp; thiếu target thì nhãn `null`.
- `.gitignore`: thêm `data/`.

**Nghiệm thu trên dữ liệu thật** (`BTCUSDT-1d-cutoff-2026-11-24`, sha256 `4d813d15…`):

| Hạng mục | Kết quả |
|---|---|
| Nến | 2.634 (2019-09-08 → 2026-11-23); gap 0, duplicate 0, row lỗi 0 |
| Tải lại cùng cutoff | Cùng checksum, CLI báo "Không đổi" |
| Origin có feature hợp lệ | 2.574 (60 thiếu do warm-up σ) |
| Origin có nhãn | 2.573 (thêm 1 thiếu target: nến cuối cùng) |
| Truncation test ngẫu nhiên (20 mốc) | 0 lệch |
| `npm test` | 50 pass / 0 fail |

Chưa xem phân bố nhãn hay bất kỳ kết quả dự báo nào. Đó là bước 3 (replay), cần chốt thêm trước khi chạy: độ dài cửa sổ train, bước refit, kỳ xác nhận giữ lại, chênh loss tối thiểu và quy tắc CI.

## P1 bước 3: replay-v1 (2026-11-24)

Spec được đăng ký và commit **trước** lần chạy đầu (commit `1e368c4`, [P1_SPEC §7](P1_SPEC.md)). Code: `lib/replay.js`, `scripts/run-replay.js`. Report: `data/reports/replay-v1-4d813d15bf8f.json` (sha256 `528720341bfb…`); chạy 2 lần cho cùng report. Mọi lần chạy được ghi vào `data/reports/experiments.jsonl`.

**Phạm vi test:** 1.455 origin (2021-11-30 → 2025-11-23), 48 fold tháng. Holdout (từ 2025-11-24) **chưa chạm**.

| Mô hình | Brier (tổng 3 lớp) | Log loss | BSS so với M0 | CI 90% (block 7) |
|---|---|---|---|---|
| M0 climatology trượt 2 năm | 0,6280 | 1,0446 | 0 | — |
| B2 climatology expanding | 0,6256 | 1,0407 | **+0,38%** | [+0,15%, +0,60%] |
| G tham chiếu Gauss | 0,6455 | 1,0678 | −2,80% | — |
| **M1 ứng viên (4 ô trend50 × mom1z)** | 0,6280 | 1,0444 | **−0,003%** | [−0,34%, +0,32%] |
| NULL (ô ngẫu nhiên) | 0,6305 | 1,0487 | −0,41% | [−0,72%, −0,11%] |

**Kết luận theo cổng đăng ký trước:** M1 **không qua** (BSS ≤ 0, cận dưới CI < 0; chỉ log loss không tệ hơn). Theo spec, không đi tiếp tới holdout. Trạng thái: **chưa đủ bằng chứng** rằng hai feature giá này dự báo được nhãn 24h tốt hơn tần suất lịch sử. Dashboard tiếp tục chỉ mô tả.

**Kiểm tra sức khoẻ pipeline:**
- Đối chứng null có BSS âm và CI hoàn toàn dưới 0. Nhờ vậy biết pipeline không tạo ra edge giả.
- Sensitivity theo độ dài block (1/7/30) cho CI gần như nhau.
- ECE của M1 < 0,03 ở cả 3 lớp.

**Phát hiện cần ghi lại (dữ kiện, không phải để chọn lại spec cho lần này):**
1. **Tỷ lệ lớp thực tế khác giả định.** Trong tập test, tăng 25,8%, ngang 50,0%, giảm 24,2%. PROBABILITY_MODEL_DESIGN §2 giả định khoảng 31/38/31 (ghi rõ "[Suy luận, sẽ đo lại]"). Nguyên nhân: return ngày BTC có đỉnh nhọn và đuôi dày hơn phân phối chuẩn, nên band ±0,5σ chứa khoảng 50% số ngày. Đây cũng là lý do G thua M0 2,8%.
2. **Baseline M0 (trượt 2 năm) yếu hơn B2 (expanding)** một cách có ý nghĩa: CI của B2 hoàn toàn dương. Nếu so với B2 thì M1 kém hơn khoảng 0,38%. Đề xuất cho version sau: dùng baseline quyết định mạnh hơn, hoặc so với cả hai.
3. M1 chọn α = 100 (co mạnh nhất) ở 30/48 fold, nghĩa là ô feature gần như không mang thông tin trong CV nội bộ. BSS theo năm dao động +0,23% (2022) → −0,39% (2024).

## P2: replay-v2-oi (2026-11-25)

Spec đăng ký trước: [P1_SPEC §9](P1_SPEC.md) (commit `71886c8`). Code: `lib/replay-oi.js`, `scripts/run-replay-oi.js`. Report: `data/reports/replay-v2-oi.json` (sha256 `7ab58d7c5156…`); chạy 2 lần cho cùng kết quả.

| Mô hình (1.177 origin, 2022-08-31 → 2025-11-23) | Brier | Log loss | BSS so với B2 | CI 90% (block 7) |
|---|---|---|---|---|
| B2 climatology expanding (baseline) | 0,6267 | 1,0418 | 0 | — |
| **M1 góc phần tư giá × OI 24h** | 0,6278 | 1,0435 | **−0,18%** | [−0,44%, +0,08%] |
| NULL (ô ngẫu nhiên) | 0,6267 | 1,0416 | 0,00% | [−0,35%, +0,33%] |
| G (Gauss) | 0,6459 | 1,0684 | −3,06% | — |

**Kết luận:** không qua cổng (cả 3 điều kiện đều trượt). Theo spec, **holdout không chạy** và vẫn còn nguyên cho ứng viên sau. α = 100 (co mạnh nhất) ở 33/39 fold: ô giá × OI gần như không mang thông tin. Nhóm OI của DiSSS từng đúng hướng trong audit, nhưng đó là một cách dựng khác: OI 6h có ngưỡng ±2%, chỉ kích hoạt khoảng 250 ngày. Không thử thêm biến thể trên cùng dữ liệu để tránh data-snooping.

**Tổng kết hướng dự báo sau 2 ứng viên:** cả feature giá (replay-v1) lẫn giá × OI (replay-v2) đều không dự báo được nhãn 24h tốt hơn tần suất lịch sử. Đúng với điều kiện dừng trong roadmap: dashboard giữ vai trò **mô tả**. Shadow baseline vẫn chạy để có bằng chứng forward. Chỉ mở ứng viên mới khi có giả thuyết với dữ liệu khác hẳn (không phải biến thể của giá/OI ngày).

## P1 shadow forward (2026-11-24)

Spec: [P1_SPEC §8](P1_SPEC.md). Code: `lib/shadow.js` (thuần), `lib/shadow-runner.js` (I/O, lock), timer trong `server.js` (`/api/health` trả trạng thái), CLI `node scripts/shadow.js status|run`. `fitModelsAtCutoff` được tách ra khỏi `runReplay` để live và replay dùng chung; report replay-v1 vẫn ra cùng sha256 `528720341bfb…` sau khi refactor.

**Kiểm chứng:**
- Test: parity shadow = replay; phát hành đúng hạn / trễ / bỏ lỡ; chấm chỉ khi nến target đã đóng; phát hành sau khi biết kết quả bị đánh dấu không hợp lệ; dòng cuối dở dang; chạy lại không ghi trùng và không tải nến; tắt máy 3 ngày; lock.
- Chạy thật: chu kỳ đầu ghi `start` + dự báo origin 2026-11-23 (late, phát hành 16:59 UTC). Chạy lại không ghi gì. `dataFingerprint` của dự báo trùng sha256 dataset đã đóng băng.
- `npm test`: 71 pass / 0 fail.

**Giới hạn:** shadow chỉ chạy khi server đang chạy, không có service hệ thống. Cần khoảng 30 dự báo đúng hạn đã chấm mới đọc được số sơ bộ, và vài trăm mới đủ để kết luận (VALIDATION_STRATEGY §5).

## Quyết định cần chốt trước P1 (theo REVISED_ROADMAP)

- Outcome chính: band theo biến động (k·σ point-in-time) hay band cố định. Phạm vi mặc định đề xuất: BTCUSDT, close ngày UTC, 24h.
- Phạm vi shadow forward và việc **lưu dữ liệu** vào `data/` (hiện `data/` chưa được gitignore).
- Có kiểm archive metrics của Binance (OI/LS) trước khi mở collector hay không.
