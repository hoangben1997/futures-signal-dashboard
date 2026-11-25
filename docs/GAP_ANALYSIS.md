# GAP ANALYSIS

Đối chiếu năng lực mục tiêu (A–J) với code hiện tại. Bằng chứng chi tiết xem [SYSTEM_AUDIT](SYSTEM_AUDIT.md).

**Status:** COMPLETE · PARTIAL · MISSING · INCORRECT · UNVERIFIED
**Priority:** P0 lỗi tính đúng đắn · P1 cốt lõi · P2 chất lượng dự báo · P3 nâng cao · P4 chưa cần
**Complexity:** S (≤ 1 ngày) · M (2–4 ngày) · L (≥ 1 tuần)

Tài liệu này không chấm "% hoàn thiện" vì chưa có tiêu chí đo khách quan. Thay vào đó, mỗi dòng có tiêu chí nghiệm thu nằm trong [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md).

## 0. Lỗi tính đúng đắn (đọc trước)

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Historical model | Chạy được | INCORRECT | `server.js:806` gọi `clamp` không định nghĩa; API trả lỗi | try/catch nuốt lỗi → `null` | Mô hình + backtest không bao giờ chạy | — | Sửa **cùng lúc** với đổi cổng skill (dòng dưới), không sửa riêng | Gỡ lỗi im lặng | S | P0 | Cổng skill |
| Probability gate | Cổng có skill | INCORRECT | `analysis.js:50, :559` | Brier < 2/9 (đoán đều) | Luôn qua vì Sideway ~80%; mô hình thua climatology 5/15 ô (SYSTEM_AUDIT §4.2) | Baseline climatology, CI | BSS so với climatology > 0 với CI bootstrap không chứa 0 | Không hiển thị xác suất vô căn cứ | S | P0 | — |
| Scoring | "Xác suất kịch bản" | INCORRECT | `scoring.js:176-204`, `main-new.js:152-209` | 33,3 ± 15·pressure → chuẩn hoá → % | Điểm tuỳ ý trình bày như xác suất; không có định nghĩa outcome | — | Ẩn hoặc đổi nhãn thành "Điểm xu hướng (không phải xác suất)"; thay bằng ma trận xác suất có kiểm định khi có | Ngừng gây hiểu sai | S | P0 | Duyệt nghiệp vụ |
| Scoring | Confidence % | INCORRECT | `scoring.js:659`, `main-new.js:99` | 42 + 58·\|decision\| | "66%" mâu thuẫn với "tin cậy thấp" của analysis | — | Bỏ %, dùng nhãn định tính của `analysis.js` | Một nguồn sự thật | S | P0 | — |
| Scoring | Đếm trùng | INCORRECT | funding: `:467, :277, :114`; taker: `:554, :278, :113`; `:438` | Cùng tín hiệu cộng 2–3 lần | Phóng đại tín hiệu phái sinh | — | Một tín hiệu/một nơi; dùng family của `analysis.js` | Giảm thiên lệch | M | P0 | — |
| Scoring | Thiên lệch funding | INCORRECT | `scoring.js:114, :277` | Funding > 0 bất kỳ → bearish | Funding mặc định ~+0,01% → luôn kéo giảm | Z-score funding | Dùng z-score/percentile funding lịch sử | Bỏ bias cấu trúc | S | P0 | Funding history |
| Backtest | Leakage | INCORRECT | `server.js:962` (median vol trên cả test), `:1387` (ngưỡng 30d gần nhất gắn nhãn cả năm), `:827` (không purge) | Split 70/30 một lần | Số Brier lạc quan | Purge/embargo | Pipeline walk-forward mới | Số đo trung thực | M | P0 | Dataset |
| Historical model | Train/serve skew | INCORRECT | `server.js:932, 942` vs `:1067-1082` | Momentum/vol live ≠ lúc train | Tra sai ô điều kiện | — | Một hàm tính đặc trưng dùng chung train và live | Đúng ô | M | P0 | Dataset |
| Data | Incomplete candle | INCORRECT | `server.js:1195-1200` (`closeChange*` dùng nến đang chạy); `indicators.js:246-258` | Nến đang chạy vào tín hiệu | Tín hiệu đổi trong nến; không tái lập được | Chỉ dùng nến đóng cho feature | Tách `display` (gồm nến chạy) và `features` (chỉ nến đóng) | Tái lập, không look-ahead | S | P0 | — |
| UI | Badge vs outlook | INCORRECT | `main-new.js:86` (0,25 cứng) vs `scoring.js:637` (weak tune) | Hai ngưỡng | Badge có thể khác outlook | — | Dùng `trend.outlook` | Nhất quán | S | P1 | — |

