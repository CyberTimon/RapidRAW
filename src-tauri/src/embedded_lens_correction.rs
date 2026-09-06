//! Lens correction data embedded in RAW files by the camera manufacturer.
//!
//! Each vendor adapter fills the same table in [`EmbeddedLensProfile`]. The
//! image pipeline reads only that table. To add a vendor, write one
//! `adapt_*` function and one branch in [`load_embedded_profile`].
//!
//! Format references:
//! - DNG: Adobe DNG Specification 1.7, "Opcode List". Opcodes
//!   `WarpRectilinear` (id 1) and `FixVignetteRadial` (id 3). Cross-checked
//!   against the Adobe DNG SDK, `dng_opcodes.cpp`.
//! - Panasonic: tag 0x0119, as decoded by ExifTool (`Panasonic.pm`,
//!   `DistortionInfo`) and darktable (`dt_image_correction_data_t`).
//!
//! The formulas are facts and are free to use. This code is written from
//! scratch.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use rawler::formats::tiff::{GenericTiffReader, Value, reader::TiffReader};
use serde::Serialize;

pub const PROFILE_KNOTS: usize = 64;

const TAG_OPCODE_LIST_2: u16 = 51009;
const TAG_OPCODE_LIST_3: u16 = 51022;
const TAG_PANASONIC_DISTORTION: u16 = 0x0119;

const OPCODE_WARP_RECTILINEAR: u32 = 1;
const OPCODE_FIX_VIGNETTE_RADIAL: u32 = 3;

const CACHE_LIMIT: usize = 64;

/// Vendor independent lens correction data.
///
/// All curves are tabulated over the radius. The radius is normalized to the
/// half diagonal of the image. The knots are evenly spaced from 0.0 to 1.0.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedLensProfile {
    pub source: String,
    /// Multiplier Rd/Ru per channel, in the order R, G, B. This covers
    /// distortion and lateral chromatic aberration.
    pub radial: [Vec<f32>; 3],
    /// Gain that compensates the vignetting.
    pub vignette: Vec<f32>,
    pub has_distortion: bool,
    pub has_tca: bool,
    pub has_vignette: bool,
}

/// Summary for the user interface. The tables stay in the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedLensProfileInfo {
    pub source: String,
    pub has_distortion: bool,
    pub has_tca: bool,
    pub has_vignette: bool,
}

impl EmbeddedLensProfile {
    fn neutral(source: &str) -> Self {
        Self {
            source: source.to_string(),
            radial: [
                vec![1.0; PROFILE_KNOTS],
                vec![1.0; PROFILE_KNOTS],
                vec![1.0; PROFILE_KNOTS],
            ],
            vignette: vec![1.0; PROFILE_KNOTS],
            has_distortion: false,
            has_tca: false,
            has_vignette: false,
        }
    }

    fn detect_features(&mut self) {
        const EPS: f32 = 1e-6;
        self.has_distortion = self.radial[1].iter().any(|v| (v - 1.0).abs() > EPS);
        self.has_tca = self.radial[1]
            .iter()
            .zip(self.radial[0].iter().zip(self.radial[2].iter()))
            .any(|(g, (r, b))| (r - g).abs() > EPS || (b - g).abs() > EPS);
        self.has_vignette = self.vignette.iter().any(|v| (v - 1.0).abs() > EPS);
    }

    fn is_empty(&self) -> bool {
        !self.has_distortion && !self.has_tca && !self.has_vignette
    }

    pub fn info(&self) -> EmbeddedLensProfileInfo {
        EmbeddedLensProfileInfo {
            source: self.source.clone(),
            has_distortion: self.has_distortion,
            has_tca: self.has_tca,
            has_vignette: self.has_vignette,
        }
    }

    /// Multiplier Rd/Ru for one channel. `plane` is 0 = R, 1 = G, 2 = B.
    #[inline]
    pub fn radial_at(&self, plane: usize, r: f32) -> f32 {
        sample_curve(&self.radial[plane.min(2)], r)
    }

    #[inline]
    pub fn vignette_at(&self, r: f32) -> f32 {
        sample_curve(&self.vignette, r)
    }
}

