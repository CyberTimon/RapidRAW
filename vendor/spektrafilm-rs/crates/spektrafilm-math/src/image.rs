use crate::precision::{Scalar, ZERO};
use rayon::prelude::*;

/// Contiguous HxWx3 image buffer, row-major, channel-interleaved.
///
/// Pixel type is `Scalar` — f32 by default, f64 with `--features precision-f64`.
#[derive(Clone)]
pub struct ImageBuf {
    pub width: u32,
    pub height: u32,
    pub data: Vec<Scalar>,
}

impl ImageBuf {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![ZERO; (width as usize) * (height as usize) * 3],
        }
    }

    pub fn from_data(width: u32, height: u32, data: Vec<Scalar>) -> Self {
        assert_eq!(data.len(), (width as usize) * (height as usize) * 3);
        Self {
            width,
            height,
            data,
        }
    }

    pub fn pixel_count(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }

    #[inline]
    pub fn idx(&self, x: u32, y: u32, c: usize) -> usize {
        ((y as usize) * (self.width as usize) + (x as usize)) * 3 + c
    }

    #[inline]
    pub fn get(&self, x: u32, y: u32) -> [Scalar; 3] {
        let i = self.idx(x, y, 0);
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    #[inline]
    pub fn set(&mut self, x: u32, y: u32, rgb: [Scalar; 3]) {
        let i = self.idx(x, y, 0);
        self.data[i] = rgb[0];
        self.data[i + 1] = rgb[1];
        self.data[i + 2] = rgb[2];
    }

    pub fn pixels(&self) -> impl Iterator<Item = &[Scalar]> {
        self.data.chunks_exact(3)
    }

    pub fn pixels_mut(&mut self) -> impl Iterator<Item = &mut [Scalar]> {
        self.data.chunks_exact_mut(3)
    }

    pub fn par_pixels(&self) -> rayon::slice::ChunksExact<'_, Scalar> {
        self.data.par_chunks_exact(3)
    }

    pub fn par_pixels_mut(&mut self) -> rayon::slice::ChunksExactMut<'_, Scalar> {
        self.data.par_chunks_exact_mut(3)
    }

    pub fn rows(&self) -> impl Iterator<Item = &[Scalar]> {
        self.data.chunks_exact((self.width as usize) * 3)
    }

    pub fn par_rows(&self) -> rayon::slice::ChunksExact<'_, Scalar> {
        self.data.par_chunks_exact((self.width as usize) * 3)
    }

    pub fn par_rows_mut(&mut self) -> rayon::slice::ChunksExactMut<'_, Scalar> {
        let w = (self.width as usize) * 3;
        self.data.par_chunks_exact_mut(w)
    }

    pub fn extract_channel(&self, c: usize) -> Vec<Scalar> {
        assert!(c < 3);
        self.data.iter().skip(c).step_by(3).copied().collect()
    }

    pub fn write_channel(&mut self, c: usize, chan: &[Scalar]) {
        assert!(c < 3);
        assert_eq!(chan.len(), self.pixel_count());
        for (i, &v) in chan.iter().enumerate() {
            self.data[i * 3 + c] = v;
        }
    }
}

impl std::fmt::Debug for ImageBuf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ImageBuf({}x{}, {} pixels)",
            self.width,
            self.height,
            self.pixel_count()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::precision::from_f64;

    #[test]
    fn test_new_and_dimensions() {
        let img = ImageBuf::new(4, 3);
        assert_eq!(img.width, 4);
        assert_eq!(img.height, 3);
        assert_eq!(img.data.len(), 4 * 3 * 3);
        assert_eq!(img.pixel_count(), 12);
    }

    #[test]
    fn test_get_set_pixel() {
        let mut img = ImageBuf::new(2, 2);
        img.set(1, 0, [from_f64(0.5), from_f64(0.6), from_f64(0.7)]);
        let px = img.get(1, 0);
        assert_eq!(px, [from_f64(0.5), from_f64(0.6), from_f64(0.7)]);
    }

    #[test]
    fn test_pixels_iter() {
        let img = ImageBuf::from_data(
            2,
            1,
            vec![
                from_f64(1.0),
                from_f64(2.0),
                from_f64(3.0),
                from_f64(4.0),
                from_f64(5.0),
                from_f64(6.0),
            ],
        );
        let pixels: Vec<&[Scalar]> = img.pixels().collect();
        assert_eq!(pixels.len(), 2);
        assert_eq!(pixels[0], &[from_f64(1.0), from_f64(2.0), from_f64(3.0)]);
        assert_eq!(pixels[1], &[from_f64(4.0), from_f64(5.0), from_f64(6.0)]);
    }

    #[test]
    fn test_extract_write_channel() {
        let mut img = ImageBuf::from_data(
            2,
            1,
            vec![
                from_f64(1.0),
                from_f64(2.0),
                from_f64(3.0),
                from_f64(4.0),
                from_f64(5.0),
                from_f64(6.0),
            ],
        );
        let g = img.extract_channel(1);
        assert_eq!(g, vec![from_f64(2.0), from_f64(5.0)]);
        img.write_channel(1, &[from_f64(10.0), from_f64(20.0)]);
        assert_eq!(
            img.get(0, 0),
            [from_f64(1.0), from_f64(10.0), from_f64(3.0)]
        );
        assert_eq!(
            img.get(1, 0),
            [from_f64(4.0), from_f64(20.0), from_f64(6.0)]
        );
    }
}
