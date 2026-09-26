#!/usr/bin/env bash
# Export a folder with two RapidRAW builds (16-bit TIFF and JPEG) and check the files are
# byte-identical. Exits 1 on any difference.
#
# Usage: bench/compare-renders.sh <before-binary> <after-binary> <image-folder> [work-dir]
set -euo pipefail
export LC_ALL=C

if [ $# -lt 3 ]; then
  echo "Usage: $0 <before-binary> <after-binary> <image-folder> [work-dir]" >&2
  exit 2
fi

before_bin=$1
after_bin=$2
images=$3
work=${4:-$(mktemp -d)}
mkdir -p "$work"

export_with() {
  local label=$1 bin=$2 format=$3
  shift 3
  local out="$work/$label-$format"
  rm -rf "$out"
  local start end
  start=$(date +%s.%N)
  "$bin" export "$images" --output "$out" --format "$format" "$@" > "$work/$label-$format.log" 2>&1 || {
    echo "$label $format export failed, see $work/$label-$format.log" >&2
    return 1
  }
  end=$(date +%s.%N)
  printf '%-7s %-5s %8.2f s  %s files\n' "$label" "$format" "$(awk -v a="$start" -v b="$end" 'BEGIN { print b - a }')" "$(find "$out" -type f | wc -l)"
  (cd "$out" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$work/$label-$format.sha256"
  rm -rf "$out"
}

status=0
for spec in "tiff --tiff-bit-depth 16" "jpeg --quality 95"; do
  read -r format extra <<< "$spec"
  # shellcheck disable=SC2086
  export_with before "$before_bin" "$format" $extra
  # shellcheck disable=SC2086
  export_with after "$after_bin" "$format" $extra
  if diff -u "$work/before-$format.sha256" "$work/after-$format.sha256" > "$work/$format.diff"; then
    echo "  $format: all $(wc -l < "$work/after-$format.sha256") outputs byte-identical"
  else
    echo "  $format: OUTPUTS DIFFER, see $work/$format.diff"
    status=1
  fi
done

echo "Checksums and logs: $work"
exit $status
