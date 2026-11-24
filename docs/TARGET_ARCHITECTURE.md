# TARGET ARCHITECTURE

Trạng thái: **đề xuất, chờ duyệt**. Nguyên tắc: tái sử dụng `lib/indicators.js` và `lib/analysis.js`, giữ Node thuần và zero-dependency lâu nhất có thể, không rewrite.

## 1. Kiến trúc hiện tại (tóm tắt)

Một tiến trình `server.js` làm mọi việc: fetch, tính chỉ báo, mô hình, phục vụ HTTP/SSE. Không có lưu trữ. Chi tiết: [SYSTEM_AUDIT §1–2](SYSTEM_AUDIT.md).

## 2. Kiến trúc mục tiêu

Hệ thống được chia thành ba đường chạy, dùng chung **một** hàm tính đặc trưng:

```
                 ┌────────────── OFFLINE (CLI, chạy tay / theo lịch người dùng duyệt) ──────────────┐
 Binance public  │ history loader → data/cache/klines/{sym}/{tf}.jsonl (chỉ nến đã đóng)             │
 klines/funding ─┤        │                                                                         │
                 │        ▼                                                                         │
                 │ lib/features.js  (closed-only, causal)  ◄──────── dùng chung ────────┐           │
                 │        │                                                             │           │
                 │        ▼                                                             │           │
                 │ lib/labels.js (outcome k·σ) → lib/validation.js (walk-forward,       │           │
                 │        baseline, BSS, calibration) → data/models/{ver}.json          │           │
                 │                                   + data/reports/{ver}.json          │           │
                 └──────────────────────────────────────────────────────────────────────┼───────────┘
                                                                                        │
                 ┌────────────── ONLINE (server.js hiện có) ────────────────────────────┼───────────┐
 Binance/others ─┤ sources (giữ code fetch hiện tại) → metrics + technicals             │           │
                 │        │                                                             │           │
                 │        ├─► lib/features.js (cùng hàm) ───────────────────────────────┘           │
                 │        ├─► lib/levels.js + lib/reactions.js (key level, event)                   │
                 │        ├─► lib/forecast.js: load model ver → P(bull/bear/side) cho mỗi horizon   │
                 │        │      chỉ "published" nếu report của ver qua cổng skill                  │
                 │        ├─► lib/analysis.js (DiSSS: giữ nguyên vai trò mô tả)                     │
                 │        └─► snapshot JSON (thêm: forecast, levels, events, sources[].asOf, modelVersion)
                 │                                                                                  │
                 │ on candle close (closedCount tăng) ──► lib/ledger.js append forecast             │
                 └──────────────────────────────────────────────────────────────────────────────────┘
                 ┌────────────── RESOLVER ───────────────────────────────────────────────────────────┐
                 │ khi now ≥ targetTime: đọc nến đã đóng → append outcome (file riêng, không sửa forecast)│
                 └──────────────────────────────────────────────────────────────────────────────────┘
```

Quyết định:
- **Một hàm feature cho cả train và live.** Lý do: sửa tận gốc lỗi H6 (train/serve skew). Có test bất biến: chạy trên chuỗi bị cắt ở t phải cho ra cùng giá trị với chạy trên chuỗi đầy đủ ở t.
- **Chỉ dùng nến đã đóng cho feature.** Nến đang chạy chỉ dùng để hiển thị.
- **Model là một file JSON có version** (bảng tần suất hoặc hệ số logistic) do CLI offline tạo ra. Server chỉ đọc file này, không train lúc chạy. Lý do: tái lập được kết quả, và server khởi động nhanh.
- **Hai bộ não được hợp nhất:** `analysis.js` lo phần mô tả, `forecast.js` lo xác suất có kiểm định. `scoring.js` lùi về vai trò "rule breakdown" để tham khảo, không còn sinh % (cần duyệt).

## 3. Lưu trữ (Database Schema Improvements)

