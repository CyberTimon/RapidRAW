// Linux: FUSE through fuser (without libfuse, mounted through fusermount3)
use crate::{Link, Reply};
use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, LockOwner,
    MountOption, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::MetadataExt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(1);

pub fn check() -> Result<(), String> {
    if std::path::Path::new("/dev/fuse").exists() { Ok(()) } else { Err("/dev/fuse is missing".into()) }
}

fn call(link: &Link, head: Value, data: &[u8]) -> Result<Reply, Errno> {
    link.call(head, data).map_err(Errno::from_i32)
}

/// Inode ↔ path relative to the root of the shared folder ("" = root, separator "/")
struct Inodes {
    by_ino: HashMap<u64, String>,
    by_path: HashMap<String, u64>,
    next: u64,
}

impl Inodes {
    fn ino(&mut self, path: &str) -> u64 {
        if let Some(&ino) = self.by_path.get(path) {
            return ino;
        }
        self.next += 1;
        self.by_ino.insert(self.next, path.to_string());
        self.by_path.insert(path.to_string(), self.next);
        self.next
    }

    fn rename(&mut self, from: &str, to: &str) {
        let prefix = format!("{from}/");
        let moved: Vec<(String, u64)> = self.by_path.iter()
            .filter(|(p, _)| *p == from || p.starts_with(&prefix))
            .map(|(p, &i)| (p.clone(), i))
            .collect();
        for (old, ino) in moved {
            let new = format!("{to}{}", &old[from.len()..]);
            self.by_path.remove(&old);
            self.by_path.insert(new.clone(), ino);
            self.by_ino.insert(ino, new);
        }
    }
}

struct Fs {
    link: Arc<Link>,
    inodes: Mutex<Inodes>,
    uid: u32,
    gid: u32,
}

fn child(parent: &str, name: &OsStr) -> String {
    let name = name.to_string_lossy();
    if parent.is_empty() { name.into_owned() } else { format!("{parent}/{name}") }
}

impl Fs {
    fn path(&self, ino: INodeNo) -> Result<String, Errno> {
        self.inodes.lock().unwrap().by_ino.get(&ino.0).cloned().ok_or(Errno::ENOENT)
    }

    /// {"kind": "dir"|"file", "size", "mtime" (ms)} → FileAttr
    fn attr(&self, path: &str, v: &Value) -> FileAttr {
        let dir = v.get("kind").and_then(Value::as_str) == Some("dir");
        let size = v.get("size").and_then(Value::as_u64).unwrap_or(0);
        let mtime = UNIX_EPOCH + Duration::from_millis(v.get("mtime").and_then(Value::as_u64).unwrap_or(0));
        FileAttr {
            ino: INodeNo(self.inodes.lock().unwrap().ino(path)),
            size,
            blocks: size.div_ceil(512),
            atime: mtime,
            mtime,
            ctime: mtime,
            crtime: mtime,
            kind: if dir { FileType::Directory } else { FileType::RegularFile },
            perm: if dir { 0o755 } else { 0o644 },
            nlink: if dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 1 << 20,
            flags: 0,
        }
    }

    fn getattr_path(&self, path: &str) -> Result<FileAttr, Errno> {
        let (v, _) = call(&self.link, json!({"op": "getattr", "path": path}), &[])?;
        Ok(self.attr(path, &v))
    }
}

