// Windows: WinFsp (https://winfsp.dev, installed once by the user). Mounts on a folder (WinFsp creates it, it must
// not exist). The same operations to the relay as on Linux; Windows semantics: a security descriptor (everyone may do
// everything, like on the Linux mount), deleting only on cleanup, directory listing through a DirBuffer.
use crate::{Link, Reply};
use serde_json::{Value, json};
use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use winfsp::filesystem::{
    DirBuffer, DirInfo, DirMarker, FileInfo, FileSecurity, FileSystemContext, OpenFileInfo, VolumeInfo, WideNameInfo,
};
use winfsp::host::{FileSystemHost, FineGuard, VolumeParams};
use winfsp::{FspError, U16CStr};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows::Win32::Security::PSECURITY_DESCRIPTOR;
use windows::Win32::System::LibraryLoader::LoadLibraryW;
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
use windows::core::{HSTRING, w};

type Result<T> = winfsp::Result<T>;

const FILE_DIRECTORY_FILE: u32 = 0x1;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
const CLEANUP_DELETE: u32 = 0x01;
const FILETIME_UNIX_MS: u64 = 11_644_473_600_000; // 1601-01-01 → 1970-01-01

const STATUS_OBJECT_NAME_NOT_FOUND: u32 = 0xC000_0034;
const STATUS_OBJECT_NAME_COLLISION: u32 = 0xC000_0035;
const STATUS_ACCESS_DENIED: u32 = 0xC000_0022;
const STATUS_FILE_IS_A_DIRECTORY: u32 = 0xC000_00BA;
const STATUS_NOT_A_DIRECTORY: u32 = 0xC000_0103;
const STATUS_DIRECTORY_NOT_EMPTY: u32 = 0xC000_0101;
const STATUS_INVALID_PARAMETER: u32 = 0xC000_000D;
const STATUS_END_OF_FILE: u32 = 0xC000_0011;
const STATUS_IO_DEVICE_ERROR: u32 = 0xC000_0185;

fn nt(status: u32) -> FspError {
    FspError::NTSTATUS(status as i32)
}

/// errno from the relay → NTSTATUS
fn errno(e: i32) -> FspError {
    nt(match e {
        2 => STATUS_OBJECT_NAME_NOT_FOUND,
        13 => STATUS_ACCESS_DENIED,
        17 => STATUS_OBJECT_NAME_COLLISION,
        20 => STATUS_NOT_A_DIRECTORY,
        21 => STATUS_FILE_IS_A_DIRECTORY,
        22 => STATUS_INVALID_PARAMETER,
        39 => STATUS_DIRECTORY_NOT_EMPTY,
        _ => STATUS_IO_DEVICE_ERROR,
    })
}

/// The WinFsp DLL from its installation folder (registry InstallDir); WinFsp doesn't put it on PATH
fn load_winfsp() -> std::result::Result<(), String> {
    let mut buf = [0u16; 260];
    let mut size = (buf.len() * 2) as u32;
    let found = [w!("SOFTWARE\\WOW6432Node\\WinFsp"), w!("SOFTWARE\\WinFsp")].into_iter().any(|key| unsafe {
        size = (buf.len() * 2) as u32;
        RegGetValueW(HKEY_LOCAL_MACHINE, key, w!("InstallDir"), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size as *mut u32)).is_ok()
    });
    if !found {
        return Err("WinFsp is not installed on the server (https://winfsp.dev)".into());
    }
    let dir = String::from_utf16_lossy(&buf[..(size as usize / 2).saturating_sub(1)]);
    let dll = format!("{}\\bin\\{}", dir.trim_end_matches('\\'), if cfg!(target_arch = "aarch64") { "winfsp-a64.dll" } else { "winfsp-x64.dll" });
    unsafe { LoadLibraryW(&HSTRING::from(dll.as_str())) }.map_err(|e| format!("WinFsp: {dll}: {e}"))?;
    winfsp::winfsp_init().map(|_| ()).map_err(|e| format!("WinFsp: {e:?}"))
}

pub fn check() -> std::result::Result<(), String> {
    load_winfsp()
}

