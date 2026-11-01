// Invalid command-line export arguments must fail with exit code 2 before the app starts, so this
// also runs on machines without a display.

use std::process::Command;

#[test]
fn invalid_tiff_bit_depth_exits_with_code_2() {
    for value in [&["12"][..], &["abc"], &[]] {
        let output = Command::new(env!("CARGO_BIN_EXE_RapidRAW"))
            .args(["export", "photo.png", "--output"])
            .arg(std::env::temp_dir())
            .arg("--tiff-bit-depth")
            .args(value)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(2), "{value:?}: {stderr}");
        assert!(stderr.contains("expected 8 or 16"), "{value:?}: {stderr}");
    }
}
