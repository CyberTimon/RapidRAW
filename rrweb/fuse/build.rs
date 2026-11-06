// Windows: winfsp-x64.dll is delay-loaded, only after src/windows.rs has found it in the WinFsp installation;
// otherwise rrweb-fuse.exe wouldn't even start on a computer without WinFsp (and --check wouldn't work).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let dll = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("aarch64") => "winfsp-a64",
            _ => "winfsp-x64",
        };
        println!("cargo:rustc-link-lib=dylib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}.dll");
    }
}