## A. Multi-Timeframe Analysis

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MTF | Khung 1M/1W/1D/4H/1H | PARTIAL | `server.js:1206-1212` | 400 nến/khung; 1M từ spot | MA/RSI gồm nến đang chạy | — | Giữ; thêm cờ closed-only cho feature | — | S | P1 | — |
| MTF | 15M, 8H, 12H, 3D | MISSING | — | 8h/12h/3d chỉ là nhãn horizon | — | Klines 15m/8h/12h/3d (Binance có sẵn) | Thêm feed; 15M chỉ khi có horizon ≤ 4h cần | Đủ ma trận | S | P2 | — |
| MTF | HH/HL/LH/LL | COMPLETE | `indicators.js:111-164`, test `:72` | Pivot 3 nến + phá cấu trúc | Thời điểm xác nhận trễ 3 nến chưa ghi vào output | `confirmedAt` | Thêm `confirmedTime` cho backtest | Không look-ahead | S | P1 | — |
| MTF | Trend direction/strength | PARTIAL | MA stack, MA200 (`indicators.js:265-270`) | Định tính | Không có strength định lượng | ADX hoặc slope/σ, efficiency ratio | Thêm `trendStrength = slope(MA)/ATR` hoặc ER | Feature liên tục cho model | S | P2 | ATR |
| MTF | Market regime | PARTIAL | `analysis.js:796-799` | Bull/bear/transition theo MA200W | Không có vol regime | Vol regime (percentile realized vol) | Regime = trend × vol (2×3 ô) | Phân tầng đánh giá | S | P1 | — |
| MTF | Alignment/Conflict | PARTIAL | `analysis.js:580-601` | Text mâu thuẫn dài/ngắn | Không có ma trận số | Ma trận TF × hướng | Bảng trạng thái từng TF (closed-only) | UI + feature | S | P2 | — |
| MTF | Điều chỉnh vs đảo chiều | PARTIAL | `findConflicts` text | Diễn giải | Chưa kiểm định | Event study: "LTF phá cấu trúc ngược HTF" → forward | Định nghĩa + đo | Trả lời câu hỏi có số | M | P2 | Event study |
| MTF | Momentum/Volatility | PARTIAL | RSI/MACD; `realizedVol24h` | Vol chỉ 1 con số (thực chất 72h) | Tên sai, không có ATR | ATR, vol percentile | Thêm ATR(14) mọi TF | Chuẩn hoá mọi khoảng cách | S | P1 | — |

## B. Candle Close Analysis

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Candle | OHLCV | COMPLETE | `klinesToCandles` | — | Bỏ cột taker buy volume `[9]` | Taker buy vol | Giữ thêm `takerBuyVolume` | Proxy CVD | S | P1 | — |
| Candle | CLV | PARTIAL | `indicators.js:234` (`closePositionInRange`) | Chỉ nến đóng cuối; chỉ 1D vào evidence | Chưa kiểm giá trị | Series CLV | Feature CLV mọi TF; kiểm bằng event study | Sơ bộ: edge yếu (AUDIT §4.3) | S | P2 | Dataset |
| Candle | Body/Wick ratio | PARTIAL | `candleCharacter` `:216-237` | Chỉ phân loại shape | Ratio không xuất ra | body/range, upper/lower wick/range | Xuất số | Feature | S | P2 | — |
| Candle | Relative volume | PARTIAL | `lastClosedVolRatio` `:273` | vol / SMA20 | Chỉ nến cuối | Series | Feature | — | S | P2 | — |
| Candle | Range expansion / ATR-normalized | MISSING | — | — | — | ATR, range/ATR | Thêm | Phát hiện compression/expansion | S | P1 | ATR |
| Candle | Close vs key level | MISSING | — | — | — | Khoảng cách (đơn vị ATR) tới level | `distATR(level)` | Lõi reaction engine | M | P1 | Key level v2 |
| Candle | Chuỗi nến liên tiếp | MISSING | — | — | — | Đếm nến đóng trên/dưới level | Counter | Acceptance | S | P1 | Key level v2 |
| Candle | Thay đổi cấu trúc khi 4H/8H/1D/1W/1M đóng | MISSING | — | Tính lại mỗi 60s, không có event "nến vừa đóng" | Không phân biệt intrabar/đóng | Close-event hook | Phát event khi `closedCount` tăng → snapshot features + log | Dự báo gắn mốc đóng nến | M | P1 | Ledger |

