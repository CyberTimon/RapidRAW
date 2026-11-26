use crate::merge::raster::Raster;
use crate::render::color_space::WORKING;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use half::f16;
use rayon::prelude::*;
use std::io::Write;

const TILE_SIZE: usize = 256;
const CHANNELS: usize = 3;
const FLOATING_POINT_PREDICTOR: u16 = 3;
const DEFLATE: u16 = 8;
const LINEAR_RAW: u16 = 34892;
const ILLUMINANT_D65: u16 = 21;
const RATIONAL_DENOMINATOR: i32 = 1_000_000;

const BYTE: u16 = 1;
const ASCII: u16 = 2;
const SHORT: u16 = 3;
const LONG: u16 = 4;
const RATIONAL: u16 = 5;
const SRATIONAL: u16 = 10;

pub struct DngDescription<'a> {
    pub make: &'a str,
    pub model: &'a str,
    pub baseline_exposure: f32,
}

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    data: Vec<u8>,
}

impl Entry {
    fn shorts(tag: u16, values: &[u16]) -> Self {
        Entry {
            tag,
            kind: SHORT,
            count: values.len() as u32,
            data: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        }
    }

    fn longs(tag: u16, values: &[u32]) -> Self {
        Entry {
            tag,
            kind: LONG,
            count: values.len() as u32,
            data: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        }
    }

    fn bytes(tag: u16, values: &[u8]) -> Self {
        Entry {
            tag,
            kind: BYTE,
            count: values.len() as u32,
            data: values.to_vec(),
        }
    }

    fn ascii(tag: u16, text: &str) -> Self {
        let mut data: Vec<u8> = text.bytes().filter(|b| *b != 0).collect();
        data.push(0);
        Entry {
            tag,
            kind: ASCII,
            count: data.len() as u32,
            data,
        }
    }

    fn rationals(tag: u16, values: &[f64]) -> Self {
        Entry {
            tag,
            kind: RATIONAL,
            count: values.len() as u32,
            data: values
                .iter()
                .flat_map(|v| {
                    let n = (v.max(0.0) * RATIONAL_DENOMINATOR as f64).round() as u32;
                    [n.to_le_bytes(), (RATIONAL_DENOMINATOR as u32).to_le_bytes()].concat()
                })
                .collect(),
        }
    }

    fn signed_rationals(tag: u16, values: &[f64]) -> Self {
        Entry {
            tag,
            kind: SRATIONAL,
            count: values.len() as u32,
            data: values
                .iter()
                .flat_map(|v| {
                    let n = (v * RATIONAL_DENOMINATOR as f64).round() as i32;
                    [n.to_le_bytes(), RATIONAL_DENOMINATOR.to_le_bytes()].concat()
                })
                .collect(),
        }
    }
}

fn encode_tile(raster: &Raster, tile_x: usize, tile_y: usize) -> Result<Vec<u8>, String> {
    let row_samples = TILE_SIZE * CHANNELS;
    let mut halves = vec![0u16; row_samples];
    let mut row = vec![0u8; row_samples * 2];
    let mut encoder = ZlibEncoder::new(
        Vec::with_capacity(row_samples * TILE_SIZE),
        Compression::new(6),
    );
    for ty in 0..TILE_SIZE {
        let y = (tile_y * TILE_SIZE + ty).min(raster.height - 1);
        for tx in 0..TILE_SIZE {
            let x = (tile_x * TILE_SIZE + tx).min(raster.width - 1);
            let pixel = raster.pixel(x, y);
            for c in 0..CHANNELS {
                let value = if pixel[c].is_finite() {
                    pixel[c].max(0.0)
                } else {
                    0.0
                };
                halves[tx * CHANNELS + c] = f16::from_f32(value).to_bits();
            }
        }
        for (i, half) in halves.iter().enumerate() {
            row[i] = (half >> 8) as u8;
            row[row_samples + i] = (half & 0xff) as u8;
        }
        for i in (CHANNELS..row.len()).rev() {
            row[i] = row[i].wrapping_sub(row[i - CHANNELS]);
        }
        encoder
            .write_all(&row)
            .map_err(|e| format!("Failed to compress DNG data: {}", e))?;
    }
    encoder
        .finish()
        .map_err(|e| format!("Failed to compress DNG data: {}", e))
}

