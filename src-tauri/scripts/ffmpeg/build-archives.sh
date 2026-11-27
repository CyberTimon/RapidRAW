#!/usr/bin/env bash
set -euo pipefail

FFMPEG_TAG="n9.0.2"
FFMPEG_COMMIT="946fcce07b6dcd0331c8cc609192aeff5e1924f8"
FFMPEG_REPO="https://github.com/FFmpeg/FFmpeg.git"
DAV1D_TAG="1.5.5"
OPUS_TAG="v1.6.1"
VPX_TAG="v1.17.0"
SVT_AV1_TAG="v4.3.1"
OPENH264_TAG="v2.6.0"
KVAZAAR_TAG="v2.3.2"
LIBVPL_TAG="v2.16.0"
ZLIB_TAG="v1.3.1"
AMF_TAG="v1.5.0"
NV_CODEC_TAG="n13.0.19.0"
MINGW_TAG="v13.0.0"
LIBVA_TAG="2.22.0"
MIN_MACOS="13.0"
LIBRARIES=("avutil:61" "swresample:7" "swscale:10" "avcodec:63" "avformat:63" "avfilter:12")
BTBN_REGISTRY="ghcr.io/ffmpeg-builds/ffmpeg-builds"
BTBN_TAG="${BTBN_TAG:-latest}"
BTBN_TARGETS=(
  "win64 ffmpeg-windows-x86_64 zip windows x86_64"
  "winarm64 ffmpeg-windows-aarch64 zip windows aarch64"
  "linux64 ffmpeg-linux-x86_64 tar.xz linux x86_64"
  "linuxarm64 ffmpeg-linux-aarch64 tar.xz linux aarch64"
)
LICENSES=(
  "libdav1d dav1d https://code.videolan.org/videolan/dav1d/-/raw/$DAV1D_TAG/COPYING"
  "libopus Opus https://raw.githubusercontent.com/xiph/opus/$OPUS_TAG/COPYING"
  "libvpx libvpx https://raw.githubusercontent.com/webmproject/libvpx/$VPX_TAG/LICENSE"
  "libvpx libvpx-patents https://raw.githubusercontent.com/webmproject/libvpx/$VPX_TAG/PATENTS"
  "libsvtav1 SVT-AV1 https://raw.githubusercontent.com/AOMediaCodec/SVT-AV1/$SVT_AV1_TAG/LICENSE.md"
  "libsvtav1 SVT-AV1-patents https://raw.githubusercontent.com/AOMediaCodec/SVT-AV1/$SVT_AV1_TAG/PATENTS.md"
  "libopenh264 OpenH264 https://raw.githubusercontent.com/cisco/openh264/$OPENH264_TAG/LICENSE"
  "libkvazaar Kvazaar https://raw.githubusercontent.com/ultravideo/kvazaar/$KVAZAAR_TAG/LICENSE"
  "libvpl libvpl https://raw.githubusercontent.com/intel/libvpl/$LIBVPL_TAG/LICENSE"
  "zlib zlib https://raw.githubusercontent.com/madler/zlib/$ZLIB_TAG/LICENSE"
  "amf AMF https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/AMF/$AMF_TAG/LICENSE.txt"
  "ffnvcodec nv-codec-headers https://raw.githubusercontent.com/FFmpeg/nv-codec-headers/$NV_CODEC_TAG/include/ffnvcodec/dynlink_loader.h"
  "vaapi libva https://raw.githubusercontent.com/intel/libva/$LIBVA_TAG/COPYING"
  "mingw winpthreads https://raw.githubusercontent.com/mingw-w64/mingw-w64/$MINGW_TAG/mingw-w64-libraries/winpthreads/COPYING"
)
HF_REPO="CyberTimon/RapidRAW-Models"
HF_FOLDER="ffmpeg-v${FFMPEG_TAG#n}-lean"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HOME/RapidRAW-FFmpeg"
UPLOAD="$OUT/$HF_FOLDER"

source "$SCRIPT_DIR/lean.sh"

step() {
  printf '\n==> %s\n' "$*"
}

