#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/var/home/fazdev/deepseek-harness"
cd "$REPO_DIR"

export DSH_TELEMETRY_DISABLED=1
URL_FILE="$HOME/.dsh/web.url"
mkdir -p "$HOME/.dsh"

# Cek apakah backend di port 3080 sedang aktif
if ! ss -tlnp 2>/dev/null | grep -q ":3080 "; then
  echo "Memulai server Boson Studio backend..."
  LOG_FILE="/tmp/dsh-web.log"
  rm -f "$LOG_FILE"
  
  node --import tsx/esm apps/cli/src/bin.ts web --no-open > "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > /tmp/dsh-web.pid

  # Tunggu URL token ter-generate
  for _ in {1..60}; do
    if grep -q "dsh web: http" "$LOG_FILE" 2>/dev/null; then
      grep -o "http://127.0.0.1:3080/?token=[^ ]*" "$LOG_FILE" | head -n 1 > "$URL_FILE"
      break
    fi
    sleep 0.5
  done
fi

TARGET_URL=$(cat "$URL_FILE" 2>/dev/null || echo "http://127.0.0.1:3080/")

echo "Membuka Boson Studio App Window: $TARGET_URL"

# Buka dalam mode native app window (tanpa browser tabs & address bar)
# Menggunakan user-data-dir terisolasi agar TIDAK bergabung ke browser session yang sedang browsing biasa
if command -v flatpak &>/dev/null && flatpak info com.google.Chrome &>/dev/null; then
  exec flatpak run com.google.Chrome --user-data-dir="$HOME/.config/dsh-chrome" --app="$TARGET_URL"
elif command -v google-chrome &>/dev/null; then
  exec google-chrome --user-data-dir="$HOME/.dsh/chrome-profile" --app="$TARGET_URL"
elif command -v chromium &>/dev/null; then
  exec chromium --user-data-dir="$HOME/.dsh/chrome-profile" --app="$TARGET_URL"
else
  exec xdg-open "$TARGET_URL"
fi