/// "\\a\\b" → "a/b" (the relay uses "/" and "" for the root)
fn rel(name: &U16CStr) -> String {
    name.to_string_lossy().replace('\\', "/").trim_matches('/').to_string()
}

fn filetime(ms: u64) -> u64 {
    (ms + FILETIME_UNIX_MS) * 10_000
}

fn is_dir(v: &Value) -> bool {
    v.get("kind").and_then(Value::as_str) == Some("dir")
}

/// {"kind", "size", "mtime" (ms)} → FileInfo
fn fill(info: &mut FileInfo, v: &Value) {
    let size = if is_dir(v) { 0 } else { v.get("size").and_then(Value::as_u64).unwrap_or(0) };
    let t = filetime(v.get("mtime").and_then(Value::as_u64).unwrap_or(0));
    *info = FileInfo {
        file_attributes: if is_dir(v) { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_ARCHIVE },
        allocation_size: size.div_ceil(4096) * 4096,
        file_size: size,
        creation_time: t,
        last_access_time: t,
        last_write_time: t,
        change_time: t,
        ..Default::default()
    };
}

pub struct Handle {
    path: String,
    dir: bool,
    dirty: AtomicBool,     // written: on cleanup the relay sends the file back to the browsing computer
    entries: DirBuffer,
}

struct Fs {
    link: Arc<Link>,
    sd: Vec<u8>, // self-relative security descriptor for all files
}

impl Fs {
    fn call(&self, head: Value, data: &[u8]) -> Result<Reply> {
        self.link.call(head, data).map_err(errno)
    }

    fn getattr(&self, path: &str) -> Result<Value> {
        Ok(self.call(json!({"op": "getattr", "path": path}), &[])?.0)
    }

    fn info(&self, path: &str, info: &mut FileInfo) -> Result<()> {
        fill(info, &self.getattr(path)?);
        Ok(())
    }

    fn handle(&self, path: String, v: &Value, dirty: bool) -> Handle {
        Handle { path, dir: is_dir(v), dirty: AtomicBool::new(dirty), entries: DirBuffer::new() }
    }
}

impl FileSystemContext for Fs {
    type FileContext = Handle;

    fn get_security_by_name(
        &self,
        file_name: &U16CStr,
        security_descriptor: Option<&mut [c_void]>,
        _resolver: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
    ) -> Result<FileSecurity> {
        let v = self.getattr(&rel(file_name))?;
        if let Some(buf) = security_descriptor
            && buf.len() >= self.sd.len()
        {
            unsafe { std::ptr::copy_nonoverlapping(self.sd.as_ptr(), buf.as_mut_ptr().cast::<u8>(), self.sd.len()) };
        }
        Ok(FileSecurity {
            reparse: false,
            sz_security_descriptor: self.sd.len() as u64,
            attributes: if is_dir(&v) { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_ARCHIVE },
        })
    }

    fn open(&self, file_name: &U16CStr, _create_options: u32, _granted_access: u32, file_info: &mut OpenFileInfo) -> Result<Handle> {
        let path = rel(file_name);
        let v = self.getattr(&path)?;
        fill(file_info.as_mut(), &v);
        Ok(self.handle(path, &v, false))
    }

    fn close(&self, _context: Handle) {}

    fn create(
        &self,
        file_name: &U16CStr,
        create_options: u32,
        _granted_access: u32,
        _file_attributes: u32,
        _security_descriptor: Option<&[c_void]>,
        _allocation_size: u64,
        _extra_buffer: Option<&[u8]>,
        _extra_buffer_is_reparse_point: bool,
        file_info: &mut OpenFileInfo,
    ) -> Result<Handle> {
        let path = rel(file_name);
        let dir = create_options & FILE_DIRECTORY_FILE != 0;
        let (v, _) = self.call(json!({"op": if dir { "mkdir" } else { "create" }, "path": path}), &[])?;
        fill(file_info.as_mut(), &v);
        Ok(self.handle(path, &v, !dir))
    }

    fn cleanup(&self, context: &Handle, _file_name: Option<&U16CStr>, flags: u32) {
        let op = if flags & CLEANUP_DELETE != 0 {
            if context.dir { "rmdir" } else { "unlink" }
        } else if context.dirty.swap(false, Ordering::Relaxed) {
            "release"
        } else {
            return;
        };
        if let Err(e) = self.link.call(json!({"op": op, "path": context.path}), &[]) {
            eprintln!("rrweb-fuse: {op} {}: errno {e}", context.path);
        }
    }

