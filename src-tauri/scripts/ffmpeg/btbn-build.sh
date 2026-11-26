#!/usr/bin/env bash
set -euo pipefail

name="$1"
source /ffbuild/scripts/lean.sh

src=/ffbuild/src/ffmpeg
root="/ffbuild/$name"
build="$root/build"
prefix="$root/prefix"
package="$root/$name"
rm -rf "$root"
mkdir -p "$build" "$package"

wanted="zlib libdav1d libopus libvpx libsvtav1 libopenh264 libkvazaar ffnvcodec amf libvpl"
case "$TARGET" in
  win64 | winarm64)
    os=windows
    platform=(--disable-w32threads --enable-pthreads)
    ;;
  linux64 | linuxarm64)
    os=linux
    platform=()
    wanted="$wanted vaapi libdrm"
    ;;
  *)
    echo "Unsupported FFmpeg-Builds target $TARGET." >&2
    exit 1
    ;;
esac

libraries=""
for library in $wanted; do
  if [[ " $FF_CONFIGURE " == *" --enable-$library "* ]]; then
    libraries="$libraries $library"
  elif [[ $TARGET == *arm64 ]]; then
    echo "The $TARGET image has no $library, so this build leaves it out."
  else
    echo "The $TARGET image has no $library." >&2
    exit 1
  fi
done
lean_configure "$os" $libraries

cd "$build"
if ! "$src/configure" --prefix="$prefix" --pkg-config-flags=--static $FFBUILD_TARGET_FLAGS \
  "${LEAN_FLAGS[@]}" "${platform[@]}" --extra-ldflags="$FF_LDFLAGS" \
  --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --nm="$NM" > configure.log 2>&1; then
  cat configure.log
  tail -n 40 ffbuild/config.log
  exit 1
fi
grep -i "warning" configure.log || true
lean_verify "$build" configure.log
make -j"$(nproc)"
make install

if [ "$os" = windows ]; then
  mkdir -p "$package/bin"
else
  mkdir -p "$package/lib"
fi
for entry in $RAPIDRAW_LIBRARIES; do
  library="${entry%%:*}"
  major="${entry##*:}"
  if [ "$os" = windows ]; then
    file="bin/$library-$major.dll"
  else
    file="lib/lib$library.so.$major"
  fi
  if [ ! -e "$prefix/$file" ]; then
    echo "Expected $file, the FFmpeg major versions changed. Update LIBRARIES in build-archives.sh and in src-tauri/src/video/libav/mod.rs." >&2
    exit 1
  fi
  cp -L "$prefix/$file" "$package/$file"
  if [ "$os" = windows ]; then
    foreign="$("${FFBUILD_CROSS_PREFIX}objdump" -p "$package/$file" | sed -n 's/^[[:space:]]*DLL Name: //p' | grep -iE '^(lib|zlib)' || true)"
  else
    foreign="$("${FFBUILD_CROSS_PREFIX}readelf" -d "$package/$file" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' |
      grep -vE '^(lib(avutil|swresample|swscale|avcodec|avformat|avfilter)\.so\.[0-9]+|libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|ld-linux.*)$' || true)"
    glibc="$("${FFBUILD_CROSS_PREFIX}objdump" -T "$package/$file" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -n 1)"
    if [ "$(printf '%s\n2.35\n' "$glibc" | sort -V | tail -n 1)" != 2.35 ]; then
      echo "$file needs glibc $glibc, newer than the 2.35 of Ubuntu 22.04." >&2
      exit 1
    fi
  fi
  if [ -n "$foreign" ]; then
    echo "$file links to libraries outside the bundle:" >&2
    echo "$foreign" >&2
    exit 1
  fi
done

notices=""
for library in $libraries mingw; do
  if [ -d "/ffbuild/licenses/$library" ] && { [ "$library" != mingw ] || [ "$os" = windows ]; }; then
    notices="$notices /ffbuild/licenses/$library"
  fi
done
{
  echo "FFmpeg $FFMPEG_TAG, lean LGPL build for ${os^} ${name##*-}."
  echo "Built with the FFmpeg-Builds image $IMAGE_DIGEST."
  echo "External libraries:$libraries."
  echo
  echo "===== FFmpeg ====="
  cat "$src/COPYING.LGPLv2.1"
  echo
  for directory in $notices; do
    for license in "$directory"/*; do
      echo "===== $(basename "$license") ====="
      cat "$license"
      echo
    done
  done
} > "$package/LICENSE.txt"

mkdir -p /ffbuild/out
cd "$root"
if [ "$os" = windows ]; then
  rm -f "/ffbuild/out/$name.zip"
  zip -9 -r -X -q "/ffbuild/out/$name.zip" "$name"
else
  tar --sort=name --owner=0 --group=0 -I "xz -9 -T1" -cf "/ffbuild/out/$name.tar.xz" "$name"
fi
