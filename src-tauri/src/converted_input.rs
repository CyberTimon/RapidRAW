//! Decoders for rendered image formats that need a conversion step before they
//! can enter RapidRAW's editable RGB working pipeline.
//!
//! These inputs are not camera RAW files. Decoding is kept behind this module so
//! future container or codec integrations do not leak into the RAW developer.

use anyhow::{Result, bail};
use image::DynamicImage;
use std::path::Path;
use std::sync::{Arc, atomic::AtomicUsize};

#[cfg(target_os = "macos")]
#[path = "converted_input/heif.rs"]
mod heif;

type CancelToken = Option<(Arc<AtomicUsize>, usize)>;

struct Decoder {
    extensions: &'static [&'static str],
    decode: fn(&[u8], CancelToken) -> Result<DynamicImage>,
}

#[cfg(target_os = "macos")]
const DECODERS: &[Decoder] = &[Decoder {
    extensions: &["hif", "heic", "heif"],
    decode: heif::decode,
}];

#[cfg(not(target_os = "macos"))]
const DECODERS: &[Decoder] = &[];

pub fn decode(bytes: &[u8], path: &str, cancel_token: CancelToken) -> Result<DynamicImage> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();

    if let Some(decoder) = DECODERS.iter().find(|decoder| {
        decoder
            .extensions
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(extension))
    }) {
        return (decoder.decode)(bytes, cancel_token);
    }

    let _ = (bytes, cancel_token);
    bail!("No converted-input decoder is available for '{path}'")
}
