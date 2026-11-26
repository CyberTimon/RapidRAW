use crate::render::agx::{hsv_to_rgb, rgb_to_hsv};
use crate::render::color_space::{OutputColorSpace, SRGB, TransferCurve};
use flate2::read::ZlibDecoder;
use glam::{DMat3, DVec3, Vec3 as HsvVec};
use std::fmt::Write as _;
use std::io::Read;

const BASE85: &[u8; 85] =
    b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?`'|()[]{}@%$#";

#[derive(Debug, Clone)]
pub struct LookTable {
    hue_divisions: usize,
    sat_divisions: usize,
    val_divisions: usize,
    data: Vec<[f32; 3]>,
    srgb_value_encoding: bool,
    pub min_amount: f64,
    pub max_amount: f64,
}

#[derive(Debug, Clone)]
pub struct RgbTable {
    divisions: usize,
    data: Vec<[f32; 3]>,
    primaries: OutputColorSpace,
    gamma: Option<TransferCurve>,
    gamut_extend: bool,
    strength: f64,
    pub min_amount: f64,
    pub max_amount: f64,
}

#[derive(Debug, Clone)]
pub enum ProfileTable {
    Look(LookTable),
    Rgb(RgbTable),
}

impl ProfileTable {
    pub fn amount_range(&self) -> (f64, f64) {
        match self {
            ProfileTable::Look(t) => (t.min_amount, t.max_amount),
            ProfileTable::Rgb(t) => (t.min_amount, t.max_amount),
        }
    }

    pub fn set_rgb_strength(&mut self, strength: f64) {
        if let ProfileTable::Rgb(t) = self {
            t.strength = strength.clamp(0.0, 1.0);
        }
    }
}

fn decode_base85(s: &str) -> Result<Vec<u8>, String> {
    let mut lookup = [255u8; 256];
    for (i, c) in BASE85.iter().enumerate() {
        lookup[*c as usize] = i as u8;
    }
    let digits: Vec<u8> = s
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .map(|b| match lookup[b as usize] {
            255 => Err(format!(
                "Invalid character '{}' in profile table",
                b as char
            )),
            d => Ok(d),
        })
        .collect::<Result<_, _>>()?;

    let mut out = Vec::with_capacity(digits.len() / 5 * 4 + 4);
    for group in digits.chunks(5) {
        let mut x: u64 = 0;
        for d in group.iter().rev() {
            x = x * 85 + *d as u64;
        }
        for _ in 0..group.len().saturating_sub(1).min(4) {
            out.push((x & 0xFF) as u8);
            x >>= 8;
        }
    }
    Ok(out)
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos + n;
        let slice = self
            .data
            .get(self.pos..end)
            .ok_or("Profile table is truncated")?;
        self.pos = end;
        Ok(slice)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }
}

const MAX_TABLE_BYTES: usize = 64 << 20;

pub fn decode_table(encoded: &str) -> Result<ProfileTable, String> {
    let bytes = decode_base85(encoded)?;
    if bytes.len() < 6 {
        return Err("Profile table is empty".into());
    }
    let expected = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let mut raw = Vec::with_capacity(expected.min(MAX_TABLE_BYTES));
    ZlibDecoder::new(&bytes[4..])
        .take(MAX_TABLE_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("Failed to inflate profile table: {}", e))?;
    if raw.len() > MAX_TABLE_BYTES {
        return Err("Profile table is too large".into());
    }

    let mut c = Cursor { data: &raw, pos: 0 };
    let kind = c.u32()?;
    let version = c.u32()?;
    match kind {
        0 => {
            let hue = c.u32()? as usize;
            let sat = c.u32()? as usize;
            let val = (c.u32()? as usize).max(1);
            let cells = hue
                .checked_mul(sat)
                .and_then(|n| n.checked_mul(val))
                .filter(|&n| n <= 1 << 20);
            let Some(cells) = cells.filter(|_| hue > 0 && sat >= 2) else {
                return Err("Unsupported look table dimensions".into());
            };
            let mut data = Vec::with_capacity(cells);
            for _ in 0..cells {
                data.push([c.f32()?, c.f32()?, c.f32()?]);
            }
            let encoding = if c.remaining() >= 4 { c.u32()? } else { 0 };
            let (min_amount, max_amount) = if version >= 2 && c.remaining() >= 16 {
                (c.f64()?, c.f64()?)
            } else {
                (0.0, 2.0)
            };
            Ok(ProfileTable::Look(LookTable {
                hue_divisions: hue,
                sat_divisions: sat,
                val_divisions: val,
                data,
                srgb_value_encoding: encoding == 1,
                min_amount,
                max_amount,
            }))
        }
        1 => {
            let dims = c.u32()?;
            let n = c.u32()? as usize;
            if dims != 3 || !(2..=64).contains(&n) {
                return Err(format!(
                    "Unsupported RGB table ({}D, {} divisions)",
                    dims, n
                ));
            }
            let identity = |i: usize| ((i * 0xFFFF + (n >> 1)) / (n - 1)) as u16;
            let mut data = Vec::with_capacity(n * n * n);
            for r in 0..n {
                for g in 0..n {
                    for b in 0..n {
                        let s = [
                            c.u16()?.wrapping_add(identity(r)),
                            c.u16()?.wrapping_add(identity(g)),
                            c.u16()?.wrapping_add(identity(b)),
                        ];
                        data.push(s.map(|v| v as f32 / 65535.0));
                    }
                }
            }
            let primaries = match c.u32().unwrap_or(0) {
                1 => OutputColorSpace::AdobeRgb,
                2 => OutputColorSpace::ProPhotoRgb,
                3 => OutputColorSpace::DisplayP3,
                4 => OutputColorSpace::Rec2020,
                _ => OutputColorSpace::Srgb,
            };
            let gamma = match c.u32().unwrap_or(1) {
                0 => None,
                2 => Some(TransferCurve::gamma(1.8)),
                3 => Some(TransferCurve::gamma(2.2)),
                4 => Some(TransferCurve::REC709),
                _ => Some(TransferCurve::SRGB),
            };
            let gamut_extend = c.u32().unwrap_or(0) == 1;
            let (min_amount, max_amount) = if c.remaining() >= 16 {
                (c.f64()?, c.f64()?)
            } else {
                (0.0, 1.0)
            };
            Ok(ProfileTable::Rgb(RgbTable {
                divisions: n,
                data,
                primaries,
                gamma,
                gamut_extend,
                strength: 1.0,
                min_amount,
                max_amount,
            }))
        }
        other => Err(format!("Unknown profile table type {}", other)),
    }
}

type Vec3 = [f64; 3];

fn transform(m: &DMat3, v: Vec3) -> Vec3 {
    (*m * DVec3::from_array(v)).to_array()
}

fn conversion(space: OutputColorSpace) -> (DMat3, DMat3) {
    (SRGB.to(space.rgb()), space.rgb().to(SRGB))
}

fn encode(curve: Option<TransferCurve>, v: f64) -> f64 {
    let v = v.max(0.0);
    curve.map_or(v, |c| c.encode(v as f32) as f64)
}

fn decode(curve: Option<TransferCurve>, v: f64) -> f64 {
    let v = v.max(0.0);
    curve.map_or(v, |c| c.decode(v as f32) as f64)
}

fn srgb_encode(v: f64) -> f64 {
    encode(Some(TransferCurve::SRGB), v)
}

fn srgb_decode(v: f64) -> f64 {
    decode(Some(TransferCurve::SRGB), v)
}

impl RgbTable {
    fn sample(&self, e: Vec3) -> Vec3 {
        let n = self.divisions;
        let max = (n - 1) as f64;
        let mut idx0 = [0usize; 3];
        let mut frac = [0.0f64; 3];
        for k in 0..3 {
            let x = e[k].clamp(0.0, 1.0) * max;
            let i = (x.floor() as usize).min(n - 2);
            idx0[k] = i;
            frac[k] = x - i as f64;
        }
        let at = |r: usize, g: usize, b: usize| self.data[(r * n + g) * n + b];
        let mut out = [0.0f64; 3];
        for (dr, wr) in [(0, 1.0 - frac[0]), (1, frac[0])] {
            for (dg, wg) in [(0, 1.0 - frac[1]), (1, frac[1])] {
                for (db, wb) in [(0, 1.0 - frac[2]), (1, frac[2])] {
                    let w = wr * wg * wb;
                    if w == 0.0 {
                        continue;
                    }
                    let s = at(idx0[0] + dr, idx0[1] + dg, idx0[2] + db);
                    for k in 0..3 {
                        out[k] += w * s[k] as f64;
                    }
                }
            }
        }
        out
    }

    fn apply(&self, srgb_linear: Vec3, conv: &(DMat3, DMat3)) -> Vec3 {
        let mut t = transform(&conv.0, srgb_linear);
        if !self.gamut_extend {
            t = t.map(|v| v.clamp(0.0, 1.0));
        }
        let encoded = t.map(|v| encode(self.gamma, v));
        let looked = self.sample(encoded);
        let mut result = [0.0; 3];
        for k in 0..3 {
            let clipped = encoded[k].clamp(0.0, 1.0);
            let blended = clipped + (looked[k] - clipped) * self.strength;
            result[k] = decode(self.gamma, blended + (encoded[k] - clipped));
        }
        transform(&conv.1, result)
    }
}

impl LookTable {
    fn lookup(&self, h: f64, s: f64, v_enc: f64) -> Vec3 {
        let hd = self.hue_divisions;
        let sd = self.sat_divisions;
        let vd = self.val_divisions;

        let h_scaled = h * hd as f64 / 6.0;
        let h0f = h_scaled.floor();
        let hf = h_scaled - h0f;
        let h0 = (h0f as usize) % hd;
        let h1 = (h0 + 1) % hd;

        let s_scaled = s.clamp(0.0, 1.0) * (sd - 1) as f64;
        let s0 = (s_scaled.floor() as usize).min(sd - 2);
        let sf = s_scaled - s0 as f64;

        let (v0, vf, v1) = if vd > 1 {
            let v_scaled = v_enc.clamp(0.0, 1.0) * (vd - 1) as f64;
            let v0 = (v_scaled.floor() as usize).min(vd - 2);
            (v0, v_scaled - v0 as f64, v0 + 1)
        } else {
            (0, 0.0, 0)
        };

        let at = |vi: usize, hi: usize, si: usize| self.data[vi * hd * sd + hi * sd + si];
        let mut out = [0.0; 3];
        for (vi, wv) in [(v0, 1.0 - vf), (v1, vf)] {
            for (hi, wh) in [(h0, 1.0 - hf), (h1, hf)] {
                for (si, ws) in [(s0, 1.0 - sf), (s0 + 1, sf)] {
                    let w = wv * wh * ws;
                    if w == 0.0 {
                        continue;
                    }
                    let d = at(vi, hi, si);
                    for k in 0..3 {
                        out[k] += w * d[k] as f64;
                    }
                }
            }
        }
        out
    }

    fn apply(&self, prophoto_linear: Vec3) -> Vec3 {
        let [r, g, b] = prophoto_linear.map(|c| c.max(0.0) as f32);
        let hsv = rgb_to_hsv(HsvVec::new(r, g, b));
        let (h, s, v) = (hsv.x as f64 * 6.0, hsv.y as f64, hsv.z as f64);
        let v_enc = if self.srgb_value_encoding {
            srgb_encode(v.min(1.0))
        } else {
            v
        };
        let [hue_shift, sat_scale, val_scale] = self.lookup(h, s, v_enc);
        let h = h + hue_shift * 6.0 / 360.0;
        let s = (s * sat_scale).clamp(0.0, 1.0);
        let v = if self.srgb_value_encoding {
            srgb_decode((v_enc * val_scale).clamp(0.0, 1.0)) + (v - v.min(1.0))
        } else {
            v * val_scale
        };
        let rgb = hsv_to_rgb(HsvVec::new((h / 6.0) as f32, s as f32, v as f32));
        [rgb.x as f64, rgb.y as f64, rgb.z as f64]
    }
}

pub fn bake_cube(title: &str, tables: &[&ProfileTable], size: usize) -> String {
    let prophoto = conversion(OutputColorSpace::ProPhotoRgb);
    let rgb_convs: Vec<Option<(DMat3, DMat3)>> = tables
        .iter()
        .map(|t| match t {
            ProfileTable::Rgb(r) => Some(conversion(r.primaries)),
            ProfileTable::Look(_) => None,
        })
        .collect();

    let mut out = String::with_capacity(size * size * size * 28 + 128);
    let _ = writeln!(out, "TITLE \"{}\"", title.replace('"', "'"));
    let _ = writeln!(out, "LUT_3D_SIZE {}", size);
    let _ = writeln!(out, "DOMAIN_MIN 0.0 0.0 0.0");
    let _ = writeln!(out, "DOMAIN_MAX 1.0 1.0 1.0");
    let step = 1.0 / (size - 1) as f64;
    for bi in 0..size {
        for gi in 0..size {
            for ri in 0..size {
                let encoded = [ri as f64 * step, gi as f64 * step, bi as f64 * step];
                let mut lin = encoded.map(srgb_decode);
                for (table, conv) in tables.iter().zip(&rgb_convs) {
                    lin = match (table, conv) {
                        (ProfileTable::Rgb(t), Some(conv)) => t.apply(lin, conv),
                        (ProfileTable::Look(t), _) => {
                            transform(&prophoto.1, t.apply(transform(&prophoto.0, lin)))
                        }
                        _ => lin,
                    };
                }
                let o = lin.map(|v| srgb_encode(v.clamp(0.0, 1.0)));
                let _ = writeln!(out, "{:.6} {:.6} {:.6}", o[0], o[1], o[2]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_base85(bytes: &[u8]) -> String {
        let mut out = String::new();
        for chunk in bytes.chunks(4) {
            let mut x: u64 = 0;
            for (i, b) in chunk.iter().enumerate() {
                x |= (*b as u64) << (8 * i);
            }
            for _ in 0..chunk.len() + 1 {
                out.push(BASE85[(x % 85) as usize] as char);
                x /= 85;
            }
        }
        out
    }

    fn encode_table(raw: &[u8]) -> String {
        use flate2::{Compression, write::ZlibEncoder};
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(raw).unwrap();
        let mut bytes = (raw.len() as u32).to_le_bytes().to_vec();
        bytes.extend(enc.finish().unwrap());
        encode_base85(&bytes)
    }

    #[test]
    fn oversized_look_table_is_rejected() {
        let mut raw = Vec::new();
        for v in [0u32, 1, 1 << 22, 1 << 22, 1 << 20] {
            raw.extend(v.to_le_bytes());
        }
        assert!(decode_table(&encode_table(&raw)).is_err());
    }

    #[test]
    fn huge_size_header_does_not_allocate() {
        let mut bytes = u32::MAX.to_le_bytes().to_vec();
        bytes.extend([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
        assert!(decode_table(&encode_base85(&bytes)).is_err());
    }

    #[test]
    fn identity_rgb_table_bakes_to_identity() {
        let n = 5usize;
        let mut raw = Vec::new();
        for v in [1u32, 1, 3, n as u32] {
            raw.extend(v.to_le_bytes());
        }
        raw.extend(vec![0u8; n * n * n * 6]);
        for v in [0u32, 1, 0] {
            raw.extend(v.to_le_bytes());
        }
        raw.extend(0f64.to_le_bytes());
        raw.extend(1f64.to_le_bytes());

        let table = decode_table(&encode_table(&raw)).unwrap();
        let cube = bake_cube("t", &[&table], 3);
        let values: Vec<f64> = cube
            .lines()
            .skip(4)
            .flat_map(|l| l.split_whitespace().map(|v| v.parse::<f64>().unwrap()))
            .collect();
        let expected = [0.0, 0.5, 1.0];
        for (i, chunk) in values.chunks(3).enumerate() {
            let (r, g, b) = (i % 3, (i / 3) % 3, i / 9);
            assert!((chunk[0] - expected[r]).abs() < 2e-3, "{:?}", chunk);
            assert!((chunk[1] - expected[g]).abs() < 2e-3);
            assert!((chunk[2] - expected[b]).abs() < 2e-3);
        }
    }

    #[test]
    fn rgb_table_amount_scales_effect() {
        let n = 2usize;
        let lift = (0.2 * 65535.0) as u16;
        let mut raw = Vec::new();
        for v in [1u32, 1, 3, n as u32] {
            raw.extend(v.to_le_bytes());
        }
        for _ in 0..n * n * n * 3 {
            raw.extend(lift.to_le_bytes());
        }
        for v in [0u32, 1, 0] {
            raw.extend(v.to_le_bytes());
        }
        let black = |strength: f64| {
            let mut table = decode_table(&encode_table(&raw)).unwrap();
            table.set_rgb_strength(strength);
            let cube = bake_cube("t", &[&table], 2);
            cube.lines()
                .nth(4)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
                .parse::<f64>()
                .unwrap()
        };
        assert!((black(1.0) - 0.2).abs() < 2e-3, "{}", black(1.0));
        assert!((black(0.5) - 0.1).abs() < 2e-3, "{}", black(0.5));
        assert!(black(0.0).abs() < 2e-3);
    }

    #[test]
    fn neutral_look_table_keeps_colors() {
        let (h, s, v) = (6u32, 2u32, 1u32);
        let mut raw = Vec::new();
        for x in [0u32, 1, h, s, v] {
            raw.extend(x.to_le_bytes());
        }
        for _ in 0..h * s * v {
            for f in [0f32, 1.0, 1.0] {
                raw.extend(f.to_le_bytes());
            }
        }
        raw.extend(0u32.to_le_bytes());
        let table = decode_table(&encode_table(&raw)).unwrap();
        let ProfileTable::Look(look) = &table else {
            panic!("expected look table")
        };
        let c = [0.2, 0.5, 0.1];
        let out = look.apply(c);
        for k in 0..3 {
            assert!((out[k] - c[k]).abs() < 1e-6);
        }
    }
}