/// Linear interpolation over evenly spaced knots from 0.0 to 1.0.
/// A radius above 1.0 clamps to the last knot.
#[inline]
fn sample_curve(curve: &[f32], r: f32) -> f32 {
    let n = curve.len();
    if n == 0 {
        return 1.0;
    }
    if n == 1 {
        return curve[0];
    }
    let last = (n - 1) as f32;
    let t = (r.max(0.0) * last).min(last);
    let i = t as usize;
    if i >= n - 1 {
        return curve[n - 1];
    }
    let f = t - i as f32;
    curve[i] + (curve[i + 1] - curve[i]) * f
}

#[inline]
fn knot_radius(i: usize) -> f64 {
    i as f64 / (PROFILE_KNOTS - 1) as f64
}

fn be_u32(buf: &[u8], off: usize) -> Option<u32> {
    let slice = buf.get(off..off + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn be_f64(buf: &[u8], off: usize) -> Option<f64> {
    let slice = buf.get(off..off + 8)?;
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(slice);
    Some(f64::from_be_bytes(bytes))
}

/// Reads the embedded correction data of a RAW file.
/// Returns `None` if the file has no usable data.
pub fn load_embedded_profile(path: &Path) -> Option<EmbeddedLensProfile> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let tiff = GenericTiffReader::new(&mut reader, 0, 0, None, &[]).ok()?;

    // DNG opcodes are an open standard. Check them for every file.
    if let Some(profile) = adapt_dng(&tiff) {
        return Some(profile);
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "rw2" || ext == "rwl" {
        return adapt_panasonic(&tiff);
    }

    None
}

/// Removes the virtual copy suffix. All copies of a file share one profile.
pub fn source_path_of(virtual_path: &str) -> &str {
    match virtual_path.rsplit_once("?vc=") {
        Some((base, _)) => base,
        None => virtual_path,
    }
}

static PROFILE_CACHE: Lazy<Mutex<HashMap<PathBuf, Option<Arc<EmbeddedLensProfile>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Returns the profile of a file from the cache. The file is read once.
/// A negative result is cached too, so files without data are read once only.
pub fn cached_profile(path: &str) -> Option<Arc<EmbeddedLensProfile>> {
    let path = source_path_of(path);
    if path.is_empty() {
        return None;
    }
    let key = PathBuf::from(path);

    {
        let cache = PROFILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get(&key) {
            return entry.clone();
        }
    }

    let profile = load_embedded_profile(&key).map(Arc::new);

    let mut cache = PROFILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(key, profile.clone());
    profile
}

pub fn clear_profile_cache() {
    PROFILE_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

#[tauri::command]
pub fn get_embedded_lens_profile(path: String) -> Option<EmbeddedLensProfileInfo> {
    cached_profile(&path).map(|p| p.info())
}

/// The four radial coefficients per plane of `WarpRectilinear`.
/// The tangential terms c4 and c5 are not used.
#[derive(Debug, Clone, Copy, PartialEq)]
struct WarpRectilinear {
    coeff: [[f64; 4]; 3],
}

fn adapt_dng(tiff: &GenericTiffReader) -> Option<EmbeddedLensProfile> {
    let mut warp: Option<WarpRectilinear> = None;
    let mut vignette: Option<[f64; 5]> = None;

    for tag in [TAG_OPCODE_LIST_2, TAG_OPCODE_LIST_3] {
        for ifd in tiff.find_ifds_with_tag(tag) {
            let Some(entry) = ifd.get_entry(tag) else {
                continue;
            };
            let buf: &[u8] = match &entry.value {
                Value::Undefined(v) => v,
                Value::Byte(v) => v,
                _ => continue,
            };
            parse_opcode_list(buf, &mut warp, &mut vignette);
        }
    }

    if warp.is_none() && vignette.is_none() {
        return None;
    }

    let mut profile = EmbeddedLensProfile::neutral("DNG");

    if let Some(warp) = warp {
        for i in 0..PROFILE_KNOTS {
            let r2 = knot_radius(i).powi(2);
            for plane in 0..3 {
                let c = warp.coeff[plane];
                profile.radial[plane][i] = (c[0] + r2 * (c[1] + r2 * (c[2] + r2 * c[3]))) as f32;
            }
        }
    }

    if let Some(k) = vignette {
        for i in 0..PROFILE_KNOTS {
            let r2 = knot_radius(i).powi(2);
            // g = 1 + k0*r^2 + k1*r^4 + k2*r^6 + k3*r^8 + k4*r^10.
            // The DNG reader multiplies the pixel value by this gain.
            profile.vignette[i] =
                (1.0 + r2 * (k[0] + r2 * (k[1] + r2 * (k[2] + r2 * (k[3] + r2 * k[4]))))) as f32;
        }
    }

    profile.detect_features();
    if profile.is_empty() {
        return None;
    }
    Some(profile)
}

/// Reads a DNG opcode list. The content is big endian, whatever the byte
/// order of the file is.
fn parse_opcode_list(
    buf: &[u8],
    warp: &mut Option<WarpRectilinear>,
    vignette: &mut Option<[f64; 5]>,
) {
    let Some(count) = be_u32(buf, 0) else {
        return;
    };

    // Header per opcode: id, version, flags, param_size. Each is 4 bytes.
    let mut off = 4usize;
    for _ in 0..count {
        let Some(id) = be_u32(buf, off) else {
            return;
        };
        let Some(param_size) = be_u32(buf, off + 12) else {
            return;
        };
        let start = off + 16;
        let Some(end) = start.checked_add(param_size as usize) else {
            return;
        };
        let Some(params) = buf.get(start..end) else {
            return;
        };

        match id {
            OPCODE_WARP_RECTILINEAR if warp.is_none() => *warp = parse_warp_rectilinear(params),
            OPCODE_FIX_VIGNETTE_RADIAL if vignette.is_none() => {
                *vignette = parse_fix_vignette_radial(params)
            }
            _ => {}
        }

        off = end;
    }
}

fn parse_warp_rectilinear(params: &[u8]) -> Option<WarpRectilinear> {
    let planes = be_u32(params, 0)? as usize;
    if planes != 1 && planes != 3 {
        return None;
    }

    // Layout: planes (uint32), then 6 doubles per plane, then the center.
    let mut coeff = [[0.0f64; 4]; 3];
    for (plane, terms) in coeff.iter_mut().take(planes).enumerate() {
        for (i, term) in terms.iter_mut().enumerate() {
            *term = be_f64(params, 4 + 8 * (i + plane * 6))?;
        }
    }

    if planes == 1 {
        coeff[1] = coeff[0];
        coeff[2] = coeff[0];
    }

    Some(WarpRectilinear { coeff })
}

fn parse_fix_vignette_radial(params: &[u8]) -> Option<[f64; 5]> {
    let mut k = [0.0f64; 5];
    for (i, slot) in k.iter_mut().enumerate() {
        *slot = be_f64(params, 8 * i)?;
    }
    Some(k)
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PanasonicDistortion {
    a: f64,
    b: f64,
    c: f64,
    scale: f64,
}

fn adapt_panasonic(tiff: &GenericTiffReader) -> Option<EmbeddedLensProfile> {
    let entry = tiff.get_entry(TAG_PANASONIC_DISTORTION)?;
    let bytes: &[u8] = match &entry.value {
        Value::Undefined(v) => v,
        Value::Byte(v) => v,
        _ => return None,
    };

    let dist = parse_panasonic_distortion(bytes)?;

    let mut profile = EmbeddedLensProfile::neutral("Panasonic");
    for i in 0..PROFILE_KNOTS {
        let ru = knot_radius(i);
        let m = if ru > 0.0 {
            (panasonic_solve_rd(&dist, ru) / ru) as f32
        } else {
            1.0
        };
        profile.radial[0][i] = m;
        profile.radial[1][i] = m;
        profile.radial[2][i] = m;
    }

    // Panasonic gives no data for vignetting and chromatic aberration.
    profile.detect_features();
    if profile.is_empty() {
        return None;
    }
    Some(profile)
}

/// Reads Panasonic tag 0x0119 as `int16[16]`, little endian.
fn parse_panasonic_distortion(bytes: &[u8]) -> Option<PanasonicDistortion> {
    if bytes.len() < 32 {
        return None;
    }
    let v: Vec<i16> = bytes[..32]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| i16::from_le_bytes(*c))
        .collect();

    // The low four bits of v[7] enable the correction.
    if (v[7] & 0x0f) != 1 {
        return None;
    }

    const UNIT: f64 = 32768.0;
    let dist = PanasonicDistortion {
        a: v[8] as f64 / UNIT,
        b: v[4] as f64 / UNIT,
        c: v[11] as f64 / UNIT,
        scale: 1.0 / (1.0 + v[5] as f64 / UNIT),
    };

    if dist.a.abs() < 1e-9 && dist.b.abs() < 1e-9 && dist.c.abs() < 1e-9 {
        return None;
    }
    if !dist.scale.is_finite() {
        return None;
    }
    Some(dist)
}

/// Panasonic forward formula: Ru from Rd.
#[inline]
fn panasonic_forward(dist: &PanasonicDistortion, rd: f64) -> f64 {
    let rd2 = rd * rd;
    rd + dist.scale * rd * rd2 * (dist.a + rd2 * (dist.b + rd2 * dist.c))
}

/// Inverts the forward formula: Rd from Ru.
///
/// The pipeline needs the source position for each point of the corrected
/// image. Newton's method solves this to machine precision. The table is
/// built once per file, thus the run time does not matter.
fn panasonic_solve_rd(dist: &PanasonicDistortion, ru: f64) -> f64 {
    let mut rd = ru;
    for _ in 0..32 {
        let value = panasonic_forward(dist, rd) - ru;
        let rd2 = rd * rd;
        let slope =
            1.0 + dist.scale * rd2 * (3.0 * dist.a + rd2 * (5.0 * dist.b + 7.0 * rd2 * dist.c));
        if slope.abs() < 1e-12 {
            break;
        }
        let delta = value / slope;
        rd -= delta;
        if delta.abs() < 1e-12 {
            break;
        }
    }
    rd.max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Content of tag 0x0119 in `P1030559.RW2`, Panasonic DMC-LX15 at 8.8 mm.
    const LX15_TAG_0119: [u8; 32] = [
        0xc1, 0x51, 0xfd, 0xe5, 0x5a, 0x00, 0x00, 0x00, 0x8b, 0xfa, 0x00, 0x00, 0x6c, 0x00, 0x01,
        0x00, 0xf6, 0x23, 0x6f, 0x02, 0xfc, 0x01, 0xea, 0xff, 0xd8, 0x0c, 0x63, 0x04, 0x87, 0x03,
        0xb8, 0xbb,
    ];

    #[test]
    fn panasonic_values_from_lx15() {
        let dist = parse_panasonic_distortion(&LX15_TAG_0119).expect("tag must be readable");
        assert!((dist.a - 0.280945).abs() < 1e-6, "a = {}", dist.a);
        assert!((dist.b - -0.042633).abs() < 1e-6, "b = {}", dist.b);
        assert!((dist.c - -0.000671).abs() < 1e-6, "c = {}", dist.c);
        assert!((dist.scale - 1.0).abs() < 1e-9, "scale = {}", dist.scale);
    }

    #[test]
    fn panasonic_inverse_is_consistent() {
        let dist = parse_panasonic_distortion(&LX15_TAG_0119).unwrap();
        for i in 0..=100 {
            let ru = i as f64 / 100.0;
            let rd = panasonic_solve_rd(&dist, ru);
            let back = panasonic_forward(&dist, rd);
            assert!(
                (back - ru).abs() < 1e-4,
                "ru = {}, rd = {}, back = {}",
                ru,
                rd,
                back
            );
        }
    }

    #[test]
    fn panasonic_multiplier_at_edge_and_center() {
        let dist = parse_panasonic_distortion(&LX15_TAG_0119).unwrap();
        // Converged solution of 1 = rd + a*rd^3 + b*rd^5 + c*rd^7.
        let rd = panasonic_solve_rd(&dist, 1.0);
        assert!((rd - 0.847723).abs() < 1e-5, "rd(1) = {}", rd);

        let mut profile = EmbeddedLensProfile::neutral("Panasonic");
        for i in 0..PROFILE_KNOTS {
            let ru = knot_radius(i);
            let m = if ru > 0.0 {
                (panasonic_solve_rd(&dist, ru) / ru) as f32
            } else {
                1.0
            };
            profile.radial[0][i] = m;
            profile.radial[1][i] = m;
            profile.radial[2][i] = m;
        }
        profile.detect_features();

        assert!((profile.radial_at(1, 0.0) - 1.0).abs() < 1e-6);
        assert!((profile.radial_at(1, 1.0) - 0.847723).abs() < 1e-4);
        assert!(profile.has_distortion);
        assert!(!profile.has_tca);
        assert!(!profile.has_vignette);
    }

    #[test]
    fn panasonic_rejects_disabled_correction() {
        let mut bytes = LX15_TAG_0119;
        bytes[14] = 0x00; // v[7] = 0
        assert!(parse_panasonic_distortion(&bytes).is_none());
    }

    fn build_opcode_list(opcodes: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(opcodes.len() as u32).to_be_bytes());
        for (id, params) in opcodes {
            buf.extend_from_slice(&id.to_be_bytes());
            buf.extend_from_slice(&0x0104_0000u32.to_be_bytes());
            buf.extend_from_slice(&0u32.to_be_bytes());
            buf.extend_from_slice(&(params.len() as u32).to_be_bytes());
            buf.extend_from_slice(params);
        }
        buf
    }

    fn warp_params(planes: &[[f64; 6]], center: [f64; 2]) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&(planes.len() as u32).to_be_bytes());
        for plane in planes {
            for c in plane {
                p.extend_from_slice(&c.to_be_bytes());
            }
        }
        for c in center {
            p.extend_from_slice(&c.to_be_bytes());
        }
        p
    }

    fn vignette_params(k: [f64; 5], center: [f64; 2]) -> Vec<u8> {
        let mut p = Vec::new();
        for v in k {
            p.extend_from_slice(&v.to_be_bytes());
        }
        for v in center {
            p.extend_from_slice(&v.to_be_bytes());
        }
        p
    }

    #[test]
    fn dng_opcode_list_is_read() {
        // Values from a real file of an Autel Robotics XL724 drone.
        let warp = warp_params(
            &[
                [1.00011940, 0.00035049, -0.00022072, 0.00005198, 0.0, 0.0],
                [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                [1.00081028, -0.00071436, 0.00038986, -0.00007397, 0.0, 0.0],
            ],
            [0.5, 0.5],
        );
        let vig = vignette_params([0.38870047, 0.0, 0.0, 0.0, 0.23910276], [0.5, 0.5]);

        let list3 = build_opcode_list(&[(OPCODE_WARP_RECTILINEAR, warp)]);
        let list2 = build_opcode_list(&[(OPCODE_FIX_VIGNETTE_RADIAL, vig)]);

        let mut w = None;
        let mut v = None;
        parse_opcode_list(&list2, &mut w, &mut v);
        parse_opcode_list(&list3, &mut w, &mut v);

        let w = w.expect("WarpRectilinear must be read");
        assert!((w.coeff[0][0] - 1.00011940).abs() < 1e-12);
        assert!((w.coeff[1][0] - 1.0).abs() < 1e-12);
        assert!((w.coeff[2][3] - -0.00007397).abs() < 1e-12);

        let v = v.expect("FixVignetteRadial must be read");
        assert!((v[0] - 0.38870047).abs() < 1e-12);
        assert!((v[4] - 0.23910276).abs() < 1e-12);

        // The gain at the corner must brighten, not darken.
        let gain = 1.0 + v[0] + v[1] + v[2] + v[3] + v[4];
        assert!(gain > 1.0, "gain = {}", gain);
        assert!((gain - 1.62780323).abs() < 1e-6);
    }

    #[test]
    fn dng_single_plane_applies_to_all_channels() {
        let warp = warp_params(&[[1.0, -0.05, 0.01, 0.0, 0.0, 0.0]], [0.5, 0.5]);
        let list = build_opcode_list(&[(OPCODE_WARP_RECTILINEAR, warp)]);
        let mut w = None;
        let mut v = None;
        parse_opcode_list(&list, &mut w, &mut v);
        let w = w.unwrap();
        assert_eq!(w.coeff[0], w.coeff[1]);
        assert_eq!(w.coeff[1], w.coeff[2]);
        assert!(v.is_none());
    }

    #[test]
    fn dng_truncated_list_does_not_panic() {
        let warp = warp_params(&[[1.0, -0.05, 0.0, 0.0, 0.0, 0.0]], [0.5, 0.5]);
        let list = build_opcode_list(&[(OPCODE_WARP_RECTILINEAR, warp)]);
        for cut in 0..list.len() {
            let mut w = None;
            let mut v = None;
            parse_opcode_list(&list[..cut], &mut w, &mut v);
        }
    }

    #[test]
    fn curve_is_interpolated_linearly() {
        let curve: Vec<f32> = (0..PROFILE_KNOTS).map(|i| i as f32).collect();
        assert!((sample_curve(&curve, 0.0) - 0.0).abs() < 1e-5);
        assert!((sample_curve(&curve, 1.0) - 63.0).abs() < 1e-5);
        let mid = sample_curve(&curve, 0.5 / 63.0);
        assert!((mid - 0.5).abs() < 1e-4, "mid = {}", mid);
        assert!((sample_curve(&curve, 2.0) - 63.0).abs() < 1e-5);
        assert!((sample_curve(&curve, -1.0) - 0.0).abs() < 1e-5);
    }

    /// Checks a real file if an environment variable holds its path.
    /// The test is skipped if the variable is not set.
    fn check_real_file(var: &str, expected_source: &str) {
        let Ok(path) = std::env::var(var) else {
            eprintln!("{} is not set, test skipped", var);
            return;
        };
        let profile = load_embedded_profile(Path::new(&path))
            .unwrap_or_else(|| panic!("{} must give embedded data", path));
        assert_eq!(profile.source, expected_source);
        assert_eq!(profile.radial[0].len(), PROFILE_KNOTS);
        assert_eq!(profile.vignette.len(), PROFILE_KNOTS);

        // The green channel carries the distortion. There is no distortion
        // at the image center.
        assert!(
            (profile.radial_at(1, 0.0) - 1.0).abs() < 1e-5,
            "green channel at center: {}",
            profile.radial_at(1, 0.0)
        );

        // A lateral chromatic aberration is a difference in scale. Thus the
        // multiplier of red and blue can differ from 1.0 at the center.
        for plane in 0..3 {
            for step in 0..=20 {
                let r = step as f32 / 20.0;
                let m = profile.radial_at(plane, r);
                assert!(
                    (0.5..=1.5).contains(&m),
                    "channel {} at r = {}: multiplier {} is out of range",
                    plane,
                    r,
                    m
                );
            }
        }

        eprintln!(
            "{}: source {}, distortion {}, tca {}, vignette {}, \
             multiplier at edge R={:.6} G={:.6} B={:.6}, vignette at edge {:.6}",
            path,
            profile.source,
            profile.has_distortion,
            profile.has_tca,
            profile.has_vignette,
            profile.radial_at(0, 1.0),
            profile.radial_at(1, 1.0),
            profile.radial_at(2, 1.0),
            profile.vignette_at(1.0),
        );
    }

    #[test]
    fn real_rw2_file() {
        check_real_file("RAPIDRAW_TEST_RW2", "Panasonic");
    }

    #[test]
    fn real_dng_file() {
        check_real_file("RAPIDRAW_TEST_DNG", "DNG");
    }

    /// Checks that a file without embedded data gives `None`.
    #[test]
    fn file_without_embedded_data() {
        let Ok(path) = std::env::var("RAPIDRAW_TEST_NO_PROFILE") else {
            eprintln!("RAPIDRAW_TEST_NO_PROFILE is not set, test skipped");
            return;
        };
        assert!(
            load_embedded_profile(Path::new(&path)).is_none(),
            "{} must not give a profile",
            path
        );
        eprintln!("{}: no embedded profile, the fallback applies", path);
    }

    #[test]
    fn non_tiff_file_returns_none() {
        let dir = std::env::temp_dir().join("rapidraw_embedded_lens_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not_a_raw.txt");
        std::fs::write(&path, b"This is not a TIFF file.").unwrap();
        assert!(load_embedded_profile(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }
}
