use super::types::*;

pub struct AvUtil {
    __library: ::libloading::Library,
    pub avutil_version: unsafe extern "C" fn() -> ::std::os::raw::c_uint,
    pub av_version_info: unsafe extern "C" fn() -> *const ::std::os::raw::c_char,
    pub av_strerror: unsafe extern "C" fn(
        errnum: ::std::os::raw::c_int,
        errbuf: *mut ::std::os::raw::c_char,
        errbuf_size: usize,
    ) -> ::std::os::raw::c_int,
    pub av_free: unsafe extern "C" fn(ptr: *mut ::std::os::raw::c_void),
    pub av_strdup:
        unsafe extern "C" fn(s: *const ::std::os::raw::c_char) -> *mut ::std::os::raw::c_char,
    pub av_rescale_q: unsafe extern "C" fn(a: i64, bq: AVRational, cq: AVRational) -> i64,
    pub av_log_set_level: unsafe extern "C" fn(level: ::std::os::raw::c_int),
    pub av_buffer_ref: unsafe extern "C" fn(buf: *const AVBufferRef) -> *mut AVBufferRef,
    pub av_buffer_unref: unsafe extern "C" fn(buf: *mut *mut AVBufferRef),
    pub av_channel_layout_default:
        unsafe extern "C" fn(ch_layout: *mut AVChannelLayout, nb_channels: ::std::os::raw::c_int),
    pub av_channel_layout_uninit: unsafe extern "C" fn(channel_layout: *mut AVChannelLayout),
    pub av_channel_layout_copy: unsafe extern "C" fn(
        dst: *mut AVChannelLayout,
        src: *const AVChannelLayout,
    ) -> ::std::os::raw::c_int,
    pub av_channel_layout_describe: unsafe extern "C" fn(
        channel_layout: *const AVChannelLayout,
        buf: *mut ::std::os::raw::c_char,
        buf_size: usize,
    ) -> ::std::os::raw::c_int,
    pub av_dict_get: unsafe extern "C" fn(
        m: *const AVDictionary,
        key: *const ::std::os::raw::c_char,
        prev: *const AVDictionaryEntry,
        flags: ::std::os::raw::c_int,
    ) -> *mut AVDictionaryEntry,
    pub av_dict_set: unsafe extern "C" fn(
        pm: *mut *mut AVDictionary,
        key: *const ::std::os::raw::c_char,
        value: *const ::std::os::raw::c_char,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_dict_free: unsafe extern "C" fn(m: *mut *mut AVDictionary),
    pub av_get_sample_fmt_name:
        unsafe extern "C" fn(sample_fmt: AVSampleFormat) -> *const ::std::os::raw::c_char,
    pub av_get_sample_fmt:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> AVSampleFormat,
    pub av_get_bytes_per_sample:
        unsafe extern "C" fn(sample_fmt: AVSampleFormat) -> ::std::os::raw::c_int,
    pub av_frame_alloc: unsafe extern "C" fn() -> *mut AVFrame,
    pub av_frame_free: unsafe extern "C" fn(frame: *mut *mut AVFrame),
    pub av_frame_unref: unsafe extern "C" fn(frame: *mut AVFrame),
    pub av_frame_get_buffer: unsafe extern "C" fn(
        frame: *mut AVFrame,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_frame_copy_props:
        unsafe extern "C" fn(dst: *mut AVFrame, src: *const AVFrame) -> ::std::os::raw::c_int,
    pub av_hwdevice_find_type_by_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> AVHWDeviceType,
    pub av_hwdevice_ctx_create: unsafe extern "C" fn(
        device_ctx: *mut *mut AVBufferRef,
        type_: AVHWDeviceType,
        device: *const ::std::os::raw::c_char,
        opts: *mut AVDictionary,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_hwframe_transfer_data: unsafe extern "C" fn(
        dst: *mut AVFrame,
        src: *const AVFrame,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_pix_fmt_desc_get:
        unsafe extern "C" fn(pix_fmt: AVPixelFormat) -> *const AVPixFmtDescriptor,
    pub av_color_range_name:
        unsafe extern "C" fn(range: AVColorRange) -> *const ::std::os::raw::c_char,
    pub av_color_range_from_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> ::std::os::raw::c_int,
    pub av_color_primaries_name:
        unsafe extern "C" fn(primaries: AVColorPrimaries) -> *const ::std::os::raw::c_char,
    pub av_color_primaries_from_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> ::std::os::raw::c_int,
    pub av_color_transfer_name: unsafe extern "C" fn(
        transfer: AVColorTransferCharacteristic,
    ) -> *const ::std::os::raw::c_char,
    pub av_color_transfer_from_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> ::std::os::raw::c_int,
    pub av_color_space_name:
        unsafe extern "C" fn(space: AVColorSpace) -> *const ::std::os::raw::c_char,
    pub av_color_space_from_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> ::std::os::raw::c_int,
    pub av_chroma_location_name:
        unsafe extern "C" fn(location: AVChromaLocation) -> *const ::std::os::raw::c_char,
    pub av_get_pix_fmt: unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> AVPixelFormat,
    pub av_get_pix_fmt_name:
        unsafe extern "C" fn(pix_fmt: AVPixelFormat) -> *const ::std::os::raw::c_char,
    pub av_image_fill_arrays: unsafe extern "C" fn(
        dst_data: *mut *mut u8,
        dst_linesize: *mut ::std::os::raw::c_int,
        src: *const u8,
        pix_fmt: AVPixelFormat,
        width: ::std::os::raw::c_int,
        height: ::std::os::raw::c_int,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_image_get_buffer_size: unsafe extern "C" fn(
        pix_fmt: AVPixelFormat,
        width: ::std::os::raw::c_int,
        height: ::std::os::raw::c_int,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_image_copy_to_buffer: unsafe extern "C" fn(
        dst: *mut u8,
        dst_size: ::std::os::raw::c_int,
        src_data: *const *const u8,
        src_linesize: *const ::std::os::raw::c_int,
        pix_fmt: AVPixelFormat,
        width: ::std::os::raw::c_int,
        height: ::std::os::raw::c_int,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_opt_set: unsafe extern "C" fn(
        obj: *mut ::std::os::raw::c_void,
        name: *const ::std::os::raw::c_char,
        val: *const ::std::os::raw::c_char,
        search_flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_opt_set_int: unsafe extern "C" fn(
        obj: *mut ::std::os::raw::c_void,
        name: *const ::std::os::raw::c_char,
        val: i64,
        search_flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_display_rotation_get: unsafe extern "C" fn(matrix: *const i32) -> f64,
}
impl AvUtil {
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
        let avutil_version = __library.get(b"avutil_version\0").map(|sym| *sym)?;
        let av_version_info = __library.get(b"av_version_info\0").map(|sym| *sym)?;
        let av_strerror = __library.get(b"av_strerror\0").map(|sym| *sym)?;
        let av_free = __library.get(b"av_free\0").map(|sym| *sym)?;
        let av_strdup = __library.get(b"av_strdup\0").map(|sym| *sym)?;
        let av_rescale_q = __library.get(b"av_rescale_q\0").map(|sym| *sym)?;
        let av_log_set_level = __library.get(b"av_log_set_level\0").map(|sym| *sym)?;
        let av_buffer_ref = __library.get(b"av_buffer_ref\0").map(|sym| *sym)?;
        let av_buffer_unref = __library.get(b"av_buffer_unref\0").map(|sym| *sym)?;
        let av_channel_layout_default = __library
            .get(b"av_channel_layout_default\0")
            .map(|sym| *sym)?;
        let av_channel_layout_uninit = __library
            .get(b"av_channel_layout_uninit\0")
            .map(|sym| *sym)?;
        let av_channel_layout_copy = __library.get(b"av_channel_layout_copy\0").map(|sym| *sym)?;
        let av_channel_layout_describe = __library
            .get(b"av_channel_layout_describe\0")
            .map(|sym| *sym)?;
        let av_dict_get = __library.get(b"av_dict_get\0").map(|sym| *sym)?;
        let av_dict_set = __library.get(b"av_dict_set\0").map(|sym| *sym)?;
        let av_dict_free = __library.get(b"av_dict_free\0").map(|sym| *sym)?;
        let av_get_sample_fmt_name = __library.get(b"av_get_sample_fmt_name\0").map(|sym| *sym)?;
        let av_get_sample_fmt = __library.get(b"av_get_sample_fmt\0").map(|sym| *sym)?;
        let av_get_bytes_per_sample = __library
            .get(b"av_get_bytes_per_sample\0")
            .map(|sym| *sym)?;
        let av_frame_alloc = __library.get(b"av_frame_alloc\0").map(|sym| *sym)?;
        let av_frame_free = __library.get(b"av_frame_free\0").map(|sym| *sym)?;
        let av_frame_unref = __library.get(b"av_frame_unref\0").map(|sym| *sym)?;
        let av_frame_get_buffer = __library.get(b"av_frame_get_buffer\0").map(|sym| *sym)?;
        let av_frame_copy_props = __library.get(b"av_frame_copy_props\0").map(|sym| *sym)?;
        let av_hwdevice_find_type_by_name = __library
            .get(b"av_hwdevice_find_type_by_name\0")
            .map(|sym| *sym)?;
        let av_hwdevice_ctx_create = __library.get(b"av_hwdevice_ctx_create\0").map(|sym| *sym)?;
        let av_hwframe_transfer_data = __library
            .get(b"av_hwframe_transfer_data\0")
            .map(|sym| *sym)?;
        let av_pix_fmt_desc_get = __library.get(b"av_pix_fmt_desc_get\0").map(|sym| *sym)?;
        let av_color_range_name = __library.get(b"av_color_range_name\0").map(|sym| *sym)?;
        let av_color_range_from_name = __library
            .get(b"av_color_range_from_name\0")
            .map(|sym| *sym)?;
        let av_color_primaries_name = __library
            .get(b"av_color_primaries_name\0")
            .map(|sym| *sym)?;
        let av_color_primaries_from_name = __library
            .get(b"av_color_primaries_from_name\0")
            .map(|sym| *sym)?;
        let av_color_transfer_name = __library.get(b"av_color_transfer_name\0").map(|sym| *sym)?;
        let av_color_transfer_from_name = __library
            .get(b"av_color_transfer_from_name\0")
            .map(|sym| *sym)?;
        let av_color_space_name = __library.get(b"av_color_space_name\0").map(|sym| *sym)?;
        let av_color_space_from_name = __library
            .get(b"av_color_space_from_name\0")
            .map(|sym| *sym)?;
        let av_chroma_location_name = __library
            .get(b"av_chroma_location_name\0")
            .map(|sym| *sym)?;
        let av_get_pix_fmt = __library.get(b"av_get_pix_fmt\0").map(|sym| *sym)?;
        let av_get_pix_fmt_name = __library.get(b"av_get_pix_fmt_name\0").map(|sym| *sym)?;
        let av_image_fill_arrays = __library.get(b"av_image_fill_arrays\0").map(|sym| *sym)?;
        let av_image_get_buffer_size = __library
            .get(b"av_image_get_buffer_size\0")
            .map(|sym| *sym)?;
        let av_image_copy_to_buffer = __library
            .get(b"av_image_copy_to_buffer\0")
            .map(|sym| *sym)?;
        let av_opt_set = __library.get(b"av_opt_set\0").map(|sym| *sym)?;
        let av_opt_set_int = __library.get(b"av_opt_set_int\0").map(|sym| *sym)?;
        let av_display_rotation_get = __library
            .get(b"av_display_rotation_get\0")
            .map(|sym| *sym)?;
        Ok(AvUtil {
            __library,
            avutil_version,
            av_version_info,
            av_strerror,
            av_free,
            av_strdup,
            av_rescale_q,
            av_log_set_level,
            av_buffer_ref,
            av_buffer_unref,
            av_channel_layout_default,
            av_channel_layout_uninit,
            av_channel_layout_copy,
            av_channel_layout_describe,
            av_dict_get,
            av_dict_set,
            av_dict_free,
            av_get_sample_fmt_name,
            av_get_sample_fmt,
            av_get_bytes_per_sample,
            av_frame_alloc,
            av_frame_free,
            av_frame_unref,
            av_frame_get_buffer,
            av_frame_copy_props,
            av_hwdevice_find_type_by_name,
            av_hwdevice_ctx_create,
            av_hwframe_transfer_data,
            av_pix_fmt_desc_get,
            av_color_range_name,
            av_color_range_from_name,
            av_color_primaries_name,
            av_color_primaries_from_name,
            av_color_transfer_name,
            av_color_transfer_from_name,
            av_color_space_name,
            av_color_space_from_name,
            av_chroma_location_name,
            av_get_pix_fmt,
            av_get_pix_fmt_name,
            av_image_fill_arrays,
            av_image_get_buffer_size,
            av_image_copy_to_buffer,
            av_opt_set,
            av_opt_set_int,
            av_display_rotation_get,
        })
    }
    pub unsafe fn avutil_version(&self) -> ::std::os::raw::c_uint {
        (self.avutil_version)()
    }
    pub unsafe fn av_version_info(&self) -> *const ::std::os::raw::c_char {
        (self.av_version_info)()
    }
    pub unsafe fn av_strerror(
        &self,
        errnum: ::std::os::raw::c_int,
        errbuf: *mut ::std::os::raw::c_char,
        errbuf_size: usize,
    ) -> ::std::os::raw::c_int {
        (self.av_strerror)(errnum, errbuf, errbuf_size)
    }
    pub unsafe fn av_free(&self, ptr: *mut ::std::os::raw::c_void) {
        (self.av_free)(ptr)
    }
    pub unsafe fn av_strdup(
        &self,
        s: *const ::std::os::raw::c_char,
    ) -> *mut ::std::os::raw::c_char {
        (self.av_strdup)(s)
    }
    pub unsafe fn av_rescale_q(&self, a: i64, bq: AVRational, cq: AVRational) -> i64 {
        (self.av_rescale_q)(a, bq, cq)
    }
    pub unsafe fn av_log_set_level(&self, level: ::std::os::raw::c_int) {
        (self.av_log_set_level)(level)
    }
    pub unsafe fn av_buffer_ref(&self, buf: *const AVBufferRef) -> *mut AVBufferRef {
        (self.av_buffer_ref)(buf)
    }
    pub unsafe fn av_buffer_unref(&self, buf: *mut *mut AVBufferRef) {
        (self.av_buffer_unref)(buf)
    }
    pub unsafe fn av_channel_layout_default(
        &self,
        ch_layout: *mut AVChannelLayout,
        nb_channels: ::std::os::raw::c_int,
    ) {
        (self.av_channel_layout_default)(ch_layout, nb_channels)
    }
    pub unsafe fn av_channel_layout_uninit(&self, channel_layout: *mut AVChannelLayout) {
        (self.av_channel_layout_uninit)(channel_layout)
    }
    pub unsafe fn av_channel_layout_copy(
        &self,
        dst: *mut AVChannelLayout,
        src: *const AVChannelLayout,
    ) -> ::std::os::raw::c_int {
        (self.av_channel_layout_copy)(dst, src)
    }
    pub unsafe fn av_channel_layout_describe(
        &self,
        channel_layout: *const AVChannelLayout,
        buf: *mut ::std::os::raw::c_char,
        buf_size: usize,
    ) -> ::std::os::raw::c_int {
        (self.av_channel_layout_describe)(channel_layout, buf, buf_size)
    }
    pub unsafe fn av_dict_get(
        &self,
        m: *const AVDictionary,
        key: *const ::std::os::raw::c_char,
        prev: *const AVDictionaryEntry,
        flags: ::std::os::raw::c_int,
    ) -> *mut AVDictionaryEntry {
        (self.av_dict_get)(m, key, prev, flags)
    }
    pub unsafe fn av_dict_set(
        &self,
        pm: *mut *mut AVDictionary,
        key: *const ::std::os::raw::c_char,
        value: *const ::std::os::raw::c_char,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_dict_set)(pm, key, value, flags)
    }
    pub unsafe fn av_dict_free(&self, m: *mut *mut AVDictionary) {
        (self.av_dict_free)(m)
    }
    pub unsafe fn av_get_sample_fmt_name(
        &self,
        sample_fmt: AVSampleFormat,
    ) -> *const ::std::os::raw::c_char {
        (self.av_get_sample_fmt_name)(sample_fmt)
    }
    pub unsafe fn av_get_sample_fmt(&self, name: *const ::std::os::raw::c_char) -> AVSampleFormat {
        (self.av_get_sample_fmt)(name)
    }
    pub unsafe fn av_get_bytes_per_sample(
        &self,
        sample_fmt: AVSampleFormat,
    ) -> ::std::os::raw::c_int {
        (self.av_get_bytes_per_sample)(sample_fmt)
    }
    pub unsafe fn av_frame_alloc(&self) -> *mut AVFrame {
        (self.av_frame_alloc)()
    }
    pub unsafe fn av_frame_free(&self, frame: *mut *mut AVFrame) {
        (self.av_frame_free)(frame)
    }
    pub unsafe fn av_frame_unref(&self, frame: *mut AVFrame) {
        (self.av_frame_unref)(frame)
    }
    pub unsafe fn av_frame_get_buffer(
        &self,
        frame: *mut AVFrame,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_frame_get_buffer)(frame, align)
    }
    pub unsafe fn av_frame_copy_props(
        &self,
        dst: *mut AVFrame,
        src: *const AVFrame,
    ) -> ::std::os::raw::c_int {
        (self.av_frame_copy_props)(dst, src)
    }
    pub unsafe fn av_hwdevice_find_type_by_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> AVHWDeviceType {
        (self.av_hwdevice_find_type_by_name)(name)
    }
    pub unsafe fn av_hwdevice_ctx_create(
        &self,
        device_ctx: *mut *mut AVBufferRef,
        type_: AVHWDeviceType,
        device: *const ::std::os::raw::c_char,
        opts: *mut AVDictionary,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_hwdevice_ctx_create)(device_ctx, type_, device, opts, flags)
    }
    pub unsafe fn av_hwframe_transfer_data(
        &self,
        dst: *mut AVFrame,
        src: *const AVFrame,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_hwframe_transfer_data)(dst, src, flags)
    }
    pub unsafe fn av_pix_fmt_desc_get(&self, pix_fmt: AVPixelFormat) -> *const AVPixFmtDescriptor {
        (self.av_pix_fmt_desc_get)(pix_fmt)
    }
    pub unsafe fn av_color_range_name(&self, range: AVColorRange) -> *const ::std::os::raw::c_char {
        (self.av_color_range_name)(range)
    }
    pub unsafe fn av_color_range_from_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int {
        (self.av_color_range_from_name)(name)
    }
    pub unsafe fn av_color_primaries_name(
        &self,
        primaries: AVColorPrimaries,
    ) -> *const ::std::os::raw::c_char {
        (self.av_color_primaries_name)(primaries)
    }
    pub unsafe fn av_color_primaries_from_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int {
        (self.av_color_primaries_from_name)(name)
    }
    pub unsafe fn av_color_transfer_name(
        &self,
        transfer: AVColorTransferCharacteristic,
    ) -> *const ::std::os::raw::c_char {
        (self.av_color_transfer_name)(transfer)
    }
    pub unsafe fn av_color_transfer_from_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int {
        (self.av_color_transfer_from_name)(name)
    }
    pub unsafe fn av_color_space_name(&self, space: AVColorSpace) -> *const ::std::os::raw::c_char {
        (self.av_color_space_name)(space)
    }
    pub unsafe fn av_color_space_from_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int {
        (self.av_color_space_from_name)(name)
    }
    pub unsafe fn av_chroma_location_name(
        &self,
        location: AVChromaLocation,
    ) -> *const ::std::os::raw::c_char {
        (self.av_chroma_location_name)(location)
    }
    pub unsafe fn av_get_pix_fmt(&self, name: *const ::std::os::raw::c_char) -> AVPixelFormat {
        (self.av_get_pix_fmt)(name)
    }
    pub unsafe fn av_get_pix_fmt_name(
        &self,
        pix_fmt: AVPixelFormat,
    ) -> *const ::std::os::raw::c_char {
        (self.av_get_pix_fmt_name)(pix_fmt)
    }
    pub unsafe fn av_image_fill_arrays(
        &self,
        dst_data: *mut *mut u8,
        dst_linesize: *mut ::std::os::raw::c_int,
        src: *const u8,
        pix_fmt: AVPixelFormat,
        width: ::std::os::raw::c_int,
        height: ::std::os::raw::c_int,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_image_fill_arrays)(dst_data, dst_linesize, src, pix_fmt, width, height, align)
    }
    pub unsafe fn av_image_get_buffer_size(
        &self,
        pix_fmt: AVPixelFormat,
        width: ::std::os::raw::c_int,
        height: ::std::os::raw::c_int,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_image_get_buffer_size)(pix_fmt, width, height, align)
    }
    pub unsafe fn av_image_copy_to_buffer(
        &self,
        dst: *mut u8,
        dst_size: ::std::os::raw::c_int,
        src_data: *const *const u8,
        src_linesize: *const ::std::os::raw::c_int,
        pix_fmt: AVPixelFormat,
        width: ::std::os::raw::c_int,
        height: ::std::os::raw::c_int,
        align: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_image_copy_to_buffer)(
            dst,
            dst_size,
            src_data,
            src_linesize,
            pix_fmt,
            width,
            height,
            align,
        )
    }
    pub unsafe fn av_opt_set(
        &self,
        obj: *mut ::std::os::raw::c_void,
        name: *const ::std::os::raw::c_char,
        val: *const ::std::os::raw::c_char,
        search_flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_opt_set)(obj, name, val, search_flags)
    }
    pub unsafe fn av_opt_set_int(
        &self,
        obj: *mut ::std::os::raw::c_void,
        name: *const ::std::os::raw::c_char,
        val: i64,
        search_flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_opt_set_int)(obj, name, val, search_flags)
    }
    pub unsafe fn av_display_rotation_get(&self, matrix: *const i32) -> f64 {
        (self.av_display_rotation_get)(matrix)
    }
}
