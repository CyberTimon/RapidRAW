#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

backend_cmds="$TMP_DIR/backend_cmds.txt"
front_enum_cmds="$TMP_DIR/front_enum_cmds.txt"
front_literal_cmds="$TMP_DIR/front_literal_cmds.txt"
front_event_methods="$TMP_DIR/front_event_methods.txt"
backend_events="$TMP_DIR/backend_events.txt"
front_events="$TMP_DIR/front_events.txt"

rg -n "#\\[tauri::command\\]" src-tauri/src -A2 --no-heading \
  | rg -o "fn [a-zA-Z0-9_]+" \
  | awk '{print $2}' \
  | sort -u > "$backend_cmds"

if rg -q "export enum Invokes" src/components/ui/AppProperties.tsx; then
  sed -n '/export enum Invokes {/,/^}/p' src/components/ui/AppProperties.tsx \
    | rg -o "'[^']+'" \
    | tr -d "'" \
    | sort -u > "$front_enum_cmds"
else
  : > "$front_enum_cmds"
fi

if rg -q "invoke\\(\\s*['\"][^'\"]+['\"]" src --glob '!src-tauri/**'; then
  rg -n "invoke\\(\\s*['\"][^'\"]+['\"]" src --glob '!src-tauri/**' -o \
    | sed -E "s/.*invoke\\(\\s*['\"]([^'\"]+)['\"].*/\\1/" \
    | sort -u > "$front_literal_cmds"
else
  : > "$front_literal_cmds"
fi

if [[ -f src/bindings.ts ]]; then
  sed -n '/}>({/,/^})/p' src/bindings.ts \
    | sed -nE 's/^[[:space:]]*[A-Za-z0-9_]+:[[:space:]]*"([^"]+)".*/\1/p' \
    | sort -u > "$backend_events"
else
  rg --files src-tauri/src \
    | xargs perl -0777 -ne 'while (/\.emit(?:_to|_filter)?\(\s*"([^"]+)"/g) { print "$1\n"; }' \
    | sort -u > "$backend_events"
fi

rg --files src --glob '!src-tauri/**' \
  | xargs perl -ne 'while (/(?:listen|once)\(\s*["\x27]([^"\x27]+)["\x27]/g) { print "$1\n"; } while (/events\.([A-Za-z0-9_]+)\.(?:listen|once)\s*\(/g) { print "__method__:$1\n"; }' \
  | sort -u > "$front_event_methods"

grep -v '^__method__:' "$front_event_methods" > "$front_events" || true

grep '^__method__:' "$front_event_methods" | sed 's/^__method__://' | while read -r method; do
  mapped="$(sed -nE "s/^[[:space:]]*${method}:[[:space:]]*\"([^\"]+)\".*/\\1/p" src/bindings.ts | head -n1)"
  if [[ -n "$mapped" ]]; then
    echo "$mapped" >> "$front_events"
  fi
done

sort -u "$front_events" -o "$front_events"

if [[ -s "$front_enum_cmds" ]]; then
  echo "=== Commands in frontend enum but missing in backend ==="
  comm -23 "$front_enum_cmds" "$backend_cmds" || true
  echo

  echo "=== Commands in backend but missing in frontend enum ==="
  comm -13 "$front_enum_cmds" "$backend_cmds" || true
  echo
else
  echo "=== Frontend enum command check skipped (Invokes enum removed) ==="
  echo
fi

echo "=== Literal invoke commands (not enum) ==="
cat "$front_literal_cmds"
echo

echo "=== Events listened in frontend but not emitted by backend ==="
comm -23 "$front_events" "$backend_events" || true
echo

echo "=== Events emitted by backend but not listened in frontend ==="
comm -13 "$front_events" "$backend_events" || true
echo

echo "IPC contract check complete."