Đề xuất bắt đầu bằng **file JSONL append-only** trong `data/` (đã gitignore), không thêm dependency.
- Lý do: khối lượng rất nhỏ (3 symbol × 6 horizon × vài lần đóng nến mỗi ngày, cỡ vài trăm dòng/ngày). Append-only cũng dễ chứng minh "không sửa" hơn.
- Khi cần query phức tạp: chuyển sang `node:sqlite` (Node ≥ 22.5) hoặc Postgres (`DATABASE_URL` đã có trong `.env.example`). Đây là việc dễ đảo ngược.

| File | Khoá | Trường chính | Ghi chú |
|---|---|---|---|
| `data/cache/klines/{sym}/{tf}.jsonl` | `openTime` | o,h,l,c,v, takerBuyVol, closeTime | Chỉ nến đóng. Idempotent khi tải lại |
| `data/cache/funding/{sym}.jsonl` | `fundingTime` | rate | Lịch sử từ `fapi/v1/fundingRate` |
| `data/snapshots/{sym}/{yyyy-mm}.jsonl` | `ts` (mỗi giờ) | OI, L/S, top L/S, taker ratio, funding, F&G | Thu thập vì API không giữ lịch sử dài. **Đây là bảng tracking mới, cần duyệt riêng** |
| `data/ledger/forecasts.jsonl` | `forecastId` | createdAt, asOfBarClose, symbol, horizon, modelVersion, featureHash, features, probs{bull,bear,side}, published(bool), prevHash, hash | Append-only, hash chain |
| `data/ledger/outcomes.jsonl` | `forecastId` | resolvedAt, entryClose, exitClose, ret, sigma, label, mfe, mae | File riêng. Không bao giờ ghi vào forecasts |
| `data/models/{version}.json` | `version` | type, params/tables, trainRange, featureSpec, labelSpec | Bất biến |
| `data/reports/{version}.json` | `version` | metrics theo horizon/regime, baseline, CI, gate pass | Bất biến |

`hash = sha256(prevHash + JSON(record không gồm hash))`, dùng `node:crypto` (không thêm dependency). Hàm `verifyLedger()` báo vị trí đầu tiên bị sửa.

## 4. Key Level & Price Reaction Engine: định nghĩa toán học

Ký hiệu: nến đã đóng `t` có `O_t, H_t, L_t, C_t, V_t`. `ATR_t` = ATR(14) Wilder trên cùng khung. Level `ℓ`. Dải dung sai `τ = 0,25·ATR_t` (tham số, cố định ex-ante). `d_t = (C_t − ℓ)/ATR_t`.

**Levels (`lib/levels.js`)**: lấy từ nến D/W/M **đã đóng**:
- PDO/PDH/PDL/PDC, PWO/PWH/PWL/PWC, PMO/PMH/PML/PMC; DO/WO/MO = open của nến đang chạy (biết ngay từ đầu nến).
- Swing high/low: pivot `k=3`, gắn `confirmedAt = time(t+k)`.
- `touches(ℓ, lookback)` = số nến có `L ≤ ℓ+τ` và `H ≥ ℓ−τ`, mỗi cụm liên tiếp chỉ tính 1 lần.
- Giữ lại các cluster của `analysis.buildKeyLevels`, nhưng đổi độ rộng sang đơn vị ATR.

**Reaction events (`lib/reactions.js`)**: kiểm tra trên mỗi nến vừa đóng, cho mỗi level:

| Event | Điều kiện (hướng lên; hướng xuống đối xứng) | Biết được lúc |
|---|---|---|
| Breakout | `C_{t−1} ≤ ℓ` và `C_t > ℓ + τ` | Đóng nến t (realtime) |
| Acceptance(N) | Breakout tại t₀ và `C_{t₀+i} > ℓ` với mọi i = 1..N (mặc định N = 2) | t₀+N (trễ N nến) |
| Failed breakout(K) | Breakout tại t₀ và tồn tại i ≤ K với `C_{t₀+i} < ℓ` (mặc định K = 3) | Khi điều kiện xảy ra (≤ t₀+K) |
| Rejection | `H_t ≥ ℓ + τ` và `C_t < ℓ` và `C_{t−1} < ℓ` | Đóng nến t |
| Liquidity sweep | Rejection với ℓ thuộc {swing high, PDH, PWH, equal highs} | Đóng nến t |
| Retest | Sau Breakout tại t₀, có t ∈ (t₀, t₀+M] với `L_t ≤ ℓ + τ` và `C_t > ℓ` (M = 10) | Đóng nến t |
| S/R flip | Acceptance + Retest thành công | Đóng nến retest |
| Compression | `ATR(5)/ATR(50) ≤ p20` (percentile tính trên quá khứ) | Đóng nến t |
| Expansion | `TR_t / ATR_{t−1} ≥ 2` | Đóng nến t |

