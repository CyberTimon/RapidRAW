use super::types::*;

pub struct AvFormat {
    __library: ::libloading::Library,
    pub avio_open: unsafe extern "C" fn(
        s: *mut *mut AVIOContext,
        url: *const ::std::os::raw::c_char,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub avio_closep: unsafe extern "C" fn(s: *mut *mut AVIOContext) -> ::std::os::raw::c_int,
    pub avformat_version: unsafe extern "C" fn() -> ::std::os::raw::c_uint,
    pub avformat_free_context: unsafe extern "C" fn(s: *mut AVFormatContext),
    pub avformat_new_stream:
        unsafe extern "C" fn(s: *mut AVFormatContext, c: *const AVCodec) -> *mut AVStream,
    pub avformat_alloc_output_context2: unsafe extern "C" fn(
        ctx: *mut *mut AVFormatContext,
        oformat: *const AVOutputFormat,
        format_name: *const ::std::os::raw::c_char,
        filename: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int,
    pub avformat_open_input: unsafe extern "C" fn(
        ps: *mut *mut AVFormatContext,
        url: *const ::std::os::raw::c_char,
        fmt: *const AVInputFormat,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int,
    pub avformat_find_stream_info: unsafe extern "C" fn(
        ic: *mut AVFormatContext,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int,
    pub av_find_best_stream: unsafe extern "C" fn(
        ic: *mut AVFormatContext,
        type_: AVMediaType,
        wanted_stream_nb: ::std::os::raw::c_int,
        related_stream: ::std::os::raw::c_int,
        decoder_ret: *mut *const AVCodec,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_read_frame:
        unsafe extern "C" fn(s: *mut AVFormatContext, pkt: *mut AVPacket) -> ::std::os::raw::c_int,
    pub avformat_seek_file: unsafe extern "C" fn(
        s: *mut AVFormatContext,
        stream_index: ::std::os::raw::c_int,
        min_ts: i64,
        ts: i64,
        max_ts: i64,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub avformat_close_input: unsafe extern "C" fn(s: *mut *mut AVFormatContext),
    pub avformat_write_header: unsafe extern "C" fn(
        s: *mut AVFormatContext,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int,
    pub av_interleaved_write_frame:
        unsafe extern "C" fn(s: *mut AVFormatContext, pkt: *mut AVPacket) -> ::std::os::raw::c_int,
    pub av_write_trailer: unsafe extern "C" fn(s: *mut AVFormatContext) -> ::std::os::raw::c_int,
    pub av_guess_frame_rate: unsafe extern "C" fn(
        ctx: *mut AVFormatContext,
        stream: *mut AVStream,
        frame: *mut AVFrame,
    ) -> AVRational,
}
impl AvFormat {
    pub unsafe fn new<P>(path: P) -> Result<Self, ::libloading::Error>
    where
        P: AsRef<::std::ffi::OsStr>,
    {
        let library = ::libloading::Library::new(path)?;
        Self::from_library(library)
    }
    pub unsafe fn from_library<L>(library: L) -> Result<Self, ::libloading::Error>
    where
        L: Into<::libloading::Library>,
    {
        let __library = library.into();
        let avio_open = __library.get(b"avio_open\0").map(|sym| *sym)?;
        let avio_closep = __library.get(b"avio_closep\0").map(|sym| *sym)?;
        let avformat_version = __library.get(b"avformat_version\0").map(|sym| *sym)?;
        let avformat_free_context = __library.get(b"avformat_free_context\0").map(|sym| *sym)?;
        let avformat_new_stream = __library.get(b"avformat_new_stream\0").map(|sym| *sym)?;
        let avformat_alloc_output_context2 = __library
            .get(b"avformat_alloc_output_context2\0")
            .map(|sym| *sym)?;
        let avformat_open_input = __library.get(b"avformat_open_input\0").map(|sym| *sym)?;
        let avformat_find_stream_info = __library
            .get(b"avformat_find_stream_info\0")
            .map(|sym| *sym)?;
        let av_find_best_stream = __library.get(b"av_find_best_stream\0").map(|sym| *sym)?;
        let av_read_frame = __library.get(b"av_read_frame\0").map(|sym| *sym)?;
        let avformat_seek_file = __library.get(b"avformat_seek_file\0").map(|sym| *sym)?;
        let avformat_close_input = __library.get(b"avformat_close_input\0").map(|sym| *sym)?;
        let avformat_write_header = __library.get(b"avformat_write_header\0").map(|sym| *sym)?;
        let av_interleaved_write_frame = __library
            .get(b"av_interleaved_write_frame\0")
            .map(|sym| *sym)?;
        let av_write_trailer = __library.get(b"av_write_trailer\0").map(|sym| *sym)?;
        let av_guess_frame_rate = __library.get(b"av_guess_frame_rate\0").map(|sym| *sym)?;
        Ok(AvFormat {
            __library,
            avio_open,
            avio_closep,
            avformat_version,
            avformat_free_context,
            avformat_new_stream,
            avformat_alloc_output_context2,
            avformat_open_input,
            avformat_find_stream_info,
            av_find_best_stream,
            av_read_frame,
            avformat_seek_file,
            avformat_close_input,
            avformat_write_header,
            av_interleaved_write_frame,
            av_write_trailer,
            av_guess_frame_rate,
        })
    }
    pub unsafe fn avio_open(
        &self,
        s: *mut *mut AVIOContext,
        url: *const ::std::os::raw::c_char,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.avio_open)(s, url, flags)
    }
    pub unsafe fn avio_closep(&self, s: *mut *mut AVIOContext) -> ::std::os::raw::c_int {
        (self.avio_closep)(s)
    }
    pub unsafe fn avformat_version(&self) -> ::std::os::raw::c_uint {
        (self.avformat_version)()
    }
    pub unsafe fn avformat_free_context(&self, s: *mut AVFormatContext) {
        (self.avformat_free_context)(s)
    }
    pub unsafe fn avformat_new_stream(
        &self,
        s: *mut AVFormatContext,
        c: *const AVCodec,
    ) -> *mut AVStream {
        (self.avformat_new_stream)(s, c)
    }
    pub unsafe fn avformat_alloc_output_context2(
        &self,
        ctx: *mut *mut AVFormatContext,
        oformat: *const AVOutputFormat,
        format_name: *const ::std::os::raw::c_char,
        filename: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int {
        (self.avformat_alloc_output_context2)(ctx, oformat, format_name, filename)
    }
    pub unsafe fn avformat_open_input(
        &self,
        ps: *mut *mut AVFormatContext,
        url: *const ::std::os::raw::c_char,
        fmt: *const AVInputFormat,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int {
        (self.avformat_open_input)(ps, url, fmt, options)
    }
    pub unsafe fn avformat_find_stream_info(
        &self,
        ic: *mut AVFormatContext,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int {
        (self.avformat_find_stream_info)(ic, options)
    }
    pub unsafe fn av_find_best_stream(
        &self,
        ic: *mut AVFormatContext,
        type_: AVMediaType,
        wanted_stream_nb: ::std::os::raw::c_int,
        related_stream: ::std::os::raw::c_int,
        decoder_ret: *mut *const AVCodec,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_find_best_stream)(
            ic,
            type_,
            wanted_stream_nb,
            related_stream,
            decoder_ret,
            flags,
        )
    }
    pub unsafe fn av_read_frame(
        &self,
        s: *mut AVFormatContext,
        pkt: *mut AVPacket,
    ) -> ::std::os::raw::c_int {
        (self.av_read_frame)(s, pkt)
    }
    pub unsafe fn avformat_seek_file(
        &self,
        s: *mut AVFormatContext,
        stream_index: ::std::os::raw::c_int,
        min_ts: i64,
        ts: i64,
        max_ts: i64,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.avformat_seek_file)(s, stream_index, min_ts, ts, max_ts, flags)
    }
    pub unsafe fn avformat_close_input(&self, s: *mut *mut AVFormatContext) {
        (self.avformat_close_input)(s)
    }
    pub unsafe fn avformat_write_header(
        &self,
        s: *mut AVFormatContext,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int {
        (self.avformat_write_header)(s, options)
    }
    pub unsafe fn av_interleaved_write_frame(
        &self,
        s: *mut AVFormatContext,
        pkt: *mut AVPacket,
    ) -> ::std::os::raw::c_int {
        (self.av_interleaved_write_frame)(s, pkt)
    }
    pub unsafe fn av_write_trailer(&self, s: *mut AVFormatContext) -> ::std::os::raw::c_int {
        (self.av_write_trailer)(s)
    }
    pub unsafe fn av_guess_frame_rate(
        &self,
        ctx: *mut AVFormatContext,
        stream: *mut AVStream,
        frame: *mut AVFrame,
    ) -> AVRational {
        (self.av_guess_frame_rate)(ctx, stream, frame)
    }
}
