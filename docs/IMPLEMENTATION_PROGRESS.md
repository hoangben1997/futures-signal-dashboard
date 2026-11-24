# IMPLEMENTATION PROGRESS

Lộ trình đang theo: [REVISED_ROADMAP](REVISED_ROADMAP.md). Phạm vi được duyệt: **chỉ gói P0**. P1 (outcome, phạm vi shadow, lưu dữ liệu) cần quyết định riêng trước khi bắt đầu.

| Gói | Trạng thái | Cập nhật |
|---|---|---|
| P0-A. Hợp đồng UI/API: ngừng trình bày tỷ lệ chưa kiểm định | **Xong** | 2026-11-24 |
| P0-B. Cách ly historical model, fail closed cả hai đường | **Xong** | 2026-11-24 |
| P0-C. Kiểm tra qua entry point (+ smoke trình duyệt) | **Xong** | 2026-11-24 |
| P0-D. Vận hành: freshness, lỗi upstream, dedup fetch, render calendar | **Xong** | 2026-11-24 |
| P1 trở đi | **Chưa bắt đầu**, chờ quyết định | — |

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
5. USDC khi stale vẫn dùng sự kiện của cửa sổ 72h tại lần fetch thành công cuối. Ngưỡng hiển thị > 100M chỉ áp ở frontend, còn DiSSS dùng feed đầy đủ (INDEPENDENT_REVIEW §2, chưa nằm trong P0).
6. DiSSS "độ phủ dữ liệu" đang lẫn "thiếu dữ liệu" với "dữ liệu trung tính" (INDEPENDENT_REVIEW §2). Chưa đổi tên, vì không nằm trong P0.
7. ~~Server `listen` trên mọi interface.~~ **Đã xử lý 2026-11-24:** mặc định bind `127.0.0.1`, đổi bằng env `HOST`. Test HTTP kiểm `server.address().address`.
8. Ngưỡng stale theo nguồn (ví dụ F&G 48h, oiHist 2h) là lựa chọn vận hành, dễ đổi (`symbolSourceSpecs`/`GLOBAL_SOURCE_SPECS` trong `server.js`).
9. Trong lúc kiểm thử, ForexFactory trả 429 do server bị khởi động lại nhiều lần. Lỗi này giờ hiện trong `errors`. Khi lịch đang rỗng, cache thử lại sau 2 phút như cũ.
10. Smoke trình duyệt chạy bằng script tạm (Chrome + CDP), chưa nằm trong `npm test` (repo zero-dependency, không có browser runner).

## Quyết định cần chốt trước P1 (theo REVISED_ROADMAP)

- Outcome chính: band theo biến động (k·σ point-in-time) hay band cố định. Phạm vi mặc định đề xuất: BTCUSDT, close ngày UTC, 24h.
- Phạm vi shadow forward và việc **lưu dữ liệu** vào `data/` (hiện `data/` chưa được gitignore).
- Có kiểm archive metrics của Binance (OI/LS) trước khi mở collector hay không.
