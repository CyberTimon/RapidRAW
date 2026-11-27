pub mod audio;
pub mod encode;
pub mod probe;
pub mod sys;
pub mod video;

use std::ffi::{CStr, CString, c_char, c_int};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::Manager;

use crate::video::ffmpeg::{FileKey, file_key};
use sys::avcodec::AvCodec;
use sys::avfilter::AvFilter;
use sys::avformat::AvFormat;
use sys::avutil::AvUtil;
use sys::types::*;

pub const AGAIN: c_int = -libc::EAGAIN;
pub const END: c_int = -541_478_725;
pub const NO_PTS: i64 = i64::MIN;
pub const TIME_BASE: AVRational = AVRational {
    num: 1,
    den: 1_000_000,
};
const INVALID: c_int = -22;
const LOG_QUIET: c_int = -8;
const MOV_FORMAT: &CStr = c"mov,mp4,m4a,3gp,3g2,mj2";
const REUSABLE_FORMATS: [&CStr; 2] = [MOV_FORMAT, c"matroska,webm"];
const SKIPPING_FORMATS: [&CStr; 1] = [MOV_FORMAT];
const REMEMBERED_FILES: usize = 64;
const BEST_KINDS: [AVMediaType; 2] = [AVMEDIA_TYPE_VIDEO, AVMEDIA_TYPE_AUDIO];
const LIBRARIES: [(&str, u32); 6] = [
    ("avutil", 61),
    ("swresample", 7),
    ("swscale", 10),
    ("avcodec", 63),
    ("avformat", 63),
    ("avfilter", 12),
];

pub struct Libav {
    pub util: AvUtil,
    pub codec: AvCodec,
    pub format: AvFormat,
    pub filter: AvFilter,
    _support: Vec<libloading::Library>,
}

static LIBAV: OnceLock<Libav> = OnceLock::new();
static GAVE_UP: AtomicBool = AtomicBool::new(false);
static LOADING: Mutex<()> = Mutex::new(());

pub fn get() -> Option<&'static Libav> {
    if let Some(libav) = LIBAV.get() {
        return Some(libav);
    }
    if GAVE_UP.load(Ordering::Relaxed) {
        return None;
    }
    let _loading = LOADING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(libav) = LIBAV.get() {
        return Some(libav);
    }
    let app_ready = crate::render::gpu::context::app_handle().is_some();
    match load() {
        Some(libav) => Some(LIBAV.get_or_init(|| libav)),
        None => {
            if app_ready {
                GAVE_UP.store(true, Ordering::Relaxed);
            }
            None
        }
    }
}

pub fn require() -> Result<&'static Libav, String> {
    get().ok_or_else(|| {
        "Video is unavailable because the FFmpeg libraries could not be loaded".to_string()
    })
}

pub fn version() -> Option<String> {
    let libav = get()?;
    unsafe { text(libav.util.av_version_info()) }
}

fn library_file(name: &str, major: u32) -> String {
    if cfg!(windows) {
        format!("{}-{}.dll", name, major)
    } else if cfg!(target_os = "macos") {
        format!("lib{}.{}.dylib", name, major)
    } else {
        format!("lib{}.so.{}", name, major)
    }
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::var_os("RAPIDRAW_FFMPEG_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(resources) = crate::render::gpu::context::app_handle().and_then(|app| {
        app.path()
            .resolve("resources", tauri::path::BaseDirectory::Resource)
            .ok()
    }) {
        dirs.push(resources.join("ffmpeg"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        dirs.push(parent.join("resources").join("ffmpeg"));
    }
    if cfg!(debug_assertions) {
        dirs.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("ffmpeg"),
        );
    }
    dirs
}

unsafe fn open_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    #[cfg(windows)]
    unsafe {
        libloading::os::windows::Library::load_with_flags(
            path,
            libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH,
        )
        .map(Into::into)
    }
    #[cfg(unix)]
    unsafe {
        libloading::os::unix::Library::open(
            Some(path),
            libloading::os::unix::RTLD_NOW | libloading::os::unix::RTLD_GLOBAL,
        )
        .map(Into::into)
    }
}

