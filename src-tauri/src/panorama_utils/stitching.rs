use crate::panorama_stitching::ImageInfo;
use image::{GrayImage, Rgb, Rgb32FImage};
use nalgebra::{Matrix3, Point3};
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter};

const FEATHER_WIDTH: f64 = 100.0;

enum SeamOrientation {
    Vertical,
    Horizontal,
}

struct SeamInfo {
    orientation: SeamOrientation,
    coords: Vec<i32>,
    dx: f64,
    dy: f64,
}

pub fn progressive_seam_stitcher(
    images: &[&ImageInfo],
    global_homographies: &HashMap<usize, Matrix3<f64>>,
    app_handle: AppHandle,
) -> Rgb32FImage {
    if images.is_empty() {
        return Rgb32FImage::new(0, 0);
    }

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for &img_info in images {
        let h = global_homographies[&img_info.id];
        let (w, h_img) = img_info.image.dimensions();
        let corners = [
            Point3::new(0.0, 0.0, 1.0),
            Point3::new(w as f64, 0.0, 1.0),
            Point3::new(w as f64, h_img as f64, 1.0),
            Point3::new(0.0, h_img as f64, 1.0),
        ];
        for p in corners.iter() {
            let tp = h * p;
            let tx = tp.x / tp.z;
            let ty = tp.y / tp.z;
            min_x = min_x.min(tx);
            max_x = max_x.max(tx);
            min_y = min_y.min(ty);
            max_y = max_y.max(ty);
        }
    }

    let offset_x = -min_x;
    let offset_y = -min_y;
    let out_width = (max_x - min_x).ceil() as u32;
    let out_height = (max_y - min_y).ceil() as u32;
    println!("  - Output canvas size: {}x{}", out_width, out_height);

    let mut panorama = Rgb32FImage::new(out_width, out_height);
    let mut panorama_mask = GrayImage::new(out_width, out_height);

    let base_img_info = images[0];
    let h_base = &global_homographies[&base_img_info.id];
    let h_base_inv = h_base.try_inverse().unwrap();
    println!("  - Placing base image: '{}'", base_img_info.filename);

    let num_pixels_per_row = out_width as usize * 3;
    panorama
        .par_chunks_mut(num_pixels_per_row)
        .zip(panorama_mask.par_chunks_mut(out_width as usize))
        .enumerate()
        .for_each(|(y, (row_slice, mask_row))| {
            for x in 0..out_width {
                let target_p = Point3::new(x as f64 - offset_x, y as f64 - offset_y, 1.0);
                let source_p = h_base_inv * target_p;
                let sx = source_p.x / source_p.z;
                let sy = source_p.y / source_p.z;

                if sx >= 0.0
                    && sx < base_img_info.image.width() as f64
                    && sy >= 0.0
                    && sy < base_img_info.image.height() as f64
                {
                    let color = get_interpolated_pixel(&base_img_info.image, sx, sy);
                    let start = x as usize * 3;
                    row_slice[start..start + 3].copy_from_slice(&color.0);
                    mask_row[x as usize] = 255;
                }
            }
        });

    for (i, &img_to_add_info) in images.iter().skip(1).enumerate() {
        let progress_msg = format!(
            "Stitching image {} of {}: {}",
            i + 2,
            images.len(),
            Path::new(&img_to_add_info.filename)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
        let _ = app_handle.emit("panorama-progress", &progress_msg);
        println!("  - Progressively stitching '{}'", img_to_add_info.filename);

        let h_add = &global_homographies[&img_to_add_info.id];
        let h_add_inv = h_add.try_inverse().unwrap();
        let img_to_add = &img_to_add_info.image;

        let seam_info = find_adaptive_seam(
            &panorama,
            &panorama_mask,
            img_to_add,
            h_add,
            offset_x,
            offset_y,
            out_width,
            out_height,
        );

        let use_seam = if let Some(ref info) = seam_info {
            !info.coords.is_empty()
        } else {
            false
        };

        if !use_seam {
            println!("    - Warning: Could not find seam. Using simple overwrite.");
        }

        let (orientation, seam_coords, new_image_is_dominant_side) = if let Some(info) = seam_info {
            let dominant = match info.orientation {
                SeamOrientation::Vertical => info.dx > 0.0,
                SeamOrientation::Horizontal => info.dy > 0.0,
            };
            (info.orientation, info.coords, dominant)
        } else {
            (SeamOrientation::Vertical, vec![], true)
        };

        if use_seam {
            let side = match orientation {
                SeamOrientation::Vertical => {
                    if new_image_is_dominant_side {
                        "right"
                    } else {
                        "left"
                    }
                }
                SeamOrientation::Horizontal => {
                    if new_image_is_dominant_side {
                        "bottom"
                    } else {
                        "top"
                    }
                }
            };
            println!("    - New image is on the {} side of the seam.", side);
        }

        match orientation {
            SeamOrientation::Vertical => {
                panorama
                    .par_chunks_mut(num_pixels_per_row)
                    .zip(panorama_mask.par_chunks_mut(out_width as usize))
                    .enumerate()
                    .for_each(|(y, (row_slice, mask_row))| {
                        for x in 0..out_width {
                            let target_p =
                                Point3::new(x as f64 - offset_x, y as f64 - offset_y, 1.0);

                            let source_p_add = h_add_inv * target_p;
                            let sx = source_p_add.x / source_p_add.z;
                            let sy = source_p_add.y / source_p_add.z;
                            let is_on_add = sx >= 0.0
                                && sx < img_to_add.width() as f64
                                && sy >= 0.0
                                && sy < img_to_add.height() as f64;

                            let is_on_pano = mask_row[x as usize] > 0;

                            if !is_on_add && !is_on_pano {
                                continue;
                            }

                            if is_on_add && is_on_pano && use_seam {
                                let seam_x_val = seam_coords[y];
                                let dist_to_seam = x as f64 - seam_x_val as f64;

                                let low_detail_mask_add = &img_to_add_info.low_detail_mask;
                                let sx_u = (sx.round() as u32).min(low_detail_mask_add.width() - 1);
                                let sy_u =
                                    (sy.round() as u32).min(low_detail_mask_add.height() - 1);
                                let is_low_detail =
                                    low_detail_mask_add.get_pixel(sx_u, sy_u)[0] > 0;
                                let dynamic_feather_width = if is_low_detail {
                                    FEATHER_WIDTH * 5.0
                                } else {
                                    FEATHER_WIDTH
                                };

                                if dist_to_seam.abs() < dynamic_feather_width / 2.0 {
                                    let color_on_pano = Rgb(row_slice
                                        [x as usize * 3..x as usize * 3 + 3]
                                        .try_into()
                                        .unwrap());
                                    let color_to_add = get_interpolated_pixel(img_to_add, sx, sy);

                                    let alpha = if new_image_is_dominant_side {
                                        (dist_to_seam + dynamic_feather_width / 2.0)
                                            / dynamic_feather_width
                                    } else {
                                        (-dist_to_seam + dynamic_feather_width / 2.0)
                                            / dynamic_feather_width
                                    };
                                    let weight_add = (1.0
                                        - (alpha.clamp(0.0, 1.0) * std::f64::consts::PI).cos())
                                        / 2.0;
                                    let weight_pano = 1.0 - weight_add;

                                    let final_color = Rgb([
                                        color_on_pano[0] * weight_pano as f32
                                            + color_to_add[0] * weight_add as f32,
                                        color_on_pano[1] * weight_pano as f32
                                            + color_to_add[1] * weight_add as f32,
                                        color_on_pano[2] * weight_pano as f32
                                            + color_to_add[2] * weight_add as f32,
                                    ]);
                                    let start = x as usize * 3;
                                    row_slice[start..start + 3].copy_from_slice(&final_color.0);
                                } else {
                                    let new_image_owns_pixel = if new_image_is_dominant_side {
                                        x as i32 > seam_x_val
                                    } else {
                                        (x as i32) < seam_x_val
                                    };
                                    if new_image_owns_pixel {
                                        let color_to_add =
                                            get_interpolated_pixel(img_to_add, sx, sy);
                                        let start = x as usize * 3;
                                        row_slice[start..start + 3]
                                            .copy_from_slice(&color_to_add.0);
                                    }
                                }
                            } else if is_on_add {
                                let color_to_add = get_interpolated_pixel(img_to_add, sx, sy);
                                let start = x as usize * 3;
                                row_slice[start..start + 3].copy_from_slice(&color_to_add.0);
                                mask_row[x as usize] = 255;
                            }
                        }
                    });
            }
            SeamOrientation::Horizontal => {
                panorama
                    .par_chunks_mut(num_pixels_per_row)
                    .zip(panorama_mask.par_chunks_mut(out_width as usize))
                    .enumerate()
                    .for_each(|(y, (row_slice, mask_row))| {
                        for x in 0..out_width {
                            let target_p =
                                Point3::new(x as f64 - offset_x, y as f64 - offset_y, 1.0);

                            let source_p_add = h_add_inv * target_p;
                            let sx = source_p_add.x / source_p_add.z;
                            let sy = source_p_add.y / source_p_add.z;
                            let is_on_add = sx >= 0.0
                                && sx < img_to_add.width() as f64
                                && sy >= 0.0
                                && sy < img_to_add.height() as f64;

                            let is_on_pano = mask_row[x as usize] > 0;

                            if !is_on_add && !is_on_pano {
                                continue;
                            }

                            if is_on_add && is_on_pano && use_seam {
                                let seam_y_val = seam_coords[x as usize];
                                let dist_to_seam = y as f64 - seam_y_val as f64;

                                let low_detail_mask_add = &img_to_add_info.low_detail_mask;
                                let sx_u = (sx.round() as u32).min(low_detail_mask_add.width() - 1);
                                let sy_u =
                                    (sy.round() as u32).min(low_detail_mask_add.height() - 1);
                                let is_low_detail =
                                    low_detail_mask_add.get_pixel(sx_u, sy_u)[0] > 0;
                                let dynamic_feather_width = if is_low_detail {
                                    FEATHER_WIDTH * 5.0
                                } else {
                                    FEATHER_WIDTH
                                };

                                if dist_to_seam.abs() < dynamic_feather_width / 2.0 {
                                    let color_on_pano = Rgb(row_slice
                                        [x as usize * 3..x as usize * 3 + 3]
                                        .try_into()
                                        .unwrap());
                                    let color_to_add = get_interpolated_pixel(img_to_add, sx, sy);

                                    let alpha = if new_image_is_dominant_side {
                                        (dist_to_seam + dynamic_feather_width / 2.0)
                                            / dynamic_feather_width
                                    } else {
                                        (-dist_to_seam + dynamic_feather_width / 2.0)
                                            / dynamic_feather_width
                                    };
                                    let weight_add = (1.0
                                        - (alpha.clamp(0.0, 1.0) * std::f64::consts::PI).cos())
                                        / 2.0;
                                    let weight_pano = 1.0 - weight_add;

                                    let final_color = Rgb([
                                        color_on_pano[0] * weight_pano as f32
                                            + color_to_add[0] * weight_add as f32,
                                        color_on_pano[1] * weight_pano as f32
                                            + color_to_add[1] * weight_add as f32,
                                        color_on_pano[2] * weight_pano as f32
                                            + color_to_add[2] * weight_add as f32,
                                    ]);
                                    let start = x as usize * 3;
                                    row_slice[start..start + 3].copy_from_slice(&final_color.0);
                                } else {
                                    let new_image_owns_pixel = if new_image_is_dominant_side {
                                        y as i32 > seam_y_val
                                    } else {
                                        (y as i32) < seam_y_val
                                    };
                                    if new_image_owns_pixel {
                                        let color_to_add =
                                            get_interpolated_pixel(img_to_add, sx, sy);
                                        let start = x as usize * 3;
                                        row_slice[start..start + 3]
                                            .copy_from_slice(&color_to_add.0);
                                    }
                                }
                            } else if is_on_add {
                                let color_to_add = get_interpolated_pixel(img_to_add, sx, sy);
                                let start = x as usize * 3;
                                row_slice[start..start + 3].copy_from_slice(&color_to_add.0);
                                mask_row[x as usize] = 255;
                            }
                        }
                    });
            }
        }
    }

    panorama
}

fn find_adaptive_seam(
    pano: &Rgb32FImage,
    pano_mask: &GrayImage,
    img_to_add: &Rgb32FImage,
    h_add: &Matrix3<f64>,
    offset_x: f64,
    offset_y: f64,
    out_width: u32,
    out_height: u32,
) -> Option<SeamInfo> {
    let h_add_inv = h_add.try_inverse().unwrap();
    let (w_add, h_add_img) = img_to_add.dimensions();

    let mut min_ox = u32::MAX;
    let mut max_ox = 0;
    let mut min_oy = u32::MAX;
    let mut max_oy = 0;
    let mut has_overlap = false;

    for y in 0..out_height {
        for x in 0..out_width {
            if pano_mask.get_pixel(x, y)[0] > 0 {
                let target_p = Point3::new(x as f64 - offset_x, y as f64 - offset_y, 1.0);
                let source_p = h_add_inv * target_p;
                let sx = source_p.x / source_p.z;
                let sy = source_p.y / source_p.z;
                if sx >= 0.0 && sx < w_add as f64 && sy >= 0.0 && sy < h_add_img as f64 {
                    has_overlap = true;
                    min_ox = min_ox.min(x);
                    max_ox = max_ox.max(x);
                    min_oy = min_oy.min(y);
                    max_oy = max_oy.max(y);
                }
            }
        }
    }

    if !has_overlap {
        return None;
    }

    let center_p_source = Point3::new(w_add as f64 / 2.0, h_add_img as f64 / 2.0, 1.0);
    let center_p_target = h_add * center_p_source;
    let center_add_x = (center_p_target.x / center_p_target.z) + offset_x;
    let center_add_y = (center_p_target.y / center_p_target.z) + offset_y;

    let center_overlap_x = (min_ox + max_ox) as f64 / 2.0;
    let center_overlap_y = (min_oy + max_oy) as f64 / 2.0;

    let dx = center_add_x - center_overlap_x;
    let dy = center_add_y - center_overlap_y;

    if dx.abs() > dy.abs() {
        println!("    - Overlap is vertical. Finding vertical seam...");
        let seam = find_pairwise_seam_dp_vertical(
            pano, pano_mask, img_to_add, h_add, offset_x, offset_y, out_width, out_height,
        );
        Some(SeamInfo {
            orientation: SeamOrientation::Vertical,
            coords: seam,
            dx,
            dy,
        })
    } else {
        println!("    - Overlap is horizontal. Finding horizontal seam...");
        let seam = find_pairwise_seam_dp_horizontal(
            pano, pano_mask, img_to_add, h_add, offset_x, offset_y, out_width, out_height,
        );
        Some(SeamInfo {
            orientation: SeamOrientation::Horizontal,
            coords: seam,
            dx,
            dy,
        })
    }
}

fn find_pairwise_seam_dp_vertical(
    pano: &Rgb32FImage,
    pano_mask: &GrayImage,
    img_to_add: &Rgb32FImage,
    h_add: &Matrix3<f64>,
    offset_x: f64,
    offset_y: f64,
    out_width: u32,
    out_height: u32,
) -> Vec<i32> {
    let h_add_inv = h_add.try_inverse().unwrap();
    let (w_add, h_add_img) = img_to_add.dimensions();
    let mut cost_matrix = vec![vec![f64::INFINITY; out_width as usize]; out_height as usize];
    let mut path_matrix = vec![vec![0i32; out_width as usize]; out_height as usize];
    let mut first_overlap_row = usize::MAX;
    let mut last_overlap_row = 0;

    for y_out in 0..out_height as usize {
        let mut row_has_overlap = false;
        for x_out in 0..out_width as usize {
            if pano_mask.get_pixel(x_out as u32, y_out as u32)[0] == 0 {
                continue;
            }
            let target_p = Point3::new(x_out as f64 - offset_x, y_out as f64 - offset_y, 1.0);
            let source_p = h_add_inv * target_p;
            let sx = source_p.x / source_p.z;
            let sy = source_p.y / source_p.z;
            if sx >= 0.0 && sx < w_add as f64 - 1.0 && sy >= 0.0 && sy < h_add_img as f64 - 1.0 {
                let p_pano = pano.get_pixel(x_out as u32, y_out as u32);
                let p_add = get_interpolated_pixel(img_to_add, sx, sy);
                let energy = ((p_pano[0] as f64 - p_add[0] as f64).powi(2)
                    + (p_pano[1] as f64 - p_add[1] as f64).powi(2)
                    + (p_pano[2] as f64 - p_add[2] as f64).powi(2))
                .sqrt();
                cost_matrix[y_out][x_out] = energy;
                row_has_overlap = true;
            }
        }
        if row_has_overlap {
            if first_overlap_row == usize::MAX {
                first_overlap_row = y_out;
            }
            last_overlap_row = y_out;
        }
    }
    if first_overlap_row == usize::MAX {
        return vec![];
    }

    for y in (first_overlap_row + 1)..=last_overlap_row {
        for x in 0..out_width as usize {
            if cost_matrix[y][x] != f64::INFINITY {
                let up_left = if x > 0 {
                    cost_matrix[y - 1][x - 1]
                } else {
                    f64::INFINITY
                };
                let up = cost_matrix[y - 1][x];
                let up_right = if x < (out_width - 1) as usize {
                    cost_matrix[y - 1][x + 1]
                } else {
                    f64::INFINITY
                };
                let min_cost = up.min(up_left).min(up_right);
                if min_cost == f64::INFINITY {
                    continue;
                }
                cost_matrix[y][x] += min_cost;
                if min_cost == up {
                    path_matrix[y][x] = 0;
                } else if min_cost == up_left {
                    path_matrix[y][x] = -1;
                } else {
                    path_matrix[y][x] = 1;
                }
            }
        }
    }

    let mut seam = vec![0i32; out_height as usize];
    let (mut min_cost, mut current_x) = (f64::INFINITY, 0);
    for x in 0..out_width as usize {
        if cost_matrix[last_overlap_row][x] < min_cost {
            min_cost = cost_matrix[last_overlap_row][x];
            current_x = x as i32;
        }
    }
    if min_cost == f64::INFINITY {
        return vec![];
    }

    for y in (first_overlap_row..=last_overlap_row).rev() {
        seam[y] = current_x;
        let path_dir = path_matrix[y][current_x as usize];
        current_x += path_dir;
        current_x = current_x.clamp(0, (out_width - 1) as i32);
    }
    for y in (0..first_overlap_row).rev() {
        seam[y] = seam[first_overlap_row];
    }
    for y in (last_overlap_row + 1)..out_height as usize {
        seam[y] = seam[last_overlap_row];
    }
    seam
}

fn find_pairwise_seam_dp_horizontal(
    pano: &Rgb32FImage,
    pano_mask: &GrayImage,
    img_to_add: &Rgb32FImage,
    h_add: &Matrix3<f64>,
    offset_x: f64,
    offset_y: f64,
    out_width: u32,
    out_height: u32,
) -> Vec<i32> {
    let h_add_inv = h_add.try_inverse().unwrap();
    let (w_add, h_add_img) = img_to_add.dimensions();
    let mut cost_matrix = vec![vec![f64::INFINITY; out_width as usize]; out_height as usize];
    let mut path_matrix = vec![vec![0i32; out_width as usize]; out_height as usize];
    let mut first_overlap_col = usize::MAX;
    let mut last_overlap_col = 0;

    for y_out in 0..out_height as usize {
        for x_out in 0..out_width as usize {
            if pano_mask.get_pixel(x_out as u32, y_out as u32)[0] == 0 {
                continue;
            }
            let target_p = Point3::new(x_out as f64 - offset_x, y_out as f64 - offset_y, 1.0);
            let source_p = h_add_inv * target_p;
            let sx = source_p.x / source_p.z;
            let sy = source_p.y / source_p.z;
            if sx >= 0.0 && sx < w_add as f64 - 1.0 && sy >= 0.0 && sy < h_add_img as f64 - 1.0 {
                let p_pano = pano.get_pixel(x_out as u32, y_out as u32);
                let p_add = get_interpolated_pixel(img_to_add, sx, sy);
                let energy = ((p_pano[0] as f64 - p_add[0] as f64).powi(2)
                    + (p_pano[1] as f64 - p_add[1] as f64).powi(2)
                    + (p_pano[2] as f64 - p_add[2] as f64).powi(2))
                .sqrt();
                cost_matrix[y_out][x_out] = energy;
                first_overlap_col = first_overlap_col.min(x_out);
                last_overlap_col = last_overlap_col.max(x_out);
            }
        }
    }
    if first_overlap_col == usize::MAX {
        return vec![];
    }

    for x in (first_overlap_col + 1)..=last_overlap_col {
        for y in 0..out_height as usize {
            if cost_matrix[y][x] != f64::INFINITY {
                let left_up = if y > 0 {
                    cost_matrix[y - 1][x - 1]
                } else {
                    f64::INFINITY
                };
                let left = cost_matrix[y][x - 1];
                let left_down = if y < (out_height - 1) as usize {
                    cost_matrix[y + 1][x - 1]
                } else {
                    f64::INFINITY
                };
                let min_cost = left.min(left_up).min(left_down);
                if min_cost == f64::INFINITY {
                    continue;
                }
                cost_matrix[y][x] += min_cost;
                if min_cost == left {
                    path_matrix[y][x] = 0;
                } else if min_cost == left_up {
                    path_matrix[y][x] = -1;
                } else {
                    path_matrix[y][x] = 1;
                }
            }
        }
    }

    let mut seam = vec![0i32; out_width as usize];
    let (mut min_cost, mut current_y) = (f64::INFINITY, 0);
    for y in 0..out_height as usize {
        if cost_matrix[y][last_overlap_col] < min_cost {
            min_cost = cost_matrix[y][last_overlap_col];
            current_y = y as i32;
        }
    }
    if min_cost == f64::INFINITY {
        return vec![];
    }

    for x in (first_overlap_col..=last_overlap_col).rev() {
        seam[x] = current_y;
        let path_dir = path_matrix[current_y as usize][x];
        current_y += path_dir;
        current_y = current_y.clamp(0, (out_height - 1) as i32);
    }
    for x in (0..first_overlap_col).rev() {
        seam[x] = seam[first_overlap_col];
    }
    for x in (last_overlap_col + 1)..out_width as usize {
        seam[x] = seam[last_overlap_col];
    }
    seam
}

fn get_interpolated_pixel(img: &Rgb32FImage, x: f64, y: f64) -> Rgb<f32> {
    let (width, height) = img.dimensions();
    let x_floor = x.floor() as u32;
    let y_floor = y.floor() as u32;
    if x_floor + 1 >= width || y_floor + 1 >= height || x < 0.0 || y < 0.0 {
        return *img.get_pixel(
            x.max(0.0).min(width as f64 - 1.0) as u32,
            y.max(0.0).min(height as f64 - 1.0) as u32,
        );
    }
    let dx = x - x_floor as f64;
    let dy = y - y_floor as f64;
    let p00 = img.get_pixel(x_floor, y_floor);
    let p10 = img.get_pixel(x_floor + 1, y_floor);
    let p01 = img.get_pixel(x_floor, y_floor + 1);
    let p11 = img.get_pixel(x_floor + 1, y_floor + 1);
    let mut final_pixel = [0.0; 3];
    for i in 0..3 {
        let c00 = p00[i] as f64;
        let c10 = p10[i] as f64;
        let c01 = p01[i] as f64;
        let c11 = p11[i] as f64;
        let top = c00 * (1.0 - dx) + c10 * dx;
        let bottom = c01 * (1.0 - dx) + c11 * dx;
        final_pixel[i] = top * (1.0 - dy) + bottom * dy;
    }
    Rgb([
        final_pixel[0] as f32,
        final_pixel[1] as f32,
        final_pixel[2] as f32,
    ])
}