#[repr(C)]
#[derive(Copy, Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct __BindgenBitfieldUnit<Storage> {
    storage: Storage,
}
impl<Storage> __BindgenBitfieldUnit<Storage> {
    #[inline]
    pub const fn new(storage: Storage) -> Self {
        Self { storage }
    }
}
impl<Storage> __BindgenBitfieldUnit<Storage>
where
    Storage: AsRef<[u8]> + AsMut<[u8]>,
{
    #[inline]
    fn extract_bit(byte: u8, index: usize) -> bool {
        let bit_index = if cfg!(target_endian = "big") {
            7 - (index % 8)
        } else {
            index % 8
        };
        let mask = 1 << bit_index;
        byte & mask == mask
    }
    #[inline]
    pub fn get_bit(&self, index: usize) -> bool {
        debug_assert!(index / 8 < self.storage.as_ref().len());
        let byte_index = index / 8;
        let byte = self.storage.as_ref()[byte_index];
        Self::extract_bit(byte, index)
    }
    #[inline]
    pub unsafe fn raw_get_bit(this: *const Self, index: usize) -> bool {
        debug_assert!(index / 8 < core::mem::size_of::<Storage>());
        let byte_index = index / 8;
        let byte = unsafe {
            *(core::ptr::addr_of!((*this).storage) as *const u8).offset(byte_index as isize)
        };
        Self::extract_bit(byte, index)
    }
    #[inline]
    fn change_bit(byte: u8, index: usize, val: bool) -> u8 {
        let bit_index = if cfg!(target_endian = "big") {
            7 - (index % 8)
        } else {
            index % 8
        };
        let mask = 1 << bit_index;
        if val { byte | mask } else { byte & !mask }
    }
    #[inline]
    pub fn set_bit(&mut self, index: usize, val: bool) {
        debug_assert!(index / 8 < self.storage.as_ref().len());
        let byte_index = index / 8;
        let byte = &mut self.storage.as_mut()[byte_index];
        *byte = Self::change_bit(*byte, index, val);
    }
    #[inline]
    pub unsafe fn raw_set_bit(this: *mut Self, index: usize, val: bool) {
        debug_assert!(index / 8 < core::mem::size_of::<Storage>());
        let byte_index = index / 8;
        let byte = unsafe {
            (core::ptr::addr_of_mut!((*this).storage) as *mut u8).offset(byte_index as isize)
        };
        unsafe { *byte = Self::change_bit(*byte, index, val) };
    }
    #[inline]
    pub fn get(&self, bit_offset: usize, bit_width: u8) -> u64 {
        debug_assert!(bit_width <= 64);
        debug_assert!(bit_offset / 8 < self.storage.as_ref().len());
        debug_assert!((bit_offset + (bit_width as usize)) / 8 <= self.storage.as_ref().len());
        let mut val = 0;
        for i in 0..(bit_width as usize) {
            if self.get_bit(i + bit_offset) {
                let index = if cfg!(target_endian = "big") {
                    bit_width as usize - 1 - i
                } else {
                    i
                };
                val |= 1 << index;
            }
        }
        val
    }
    #[inline]
    pub unsafe fn raw_get(this: *const Self, bit_offset: usize, bit_width: u8) -> u64 {
        debug_assert!(bit_width <= 64);
        debug_assert!(bit_offset / 8 < core::mem::size_of::<Storage>());
        debug_assert!((bit_offset + (bit_width as usize)) / 8 <= core::mem::size_of::<Storage>());
        let mut val = 0;
        for i in 0..(bit_width as usize) {
            if unsafe { Self::raw_get_bit(this, i + bit_offset) } {
                let index = if cfg!(target_endian = "big") {
                    bit_width as usize - 1 - i
                } else {
                    i
                };
                val |= 1 << index;
            }
        }
        val
    }
    #[inline]
    pub fn set(&mut self, bit_offset: usize, bit_width: u8, val: u64) {
        debug_assert!(bit_width <= 64);
        debug_assert!(bit_offset / 8 < self.storage.as_ref().len());
        debug_assert!((bit_offset + (bit_width as usize)) / 8 <= self.storage.as_ref().len());
        for i in 0..(bit_width as usize) {
            let mask = 1 << i;
            let val_bit_is_set = val & mask == mask;
            let index = if cfg!(target_endian = "big") {
                bit_width as usize - 1 - i
            } else {
                i
            };
            self.set_bit(index + bit_offset, val_bit_is_set);
        }
    }
    #[inline]
    pub unsafe fn raw_set(this: *mut Self, bit_offset: usize, bit_width: u8, val: u64) {
        debug_assert!(bit_width <= 64);
        debug_assert!(bit_offset / 8 < core::mem::size_of::<Storage>());
        debug_assert!((bit_offset + (bit_width as usize)) / 8 <= core::mem::size_of::<Storage>());
        for i in 0..(bit_width as usize) {
            let mask = 1 << i;
            let val_bit_is_set = val & mask == mask;
            let index = if cfg!(target_endian = "big") {
                bit_width as usize - 1 - i
            } else {
                i
            };
            unsafe { Self::raw_set_bit(this, index + bit_offset, val_bit_is_set) };
        }
    }
}
pub const AVERROR_EXPERIMENTAL: i32 = -733130664;
pub const AVERROR_INPUT_CHANGED: i32 = -1668179713;
pub const AVERROR_OUTPUT_CHANGED: i32 = -1668179714;
pub const AV_BUFFER_FLAG_READONLY: u32 = 1;
pub const AV_FRAME_FLAG_CORRUPT: u32 = 1;
pub const AV_FRAME_FLAG_KEY: u32 = 2;
pub const AV_FRAME_FLAG_DISCARD: u32 = 4;
pub const AV_FRAME_FLAG_INTERLACED: u32 = 8;
pub const AV_FRAME_FLAG_TOP_FIELD_FIRST: u32 = 16;
pub const AV_FRAME_FLAG_LOSSLESS: u32 = 32;
pub const AV_FRAME_SIDE_DATA_FLAG_UNIQUE: u32 = 1;
pub const AV_FRAME_SIDE_DATA_FLAG_REPLACE: u32 = 2;
pub const AV_FRAME_SIDE_DATA_FLAG_NEW_REF: u32 = 4;
pub const AV_PKT_FLAG_KEY: u32 = 1;
pub const AV_PKT_FLAG_CORRUPT: u32 = 2;
pub const AV_PKT_FLAG_DISCARD: u32 = 4;
pub const AV_PKT_FLAG_TRUSTED: u32 = 8;
pub const AV_PKT_FLAG_DISPOSABLE: u32 = 16;
pub const AV_CODEC_FLAG_UNALIGNED: u32 = 1;
pub const AV_CODEC_FLAG_QSCALE: u32 = 2;
pub const AV_CODEC_FLAG_4MV: u32 = 4;
pub const AV_CODEC_FLAG_OUTPUT_CORRUPT: u32 = 8;
pub const AV_CODEC_FLAG_QPEL: u32 = 16;
pub const AV_CODEC_FLAG_RECON_FRAME: u32 = 64;
pub const AV_CODEC_FLAG_COPY_OPAQUE: u32 = 128;
pub const AV_CODEC_FLAG_FRAME_DURATION: u32 = 256;
pub const AV_CODEC_FLAG_PASS1: u32 = 512;
pub const AV_CODEC_FLAG_PASS2: u32 = 1024;
pub const AV_CODEC_FLAG_LOOP_FILTER: u32 = 2048;
pub const AV_CODEC_FLAG_GRAY: u32 = 8192;
pub const AV_CODEC_FLAG_PSNR: u32 = 32768;
pub const AV_CODEC_FLAG_INTERLACED_DCT: u32 = 262144;
pub const AV_CODEC_FLAG_LOW_DELAY: u32 = 524288;
pub const AV_CODEC_FLAG_GLOBAL_HEADER: u32 = 4194304;
pub const AV_CODEC_FLAG_BITEXACT: u32 = 8388608;
pub const AV_CODEC_FLAG_AC_PRED: u32 = 16777216;
pub const AV_CODEC_FLAG_INTERLACED_ME: u32 = 536870912;
pub const AV_CODEC_FLAG_CLOSED_GOP: u32 = 2147483648;
pub const AV_CODEC_RECEIVE_FRAME_FLAG_SYNCHRONOUS: u32 = 1;
pub const AVSEEK_SIZE: u32 = 65536;
pub const AVSEEK_FORCE: u32 = 131072;
pub const AVIO_FLAG_READ: u32 = 1;
pub const AVIO_FLAG_WRITE: u32 = 2;
pub const AVIO_FLAG_READ_WRITE: u32 = 3;
pub const AVIO_FLAG_NONBLOCK: u32 = 8;
pub const AVIO_FLAG_DIRECT: u32 = 32768;
pub const AVFMT_NOFILE: u32 = 1;
pub const AVFMT_NEEDNUMBER: u32 = 2;
pub const AVFMT_EXPERIMENTAL: u32 = 4;
pub const AVFMT_SHOW_IDS: u32 = 8;
pub const AVFMT_GLOBALHEADER: u32 = 64;
pub const AVFMT_NOTIMESTAMPS: u32 = 128;
pub const AVFMT_GENERIC_INDEX: u32 = 256;
pub const AVFMT_TS_DISCONT: u32 = 512;
pub const AVFMT_VARIABLE_FPS: u32 = 1024;
pub const AVFMT_NODIMENSIONS: u32 = 2048;
pub const AVFMT_NOSTREAMS: u32 = 4096;
pub const AVFMT_NOBINSEARCH: u32 = 8192;
pub const AVFMT_NOGENSEARCH: u32 = 16384;
pub const AVFMT_NO_BYTE_SEEK: u32 = 32768;
pub const AVFMT_TS_NONSTRICT: u32 = 131072;
pub const AVFMT_TS_NEGATIVE: u32 = 262144;
pub const AVFMT_FIXED_FRAMESIZE: u32 = 524288;
pub const AVFMT_SEEK_TO_PTS: u32 = 67108864;
pub const AV_PROGRAM_RUNNING: u32 = 1;
pub const AVFMT_FLAG_GENPTS: u32 = 1;
pub const AVFMT_FLAG_IGNIDX: u32 = 2;
pub const AVFMT_FLAG_NONBLOCK: u32 = 4;
pub const AVFMT_FLAG_IGNDTS: u32 = 8;
pub const AVFMT_FLAG_NOFILLIN: u32 = 16;
pub const AVFMT_FLAG_NOPARSE: u32 = 32;
pub const AVFMT_FLAG_NOBUFFER: u32 = 64;
pub const AVFMT_FLAG_CUSTOM_IO: u32 = 128;
pub const AVFMT_FLAG_DISCARD_CORRUPT: u32 = 256;
pub const AVFMT_FLAG_FLUSH_PACKETS: u32 = 512;
pub const AVFMT_FLAG_BITEXACT: u32 = 1024;
pub const AVFMT_FLAG_SORT_DTS: u32 = 65536;
pub const AVFMT_FLAG_FAST_SEEK: u32 = 524288;
pub const AVFMT_FLAG_AUTO_BSF: u32 = 2097152;
pub const AV_FDEBUG_TS: u32 = 1;
pub const AV_FDEBUG_ID3V2: u32 = 2;
pub const AVFMT_PROGCOPY_MATCH_BY_ID: u32 = 1;
pub const AVFMT_PROGCOPY_MATCH_BY_INDEX: u32 = 2;
pub const AVFMT_PROGCOPY_OVERWRITE: u32 = 256;
pub const AVSEEK_FLAG_BACKWARD: u32 = 1;
pub const AVSEEK_FLAG_BYTE: u32 = 2;
pub const AVSEEK_FLAG_ANY: u32 = 4;
pub const AVSEEK_FLAG_FRAME: u32 = 8;
pub const AV_FRAME_FILENAME_FLAGS_MULTIPLE: u32 = 1;
pub const AV_FRAME_FILENAME_FLAGS_IGNORE_TRUNCATION: u32 = 2;
pub const AV_BUFFERSINK_FLAG_PEEK: u32 = 1;
pub const AV_BUFFERSINK_FLAG_NO_REQUEST: u32 = 2;
pub const AVMEDIA_TYPE_UNKNOWN: AVMediaType = -1;
pub const AVMEDIA_TYPE_VIDEO: AVMediaType = 0;
pub const AVMEDIA_TYPE_AUDIO: AVMediaType = 1;
pub const AVMEDIA_TYPE_DATA: AVMediaType = 2;
pub const AVMEDIA_TYPE_SUBTITLE: AVMediaType = 3;
pub const AVMEDIA_TYPE_ATTACHMENT: AVMediaType = 4;
pub const AVMEDIA_TYPE_NB: AVMediaType = 5;
pub type AVMediaType = ::std::os::raw::c_int;
pub const AV_PICTURE_TYPE_NONE: AVPictureType = 0;
pub const AV_PICTURE_TYPE_I: AVPictureType = 1;
pub const AV_PICTURE_TYPE_P: AVPictureType = 2;
pub const AV_PICTURE_TYPE_B: AVPictureType = 3;
pub const AV_PICTURE_TYPE_S: AVPictureType = 4;
pub const AV_PICTURE_TYPE_SI: AVPictureType = 5;
pub const AV_PICTURE_TYPE_SP: AVPictureType = 6;
pub const AV_PICTURE_TYPE_BI: AVPictureType = 7;
pub type AVPictureType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVRational {
    pub num: ::std::os::raw::c_int,
    pub den: ::std::os::raw::c_int,
}
pub const AV_ROUND_ZERO: AVRounding = 0;
pub const AV_ROUND_INF: AVRounding = 1;
pub const AV_ROUND_DOWN: AVRounding = 2;
pub const AV_ROUND_UP: AVRounding = 3;
pub const AV_ROUND_NEAR_INF: AVRounding = 5;
pub const AV_ROUND_PASS_MINMAX: AVRounding = 8192;
pub type AVRounding = ::std::os::raw::c_int;
pub const AV_CLASS_CATEGORY_NA: AVClassCategory = 0;
pub const AV_CLASS_CATEGORY_INPUT: AVClassCategory = 1;
pub const AV_CLASS_CATEGORY_OUTPUT: AVClassCategory = 2;
pub const AV_CLASS_CATEGORY_MUXER: AVClassCategory = 3;
pub const AV_CLASS_CATEGORY_DEMUXER: AVClassCategory = 4;
pub const AV_CLASS_CATEGORY_ENCODER: AVClassCategory = 5;
pub const AV_CLASS_CATEGORY_DECODER: AVClassCategory = 6;
pub const AV_CLASS_CATEGORY_FILTER: AVClassCategory = 7;
pub const AV_CLASS_CATEGORY_BITSTREAM_FILTER: AVClassCategory = 8;
pub const AV_CLASS_CATEGORY_SWSCALER: AVClassCategory = 9;
pub const AV_CLASS_CATEGORY_SWRESAMPLER: AVClassCategory = 10;
pub const AV_CLASS_CATEGORY_HWDEVICE: AVClassCategory = 11;
pub const AV_CLASS_CATEGORY_DEVICE_VIDEO_OUTPUT: AVClassCategory = 40;
pub const AV_CLASS_CATEGORY_DEVICE_VIDEO_INPUT: AVClassCategory = 41;
pub const AV_CLASS_CATEGORY_DEVICE_AUDIO_OUTPUT: AVClassCategory = 42;
pub const AV_CLASS_CATEGORY_DEVICE_AUDIO_INPUT: AVClassCategory = 43;
pub const AV_CLASS_CATEGORY_DEVICE_OUTPUT: AVClassCategory = 44;
pub const AV_CLASS_CATEGORY_DEVICE_INPUT: AVClassCategory = 45;
pub const AV_CLASS_CATEGORY_NB: AVClassCategory = 46;
pub type AVClassCategory = ::std::os::raw::c_int;
pub const AV_CLASS_STATE_INITIALIZED: AVClassStateFlags = 1;
pub type AVClassStateFlags = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVClass {
    pub class_name: *const ::std::os::raw::c_char,
    pub item_name: ::std::option::Option<
        unsafe extern "C" fn(ctx: *mut ::std::os::raw::c_void) -> *const ::std::os::raw::c_char,
    >,
    pub option: *const AVOption,
    pub version: ::std::os::raw::c_int,
    pub log_level_offset_offset: ::std::os::raw::c_int,
    pub parent_log_context_offset: ::std::os::raw::c_int,
    pub category: AVClassCategory,
    pub get_category: ::std::option::Option<
        unsafe extern "C" fn(ctx: *mut ::std::os::raw::c_void) -> AVClassCategory,
    >,
    pub query_ranges: ::std::option::Option<
        unsafe extern "C" fn(
            arg1: *mut *mut AVOptionRanges,
            obj: *mut ::std::os::raw::c_void,
            key: *const ::std::os::raw::c_char,
            flags: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub child_next: ::std::option::Option<
        unsafe extern "C" fn(
            obj: *mut ::std::os::raw::c_void,
            prev: *mut ::std::os::raw::c_void,
        ) -> *mut ::std::os::raw::c_void,
    >,
    pub child_class_iterate: ::std::option::Option<
        unsafe extern "C" fn(iter: *mut *mut ::std::os::raw::c_void) -> *const AVClass,
    >,
    pub state_flags_offset: ::std::os::raw::c_int,
}
impl Default for AVClass {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_PIX_FMT_NONE: AVPixelFormat = -1;
pub const AV_PIX_FMT_YUV420P: AVPixelFormat = 0;
pub const AV_PIX_FMT_YUYV422: AVPixelFormat = 1;
pub const AV_PIX_FMT_RGB24: AVPixelFormat = 2;
pub const AV_PIX_FMT_BGR24: AVPixelFormat = 3;
pub const AV_PIX_FMT_YUV422P: AVPixelFormat = 4;
pub const AV_PIX_FMT_YUV444P: AVPixelFormat = 5;
pub const AV_PIX_FMT_YUV410P: AVPixelFormat = 6;
pub const AV_PIX_FMT_YUV411P: AVPixelFormat = 7;
pub const AV_PIX_FMT_GRAY8: AVPixelFormat = 8;
pub const AV_PIX_FMT_MONOWHITE: AVPixelFormat = 9;
pub const AV_PIX_FMT_MONOBLACK: AVPixelFormat = 10;
pub const AV_PIX_FMT_PAL8: AVPixelFormat = 11;
pub const AV_PIX_FMT_YUVJ420P: AVPixelFormat = 12;
pub const AV_PIX_FMT_YUVJ422P: AVPixelFormat = 13;
pub const AV_PIX_FMT_YUVJ444P: AVPixelFormat = 14;
pub const AV_PIX_FMT_UYVY422: AVPixelFormat = 15;
pub const AV_PIX_FMT_UYYVYY411: AVPixelFormat = 16;
pub const AV_PIX_FMT_BGR8: AVPixelFormat = 17;
pub const AV_PIX_FMT_BGR4: AVPixelFormat = 18;
pub const AV_PIX_FMT_BGR4_BYTE: AVPixelFormat = 19;
pub const AV_PIX_FMT_RGB8: AVPixelFormat = 20;
pub const AV_PIX_FMT_RGB4: AVPixelFormat = 21;
pub const AV_PIX_FMT_RGB4_BYTE: AVPixelFormat = 22;
pub const AV_PIX_FMT_NV12: AVPixelFormat = 23;
pub const AV_PIX_FMT_NV21: AVPixelFormat = 24;
pub const AV_PIX_FMT_ARGB: AVPixelFormat = 25;
pub const AV_PIX_FMT_RGBA: AVPixelFormat = 26;
pub const AV_PIX_FMT_ABGR: AVPixelFormat = 27;
pub const AV_PIX_FMT_BGRA: AVPixelFormat = 28;
pub const AV_PIX_FMT_GRAY16BE: AVPixelFormat = 29;
pub const AV_PIX_FMT_GRAY16LE: AVPixelFormat = 30;
pub const AV_PIX_FMT_YUV440P: AVPixelFormat = 31;
pub const AV_PIX_FMT_YUVJ440P: AVPixelFormat = 32;
pub const AV_PIX_FMT_YUVA420P: AVPixelFormat = 33;
pub const AV_PIX_FMT_RGB48BE: AVPixelFormat = 34;
pub const AV_PIX_FMT_RGB48LE: AVPixelFormat = 35;
pub const AV_PIX_FMT_RGB565BE: AVPixelFormat = 36;
pub const AV_PIX_FMT_RGB565LE: AVPixelFormat = 37;
pub const AV_PIX_FMT_RGB555BE: AVPixelFormat = 38;
pub const AV_PIX_FMT_RGB555LE: AVPixelFormat = 39;
pub const AV_PIX_FMT_BGR565BE: AVPixelFormat = 40;
pub const AV_PIX_FMT_BGR565LE: AVPixelFormat = 41;
pub const AV_PIX_FMT_BGR555BE: AVPixelFormat = 42;
pub const AV_PIX_FMT_BGR555LE: AVPixelFormat = 43;
pub const AV_PIX_FMT_VAAPI: AVPixelFormat = 44;
pub const AV_PIX_FMT_YUV420P16LE: AVPixelFormat = 45;
pub const AV_PIX_FMT_YUV420P16BE: AVPixelFormat = 46;
pub const AV_PIX_FMT_YUV422P16LE: AVPixelFormat = 47;
pub const AV_PIX_FMT_YUV422P16BE: AVPixelFormat = 48;
pub const AV_PIX_FMT_YUV444P16LE: AVPixelFormat = 49;
pub const AV_PIX_FMT_YUV444P16BE: AVPixelFormat = 50;
pub const AV_PIX_FMT_DXVA2_VLD: AVPixelFormat = 51;
pub const AV_PIX_FMT_RGB444LE: AVPixelFormat = 52;
pub const AV_PIX_FMT_RGB444BE: AVPixelFormat = 53;
pub const AV_PIX_FMT_BGR444LE: AVPixelFormat = 54;
pub const AV_PIX_FMT_BGR444BE: AVPixelFormat = 55;
pub const AV_PIX_FMT_YA8: AVPixelFormat = 56;
pub const AV_PIX_FMT_Y400A: AVPixelFormat = 56;
pub const AV_PIX_FMT_GRAY8A: AVPixelFormat = 56;
pub const AV_PIX_FMT_BGR48BE: AVPixelFormat = 57;
pub const AV_PIX_FMT_BGR48LE: AVPixelFormat = 58;
pub const AV_PIX_FMT_YUV420P9BE: AVPixelFormat = 59;
pub const AV_PIX_FMT_YUV420P9LE: AVPixelFormat = 60;
pub const AV_PIX_FMT_YUV420P10BE: AVPixelFormat = 61;
pub const AV_PIX_FMT_YUV420P10LE: AVPixelFormat = 62;
pub const AV_PIX_FMT_YUV422P10BE: AVPixelFormat = 63;
pub const AV_PIX_FMT_YUV422P10LE: AVPixelFormat = 64;
pub const AV_PIX_FMT_YUV444P9BE: AVPixelFormat = 65;
pub const AV_PIX_FMT_YUV444P9LE: AVPixelFormat = 66;
pub const AV_PIX_FMT_YUV444P10BE: AVPixelFormat = 67;
pub const AV_PIX_FMT_YUV444P10LE: AVPixelFormat = 68;
pub const AV_PIX_FMT_YUV422P9BE: AVPixelFormat = 69;
pub const AV_PIX_FMT_YUV422P9LE: AVPixelFormat = 70;
pub const AV_PIX_FMT_GBRP: AVPixelFormat = 71;
pub const AV_PIX_FMT_GBR24P: AVPixelFormat = 71;
pub const AV_PIX_FMT_GBRP9BE: AVPixelFormat = 72;
pub const AV_PIX_FMT_GBRP9LE: AVPixelFormat = 73;
pub const AV_PIX_FMT_GBRP10BE: AVPixelFormat = 74;
pub const AV_PIX_FMT_GBRP10LE: AVPixelFormat = 75;
pub const AV_PIX_FMT_GBRP16BE: AVPixelFormat = 76;
pub const AV_PIX_FMT_GBRP16LE: AVPixelFormat = 77;
pub const AV_PIX_FMT_YUVA422P: AVPixelFormat = 78;
pub const AV_PIX_FMT_YUVA444P: AVPixelFormat = 79;
pub const AV_PIX_FMT_YUVA420P9BE: AVPixelFormat = 80;
pub const AV_PIX_FMT_YUVA420P9LE: AVPixelFormat = 81;
pub const AV_PIX_FMT_YUVA422P9BE: AVPixelFormat = 82;
pub const AV_PIX_FMT_YUVA422P9LE: AVPixelFormat = 83;
pub const AV_PIX_FMT_YUVA444P9BE: AVPixelFormat = 84;
pub const AV_PIX_FMT_YUVA444P9LE: AVPixelFormat = 85;
pub const AV_PIX_FMT_YUVA420P10BE: AVPixelFormat = 86;
pub const AV_PIX_FMT_YUVA420P10LE: AVPixelFormat = 87;
pub const AV_PIX_FMT_YUVA422P10BE: AVPixelFormat = 88;
pub const AV_PIX_FMT_YUVA422P10LE: AVPixelFormat = 89;
pub const AV_PIX_FMT_YUVA444P10BE: AVPixelFormat = 90;
pub const AV_PIX_FMT_YUVA444P10LE: AVPixelFormat = 91;
pub const AV_PIX_FMT_YUVA420P16BE: AVPixelFormat = 92;
pub const AV_PIX_FMT_YUVA420P16LE: AVPixelFormat = 93;
pub const AV_PIX_FMT_YUVA422P16BE: AVPixelFormat = 94;
pub const AV_PIX_FMT_YUVA422P16LE: AVPixelFormat = 95;
pub const AV_PIX_FMT_YUVA444P16BE: AVPixelFormat = 96;
pub const AV_PIX_FMT_YUVA444P16LE: AVPixelFormat = 97;
pub const AV_PIX_FMT_VDPAU: AVPixelFormat = 98;
pub const AV_PIX_FMT_XYZ12LE: AVPixelFormat = 99;
pub const AV_PIX_FMT_XYZ12BE: AVPixelFormat = 100;
pub const AV_PIX_FMT_NV16: AVPixelFormat = 101;
pub const AV_PIX_FMT_NV20LE: AVPixelFormat = 102;
pub const AV_PIX_FMT_NV20BE: AVPixelFormat = 103;
pub const AV_PIX_FMT_RGBA64BE: AVPixelFormat = 104;
pub const AV_PIX_FMT_RGBA64LE: AVPixelFormat = 105;
pub const AV_PIX_FMT_BGRA64BE: AVPixelFormat = 106;
pub const AV_PIX_FMT_BGRA64LE: AVPixelFormat = 107;
pub const AV_PIX_FMT_YVYU422: AVPixelFormat = 108;
pub const AV_PIX_FMT_YA16BE: AVPixelFormat = 109;
pub const AV_PIX_FMT_YA16LE: AVPixelFormat = 110;
pub const AV_PIX_FMT_GBRAP: AVPixelFormat = 111;
pub const AV_PIX_FMT_GBRAP16BE: AVPixelFormat = 112;
pub const AV_PIX_FMT_GBRAP16LE: AVPixelFormat = 113;
pub const AV_PIX_FMT_QSV: AVPixelFormat = 114;
pub const AV_PIX_FMT_MMAL: AVPixelFormat = 115;
pub const AV_PIX_FMT_D3D11VA_VLD: AVPixelFormat = 116;
pub const AV_PIX_FMT_CUDA: AVPixelFormat = 117;
pub const AV_PIX_FMT_0RGB: AVPixelFormat = 118;
pub const AV_PIX_FMT_RGB0: AVPixelFormat = 119;
pub const AV_PIX_FMT_0BGR: AVPixelFormat = 120;
pub const AV_PIX_FMT_BGR0: AVPixelFormat = 121;
pub const AV_PIX_FMT_YUV420P12BE: AVPixelFormat = 122;
pub const AV_PIX_FMT_YUV420P12LE: AVPixelFormat = 123;
pub const AV_PIX_FMT_YUV420P14BE: AVPixelFormat = 124;
pub const AV_PIX_FMT_YUV420P14LE: AVPixelFormat = 125;
pub const AV_PIX_FMT_YUV422P12BE: AVPixelFormat = 126;
pub const AV_PIX_FMT_YUV422P12LE: AVPixelFormat = 127;
pub const AV_PIX_FMT_YUV422P14BE: AVPixelFormat = 128;
pub const AV_PIX_FMT_YUV422P14LE: AVPixelFormat = 129;
pub const AV_PIX_FMT_YUV444P12BE: AVPixelFormat = 130;
pub const AV_PIX_FMT_YUV444P12LE: AVPixelFormat = 131;
pub const AV_PIX_FMT_YUV444P14BE: AVPixelFormat = 132;
pub const AV_PIX_FMT_YUV444P14LE: AVPixelFormat = 133;
pub const AV_PIX_FMT_GBRP12BE: AVPixelFormat = 134;
pub const AV_PIX_FMT_GBRP12LE: AVPixelFormat = 135;
pub const AV_PIX_FMT_GBRP14BE: AVPixelFormat = 136;
pub const AV_PIX_FMT_GBRP14LE: AVPixelFormat = 137;
pub const AV_PIX_FMT_YUVJ411P: AVPixelFormat = 138;
pub const AV_PIX_FMT_BAYER_BGGR8: AVPixelFormat = 139;
pub const AV_PIX_FMT_BAYER_RGGB8: AVPixelFormat = 140;
pub const AV_PIX_FMT_BAYER_GBRG8: AVPixelFormat = 141;
pub const AV_PIX_FMT_BAYER_GRBG8: AVPixelFormat = 142;
pub const AV_PIX_FMT_BAYER_BGGR16LE: AVPixelFormat = 143;
pub const AV_PIX_FMT_BAYER_BGGR16BE: AVPixelFormat = 144;
pub const AV_PIX_FMT_BAYER_RGGB16LE: AVPixelFormat = 145;
pub const AV_PIX_FMT_BAYER_RGGB16BE: AVPixelFormat = 146;
pub const AV_PIX_FMT_BAYER_GBRG16LE: AVPixelFormat = 147;
pub const AV_PIX_FMT_BAYER_GBRG16BE: AVPixelFormat = 148;
pub const AV_PIX_FMT_BAYER_GRBG16LE: AVPixelFormat = 149;
pub const AV_PIX_FMT_BAYER_GRBG16BE: AVPixelFormat = 150;
pub const AV_PIX_FMT_YUV440P10LE: AVPixelFormat = 151;
pub const AV_PIX_FMT_YUV440P10BE: AVPixelFormat = 152;
pub const AV_PIX_FMT_YUV440P12LE: AVPixelFormat = 153;
pub const AV_PIX_FMT_YUV440P12BE: AVPixelFormat = 154;
pub const AV_PIX_FMT_AYUV64LE: AVPixelFormat = 155;
pub const AV_PIX_FMT_AYUV64BE: AVPixelFormat = 156;
pub const AV_PIX_FMT_VIDEOTOOLBOX: AVPixelFormat = 157;
pub const AV_PIX_FMT_P010LE: AVPixelFormat = 158;
pub const AV_PIX_FMT_P010BE: AVPixelFormat = 159;
pub const AV_PIX_FMT_GBRAP12BE: AVPixelFormat = 160;
pub const AV_PIX_FMT_GBRAP12LE: AVPixelFormat = 161;
pub const AV_PIX_FMT_GBRAP10BE: AVPixelFormat = 162;
pub const AV_PIX_FMT_GBRAP10LE: AVPixelFormat = 163;
pub const AV_PIX_FMT_MEDIACODEC: AVPixelFormat = 164;
pub const AV_PIX_FMT_GRAY12BE: AVPixelFormat = 165;
pub const AV_PIX_FMT_GRAY12LE: AVPixelFormat = 166;
pub const AV_PIX_FMT_GRAY10BE: AVPixelFormat = 167;
pub const AV_PIX_FMT_GRAY10LE: AVPixelFormat = 168;
pub const AV_PIX_FMT_P016LE: AVPixelFormat = 169;
pub const AV_PIX_FMT_P016BE: AVPixelFormat = 170;
pub const AV_PIX_FMT_D3D11: AVPixelFormat = 171;
pub const AV_PIX_FMT_GRAY9BE: AVPixelFormat = 172;
pub const AV_PIX_FMT_GRAY9LE: AVPixelFormat = 173;
pub const AV_PIX_FMT_GBRPF32BE: AVPixelFormat = 174;
pub const AV_PIX_FMT_GBRPF32LE: AVPixelFormat = 175;
pub const AV_PIX_FMT_GBRAPF32BE: AVPixelFormat = 176;
pub const AV_PIX_FMT_GBRAPF32LE: AVPixelFormat = 177;
pub const AV_PIX_FMT_DRM_PRIME: AVPixelFormat = 178;
pub const AV_PIX_FMT_OPENCL: AVPixelFormat = 179;
pub const AV_PIX_FMT_GRAY14BE: AVPixelFormat = 180;
pub const AV_PIX_FMT_GRAY14LE: AVPixelFormat = 181;
pub const AV_PIX_FMT_GRAYF32BE: AVPixelFormat = 182;
pub const AV_PIX_FMT_GRAYF32LE: AVPixelFormat = 183;
pub const AV_PIX_FMT_YUVA422P12BE: AVPixelFormat = 184;
pub const AV_PIX_FMT_YUVA422P12LE: AVPixelFormat = 185;
pub const AV_PIX_FMT_YUVA444P12BE: AVPixelFormat = 186;
pub const AV_PIX_FMT_YUVA444P12LE: AVPixelFormat = 187;
pub const AV_PIX_FMT_NV24: AVPixelFormat = 188;
pub const AV_PIX_FMT_NV42: AVPixelFormat = 189;
pub const AV_PIX_FMT_VULKAN: AVPixelFormat = 190;
pub const AV_PIX_FMT_Y210BE: AVPixelFormat = 191;
pub const AV_PIX_FMT_Y210LE: AVPixelFormat = 192;
pub const AV_PIX_FMT_X2RGB10LE: AVPixelFormat = 193;
pub const AV_PIX_FMT_X2RGB10BE: AVPixelFormat = 194;
pub const AV_PIX_FMT_X2BGR10LE: AVPixelFormat = 195;
pub const AV_PIX_FMT_X2BGR10BE: AVPixelFormat = 196;
pub const AV_PIX_FMT_P210BE: AVPixelFormat = 197;
pub const AV_PIX_FMT_P210LE: AVPixelFormat = 198;
pub const AV_PIX_FMT_P410BE: AVPixelFormat = 199;
pub const AV_PIX_FMT_P410LE: AVPixelFormat = 200;
pub const AV_PIX_FMT_P216BE: AVPixelFormat = 201;
pub const AV_PIX_FMT_P216LE: AVPixelFormat = 202;
pub const AV_PIX_FMT_P416BE: AVPixelFormat = 203;
pub const AV_PIX_FMT_P416LE: AVPixelFormat = 204;
pub const AV_PIX_FMT_VUYA: AVPixelFormat = 205;
pub const AV_PIX_FMT_RGBAF16BE: AVPixelFormat = 206;
pub const AV_PIX_FMT_RGBAF16LE: AVPixelFormat = 207;
pub const AV_PIX_FMT_VUYX: AVPixelFormat = 208;
pub const AV_PIX_FMT_P012LE: AVPixelFormat = 209;
pub const AV_PIX_FMT_P012BE: AVPixelFormat = 210;
pub const AV_PIX_FMT_Y212BE: AVPixelFormat = 211;
pub const AV_PIX_FMT_Y212LE: AVPixelFormat = 212;
pub const AV_PIX_FMT_XV30BE: AVPixelFormat = 213;
pub const AV_PIX_FMT_XV30LE: AVPixelFormat = 214;
pub const AV_PIX_FMT_XV36BE: AVPixelFormat = 215;
pub const AV_PIX_FMT_XV36LE: AVPixelFormat = 216;
pub const AV_PIX_FMT_RGBF32BE: AVPixelFormat = 217;
pub const AV_PIX_FMT_RGBF32LE: AVPixelFormat = 218;
pub const AV_PIX_FMT_RGBAF32BE: AVPixelFormat = 219;
pub const AV_PIX_FMT_RGBAF32LE: AVPixelFormat = 220;
pub const AV_PIX_FMT_P212BE: AVPixelFormat = 221;
pub const AV_PIX_FMT_P212LE: AVPixelFormat = 222;
pub const AV_PIX_FMT_P412BE: AVPixelFormat = 223;
pub const AV_PIX_FMT_P412LE: AVPixelFormat = 224;
pub const AV_PIX_FMT_GBRAP14BE: AVPixelFormat = 225;
pub const AV_PIX_FMT_GBRAP14LE: AVPixelFormat = 226;
pub const AV_PIX_FMT_D3D12: AVPixelFormat = 227;
pub const AV_PIX_FMT_AYUV: AVPixelFormat = 228;
pub const AV_PIX_FMT_UYVA: AVPixelFormat = 229;
pub const AV_PIX_FMT_VYU444: AVPixelFormat = 230;
pub const AV_PIX_FMT_V30XBE: AVPixelFormat = 231;
pub const AV_PIX_FMT_V30XLE: AVPixelFormat = 232;
pub const AV_PIX_FMT_RGBF16BE: AVPixelFormat = 233;
pub const AV_PIX_FMT_RGBF16LE: AVPixelFormat = 234;
pub const AV_PIX_FMT_RGBA128BE: AVPixelFormat = 235;
pub const AV_PIX_FMT_RGBA128LE: AVPixelFormat = 236;
pub const AV_PIX_FMT_RGB96BE: AVPixelFormat = 237;
pub const AV_PIX_FMT_RGB96LE: AVPixelFormat = 238;
pub const AV_PIX_FMT_Y216BE: AVPixelFormat = 239;
pub const AV_PIX_FMT_Y216LE: AVPixelFormat = 240;
pub const AV_PIX_FMT_XV48BE: AVPixelFormat = 241;
pub const AV_PIX_FMT_XV48LE: AVPixelFormat = 242;
pub const AV_PIX_FMT_GBRPF16BE: AVPixelFormat = 243;
pub const AV_PIX_FMT_GBRPF16LE: AVPixelFormat = 244;
pub const AV_PIX_FMT_GBRAPF16BE: AVPixelFormat = 245;
pub const AV_PIX_FMT_GBRAPF16LE: AVPixelFormat = 246;
pub const AV_PIX_FMT_GRAYF16BE: AVPixelFormat = 247;
pub const AV_PIX_FMT_GRAYF16LE: AVPixelFormat = 248;
pub const AV_PIX_FMT_AMF_SURFACE: AVPixelFormat = 249;
pub const AV_PIX_FMT_GRAY32BE: AVPixelFormat = 250;
pub const AV_PIX_FMT_GRAY32LE: AVPixelFormat = 251;
pub const AV_PIX_FMT_YAF32BE: AVPixelFormat = 252;
pub const AV_PIX_FMT_YAF32LE: AVPixelFormat = 253;
pub const AV_PIX_FMT_YAF16BE: AVPixelFormat = 254;
pub const AV_PIX_FMT_YAF16LE: AVPixelFormat = 255;
pub const AV_PIX_FMT_GBRAP32BE: AVPixelFormat = 256;
pub const AV_PIX_FMT_GBRAP32LE: AVPixelFormat = 257;
pub const AV_PIX_FMT_YUV444P10MSBBE: AVPixelFormat = 258;
pub const AV_PIX_FMT_YUV444P10MSBLE: AVPixelFormat = 259;
pub const AV_PIX_FMT_YUV444P12MSBBE: AVPixelFormat = 260;
pub const AV_PIX_FMT_YUV444P12MSBLE: AVPixelFormat = 261;
pub const AV_PIX_FMT_GBRP10MSBBE: AVPixelFormat = 262;
pub const AV_PIX_FMT_GBRP10MSBLE: AVPixelFormat = 263;
pub const AV_PIX_FMT_GBRP12MSBBE: AVPixelFormat = 264;
pub const AV_PIX_FMT_GBRP12MSBLE: AVPixelFormat = 265;
pub const AV_PIX_FMT_OHCODEC: AVPixelFormat = 266;
pub const AV_PIX_FMT_NB: AVPixelFormat = 267;
pub type AVPixelFormat = ::std::os::raw::c_int;
pub const AVCOL_PRI_RESERVED0: AVColorPrimaries = 0;
pub const AVCOL_PRI_BT709: AVColorPrimaries = 1;
pub const AVCOL_PRI_UNSPECIFIED: AVColorPrimaries = 2;
pub const AVCOL_PRI_RESERVED: AVColorPrimaries = 3;
pub const AVCOL_PRI_BT470M: AVColorPrimaries = 4;
pub const AVCOL_PRI_BT470BG: AVColorPrimaries = 5;
pub const AVCOL_PRI_SMPTE170M: AVColorPrimaries = 6;
pub const AVCOL_PRI_SMPTE240M: AVColorPrimaries = 7;
pub const AVCOL_PRI_FILM: AVColorPrimaries = 8;
pub const AVCOL_PRI_BT2020: AVColorPrimaries = 9;
pub const AVCOL_PRI_SMPTE428: AVColorPrimaries = 10;
pub const AVCOL_PRI_SMPTEST428_1: AVColorPrimaries = 10;
pub const AVCOL_PRI_SMPTE431: AVColorPrimaries = 11;
pub const AVCOL_PRI_SMPTE432: AVColorPrimaries = 12;
pub const AVCOL_PRI_EBU3213: AVColorPrimaries = 22;
pub const AVCOL_PRI_JEDEC_P22: AVColorPrimaries = 22;
pub const AVCOL_PRI_NB: AVColorPrimaries = 23;
pub const AVCOL_PRI_EXT_BASE: AVColorPrimaries = 256;
pub const AVCOL_PRI_V_GAMUT: AVColorPrimaries = 256;
pub const AVCOL_PRI_EXT_NB: AVColorPrimaries = 257;
pub type AVColorPrimaries = ::std::os::raw::c_int;
pub const AVCOL_TRC_RESERVED0: AVColorTransferCharacteristic = 0;
pub const AVCOL_TRC_BT709: AVColorTransferCharacteristic = 1;
pub const AVCOL_TRC_UNSPECIFIED: AVColorTransferCharacteristic = 2;
pub const AVCOL_TRC_RESERVED: AVColorTransferCharacteristic = 3;
pub const AVCOL_TRC_GAMMA22: AVColorTransferCharacteristic = 4;
pub const AVCOL_TRC_GAMMA28: AVColorTransferCharacteristic = 5;
pub const AVCOL_TRC_SMPTE170M: AVColorTransferCharacteristic = 6;
pub const AVCOL_TRC_SMPTE240M: AVColorTransferCharacteristic = 7;
pub const AVCOL_TRC_LINEAR: AVColorTransferCharacteristic = 8;
pub const AVCOL_TRC_LOG: AVColorTransferCharacteristic = 9;
pub const AVCOL_TRC_LOG_SQRT: AVColorTransferCharacteristic = 10;
pub const AVCOL_TRC_IEC61966_2_4: AVColorTransferCharacteristic = 11;
pub const AVCOL_TRC_BT1361_ECG: AVColorTransferCharacteristic = 12;
pub const AVCOL_TRC_IEC61966_2_1: AVColorTransferCharacteristic = 13;
pub const AVCOL_TRC_BT2020_10: AVColorTransferCharacteristic = 14;
pub const AVCOL_TRC_BT2020_12: AVColorTransferCharacteristic = 15;
pub const AVCOL_TRC_SMPTE2084: AVColorTransferCharacteristic = 16;
pub const AVCOL_TRC_SMPTEST2084: AVColorTransferCharacteristic = 16;
pub const AVCOL_TRC_SMPTE428: AVColorTransferCharacteristic = 17;
pub const AVCOL_TRC_SMPTEST428_1: AVColorTransferCharacteristic = 17;
pub const AVCOL_TRC_ARIB_STD_B67: AVColorTransferCharacteristic = 18;
pub const AVCOL_TRC_NB: AVColorTransferCharacteristic = 19;
pub const AVCOL_TRC_EXT_BASE: AVColorTransferCharacteristic = 256;
pub const AVCOL_TRC_V_LOG: AVColorTransferCharacteristic = 256;
pub const AVCOL_TRC_EXT_NB: AVColorTransferCharacteristic = 257;
pub type AVColorTransferCharacteristic = ::std::os::raw::c_int;
pub const AVCOL_SPC_RGB: AVColorSpace = 0;
pub const AVCOL_SPC_BT709: AVColorSpace = 1;
pub const AVCOL_SPC_UNSPECIFIED: AVColorSpace = 2;
pub const AVCOL_SPC_RESERVED: AVColorSpace = 3;
pub const AVCOL_SPC_FCC: AVColorSpace = 4;
pub const AVCOL_SPC_BT470BG: AVColorSpace = 5;
pub const AVCOL_SPC_SMPTE170M: AVColorSpace = 6;
pub const AVCOL_SPC_SMPTE240M: AVColorSpace = 7;
pub const AVCOL_SPC_YCGCO: AVColorSpace = 8;
pub const AVCOL_SPC_YCOCG: AVColorSpace = 8;
pub const AVCOL_SPC_BT2020_NCL: AVColorSpace = 9;
pub const AVCOL_SPC_BT2020_CL: AVColorSpace = 10;
pub const AVCOL_SPC_SMPTE2085: AVColorSpace = 11;
pub const AVCOL_SPC_CHROMA_DERIVED_NCL: AVColorSpace = 12;
pub const AVCOL_SPC_CHROMA_DERIVED_CL: AVColorSpace = 13;
pub const AVCOL_SPC_ICTCP: AVColorSpace = 14;
pub const AVCOL_SPC_IPT_C2: AVColorSpace = 15;
pub const AVCOL_SPC_YCGCO_RE: AVColorSpace = 16;
pub const AVCOL_SPC_YCGCO_RO: AVColorSpace = 17;
pub const AVCOL_SPC_NB: AVColorSpace = 18;
pub type AVColorSpace = ::std::os::raw::c_int;
pub const AVCOL_RANGE_UNSPECIFIED: AVColorRange = 0;
pub const AVCOL_RANGE_MPEG: AVColorRange = 1;
pub const AVCOL_RANGE_JPEG: AVColorRange = 2;
pub const AVCOL_RANGE_NB: AVColorRange = 3;
pub type AVColorRange = ::std::os::raw::c_int;
pub const AVCHROMA_LOC_UNSPECIFIED: AVChromaLocation = 0;
pub const AVCHROMA_LOC_LEFT: AVChromaLocation = 1;
pub const AVCHROMA_LOC_CENTER: AVChromaLocation = 2;
pub const AVCHROMA_LOC_TOPLEFT: AVChromaLocation = 3;
pub const AVCHROMA_LOC_TOP: AVChromaLocation = 4;
pub const AVCHROMA_LOC_BOTTOMLEFT: AVChromaLocation = 5;
pub const AVCHROMA_LOC_BOTTOM: AVChromaLocation = 6;
pub const AVCHROMA_LOC_NB: AVChromaLocation = 7;
pub type AVChromaLocation = ::std::os::raw::c_int;
pub const AVALPHA_MODE_UNSPECIFIED: AVAlphaMode = 0;
pub const AVALPHA_MODE_PREMULTIPLIED: AVAlphaMode = 1;
pub const AVALPHA_MODE_STRAIGHT: AVAlphaMode = 2;
pub const AVALPHA_MODE_NB: AVAlphaMode = 3;
pub type AVAlphaMode = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVBuffer {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVBufferRef {
    pub buffer: *mut AVBuffer,
    pub data: *mut u8,
    pub size: usize,
}
impl Default for AVBufferRef {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVBufferPool {
    _unused: [u8; 0],
}
pub const AV_CHAN_NONE: AVChannel = -1;
pub const AV_CHAN_FRONT_LEFT: AVChannel = 0;
pub const AV_CHAN_FRONT_RIGHT: AVChannel = 1;
pub const AV_CHAN_FRONT_CENTER: AVChannel = 2;
pub const AV_CHAN_LOW_FREQUENCY: AVChannel = 3;
pub const AV_CHAN_BACK_LEFT: AVChannel = 4;
pub const AV_CHAN_BACK_RIGHT: AVChannel = 5;
pub const AV_CHAN_FRONT_LEFT_OF_CENTER: AVChannel = 6;
pub const AV_CHAN_FRONT_RIGHT_OF_CENTER: AVChannel = 7;
pub const AV_CHAN_BACK_CENTER: AVChannel = 8;
pub const AV_CHAN_SIDE_LEFT: AVChannel = 9;
pub const AV_CHAN_SIDE_RIGHT: AVChannel = 10;
pub const AV_CHAN_TOP_CENTER: AVChannel = 11;
pub const AV_CHAN_TOP_FRONT_LEFT: AVChannel = 12;
pub const AV_CHAN_TOP_FRONT_CENTER: AVChannel = 13;
pub const AV_CHAN_TOP_FRONT_RIGHT: AVChannel = 14;
pub const AV_CHAN_TOP_BACK_LEFT: AVChannel = 15;
pub const AV_CHAN_TOP_BACK_CENTER: AVChannel = 16;
pub const AV_CHAN_TOP_BACK_RIGHT: AVChannel = 17;
pub const AV_CHAN_STEREO_LEFT: AVChannel = 29;
pub const AV_CHAN_STEREO_RIGHT: AVChannel = 30;
pub const AV_CHAN_WIDE_LEFT: AVChannel = 31;
pub const AV_CHAN_WIDE_RIGHT: AVChannel = 32;
pub const AV_CHAN_SURROUND_DIRECT_LEFT: AVChannel = 33;
pub const AV_CHAN_SURROUND_DIRECT_RIGHT: AVChannel = 34;
pub const AV_CHAN_LOW_FREQUENCY_2: AVChannel = 35;
pub const AV_CHAN_TOP_SIDE_LEFT: AVChannel = 36;
pub const AV_CHAN_TOP_SIDE_RIGHT: AVChannel = 37;
pub const AV_CHAN_BOTTOM_FRONT_CENTER: AVChannel = 38;
pub const AV_CHAN_BOTTOM_FRONT_LEFT: AVChannel = 39;
pub const AV_CHAN_BOTTOM_FRONT_RIGHT: AVChannel = 40;
pub const AV_CHAN_SIDE_SURROUND_LEFT: AVChannel = 41;
pub const AV_CHAN_SIDE_SURROUND_RIGHT: AVChannel = 42;
pub const AV_CHAN_TOP_SURROUND_LEFT: AVChannel = 43;
pub const AV_CHAN_TOP_SURROUND_RIGHT: AVChannel = 44;
pub const AV_CHAN_BINAURAL_LEFT: AVChannel = 61;
pub const AV_CHAN_BINAURAL_RIGHT: AVChannel = 62;
pub const AV_CHAN_UNUSED: AVChannel = 512;
pub const AV_CHAN_UNKNOWN: AVChannel = 768;
pub const AV_CHAN_AMBISONIC_BASE: AVChannel = 1024;
pub const AV_CHAN_AMBISONIC_END: AVChannel = 2047;
pub type AVChannel = ::std::os::raw::c_int;
pub const AV_CHANNEL_ORDER_UNSPEC: AVChannelOrder = 0;
pub const AV_CHANNEL_ORDER_NATIVE: AVChannelOrder = 1;
pub const AV_CHANNEL_ORDER_CUSTOM: AVChannelOrder = 2;
pub const AV_CHANNEL_ORDER_AMBISONIC: AVChannelOrder = 3;
pub const FF_CHANNEL_ORDER_NB: AVChannelOrder = 4;
pub type AVChannelOrder = ::std::os::raw::c_int;
pub const AV_MATRIX_ENCODING_NONE: AVMatrixEncoding = 0;
pub const AV_MATRIX_ENCODING_DOLBY: AVMatrixEncoding = 1;
pub const AV_MATRIX_ENCODING_DPLII: AVMatrixEncoding = 2;
pub const AV_MATRIX_ENCODING_DPLIIX: AVMatrixEncoding = 3;
pub const AV_MATRIX_ENCODING_DPLIIZ: AVMatrixEncoding = 4;
pub const AV_MATRIX_ENCODING_DOLBYEX: AVMatrixEncoding = 5;
pub const AV_MATRIX_ENCODING_DOLBYHEADPHONE: AVMatrixEncoding = 6;
pub const AV_MATRIX_ENCODING_NB: AVMatrixEncoding = 7;
pub type AVMatrixEncoding = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVChannelCustom {
    pub id: AVChannel,
    pub name: [::std::os::raw::c_char; 16usize],
    pub opaque: *mut ::std::os::raw::c_void,
}
impl Default for AVChannelCustom {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVChannelLayout {
    pub order: AVChannelOrder,
    pub nb_channels: ::std::os::raw::c_int,
    pub u: AVChannelLayout__bindgen_ty_1,
    pub opaque: *mut ::std::os::raw::c_void,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub union AVChannelLayout__bindgen_ty_1 {
    pub mask: u64,
    pub map: *mut AVChannelCustom,
}
impl Default for AVChannelLayout__bindgen_ty_1 {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
impl Default for AVChannelLayout {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVBPrint {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVDictionaryEntry {
    pub key: *mut ::std::os::raw::c_char,
    pub value: *mut ::std::os::raw::c_char,
}
impl Default for AVDictionaryEntry {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVDictionary {
    _unused: [u8; 0],
}
pub const AV_SAMPLE_FMT_NONE: AVSampleFormat = -1;
pub const AV_SAMPLE_FMT_U8: AVSampleFormat = 0;
pub const AV_SAMPLE_FMT_S16: AVSampleFormat = 1;
pub const AV_SAMPLE_FMT_S32: AVSampleFormat = 2;
pub const AV_SAMPLE_FMT_FLT: AVSampleFormat = 3;
pub const AV_SAMPLE_FMT_DBL: AVSampleFormat = 4;
pub const AV_SAMPLE_FMT_U8P: AVSampleFormat = 5;
pub const AV_SAMPLE_FMT_S16P: AVSampleFormat = 6;
pub const AV_SAMPLE_FMT_S32P: AVSampleFormat = 7;
pub const AV_SAMPLE_FMT_FLTP: AVSampleFormat = 8;
pub const AV_SAMPLE_FMT_DBLP: AVSampleFormat = 9;
pub const AV_SAMPLE_FMT_S64: AVSampleFormat = 10;
pub const AV_SAMPLE_FMT_S64P: AVSampleFormat = 11;
pub const AV_SAMPLE_FMT_NB: AVSampleFormat = 12;
pub type AVSampleFormat = ::std::os::raw::c_int;
pub const AV_FRAME_DATA_PANSCAN: AVFrameSideDataType = 0;
pub const AV_FRAME_DATA_A53_CC: AVFrameSideDataType = 1;
pub const AV_FRAME_DATA_STEREO3D: AVFrameSideDataType = 2;
pub const AV_FRAME_DATA_MATRIXENCODING: AVFrameSideDataType = 3;
pub const AV_FRAME_DATA_DOWNMIX_INFO: AVFrameSideDataType = 4;
pub const AV_FRAME_DATA_REPLAYGAIN: AVFrameSideDataType = 5;
pub const AV_FRAME_DATA_DISPLAYMATRIX: AVFrameSideDataType = 6;
pub const AV_FRAME_DATA_AFD: AVFrameSideDataType = 7;
pub const AV_FRAME_DATA_MOTION_VECTORS: AVFrameSideDataType = 8;
pub const AV_FRAME_DATA_SKIP_SAMPLES: AVFrameSideDataType = 9;
pub const AV_FRAME_DATA_AUDIO_SERVICE_TYPE: AVFrameSideDataType = 10;
pub const AV_FRAME_DATA_MASTERING_DISPLAY_METADATA: AVFrameSideDataType = 11;
pub const AV_FRAME_DATA_GOP_TIMECODE: AVFrameSideDataType = 12;
pub const AV_FRAME_DATA_SPHERICAL: AVFrameSideDataType = 13;
pub const AV_FRAME_DATA_CONTENT_LIGHT_LEVEL: AVFrameSideDataType = 14;
pub const AV_FRAME_DATA_ICC_PROFILE: AVFrameSideDataType = 15;
pub const AV_FRAME_DATA_S12M_TIMECODE: AVFrameSideDataType = 16;
pub const AV_FRAME_DATA_DYNAMIC_HDR_PLUS: AVFrameSideDataType = 17;
pub const AV_FRAME_DATA_REGIONS_OF_INTEREST: AVFrameSideDataType = 18;
pub const AV_FRAME_DATA_VIDEO_ENC_PARAMS: AVFrameSideDataType = 19;
pub const AV_FRAME_DATA_SEI_UNREGISTERED: AVFrameSideDataType = 20;
pub const AV_FRAME_DATA_FILM_GRAIN_PARAMS: AVFrameSideDataType = 21;
pub const AV_FRAME_DATA_DETECTION_BBOXES: AVFrameSideDataType = 22;
pub const AV_FRAME_DATA_DOVI_RPU_BUFFER: AVFrameSideDataType = 23;
pub const AV_FRAME_DATA_DOVI_METADATA: AVFrameSideDataType = 24;
pub const AV_FRAME_DATA_DYNAMIC_HDR_VIVID: AVFrameSideDataType = 25;
pub const AV_FRAME_DATA_AMBIENT_VIEWING_ENVIRONMENT: AVFrameSideDataType = 26;
pub const AV_FRAME_DATA_VIDEO_HINT: AVFrameSideDataType = 27;
pub const AV_FRAME_DATA_LCEVC: AVFrameSideDataType = 28;
pub const AV_FRAME_DATA_VIEW_ID: AVFrameSideDataType = 29;
pub const AV_FRAME_DATA_3D_REFERENCE_DISPLAYS: AVFrameSideDataType = 30;
pub const AV_FRAME_DATA_EXIF: AVFrameSideDataType = 31;
pub const AV_FRAME_DATA_DYNAMIC_HDR_SMPTE_2094_APP5: AVFrameSideDataType = 32;
pub const AV_FRAME_DATA_IAMF_MIX_GAIN_PARAM: AVFrameSideDataType = 33;
pub const AV_FRAME_DATA_IAMF_DEMIXING_INFO_PARAM: AVFrameSideDataType = 34;
pub const AV_FRAME_DATA_IAMF_RECON_GAIN_INFO_PARAM: AVFrameSideDataType = 35;
pub const AV_FRAME_DATA_RAW_COLOR_PARAMS: AVFrameSideDataType = 36;
pub type AVFrameSideDataType = ::std::os::raw::c_int;
pub const AV_AFD_SAME: AVActiveFormatDescription = 8;
pub const AV_AFD_4_3: AVActiveFormatDescription = 9;
pub const AV_AFD_16_9: AVActiveFormatDescription = 10;
pub const AV_AFD_14_9: AVActiveFormatDescription = 11;
pub const AV_AFD_4_3_SP_14_9: AVActiveFormatDescription = 13;
pub const AV_AFD_16_9_SP_14_9: AVActiveFormatDescription = 14;
pub const AV_AFD_SP_4_3: AVActiveFormatDescription = 15;
pub type AVActiveFormatDescription = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFrameSideData {
    pub type_: AVFrameSideDataType,
    pub data: *mut u8,
    pub size: usize,
    pub metadata: *mut AVDictionary,
    pub buf: *mut AVBufferRef,
}
impl Default for AVFrameSideData {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_SIDE_DATA_PROP_GLOBAL: AVSideDataProps = 1;
pub const AV_SIDE_DATA_PROP_MULTI: AVSideDataProps = 2;
pub const AV_SIDE_DATA_PROP_SIZE_DEPENDENT: AVSideDataProps = 4;
pub const AV_SIDE_DATA_PROP_COLOR_DEPENDENT: AVSideDataProps = 8;
pub const AV_SIDE_DATA_PROP_CHANNEL_DEPENDENT: AVSideDataProps = 16;
pub type AVSideDataProps = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVSideDataDescriptor {
    pub name: *const ::std::os::raw::c_char,
    pub props: ::std::os::raw::c_uint,
}
impl Default for AVSideDataDescriptor {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVRegionOfInterest {
    pub self_size: u32,
    pub top: ::std::os::raw::c_int,
    pub bottom: ::std::os::raw::c_int,
    pub left: ::std::os::raw::c_int,
    pub right: ::std::os::raw::c_int,
    pub qoffset: AVRational,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFrame {
    pub data: [*mut u8; 8usize],
    pub linesize: [::std::os::raw::c_int; 8usize],
    pub extended_data: *mut *mut u8,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub nb_samples: ::std::os::raw::c_int,
    pub format: ::std::os::raw::c_int,
    pub pict_type: AVPictureType,
    pub sample_aspect_ratio: AVRational,
    pub pts: i64,
    pub pkt_dts: i64,
    pub time_base: AVRational,
    pub quality: ::std::os::raw::c_int,
    pub opaque: *mut ::std::os::raw::c_void,
    pub repeat_pict: ::std::os::raw::c_int,
    pub sample_rate: ::std::os::raw::c_int,
    pub buf: [*mut AVBufferRef; 8usize],
    pub extended_buf: *mut *mut AVBufferRef,
    pub nb_extended_buf: ::std::os::raw::c_int,
    pub side_data: *mut *mut AVFrameSideData,
    pub nb_side_data: ::std::os::raw::c_int,
    pub flags: ::std::os::raw::c_int,
    pub color_range: AVColorRange,
    pub color_primaries: AVColorPrimaries,
    pub color_trc: AVColorTransferCharacteristic,
    pub colorspace: AVColorSpace,
    pub chroma_location: AVChromaLocation,
    pub best_effort_timestamp: i64,
    pub metadata: *mut AVDictionary,
    pub decode_error_flags: ::std::os::raw::c_int,
    pub hw_frames_ctx: *mut AVBufferRef,
    pub opaque_ref: *mut AVBufferRef,
    pub crop_top: usize,
    pub crop_bottom: usize,
    pub crop_left: usize,
    pub crop_right: usize,
    pub private_ref: *mut ::std::os::raw::c_void,
    pub ch_layout: AVChannelLayout,
    pub duration: i64,
    pub alpha_mode: AVAlphaMode,
}
impl Default for AVFrame {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_FRAME_CROP_UNALIGNED: _bindgen_ty_1 = 1;
pub type _bindgen_ty_1 = ::std::os::raw::c_int;
pub const AV_HWDEVICE_TYPE_NONE: AVHWDeviceType = 0;
pub const AV_HWDEVICE_TYPE_VDPAU: AVHWDeviceType = 1;
pub const AV_HWDEVICE_TYPE_CUDA: AVHWDeviceType = 2;
pub const AV_HWDEVICE_TYPE_VAAPI: AVHWDeviceType = 3;
pub const AV_HWDEVICE_TYPE_DXVA2: AVHWDeviceType = 4;
pub const AV_HWDEVICE_TYPE_QSV: AVHWDeviceType = 5;
pub const AV_HWDEVICE_TYPE_VIDEOTOOLBOX: AVHWDeviceType = 6;
pub const AV_HWDEVICE_TYPE_D3D11VA: AVHWDeviceType = 7;
pub const AV_HWDEVICE_TYPE_DRM: AVHWDeviceType = 8;
pub const AV_HWDEVICE_TYPE_OPENCL: AVHWDeviceType = 9;
pub const AV_HWDEVICE_TYPE_MEDIACODEC: AVHWDeviceType = 10;
pub const AV_HWDEVICE_TYPE_VULKAN: AVHWDeviceType = 11;
pub const AV_HWDEVICE_TYPE_D3D12VA: AVHWDeviceType = 12;
pub const AV_HWDEVICE_TYPE_AMF: AVHWDeviceType = 13;
pub const AV_HWDEVICE_TYPE_OHCODEC: AVHWDeviceType = 14;
pub type AVHWDeviceType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVHWDeviceContext {
    pub av_class: *const AVClass,
    pub type_: AVHWDeviceType,
    pub hwctx: *mut ::std::os::raw::c_void,
    pub free: ::std::option::Option<unsafe extern "C" fn(ctx: *mut AVHWDeviceContext)>,
    pub user_opaque: *mut ::std::os::raw::c_void,
}
impl Default for AVHWDeviceContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVHWFramesContext {
    pub av_class: *const AVClass,
    pub device_ref: *mut AVBufferRef,
    pub device_ctx: *mut AVHWDeviceContext,
    pub hwctx: *mut ::std::os::raw::c_void,
    pub free: ::std::option::Option<unsafe extern "C" fn(ctx: *mut AVHWFramesContext)>,
    pub user_opaque: *mut ::std::os::raw::c_void,
    pub pool: *mut AVBufferPool,
    pub initial_pool_size: ::std::os::raw::c_int,
    pub format: AVPixelFormat,
    pub sw_format: AVPixelFormat,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
}
impl Default for AVHWFramesContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_HWFRAME_TRANSFER_DIRECTION_FROM: AVHWFrameTransferDirection = 0;
pub const AV_HWFRAME_TRANSFER_DIRECTION_TO: AVHWFrameTransferDirection = 1;
pub type AVHWFrameTransferDirection = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVHWFramesConstraints {
    pub valid_hw_formats: *mut AVPixelFormat,
    pub valid_sw_formats: *mut AVPixelFormat,
    pub min_width: ::std::os::raw::c_int,
    pub min_height: ::std::os::raw::c_int,
    pub max_width: ::std::os::raw::c_int,
    pub max_height: ::std::os::raw::c_int,
}
impl Default for AVHWFramesConstraints {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_HWFRAME_MAP_READ: _bindgen_ty_2 = 1;
pub const AV_HWFRAME_MAP_WRITE: _bindgen_ty_2 = 2;
pub const AV_HWFRAME_MAP_OVERWRITE: _bindgen_ty_2 = 4;
pub const AV_HWFRAME_MAP_DIRECT: _bindgen_ty_2 = 8;
pub type _bindgen_ty_2 = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVComponentDescriptor {
    pub plane: ::std::os::raw::c_int,
    pub step: ::std::os::raw::c_int,
    pub offset: ::std::os::raw::c_int,
    pub shift: ::std::os::raw::c_int,
    pub depth: ::std::os::raw::c_int,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVPixFmtDescriptor {
    pub name: *const ::std::os::raw::c_char,
    pub nb_components: u8,
    pub log2_chroma_w: u8,
    pub log2_chroma_h: u8,
    pub flags: u64,
    pub comp: [AVComponentDescriptor; 4usize],
    pub alias: *const ::std::os::raw::c_char,
}
impl Default for AVPixFmtDescriptor {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_OPT_TYPE_FLAGS: AVOptionType = 1;
pub const AV_OPT_TYPE_INT: AVOptionType = 2;
pub const AV_OPT_TYPE_INT64: AVOptionType = 3;
pub const AV_OPT_TYPE_DOUBLE: AVOptionType = 4;
pub const AV_OPT_TYPE_FLOAT: AVOptionType = 5;
pub const AV_OPT_TYPE_STRING: AVOptionType = 6;
pub const AV_OPT_TYPE_RATIONAL: AVOptionType = 7;
pub const AV_OPT_TYPE_BINARY: AVOptionType = 8;
pub const AV_OPT_TYPE_DICT: AVOptionType = 9;
pub const AV_OPT_TYPE_UINT64: AVOptionType = 10;
pub const AV_OPT_TYPE_CONST: AVOptionType = 11;
pub const AV_OPT_TYPE_IMAGE_SIZE: AVOptionType = 12;
pub const AV_OPT_TYPE_PIXEL_FMT: AVOptionType = 13;
pub const AV_OPT_TYPE_SAMPLE_FMT: AVOptionType = 14;
pub const AV_OPT_TYPE_VIDEO_RATE: AVOptionType = 15;
pub const AV_OPT_TYPE_DURATION: AVOptionType = 16;
pub const AV_OPT_TYPE_COLOR: AVOptionType = 17;
pub const AV_OPT_TYPE_BOOL: AVOptionType = 18;
pub const AV_OPT_TYPE_CHLAYOUT: AVOptionType = 19;
pub const AV_OPT_TYPE_UINT: AVOptionType = 20;
pub const AV_OPT_TYPE_FLAG_ARRAY: AVOptionType = 65536;
pub type AVOptionType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVOptionArrayDef {
    pub def: *const ::std::os::raw::c_char,
    pub size_min: ::std::os::raw::c_uint,
    pub size_max: ::std::os::raw::c_uint,
    pub sep: ::std::os::raw::c_char,
}
impl Default for AVOptionArrayDef {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVOption {
    pub name: *const ::std::os::raw::c_char,
    pub help: *const ::std::os::raw::c_char,
    pub offset: ::std::os::raw::c_int,
    pub type_: AVOptionType,
    pub default_val: AVOption__bindgen_ty_1,
    pub min: f64,
    pub max: f64,
    pub flags: ::std::os::raw::c_int,
    pub unit: *const ::std::os::raw::c_char,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub union AVOption__bindgen_ty_1 {
    pub i64_: i64,
    pub dbl: f64,
    pub str_: *const ::std::os::raw::c_char,
    pub q: AVRational,
    pub arr: *const AVOptionArrayDef,
}
impl Default for AVOption__bindgen_ty_1 {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
impl Default for AVOption {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVOptionRange {
    pub str_: *const ::std::os::raw::c_char,
    pub value_min: f64,
    pub value_max: f64,
    pub component_min: f64,
    pub component_max: f64,
    pub is_range: ::std::os::raw::c_int,
}
impl Default for AVOptionRange {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVOptionRanges {
    pub range: *mut *mut AVOptionRange,
    pub nb_ranges: ::std::os::raw::c_int,
    pub nb_components: ::std::os::raw::c_int,
}
impl Default for AVOptionRanges {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_OPT_FLAG_IMPLICIT_KEY: _bindgen_ty_3 = 1;
pub type _bindgen_ty_3 = ::std::os::raw::c_int;
pub const AV_CODEC_ID_NONE: AVCodecID = 0;
pub const AV_CODEC_ID_MPEG1VIDEO: AVCodecID = 1;
pub const AV_CODEC_ID_MPEG2VIDEO: AVCodecID = 2;
pub const AV_CODEC_ID_H261: AVCodecID = 3;
pub const AV_CODEC_ID_H263: AVCodecID = 4;
pub const AV_CODEC_ID_RV10: AVCodecID = 5;
pub const AV_CODEC_ID_RV20: AVCodecID = 6;
pub const AV_CODEC_ID_MJPEG: AVCodecID = 7;
pub const AV_CODEC_ID_MJPEGB: AVCodecID = 8;
pub const AV_CODEC_ID_LJPEG: AVCodecID = 9;
pub const AV_CODEC_ID_SP5X: AVCodecID = 10;
pub const AV_CODEC_ID_JPEGLS: AVCodecID = 11;
pub const AV_CODEC_ID_MPEG4: AVCodecID = 12;
pub const AV_CODEC_ID_RAWVIDEO: AVCodecID = 13;
pub const AV_CODEC_ID_MSMPEG4V1: AVCodecID = 14;
pub const AV_CODEC_ID_MSMPEG4V2: AVCodecID = 15;
pub const AV_CODEC_ID_MSMPEG4V3: AVCodecID = 16;
pub const AV_CODEC_ID_WMV1: AVCodecID = 17;
pub const AV_CODEC_ID_WMV2: AVCodecID = 18;
pub const AV_CODEC_ID_H263P: AVCodecID = 19;
pub const AV_CODEC_ID_H263I: AVCodecID = 20;
pub const AV_CODEC_ID_FLV1: AVCodecID = 21;
pub const AV_CODEC_ID_SVQ1: AVCodecID = 22;
pub const AV_CODEC_ID_SVQ3: AVCodecID = 23;
pub const AV_CODEC_ID_DVVIDEO: AVCodecID = 24;
pub const AV_CODEC_ID_HUFFYUV: AVCodecID = 25;
pub const AV_CODEC_ID_CYUV: AVCodecID = 26;
pub const AV_CODEC_ID_H264: AVCodecID = 27;
pub const AV_CODEC_ID_INDEO3: AVCodecID = 28;
pub const AV_CODEC_ID_VP3: AVCodecID = 29;
pub const AV_CODEC_ID_THEORA: AVCodecID = 30;
pub const AV_CODEC_ID_ASV1: AVCodecID = 31;
pub const AV_CODEC_ID_ASV2: AVCodecID = 32;
pub const AV_CODEC_ID_FFV1: AVCodecID = 33;
pub const AV_CODEC_ID_4XM: AVCodecID = 34;
pub const AV_CODEC_ID_VCR1: AVCodecID = 35;
pub const AV_CODEC_ID_CLJR: AVCodecID = 36;
pub const AV_CODEC_ID_MDEC: AVCodecID = 37;
pub const AV_CODEC_ID_ROQ: AVCodecID = 38;
pub const AV_CODEC_ID_INTERPLAY_VIDEO: AVCodecID = 39;
pub const AV_CODEC_ID_XAN_WC3: AVCodecID = 40;
pub const AV_CODEC_ID_XAN_WC4: AVCodecID = 41;
pub const AV_CODEC_ID_RPZA: AVCodecID = 42;
pub const AV_CODEC_ID_CINEPAK: AVCodecID = 43;
pub const AV_CODEC_ID_WS_VQA: AVCodecID = 44;
pub const AV_CODEC_ID_MSRLE: AVCodecID = 45;
pub const AV_CODEC_ID_MSVIDEO1: AVCodecID = 46;
pub const AV_CODEC_ID_IDCIN: AVCodecID = 47;
pub const AV_CODEC_ID_8BPS: AVCodecID = 48;
pub const AV_CODEC_ID_SMC: AVCodecID = 49;
pub const AV_CODEC_ID_FLIC: AVCodecID = 50;
pub const AV_CODEC_ID_TRUEMOTION1: AVCodecID = 51;
pub const AV_CODEC_ID_VMDVIDEO: AVCodecID = 52;
pub const AV_CODEC_ID_MSZH: AVCodecID = 53;
pub const AV_CODEC_ID_ZLIB: AVCodecID = 54;
pub const AV_CODEC_ID_QTRLE: AVCodecID = 55;
pub const AV_CODEC_ID_TSCC: AVCodecID = 56;
pub const AV_CODEC_ID_ULTI: AVCodecID = 57;
pub const AV_CODEC_ID_QDRAW: AVCodecID = 58;
pub const AV_CODEC_ID_VIXL: AVCodecID = 59;
pub const AV_CODEC_ID_QPEG: AVCodecID = 60;
pub const AV_CODEC_ID_PNG: AVCodecID = 61;
pub const AV_CODEC_ID_PPM: AVCodecID = 62;
pub const AV_CODEC_ID_PBM: AVCodecID = 63;
pub const AV_CODEC_ID_PGM: AVCodecID = 64;
pub const AV_CODEC_ID_PGMYUV: AVCodecID = 65;
pub const AV_CODEC_ID_PAM: AVCodecID = 66;
pub const AV_CODEC_ID_FFVHUFF: AVCodecID = 67;
pub const AV_CODEC_ID_RV30: AVCodecID = 68;
pub const AV_CODEC_ID_RV40: AVCodecID = 69;
pub const AV_CODEC_ID_VC1: AVCodecID = 70;
pub const AV_CODEC_ID_WMV3: AVCodecID = 71;
pub const AV_CODEC_ID_LOCO: AVCodecID = 72;
pub const AV_CODEC_ID_WNV1: AVCodecID = 73;
pub const AV_CODEC_ID_AASC: AVCodecID = 74;
pub const AV_CODEC_ID_INDEO2: AVCodecID = 75;
pub const AV_CODEC_ID_FRAPS: AVCodecID = 76;
pub const AV_CODEC_ID_TRUEMOTION2: AVCodecID = 77;
pub const AV_CODEC_ID_BMP: AVCodecID = 78;
pub const AV_CODEC_ID_CSCD: AVCodecID = 79;
pub const AV_CODEC_ID_MMVIDEO: AVCodecID = 80;
pub const AV_CODEC_ID_ZMBV: AVCodecID = 81;
pub const AV_CODEC_ID_AVS: AVCodecID = 82;
pub const AV_CODEC_ID_SMACKVIDEO: AVCodecID = 83;
pub const AV_CODEC_ID_NUV: AVCodecID = 84;
pub const AV_CODEC_ID_KMVC: AVCodecID = 85;
pub const AV_CODEC_ID_FLASHSV: AVCodecID = 86;
pub const AV_CODEC_ID_CAVS: AVCodecID = 87;
pub const AV_CODEC_ID_JPEG2000: AVCodecID = 88;
pub const AV_CODEC_ID_VMNC: AVCodecID = 89;
pub const AV_CODEC_ID_VP5: AVCodecID = 90;
pub const AV_CODEC_ID_VP6: AVCodecID = 91;
pub const AV_CODEC_ID_VP6F: AVCodecID = 92;
pub const AV_CODEC_ID_TARGA: AVCodecID = 93;
pub const AV_CODEC_ID_DSICINVIDEO: AVCodecID = 94;
pub const AV_CODEC_ID_TIERTEXSEQVIDEO: AVCodecID = 95;
pub const AV_CODEC_ID_TIFF: AVCodecID = 96;
pub const AV_CODEC_ID_GIF: AVCodecID = 97;
pub const AV_CODEC_ID_DXA: AVCodecID = 98;
pub const AV_CODEC_ID_DNXHD: AVCodecID = 99;
pub const AV_CODEC_ID_THP: AVCodecID = 100;
pub const AV_CODEC_ID_SGI: AVCodecID = 101;
pub const AV_CODEC_ID_C93: AVCodecID = 102;
pub const AV_CODEC_ID_BETHSOFTVID: AVCodecID = 103;
pub const AV_CODEC_ID_PTX: AVCodecID = 104;
pub const AV_CODEC_ID_TXD: AVCodecID = 105;
pub const AV_CODEC_ID_VP6A: AVCodecID = 106;
pub const AV_CODEC_ID_AMV: AVCodecID = 107;
pub const AV_CODEC_ID_VB: AVCodecID = 108;
pub const AV_CODEC_ID_PCX: AVCodecID = 109;
pub const AV_CODEC_ID_SUNRAST: AVCodecID = 110;
pub const AV_CODEC_ID_INDEO4: AVCodecID = 111;
pub const AV_CODEC_ID_INDEO5: AVCodecID = 112;
pub const AV_CODEC_ID_MIMIC: AVCodecID = 113;
pub const AV_CODEC_ID_RL2: AVCodecID = 114;
pub const AV_CODEC_ID_ESCAPE124: AVCodecID = 115;
pub const AV_CODEC_ID_DIRAC: AVCodecID = 116;
pub const AV_CODEC_ID_BFI: AVCodecID = 117;
pub const AV_CODEC_ID_CMV: AVCodecID = 118;
pub const AV_CODEC_ID_MOTIONPIXELS: AVCodecID = 119;
pub const AV_CODEC_ID_TGV: AVCodecID = 120;
pub const AV_CODEC_ID_TGQ: AVCodecID = 121;
pub const AV_CODEC_ID_TQI: AVCodecID = 122;
pub const AV_CODEC_ID_AURA: AVCodecID = 123;
pub const AV_CODEC_ID_AURA2: AVCodecID = 124;
pub const AV_CODEC_ID_V210X: AVCodecID = 125;
pub const AV_CODEC_ID_TMV: AVCodecID = 126;
pub const AV_CODEC_ID_V210: AVCodecID = 127;
pub const AV_CODEC_ID_DPX: AVCodecID = 128;
pub const AV_CODEC_ID_MAD: AVCodecID = 129;
pub const AV_CODEC_ID_FRWU: AVCodecID = 130;
pub const AV_CODEC_ID_FLASHSV2: AVCodecID = 131;
pub const AV_CODEC_ID_CDGRAPHICS: AVCodecID = 132;
pub const AV_CODEC_ID_R210: AVCodecID = 133;
pub const AV_CODEC_ID_ANM: AVCodecID = 134;
pub const AV_CODEC_ID_BINKVIDEO: AVCodecID = 135;
pub const AV_CODEC_ID_IFF_ILBM: AVCodecID = 136;
pub const AV_CODEC_ID_KGV1: AVCodecID = 137;
pub const AV_CODEC_ID_YOP: AVCodecID = 138;
pub const AV_CODEC_ID_VP8: AVCodecID = 139;
pub const AV_CODEC_ID_PICTOR: AVCodecID = 140;
pub const AV_CODEC_ID_ANSI: AVCodecID = 141;
pub const AV_CODEC_ID_A64_MULTI: AVCodecID = 142;
pub const AV_CODEC_ID_A64_MULTI5: AVCodecID = 143;
pub const AV_CODEC_ID_R10K: AVCodecID = 144;
pub const AV_CODEC_ID_MXPEG: AVCodecID = 145;
pub const AV_CODEC_ID_LAGARITH: AVCodecID = 146;
pub const AV_CODEC_ID_PRORES: AVCodecID = 147;
pub const AV_CODEC_ID_JV: AVCodecID = 148;
pub const AV_CODEC_ID_DFA: AVCodecID = 149;
pub const AV_CODEC_ID_WMV3IMAGE: AVCodecID = 150;
pub const AV_CODEC_ID_VC1IMAGE: AVCodecID = 151;
pub const AV_CODEC_ID_UTVIDEO: AVCodecID = 152;
pub const AV_CODEC_ID_BMV_VIDEO: AVCodecID = 153;
pub const AV_CODEC_ID_VBLE: AVCodecID = 154;
pub const AV_CODEC_ID_DXTORY: AVCodecID = 155;
pub const AV_CODEC_ID_XWD: AVCodecID = 156;
pub const AV_CODEC_ID_CDXL: AVCodecID = 157;
pub const AV_CODEC_ID_XBM: AVCodecID = 158;
pub const AV_CODEC_ID_ZEROCODEC: AVCodecID = 159;
pub const AV_CODEC_ID_MSS1: AVCodecID = 160;
pub const AV_CODEC_ID_MSA1: AVCodecID = 161;
pub const AV_CODEC_ID_TSCC2: AVCodecID = 162;
pub const AV_CODEC_ID_MTS2: AVCodecID = 163;
pub const AV_CODEC_ID_CLLC: AVCodecID = 164;
pub const AV_CODEC_ID_MSS2: AVCodecID = 165;
pub const AV_CODEC_ID_VP9: AVCodecID = 166;
pub const AV_CODEC_ID_AIC: AVCodecID = 167;
pub const AV_CODEC_ID_ESCAPE130: AVCodecID = 168;
pub const AV_CODEC_ID_G2M: AVCodecID = 169;
pub const AV_CODEC_ID_WEBP: AVCodecID = 170;
pub const AV_CODEC_ID_HNM4_VIDEO: AVCodecID = 171;
pub const AV_CODEC_ID_HEVC: AVCodecID = 172;
pub const AV_CODEC_ID_FIC: AVCodecID = 173;
pub const AV_CODEC_ID_ALIAS_PIX: AVCodecID = 174;
pub const AV_CODEC_ID_BRENDER_PIX: AVCodecID = 175;
pub const AV_CODEC_ID_PAF_VIDEO: AVCodecID = 176;
pub const AV_CODEC_ID_EXR: AVCodecID = 177;
pub const AV_CODEC_ID_VP7: AVCodecID = 178;
pub const AV_CODEC_ID_SANM: AVCodecID = 179;
pub const AV_CODEC_ID_SGIRLE: AVCodecID = 180;
pub const AV_CODEC_ID_MVC1: AVCodecID = 181;
pub const AV_CODEC_ID_MVC2: AVCodecID = 182;
pub const AV_CODEC_ID_HQX: AVCodecID = 183;
pub const AV_CODEC_ID_TDSC: AVCodecID = 184;
pub const AV_CODEC_ID_HQ_HQA: AVCodecID = 185;
pub const AV_CODEC_ID_HAP: AVCodecID = 186;
pub const AV_CODEC_ID_DDS: AVCodecID = 187;
pub const AV_CODEC_ID_DXV: AVCodecID = 188;
pub const AV_CODEC_ID_SCREENPRESSO: AVCodecID = 189;
pub const AV_CODEC_ID_RSCC: AVCodecID = 190;
pub const AV_CODEC_ID_AVS2: AVCodecID = 191;
pub const AV_CODEC_ID_PGX: AVCodecID = 192;
pub const AV_CODEC_ID_AVS3: AVCodecID = 193;
pub const AV_CODEC_ID_MSP2: AVCodecID = 194;
pub const AV_CODEC_ID_VVC: AVCodecID = 195;
pub const AV_CODEC_ID_Y41P: AVCodecID = 196;
pub const AV_CODEC_ID_AVRP: AVCodecID = 197;
pub const AV_CODEC_ID_012V: AVCodecID = 198;
pub const AV_CODEC_ID_AVUI: AVCodecID = 199;
pub const AV_CODEC_ID_TARGA_Y216: AVCodecID = 200;
pub const AV_CODEC_ID_YUV4: AVCodecID = 201;
pub const AV_CODEC_ID_AVRN: AVCodecID = 202;
pub const AV_CODEC_ID_CPIA: AVCodecID = 203;
pub const AV_CODEC_ID_XFACE: AVCodecID = 204;
pub const AV_CODEC_ID_SNOW: AVCodecID = 205;
pub const AV_CODEC_ID_SMVJPEG: AVCodecID = 206;
pub const AV_CODEC_ID_APNG: AVCodecID = 207;
pub const AV_CODEC_ID_DAALA: AVCodecID = 208;
pub const AV_CODEC_ID_CFHD: AVCodecID = 209;
pub const AV_CODEC_ID_TRUEMOTION2RT: AVCodecID = 210;
pub const AV_CODEC_ID_M101: AVCodecID = 211;
pub const AV_CODEC_ID_MAGICYUV: AVCodecID = 212;
pub const AV_CODEC_ID_SHEERVIDEO: AVCodecID = 213;
pub const AV_CODEC_ID_YLC: AVCodecID = 214;
pub const AV_CODEC_ID_PSD: AVCodecID = 215;
pub const AV_CODEC_ID_PIXLET: AVCodecID = 216;
pub const AV_CODEC_ID_SPEEDHQ: AVCodecID = 217;
pub const AV_CODEC_ID_FMVC: AVCodecID = 218;
pub const AV_CODEC_ID_SCPR: AVCodecID = 219;
pub const AV_CODEC_ID_CLEARVIDEO: AVCodecID = 220;
pub const AV_CODEC_ID_XPM: AVCodecID = 221;
pub const AV_CODEC_ID_AV1: AVCodecID = 222;
pub const AV_CODEC_ID_BITPACKED: AVCodecID = 223;
pub const AV_CODEC_ID_MSCC: AVCodecID = 224;
pub const AV_CODEC_ID_SRGC: AVCodecID = 225;
pub const AV_CODEC_ID_SVG: AVCodecID = 226;
pub const AV_CODEC_ID_GDV: AVCodecID = 227;
pub const AV_CODEC_ID_FITS: AVCodecID = 228;
pub const AV_CODEC_ID_IMM4: AVCodecID = 229;
pub const AV_CODEC_ID_PROSUMER: AVCodecID = 230;
pub const AV_CODEC_ID_MWSC: AVCodecID = 231;
pub const AV_CODEC_ID_WCMV: AVCodecID = 232;
pub const AV_CODEC_ID_RASC: AVCodecID = 233;
pub const AV_CODEC_ID_HYMT: AVCodecID = 234;
pub const AV_CODEC_ID_ARBC: AVCodecID = 235;
pub const AV_CODEC_ID_AGM: AVCodecID = 236;
pub const AV_CODEC_ID_LSCR: AVCodecID = 237;
pub const AV_CODEC_ID_VP4: AVCodecID = 238;
pub const AV_CODEC_ID_IMM5: AVCodecID = 239;
pub const AV_CODEC_ID_MVDV: AVCodecID = 240;
pub const AV_CODEC_ID_MVHA: AVCodecID = 241;
pub const AV_CODEC_ID_CDTOONS: AVCodecID = 242;
pub const AV_CODEC_ID_MV30: AVCodecID = 243;
pub const AV_CODEC_ID_NOTCHLC: AVCodecID = 244;
pub const AV_CODEC_ID_PFM: AVCodecID = 245;
pub const AV_CODEC_ID_MOBICLIP: AVCodecID = 246;
pub const AV_CODEC_ID_PHOTOCD: AVCodecID = 247;
pub const AV_CODEC_ID_IPU: AVCodecID = 248;
pub const AV_CODEC_ID_ARGO: AVCodecID = 249;
pub const AV_CODEC_ID_CRI: AVCodecID = 250;
pub const AV_CODEC_ID_SIMBIOSIS_IMX: AVCodecID = 251;
pub const AV_CODEC_ID_SGA_VIDEO: AVCodecID = 252;
pub const AV_CODEC_ID_GEM: AVCodecID = 253;
pub const AV_CODEC_ID_VBN: AVCodecID = 254;
pub const AV_CODEC_ID_JPEGXL: AVCodecID = 255;
pub const AV_CODEC_ID_QOI: AVCodecID = 256;
pub const AV_CODEC_ID_PHM: AVCodecID = 257;
pub const AV_CODEC_ID_RADIANCE_HDR: AVCodecID = 258;
pub const AV_CODEC_ID_WBMP: AVCodecID = 259;
pub const AV_CODEC_ID_MEDIA100: AVCodecID = 260;
pub const AV_CODEC_ID_VQC: AVCodecID = 261;
pub const AV_CODEC_ID_PDV: AVCodecID = 262;
pub const AV_CODEC_ID_EVC: AVCodecID = 263;
pub const AV_CODEC_ID_RTV1: AVCodecID = 264;
pub const AV_CODEC_ID_VMIX: AVCodecID = 265;
pub const AV_CODEC_ID_LEAD: AVCodecID = 266;
pub const AV_CODEC_ID_DNXUC: AVCodecID = 267;
pub const AV_CODEC_ID_RV60: AVCodecID = 268;
pub const AV_CODEC_ID_JPEGXL_ANIM: AVCodecID = 269;
pub const AV_CODEC_ID_APV: AVCodecID = 270;
pub const AV_CODEC_ID_PRORES_RAW: AVCodecID = 271;
pub const AV_CODEC_ID_JPEGXS: AVCodecID = 272;
pub const AV_CODEC_ID_WEBP_ANIM: AVCodecID = 273;
pub const AV_CODEC_ID_FIRST_AUDIO: AVCodecID = 65536;
pub const AV_CODEC_ID_PCM_S16LE: AVCodecID = 65536;
pub const AV_CODEC_ID_PCM_S16BE: AVCodecID = 65537;
pub const AV_CODEC_ID_PCM_U16LE: AVCodecID = 65538;
pub const AV_CODEC_ID_PCM_U16BE: AVCodecID = 65539;
pub const AV_CODEC_ID_PCM_S8: AVCodecID = 65540;
pub const AV_CODEC_ID_PCM_U8: AVCodecID = 65541;
pub const AV_CODEC_ID_PCM_MULAW: AVCodecID = 65542;
pub const AV_CODEC_ID_PCM_ALAW: AVCodecID = 65543;
pub const AV_CODEC_ID_PCM_S32LE: AVCodecID = 65544;
pub const AV_CODEC_ID_PCM_S32BE: AVCodecID = 65545;
pub const AV_CODEC_ID_PCM_U32LE: AVCodecID = 65546;
pub const AV_CODEC_ID_PCM_U32BE: AVCodecID = 65547;
pub const AV_CODEC_ID_PCM_S24LE: AVCodecID = 65548;
pub const AV_CODEC_ID_PCM_S24BE: AVCodecID = 65549;
pub const AV_CODEC_ID_PCM_U24LE: AVCodecID = 65550;
pub const AV_CODEC_ID_PCM_U24BE: AVCodecID = 65551;
pub const AV_CODEC_ID_PCM_S24DAUD: AVCodecID = 65552;
pub const AV_CODEC_ID_PCM_ZORK: AVCodecID = 65553;
pub const AV_CODEC_ID_PCM_S16LE_PLANAR: AVCodecID = 65554;
pub const AV_CODEC_ID_PCM_DVD: AVCodecID = 65555;
pub const AV_CODEC_ID_PCM_F32BE: AVCodecID = 65556;
pub const AV_CODEC_ID_PCM_F32LE: AVCodecID = 65557;
pub const AV_CODEC_ID_PCM_F64BE: AVCodecID = 65558;
pub const AV_CODEC_ID_PCM_F64LE: AVCodecID = 65559;
pub const AV_CODEC_ID_PCM_BLURAY: AVCodecID = 65560;
pub const AV_CODEC_ID_PCM_LXF: AVCodecID = 65561;
pub const AV_CODEC_ID_S302M: AVCodecID = 65562;
pub const AV_CODEC_ID_PCM_S8_PLANAR: AVCodecID = 65563;
pub const AV_CODEC_ID_PCM_S24LE_PLANAR: AVCodecID = 65564;
pub const AV_CODEC_ID_PCM_S32LE_PLANAR: AVCodecID = 65565;
pub const AV_CODEC_ID_PCM_S16BE_PLANAR: AVCodecID = 65566;
pub const AV_CODEC_ID_PCM_S64LE: AVCodecID = 65567;
pub const AV_CODEC_ID_PCM_S64BE: AVCodecID = 65568;
pub const AV_CODEC_ID_PCM_F16LE: AVCodecID = 65569;
pub const AV_CODEC_ID_PCM_F24LE: AVCodecID = 65570;
pub const AV_CODEC_ID_PCM_VIDC: AVCodecID = 65571;
pub const AV_CODEC_ID_PCM_SGA: AVCodecID = 65572;
pub const AV_CODEC_ID_ADPCM_IMA_QT: AVCodecID = 69632;
pub const AV_CODEC_ID_ADPCM_IMA_WAV: AVCodecID = 69633;
pub const AV_CODEC_ID_ADPCM_IMA_DK3: AVCodecID = 69634;
pub const AV_CODEC_ID_ADPCM_IMA_DK4: AVCodecID = 69635;
pub const AV_CODEC_ID_ADPCM_IMA_WS: AVCodecID = 69636;
pub const AV_CODEC_ID_ADPCM_IMA_SMJPEG: AVCodecID = 69637;
pub const AV_CODEC_ID_ADPCM_MS: AVCodecID = 69638;
pub const AV_CODEC_ID_ADPCM_4XM: AVCodecID = 69639;
pub const AV_CODEC_ID_ADPCM_XA: AVCodecID = 69640;
pub const AV_CODEC_ID_ADPCM_ADX: AVCodecID = 69641;
pub const AV_CODEC_ID_ADPCM_EA: AVCodecID = 69642;
pub const AV_CODEC_ID_ADPCM_G726: AVCodecID = 69643;
pub const AV_CODEC_ID_ADPCM_CT: AVCodecID = 69644;
pub const AV_CODEC_ID_ADPCM_SWF: AVCodecID = 69645;
pub const AV_CODEC_ID_ADPCM_YAMAHA: AVCodecID = 69646;
pub const AV_CODEC_ID_ADPCM_SBPRO_4: AVCodecID = 69647;
pub const AV_CODEC_ID_ADPCM_SBPRO_3: AVCodecID = 69648;
pub const AV_CODEC_ID_ADPCM_SBPRO_2: AVCodecID = 69649;
pub const AV_CODEC_ID_ADPCM_THP: AVCodecID = 69650;
pub const AV_CODEC_ID_ADPCM_IMA_AMV: AVCodecID = 69651;
pub const AV_CODEC_ID_ADPCM_EA_R1: AVCodecID = 69652;
pub const AV_CODEC_ID_ADPCM_EA_R3: AVCodecID = 69653;
pub const AV_CODEC_ID_ADPCM_EA_R2: AVCodecID = 69654;
pub const AV_CODEC_ID_ADPCM_IMA_EA_SEAD: AVCodecID = 69655;
pub const AV_CODEC_ID_ADPCM_IMA_EA_EACS: AVCodecID = 69656;
pub const AV_CODEC_ID_ADPCM_EA_XAS: AVCodecID = 69657;
pub const AV_CODEC_ID_ADPCM_EA_MAXIS_XA: AVCodecID = 69658;
pub const AV_CODEC_ID_ADPCM_IMA_ISS: AVCodecID = 69659;
pub const AV_CODEC_ID_ADPCM_G722: AVCodecID = 69660;
pub const AV_CODEC_ID_ADPCM_IMA_APC: AVCodecID = 69661;
pub const AV_CODEC_ID_ADPCM_VIMA: AVCodecID = 69662;
pub const AV_CODEC_ID_ADPCM_AFC: AVCodecID = 69663;
pub const AV_CODEC_ID_ADPCM_IMA_OKI: AVCodecID = 69664;
pub const AV_CODEC_ID_ADPCM_DTK: AVCodecID = 69665;
pub const AV_CODEC_ID_ADPCM_IMA_RAD: AVCodecID = 69666;
pub const AV_CODEC_ID_ADPCM_G726LE: AVCodecID = 69667;
pub const AV_CODEC_ID_ADPCM_THP_LE: AVCodecID = 69668;
pub const AV_CODEC_ID_ADPCM_PSX: AVCodecID = 69669;
pub const AV_CODEC_ID_ADPCM_AICA: AVCodecID = 69670;
pub const AV_CODEC_ID_ADPCM_IMA_DAT4: AVCodecID = 69671;
pub const AV_CODEC_ID_ADPCM_MTAF: AVCodecID = 69672;
pub const AV_CODEC_ID_ADPCM_AGM: AVCodecID = 69673;
pub const AV_CODEC_ID_ADPCM_ARGO: AVCodecID = 69674;
pub const AV_CODEC_ID_ADPCM_IMA_SSI: AVCodecID = 69675;
pub const AV_CODEC_ID_ADPCM_ZORK: AVCodecID = 69676;
pub const AV_CODEC_ID_ADPCM_IMA_APM: AVCodecID = 69677;
pub const AV_CODEC_ID_ADPCM_IMA_ALP: AVCodecID = 69678;
pub const AV_CODEC_ID_ADPCM_IMA_MTF: AVCodecID = 69679;
pub const AV_CODEC_ID_ADPCM_IMA_CUNNING: AVCodecID = 69680;
pub const AV_CODEC_ID_ADPCM_IMA_MOFLEX: AVCodecID = 69681;
pub const AV_CODEC_ID_ADPCM_IMA_ACORN: AVCodecID = 69682;
pub const AV_CODEC_ID_ADPCM_XMD: AVCodecID = 69683;
pub const AV_CODEC_ID_ADPCM_IMA_XBOX: AVCodecID = 69684;
pub const AV_CODEC_ID_ADPCM_SANYO: AVCodecID = 69685;
pub const AV_CODEC_ID_ADPCM_IMA_HVQM4: AVCodecID = 69686;
pub const AV_CODEC_ID_ADPCM_IMA_PDA: AVCodecID = 69687;
pub const AV_CODEC_ID_ADPCM_N64: AVCodecID = 69688;
pub const AV_CODEC_ID_ADPCM_IMA_HVQM2: AVCodecID = 69689;
pub const AV_CODEC_ID_ADPCM_IMA_MAGIX: AVCodecID = 69690;
pub const AV_CODEC_ID_ADPCM_PSXC: AVCodecID = 69691;
pub const AV_CODEC_ID_ADPCM_CIRCUS: AVCodecID = 69692;
pub const AV_CODEC_ID_ADPCM_IMA_ESCAPE: AVCodecID = 69693;
pub const AV_CODEC_ID_AMR_NB: AVCodecID = 73728;
pub const AV_CODEC_ID_AMR_WB: AVCodecID = 73729;
pub const AV_CODEC_ID_RA_144: AVCodecID = 77824;
pub const AV_CODEC_ID_RA_288: AVCodecID = 77825;
pub const AV_CODEC_ID_ROQ_DPCM: AVCodecID = 81920;
pub const AV_CODEC_ID_INTERPLAY_DPCM: AVCodecID = 81921;
pub const AV_CODEC_ID_XAN_DPCM: AVCodecID = 81922;
pub const AV_CODEC_ID_SOL_DPCM: AVCodecID = 81923;
pub const AV_CODEC_ID_SDX2_DPCM: AVCodecID = 81924;
pub const AV_CODEC_ID_GREMLIN_DPCM: AVCodecID = 81925;
pub const AV_CODEC_ID_DERF_DPCM: AVCodecID = 81926;
pub const AV_CODEC_ID_WADY_DPCM: AVCodecID = 81927;
pub const AV_CODEC_ID_CBD2_DPCM: AVCodecID = 81928;
pub const AV_CODEC_ID_MP2: AVCodecID = 86016;
pub const AV_CODEC_ID_MP3: AVCodecID = 86017;
pub const AV_CODEC_ID_AAC: AVCodecID = 86018;
pub const AV_CODEC_ID_AC3: AVCodecID = 86019;
pub const AV_CODEC_ID_DTS: AVCodecID = 86020;
pub const AV_CODEC_ID_VORBIS: AVCodecID = 86021;
pub const AV_CODEC_ID_DVAUDIO: AVCodecID = 86022;
pub const AV_CODEC_ID_WMAV1: AVCodecID = 86023;
pub const AV_CODEC_ID_WMAV2: AVCodecID = 86024;
pub const AV_CODEC_ID_MACE3: AVCodecID = 86025;
pub const AV_CODEC_ID_MACE6: AVCodecID = 86026;
pub const AV_CODEC_ID_VMDAUDIO: AVCodecID = 86027;
pub const AV_CODEC_ID_FLAC: AVCodecID = 86028;
pub const AV_CODEC_ID_MP3ADU: AVCodecID = 86029;
pub const AV_CODEC_ID_MP3ON4: AVCodecID = 86030;
pub const AV_CODEC_ID_SHORTEN: AVCodecID = 86031;
pub const AV_CODEC_ID_ALAC: AVCodecID = 86032;
pub const AV_CODEC_ID_WESTWOOD_SND1: AVCodecID = 86033;
pub const AV_CODEC_ID_GSM: AVCodecID = 86034;
pub const AV_CODEC_ID_QDM2: AVCodecID = 86035;
pub const AV_CODEC_ID_COOK: AVCodecID = 86036;
pub const AV_CODEC_ID_TRUESPEECH: AVCodecID = 86037;
pub const AV_CODEC_ID_TTA: AVCodecID = 86038;
pub const AV_CODEC_ID_SMACKAUDIO: AVCodecID = 86039;
pub const AV_CODEC_ID_QCELP: AVCodecID = 86040;
pub const AV_CODEC_ID_WAVPACK: AVCodecID = 86041;
pub const AV_CODEC_ID_DSICINAUDIO: AVCodecID = 86042;
pub const AV_CODEC_ID_IMC: AVCodecID = 86043;
pub const AV_CODEC_ID_MUSEPACK7: AVCodecID = 86044;
pub const AV_CODEC_ID_MLP: AVCodecID = 86045;
pub const AV_CODEC_ID_GSM_MS: AVCodecID = 86046;
pub const AV_CODEC_ID_ATRAC3: AVCodecID = 86047;
pub const AV_CODEC_ID_APE: AVCodecID = 86048;
pub const AV_CODEC_ID_NELLYMOSER: AVCodecID = 86049;
pub const AV_CODEC_ID_MUSEPACK8: AVCodecID = 86050;
pub const AV_CODEC_ID_SPEEX: AVCodecID = 86051;
pub const AV_CODEC_ID_WMAVOICE: AVCodecID = 86052;
pub const AV_CODEC_ID_WMAPRO: AVCodecID = 86053;
pub const AV_CODEC_ID_WMALOSSLESS: AVCodecID = 86054;
pub const AV_CODEC_ID_ATRAC3P: AVCodecID = 86055;
pub const AV_CODEC_ID_EAC3: AVCodecID = 86056;
pub const AV_CODEC_ID_SIPR: AVCodecID = 86057;
pub const AV_CODEC_ID_MP1: AVCodecID = 86058;
pub const AV_CODEC_ID_TWINVQ: AVCodecID = 86059;
pub const AV_CODEC_ID_TRUEHD: AVCodecID = 86060;
pub const AV_CODEC_ID_MP4ALS: AVCodecID = 86061;
pub const AV_CODEC_ID_ATRAC1: AVCodecID = 86062;
pub const AV_CODEC_ID_BINKAUDIO_RDFT: AVCodecID = 86063;
pub const AV_CODEC_ID_BINKAUDIO_DCT: AVCodecID = 86064;
pub const AV_CODEC_ID_AAC_LATM: AVCodecID = 86065;
pub const AV_CODEC_ID_QDMC: AVCodecID = 86066;
pub const AV_CODEC_ID_CELT: AVCodecID = 86067;
pub const AV_CODEC_ID_G723_1: AVCodecID = 86068;
pub const AV_CODEC_ID_G729: AVCodecID = 86069;
pub const AV_CODEC_ID_8SVX_EXP: AVCodecID = 86070;
pub const AV_CODEC_ID_8SVX_FIB: AVCodecID = 86071;
pub const AV_CODEC_ID_BMV_AUDIO: AVCodecID = 86072;
pub const AV_CODEC_ID_RALF: AVCodecID = 86073;
pub const AV_CODEC_ID_IAC: AVCodecID = 86074;
pub const AV_CODEC_ID_ILBC: AVCodecID = 86075;
pub const AV_CODEC_ID_OPUS: AVCodecID = 86076;
pub const AV_CODEC_ID_COMFORT_NOISE: AVCodecID = 86077;
pub const AV_CODEC_ID_TAK: AVCodecID = 86078;
pub const AV_CODEC_ID_METASOUND: AVCodecID = 86079;
pub const AV_CODEC_ID_PAF_AUDIO: AVCodecID = 86080;
pub const AV_CODEC_ID_ON2AVC: AVCodecID = 86081;
pub const AV_CODEC_ID_DSS_SP: AVCodecID = 86082;
pub const AV_CODEC_ID_CODEC2: AVCodecID = 86083;
pub const AV_CODEC_ID_FFWAVESYNTH: AVCodecID = 86084;
pub const AV_CODEC_ID_SONIC: AVCodecID = 86085;
pub const AV_CODEC_ID_SONIC_LS: AVCodecID = 86086;
pub const AV_CODEC_ID_EVRC: AVCodecID = 86087;
pub const AV_CODEC_ID_SMV: AVCodecID = 86088;
pub const AV_CODEC_ID_DSD_LSBF: AVCodecID = 86089;
pub const AV_CODEC_ID_DSD_MSBF: AVCodecID = 86090;
pub const AV_CODEC_ID_DSD_LSBF_PLANAR: AVCodecID = 86091;
pub const AV_CODEC_ID_DSD_MSBF_PLANAR: AVCodecID = 86092;
pub const AV_CODEC_ID_4GV: AVCodecID = 86093;
pub const AV_CODEC_ID_INTERPLAY_ACM: AVCodecID = 86094;
pub const AV_CODEC_ID_XMA1: AVCodecID = 86095;
pub const AV_CODEC_ID_XMA2: AVCodecID = 86096;
pub const AV_CODEC_ID_DST: AVCodecID = 86097;
pub const AV_CODEC_ID_ATRAC3AL: AVCodecID = 86098;
pub const AV_CODEC_ID_ATRAC3PAL: AVCodecID = 86099;
pub const AV_CODEC_ID_DOLBY_E: AVCodecID = 86100;
pub const AV_CODEC_ID_APTX: AVCodecID = 86101;
pub const AV_CODEC_ID_APTX_HD: AVCodecID = 86102;
pub const AV_CODEC_ID_SBC: AVCodecID = 86103;
pub const AV_CODEC_ID_ATRAC9: AVCodecID = 86104;
pub const AV_CODEC_ID_HCOM: AVCodecID = 86105;
pub const AV_CODEC_ID_ACELP_KELVIN: AVCodecID = 86106;
pub const AV_CODEC_ID_MPEGH_3D_AUDIO: AVCodecID = 86107;
pub const AV_CODEC_ID_SIREN: AVCodecID = 86108;
pub const AV_CODEC_ID_HCA: AVCodecID = 86109;
pub const AV_CODEC_ID_FASTAUDIO: AVCodecID = 86110;
pub const AV_CODEC_ID_MSNSIREN: AVCodecID = 86111;
pub const AV_CODEC_ID_DFPWM: AVCodecID = 86112;
pub const AV_CODEC_ID_BONK: AVCodecID = 86113;
pub const AV_CODEC_ID_MISC4: AVCodecID = 86114;
pub const AV_CODEC_ID_APAC: AVCodecID = 86115;
pub const AV_CODEC_ID_FTR: AVCodecID = 86116;
pub const AV_CODEC_ID_WAVARC: AVCodecID = 86117;
pub const AV_CODEC_ID_RKA: AVCodecID = 86118;
pub const AV_CODEC_ID_AC4: AVCodecID = 86119;
pub const AV_CODEC_ID_OSQ: AVCodecID = 86120;
pub const AV_CODEC_ID_QOA: AVCodecID = 86121;
pub const AV_CODEC_ID_LC3: AVCodecID = 86122;
pub const AV_CODEC_ID_G728: AVCodecID = 86123;
pub const AV_CODEC_ID_AHX: AVCodecID = 86124;
pub const AV_CODEC_ID_APPLE_APAC: AVCodecID = 86125;
pub const AV_CODEC_ID_FIRST_SUBTITLE: AVCodecID = 94208;
pub const AV_CODEC_ID_DVD_SUBTITLE: AVCodecID = 94208;
pub const AV_CODEC_ID_DVB_SUBTITLE: AVCodecID = 94209;
pub const AV_CODEC_ID_TEXT: AVCodecID = 94210;
pub const AV_CODEC_ID_XSUB: AVCodecID = 94211;
pub const AV_CODEC_ID_SSA: AVCodecID = 94212;
pub const AV_CODEC_ID_MOV_TEXT: AVCodecID = 94213;
pub const AV_CODEC_ID_HDMV_PGS_SUBTITLE: AVCodecID = 94214;
pub const AV_CODEC_ID_DVB_TELETEXT: AVCodecID = 94215;
pub const AV_CODEC_ID_SRT: AVCodecID = 94216;
pub const AV_CODEC_ID_MICRODVD: AVCodecID = 94217;
pub const AV_CODEC_ID_EIA_608: AVCodecID = 94218;
pub const AV_CODEC_ID_JACOSUB: AVCodecID = 94219;
pub const AV_CODEC_ID_SAMI: AVCodecID = 94220;
pub const AV_CODEC_ID_REALTEXT: AVCodecID = 94221;
pub const AV_CODEC_ID_STL: AVCodecID = 94222;
pub const AV_CODEC_ID_SUBVIEWER1: AVCodecID = 94223;
pub const AV_CODEC_ID_SUBVIEWER: AVCodecID = 94224;
pub const AV_CODEC_ID_SUBRIP: AVCodecID = 94225;
pub const AV_CODEC_ID_WEBVTT: AVCodecID = 94226;
pub const AV_CODEC_ID_MPL2: AVCodecID = 94227;
pub const AV_CODEC_ID_VPLAYER: AVCodecID = 94228;
pub const AV_CODEC_ID_PJS: AVCodecID = 94229;
pub const AV_CODEC_ID_ASS: AVCodecID = 94230;
pub const AV_CODEC_ID_HDMV_TEXT_SUBTITLE: AVCodecID = 94231;
pub const AV_CODEC_ID_TTML: AVCodecID = 94232;
pub const AV_CODEC_ID_ARIB_CAPTION: AVCodecID = 94233;
pub const AV_CODEC_ID_IVTV_VBI: AVCodecID = 94234;
pub const AV_CODEC_ID_FIRST_UNKNOWN: AVCodecID = 98304;
pub const AV_CODEC_ID_TTF: AVCodecID = 98304;
pub const AV_CODEC_ID_SCTE_35: AVCodecID = 98305;
pub const AV_CODEC_ID_EPG: AVCodecID = 98306;
pub const AV_CODEC_ID_BINTEXT: AVCodecID = 98307;
pub const AV_CODEC_ID_XBIN: AVCodecID = 98308;
pub const AV_CODEC_ID_IDF: AVCodecID = 98309;
pub const AV_CODEC_ID_OTF: AVCodecID = 98310;
pub const AV_CODEC_ID_SMPTE_KLV: AVCodecID = 98311;
pub const AV_CODEC_ID_DVD_NAV: AVCodecID = 98312;
pub const AV_CODEC_ID_TIMED_ID3: AVCodecID = 98313;
pub const AV_CODEC_ID_BIN_DATA: AVCodecID = 98314;
pub const AV_CODEC_ID_SMPTE_2038: AVCodecID = 98315;
pub const AV_CODEC_ID_LCEVC: AVCodecID = 98316;
pub const AV_CODEC_ID_SMPTE_436M_ANC: AVCodecID = 98317;
pub const AV_CODEC_ID_PROBE: AVCodecID = 102400;
pub const AV_CODEC_ID_MPEG2TS: AVCodecID = 131072;
pub const AV_CODEC_ID_MPEG4SYSTEMS: AVCodecID = 131073;
pub const AV_CODEC_ID_FFMETADATA: AVCodecID = 135168;
pub const AV_CODEC_ID_WRAPPED_AVFRAME: AVCodecID = 135169;
pub const AV_CODEC_ID_VNULL: AVCodecID = 135170;
pub const AV_CODEC_ID_ANULL: AVCodecID = 135171;
pub type AVCodecID = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVProfile {
    pub profile: ::std::os::raw::c_int,
    pub name: *const ::std::os::raw::c_char,
}
impl Default for AVProfile {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodec {
    pub name: *const ::std::os::raw::c_char,
    pub long_name: *const ::std::os::raw::c_char,
    pub type_: AVMediaType,
    pub id: AVCodecID,
    pub capabilities: ::std::os::raw::c_int,
    pub max_lowres: u8,
    pub priv_class: *const AVClass,
    pub profiles: *const AVProfile,
    pub wrapper_name: *const ::std::os::raw::c_char,
}
impl Default for AVCodec {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX: _bindgen_ty_4 = 1;
pub const AV_CODEC_HW_CONFIG_METHOD_HW_FRAMES_CTX: _bindgen_ty_4 = 2;
pub const AV_CODEC_HW_CONFIG_METHOD_INTERNAL: _bindgen_ty_4 = 4;
pub const AV_CODEC_HW_CONFIG_METHOD_AD_HOC: _bindgen_ty_4 = 8;
pub type _bindgen_ty_4 = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecHWConfig {
    pub pix_fmt: AVPixelFormat,
    pub methods: ::std::os::raw::c_int,
    pub device_type: AVHWDeviceType,
}
impl Default for AVCodecHWConfig {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_FIELD_UNKNOWN: AVFieldOrder = 0;
pub const AV_FIELD_PROGRESSIVE: AVFieldOrder = 1;
pub const AV_FIELD_TT: AVFieldOrder = 2;
pub const AV_FIELD_BB: AVFieldOrder = 3;
pub const AV_FIELD_TB: AVFieldOrder = 4;
pub const AV_FIELD_BT: AVFieldOrder = 5;
pub type AVFieldOrder = ::std::os::raw::c_int;
pub const AVDISCARD_NONE: AVDiscard = -16;
pub const AVDISCARD_DEFAULT: AVDiscard = 0;
pub const AVDISCARD_NONREF: AVDiscard = 8;
pub const AVDISCARD_BIDIR: AVDiscard = 16;
pub const AVDISCARD_NONINTRA: AVDiscard = 24;
pub const AVDISCARD_NONKEY: AVDiscard = 32;
pub const AVDISCARD_ALL: AVDiscard = 48;
pub type AVDiscard = ::std::os::raw::c_int;
pub const AV_AUDIO_SERVICE_TYPE_MAIN: AVAudioServiceType = 0;
pub const AV_AUDIO_SERVICE_TYPE_EFFECTS: AVAudioServiceType = 1;
pub const AV_AUDIO_SERVICE_TYPE_VISUALLY_IMPAIRED: AVAudioServiceType = 2;
pub const AV_AUDIO_SERVICE_TYPE_HEARING_IMPAIRED: AVAudioServiceType = 3;
pub const AV_AUDIO_SERVICE_TYPE_DIALOGUE: AVAudioServiceType = 4;
pub const AV_AUDIO_SERVICE_TYPE_COMMENTARY: AVAudioServiceType = 5;
pub const AV_AUDIO_SERVICE_TYPE_EMERGENCY: AVAudioServiceType = 6;
pub const AV_AUDIO_SERVICE_TYPE_VOICE_OVER: AVAudioServiceType = 7;
pub const AV_AUDIO_SERVICE_TYPE_KARAOKE: AVAudioServiceType = 8;
pub const AV_AUDIO_SERVICE_TYPE_NB: AVAudioServiceType = 9;
pub type AVAudioServiceType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVPanScan {
    pub id: ::std::os::raw::c_int,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub position: [[i16; 2usize]; 3usize],
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVCPBProperties {
    pub max_bitrate: i64,
    pub min_bitrate: i64,
    pub avg_bitrate: i64,
    pub buffer_size: i64,
    pub vbv_delay: u64,
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVProducerReferenceTime {
    pub wallclock: i64,
    pub flags: ::std::os::raw::c_int,
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVRTCPSenderReport {
    pub ssrc: u32,
    pub ntp_timestamp: u64,
    pub rtp_timestamp: u32,
    pub sender_nb_packets: u32,
    pub sender_nb_bytes: u32,
}
pub const AV_PKT_DATA_PALETTE: AVPacketSideDataType = 0;
pub const AV_PKT_DATA_NEW_EXTRADATA: AVPacketSideDataType = 1;
pub const AV_PKT_DATA_PARAM_CHANGE: AVPacketSideDataType = 2;
pub const AV_PKT_DATA_H263_MB_INFO: AVPacketSideDataType = 3;
pub const AV_PKT_DATA_REPLAYGAIN: AVPacketSideDataType = 4;
pub const AV_PKT_DATA_DISPLAYMATRIX: AVPacketSideDataType = 5;
pub const AV_PKT_DATA_STEREO3D: AVPacketSideDataType = 6;
pub const AV_PKT_DATA_AUDIO_SERVICE_TYPE: AVPacketSideDataType = 7;
pub const AV_PKT_DATA_QUALITY_STATS: AVPacketSideDataType = 8;
pub const AV_PKT_DATA_FALLBACK_TRACK: AVPacketSideDataType = 9;
pub const AV_PKT_DATA_CPB_PROPERTIES: AVPacketSideDataType = 10;
pub const AV_PKT_DATA_SKIP_SAMPLES: AVPacketSideDataType = 11;
pub const AV_PKT_DATA_JP_DUALMONO: AVPacketSideDataType = 12;
pub const AV_PKT_DATA_STRINGS_METADATA: AVPacketSideDataType = 13;
pub const AV_PKT_DATA_SUBTITLE_POSITION: AVPacketSideDataType = 14;
pub const AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL: AVPacketSideDataType = 15;
pub const AV_PKT_DATA_WEBVTT_IDENTIFIER: AVPacketSideDataType = 16;
pub const AV_PKT_DATA_WEBVTT_SETTINGS: AVPacketSideDataType = 17;
pub const AV_PKT_DATA_METADATA_UPDATE: AVPacketSideDataType = 18;
pub const AV_PKT_DATA_MPEGTS_STREAM_ID: AVPacketSideDataType = 19;
pub const AV_PKT_DATA_MASTERING_DISPLAY_METADATA: AVPacketSideDataType = 20;
pub const AV_PKT_DATA_SPHERICAL: AVPacketSideDataType = 21;
pub const AV_PKT_DATA_CONTENT_LIGHT_LEVEL: AVPacketSideDataType = 22;
pub const AV_PKT_DATA_A53_CC: AVPacketSideDataType = 23;
pub const AV_PKT_DATA_ENCRYPTION_INIT_INFO: AVPacketSideDataType = 24;
pub const AV_PKT_DATA_ENCRYPTION_INFO: AVPacketSideDataType = 25;
pub const AV_PKT_DATA_AFD: AVPacketSideDataType = 26;
pub const AV_PKT_DATA_PRFT: AVPacketSideDataType = 27;
pub const AV_PKT_DATA_ICC_PROFILE: AVPacketSideDataType = 28;
pub const AV_PKT_DATA_DOVI_CONF: AVPacketSideDataType = 29;
pub const AV_PKT_DATA_S12M_TIMECODE: AVPacketSideDataType = 30;
pub const AV_PKT_DATA_DYNAMIC_HDR10_PLUS: AVPacketSideDataType = 31;
pub const AV_PKT_DATA_IAMF_MIX_GAIN_PARAM: AVPacketSideDataType = 32;
pub const AV_PKT_DATA_IAMF_DEMIXING_INFO_PARAM: AVPacketSideDataType = 33;
pub const AV_PKT_DATA_IAMF_RECON_GAIN_INFO_PARAM: AVPacketSideDataType = 34;
pub const AV_PKT_DATA_AMBIENT_VIEWING_ENVIRONMENT: AVPacketSideDataType = 35;
pub const AV_PKT_DATA_FRAME_CROPPING: AVPacketSideDataType = 36;
pub const AV_PKT_DATA_LCEVC: AVPacketSideDataType = 37;
pub const AV_PKT_DATA_3D_REFERENCE_DISPLAYS: AVPacketSideDataType = 38;
pub const AV_PKT_DATA_RTCP_SR: AVPacketSideDataType = 39;
pub const AV_PKT_DATA_EXIF: AVPacketSideDataType = 40;
pub const AV_PKT_DATA_DYNAMIC_HDR_SMPTE_2094_APP5: AVPacketSideDataType = 41;
pub const AV_PKT_DATA_HEVC_CONF: AVPacketSideDataType = 42;
pub const AV_PKT_DATA_NB: AVPacketSideDataType = 43;
pub type AVPacketSideDataType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVPacketSideData {
    pub data: *mut u8,
    pub size: usize,
    pub type_: AVPacketSideDataType,
}
impl Default for AVPacketSideData {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVPacket {
    pub buf: *mut AVBufferRef,
    pub pts: i64,
    pub dts: i64,
    pub data: *mut u8,
    pub size: ::std::os::raw::c_int,
    pub stream_index: ::std::os::raw::c_int,
    pub flags: ::std::os::raw::c_int,
    pub side_data: *mut AVPacketSideData,
    pub side_data_elems: ::std::os::raw::c_int,
    pub duration: i64,
    pub pos: i64,
    pub opaque: *mut ::std::os::raw::c_void,
    pub opaque_ref: *mut AVBufferRef,
    pub time_base: AVRational,
}
impl Default for AVPacket {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_SIDE_DATA_PARAM_CHANGE_SAMPLE_RATE: AVSideDataParamChangeFlags = 4;
pub const AV_SIDE_DATA_PARAM_CHANGE_DIMENSIONS: AVSideDataParamChangeFlags = 8;
pub type AVSideDataParamChangeFlags = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVContainerFifo {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecDescriptor {
    pub id: AVCodecID,
    pub type_: AVMediaType,
    pub name: *const ::std::os::raw::c_char,
    pub long_name: *const ::std::os::raw::c_char,
    pub props: ::std::os::raw::c_int,
    pub mime_types: *const *const ::std::os::raw::c_char,
    pub profiles: *const AVProfile,
}
impl Default for AVCodecDescriptor {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecParameters {
    pub codec_type: AVMediaType,
    pub codec_id: AVCodecID,
    pub codec_tag: u32,
    pub extradata: *mut u8,
    pub extradata_size: ::std::os::raw::c_int,
    pub coded_side_data: *mut AVPacketSideData,
    pub nb_coded_side_data: ::std::os::raw::c_int,
    pub format: ::std::os::raw::c_int,
    pub bit_rate: i64,
    pub bits_per_coded_sample: ::std::os::raw::c_int,
    pub bits_per_raw_sample: ::std::os::raw::c_int,
    pub profile: ::std::os::raw::c_int,
    pub level: ::std::os::raw::c_int,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub sample_aspect_ratio: AVRational,
    pub framerate: AVRational,
    pub field_order: AVFieldOrder,
    pub color_range: AVColorRange,
    pub color_primaries: AVColorPrimaries,
    pub color_trc: AVColorTransferCharacteristic,
    pub color_space: AVColorSpace,
    pub chroma_location: AVChromaLocation,
    pub video_delay: ::std::os::raw::c_int,
    pub ch_layout: AVChannelLayout,
    pub sample_rate: ::std::os::raw::c_int,
    pub block_align: ::std::os::raw::c_int,
    pub frame_size: ::std::os::raw::c_int,
    pub initial_padding: ::std::os::raw::c_int,
    pub trailing_padding: ::std::os::raw::c_int,
    pub seek_preroll: ::std::os::raw::c_int,
    pub alpha_mode: AVAlphaMode,
}
impl Default for AVCodecParameters {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct RcOverride {
    pub start_frame: ::std::os::raw::c_int,
    pub end_frame: ::std::os::raw::c_int,
    pub qscale: ::std::os::raw::c_int,
    pub quality_factor: f32,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecContext {
    pub av_class: *const AVClass,
    pub log_level_offset: ::std::os::raw::c_int,
    pub codec_type: AVMediaType,
    pub codec: *const AVCodec,
    pub codec_id: AVCodecID,
    pub codec_tag: ::std::os::raw::c_uint,
    pub priv_data: *mut ::std::os::raw::c_void,
    pub internal: *mut AVCodecInternal,
    pub opaque: *mut ::std::os::raw::c_void,
    pub bit_rate: i64,
    pub flags: ::std::os::raw::c_int,
    pub flags2: ::std::os::raw::c_int,
    pub extradata: *mut u8,
    pub extradata_size: ::std::os::raw::c_int,
    pub time_base: AVRational,
    pub pkt_timebase: AVRational,
    pub framerate: AVRational,
    pub delay: ::std::os::raw::c_int,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub coded_width: ::std::os::raw::c_int,
    pub coded_height: ::std::os::raw::c_int,
    pub sample_aspect_ratio: AVRational,
    pub pix_fmt: AVPixelFormat,
    pub sw_pix_fmt: AVPixelFormat,
    pub color_primaries: AVColorPrimaries,
    pub color_trc: AVColorTransferCharacteristic,
    pub colorspace: AVColorSpace,
    pub color_range: AVColorRange,
    pub chroma_sample_location: AVChromaLocation,
    pub field_order: AVFieldOrder,
    pub refs: ::std::os::raw::c_int,
    pub has_b_frames: ::std::os::raw::c_int,
    pub slice_flags: ::std::os::raw::c_int,
    pub draw_horiz_band: ::std::option::Option<
        unsafe extern "C" fn(
            s: *mut AVCodecContext,
            src: *const AVFrame,
            offset: *mut ::std::os::raw::c_int,
            y: ::std::os::raw::c_int,
            type_: ::std::os::raw::c_int,
            height: ::std::os::raw::c_int,
        ),
    >,
    pub get_format: ::std::option::Option<
        unsafe extern "C" fn(s: *mut AVCodecContext, fmt: *const AVPixelFormat) -> AVPixelFormat,
    >,
    pub max_b_frames: ::std::os::raw::c_int,
    pub b_quant_factor: f32,
    pub b_quant_offset: f32,
    pub i_quant_factor: f32,
    pub i_quant_offset: f32,
    pub lumi_masking: f32,
    pub temporal_cplx_masking: f32,
    pub spatial_cplx_masking: f32,
    pub p_masking: f32,
    pub dark_masking: f32,
    pub nsse_weight: ::std::os::raw::c_int,
    pub me_cmp: ::std::os::raw::c_int,
    pub me_sub_cmp: ::std::os::raw::c_int,
    pub mb_cmp: ::std::os::raw::c_int,
    pub ildct_cmp: ::std::os::raw::c_int,
    pub dia_size: ::std::os::raw::c_int,
    pub last_predictor_count: ::std::os::raw::c_int,
    pub me_pre_cmp: ::std::os::raw::c_int,
    pub pre_dia_size: ::std::os::raw::c_int,
    pub me_subpel_quality: ::std::os::raw::c_int,
    pub me_range: ::std::os::raw::c_int,
    pub mb_decision: ::std::os::raw::c_int,
    pub intra_matrix: *mut u16,
    pub inter_matrix: *mut u16,
    pub chroma_intra_matrix: *mut u16,
    pub intra_dc_precision: ::std::os::raw::c_int,
    pub mb_lmin: ::std::os::raw::c_int,
    pub mb_lmax: ::std::os::raw::c_int,
    pub bidir_refine: ::std::os::raw::c_int,
    pub keyint_min: ::std::os::raw::c_int,
    pub gop_size: ::std::os::raw::c_int,
    pub mv0_threshold: ::std::os::raw::c_int,
    pub slices: ::std::os::raw::c_int,
    pub sample_rate: ::std::os::raw::c_int,
    pub sample_fmt: AVSampleFormat,
    pub ch_layout: AVChannelLayout,
    pub frame_size: ::std::os::raw::c_int,
    pub block_align: ::std::os::raw::c_int,
    pub cutoff: ::std::os::raw::c_int,
    pub audio_service_type: AVAudioServiceType,
    pub request_sample_fmt: AVSampleFormat,
    pub initial_padding: ::std::os::raw::c_int,
    pub trailing_padding: ::std::os::raw::c_int,
    pub seek_preroll: ::std::os::raw::c_int,
    pub get_buffer2: ::std::option::Option<
        unsafe extern "C" fn(
            s: *mut AVCodecContext,
            frame: *mut AVFrame,
            flags: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub bit_rate_tolerance: ::std::os::raw::c_int,
    pub global_quality: ::std::os::raw::c_int,
    pub compression_level: ::std::os::raw::c_int,
    pub qcompress: f32,
    pub qblur: f32,
    pub qmin: ::std::os::raw::c_int,
    pub qmax: ::std::os::raw::c_int,
    pub max_qdiff: ::std::os::raw::c_int,
    pub rc_buffer_size: ::std::os::raw::c_int,
    pub rc_override_count: ::std::os::raw::c_int,
    pub rc_override: *mut RcOverride,
    pub rc_max_rate: i64,
    pub rc_min_rate: i64,
    pub rc_max_available_vbv_use: f32,
    pub rc_min_vbv_overflow_use: f32,
    pub rc_initial_buffer_occupancy: ::std::os::raw::c_int,
    pub trellis: ::std::os::raw::c_int,
    pub stats_out: *mut ::std::os::raw::c_char,
    pub stats_in: *mut ::std::os::raw::c_char,
    pub workaround_bugs: ::std::os::raw::c_int,
    pub strict_std_compliance: ::std::os::raw::c_int,
    pub error_concealment: ::std::os::raw::c_int,
    pub debug: ::std::os::raw::c_int,
    pub err_recognition: ::std::os::raw::c_int,
    pub hwaccel: *const AVHWAccel,
    pub hwaccel_context: *mut ::std::os::raw::c_void,
    pub hw_frames_ctx: *mut AVBufferRef,
    pub hw_device_ctx: *mut AVBufferRef,
    pub hwaccel_flags: ::std::os::raw::c_int,
    pub extra_hw_frames: ::std::os::raw::c_int,
    pub error: [u64; 8usize],
    pub dct_algo: ::std::os::raw::c_int,
    pub idct_algo: ::std::os::raw::c_int,
    pub bits_per_coded_sample: ::std::os::raw::c_int,
    pub bits_per_raw_sample: ::std::os::raw::c_int,
    pub thread_count: ::std::os::raw::c_int,
    pub thread_type: ::std::os::raw::c_int,
    pub active_thread_type: ::std::os::raw::c_int,
    pub execute: ::std::option::Option<
        unsafe extern "C" fn(
            c: *mut AVCodecContext,
            func: ::std::option::Option<
                unsafe extern "C" fn(
                    c2: *mut AVCodecContext,
                    arg: *mut ::std::os::raw::c_void,
                ) -> ::std::os::raw::c_int,
            >,
            arg2: *mut ::std::os::raw::c_void,
            ret: *mut ::std::os::raw::c_int,
            count: ::std::os::raw::c_int,
            size: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub execute2: ::std::option::Option<
        unsafe extern "C" fn(
            c: *mut AVCodecContext,
            func: ::std::option::Option<
                unsafe extern "C" fn(
                    c2: *mut AVCodecContext,
                    arg: *mut ::std::os::raw::c_void,
                    jobnr: ::std::os::raw::c_int,
                    threadnr: ::std::os::raw::c_int,
                ) -> ::std::os::raw::c_int,
            >,
            arg2: *mut ::std::os::raw::c_void,
            ret: *mut ::std::os::raw::c_int,
            count: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub profile: ::std::os::raw::c_int,
    pub level: ::std::os::raw::c_int,
    pub skip_loop_filter: AVDiscard,
    pub skip_idct: AVDiscard,
    pub skip_frame: AVDiscard,
    pub skip_alpha: ::std::os::raw::c_int,
    pub skip_top: ::std::os::raw::c_int,
    pub skip_bottom: ::std::os::raw::c_int,
    pub lowres: ::std::os::raw::c_int,
    pub codec_descriptor: *const AVCodecDescriptor,
    pub sub_charenc: *mut ::std::os::raw::c_char,
    pub sub_charenc_mode: ::std::os::raw::c_int,
    pub subtitle_header_size: ::std::os::raw::c_int,
    pub subtitle_header: *mut u8,
    pub dump_separator: *mut u8,
    pub codec_whitelist: *mut ::std::os::raw::c_char,
    pub coded_side_data: *mut AVPacketSideData,
    pub nb_coded_side_data: ::std::os::raw::c_int,
    pub export_side_data: ::std::os::raw::c_int,
    pub max_pixels: i64,
    pub apply_cropping: ::std::os::raw::c_int,
    pub discard_damaged_percentage: ::std::os::raw::c_int,
    pub max_samples: i64,
    pub get_encode_buffer: ::std::option::Option<
        unsafe extern "C" fn(
            s: *mut AVCodecContext,
            pkt: *mut AVPacket,
            flags: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub frame_num: i64,
    pub side_data_prefer_packet: *mut ::std::os::raw::c_int,
    pub nb_side_data_prefer_packet: ::std::os::raw::c_uint,
    pub decoded_side_data: *mut *mut AVFrameSideData,
    pub nb_decoded_side_data: ::std::os::raw::c_int,
    pub alpha_mode: AVAlphaMode,
}
impl Default for AVCodecContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVHWAccel {
    pub name: *const ::std::os::raw::c_char,
    pub type_: AVMediaType,
    pub id: AVCodecID,
    pub pix_fmt: AVPixelFormat,
    pub capabilities: ::std::os::raw::c_int,
}
impl Default for AVHWAccel {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const SUBTITLE_NONE: AVSubtitleType = 0;
pub const SUBTITLE_BITMAP: AVSubtitleType = 1;
pub const SUBTITLE_TEXT: AVSubtitleType = 2;
pub const SUBTITLE_ASS: AVSubtitleType = 3;
pub type AVSubtitleType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVSubtitleRect {
    pub x: ::std::os::raw::c_int,
    pub y: ::std::os::raw::c_int,
    pub w: ::std::os::raw::c_int,
    pub h: ::std::os::raw::c_int,
    pub nb_colors: ::std::os::raw::c_int,
    pub data: [*mut u8; 4usize],
    pub linesize: [::std::os::raw::c_int; 4usize],
    pub flags: ::std::os::raw::c_int,
    pub type_: AVSubtitleType,
    pub text: *mut ::std::os::raw::c_char,
    pub ass: *mut ::std::os::raw::c_char,
}
impl Default for AVSubtitleRect {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVSubtitle {
    pub format: u16,
    pub start_display_time: u32,
    pub end_display_time: u32,
    pub num_rects: ::std::os::raw::c_uint,
    pub rects: *mut *mut AVSubtitleRect,
    pub pts: i64,
}
impl Default for AVSubtitle {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_CODEC_CONFIG_PIX_FORMAT: AVCodecConfig = 0;
pub const AV_CODEC_CONFIG_FRAME_RATE: AVCodecConfig = 1;
pub const AV_CODEC_CONFIG_SAMPLE_RATE: AVCodecConfig = 2;
pub const AV_CODEC_CONFIG_SAMPLE_FORMAT: AVCodecConfig = 3;
pub const AV_CODEC_CONFIG_CHANNEL_LAYOUT: AVCodecConfig = 4;
pub const AV_CODEC_CONFIG_COLOR_RANGE: AVCodecConfig = 5;
pub const AV_CODEC_CONFIG_COLOR_SPACE: AVCodecConfig = 6;
pub const AV_CODEC_CONFIG_ALPHA_MODE: AVCodecConfig = 7;
pub type AVCodecConfig = ::std::os::raw::c_int;
pub const AV_PICTURE_STRUCTURE_UNKNOWN: AVPictureStructure = 0;
pub const AV_PICTURE_STRUCTURE_TOP_FIELD: AVPictureStructure = 1;
pub const AV_PICTURE_STRUCTURE_BOTTOM_FIELD: AVPictureStructure = 2;
pub const AV_PICTURE_STRUCTURE_FRAME: AVPictureStructure = 3;
pub type AVPictureStructure = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecParserContext {
    pub priv_data: *mut ::std::os::raw::c_void,
    pub parser: *const AVCodecParser,
    pub frame_offset: i64,
    pub cur_offset: i64,
    pub next_frame_offset: i64,
    pub pict_type: ::std::os::raw::c_int,
    pub repeat_pict: ::std::os::raw::c_int,
    pub pts: i64,
    pub dts: i64,
    pub last_pts: i64,
    pub last_dts: i64,
    pub fetch_timestamp: ::std::os::raw::c_int,
    pub cur_frame_start_index: ::std::os::raw::c_int,
    pub cur_frame_offset: [i64; 4usize],
    pub cur_frame_pts: [i64; 4usize],
    pub cur_frame_dts: [i64; 4usize],
    pub flags: ::std::os::raw::c_int,
    pub offset: i64,
    pub cur_frame_end: [i64; 4usize],
    pub key_frame: ::std::os::raw::c_int,
    pub dts_sync_point: ::std::os::raw::c_int,
    pub dts_ref_dts_delta: ::std::os::raw::c_int,
    pub pts_dts_delta: ::std::os::raw::c_int,
    pub cur_frame_pos: [i64; 4usize],
    pub pos: i64,
    pub last_pos: i64,
    pub duration: ::std::os::raw::c_int,
    pub field_order: AVFieldOrder,
    pub picture_structure: AVPictureStructure,
    pub output_picture_number: ::std::os::raw::c_int,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub coded_width: ::std::os::raw::c_int,
    pub coded_height: ::std::os::raw::c_int,
    pub format: ::std::os::raw::c_int,
}
impl Default for AVCodecParserContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecParser {
    pub codec_ids: [AVCodecID; 7usize],
}
impl Default for AVCodecParser {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVIOInterruptCB {
    pub callback: ::std::option::Option<
        unsafe extern "C" fn(arg1: *mut ::std::os::raw::c_void) -> ::std::os::raw::c_int,
    >,
    pub opaque: *mut ::std::os::raw::c_void,
}
impl Default for AVIOInterruptCB {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AVIO_ENTRY_UNKNOWN: AVIODirEntryType = 0;
pub const AVIO_ENTRY_BLOCK_DEVICE: AVIODirEntryType = 1;
pub const AVIO_ENTRY_CHARACTER_DEVICE: AVIODirEntryType = 2;
pub const AVIO_ENTRY_DIRECTORY: AVIODirEntryType = 3;
pub const AVIO_ENTRY_NAMED_PIPE: AVIODirEntryType = 4;
pub const AVIO_ENTRY_SYMBOLIC_LINK: AVIODirEntryType = 5;
pub const AVIO_ENTRY_SOCKET: AVIODirEntryType = 6;
pub const AVIO_ENTRY_FILE: AVIODirEntryType = 7;
pub const AVIO_ENTRY_SERVER: AVIODirEntryType = 8;
pub const AVIO_ENTRY_SHARE: AVIODirEntryType = 9;
pub const AVIO_ENTRY_WORKGROUP: AVIODirEntryType = 10;
pub type AVIODirEntryType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVIODirEntry {
    pub name: *mut ::std::os::raw::c_char,
    pub type_: ::std::os::raw::c_int,
    pub utf8: ::std::os::raw::c_int,
    pub size: i64,
    pub modification_timestamp: i64,
    pub access_timestamp: i64,
    pub status_change_timestamp: i64,
    pub user_id: i64,
    pub group_id: i64,
    pub filemode: i64,
}
impl Default for AVIODirEntry {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVIODirContext {
    _unused: [u8; 0],
}
pub const AVIO_DATA_MARKER_HEADER: AVIODataMarkerType = 0;
pub const AVIO_DATA_MARKER_SYNC_POINT: AVIODataMarkerType = 1;
pub const AVIO_DATA_MARKER_BOUNDARY_POINT: AVIODataMarkerType = 2;
pub const AVIO_DATA_MARKER_UNKNOWN: AVIODataMarkerType = 3;
pub const AVIO_DATA_MARKER_TRAILER: AVIODataMarkerType = 4;
pub const AVIO_DATA_MARKER_FLUSH_POINT: AVIODataMarkerType = 5;
pub type AVIODataMarkerType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVIOContext {
    pub av_class: *const AVClass,
    pub buffer: *mut ::std::os::raw::c_uchar,
    pub buffer_size: ::std::os::raw::c_int,
    pub buf_ptr: *mut ::std::os::raw::c_uchar,
    pub buf_end: *mut ::std::os::raw::c_uchar,
    pub opaque: *mut ::std::os::raw::c_void,
    pub read_packet: ::std::option::Option<
        unsafe extern "C" fn(
            opaque: *mut ::std::os::raw::c_void,
            buf: *mut u8,
            buf_size: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub write_packet: ::std::option::Option<
        unsafe extern "C" fn(
            opaque: *mut ::std::os::raw::c_void,
            buf: *const u8,
            buf_size: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub seek: ::std::option::Option<
        unsafe extern "C" fn(
            opaque: *mut ::std::os::raw::c_void,
            offset: i64,
            whence: ::std::os::raw::c_int,
        ) -> i64,
    >,
    pub pos: i64,
    pub eof_reached: ::std::os::raw::c_int,
    pub error: ::std::os::raw::c_int,
    pub write_flag: ::std::os::raw::c_int,
    pub max_packet_size: ::std::os::raw::c_int,
    pub min_packet_size: ::std::os::raw::c_int,
    pub checksum: ::std::os::raw::c_ulong,
    pub checksum_ptr: *mut ::std::os::raw::c_uchar,
    pub update_checksum: ::std::option::Option<
        unsafe extern "C" fn(
            checksum: ::std::os::raw::c_ulong,
            buf: *const u8,
            size: ::std::os::raw::c_uint,
        ) -> ::std::os::raw::c_ulong,
    >,
    pub read_pause: ::std::option::Option<
        unsafe extern "C" fn(
            opaque: *mut ::std::os::raw::c_void,
            pause: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int,
    >,
    pub read_seek: ::std::option::Option<
        unsafe extern "C" fn(
            opaque: *mut ::std::os::raw::c_void,
            stream_index: ::std::os::raw::c_int,
            timestamp: i64,
            flags: ::std::os::raw::c_int,
        ) -> i64,
    >,
    pub seekable: ::std::os::raw::c_int,
    pub direct: ::std::os::raw::c_int,
    pub protocol_whitelist: *const ::std::os::raw::c_char,
    pub protocol_blacklist: *const ::std::os::raw::c_char,
    pub write_data_type: ::std::option::Option<
        unsafe extern "C" fn(
            opaque: *mut ::std::os::raw::c_void,
            buf: *const u8,
            buf_size: ::std::os::raw::c_int,
            type_: AVIODataMarkerType,
            time: i64,
        ) -> ::std::os::raw::c_int,
    >,
    pub ignore_boundary_point: ::std::os::raw::c_int,
    pub buf_ptr_max: *mut ::std::os::raw::c_uchar,
    pub bytes_read: i64,
    pub bytes_written: i64,
}
impl Default for AVIOContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVCodecTag {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVProbeData {
    pub filename: *const ::std::os::raw::c_char,
    pub buf: *mut ::std::os::raw::c_uchar,
    pub buf_size: ::std::os::raw::c_int,
    pub mime_type: *const ::std::os::raw::c_char,
}
impl Default for AVProbeData {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVOutputFormat {
    pub name: *const ::std::os::raw::c_char,
    pub long_name: *const ::std::os::raw::c_char,
    pub mime_type: *const ::std::os::raw::c_char,
    pub extensions: *const ::std::os::raw::c_char,
    pub audio_codec: AVCodecID,
    pub video_codec: AVCodecID,
    pub subtitle_codec: AVCodecID,
    pub flags: ::std::os::raw::c_int,
    pub codec_tag: *const *const AVCodecTag,
    pub priv_class: *const AVClass,
}
impl Default for AVOutputFormat {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVInputFormat {
    pub name: *const ::std::os::raw::c_char,
    pub long_name: *const ::std::os::raw::c_char,
    pub flags: ::std::os::raw::c_int,
    pub extensions: *const ::std::os::raw::c_char,
    pub codec_tag: *const *const AVCodecTag,
    pub priv_class: *const AVClass,
    pub mime_type: *const ::std::os::raw::c_char,
}
impl Default for AVInputFormat {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AVSTREAM_PARSE_NONE: AVStreamParseType = 0;
pub const AVSTREAM_PARSE_FULL: AVStreamParseType = 1;
pub const AVSTREAM_PARSE_HEADERS: AVStreamParseType = 2;
pub const AVSTREAM_PARSE_TIMESTAMPS: AVStreamParseType = 3;
pub const AVSTREAM_PARSE_FULL_ONCE: AVStreamParseType = 4;
pub const AVSTREAM_PARSE_FULL_RAW: AVStreamParseType = 5;
pub type AVStreamParseType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVIndexEntry {
    pub pos: i64,
    pub timestamp: i64,
    pub _bitfield_align_1: [u32; 0],
    pub _bitfield_1: __BindgenBitfieldUnit<[u8; 4usize]>,
    pub min_distance: ::std::os::raw::c_int,
}
impl AVIndexEntry {
    #[inline]
    pub fn flags(&self) -> ::std::os::raw::c_int {
        unsafe { ::std::mem::transmute(self._bitfield_1.get(0usize, 2u8) as u32) }
    }
    #[inline]
    pub fn set_flags(&mut self, val: ::std::os::raw::c_int) {
        unsafe {
            let val: u32 = ::std::mem::transmute(val);
            self._bitfield_1.set(0usize, 2u8, val as u64)
        }
    }
    #[inline]
    pub unsafe fn flags_raw(this: *const Self) -> ::std::os::raw::c_int {
        unsafe {
            ::std::mem::transmute(<__BindgenBitfieldUnit<[u8; 4usize]>>::raw_get(
                ::std::ptr::addr_of!((*this)._bitfield_1),
                0usize,
                2u8,
            ) as u32)
        }
    }
    #[inline]
    pub unsafe fn set_flags_raw(this: *mut Self, val: ::std::os::raw::c_int) {
        unsafe {
            let val: u32 = ::std::mem::transmute(val);
            <__BindgenBitfieldUnit<[u8; 4usize]>>::raw_set(
                ::std::ptr::addr_of_mut!((*this)._bitfield_1),
                0usize,
                2u8,
                val as u64,
            )
        }
    }
    #[inline]
    pub fn size(&self) -> ::std::os::raw::c_int {
        unsafe { ::std::mem::transmute(self._bitfield_1.get(2usize, 30u8) as u32) }
    }
    #[inline]
    pub fn set_size(&mut self, val: ::std::os::raw::c_int) {
        unsafe {
            let val: u32 = ::std::mem::transmute(val);
            self._bitfield_1.set(2usize, 30u8, val as u64)
        }
    }
    #[inline]
    pub unsafe fn size_raw(this: *const Self) -> ::std::os::raw::c_int {
        unsafe {
            ::std::mem::transmute(<__BindgenBitfieldUnit<[u8; 4usize]>>::raw_get(
                ::std::ptr::addr_of!((*this)._bitfield_1),
                2usize,
                30u8,
            ) as u32)
        }
    }
    #[inline]
    pub unsafe fn set_size_raw(this: *mut Self, val: ::std::os::raw::c_int) {
        unsafe {
            let val: u32 = ::std::mem::transmute(val);
            <__BindgenBitfieldUnit<[u8; 4usize]>>::raw_set(
                ::std::ptr::addr_of_mut!((*this)._bitfield_1),
                2usize,
                30u8,
                val as u64,
            )
        }
    }
    #[inline]
    pub fn new_bitfield_1(
        flags: ::std::os::raw::c_int,
        size: ::std::os::raw::c_int,
    ) -> __BindgenBitfieldUnit<[u8; 4usize]> {
        let mut __bindgen_bitfield_unit: __BindgenBitfieldUnit<[u8; 4usize]> = Default::default();
        __bindgen_bitfield_unit.set(0usize, 2u8, {
            let flags: u32 = unsafe { ::std::mem::transmute(flags) };
            flags as u64
        });
        __bindgen_bitfield_unit.set(2usize, 30u8, {
            let size: u32 = unsafe { ::std::mem::transmute(size) };
            size as u64
        });
        __bindgen_bitfield_unit
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVStream {
    pub av_class: *const AVClass,
    pub index: ::std::os::raw::c_int,
    pub id: ::std::os::raw::c_int,
    pub codecpar: *mut AVCodecParameters,
    pub priv_data: *mut ::std::os::raw::c_void,
    pub time_base: AVRational,
    pub start_time: i64,
    pub duration: i64,
    pub nb_frames: i64,
    pub disposition: ::std::os::raw::c_int,
    pub discard: AVDiscard,
    pub sample_aspect_ratio: AVRational,
    pub metadata: *mut AVDictionary,
    pub avg_frame_rate: AVRational,
    pub attached_pic: AVPacket,
    pub event_flags: ::std::os::raw::c_int,
    pub r_frame_rate: AVRational,
    pub pts_wrap_bits: ::std::os::raw::c_int,
}
impl Default for AVStream {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVStreamGroupTileGrid {
    pub av_class: *const AVClass,
    pub nb_tiles: ::std::os::raw::c_uint,
    pub coded_width: ::std::os::raw::c_int,
    pub coded_height: ::std::os::raw::c_int,
    pub offsets: *mut AVStreamGroupTileGrid__bindgen_ty_1,
    pub background: [u8; 4usize],
    pub horizontal_offset: ::std::os::raw::c_int,
    pub vertical_offset: ::std::os::raw::c_int,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub coded_side_data: *mut AVPacketSideData,
    pub nb_coded_side_data: ::std::os::raw::c_int,
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVStreamGroupTileGrid__bindgen_ty_1 {
    pub idx: ::std::os::raw::c_uint,
    pub horizontal: ::std::os::raw::c_int,
    pub vertical: ::std::os::raw::c_int,
}
impl Default for AVStreamGroupTileGrid {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVStreamGroupLayeredVideo {
    pub av_class: *const AVClass,
    pub __bindgen_anon_1: AVStreamGroupLayeredVideo__bindgen_ty_1,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub union AVStreamGroupLayeredVideo__bindgen_ty_1 {
    pub el_index: ::std::os::raw::c_uint,
    pub lcevc_index: ::std::os::raw::c_uint,
}
impl Default for AVStreamGroupLayeredVideo__bindgen_ty_1 {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
impl Default for AVStreamGroupLayeredVideo {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVStreamGroupTREF {
    pub av_class: *const AVClass,
    pub metadata_index: ::std::os::raw::c_uint,
}
impl Default for AVStreamGroupTREF {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_STREAM_GROUP_PARAMS_NONE: AVStreamGroupParamsType = 0;
pub const AV_STREAM_GROUP_PARAMS_IAMF_AUDIO_ELEMENT: AVStreamGroupParamsType = 1;
pub const AV_STREAM_GROUP_PARAMS_IAMF_MIX_PRESENTATION: AVStreamGroupParamsType = 2;
pub const AV_STREAM_GROUP_PARAMS_TILE_GRID: AVStreamGroupParamsType = 3;
pub const AV_STREAM_GROUP_PARAMS_LCEVC: AVStreamGroupParamsType = 4;
pub const AV_STREAM_GROUP_PARAMS_TREF: AVStreamGroupParamsType = 5;
pub const AV_STREAM_GROUP_PARAMS_DOLBY_VISION: AVStreamGroupParamsType = 6;
pub type AVStreamGroupParamsType = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVIAMFAudioElement {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVIAMFMixPresentation {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVStreamGroup {
    pub av_class: *const AVClass,
    pub priv_data: *mut ::std::os::raw::c_void,
    pub index: ::std::os::raw::c_uint,
    pub id: i64,
    pub type_: AVStreamGroupParamsType,
    pub params: AVStreamGroup__bindgen_ty_1,
    pub metadata: *mut AVDictionary,
    pub nb_streams: ::std::os::raw::c_uint,
    pub streams: *mut *mut AVStream,
    pub disposition: ::std::os::raw::c_int,
}
#[repr(C)]
#[derive(Copy, Clone)]
pub union AVStreamGroup__bindgen_ty_1 {
    pub iamf_audio_element: *mut AVIAMFAudioElement,
    pub iamf_mix_presentation: *mut AVIAMFMixPresentation,
    pub tile_grid: *mut AVStreamGroupTileGrid,
    pub layered_video: *mut AVStreamGroupLayeredVideo,
    pub lcevc: *mut AVStreamGroupLayeredVideo,
    pub tref: *mut AVStreamGroupTREF,
}
impl Default for AVStreamGroup__bindgen_ty_1 {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
impl Default for AVStreamGroup {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVProgram {
    pub id: ::std::os::raw::c_int,
    pub flags: ::std::os::raw::c_int,
    pub discard: AVDiscard,
    pub stream_index: *mut ::std::os::raw::c_uint,
    pub nb_stream_indexes: ::std::os::raw::c_uint,
    pub metadata: *mut AVDictionary,
    pub program_num: ::std::os::raw::c_int,
    pub pmt_pid: ::std::os::raw::c_int,
    pub pcr_pid: ::std::os::raw::c_int,
    pub pmt_version: ::std::os::raw::c_int,
    pub start_time: i64,
    pub end_time: i64,
    pub pts_wrap_reference: i64,
    pub pts_wrap_behavior: ::std::os::raw::c_int,
}
impl Default for AVProgram {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVChapter {
    pub id: i64,
    pub time_base: AVRational,
    pub start: i64,
    pub end: i64,
    pub metadata: *mut AVDictionary,
}
impl Default for AVChapter {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub type av_format_control_message = ::std::option::Option<
    unsafe extern "C" fn(
        s: *mut AVFormatContext,
        type_: ::std::os::raw::c_int,
        data: *mut ::std::os::raw::c_void,
        data_size: usize,
    ) -> ::std::os::raw::c_int,
>;
pub type AVOpenCallback = ::std::option::Option<
    unsafe extern "C" fn(
        s: *mut AVFormatContext,
        pb: *mut *mut AVIOContext,
        url: *const ::std::os::raw::c_char,
        flags: ::std::os::raw::c_int,
        int_cb: *const AVIOInterruptCB,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int,
>;
pub const AVFMT_DURATION_FROM_PTS: AVDurationEstimationMethod = 0;
pub const AVFMT_DURATION_FROM_STREAM: AVDurationEstimationMethod = 1;
pub const AVFMT_DURATION_FROM_BITRATE: AVDurationEstimationMethod = 2;
pub type AVDurationEstimationMethod = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFormatContext {
    pub av_class: *const AVClass,
    pub iformat: *const AVInputFormat,
    pub oformat: *const AVOutputFormat,
    pub priv_data: *mut ::std::os::raw::c_void,
    pub pb: *mut AVIOContext,
    pub ctx_flags: ::std::os::raw::c_int,
    pub nb_streams: ::std::os::raw::c_uint,
    pub streams: *mut *mut AVStream,
    pub nb_stream_groups: ::std::os::raw::c_uint,
    pub stream_groups: *mut *mut AVStreamGroup,
    pub nb_chapters: ::std::os::raw::c_uint,
    pub chapters: *mut *mut AVChapter,
    pub url: *mut ::std::os::raw::c_char,
    pub start_time: i64,
    pub duration: i64,
    pub bit_rate: i64,
    pub packet_size: ::std::os::raw::c_uint,
    pub max_delay: ::std::os::raw::c_int,
    pub flags: ::std::os::raw::c_int,
    pub probesize: i64,
    pub max_analyze_duration: i64,
    pub key: *const u8,
    pub keylen: ::std::os::raw::c_int,
    pub nb_programs: ::std::os::raw::c_uint,
    pub programs: *mut *mut AVProgram,
    pub video_codec_id: AVCodecID,
    pub audio_codec_id: AVCodecID,
    pub subtitle_codec_id: AVCodecID,
    pub data_codec_id: AVCodecID,
    pub metadata: *mut AVDictionary,
    pub start_time_realtime: i64,
    pub fps_probe_size: ::std::os::raw::c_int,
    pub error_recognition: ::std::os::raw::c_int,
    pub interrupt_callback: AVIOInterruptCB,
    pub debug: ::std::os::raw::c_int,
    pub max_streams: ::std::os::raw::c_int,
    pub max_index_size: ::std::os::raw::c_uint,
    pub max_picture_buffer: ::std::os::raw::c_uint,
    pub max_interleave_delta: i64,
    pub max_ts_probe: ::std::os::raw::c_int,
    pub max_chunk_duration: ::std::os::raw::c_int,
    pub max_chunk_size: ::std::os::raw::c_int,
    pub max_probe_packets: ::std::os::raw::c_int,
    pub strict_std_compliance: ::std::os::raw::c_int,
    pub event_flags: ::std::os::raw::c_int,
    pub avoid_negative_ts: ::std::os::raw::c_int,
    pub audio_preload: ::std::os::raw::c_int,
    pub use_wallclock_as_timestamps: ::std::os::raw::c_int,
    pub skip_estimate_duration_from_pts: ::std::os::raw::c_int,
    pub avio_flags: ::std::os::raw::c_int,
    pub duration_estimation_method: AVDurationEstimationMethod,
    pub skip_initial_bytes: i64,
    pub correct_ts_overflow: ::std::os::raw::c_uint,
    pub seek2any: ::std::os::raw::c_int,
    pub flush_packets: ::std::os::raw::c_int,
    pub probe_score: ::std::os::raw::c_int,
    pub format_probesize: ::std::os::raw::c_int,
    pub codec_whitelist: *mut ::std::os::raw::c_char,
    pub format_whitelist: *mut ::std::os::raw::c_char,
    pub protocol_whitelist: *mut ::std::os::raw::c_char,
    pub protocol_blacklist: *mut ::std::os::raw::c_char,
    pub io_repositioned: ::std::os::raw::c_int,
    pub video_codec: *const AVCodec,
    pub audio_codec: *const AVCodec,
    pub subtitle_codec: *const AVCodec,
    pub data_codec: *const AVCodec,
    pub metadata_header_padding: ::std::os::raw::c_int,
    pub opaque: *mut ::std::os::raw::c_void,
    pub control_message_cb: av_format_control_message,
    pub output_ts_offset: i64,
    pub dump_separator: *mut u8,
    pub io_open: ::std::option::Option<
        unsafe extern "C" fn(
            s: *mut AVFormatContext,
            pb: *mut *mut AVIOContext,
            url: *const ::std::os::raw::c_char,
            flags: ::std::os::raw::c_int,
            options: *mut *mut AVDictionary,
        ) -> ::std::os::raw::c_int,
    >,
    pub io_close2: ::std::option::Option<
        unsafe extern "C" fn(
            s: *mut AVFormatContext,
            pb: *mut AVIOContext,
        ) -> ::std::os::raw::c_int,
    >,
    pub duration_probesize: i64,
    pub name: *mut ::std::os::raw::c_char,
}
impl Default for AVFormatContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AVFORMAT_COMMAND_RTSP_SET_PARAMETER: AVFormatCommandID = 0;
pub type AVFormatCommandID = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVRTSPCommandRequest {
    pub headers: *mut AVDictionary,
    pub body_len: usize,
    pub body: *mut ::std::os::raw::c_char,
}
impl Default for AVRTSPCommandRequest {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVRTSPResponse {
    pub status_code: ::std::os::raw::c_int,
    pub reason: *mut ::std::os::raw::c_char,
    pub body_len: usize,
    pub body: *mut ::std::os::raw::c_uchar,
}
impl Default for AVRTSPResponse {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterPad {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterFormats {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterChannelLayouts {
    _unused: [u8; 0],
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterFormatsConfig {
    pub formats: *mut AVFilterFormats,
    pub samplerates: *mut AVFilterFormats,
    pub channel_layouts: *mut AVFilterChannelLayouts,
    pub color_spaces: *mut AVFilterFormats,
    pub color_ranges: *mut AVFilterFormats,
    pub alpha_modes: *mut AVFilterFormats,
}
impl Default for AVFilterFormatsConfig {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilter {
    pub name: *const ::std::os::raw::c_char,
    pub description: *const ::std::os::raw::c_char,
    pub inputs: *const AVFilterPad,
    pub outputs: *const AVFilterPad,
    pub priv_class: *const AVClass,
    pub flags: ::std::os::raw::c_int,
}
impl Default for AVFilter {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterContext {
    pub av_class: *const AVClass,
    pub filter: *const AVFilter,
    pub name: *mut ::std::os::raw::c_char,
    pub input_pads: *mut AVFilterPad,
    pub inputs: *mut *mut AVFilterLink,
    pub nb_inputs: ::std::os::raw::c_uint,
    pub output_pads: *mut AVFilterPad,
    pub outputs: *mut *mut AVFilterLink,
    pub nb_outputs: ::std::os::raw::c_uint,
    pub priv_: *mut ::std::os::raw::c_void,
    pub graph: *mut AVFilterGraph,
    pub thread_type: ::std::os::raw::c_int,
    pub nb_threads: ::std::os::raw::c_int,
    pub enable_str: *mut ::std::os::raw::c_char,
    pub is_disabled: ::std::os::raw::c_int,
    pub hw_device_ctx: *mut AVBufferRef,
    pub extra_hw_frames: ::std::os::raw::c_int,
}
impl Default for AVFilterContext {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterLink {
    pub src: *mut AVFilterContext,
    pub srcpad: *mut AVFilterPad,
    pub dst: *mut AVFilterContext,
    pub dstpad: *mut AVFilterPad,
    pub type_: AVMediaType,
    pub format: ::std::os::raw::c_int,
    pub w: ::std::os::raw::c_int,
    pub h: ::std::os::raw::c_int,
    pub sample_aspect_ratio: AVRational,
    pub colorspace: AVColorSpace,
    pub color_range: AVColorRange,
    pub sample_rate: ::std::os::raw::c_int,
    pub ch_layout: AVChannelLayout,
    pub time_base: AVRational,
    pub side_data: *mut *mut AVFrameSideData,
    pub nb_side_data: ::std::os::raw::c_int,
    pub alpha_mode: AVAlphaMode,
    pub incfg: AVFilterFormatsConfig,
    pub outcfg: AVFilterFormatsConfig,
}
impl Default for AVFilterLink {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub type avfilter_action_func = ::std::option::Option<
    unsafe extern "C" fn(
        ctx: *mut AVFilterContext,
        arg: *mut ::std::os::raw::c_void,
        jobnr: ::std::os::raw::c_int,
        nb_jobs: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
>;
pub type avfilter_execute_func = ::std::option::Option<
    unsafe extern "C" fn(
        ctx: *mut AVFilterContext,
        func: avfilter_action_func,
        arg: *mut ::std::os::raw::c_void,
        ret: *mut ::std::os::raw::c_int,
        nb_jobs: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
>;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterGraph {
    pub av_class: *const AVClass,
    pub filters: *mut *mut AVFilterContext,
    pub nb_filters: ::std::os::raw::c_uint,
    pub scale_sws_opts: *mut ::std::os::raw::c_char,
    pub thread_type: ::std::os::raw::c_int,
    pub nb_threads: ::std::os::raw::c_int,
    pub opaque: *mut ::std::os::raw::c_void,
    pub execute: avfilter_execute_func,
    pub aresample_swr_opts: *mut ::std::os::raw::c_char,
    pub max_buffered_frames: ::std::os::raw::c_uint,
}
impl Default for AVFilterGraph {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AVFILTER_AUTO_CONVERT_ALL: _bindgen_ty_5 = 0;
pub const AVFILTER_AUTO_CONVERT_NONE: _bindgen_ty_5 = -1;
pub type _bindgen_ty_5 = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterInOut {
    pub name: *mut ::std::os::raw::c_char,
    pub filter_ctx: *mut AVFilterContext,
    pub pad_idx: ::std::os::raw::c_int,
    pub next: *mut AVFilterInOut,
}
impl Default for AVFilterInOut {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterPadParams {
    pub label: *mut ::std::os::raw::c_char,
}
impl Default for AVFilterPadParams {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterParams {
    pub filter: *mut AVFilterContext,
    pub filter_name: *mut ::std::os::raw::c_char,
    pub instance_name: *mut ::std::os::raw::c_char,
    pub opts: *mut AVDictionary,
    pub inputs: *mut *mut AVFilterPadParams,
    pub nb_inputs: ::std::os::raw::c_uint,
    pub outputs: *mut *mut AVFilterPadParams,
    pub nb_outputs: ::std::os::raw::c_uint,
}
impl Default for AVFilterParams {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterChain {
    pub filters: *mut *mut AVFilterParams,
    pub nb_filters: usize,
}
impl Default for AVFilterChain {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVFilterGraphSegment {
    pub graph: *mut AVFilterGraph,
    pub chains: *mut *mut AVFilterChain,
    pub nb_chains: usize,
    pub scale_sws_opts: *mut ::std::os::raw::c_char,
}
impl Default for AVFilterGraphSegment {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
pub const AV_BUFFERSRC_FLAG_NO_CHECK_FORMAT: _bindgen_ty_6 = 1;
pub const AV_BUFFERSRC_FLAG_PUSH: _bindgen_ty_6 = 4;
pub const AV_BUFFERSRC_FLAG_KEEP_REF: _bindgen_ty_6 = 8;
pub type _bindgen_ty_6 = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Copy, Clone)]
pub struct AVBufferSrcParameters {
    pub format: ::std::os::raw::c_int,
    pub time_base: AVRational,
    pub width: ::std::os::raw::c_int,
    pub height: ::std::os::raw::c_int,
    pub sample_aspect_ratio: AVRational,
    pub frame_rate: AVRational,
    pub hw_frames_ctx: *mut AVBufferRef,
    pub sample_rate: ::std::os::raw::c_int,
    pub ch_layout: AVChannelLayout,
    pub color_space: AVColorSpace,
    pub color_range: AVColorRange,
    pub side_data: *mut *mut AVFrameSideData,
    pub nb_side_data: ::std::os::raw::c_int,
    pub alpha_mode: AVAlphaMode,
}
impl Default for AVBufferSrcParameters {
    fn default() -> Self {
        let mut s = ::std::mem::MaybeUninit::<Self>::uninit();
        unsafe {
            ::std::ptr::write_bytes(s.as_mut_ptr(), 0, 1);
            s.assume_init()
        }
    }
}
#[repr(C)]
#[derive(Default, Copy, Clone)]
pub struct AVCodecInternal {
    pub _address: u8,
}
