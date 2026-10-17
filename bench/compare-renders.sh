#!/usr/bin/env bash
# Export a folder with two RapidRAW builds (16-bit TIFF and JPEG) using the headless `export`
# command, check the files are byte-identical, and compare timings. Exits 1 on any difference.
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

# Median in milliseconds of the durations logged after "$2" in log file "$1".
median_ms() {
  grep -o -E "$2 [0-9.]+(ns|µs|ms|s)" "$1" | awk '{
      v = $NF
      if (v ~ /ns$/) { sub(/ns$/, "", v); v = v / 1e6 }
      else if (v ~ /µs$/) { sub(/µs$/, "", v); v = v / 1e3 }
      else if (v ~ /ms$/) { sub(/ms$/, "", v); v = v + 0 }
      else { sub(/s$/, "", v); v = v * 1e3 }
      print v
    }' | sort -n | awk '{ a[NR] = $1 } END { if (NR) printf "%.0f", a[int((NR + 1) / 2)]; else printf "-" }'
}

export_with() {
  local label=$1 bin=$2 format=$3
  shift 3
  local out="$work/$label-$format" log="$work/$label-$format.log"
  rm -rf "$out"
  local start end
  start=$(date +%s.%N)
  "$bin" export "$images" --output "$out" --format "$format" "$@" > "$log" 2>&1 || {
    echo "$label $format export failed, see $log" >&2
    return 1
  }
  end=$(date +%s.%N)
  printf '%-7s %-5s %8.2f s  %3s files   per image: raw enhance %6s ms, GPU %6s ms\n' \
    "$label" "$format" "$(awk -v a="$start" -v b="$end" 'BEGIN { print b - a }')" \
    "$(find "$out" -type f | wc -l)" "$(median_ms "$log" "' took")" "$(median_ms "$log" "on GPU in")"
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
