use super::types::*;

pub struct AvCodec {
    __library: ::libloading::Library,
    pub avcodec_get_name: unsafe extern "C" fn(id: AVCodecID) -> *const ::std::os::raw::c_char,
    pub avcodec_find_decoder: unsafe extern "C" fn(id: AVCodecID) -> *const AVCodec,
    pub avcodec_find_encoder_by_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> *const AVCodec,
    pub avcodec_get_hw_config: unsafe extern "C" fn(
        codec: *const AVCodec,
        index: ::std::os::raw::c_int,
    ) -> *const AVCodecHWConfig,
    pub av_packet_side_data_get: unsafe extern "C" fn(
        sd: *const AVPacketSideData,
        nb_sd: ::std::os::raw::c_int,
        type_: AVPacketSideDataType,
    ) -> *const AVPacketSideData,
    pub av_packet_alloc: unsafe extern "C" fn() -> *mut AVPacket,
    pub av_packet_free: unsafe extern "C" fn(pkt: *mut *mut AVPacket),
    pub av_packet_unref: unsafe extern "C" fn(pkt: *mut AVPacket),
    pub av_packet_rescale_ts:
        unsafe extern "C" fn(pkt: *mut AVPacket, tb_src: AVRational, tb_dst: AVRational),
    pub avcodec_version: unsafe extern "C" fn() -> ::std::os::raw::c_uint,
    pub avcodec_alloc_context3: unsafe extern "C" fn(codec: *const AVCodec) -> *mut AVCodecContext,
    pub avcodec_free_context: unsafe extern "C" fn(avctx: *mut *mut AVCodecContext),
    pub avcodec_parameters_alloc: unsafe extern "C" fn() -> *mut AVCodecParameters,
    pub avcodec_parameters_free: unsafe extern "C" fn(par: *mut *mut AVCodecParameters),
    pub avcodec_parameters_copy: unsafe extern "C" fn(
        dst: *mut AVCodecParameters,
        src: *const AVCodecParameters,
    ) -> ::std::os::raw::c_int,
    pub avcodec_parameters_from_context: unsafe extern "C" fn(
        par: *mut AVCodecParameters,
        codec: *const AVCodecContext,
    ) -> ::std::os::raw::c_int,
    pub avcodec_parameters_to_context: unsafe extern "C" fn(
        codec: *mut AVCodecContext,
        par: *const AVCodecParameters,
    ) -> ::std::os::raw::c_int,
    pub avcodec_open2: unsafe extern "C" fn(
        avctx: *mut AVCodecContext,
        codec: *const AVCodec,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int,
    pub avcodec_send_packet: unsafe extern "C" fn(
        avctx: *mut AVCodecContext,
        avpkt: *const AVPacket,
    ) -> ::std::os::raw::c_int,
    pub avcodec_receive_frame: unsafe extern "C" fn(
        avctx: *mut AVCodecContext,
        frame: *mut AVFrame,
    ) -> ::std::os::raw::c_int,
    pub avcodec_send_frame: unsafe extern "C" fn(
        avctx: *mut AVCodecContext,
        frame: *const AVFrame,
    ) -> ::std::os::raw::c_int,
    pub avcodec_receive_packet: unsafe extern "C" fn(
        avctx: *mut AVCodecContext,
        avpkt: *mut AVPacket,
    ) -> ::std::os::raw::c_int,
    pub avcodec_flush_buffers: unsafe extern "C" fn(avctx: *mut AVCodecContext),
}
impl AvCodec {
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
        let avcodec_get_name = __library.get(b"avcodec_get_name\0").map(|sym| *sym)?;
        let avcodec_find_decoder = __library.get(b"avcodec_find_decoder\0").map(|sym| *sym)?;
        let avcodec_find_encoder_by_name = __library
            .get(b"avcodec_find_encoder_by_name\0")
            .map(|sym| *sym)?;
        let avcodec_get_hw_config = __library.get(b"avcodec_get_hw_config\0").map(|sym| *sym)?;
        let av_packet_side_data_get = __library
            .get(b"av_packet_side_data_get\0")
            .map(|sym| *sym)?;
        let av_packet_alloc = __library.get(b"av_packet_alloc\0").map(|sym| *sym)?;
        let av_packet_free = __library.get(b"av_packet_free\0").map(|sym| *sym)?;
        let av_packet_unref = __library.get(b"av_packet_unref\0").map(|sym| *sym)?;
        let av_packet_rescale_ts = __library.get(b"av_packet_rescale_ts\0").map(|sym| *sym)?;
        let avcodec_version = __library.get(b"avcodec_version\0").map(|sym| *sym)?;
        let avcodec_alloc_context3 = __library.get(b"avcodec_alloc_context3\0").map(|sym| *sym)?;
        let avcodec_free_context = __library.get(b"avcodec_free_context\0").map(|sym| *sym)?;
        let avcodec_parameters_alloc = __library
            .get(b"avcodec_parameters_alloc\0")
            .map(|sym| *sym)?;
        let avcodec_parameters_free = __library
            .get(b"avcodec_parameters_free\0")
            .map(|sym| *sym)?;
        let avcodec_parameters_copy = __library
            .get(b"avcodec_parameters_copy\0")
            .map(|sym| *sym)?;
        let avcodec_parameters_from_context = __library
            .get(b"avcodec_parameters_from_context\0")
            .map(|sym| *sym)?;
        let avcodec_parameters_to_context = __library
            .get(b"avcodec_parameters_to_context\0")
            .map(|sym| *sym)?;
        let avcodec_open2 = __library.get(b"avcodec_open2\0").map(|sym| *sym)?;
        let avcodec_send_packet = __library.get(b"avcodec_send_packet\0").map(|sym| *sym)?;
        let avcodec_receive_frame = __library.get(b"avcodec_receive_frame\0").map(|sym| *sym)?;
        let avcodec_send_frame = __library.get(b"avcodec_send_frame\0").map(|sym| *sym)?;
        let avcodec_receive_packet = __library.get(b"avcodec_receive_packet\0").map(|sym| *sym)?;
        let avcodec_flush_buffers = __library.get(b"avcodec_flush_buffers\0").map(|sym| *sym)?;
        Ok(AvCodec {
            __library,
            avcodec_get_name,
            avcodec_find_decoder,
            avcodec_find_encoder_by_name,
            avcodec_get_hw_config,
            av_packet_side_data_get,
            av_packet_alloc,
            av_packet_free,
            av_packet_unref,
            av_packet_rescale_ts,
            avcodec_version,
            avcodec_alloc_context3,
            avcodec_free_context,
            avcodec_parameters_alloc,
            avcodec_parameters_free,
            avcodec_parameters_copy,
            avcodec_parameters_from_context,
            avcodec_parameters_to_context,
            avcodec_open2,
            avcodec_send_packet,
            avcodec_receive_frame,
            avcodec_send_frame,
            avcodec_receive_packet,
            avcodec_flush_buffers,
        })
    }
    pub unsafe fn avcodec_get_name(&self, id: AVCodecID) -> *const ::std::os::raw::c_char {
        (self.avcodec_get_name)(id)
    }
    pub unsafe fn avcodec_find_decoder(&self, id: AVCodecID) -> *const AVCodec {
        (self.avcodec_find_decoder)(id)
    }
    pub unsafe fn avcodec_find_encoder_by_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> *const AVCodec {
        (self.avcodec_find_encoder_by_name)(name)
    }
    pub unsafe fn avcodec_get_hw_config(
        &self,
        codec: *const AVCodec,
        index: ::std::os::raw::c_int,
    ) -> *const AVCodecHWConfig {
        (self.avcodec_get_hw_config)(codec, index)
    }
    pub unsafe fn av_packet_side_data_get(
        &self,
        sd: *const AVPacketSideData,
        nb_sd: ::std::os::raw::c_int,
        type_: AVPacketSideDataType,
    ) -> *const AVPacketSideData {
        (self.av_packet_side_data_get)(sd, nb_sd, type_)
    }
    pub unsafe fn av_packet_alloc(&self) -> *mut AVPacket {
        (self.av_packet_alloc)()
    }
    pub unsafe fn av_packet_free(&self, pkt: *mut *mut AVPacket) {
        (self.av_packet_free)(pkt)
    }
    pub unsafe fn av_packet_unref(&self, pkt: *mut AVPacket) {
        (self.av_packet_unref)(pkt)
    }
    pub unsafe fn av_packet_rescale_ts(
        &self,
        pkt: *mut AVPacket,
        tb_src: AVRational,
        tb_dst: AVRational,
    ) {
        (self.av_packet_rescale_ts)(pkt, tb_src, tb_dst)
    }
    pub unsafe fn avcodec_version(&self) -> ::std::os::raw::c_uint {
        (self.avcodec_version)()
    }
    pub unsafe fn avcodec_alloc_context3(&self, codec: *const AVCodec) -> *mut AVCodecContext {
        (self.avcodec_alloc_context3)(codec)
    }
    pub unsafe fn avcodec_free_context(&self, avctx: *mut *mut AVCodecContext) {
        (self.avcodec_free_context)(avctx)
    }
    pub unsafe fn avcodec_parameters_alloc(&self) -> *mut AVCodecParameters {
        (self.avcodec_parameters_alloc)()
    }
    pub unsafe fn avcodec_parameters_free(&self, par: *mut *mut AVCodecParameters) {
        (self.avcodec_parameters_free)(par)
    }
    pub unsafe fn avcodec_parameters_copy(
        &self,
        dst: *mut AVCodecParameters,
        src: *const AVCodecParameters,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_parameters_copy)(dst, src)
    }
    pub unsafe fn avcodec_parameters_from_context(
        &self,
        par: *mut AVCodecParameters,
        codec: *const AVCodecContext,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_parameters_from_context)(par, codec)
    }
    pub unsafe fn avcodec_parameters_to_context(
        &self,
        codec: *mut AVCodecContext,
        par: *const AVCodecParameters,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_parameters_to_context)(codec, par)
    }
    pub unsafe fn avcodec_open2(
        &self,
        avctx: *mut AVCodecContext,
        codec: *const AVCodec,
        options: *mut *mut AVDictionary,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_open2)(avctx, codec, options)
    }
    pub unsafe fn avcodec_send_packet(
        &self,
        avctx: *mut AVCodecContext,
        avpkt: *const AVPacket,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_send_packet)(avctx, avpkt)
    }
    pub unsafe fn avcodec_receive_frame(
        &self,
        avctx: *mut AVCodecContext,
        frame: *mut AVFrame,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_receive_frame)(avctx, frame)
    }
    pub unsafe fn avcodec_send_frame(
        &self,
        avctx: *mut AVCodecContext,
        frame: *const AVFrame,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_send_frame)(avctx, frame)
    }
    pub unsafe fn avcodec_receive_packet(
        &self,
        avctx: *mut AVCodecContext,
        avpkt: *mut AVPacket,
    ) -> ::std::os::raw::c_int {
        (self.avcodec_receive_packet)(avctx, avpkt)
    }
    pub unsafe fn avcodec_flush_buffers(&self, avctx: *mut AVCodecContext) {
        (self.avcodec_flush_buffers)(avctx)
    }
}