## C. Key Level Engine

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Levels | PD/PW/PM O-H-L-C | MISSING | — | — | Đây là level phổ biến và kiểm định được nhất | Tính từ nến D/W/M đã đóng | `lib/levels.js` | Rẻ, giá trị cao | S | P1 | — |
| Levels | Current D/W/M open | MISSING | — | — | — | Open nến đang chạy | Như trên | — | S | P1 | — |
| Levels | Swing high/low | PARTIAL | `recentSwings` 1d/4h (3 gần nhất) | — | Ít, không đếm touch | Lịch sử swing + touch count | Mở rộng | — | S | P2 | — |
| Levels | S/R cluster | PARTIAL | `buildKeyLevels` `analysis.js:387` | Gom MA/swing/fib/round trong 0,6% | Độ mạnh = số loại nguồn, chưa kiểm; tolerance % không theo ATR | Touch count, độ rộng theo ATR, tuổi level | Width = 0,25·ATR; score = touches + nguồn; ghi lại để kiểm | Định lượng | M | P2 | ATR |
| Levels | ATH/ATL | MISSING | — | — | — | Từ nến M | Thêm | — | S | P3 | — |
| Levels | Psychological levels | PARTIAL | `roundStep` `:380` | Bước ~6% giá | — | — | Giữ | — | — | P4 | — |
| Levels | Volume profile POC/VAH/VAL | MISSING | — | — | Cần volume-at-price | Dựng từ nến 15m/1h (xấp xỉ) | P3 sau khi có event study | AMT | L | P3 | Data 15m |
| Levels | VWAP / Anchored VWAP | MISSING | — | — | — | VWAP tuần/tháng, AVWAP từ swing | Tính từ nến 1h | Level động | M | P3 | — |
| Levels | Liquidity zones | PARTIAL (suy luận) | `liquidityNotes` `analysis.js:624` | Swing = chỗ có stop | Không có dữ liệu thật; đã gắn nhãn suy luận | Equal highs/lows | Giữ nhãn suy luận; thêm equal-high/low detection | — | S | P3 | — |

## D. Price Reaction Engine

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Reaction | Breakout/Breakdown | PARTIAL | `classifyStructure.broken` `indicators.js:147-153`; text "nến ngày đóng trên X" `analysis.js:497` | Close vượt pivot gần nhất | Chỉ 1 loại level; không lưu sự kiện | Định nghĩa trên mọi key level | Spec ở TARGET_ARCHITECTURE §4 | Lõi conditional engine | M | P1 | Key level v2 |
| Reaction | Acceptance | MISSING | — | — | — | N nến đóng ngoài level | Spec §4 | — | S | P1 | Breakout |
| Reaction | Rejection | MISSING | — | Shape "râu dài" không gắn level | — | Wick xuyên level, close quay lại | Spec §4 | — | S | P1 | Key level v2 |
| Reaction | Retest | MISSING | — | — | — | Sau breakout, low chạm lại level ± tol | Spec §4 | — | S | P2 | Breakout |
| Reaction | Failed breakout/breakdown | MISSING | — | — | Chỉ xác nhận được sau K nến (có độ trễ) | — | Spec §4, gắn `confirmedAt` | — | S | P2 | Breakout |
| Reaction | Liquidity sweep | MISSING | — | — | — | High > level, close < level, trong 1 nến | Spec §4 (= rejection trên swing/PDH) | — | S | P2 | — |
| Reaction | S/R flip | MISSING | — | — | — | Breakout + retest giữ | Spec §4 | — | S | P3 | Retest |
| Reaction | Compression/Expansion | MISSING | — | — | — | ATR(5)/ATR(50), range percentile | Spec §4 | Feature vol regime | S | P2 | ATR |
| Reaction | Absorption | MISSING | — | Câu "hấp thụ lực bán" `analysis.js:194` là suy luận | Không đủ dữ liệu | Order flow tick | Không làm; giữ nhãn suy luận | — | — | P4 | — |
| Reaction | Phân biệt realtime vs confirmed-later | MISSING | — | — | — | Trường `knowableAt` | Mọi event có `occurredAt` + `confirmedAt` | Chống look-ahead | S | P1 | — |