fn xyz_to_working() -> Vec<f64> {
    let matrix = WORKING.to_xyz().inverse();
    (0..3)
        .flat_map(|row| (0..3).map(move |col| matrix.col(col)[row]))
        .collect()
}

pub fn encode_linear_dng(raster: &Raster, description: &DngDescription) -> Result<Vec<u8>, String> {
    assert_eq!(raster.channels, CHANNELS, "DNG export expects RGB data");
    assert!(
        raster.width > 0 && raster.height > 0,
        "DNG export expects a non-empty image"
    );
    let tiles_across = raster.width.div_ceil(TILE_SIZE);
    let tiles_down = raster.height.div_ceil(TILE_SIZE);
    let mut out = Vec::with_capacity(raster.width * raster.height * CHANNELS);
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    let mut offsets = Vec::with_capacity(tiles_across * tiles_down);
    let mut counts = Vec::with_capacity(tiles_across * tiles_down);
    for tile_y in 0..tiles_down {
        let row: Vec<Vec<u8>> = (0..tiles_across)
            .into_par_iter()
            .map(|tile_x| encode_tile(raster, tile_x, tile_y))
            .collect::<Result<_, _>>()?;
        for tile in row {
            offsets.push(out.len() as u32);
            counts.push(tile.len() as u32);
            out.extend_from_slice(&tile);
            if out.len() % 2 == 1 {
                out.push(0);
            }
        }
    }

    let unique_model = format!("{} {}", description.make, description.model);
    let unique_model = match unique_model.trim() {
        "" => "RapidRAW Merge",
        name => name,
    };
    let mut entries = vec![
        Entry::longs(254, &[0]),
        Entry::longs(256, &[raster.width as u32]),
        Entry::longs(257, &[raster.height as u32]),
        Entry::shorts(258, &[16; CHANNELS]),
        Entry::shorts(259, &[DEFLATE]),
        Entry::shorts(262, &[LINEAR_RAW]),
        Entry::ascii(271, description.make),
        Entry::ascii(272, description.model),
        Entry::shorts(274, &[1]),
        Entry::shorts(277, &[CHANNELS as u16]),
        Entry::shorts(284, &[1]),
        Entry::ascii(305, "RapidRAW"),
        Entry::shorts(317, &[FLOATING_POINT_PREDICTOR]),
        Entry::longs(322, &[TILE_SIZE as u32]),
        Entry::longs(323, &[TILE_SIZE as u32]),
        Entry::longs(324, &offsets),
        Entry::longs(325, &counts),
        Entry::shorts(339, &[3; CHANNELS]),
        Entry::bytes(50706, &[1, 4, 0, 0]),
        Entry::bytes(50707, &[1, 4, 0, 0]),
        Entry::ascii(50708, unique_model),
        Entry::longs(50717, &[1; CHANNELS]),
        Entry::signed_rationals(50721, &xyz_to_working()),
        Entry::rationals(50728, &[1.0; CHANNELS]),
        Entry::signed_rationals(50730, &[description.baseline_exposure as f64]),
        Entry::shorts(50778, &[ILLUMINANT_D65]),
    ];
    entries.sort_by_key(|entry| entry.tag);

    let ifd_offset = out.len() as u32;
    out[4..8].copy_from_slice(&ifd_offset.to_le_bytes());
    let mut data_offset = ifd_offset as usize + 2 + entries.len() * 12 + 4;
    let mut directory = Vec::with_capacity(entries.len() * 12);
    let mut extra = Vec::new();
    for entry in &entries {
        directory.extend_from_slice(&entry.tag.to_le_bytes());
        directory.extend_from_slice(&entry.kind.to_le_bytes());
        directory.extend_from_slice(&entry.count.to_le_bytes());
        if entry.data.len() <= 4 {
            let mut inline = [0u8; 4];
            inline[..entry.data.len()].copy_from_slice(&entry.data);
            directory.extend_from_slice(&inline);
        } else {
            directory.extend_from_slice(&(data_offset as u32).to_le_bytes());
            extra.extend_from_slice(&entry.data);
            if extra.len() % 2 == 1 {
                extra.push(0);
            }
            data_offset = ifd_offset as usize + 2 + entries.len() * 12 + 4 + extra.len();
        }
    }
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&directory);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&extra);
    Ok(out)
}