fn load() -> Option<Libav> {
    for dir in search_dirs() {
        if !dir
            .join(library_file(LIBRARIES[0].0, LIBRARIES[0].1))
            .is_file()
        {
            continue;
        }
        match load_from(&dir) {
            Ok(libav) => {
                log::info!(
                    "Loaded FFmpeg {} from {}",
                    unsafe { text(libav.util.av_version_info()) }.unwrap_or_default(),
                    dir.display()
                );
                return Some(libav);
            }
            Err(e) => log::warn!("Could not load FFmpeg from {}: {}", dir.display(), e),
        }
    }
    None
}

fn load_from(dir: &Path) -> Result<Libav, String> {
    let mut libraries = Vec::new();
    for (name, major) in LIBRARIES {
        let library = unsafe { open_library(&dir.join(library_file(name, major))) }
            .map_err(|e| format!("{}: {}", name, e))?;
        libraries.push(library);
    }
    let mut libraries = libraries.into_iter();
    let mut next = || libraries.next().expect("every FFmpeg library is loaded");
    let util = unsafe { AvUtil::from_library(next()) }.map_err(|e| e.to_string())?;
    let support = vec![next(), next()];
    let codec = unsafe { AvCodec::from_library(next()) }.map_err(|e| e.to_string())?;
    let format = unsafe { AvFormat::from_library(next()) }.map_err(|e| e.to_string())?;
    let filter = unsafe { AvFilter::from_library(next()) }.map_err(|e| e.to_string())?;
    let majors = unsafe {
        [
            util.avutil_version(),
            codec.avcodec_version(),
            format.avformat_version(),
            filter.avfilter_version(),
        ]
    }
    .map(|version| version >> 16);
    let expected = [
        LIBRARIES[0].1,
        LIBRARIES[3].1,
        LIBRARIES[4].1,
        LIBRARIES[5].1,
    ];
    if majors != expected {
        return Err(format!(
            "unexpected library versions {:?}, expected {:?}",
            majors, expected
        ));
    }
    unsafe { util.av_log_set_level(LOG_QUIET) };
    Ok(Libav {
        util,
        codec,
        format,
        filter,
        _support: support,
    })
}

impl Libav {
    pub fn error(&self, code: c_int) -> String {
        let mut buffer = [0 as c_char; 256];
        unsafe {
            self.util
                .av_strerror(code, buffer.as_mut_ptr(), buffer.len());
            CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned()
        }
    }

    pub fn check(&self, code: c_int, context: &str) -> Result<c_int, String> {
        if code < 0 {
            Err(format!("{}: {}", context, self.error(code)))
        } else {
            Ok(code)
        }
    }

    pub fn pixel_format(&self, name: &str) -> Result<AVPixelFormat, String> {
        let name = cstring(name)?;
        let format = unsafe { self.util.av_get_pix_fmt(name.as_ptr()) };
        if format == AV_PIX_FMT_NONE {
            Err(format!("Unknown pixel format {:?}", name))
        } else {
            Ok(format)
        }
    }
}

pub(super) fn libav() -> &'static Libav {
    LIBAV
        .get()
        .expect("FFmpeg objects only exist after the libraries are loaded")
}

pub fn cstring(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| format!("Invalid text {:?}", text))
}

pub fn path_cstring(path: &Path) -> Result<CString, String> {
    cstring(
        path.to_str()
            .ok_or_else(|| format!("'{}' is not a valid UTF-8 path", path.display()))?,
    )
}

pub unsafe fn text(pointer: *const c_char) -> Option<String> {
    (!pointer.is_null()).then(|| {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    })
}

pub fn q2d(rational: AVRational) -> f64 {
    if rational.den == 0 {
        0.0
    } else {
        rational.num as f64 / rational.den as f64
    }
}