Mỗi event lưu: `type, level{kind, price}, tf, occurredAt, knowableAt, d_t, CLV_t, relVol_t, touchesBefore, mtfContext{trend 1D/1W, regime}`. Các event có `knowableAt > occurredAt` **không được** dùng làm feature tại `occurredAt`.

Lưu ý quan trọng: các tham số τ, N, K, M **phải chốt trước** khi chạy event study, rồi ghi vào `featureSpec`. Không tối ưu chúng trên toàn bộ dữ liệu.

## 5. API Improvements

| Endpoint | Thay đổi |
|---|---|
| `GET /api/snapshot` | Thêm `forecast: {modelVersion, generatedFromBarClose, horizons: {4h:{bull,bear,side, baseline:{…}, published, bss, n}}}`, `levels`, `events`, `sources: [{name, ok, asOf}]`. Bỏ dần `trend.scenarioProbabilities` và `trend.confidence` (cần duyệt; giai đoạn chuyển tiếp chỉ đổi nhãn) |
| `GET /api/forecast/history?symbol&horizon&limit` | Đọc ledger + outcomes |
| `GET /api/validation?version` | Trả `data/reports/{version}.json` |
| `GET /api/events/study?symbol&tf&event&level` | Kết quả event study đã tính sẵn (offline) |
| Hạ tải | Cache snapshot theo symbol (TTL = REFRESH_MS). Các nhóm timeframe dùng chung dữ liệu nguồn, chỉ khác phần `inferTrend`. CoinGecko/F&G cache ≥ 5 phút |

## 6. Feature Engineering Pipeline

Chi tiết ở [PROBABILITY_MODEL_DESIGN §3](PROBABILITY_MODEL_DESIGN.md). Nguyên tắc:
1. Input là chuỗi nến **đã đóng** đến t, cộng với các dữ liệu phụ có `asOf ≤ t`.
2. Mọi khoảng cách chuẩn hoá theo ATR hoặc σ. Mọi ngưỡng tính bằng percentile **chỉ trên quá khứ** (expanding window).
3. Xuất `featureHash` (hash của spec + giá trị) để ghi vào ledger.

## 7. Dashboard mục tiêu

Bố cục đề xuất, từ trên xuống:
1. **Header:** giá, regime (trend × vol), data freshness (chấm xanh/vàng/đỏ theo `asOf` từng nguồn), model version.
2. **Probability Matrix:** hàng là horizon (4h, 12h, 24h, 3d, 7d), cột là P(bull)/P(side)/P(bear). Mỗi ô hiện **model vs baseline** (ví dụ `Bull 31% (gốc 27%)`) cùng n và BSS. Horizon nào chưa qua cổng skill thì ô bị làm mờ và chỉ hiện baseline kèm dòng "chưa có edge kiểm chứng". 30d chỉ hiện phân phối.
3. **"Vì sao thay đổi":** so với lần đóng nến trước, liệt kê đặc trưng nào đổi và đóng góp bao nhiêu điểm %. Với logistic: Δ(β·x). Với bảng tần suất: ô điều kiện cũ → mới.
4. **Key levels + reaction events gần nhất:** khoảng cách theo ATR, số lần chạm.
5. **Conditional scenarios:** "Nếu nến 4H đóng trên PWH": n sự kiện, tần suất bull/bear/side so với baseline cùng regime, median/p10/p90 return, MFE/MAE, CI.
6. **Validation:** reliability diagram, Brier/BSS theo horizon và regime, lịch sử dự báo vs kết quả (từ ledger).
7. **Analysis (DiSSS):** giữ nguyên làm phần đọc thêm.
8. Thanh "Trend score" cũ: giữ, nhưng đổi nhãn thành điểm (không còn %), đặt trong phần chi tiết.
