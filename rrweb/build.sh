#!/usr/bin/env bash
# Builds the browser UI (rrweb/dist-web), the bridge variant of RapidRAW and the relay.
# BUNDLES=deb,rpm,appimage ./rrweb/build.sh  → also installer packages
# The bridge is all-in-one: bundled Node.js + relay + web UI (rrweb/bundle/prepare.mjs), on Linux and Windows also rrweb-fuse.
# RR_PLAIN=1 → only the bridge, without the bundled relay (the relay is then started with run.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
node rrweb/check-shims.mjs
npm ci --no-audit --no-fund
npx vite build --config rrweb/vite.web.config.mjs
(cd rrweb/relay && npm install --omit=dev --no-audit --no-fund)
if [ "$(uname -s)" = Linux ] || [ "${OS:-}" = Windows_NT ]; then   # on-demand folders from browsing computers (FUSE / WinFsp)
  cargo build --release --manifest-path rrweb/fuse/Cargo.toml
  if [ "$(uname -s)" = Linux ]; then   # for run.sh from the repository
    mkdir -p "rrweb/fuse/$(uname -m)" && cp rrweb/fuse/target/release/rrweb-fuse "rrweb/fuse/$(uname -m)/"
  fi
fi
CONFIGS=(--config rrweb/tauri.bridge.json)
if [ -z "${RR_PLAIN:-}" ]; then
  node rrweb/bundle/prepare.mjs
  CONFIGS+=(--config rrweb/bundle/tauri.bundle.json)
fi
if [ -n "${BUNDLES:-}" ]; then
  npx tauri build --bundles "$BUNDLES" "${CONFIGS[@]}"
else
  npx tauri build --no-bundle "${CONFIGS[@]}"
fi
echo "OK → src-tauri/target/release/rapidraw-web-bridge, rrweb/dist-web/, rrweb/relay/"