pub fn rational(num: i32, den: i32) -> AVRational {
    AVRational { num, den }
}

pub struct Frame(pub *mut AVFrame);

impl Frame {
    pub fn new(libav: &Libav) -> Result<Self, String> {
        let frame = unsafe { libav.util.av_frame_alloc() };
        if frame.is_null() {
            Err("Out of memory allocating a frame".to_string())
        } else {
            Ok(Self(frame))
        }
    }

    pub fn unref(&self) {
        unsafe { libav().util.av_frame_unref(self.0) };
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        unsafe { libav().util.av_frame_free(&mut self.0) };
    }
}

pub struct Packet(pub *mut AVPacket);

impl Packet {
    pub fn new(libav: &Libav) -> Result<Self, String> {
        let packet = unsafe { libav.codec.av_packet_alloc() };
        if packet.is_null() {
            Err("Out of memory allocating a packet".to_string())
        } else {
            Ok(Self(packet))
        }
    }

    pub fn unref(&self) {
        unsafe { libav().codec.av_packet_unref(self.0) };
    }
}

impl Drop for Packet {
    fn drop(&mut self) {
        unsafe { libav().codec.av_packet_free(&mut self.0) };
    }
}

#[derive(Default)]
pub struct Dictionary(pub *mut AVDictionary);

impl Dictionary {
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        let (key_c, value_c) = (cstring(key)?, cstring(value)?);
        let result = unsafe {
            libav()
                .util
                .av_dict_set(&mut self.0, key_c.as_ptr(), value_c.as_ptr(), 0)
        };
        libav()
            .check(result, &format!("Invalid option {}={}", key, value))
            .map(|_| ())
    }
}

impl Drop for Dictionary {
    fn drop(&mut self) {
        unsafe { libav().util.av_dict_free(&mut self.0) };
    }
}

struct Parameters(*mut AVCodecParameters);

unsafe impl Send for Parameters {}
unsafe impl Sync for Parameters {}

impl Drop for Parameters {
    fn drop(&mut self) {
        unsafe { libav().codec.avcodec_parameters_free(&mut self.0) };
    }
}

#[derive(PartialEq)]
struct Header {
    codec_type: AVMediaType,
    codec_id: AVCodecID,
    time_base: (c_int, c_int),
}

impl Header {
    fn of(stream: *mut AVStream) -> Self {
        unsafe {
            Self {
                codec_type: (*(*stream).codecpar).codec_type,
                codec_id: (*(*stream).codecpar).codec_id,
                time_base: ((*stream).time_base.num, (*stream).time_base.den),
            }
        }
    }
}

struct StreamInfo {
    header: Header,
    parameters: Parameters,
    start_time: i64,
    duration: i64,
    sample_aspect_ratio: AVRational,
    avg_frame_rate: AVRational,
    r_frame_rate: AVRational,
}

struct FileInfo {
    key: FileKey,
    streams: Vec<StreamInfo>,
    start_time: i64,
    duration: i64,
    bit_rate: i64,
    best: [c_int; 2],
}

static FILE_INFOS: Mutex<Vec<(PathBuf, Arc<FileInfo>)>> = Mutex::new(Vec::new());

fn remembered(path: &Path, key: &FileKey) -> Option<Arc<FileInfo>> {
    let mut infos = FILE_INFOS.lock().unwrap_or_else(|e| e.into_inner());
    let index = infos.iter().position(|(cached, _)| cached == path)?;
    let entry = infos.remove(index);
    (entry.1.key == *key).then(|| {
        let info = Arc::clone(&entry.1);
        infos.push(entry);
        info
    })
}

fn remember(path: &Path, info: FileInfo) {
    let mut infos = FILE_INFOS.lock().unwrap_or_else(|e| e.into_inner());
    infos.retain(|(cached, _)| cached != path);
    if infos.len() >= REMEMBERED_FILES {
        infos.remove(0);
    }
    infos.push((path.to_path_buf(), Arc::new(info)));
}