## E. Market Intelligence

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MI | Funding | PARTIAL | `server.js:1402` | Giá trị tức thời | Ngưỡng tay, 2 bộ ngưỡng khác nhau | Lịch sử, z-score | Tải `fundingRate` history | Feature kiểm được | S | P1 | — |
| MI | OI, L/S, taker ratio | PARTIAL | `server.js:1302-1305` | 1h gần nhất | API không có lịch sử dài (~30 ngày) [cần kiểm] | Tự lưu | **Bắt đầu lưu ngay** (ledger snapshot 1h) | Có dữ liệu sau 3–6 tháng | S | P1 | Ledger |
| MI | CVD | MISSING | — | — | — | Kline `[9]` | Proxy CVD từ klines (có lịch sử) | Rẻ, kiểm được | S | P2 | — |
| MI | Liquidations | MISSING | — | Link CoinGlass | Không có lịch sử miễn phí | — | Không làm bây giờ | — | — | P4 | — |
| MI | Order book imbalance | MISSING | — | — | Chỉ realtime, chi phí cao | — | Không làm | — | — | P4 | — |
| MI | Spot/Futures basis | MISSING | `markPrice` có nhưng không dùng | — | — | Spot klines | Basis = futures/spot − 1 | Rẻ | S | P3 | — |
| MI | BTC dominance | PARTIAL | `scoring.js:284-290` | Ngưỡng 52/56 cứng | Không có lịch sử free | — | Giữ hiển thị, bỏ khỏi scoring | — | S | P3 | — |
| MI | Stablecoin | PARTIAL | USDC treasury 72h `server.js:110-373` | Mint/burn | Proxy hẹp, 3 nguồn fallback phức tạp | Tổng cung stablecoin | DefiLlama (horizon ≥ 3d) | — | M | P3 | — |
| MI | On-chain khác, ETF flow | MISSING | — | — | — | — | Chỉ cho horizon 7–30d | — | M | P4 | — |
| MI | Macro DXY/yields/CPI | PARTIAL | Lịch ForexFactory `server.js:544-630` | Cảnh báo sự kiện 72h | Không có giá trị thực tế vs kỳ vọng | FRED | Giữ cảnh báo; macro số liệu P4 | — | M | P4 | — |
| MI | Sentiment F&G | PARTIAL | `server.js:1311` | Giá trị hiện tại | — | Lịch sử | Tải lịch sử để kiểm | — | S | P3 | — |
| MI | Deribit IV | UNVERIFIED | `server.js:1427` | `mark_iv` của perpetual | Có thể không phải IV option | DVOL | Kiểm lại hoặc bỏ | — | S | P3 | — |
| MI | Data freshness | MISSING | Chỉ có `errors[]` | — | Không biết số liệu cũ bao lâu | `asOf` từng nguồn | Thêm `sources[{name, asOf, ok}]` | Tin cậy UI | S | P1 | — |

## F. Probability Forecast Engine

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Forecast | Horizons 4h/12h/24h/3d/7d | PARTIAL | `server.js:1058-1065` | Có nhưng crash | H1–H11 | — | Thiết kế lại (PROBABILITY_MODEL_DESIGN) | — | L | P1 | Dataset |
| Forecast | 30d | MISSING | — | — | ~85 mẫu độc lập | — | Chỉ phân phối theo regime, không claim skill | Trung thực | S | P3 | — |
| Forecast | Định nghĩa outcome | INCORRECT | `classifyOutcome` `server.js:703` + ngưỡng p75 30d | 80% Sideway | Mất cân bằng; ngưỡng rò rỉ | — | Ngưỡng k·σ trượt, ex-ante (Design §2) | Lớp cân hơn | S | P1 | — |
| Forecast | Phương pháp | INCORRECT | scoring.js (weighted scoring) + historical conditional frequency + tilt | Blend tuỳ ý | — | Climatology, shrinkage, logistic | Bậc thang M0→M1→M2 (Design §4) | — | L | P1 | Validation |
| Forecast | Tổng = 100% | COMPLETE (hình thức) | `normalizeProbability` | Chuẩn hoá | Chuẩn hoá ≠ hiệu chuẩn | Calibration | — | — | — | P2 | — |
| Forecast | LLM | — (không dùng) | — | — | — | — | Giữ không dùng LLM cho số | — | — | — | — |

## G. Conditional Scenario Engine

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Scenario | "Nếu nến X đóng trên level Y" | PARTIAL (text) | `analysis.js:497-531` | Câu điều kiện xác nhận/vô hiệu | Không có số | Event study | Engine event study (Design §6) | Trả lời đúng câu hỏi | M | P1 | Levels, Reaction, Dataset |
| Scenario | Giá tăng nhưng OI/Volume không xác nhận | PARTIAL | `analysis.js:229-240` (6h) | Text | OI không có lịch sử | Lịch sử OI tự lưu | Sau 3–6 tháng log | — | M | P3 | Ledger |
| Scenario | Phân biệt điều kiện vs nhân quả | MISSING | — | — | — | Câu chữ chuẩn | Template "Trong quá khứ, khi…" + n + CI | — | S | P1 | — |

