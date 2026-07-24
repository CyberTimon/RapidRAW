use crate::color_encoding::{linear_to_srgb_extended, srgb_to_linear};
use image::DynamicImage;
use rayon::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Linear,
    Srgb,
}

pub struct TaggedImage {
    image: DynamicImage,
    encoding: Encoding,
}

impl TaggedImage {
    pub fn new(image: DynamicImage, encoding: Encoding) -> TaggedImage {
        TaggedImage { image, encoding }
    }

    pub fn encoding(&self) -> Encoding {
        self.encoding
    }

    pub fn into_srgb(mut self) -> TaggedImage {
        if self.encoding == Encoding::Srgb {
            return self;
        }

        __convert_in_place(&mut self.image, linear_to_srgb_extended);
        self.encoding = Encoding::Srgb;
        debug_assert!(self.encoding == Encoding::Srgb, "into_srgb tag mismatch");
        self
    }

    pub fn into_linear(mut self) -> TaggedImage {
        if self.encoding == Encoding::Linear {
            return self;
        }

        __convert_in_place(&mut self.image, srgb_to_linear);
        self.encoding = Encoding::Linear;
        debug_assert!(
            self.encoding == Encoding::Linear,
            "into_linear tag mismatch"
        );
        self
    }

    pub fn as_image(&self) -> &DynamicImage {
        &self.image
    }

    pub fn into_inner(self) -> DynamicImage {
        self.image
    }
}

fn __convert_in_place(image: &mut DynamicImage, op: fn(f32) -> f32) {
    match image {
        DynamicImage::ImageRgb32F(img) => {
            img.as_mut().par_iter_mut().for_each(|c| *c = op(*c));
        }
        DynamicImage::ImageRgba32F(img) => {
            img.par_chunks_mut(4).for_each(|p| {
                p[0] = op(p[0]);
                p[1] = op(p[1]);
                p[2] = op(p[2]);
            });
        }
        _ => {}
    }
}