pub struct Input(pub *mut AVFormatContext, [c_int; 2]);

unsafe impl Send for Input {}

impl Input {
    pub fn open(libav: &Libav, path: &Path) -> Result<Self, String> {
        let path_c = path_cstring(path)?;
        let mut context: *mut AVFormatContext = ptr::null_mut();
        let opened = unsafe {
            libav.format.avformat_open_input(
                &mut context,
                path_c.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
            )
        };
        libav.check(opened, &format!("Could not open '{}'", path.display()))?;
        let mut input = Self(context, [INVALID; 2]);
        let key = file_key(path).ok();
        let headers: Vec<Header> = input.streams().map(Header::of).collect();
        if let Some(info) = key.as_ref().and_then(|key| remembered(path, key))
            && info.streams.len() == headers.len()
            && info
                .streams
                .iter()
                .zip(&headers)
                .all(|(stream, header)| stream.header == *header)
        {
            input.restore(libav, &info)?;
            return Ok(input);
        }
        let found = unsafe {
            libav
                .format
                .avformat_find_stream_info(input.0, ptr::null_mut())
        };
        libav.check(found, &format!("Could not read '{}'", path.display()))?;
        input.1 = BEST_KINDS.map(|kind| unsafe {
            libav
                .format
                .av_find_best_stream(input.0, kind, -1, -1, ptr::null_mut(), 0)
        });
        if let Some(key) = key
            && input.format_in(&REUSABLE_FORMATS)
            && input.streams().count() == headers.len()
        {
            remember(path, input.capture(libav, key, headers)?);
        }
        Ok(input)
    }

    fn streams(&self) -> impl Iterator<Item = *mut AVStream> + '_ {
        (0..unsafe { (*self.0).nb_streams } as c_int).map(|index| self.stream(index))
    }

    fn format_in(&self, formats: &[&CStr]) -> bool {
        let format = unsafe { (*self.0).iformat };
        !format.is_null() && formats.contains(&unsafe { CStr::from_ptr((*format).name) })
    }

    fn capture(
        &self,
        libav: &Libav,
        key: FileKey,
        headers: Vec<Header>,
    ) -> Result<FileInfo, String> {
        let streams = self
            .streams()
            .zip(headers)
            .map(|(stream, header)| {
                let parameters = Parameters(unsafe { libav.codec.avcodec_parameters_alloc() });
                if parameters.0.is_null() {
                    return Err("Out of memory remembering a stream".to_string());
                }
                libav.check(
                    unsafe {
                        libav
                            .codec
                            .avcodec_parameters_copy(parameters.0, (*stream).codecpar)
                    },
                    "Could not remember a stream",
                )?;
                Ok(unsafe {
                    StreamInfo {
                        header,
                        parameters,
                        start_time: (*stream).start_time,
                        duration: (*stream).duration,
                        sample_aspect_ratio: (*stream).sample_aspect_ratio,
                        avg_frame_rate: (*stream).avg_frame_rate,
                        r_frame_rate: (*stream).r_frame_rate,
                    }
                })
            })
            .collect::<Result<_, String>>()?;
        Ok(unsafe {
            FileInfo {
                key,
                streams,
                start_time: (*self.0).start_time,
                duration: (*self.0).duration,
                bit_rate: (*self.0).bit_rate,
                best: self.1,
            }
        })
    }

    fn restore(&mut self, libav: &Libav, info: &FileInfo) -> Result<(), String> {
        for (stream, cached) in self.streams().zip(&info.streams) {
            libav.check(
                unsafe {
                    libav
                        .codec
                        .avcodec_parameters_copy((*stream).codecpar, cached.parameters.0)
                },
                "Could not restore a stream",
            )?;
            unsafe {
                (*stream).start_time = cached.start_time;
                (*stream).duration = cached.duration;
                (*stream).sample_aspect_ratio = cached.sample_aspect_ratio;
                (*stream).avg_frame_rate = cached.avg_frame_rate;
                (*stream).r_frame_rate = cached.r_frame_rate;
            }
        }
        unsafe {
            (*self.0).start_time = info.start_time;
            (*self.0).duration = info.duration;
            (*self.0).bit_rate = info.bit_rate;
        }
        self.1 = info.best;
        Ok(())
    }

    pub fn best_stream(&self, kind: AVMediaType) -> c_int {
        BEST_KINDS
            .iter()
            .position(|best| *best == kind)
            .map_or(INVALID, |index| self.1[index])
    }

    pub fn keep_only(&self, index: c_int) {
        if !self.format_in(&SKIPPING_FORMATS) {
            return;
        }
        for stream in self.streams() {
            if unsafe { (*stream).index } != index {
                unsafe { (*stream).discard = AVDISCARD_ALL };
            }
        }
    }

    pub fn stream(&self, index: c_int) -> *mut AVStream {
        unsafe { *(*self.0).streams.add(index as usize) }
    }

    pub fn start_offset(&self, time_base: AVRational) -> i64 {
        let start = unsafe { (*self.0).start_time };
        if start == NO_PTS {
            0
        } else {
            unsafe { libav().util.av_rescale_q(start, TIME_BASE, time_base) }
        }
    }
}

