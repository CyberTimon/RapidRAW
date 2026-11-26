mod convert;
pub mod import;
mod tables;
mod xmp;

use crate::library::presets::Preset;
use import::ProfileIndex;

pub fn convert_xmp_to_preset(
    xmp_content: &str,
    profiles: Option<&ProfileIndex>,
) -> Result<Preset, String> {
    let doc = xmp::parse_crs(xmp_content)?;
    Ok(convert::convert(&doc, profiles).preset)
}
