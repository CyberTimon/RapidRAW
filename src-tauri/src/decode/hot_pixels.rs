use rawler::RawImageData;
use rawler::rawimage::{RawImage, RawPhotometricInterpretation};
use rayon::prelude::*;

use crate::decode::demosaic::{active_domain, white_level};

const REACH: isize = 2;
const MARGIN: usize = 2 * REACH as usize;
const ISOLATION: f32 = 21.0 / 24.0;
const FLOOR: f32 = 1.0 / 256.0;
const CONTRAST: f32 = 0.25;
const SPILL: f32 = 0.25;
const CLIP: f32 = 0.95;

struct Site {
    black: f32,
    same: Vec<(isize, f32)>,
}

struct Sensor<'a> {
    data: &'a [u16],
    stride: usize,
    period: [usize; 2],
    sites: Vec<Site>,
    floor: f32,
    clip: f32,
}

impl Sensor<'_> {
    fn row(&self, y: usize) -> &[Site] {
        &self.sites[(y % self.period[1]) * self.period[0]..][..self.period[0]]
    }

    fn site(&self, x: usize, y: usize) -> &Site {
        &self.row(y)[x % self.period[0]]
    }

    fn value(&self, i: usize, black: f32) -> f32 {
        self.data[i] as f32 - black
    }

    fn neighbours(&self, i: usize, site: &Site) -> impl Iterator<Item = f32> {
        site.same
            .iter()
            .map(move |&(offset, black)| self.value(i.wrapping_add_signed(offset), black))
    }

    fn median(&self, i: usize, site: &Site, center: Option<f32>) -> f32 {
        let mut samples = [0.0; 25];
        let mut n = 0;
        for value in self.neighbours(i, site).chain(center) {
            samples[n] = value;
            n += 1;
        }
        middle(&mut samples[..n])
    }

    fn repair(&self, x: usize, y: usize, site: &Site) -> Option<u16> {
        let i = y * self.stride + x;
        let v = self.value(i, site.black);
        let first = self.neighbours(i, site).next()?;
        let sign = if v > first { 1.0 } else { -1.0 };
        if !self
            .neighbours(i, site)
            .all(|s| sign * (v - s) > self.floor.max(s * CONTRAST))
        {
            return None;
        }
        let (lo, hi) = self
            .neighbours(i, site)
            .fold((f32::MAX, f32::MIN), |(lo, hi), s| (lo.min(s), hi.max(s)));
        let spread = self.floor.max(hi - lo);
        let hot = v - hi > spread.max(hi * CONTRAST);
        let dead = lo - v > spread.max(lo * CONTRAST);
        if !hot && !dead {
            return None;
        }

        let deviation = v - self.median(i, site, Some(v));
        let mut surround = 0.0;
        let mut spill = 0.0;
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                if dx != 0 || dy != 0 {
                    let (nx, ny) = (x.wrapping_add_signed(dx), y.wrapping_add_signed(dy));
                    let ni = ny * self.stride + nx;
                    let neighbour = self.site(nx, ny);
                    let value = self.value(ni, neighbour.black);
                    let d = value - self.median(ni, neighbour, Some(value));
                    surround += d.abs();
                    if dx.abs() <= 1 && dy.abs() <= 1 {
                        if deviation > 0.0 && value >= self.clip {
                            return None;
                        }
                        spill += d;
                    }
                }
            }
        }
        if deviation.abs() <= ISOLATION * surround
            || spill * deviation.signum() > SPILL * deviation.abs()
        {
            return None;
        }

        let replacement = self.median(i, site, None) + site.black;
        Some(replacement.round().clamp(0.0, u16::MAX as f32) as u16)
    }
}

fn middle(samples: &mut [f32]) -> f32 {
    samples.sort_unstable_by(f32::total_cmp);
    let half = samples.len() / 2;
    if samples.len().is_multiple_of(2) {
        (samples[half - 1] + samples[half]) * 0.5
    } else {
        samples[half]
    }
}

pub fn repair_hot_pixels(raw_image: &mut RawImage) {
    let RawPhotometricInterpretation::Cfa(config) = &raw_image.photometric else {
        return;
    };
    if raw_image.cpp != 1 || raw_image.fuji_rotation_width.is_some() {
        return;
    }
    let Some(domain) = active_domain(raw_image, 2 * MARGIN + 1) else {
        return;
    };
    let (width, height) = (raw_image.width, raw_image.height);
    let black = raw_image.blacklevel.as_bayer_array();
    let black_at = |x: usize, y: usize| black[(y & 1) * 2 + (x & 1)];
    let white = white_level(raw_image);
    let period = [config.cfa.width, config.cfa.height]
        .map(|p| if p.is_multiple_of(2) { p.max(2) } else { 2 * p });
    let mut offsets = (-REACH..=REACH)
        .flat_map(|dy| (-REACH..=REACH).map(move |dx| (dx, dy)))
        .filter(|&(dx, dy)| dx != 0 || dy != 0)
        .collect::<Vec<_>>();
    offsets.sort_by_key(|&(dx, dy)| dx * dx + dy * dy);
    let sites = (0..period[0] * period[1])
        .map(|k| {
            let (x, y) = (k % period[0] + period[0], k / period[0] + period[1]);
            let color = config.cfa.color_at(y, x);
            let same = offsets
                .iter()
                .map(|&(dx, dy)| (x.wrapping_add_signed(dx), y.wrapping_add_signed(dy), dx, dy))
                .filter(|&(nx, ny, _, _)| config.cfa.color_at(ny, nx) == color)
                .map(|(nx, ny, dx, dy)| (dy * width as isize + dx, black_at(nx, ny)))
                .collect();
            Site {
                black: black_at(x, y),
                same,
            }
        })
        .collect::<Vec<_>>();
    if sites.iter().any(|site| site.same.len() < 2) {
        return;
    }

    let RawImageData::Integer(data) = &mut raw_image.data else {
        return;
    };
    if data.len() < width * height {
        return;
    }

    let sensor = Sensor {
        data: data.as_slice(),
        stride: width,
        period,
        sites,
        floor: (white - black[0]).max(1.0) * FLOOR,
        clip: (white - black[0]) * CLIP,
    };
    let (x0, x1) = (domain.p.x + MARGIN, domain.p.x + domain.d.w - MARGIN);
    let (y0, y1) = (domain.p.y + MARGIN, domain.p.y + domain.d.h - MARGIN);
    let repairs = (y0..y1)
        .into_par_iter()
        .flat_map_iter(|y| {
            let sensor = &sensor;
            let sites = sensor.row(y).iter().cycle().skip(x0 % period[0]);
            (x0..x1)
                .zip(sites)
                .filter_map(move |(x, site)| sensor.repair(x, y, site).map(|v| (y * width + x, v)))
        })
        .collect::<Vec<_>>();

    log::debug!("Repaired {} hot or dead pixels", repairs.len());
    for (i, v) in repairs {
        data[i] = v;
    }
}
