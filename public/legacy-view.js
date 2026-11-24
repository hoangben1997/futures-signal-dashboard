/**
 * Dựng nội dung hiển thị cho phần rule-based cũ (lib/scoring.js) và trạng thái mô hình.
 * Hàm thuần, không đụng DOM, để test được bằng `node --test`.
 *
 * Hợp đồng P0 (docs/REVISED_ROADMAP.md): chưa có xác suất nào qua kiểm định ngoài mẫu, nên
 * - không hiển thị trend.scenarioProbabilities, trend.confidence dưới dạng %;
 * - mức breakout chỉ là "mức theo dõi", không phải outcome dự báo;
 * - số của mô hình thống kê chỉ hiện khi đã qua kiểm định (stat.hasSkill).
 */

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function money(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  return `$${nf.format(v)}`;
}

function signed(v, digits = 2) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

const HORIZON_LABEL = { 4: '4h', 8: '8h', 12: '12h', 24: '1d', 72: '3d', 168: '1w' };

const OUTLOOK_BADGE = {
  'Bullish Bias': { text: 'BULLISH', outlook: 'BULLISH BIAS' },
  'Bearish Bias': { text: 'BEARISH', outlook: 'BEARISH BIAS' },
  'Sideways / High-Noise': { text: 'SIDEWAYS', outlook: 'SIDEWAYS' }
};

export const UNVERIFIED_NOTE = 'Điểm rule-based chưa kiểm định, không phải xác suất.';

// Thanh trên cùng: badge lấy đúng trend.outlook của backend (cùng ngưỡng với playbook).
export function decisionBarView(trend = {}) {
  const badge = OUTLOOK_BADGE[trend.outlook] || { text: 'N/A', outlook: 'SIDEWAYS' };
  const strength = Number(trend.decision?.score);
  const score = Number(trend.score);
  return {
    badgeText: badge.text,
    badgeOutlook: badge.outlook,
    strengthText: Number.isFinite(strength) ? Math.abs(strength).toFixed(2) : '--',
    strengthTitle: `Độ lớn điểm quyết định (0–1). ${UNVERIFIED_NOTE}`,
    scoreText: Number.isFinite(score) ? score.toFixed(2) : '--'
  };
}

// Panel kịch bản theo horizon đang chọn: chỉ còn mức theo dõi + thông báo chưa có xác suất kiểm định.
export function scenarioPanelView(trend = {}, timeframeHours = 4) {
  const horizon = HORIZON_LABEL[timeframeHours] || `${timeframeHours}h`;
  const b = trend.breakoutLevels;
  const monitoring = b && Number.isFinite(Number(b.currentPrice))
    ? {
        header: `Mức theo dõi khung ${b.timeframeLabel}`,
        aboveLabel: 'Đóng trên',
        above: money(b.bullishAbove),
        belowLabel: 'Đóng dưới',
        below: money(b.bearishBelow),
        footer: `Close nến trước: ${money(b.basePrice)} | Giá hiện tại: ${money(b.currentPrice)} | Ngưỡng: ±${b.thresholdPct}%`,
        note: 'Mức theo dõi = close nến đã đóng trước đó ± ngưỡng biến động (p75 của 30 ngày). Giá đóng qua mức này không phải outcome dự báo đã kiểm định.'
      }
    : null;
  return {
    horizonNote: `Horizon đang chọn: ${horizon}. Panel này đổi theo bộ chọn horizon; báo cáo DiSSS phía trên luôn dùng nến ngày (1–7 ngày).`,
    monitoring,
    probabilityNotice: 'Chưa có xác suất kịch bản nào qua kiểm định ngoài mẫu cho horizon này. Tỷ lệ heuristic cũ đã được ẩn vì chưa có định nghĩa outcome và chưa được backtest.'
  };
}

