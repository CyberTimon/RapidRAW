use super::types::*;

pub struct AvFilter {
    __library: ::libloading::Library,
    pub avfilter_version: unsafe extern "C" fn() -> ::std::os::raw::c_uint,
    pub avfilter_get_by_name:
        unsafe extern "C" fn(name: *const ::std::os::raw::c_char) -> *const AVFilter,
    pub avfilter_graph_alloc: unsafe extern "C" fn() -> *mut AVFilterGraph,
    pub avfilter_graph_create_filter: unsafe extern "C" fn(
        filt_ctx: *mut *mut AVFilterContext,
        filt: *const AVFilter,
        name: *const ::std::os::raw::c_char,
        args: *const ::std::os::raw::c_char,
        opaque: *mut ::std::os::raw::c_void,
        graph_ctx: *mut AVFilterGraph,
    ) -> ::std::os::raw::c_int,
    pub avfilter_graph_alloc_filter: unsafe extern "C" fn(
        graph: *mut AVFilterGraph,
        filter: *const AVFilter,
        name: *const ::std::os::raw::c_char,
    ) -> *mut AVFilterContext,
    pub avfilter_init_str: unsafe extern "C" fn(
        ctx: *mut AVFilterContext,
        args: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int,
    pub avfilter_graph_config: unsafe extern "C" fn(
        graphctx: *mut AVFilterGraph,
        log_ctx: *mut ::std::os::raw::c_void,
    ) -> ::std::os::raw::c_int,
    pub avfilter_graph_free: unsafe extern "C" fn(graph: *mut *mut AVFilterGraph),
    pub avfilter_inout_alloc: unsafe extern "C" fn() -> *mut AVFilterInOut,
    pub avfilter_inout_free: unsafe extern "C" fn(inout: *mut *mut AVFilterInOut),
    pub avfilter_graph_parse_ptr: unsafe extern "C" fn(
        graph: *mut AVFilterGraph,
        filters: *const ::std::os::raw::c_char,
        inputs: *mut *mut AVFilterInOut,
        outputs: *mut *mut AVFilterInOut,
        log_ctx: *mut ::std::os::raw::c_void,
    ) -> ::std::os::raw::c_int,
    pub av_buffersrc_get_nb_failed_requests:
        unsafe extern "C" fn(buffer_src: *mut AVFilterContext) -> ::std::os::raw::c_uint,
    pub av_buffersrc_add_frame_flags: unsafe extern "C" fn(
        buffer_src: *mut AVFilterContext,
        frame: *mut AVFrame,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int,
    pub av_buffersrc_parameters_alloc: unsafe extern "C" fn() -> *mut AVBufferSrcParameters,
    pub av_buffersrc_parameters_set: unsafe extern "C" fn(
        ctx: *mut AVFilterContext,
        param: *mut AVBufferSrcParameters,
    ) -> ::std::os::raw::c_int,
    pub av_buffersink_set_frame_size:
        unsafe extern "C" fn(ctx: *mut AVFilterContext, frame_size: ::std::os::raw::c_uint),
    pub av_buffersink_get_time_base:
        unsafe extern "C" fn(ctx: *const AVFilterContext) -> AVRational,
    pub av_buffersink_get_frame_rate:
        unsafe extern "C" fn(ctx: *const AVFilterContext) -> AVRational,
    pub av_buffersink_get_frame: unsafe extern "C" fn(
        ctx: *mut AVFilterContext,
        frame: *mut AVFrame,
    ) -> ::std::os::raw::c_int,
    pub av_buffersink_get_hw_frames_ctx:
        unsafe extern "C" fn(ctx: *const AVFilterContext) -> *mut AVBufferRef,
}
impl AvFilter {
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
        let avfilter_version = __library.get(b"avfilter_version\0").map(|sym| *sym)?;
        let avfilter_get_by_name = __library.get(b"avfilter_get_by_name\0").map(|sym| *sym)?;
        let avfilter_graph_alloc = __library.get(b"avfilter_graph_alloc\0").map(|sym| *sym)?;
        let avfilter_graph_create_filter = __library
            .get(b"avfilter_graph_create_filter\0")
            .map(|sym| *sym)?;
        let avfilter_graph_alloc_filter = __library
            .get(b"avfilter_graph_alloc_filter\0")
            .map(|sym| *sym)?;
        let avfilter_init_str = __library.get(b"avfilter_init_str\0").map(|sym| *sym)?;
        let avfilter_graph_config = __library.get(b"avfilter_graph_config\0").map(|sym| *sym)?;
        let avfilter_graph_free = __library.get(b"avfilter_graph_free\0").map(|sym| *sym)?;
        let avfilter_inout_alloc = __library.get(b"avfilter_inout_alloc\0").map(|sym| *sym)?;
        let avfilter_inout_free = __library.get(b"avfilter_inout_free\0").map(|sym| *sym)?;
        let avfilter_graph_parse_ptr = __library
            .get(b"avfilter_graph_parse_ptr\0")
            .map(|sym| *sym)?;
        let av_buffersrc_get_nb_failed_requests = __library
            .get(b"av_buffersrc_get_nb_failed_requests\0")
            .map(|sym| *sym)?;
        let av_buffersrc_add_frame_flags = __library
            .get(b"av_buffersrc_add_frame_flags\0")
            .map(|sym| *sym)?;
        let av_buffersrc_parameters_alloc = __library
            .get(b"av_buffersrc_parameters_alloc\0")
            .map(|sym| *sym)?;
        let av_buffersrc_parameters_set = __library
            .get(b"av_buffersrc_parameters_set\0")
            .map(|sym| *sym)?;
        let av_buffersink_set_frame_size = __library
            .get(b"av_buffersink_set_frame_size\0")
            .map(|sym| *sym)?;
        let av_buffersink_get_time_base = __library
            .get(b"av_buffersink_get_time_base\0")
            .map(|sym| *sym)?;
        let av_buffersink_get_frame_rate = __library
            .get(b"av_buffersink_get_frame_rate\0")
            .map(|sym| *sym)?;
        let av_buffersink_get_frame = __library
            .get(b"av_buffersink_get_frame\0")
            .map(|sym| *sym)?;
        let av_buffersink_get_hw_frames_ctx = __library
            .get(b"av_buffersink_get_hw_frames_ctx\0")
            .map(|sym| *sym)?;
        Ok(AvFilter {
            __library,
            avfilter_version,
            avfilter_get_by_name,
            avfilter_graph_alloc,
            avfilter_graph_create_filter,
            avfilter_graph_alloc_filter,
            avfilter_init_str,
            avfilter_graph_config,
            avfilter_graph_free,
            avfilter_inout_alloc,
            avfilter_inout_free,
            avfilter_graph_parse_ptr,
            av_buffersrc_get_nb_failed_requests,
            av_buffersrc_add_frame_flags,
            av_buffersrc_parameters_alloc,
            av_buffersrc_parameters_set,
            av_buffersink_set_frame_size,
            av_buffersink_get_time_base,
            av_buffersink_get_frame_rate,
            av_buffersink_get_frame,
            av_buffersink_get_hw_frames_ctx,
        })
    }
    pub unsafe fn avfilter_version(&self) -> ::std::os::raw::c_uint {
        (self.avfilter_version)()
    }
    pub unsafe fn avfilter_get_by_name(
        &self,
        name: *const ::std::os::raw::c_char,
    ) -> *const AVFilter {
        (self.avfilter_get_by_name)(name)
    }
    pub unsafe fn avfilter_graph_alloc(&self) -> *mut AVFilterGraph {
        (self.avfilter_graph_alloc)()
    }
    pub unsafe fn avfilter_graph_create_filter(
        &self,
        filt_ctx: *mut *mut AVFilterContext,
        filt: *const AVFilter,
        name: *const ::std::os::raw::c_char,
        args: *const ::std::os::raw::c_char,
        opaque: *mut ::std::os::raw::c_void,
        graph_ctx: *mut AVFilterGraph,
    ) -> ::std::os::raw::c_int {
        (self.avfilter_graph_create_filter)(filt_ctx, filt, name, args, opaque, graph_ctx)
    }
    pub unsafe fn avfilter_graph_alloc_filter(
        &self,
        graph: *mut AVFilterGraph,
        filter: *const AVFilter,
        name: *const ::std::os::raw::c_char,
    ) -> *mut AVFilterContext {
        (self.avfilter_graph_alloc_filter)(graph, filter, name)
    }
    pub unsafe fn avfilter_init_str(
        &self,
        ctx: *mut AVFilterContext,
        args: *const ::std::os::raw::c_char,
    ) -> ::std::os::raw::c_int {
        (self.avfilter_init_str)(ctx, args)
    }
    pub unsafe fn avfilter_graph_config(
        &self,
        graphctx: *mut AVFilterGraph,
        log_ctx: *mut ::std::os::raw::c_void,
    ) -> ::std::os::raw::c_int {
        (self.avfilter_graph_config)(graphctx, log_ctx)
    }
    pub unsafe fn avfilter_graph_free(&self, graph: *mut *mut AVFilterGraph) {
        (self.avfilter_graph_free)(graph)
    }
    pub unsafe fn avfilter_inout_alloc(&self) -> *mut AVFilterInOut {
        (self.avfilter_inout_alloc)()
    }
    pub unsafe fn avfilter_inout_free(&self, inout: *mut *mut AVFilterInOut) {
        (self.avfilter_inout_free)(inout)
    }
    pub unsafe fn avfilter_graph_parse_ptr(
        &self,
        graph: *mut AVFilterGraph,
        filters: *const ::std::os::raw::c_char,
        inputs: *mut *mut AVFilterInOut,
        outputs: *mut *mut AVFilterInOut,
        log_ctx: *mut ::std::os::raw::c_void,
    ) -> ::std::os::raw::c_int {
        (self.avfilter_graph_parse_ptr)(graph, filters, inputs, outputs, log_ctx)
    }
    pub unsafe fn av_buffersrc_get_nb_failed_requests(
        &self,
        buffer_src: *mut AVFilterContext,
    ) -> ::std::os::raw::c_uint {
        (self.av_buffersrc_get_nb_failed_requests)(buffer_src)
    }
    pub unsafe fn av_buffersrc_add_frame_flags(
        &self,
        buffer_src: *mut AVFilterContext,
        frame: *mut AVFrame,
        flags: ::std::os::raw::c_int,
    ) -> ::std::os::raw::c_int {
        (self.av_buffersrc_add_frame_flags)(buffer_src, frame, flags)
    }
    pub unsafe fn av_buffersrc_parameters_alloc(&self) -> *mut AVBufferSrcParameters {
        (self.av_buffersrc_parameters_alloc)()
    }
    pub unsafe fn av_buffersrc_parameters_set(
        &self,
        ctx: *mut AVFilterContext,
        param: *mut AVBufferSrcParameters,
    ) -> ::std::os::raw::c_int {
        (self.av_buffersrc_parameters_set)(ctx, param)
    }
    pub unsafe fn av_buffersink_set_frame_size(
        &self,
        ctx: *mut AVFilterContext,
        frame_size: ::std::os::raw::c_uint,
    ) {
        (self.av_buffersink_set_frame_size)(ctx, frame_size)
    }
    pub unsafe fn av_buffersink_get_time_base(&self, ctx: *const AVFilterContext) -> AVRational {
        (self.av_buffersink_get_time_base)(ctx)
    }
    pub unsafe fn av_buffersink_get_frame_rate(&self, ctx: *const AVFilterContext) -> AVRational {
        (self.av_buffersink_get_frame_rate)(ctx)
    }
    pub unsafe fn av_buffersink_get_frame(
        &self,
        ctx: *mut AVFilterContext,
        frame: *mut AVFrame,
    ) -> ::std::os::raw::c_int {
        (self.av_buffersink_get_frame)(ctx, frame)
    }
    pub unsafe fn av_buffersink_get_hw_frames_ctx(
        &self,
        ctx: *const AVFilterContext,
    ) -> *mut AVBufferRef {
        (self.av_buffersink_get_hw_frames_ctx)(ctx)
    }
}
