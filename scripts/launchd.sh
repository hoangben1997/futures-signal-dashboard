#!/usr/bin/env bash
# Chạy dashboard (kèm shadow forward) như LaunchAgent của macOS: tự khởi động khi đăng nhập,
# tự chạy lại nếu tiến trình chết. Máy ngủ/tắt thì vẫn không chạy (shadow ghi late/missed).
#
#   scripts/launchd.sh install     # cài và khởi động
#   scripts/launchd.sh status      # trạng thái + /api/health
#   scripts/launchd.sh logs        # 50 dòng log cuối
#   scripts/launchd.sh uninstall   # dừng và gỡ
set -euo pipefail

LABEL="local.futures-signal-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/futures-signal-dashboard.log"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

port() {
  local p
  p="$(grep -E '^PORT=' "$REPO/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
  echo "${p:-7000}"
}

case "${1:-status}" in
  install)
    NODE="$(command -v node)"
    [ -n "$NODE" ] || { echo "Không tìm thấy node trong PATH"; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Đã cài $LABEL (node: $NODE, repo: $REPO, log: $LOG)"
    echo "Dashboard: http://localhost:$(port)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Đã gỡ $LABEL"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" | sed 's/^[[:space:]]*/  /'
      curl -s -m 5 "http://127.0.0.1:$(port)/api/health" || echo "  (chưa trả lời /api/health)"
      echo
    else
      echo "$LABEL chưa được cài"
    fi
    ;;
  logs)
    tail -n 50 "$LOG" 2>/dev/null || echo "Chưa có log ($LOG)"
    ;;
  *)
    echo "Dùng: $0 install | status | logs | uninstall"; exit 1
    ;;
esac