export function playbookBasisLines(basis) {
  if (!basis) return [];
  const labels = {
    structure: 'Cấu trúc',
    derivatives: 'Phái sinh',
    regime: 'Bối cảnh thị trường',
    macroTime: 'Vĩ mô/Thời điểm'
  };
  const lines = [];
  if (Array.isArray(basis.factors) && basis.factors.length) {
    const top = basis.factors.slice(0, 3).map((f) =>
      `${labels[f.key] || f.key}: ${signed(f.component)} × ${Number(f.weight).toFixed(2)} = ${signed(f.contribution, 3)}`
    );
    lines.push(`Yếu tố chính: ${top.join(' | ')}`);
  }
  if (basis.confirmation) {
    lines.push(
      `Mức theo dõi ${String(basis.confirmation.timeframe || '').toUpperCase()}: đóng trên ${money(basis.confirmation.bullishAbove)}, đóng dưới ${money(basis.confirmation.bearishBelow)}, ngưỡng ±${basis.confirmation.thresholdPct}%`
    );
  }
  if (Array.isArray(basis.activeRules) && basis.activeRules.length) {
    const ruleText = basis.activeRules
      .slice(0, 3)
      .map((r) => `${r.name} (${signed(Number(r.score || 0), 0)})`)
      .join(' | ');
    lines.push(`Quy tắc đang tác động: ${ruleText}`);
  }
  if (basis.decision) {
    const d = basis.decision;
    lines.push(
      `Điểm quyết định: ${signed(Number(d.score || 0), 3)} | Chênh điểm kịch bản heuristic (Tăng−Giảm): ${signed(Number(d.probEdge || 0), 3)} | Tín hiệu so với mức theo dõi: ${signed(Number(d.confirmSignal || 0), 3)} | Hệ số chất lượng: ${Number(d.qualityAdj || 0).toFixed(3)} | Ngưỡng nhẹ/mạnh: ${Number(d.thresholds?.weak || 0).toFixed(3)}/${Number(d.thresholds?.strong || 0).toFixed(3)}`
    );
  }
  lines.push(UNVERIFIED_NOTE);
  return lines;
}

export function historicalModelStatusText(contract) {
  if (contract?.historicalModel === 'disabled') {
    return 'Mô hình kịch bản lịch sử đang tắt: thiết kế cũ có leakage và chưa chứng minh được giá trị ngoài mẫu (docs/SYSTEM_AUDIT.md §4.2).';
  }
  return 'Chưa có kết quả kiểm định ngoài mẫu.';
}

// Ghi chú dưới 3 kịch bản DiSSS: chỉ đưa số khi mô hình đã qua kiểm định.
export function statisticalNoteText(stat) {
  if (stat?.hasSkill) {
    return `Mô hình thống kê 1d (đã kiểm định): Tăng ${stat.up}% · Giảm ${stat.down}% · Ngang ${stat.sideway}% (n=${stat.samples}). ${stat.verdict}`;
  }
  if (stat) return `Mô hình thống kê 1d: ${stat.verdict}`;
  return 'Không có mô hình thống kê đã kiểm định → không đưa xác suất bằng số, chỉ dùng mức tin cậy.';
}

function ageText(fromIso, nowMs) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  const min = Math.round((nowMs - t) / 60000);
  if (min < 60) return `${min} phút`;
  if (min < 48 * 60) return `${Math.round(min / 60)} giờ`;
  return `${Math.round(min / 1440)} ngày`;
}

// Cảnh báo nguồn: lỗi (đã ghi trong snapshot.errors) không lặp lại; ở đây chỉ báo dữ liệu cũ.
export function staleSourceAlerts(sources = [], nowMs = Date.now()) {
  return (Array.isArray(sources) ? sources : [])
    .filter((s) => s?.stale)
    .map((s) => {
      const observed = s.observedAt ? ageText(s.observedAt, nowMs) : null;
      const fetched = s.fetchedAt ? ageText(s.fetchedAt, nowMs) : null;
      if (!s.ok) return `${s.name}: lần lấy mới nhất lỗi, đang dùng dữ liệu cũ${fetched ? ` (nhận cách đây ${fetched})` : ''}.`;
      return `${s.name}: dữ liệu cũ${observed ? `, điểm dữ liệu mới nhất cách đây ${observed}` : ''}.`;
    });
}