    fn flush(&self, context: Option<&Handle>, file_info: &mut FileInfo) -> Result<()> {
        match context {
            Some(c) => self.info(&c.path, file_info),
            None => Ok(()),
        }
    }

    fn get_file_info(&self, context: &Handle, file_info: &mut FileInfo) -> Result<()> {
        self.info(&context.path, file_info)
    }

    fn get_security(&self, _context: &Handle, security_descriptor: Option<&mut [c_void]>) -> Result<u64> {
        if let Some(buf) = security_descriptor
            && buf.len() >= self.sd.len()
        {
            unsafe { std::ptr::copy_nonoverlapping(self.sd.as_ptr(), buf.as_mut_ptr().cast::<u8>(), self.sd.len()) };
        }
        Ok(self.sd.len() as u64)
    }

    fn overwrite(
        &self,
        context: &Handle,
        _file_attributes: u32,
        _replace_file_attributes: bool,
        _allocation_size: u64,
        _extra_buffer: Option<&[u8]>,
        file_info: &mut FileInfo,
    ) -> Result<()> {
        self.call(json!({"op": "truncate", "path": context.path, "size": 0}), &[])?;
        context.dirty.store(true, Ordering::Relaxed);
        self.info(&context.path, file_info)
    }

    fn read_directory(&self, context: &Handle, _pattern: Option<&U16CStr>, marker: DirMarker, buffer: &mut [u8]) -> Result<u32> {
        if marker.is_none() {
            // first read: the whole listing into WinFsp's DirBuffer (it sorts, filters by pattern and continues from the marker)
            let (v, _) = self.call(json!({"op": "readdir", "path": context.path}), &[])?;
            let lock = context.entries.acquire(true, None)?;
            let mut entry: DirInfo = DirInfo::new();
            let mut add = |name: &str, v: &Value| -> Result<()> {
                entry.reset();
                fill(entry.file_info_mut(), v);
                // without a trailing NUL: set_name writes it into the name, so continuing the listing from the marker
                // ("name" < "name\0") always returns the last entry again and WinFsp loops forever (listings over
                // ~64 KB, about 480 files)
                let wide: Vec<u16> = name.encode_utf16().collect();
                entry.set_name_raw(wide.as_slice())?;
                lock.write(&mut entry)
            };
            let here = json!({"kind": "dir"});
            if !context.path.is_empty() {
                add(".", &here)?;
                add("..", &here)?;
            }
            for e in v.get("entries").and_then(Value::as_array).into_iter().flatten() {
                if let Some(name) = e.get("name").and_then(Value::as_str) {
                    add(name, e)?;
                }
            }
        }
        Ok(context.entries.read(marker, buffer))
    }

    fn rename(&self, _context: &Handle, file_name: &U16CStr, new_file_name: &U16CStr, replace_if_exists: bool) -> Result<()> {
        let (from, to) = (rel(file_name), rel(new_file_name));
        if !replace_if_exists && self.getattr(&to).is_ok() {
            return Err(nt(STATUS_OBJECT_NAME_COLLISION));
        }
        self.call(json!({"op": "rename", "from": from, "to": to}), &[])?;
        Ok(())
    }

    fn set_basic_info(
        &self,
        context: &Handle,
        _file_attributes: u32,
        _creation_time: u64,
        _last_access_time: u64,
        _last_write_time: u64,
        _last_change_time: u64,
        file_info: &mut FileInfo,
    ) -> Result<()> {
        self.info(&context.path, file_info) // times and attributes come from the browsing computer; changes are ignored
    }

