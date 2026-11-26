#!/usr/bin/env bash

LEAN_DEMUXERS="aac ac3 amr asf avi dts dv eac3 flac h264 hevc loas m4v matroska mov mp3 mpegps mpegts mpegvideo mxf ogg truehd wav"

LEAN_MUXERS="matroska mov mp4 webm"

LEAN_PARSERS="aac aac_latm ac3 amr apv av1 dca dnxhd dvaudio flac gsm h263 h264 hevc jpeg2000 mjpeg mlp mpeg4video
  mpegaudio mpegvideo opus png prores prores_raw vc1 vorbis vp8 vp9"

LEAN_VIDEO_DECODERS="aic apv av1 cfhd dnxhd dvvideo ffv1 ffvhuff h263 h263i h263p h264 hevc huffyuv jpeg2000 magicyuv
  mjpeg mjpegb mpeg1video mpeg2video mpeg4 msmpeg4v1 msmpeg4v2 msmpeg4v3 png prores prores_raw qtrle r10k r210 rawvideo
  utvideo v210 v210x vc1 vp8 vp9 wmv1 wmv2 wmv3 yuv4"

LEAN_AUDIO_DECODERS="aac aac_latm ac3 adpcm_g726 adpcm_ima_qt adpcm_ima_wav adpcm_ms alac amrnb amrwb dca dvaudio eac3
  flac gsm gsm_ms mlp mp1 mp1float mp2 mp2float mp3 mp3float opus pcm_alaw pcm_bluray pcm_dvd pcm_f32be pcm_f32le
  pcm_f64be pcm_f64le pcm_mulaw pcm_s16be pcm_s16le pcm_s16le_planar pcm_s24be pcm_s24le pcm_s24le_planar pcm_s32be
  pcm_s32le pcm_s32le_planar pcm_s8 pcm_s8_planar pcm_u16be pcm_u16le pcm_u24be pcm_u24le pcm_u32be pcm_u32le pcm_u8
  qdm2 qdmc s302m speex truehd vorbis wmalossless wmapro wmav1 wmav2 wmavoice"

LEAN_ENCODERS="aac pcm_s16le prores_ks"

LEAN_FILTERS="acompressor adelay aeval afftdn aformat alimiter amix apad aresample asetpts atempo atrim bass equalizer
  format fps hflip highpass hwdownload hwupload lowpass null pan scale setparams setpts transpose treble vflip volume"

LEAN_BSFS="extract_extradata"

LEAN_PROTOCOLS="file"

LEAN_BASE_FLAGS="--enable-shared --disable-static --enable-pic --disable-programs --disable-doc --disable-debug
  --disable-avdevice --disable-network --disable-autodetect --disable-everything"

lean_upper() {
  echo "$1" | tr 'a-z-' 'A-Z_'
}

lean_hwaccels() {
  local api="$1" codec
  for codec in $2; do
    echo "${codec}_$api"
  done
}

lean_components() {
  local kind="$1" names="$2" name list=""
  for name in $names; do
    list="$list${list:+,}$name"
    LEAN_EXPECTED="$LEAN_EXPECTED CONFIG_$(lean_upper "$name")_$(lean_upper "$kind")"
  done
  if [ -n "$list" ]; then
    LEAN_FLAGS+=("--enable-$kind=$list")
  fi
}

