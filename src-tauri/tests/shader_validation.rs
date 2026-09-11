//! Compile the WGSL shaders at test time.
//!
//! Shader errors otherwise only surface when a GPU pipeline is built at
//! runtime, which means a typo or a uniform layout mistake ships as a blank
//! canvas rather than a failing build.

use naga::valid::{Capabilities, ValidationFlags, Validator};

fn validate(name: &str, source: &str) {
    let module = match naga::front::wgsl::parse_str(source) {
        Ok(module) => module,
        Err(e) => panic!("{name} failed to parse:\n{}", e.emit_to_string(source)),
    };

    let mut validator = Validator::new(ValidationFlags::all(), Capabilities::all());
    if let Err(e) = validator.validate(&module) {
        panic!("{name} failed validation:\n{e:?}");
    }
}

#[test]
fn shaders_compile() {
    for (name, source) in [
        ("shader.wgsl", include_str!("../src/shaders/shader.wgsl")),
        ("display.wgsl", include_str!("../src/shaders/display.wgsl")),
        ("blur.wgsl", include_str!("../src/shaders/blur.wgsl")),
        ("flare.wgsl", include_str!("../src/shaders/flare.wgsl")),
    ] {
        validate(name, source);
    }
}
