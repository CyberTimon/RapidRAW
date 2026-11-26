use rayon::prelude::*;

const MIN_LEVEL_SIDE: u32 = 16;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GrayFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

impl GrayFrame {
    pub fn from_luma8(width: u32, height: u32, luma: &[u8]) -> Self {
        let data = luma.iter().map(|&value| f32::from(value) / 255.0).collect();
        Self {
            width,
            height,
            data,
        }
    }

    fn halved(&self) -> Self {
        let (width, height) = (self.width as usize, self.height as usize);
        let (half_width, half_height) = (width / 2, height / 2);
        let taps = |index: usize, length: usize| {
            let at = |offset: isize| {
                (2 * index as isize + offset).clamp(0, length as isize - 1) as usize
            };
            [at(-1), at(0), at(1), at(2)]
        };
        let mut horizontal = vec![0.0; half_width * height];
        horizontal
            .par_chunks_mut(half_width)
            .zip(self.data.par_chunks(width))
            .for_each(|(out, row)| {
                for (x, value) in out.iter_mut().enumerate() {
                    let [a, b, c, d] = taps(x, width);
                    *value = (row[a] + 3.0 * (row[b] + row[c]) + row[d]) * 0.125;
                }
            });
        let mut data = vec![0.0; half_width * half_height];
        data.par_chunks_mut(half_width)
            .enumerate()
            .for_each(|(y, out)| {
                let rows = taps(y, height).map(|row| &horizontal[row * half_width..][..half_width]);
                for (x, value) in out.iter_mut().enumerate() {
                    *value = (rows[0][x] + 3.0 * (rows[1][x] + rows[2][x]) + rows[3][x]) * 0.125;
                }
            });
        Self {
            width: half_width as u32,
            height: half_height as u32,
            data,
        }
    }

    pub(super) fn sample(&self, x: f32, y: f32) -> f32 {
        let (width, height) = (self.width as usize, self.height as usize);
        let x = x.clamp(0.0, (width - 1) as f32);
        let y = y.clamp(0.0, (height - 1) as f32);
        let (left, top) = (x as usize, y as usize);
        let (right, bottom) = ((left + 1).min(width - 1), (top + 1).min(height - 1));
        let (fx, fy) = (x - left as f32, y - top as f32);
        let row = |row: usize| {
            let line = &self.data[row * width..];
            line[left] + (line[right] - line[left]) * fx
        };
        let upper = row(top);
        upper + (row(bottom) - upper) * fy
    }

    pub(super) fn sample_window(&self, x: f32, y: f32, width: usize, out: &mut [f32]) {
        let height = out.len() / width;
        let frame_width = self.width as usize;
        let (left, top) = (x.floor(), y.floor());
        let inside = left >= 0.0
            && top >= 0.0
            && left as usize + width < frame_width
            && top as usize + height < self.height as usize;
        if !inside {
            for (row, line) in out.chunks_exact_mut(width).enumerate() {
                for (column, value) in line.iter_mut().enumerate() {
                    *value = self.sample(x + column as f32, y + row as f32);
                }
            }
            return;
        }
        let (fx, fy) = (x - left, y - top);
        let weights = [
            (1.0 - fx) * (1.0 - fy),
            fx * (1.0 - fy),
            (1.0 - fx) * fy,
            fx * fy,
        ];
        let (left, top) = (left as usize, top as usize);
        for (row, line) in out.chunks_exact_mut(width).enumerate() {
            let upper = &self.data[(top + row) * frame_width + left..][..=width];
            let lower = &self.data[(top + row + 1) * frame_width + left..][..=width];
            for ((value, upper), lower) in
                line.iter_mut().zip(upper.windows(2)).zip(lower.windows(2))
            {
                *value = weights[0] * upper[0]
                    + weights[1] * upper[1]
                    + weights[2] * lower[0]
                    + weights[3] * lower[1];
            }
        }
    }
}

pub(super) struct Pyramid(pub Vec<GrayFrame>);

impl Pyramid {
    pub fn new(frame: GrayFrame, levels: usize) -> Self {
        let mut pyramid = vec![frame];
        while pyramid.len() < levels {
            let last = &pyramid[pyramid.len() - 1];
            if last.width < 2 * MIN_LEVEL_SIDE || last.height < 2 * MIN_LEVEL_SIDE {
                break;
            }
            let next = last.halved();
            pyramid.push(next);
        }
        Self(pyramid)
    }
}

pub(super) fn to_level(point: [f32; 2], levels: usize) -> [f32; 2] {
    let factor = (1u32 << levels) as f32;
    point.map(|value| (value + 0.5) / factor - 0.5)
}

pub(super) fn from_level(point: [f32; 2], levels: usize) -> [f32; 2] {
    let factor = (1u32 << levels) as f32;
    point.map(|value| (value + 0.5) * factor - 0.5)
}