lean_configure() {
  local os="$1"
  shift
  local libraries="$*" hardware="" item
  local decoders="$LEAN_VIDEO_DECODERS $LEAN_AUDIO_DECODERS" encoders="$LEAN_ENCODERS" filters="$LEAN_FILTERS"
  local hwaccels=""
  case "$os" in
    windows)
      hardware="d3d11va dxva2 mediafoundation"
      encoders="$encoders h264_mf hevc_mf"
      hwaccels="$(lean_hwaccels d3d11va "av1 h264 hevc mpeg2 vc1 vp9 wmv3")
        $(lean_hwaccels d3d11va2 "av1 h264 hevc mpeg2 vc1 vp9 wmv3")
        $(lean_hwaccels dxva2 "av1 h264 hevc mpeg2 vc1 vp9 wmv3")"
      ;;
    linux) ;;
    macos)
      hardware="videotoolbox audiotoolbox"
      encoders="$encoders aac_at h264_videotoolbox hevc_videotoolbox prores_videotoolbox"
      filters="$filters scale_vt"
      hwaccels="$(lean_hwaccels videotoolbox "av1 h263 h264 hevc mpeg1 mpeg2 mpeg4 prores prores_raw vp9")"
      ;;
    *)
      echo "Unknown FFmpeg target system $os." >&2
      return 1
      ;;
  esac
  for item in $libraries; do
    case "$item" in
      zlib | libdrm) ;;
      libdav1d) decoders="$decoders libdav1d" ;;
      libopus) encoders="$encoders libopus" ;;
      libvpx) encoders="$encoders libvpx_vp9" ;;
      libsvtav1) encoders="$encoders libsvtav1" ;;
      libopenh264) encoders="$encoders libopenh264" ;;
      libkvazaar) encoders="$encoders libkvazaar" ;;
      ffnvcodec)
        hardware="$hardware cuda cuda-llvm nvdec nvenc"
        encoders="$encoders av1_nvenc h264_nvenc hevc_nvenc"
        filters="$filters scale_cuda"
        hwaccels="$hwaccels $(lean_hwaccels nvdec "av1 h264 hevc mjpeg mpeg1 mpeg2 mpeg4 vc1 vp8 vp9 wmv3")"
        ;;
      amf) encoders="$encoders av1_amf h264_amf hevc_amf" ;;
      libvpl) encoders="$encoders av1_qsv h264_qsv hevc_qsv" ;;
      vaapi)
        encoders="$encoders av1_vaapi h264_vaapi hevc_vaapi"
        filters="$filters scale_vaapi"
        hwaccels="$hwaccels $(lean_hwaccels vaapi "av1 h263 h264 hevc mjpeg mpeg2 mpeg4 vc1 vp8 vp9 wmv3")"
        ;;
      *)
        echo "Unknown FFmpeg library $item." >&2
        return 1
        ;;
    esac
  done

  LEAN_FLAGS=()
  LEAN_EXPECTED=""
  for item in $LEAN_BASE_FLAGS; do
    LEAN_FLAGS+=("$item")
  done
  for item in $hardware $libraries; do
    LEAN_FLAGS+=("--enable-$item")
    LEAN_EXPECTED="$LEAN_EXPECTED CONFIG_$(lean_upper "$item")"
  done
  lean_components decoder "$decoders"
  lean_components encoder "$encoders"
  lean_components hwaccel "$hwaccels"
  lean_components demuxer "$LEAN_DEMUXERS"
  lean_components muxer "$LEAN_MUXERS"
  lean_components parser "$LEAN_PARSERS"
  lean_components bsf "$LEAN_BSFS"
  lean_components protocol "$LEAN_PROTOCOLS"
  lean_components filter "$filters"
}

lean_verify() {
  local build="$1" log="$2" macro missing=""
  if grep -q "did not match anything" "$log"; then
    grep "did not match anything" "$log" >&2
    echo "FFmpeg does not know some of the components above. Fix the names in src-tauri/scripts/ffmpeg/lean.sh." >&2
    return 1
  fi
  if grep -qE '^CONFIG_(GPL|NONFREE|VERSION3)=yes' "$build/ffbuild/config.mak"; then
    echo "The FFmpeg build is not LGPL 2.1." >&2
    return 1
  fi
  for macro in $LEAN_EXPECTED; do
    grep -qx "#define $macro 1" "$build/config.h" "$build/config_components.h" || missing="$missing $macro"
  done
  if [ -n "$missing" ]; then
    echo "FFmpeg configure turned off components RapidRAW needs, usually because a library or SDK is missing:" >&2
    echo "$missing" | tr ' ' '\n' | sed '/^$/d; s/^/  /' >&2
    return 1
  fi
}