sha256_of() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

fetch() {
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$2" "$1" "$3"
}

fetch_ffmpeg() {
  fetch "$FFMPEG_REPO" "$FFMPEG_TAG" "$1"
  if [ "$(git -C "$1" rev-parse HEAD)" != "$FFMPEG_COMMIT" ]; then
    echo "The FFmpeg tag $FFMPEG_TAG does not point to $FFMPEG_COMMIT." >&2
    exit 1
  fi
}

rust_entry() {
  printf '        ("%s", "%s") => Some((\n            "%s",\n            "%s",\n        )),\n' \
    "$1" "$2" "$3" "$(sha256_of "$UPLOAD/$3")"
}

finish() {
  local table="$1"
  shift
  step "Done"
  (cd "$UPLOAD" && ls -lh "$@")
  echo
  echo "SHA256:"
  for file in "$@"; do
    echo "$(sha256_of "$UPLOAD/$file")  $file"
  done
  echo
  echo "Upload them to the $HF_FOLDER folder of https://huggingface.co/$HF_REPO, for example with:"
  echo "  hf upload $HF_REPO \"$UPLOAD\" $HF_FOLDER"
  echo
  echo "In src-tauri/build.rs set:"
  echo "const FFMPEG_BASE_URL: &str ="
  echo "    \"https://huggingface.co/$HF_REPO/resolve/main/$HF_FOLDER/\";"
  echo "and use these ffmpeg_archive entries (also saved to $table):"
  cat "$table"
}