impl Drop for Input {
    fn drop(&mut self) {
        unsafe { libav().format.avformat_close_input(&mut self.0) };
    }
}

pub struct Codec(pub *mut AVCodecContext);

unsafe impl Send for Codec {}

impl Codec {
    pub fn new(libav: &Libav, codec: *const AVCodec) -> Result<Self, String> {
        let context = unsafe { libav.codec.avcodec_alloc_context3(codec) };
        if context.is_null() {
            Err("Out of memory allocating a codec".to_string())
        } else {
            Ok(Self(context))
        }
    }
}

impl Drop for Codec {
    fn drop(&mut self) {
        unsafe { libav().codec.avcodec_free_context(&mut self.0) };
    }
}

pub struct BufferRef(pub *mut AVBufferRef);

unsafe impl Send for BufferRef {}

impl Drop for BufferRef {
    fn drop(&mut self) {
        unsafe { libav().util.av_buffer_unref(&mut self.0) };
    }
}

pub struct Graph(pub *mut AVFilterGraph);

unsafe impl Send for Graph {}

impl Graph {
    pub fn new(libav: &Libav) -> Result<Self, String> {
        let graph = unsafe { libav.filter.avfilter_graph_alloc() };
        if graph.is_null() {
            Err("Out of memory allocating a filter graph".to_string())
        } else {
            Ok(Self(graph))
        }
    }

    pub fn create(
        &self,
        libav: &Libav,
        filter: &str,
        name: &str,
        args: &str,
    ) -> Result<*mut AVFilterContext, String> {
        let (filter_c, name_c, args_c) = (cstring(filter)?, cstring(name)?, cstring(args)?);
        let definition = unsafe { libav.filter.avfilter_get_by_name(filter_c.as_ptr()) };
        if definition.is_null() {
            return Err(format!("FFmpeg has no {} filter", filter));
        }
        let mut context = ptr::null_mut();
        let created = unsafe {
            libav.filter.avfilter_graph_create_filter(
                &mut context,
                definition,
                name_c.as_ptr(),
                if args.is_empty() {
                    ptr::null()
                } else {
                    args_c.as_ptr()
                },
                ptr::null_mut(),
                self.0,
            )
        };
        libav.check(created, &format!("Could not create the {} filter", filter))?;
        Ok(context)
    }

