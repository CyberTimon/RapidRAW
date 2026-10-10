#!/usr/bin/env bash
# Starts the relay + RapidRAW Web Bridge. Ctrl+C stops both; the relay restarts by itself if it stops.
#   RR_PHOTOS=/mnt/photos ./run.sh
# Env: RR_PHOTOS (required), RR_PORT, RR_HOST, RR_AUTH=user:pass, RR_VERBOSE=1, RR_BRIDGE_BIN
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ID=io.github.CyberTimon.RapidRAW.Web
: "${RR_PHOTOS:?set RR_PHOTOS=/path/to/photos}"
command -v node >/dev/null || { echo "Node.js 20+ is not installed"; exit 1; }

BIN="${RR_BRIDGE_BIN:-}"
for c in "$HERE/../src-tauri/target/release/rapidraw-web-bridge" "$(command -v rapidraw-web-bridge || true)" "$HERE"/*.AppImage; do
  [ -z "$BIN" ] && [ -n "$c" ] && [ -x "$c" ] && BIN="$c"
done
[ -n "$BIN" ] || { echo "rapidraw-web-bridge not found (set RR_BRIDGE_BIN)"; exit 1; }

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$ID"; CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/$ID"
mkdir -p "$DATA" "$CACHE"
export RR_ROOTS="${RR_ROOTS:-$RR_PHOTOS:$DATA:$CACHE}"
export RR_CONFIG="${RR_CONFIG:-$DATA/rrweb.json}"   # photo library folder from the RapidRAW Web window
export RR_WORK="${RR_WORK:-$CACHE/remote}"          # folders from browsing computers (mirror, cache, FUSE)
export RR_LOG="${RR_LOG:-$DATA/logs/relay.log}"     # copy of the relay's output

# Headless server without a screen → Xvfb (WebKitGTK needs a display; wgpu/Vulkan doesn't)
LAUNCH=()
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  command -v xvfb-run >/dev/null || { echo "No display: install xvfb (xvfb-run)"; exit 1; }
  LAUNCH=(xvfb-run -a)
fi

# Restart a relay that stops (the bridge and the browser reconnect by themselves). Exit 0 = a clean shutdown;
# if it stops right after starting (e.g. the port is taken), give up.
relay_loop() {
  local pid="" code quick=0 started
  trap '[ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 0' TERM INT
  while :; do
    started=$SECONDS
    node "$HERE/relay/relay.mjs" & pid=$!
    code=0; wait "$pid" || code=$?
    [ "$code" -eq 0 ] && exit 0
    if [ $((SECONDS - started)) -lt 10 ]; then quick=$((quick + 1)); else quick=0; fi
    [ "$quick" -ge 3 ] && { echo "[run.sh] relay keeps failing (exit $code), giving up" >&2; kill -TERM $$ 2>/dev/null; exit 1; }
    echo "[run.sh] relay exited (exit $code), restarting in 2 s" >&2
    sleep 2
  done
}
APP=""
relay_loop & RELAY=$!
trap 'kill $RELAY $APP 2>/dev/null' EXIT INT TERM
sleep 0.5
"${LAUNCH[@]}" "$BIN" & APP=$!
wait "$APP" || true