impl Filesystem for Fs {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        match self.path(parent).and_then(|p| self.getattr_path(&child(&p, name))) {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(e) => reply.error(e),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        match self.path(ino).and_then(|p| self.getattr_path(&p)) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn setattr(
        &self, _req: &Request, ino: INodeNo, _mode: Option<u32>, _uid: Option<u32>, _gid: Option<u32>,
        size: Option<u64>, _atime: Option<TimeOrNow>, _mtime: Option<TimeOrNow>, _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>, _crtime: Option<SystemTime>, _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>, _flags: Option<fuser::BsdFileFlags>, reply: ReplyAttr,
    ) {
        let result = self.path(ino).and_then(|p| {
            if let Some(size) = size {
                call(&self.link, json!({"op": "truncate", "path": p, "size": size}), &[])?;
            }
            self.getattr_path(&p)
        });
        match result {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn readdir(&self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        let path = match self.path(ino) {
            Ok(p) => p,
            Err(e) => return reply.error(e),
        };
        let entries = match call(&self.link, json!({"op": "readdir", "path": path}), &[]) {
            Ok((v, _)) => v.get("entries").and_then(Value::as_array).cloned().unwrap_or_default(),
            Err(e) => return reply.error(e),
        };
        let mut list = vec![(ino.0, FileType::Directory, ".".to_string()), (ino.0, FileType::Directory, "..".to_string())];
        {
            let mut inodes = self.inodes.lock().unwrap();
            for e in &entries {
                let name = e.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                let kind = if e.get("kind").and_then(Value::as_str) == Some("dir") { FileType::Directory } else { FileType::RegularFile };
                let p = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
                list.push((inodes.ino(&p), kind, name));
            }
        }
        for (i, (ino, kind, name)) in list.into_iter().enumerate().skip(offset as usize) {
            if reply.add(INodeNo(ino), (i + 1) as u64, kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&self, _req: &Request, _ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        reply.opened(FileHandle(0), FopenFlags::empty());
    }

    fn read(
        &self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, size: u32, _flags: OpenFlags,
        _lock_owner: Option<LockOwner>, reply: ReplyData,
    ) {
        let result = self.path(ino).and_then(|p| call(&self.link, json!({"op": "read", "path": p, "off": offset, "len": size}), &[]));
        match result {
            Ok((_, data)) => reply.data(&data),
            Err(e) => reply.error(e),
        }
    }

    fn write(
        &self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, data: &[u8], _write_flags: WriteFlags,
        _flags: OpenFlags, _lock_owner: Option<LockOwner>, reply: ReplyWrite,
    ) {
        let result = self.path(ino).and_then(|p| call(&self.link, json!({"op": "write", "path": p, "off": offset}), data));
        match result {
            Ok(_) => reply.written(data.len() as u32),
            Err(e) => reply.error(e),
        }
    }

    fn create(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, _mode: u32, _umask: u32, _flags: i32, reply: ReplyCreate,
    ) {
        let result = self.path(parent).and_then(|p| {
            let path = child(&p, name);
            let (v, _) = call(&self.link, json!({"op": "create", "path": path}), &[])?;
            Ok(self.attr(&path, &v))
        });
        match result {
            Ok(attr) => reply.created(&TTL, &attr, Generation(0), FileHandle(0), FopenFlags::empty()),
            Err(e) => reply.error(e),
        }
    }

    fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, _mode: u32, _umask: u32, reply: ReplyEntry) {
        let result = self.path(parent).and_then(|p| {
            let path = child(&p, name);
            let (v, _) = call(&self.link, json!({"op": "mkdir", "path": path}), &[])?;
            Ok(self.attr(&path, &v))
        });
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(e) => reply.error(e),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self.path(parent).and_then(|p| call(&self.link, json!({"op": "unlink", "path": child(&p, name)}), &[])) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self.path(parent).and_then(|p| call(&self.link, json!({"op": "rmdir", "path": child(&p, name)}), &[])) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rename(
        &self, _req: &Request, parent: INodeNo, name: &OsStr, newparent: INodeNo, newname: &OsStr, _flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let result = self.path(parent).and_then(|p| {
            let from = child(&p, name);
            let to = child(&self.path(newparent)?, newname);
            call(&self.link, json!({"op": "rename", "from": from, "to": to}), &[])?;
            self.inodes.lock().unwrap().rename(&from, &to);
            Ok(())
        });
        match result {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn flush(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _lock_owner: LockOwner, reply: ReplyEmpty) {
        reply.ok();
    }

    // On release the relay sends the changed file back to the browsing computer
    fn release(
        &self, _req: &Request, ino: INodeNo, _fh: FileHandle, _flags: OpenFlags, _lock_owner: Option<LockOwner>,
        _flush: bool, reply: ReplyEmpty,
    ) {
        match self.path(ino).and_then(|p| call(&self.link, json!({"op": "release", "path": p}), &[])) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn fsync(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _datasync: bool, reply: ReplyEmpty) {
        reply.ok();
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        // the real space is on the browsing computer; report enough that programs don't give up writing
        reply.statfs(1 << 30, 1 << 29, 1 << 29, 1 << 20, 1 << 19, 4096, 255, 4096);
    }
}

pub fn run(mountpoint: &str, link: Arc<Link>) {
    let meta = std::fs::metadata(mountpoint).unwrap_or_else(|e| {
        eprintln!("rrweb-fuse: {mountpoint}: {e}");
        std::process::exit(1);
    });
    let mut inodes = Inodes { by_ino: HashMap::new(), by_path: HashMap::new(), next: 1 };
    inodes.by_ino.insert(INodeNo::ROOT.0, String::new());
    inodes.by_path.insert(String::new(), INodeNo::ROOT.0);
    let fs = Fs { link: link.clone(), inodes: Mutex::new(inodes), uid: meta.uid(), gid: meta.gid() };

    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("rrweb".into()),
        MountOption::Subtype("rrweb".into()),
        MountOption::NoAtime,
        MountOption::NoDev,
        MountOption::NoSuid,
    ];
    config.n_threads = Some(8); // operations wait for the network; the others must not stall
    let session = fuser::spawn_mount(fs, mountpoint, &config).unwrap_or_else(|e| {
        eprintln!("rrweb-fuse: mount {mountpoint}: {e}");
        std::process::exit(1);
    });
    link.mounted();
    link.read_replies();
    if let Err(e) = session.umount_and_join() {
        // busy (RapidRAW keeps a file open): detach lazily, otherwise "Transport endpoint is not connected" stays
        eprintln!("rrweb-fuse: unmount: {e}; detaching lazily");
        let _ = std::process::Command::new("fusermount3").args(["-u", "-z", mountpoint]).status();
    }
}