## H. Historical Similarity Engine

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Similarity | Tìm trạng thái tương đồng | PARTIAL | Buckets `momentum×vol` `server.js:963-977` | 6 ô | Thô | — | Event study trước; kNN sau | — | L | P3 | Dataset |
| Similarity | n, tần suất, quantile, MFE/MAE, CI | MISSING | Chỉ có n + tần suất | — | — | Thống kê đầy đủ | Hàm `summarizeOutcomes()` dùng chung | — | M | P1 | Dataset |
| Similarity | Chồng lấn mẫu | INCORRECT | Bước 1 bar, horizon h | — | n bị thổi phồng | n hiệu dụng, de-cluster | Lấy sự kiện đầu tiên trong cửa sổ h | Trung thực | S | P1 | — |

## I. Forecast Validation Engine

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Validation | Walk-forward + purge/embargo | MISSING | Split 70/30 `server.js:827` | — | — | — | `lib/validation.js` (VALIDATION_STRATEGY §3) | — | M | P0 | Dataset |
| Validation | Brier / Log loss / ECE / Confusion | PARTIAL | Brier, top1 `server.js:847-878` | — | Không có log loss, reliability, BSS | — | Thêm đầy đủ | — | S | P1 | — |
| Validation | Baseline comparison | INCORRECT | Đoán đều | — | — | Climatology, persistence | — | — | S | P0 | — |
| Validation | Theo horizon/regime | MISSING | — | — | — | — | Bảng phân tầng | — | S | P1 | Regime |
| Validation | Lưu dự báo trước kết quả | MISSING | Không có ghi file | — | Không đo được live | Ledger append-only | `data/ledger/*.jsonl` + hash chain | Bằng chứng live | M | P1 | — |
| Validation | Không sửa dự báo cũ | MISSING | — | — | — | Hash chain | — | — | S | P1 | Ledger |
| Validation | Multiple testing / data snooping | MISSING | — | — | — | Pre-registration, BH | VALIDATION_STRATEGY §7 | — | S | P1 | — |

## J. Dashboard

| Module | Feature | Status | Evidence | Current Logic | Problems | Missing | Proposed Improvement | Benefit | Cx | Pri | Deps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| UI | Market overview | COMPLETE | `renderMetrics` | — | — | — | Giữ | — | — | — | — |
| UI | MTF trend matrix | PARTIAL | `renderTechnicals` `main-new.js:702` | Bảng chỉ báo | Không có ô trạng thái tổng hợp | — | Thêm cột structure/trend/vol regime | — | S | P2 | — |
| UI | Trend probability matrix | INCORRECT | Thanh xác suất 1 horizon | Heuristic | — | Horizon × lớp + baseline | Ma trận + cột "baseline" + BSS + n | Hiểu đúng | M | P1 | Model |
| UI | Key levels | PARTIAL | Bảng trong analysis | — | — | PD/PW/PM | Sau Levels v2 | — | S | P2 | Levels |
| UI | Reaction events, conditional, similar events, return distribution | MISSING | — | — | — | — | Panel event study | — | M | P2 | Engine |
| UI | Probability history, accuracy, calibration, prediction history | MISSING | — | — | — | — | Panel từ ledger | — | M | P2 | Ledger |
| UI | Data freshness, model version | MISSING | — | — | — | — | Footer/badge | — | S | P1 | — |
| UI | Explainability | PARTIAL | Contribution chips | Của điểm, không của xác suất | — | — | "Vì sao xác suất đổi": diff đặc trưng so với lần trước | — | M | P2 | Model |
| UI | Hai bộ não mâu thuẫn | INCORRECT | Thanh trên (scoring) vs Analysis | — | Hai kết luận, hai "confidence" | — | Một kết luận; scoring chỉ còn là chi tiết | Rõ ràng | S | P1 | Duyệt |

## Tổng hợp theo priority

- **P0 (10):** cổng skill, xác suất heuristic, confidence %, đếm trùng, bias funding, leakage backtest, train/serve skew, incomplete candle, walk-forward, baseline. Sửa `clamp` đi chung với cổng skill.
- **P1:** dataset nhân quả, outcome definition, Levels v2 (PD/PW/PM), reaction events cơ bản, event study, ledger, data freshness, regime, hợp nhất kết luận UI.
- **P2:** logistic, CVD proxy, CLV/wick features, ATR-normalized, ma trận UI, explainability.
- **P3/P4:** volume profile, VWAP, similarity kNN, macro, ETF, order book, liquidation, absorption, ensemble.