    pub fn create_on_device(
        &self,
        libav: &Libav,
        filter: &str,
        name: &str,
        device: *mut AVBufferRef,
    ) -> Result<*mut AVFilterContext, String> {
        let (filter_c, name_c) = (cstring(filter)?, cstring(name)?);
        let definition = unsafe { libav.filter.avfilter_get_by_name(filter_c.as_ptr()) };
        if definition.is_null() {
            return Err(format!("FFmpeg has no {} filter", filter));
        }
        let context = unsafe {
            libav
                .filter
                .avfilter_graph_alloc_filter(self.0, definition, name_c.as_ptr())
        };
        if context.is_null() {
            return Err(format!("Could not create the {} filter", filter));
        }
        let initialized = unsafe {
            (*context).hw_device_ctx = libav.util.av_buffer_ref(device);
            libav.filter.avfilter_init_str(context, ptr::null())
        };
        libav.check(
            initialized,
            &format!("Could not start the {} filter", filter),
        )?;
        Ok(context)
    }

    pub fn create_hardware_source(
        &self,
        libav: &Libav,
        name: &str,
        configure: impl FnOnce(&mut AVBufferSrcParameters),
    ) -> Result<*mut AVFilterContext, String> {
        let (filter_c, name_c) = (cstring("buffer")?, cstring(name)?);
        let context = unsafe {
            libav.filter.avfilter_graph_alloc_filter(
                self.0,
                libav.filter.avfilter_get_by_name(filter_c.as_ptr()),
                name_c.as_ptr(),
            )
        };
        if context.is_null() {
            return Err("Could not create the hardware frame source".to_string());
        }
        let parameters = unsafe { libav.filter.av_buffersrc_parameters_alloc() };
        if parameters.is_null() {
            return Err("Out of memory configuring the hardware frame source".to_string());
        }
        let configured = unsafe {
            configure(&mut *parameters);
            let configured = libav
                .filter
                .av_buffersrc_parameters_set(context, parameters);
            libav.util.av_free(parameters.cast());
            configured
        };
        libav.check(configured, "Could not configure the hardware frame source")?;
        let initialized = unsafe { libav.filter.avfilter_init_str(context, ptr::null()) };
        libav.check(initialized, "Could not start the hardware frame source")?;
        Ok(context)
    }

    pub fn link(
        &self,
        libav: &Libav,
        description: &str,
        sources: &[(&str, *mut AVFilterContext)],
        sinks: &[(&str, *mut AVFilterContext)],
    ) -> Result<(), String> {
        let chain = |pads: &[(&str, *mut AVFilterContext)]| -> Result<*mut AVFilterInOut, String> {
            let mut head: *mut AVFilterInOut = ptr::null_mut();
            for (label, context) in pads.iter().rev() {
                let node = unsafe { libav.filter.avfilter_inout_alloc() };
                if node.is_null() {
                    return Err("Out of memory linking filters".to_string());
                }
                let label_c = cstring(label)?;
                unsafe {
                    (*node).name = libav.util.av_strdup(label_c.as_ptr());
                    (*node).filter_ctx = *context;
                    (*node).pad_idx = 0;
                    (*node).next = head;
                }
                head = node;
            }
            Ok(head)
        };
        let mut outputs = chain(sources)?;
        let mut inputs = chain(sinks)?;
        let description_c = cstring(description)?;
        let parsed = unsafe {
            libav.filter.avfilter_graph_parse_ptr(
                self.0,
                description_c.as_ptr(),
                &mut inputs,
                &mut outputs,
                ptr::null_mut(),
            )
        };
        unsafe {
            libav.filter.avfilter_inout_free(&mut inputs);
            libav.filter.avfilter_inout_free(&mut outputs);
        }
        libav.check(parsed, &format!("Invalid filters '{}'", description))?;
        let configured = unsafe { libav.filter.avfilter_graph_config(self.0, ptr::null_mut()) };
        libav
            .check(
                configured,
                &format!("Could not set up the filters '{}'", description),
            )
            .map(|_| ())
    }
}

impl Drop for Graph {
    fn drop(&mut self) {
        unsafe { libav().filter.avfilter_graph_free(&mut self.0) };
    }
}