    fn set_delete(&self, context: &Handle, _file_name: &U16CStr, delete_file: bool) -> Result<()> {
        if delete_file && context.dir {
            let (v, _) = self.call(json!({"op": "readdir", "path": context.path}), &[])?;
            if v.get("entries").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                return Err(nt(STATUS_DIRECTORY_NOT_EMPTY));
            }
        }
        Ok(())
    }

    fn set_file_size(&self, context: &Handle, new_size: u64, set_allocation_size: bool, file_info: &mut FileInfo) -> Result<()> {
        if !set_allocation_size {
            self.call(json!({"op": "truncate", "path": context.path, "size": new_size}), &[])?;
            context.dirty.store(true, Ordering::Relaxed);
        }
        self.info(&context.path, file_info)
    }

    fn read(&self, context: &Handle, buffer: &mut [u8], offset: u64) -> Result<u32> {
        let (_, data) = self.call(json!({"op": "read", "path": context.path, "off": offset, "len": buffer.len()}), &[])?;
        if data.is_empty() && !buffer.is_empty() {
            return Err(nt(STATUS_END_OF_FILE));
        }
        let n = data.len().min(buffer.len());
        buffer[..n].copy_from_slice(&data[..n]);
        Ok(n as u32)
    }

    fn write(
        &self,
        context: &Handle,
        buffer: &[u8],
        offset: u64,
        write_to_eof: bool,
        constrained_io: bool,
        file_info: &mut FileInfo,
    ) -> Result<u32> {
        let mut data = buffer;
        let mut offset = offset;
        if write_to_eof || constrained_io {
            let size = self.getattr(&context.path)?.get("size").and_then(Value::as_u64).unwrap_or(0);
            if write_to_eof {
                offset = size;
            }
            if constrained_io { // paging I/O must not grow the file
                if offset >= size {
                    return self.info(&context.path, file_info).map(|_| 0);
                }
                data = &data[..data.len().min((size - offset) as usize)];
            }
        }
        self.call(json!({"op": "write", "path": context.path, "off": offset}), data)?;
        context.dirty.store(true, Ordering::Relaxed);
        self.info(&context.path, file_info)?;
        Ok(data.len() as u32)
    }

    fn get_volume_info(&self, out_volume_info: &mut VolumeInfo) -> Result<()> {
        // the real space is on the browsing computer; report enough that programs don't give up writing
        out_volume_info.total_size = 1 << 40;
        out_volume_info.free_size = 1 << 39;
        out_volume_info.set_volume_label("rrweb");
        Ok(())
    }
}

/// Security descriptor: owner Administrators, everyone (WD) may do everything, like 0644/0755 without user checks on Linux
fn security_descriptor() -> Vec<u8> {
    let mut psd = PSECURITY_DESCRIPTOR::default();
    let mut len = 0u32;
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;WD)"),
            SDDL_REVISION_1,
            &mut psd,
            Some(&mut len as *mut u32),
        )
        .expect("security descriptor");
        let sd = std::slice::from_raw_parts(psd.0 as *const u8, len as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(psd.0)));
        sd
    }
}

pub fn run(mountpoint: &str, link: Arc<Link>) {
    if let Err(e) = load_winfsp() {
        eprintln!("rrweb-fuse: {e}");
        std::process::exit(1);
    }
    let mut params = VolumeParams::new();
    params
        .filesystem_name("rrweb")
        .sector_size(4096)
        .sectors_per_allocation_unit(1)
        .max_component_length(255)
        .file_info_timeout(1000)
        // case-sensitive: otherwise WinFsp sends some names (e.g. the source of a rename) in upper case, while the
        // folder on the browsing computer (and the relay's listing) is case-sensitive; RapidRAW uses the exact names
        .case_sensitive_search(true)
        .case_preserved_names(true)
        .unicode_on_disk(true)
        .persistent_acls(true)
        .post_cleanup_when_modified_only(true);
    let fs = Fs { link: link.clone(), sd: security_descriptor() };
    let mut host: FileSystemHost<Fs, FineGuard> = FileSystemHost::new(params, fs).unwrap_or_else(|e| {
        eprintln!("rrweb-fuse: WinFsp: {e:?}");
        std::process::exit(1);
    });
    if let Err(e) = host.mount(mountpoint) {
        eprintln!("rrweb-fuse: mount {mountpoint}: {e:?}");
        std::process::exit(1);
    }
    // operations wait for the network; the others must not stall
    if let Err(e) = host.start_with_threads(16) {
        eprintln!("rrweb-fuse: start: {e:?}");
        std::process::exit(1);
    }
    link.mounted();
    link.read_replies();
    host.stop();
    host.unmount();
}