build_macos() (
  arch="$1"
  host_arch="$2"
  root="$WORK/$arch"
  src="$root/src"
  deps="$root/deps"
  prefix="$root/ffmpeg"
  package_name="ffmpeg-macos-$arch"
  package="$root/$package_name"
  target_flags="-arch $host_arch -mmacosx-version-min=$MIN_MACOS"
  cross=()
  if [ "$host_arch" != "arm64" ]; then
    cross=(--enable-cross-compile --target-os=darwin)
  fi
  mkdir -p "$src" "$deps" "$package/lib"

  export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
  export CFLAGS="$target_flags -O2"
  export CXXFLAGS="$CFLAGS"
  export LDFLAGS="$target_flags"
  export PKG_CONFIG_PATH="$deps/lib/pkgconfig"
  export PKG_CONFIG_LIBDIR="$deps/lib/pkgconfig"
  cmake_target=(
    -DCMAKE_OSX_ARCHITECTURES="$host_arch"
    -DCMAKE_APPLE_SILICON_PROCESSOR="$host_arch"
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS"
  )

  cat > "$root/meson-target.ini" << EOF
[binaries]
c = 'clang'
cpp = 'clang++'
ar = 'ar'
strip = 'strip'
nasm = 'nasm'
pkg-config = 'pkg-config'

[built-in options]
c_args = ['-arch', '$host_arch', '-mmacosx-version-min=$MIN_MACOS']
c_link_args = ['-arch', '$host_arch', '-mmacosx-version-min=$MIN_MACOS']

[host_machine]
system = 'darwin'
cpu_family = '$arch'
cpu = '$host_arch'
endian = 'little'
EOF

  fetch https://code.videolan.org/videolan/dav1d.git "$DAV1D_TAG" "$src/dav1d"
  fetch https://github.com/xiph/opus.git "$OPUS_TAG" "$src/opus"
  fetch https://chromium.googlesource.com/webm/libvpx "$VPX_TAG" "$src/libvpx"
  fetch https://github.com/AOMediaCodec/SVT-AV1.git "$SVT_AV1_TAG" "$src/svt-av1"
  fetch_ffmpeg "$src/ffmpeg"

  (
    cd "$src/dav1d"
    meson setup build --cross-file="$root/meson-target.ini" --prefix="$deps" --libdir=lib \
      --buildtype=release --default-library=static -Denable_tools=false -Denable_tests=false
    ninja -C build install
  )

  (
    cd "$src/opus"
    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$deps" \
      "${cmake_target[@]}" -DBUILD_SHARED_LIBS=OFF -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
    cmake --build build --target install
  )

  (
    cd "$src/libvpx"
    ./configure --prefix="$deps" --target="$host_arch-darwin22-gcc" --enable-static --disable-shared \
      --enable-pic --enable-vp9-highbitdepth --disable-examples --disable-tools --disable-docs \
      --disable-unit-tests --extra-cflags="$target_flags" --extra-cxxflags="$target_flags"
    make -j"$JOBS" install
  )

  (
    cd "$src/svt-av1"
    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$deps" \
      -DCMAKE_INSTALL_LIBDIR=lib "${cmake_target[@]}" -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_APPS=OFF -DBUILD_TESTING=OFF -DSVT_AV1_LTO=OFF
    cmake --build build --target install
  )

  (
    cd "$src/ffmpeg"
    lean_configure macos zlib libdav1d libopus libvpx libsvtav1
    if ! ./configure \
      --prefix="$prefix" \
      --arch="$arch" \
      ${cross[@]+"${cross[@]}"} \
      --install-name-dir='@rpath' \
      "${LEAN_FLAGS[@]}" \
      --pkg-config-flags=--static \
      --extra-cflags="$target_flags -I$deps/include" \
      --extra-ldflags="$target_flags -L$deps/lib" > configure.log 2>&1; then
      cat configure.log
      tail -n 40 ffbuild/config.log
      exit 1
    fi
    lean_verify . configure.log
    make -j"$JOBS"
    make install
  )

  checks=()
  for entry in "${LIBRARIES[@]}"; do
    name="${entry%%:*}"
    major="${entry##*:}"
    file="lib$name.$major.dylib"
    if [ ! -e "$prefix/lib/$file" ]; then
      echo "Expected $file, the FFmpeg major versions changed. Update LIBRARIES in this script and in src-tauri/src/video/libav/mod.rs." >&2
      exit 1
    fi
    cp -L "$prefix/lib/$file" "$package/lib/$file"
    chmod u+w "$package/lib/$file"
    install_name_tool -id "@rpath/$file" "$package/lib/$file"
    install_name_tool -add_rpath "@loader_path" "$package/lib/$file"
    checks+=("$package/lib/$file" "${name}_version" "$major")
  done

  for dylib in "$package"/lib/*.dylib; do
    archs="$(lipo -archs "$dylib")"
    if [ "$archs" != "$host_arch" ]; then
      echo "$(basename "$dylib") was built for $archs instead of $host_arch." >&2
      exit 1
    fi
    foreign="$(otool -L "$dylib" | tail -n +2 | awk '{print $1}' | grep -vE '^(@rpath/|/usr/lib/|/System/Library/)' || true)"
    if [ -n "$foreign" ]; then
      echo "$(basename "$dylib") links to libraries outside the bundle:" >&2
      echo "$foreign" >&2
      exit 1
    fi
    codesign --force --sign - "$dylib"
  done

  clang -arch "$host_arch" -mmacosx-version-min="$MIN_MACOS" "$WORK/load-check.c" -o "$root/load-check"
  if [ "$host_arch" = "arm64" ] || arch -x86_64 /usr/bin/true 2> /dev/null; then
    "$root/load-check" "${checks[@]}"
  else
    echo "Rosetta is not installed, so the x86_64 libraries were not test-loaded."
  fi

  {
    echo "FFmpeg $FFMPEG_TAG, lean LGPL build for macOS $arch (minimum macOS $MIN_MACOS)."
    echo "Built with dav1d $DAV1D_TAG, Opus $OPUS_TAG, libvpx $VPX_TAG and SVT-AV1 $SVT_AV1_TAG, linked statically."
    echo
    for license in \
      "FFmpeg:$src/ffmpeg/COPYING.LGPLv2.1" \
      "dav1d:$src/dav1d/COPYING" \
      "Opus:$src/opus/COPYING" \
      "libvpx:$src/libvpx/LICENSE" \
      "libvpx patents:$src/libvpx/PATENTS" \
      "SVT-AV1:$src/svt-av1/LICENSE.md" \
      "SVT-AV1 patents:$src/svt-av1/PATENTS.md"; do
      echo "===== ${license%%:*} ====="
      cat "${license#*:}"
      echo
    done
  } > "$package/LICENSE.txt"

  COPYFILE_DISABLE=1 tar -czf "$UPLOAD/$package_name.tar.gz" --no-xattrs -C "$root" "$package_name"
)

build_all_macos() {
  echo "Builds the lean FFmpeg libraries for macOS arm64 and x86_64 from source."
  echo "Needs an Apple Silicon Mac with the Xcode command line tools, Homebrew meson ninja nasm cmake pkg-config,"
  echo "about 5 GB of free disk space and takes about 15 minutes."
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "Run this on an Apple Silicon Mac." >&2
    exit 1
  fi
  if ! xcrun --sdk macosx --show-sdk-path > /dev/null 2>&1; then
    echo "The Xcode command line tools are missing. Install them with: xcode-select --install" >&2
    exit 1
  fi
  local missing="" tool
  for tool in meson ninja nasm cmake pkg-config git; do
    command -v "$tool" > /dev/null || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    echo "Build tools are missing. Install them with: brew install$missing" >&2
    exit 1
  fi

  WORK="$OUT/build-macos"
  JOBS="$(sysctl -n hw.ncpu)"
  unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH
  rm -rf "$WORK"
  mkdir -p "$UPLOAD" "$WORK"

  cat > "$WORK/load-check.c" << 'EOF'
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  for (int i = 1; i + 2 < argc; i += 3) {
    void *library = dlopen(argv[i], RTLD_NOW | RTLD_GLOBAL);
    if (!library) {
      fprintf(stderr, "%s\n", dlerror());
      return 1;
    }
    unsigned (*version)(void) = (unsigned (*)(void))dlsym(library, argv[i + 1]);
    if (!version || version() >> 16 != (unsigned)atoi(argv[i + 2])) {
      fprintf(stderr, "%s does not report major version %s\n", argv[i], argv[i + 2]);
      return 1;
    }
  }
  return 0;
}
EOF

  step "Building FFmpeg for macOS arm64"
  build_macos aarch64 arm64
  step "Building FFmpeg for macOS x86_64"
  build_macos x86_64 x86_64
  rm -rf "$WORK"

  local table="$OUT/build-rs-macos.txt"
  {
    rust_entry macos aarch64 ffmpeg-macos-aarch64.tar.gz
    rust_entry macos x86_64 ffmpeg-macos-x86_64.tar.gz
  } > "$table"
  finish "$table" ffmpeg-macos-aarch64.tar.gz ffmpeg-macos-x86_64.tar.gz
}

origin_rpath() {
  local archive="$1" name="$2" unpack="$WORK/rpath" library
  rm -rf "$unpack"
  mkdir -p "$unpack"
  tar -xf "$archive" -C "$unpack"
  for library in "$unpack/$name"/lib/*.so.*; do
    patchelf --set-rpath '$ORIGIN' "$library"
  done
  (cd "$unpack" && tar --sort=name --owner=0 --group=0 -I "xz -9 -T1" -cf "$archive" "$name")
  rm -rf "$unpack"
}

build_all_windows_linux() {
  echo "Builds the lean FFmpeg libraries for Windows x86_64/arm64 and Linux x86_64/arm64 inside the"
  echo "FFmpeg-Builds images ($BTBN_REGISTRY/<target>-lgpl-shared-9.0:$BTBN_TAG), which bring the cross"
  echo "toolchains and prebuilt dav1d, Opus, libvpx, SVT-AV1, OpenH264, Kvazaar, libvpl, AMF, NVENC and VA-API."
  echo "Needs an x86_64 machine with Docker (usable without sudo), git, curl and patchelf, about 15 GB of free space for"
  echo "Docker and the build (each image is about 2 GB to download and is removed again after its target),"
  echo "and takes 30 to 60 minutes, mostly downloading. On WSL the Docker data lives inside the WSL disk on C:."
  local missing="" tool
  for tool in docker git curl patchelf; do
    command -v "$tool" > /dev/null || missing="$missing $tool"
  done
  if [ -n "$missing" ]; then
    echo "Missing tools:$missing. On Ubuntu/WSL: sudo apt install docker.io git curl patchelf" >&2
    exit 1
  fi
  if ! docker info > /dev/null 2>&1; then
    echo "Docker is not usable. Start it (sudo service docker start, or sudo systemctl start docker) and allow your" >&2
    echo "user to run it (sudo usermod -aG docker \$USER, then open a new shell)." >&2
    exit 1
  fi
  if [ "$(uname -m)" != "x86_64" ]; then
    echo "The FFmpeg-Builds images are x86_64 only, run this on an x86_64 machine." >&2
    exit 1
  fi

  local uid_args=(-u "$(id -u):$(id -g)")
  if docker info -f "{{println .SecurityOptions}}" 2> /dev/null | grep -q rootless; then
    uid_args=()
  fi

  WORK="$OUT/build-windows-linux"
  rm -rf "$WORK"
  mkdir -p "$UPLOAD" "$WORK/scripts" "$WORK/src" "$WORK/licenses"
  cp "$SCRIPT_DIR/lean.sh" "$SCRIPT_DIR/btbn-build.sh" "$WORK/scripts/"

  step "Downloading the license texts of the bundled libraries"
  local entry library title url
  for entry in "${LICENSES[@]}"; do
    read -r library title url <<< "$entry"
    mkdir -p "$WORK/licenses/$library"
    curl -fsSL --retry 3 -o "$WORK/licenses/$library/$title" "$url"
  done
  sed -i -n '1,/\*\//p' "$WORK/licenses/ffnvcodec/nv-codec-headers"

  step "Downloading FFmpeg $FFMPEG_TAG"
  fetch_ffmpeg "$WORK/src/ffmpeg"

  local table="$OUT/build-rs-windows-linux.txt" files=() target name format os arch image digest started
  : > "$table"
  for entry in "${BTBN_TARGETS[@]}"; do
    read -r target name format os arch <<< "$entry"
    image="$BTBN_REGISTRY/$target-lgpl-shared-9.0:$BTBN_TAG"
    started="$(date +%s)"
    step "Building $name in $image"
    docker pull --platform linux/amd64 "$image"
    digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
    docker run --rm --platform linux/amd64 ${uid_args[@]+"${uid_args[@]}"} \
      -e HOME=/ffbuild \
      -e FFMPEG_TAG="$FFMPEG_TAG" \
      -e RAPIDRAW_LIBRARIES="${LIBRARIES[*]}" \
      -e IMAGE_DIGEST="$digest" \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -v "$WORK":/ffbuild \
      "$image" bash /ffbuild/scripts/btbn-build.sh "$name"
    cp "$WORK/out/$name.$format" "$UPLOAD/$name.$format"
    if [ "$os" = linux ]; then
      origin_rpath "$UPLOAD/$name.$format" "$name"
    fi
    rm -rf "${WORK:?}/$name"
    if [ -z "${KEEP_IMAGES:-}" ]; then
      docker image rm "$image" > /dev/null
    fi
    rust_entry "$os" "$arch" "$name.$format" >> "$table"
    files+=("$name.$format")
    echo "$name took $(($(date +%s) - started)) s."
  done
  rm -rf "$WORK"
  finish "$table" "${files[@]}"
}

case "${1:-}" in
  macos) build_all_macos ;;
  windows-linux) build_all_windows_linux ;;
  *)
    echo "Usage: src-tauri/scripts/ffmpeg/build-archives.sh macos|windows-linux" >&2
    echo "  macos          builds ffmpeg-macos-{aarch64,x86_64}.tar.gz on an Apple Silicon Mac" >&2
    echo "  windows-linux  builds ffmpeg-windows-{x86_64,aarch64}.zip and ffmpeg-linux-{x86_64,aarch64}.tar.xz with Docker" >&2
    echo "The archives go to $UPLOAD." >&2
    exit 1
    ;;
esac
