use rayon::prelude::*;

/// All values are normalized to `0.0..=1.0`.
#[derive(Debug, Clone, Copy)]
pub struct SkinRetouchParams {
    /// Evens out mid-frequency tonal unevenness (the "dodge & burn" part).
    pub smoothing: f32,
    /// How much of the fine skin texture (pores) is kept.
    pub texture: f32,
    /// Automatic removal of small spots (pimples, moles, dark dots).
    pub blemish: f32,
    /// Reduction of specular shine and sweat sparkles.
    pub shine: f32,
    /// Evens out color blotches and redness.
    pub even_tone: f32,
    /// How strongly non-skin pixels (eyes, lips, brows, hair) are left untouched.
    pub skin_protection: f32,
}

/// What a face parsing model knows about the pixels being retouched, as `0..=255`
/// probabilities aligned with the image buffer.
#[derive(Clone, Copy)]
pub struct FaceHints<'a> {
    /// Skin, including the parts washed out by shine that color alone cannot identify.
    pub skin: &'a [u8],
    /// Eyes, brows, lips, mouth and hair, which must never be retouched as skin.
    pub features: &'a [u8],
    /// Where spots may be removed. Everywhere on the skin when absent.
    pub blemish_zone: Option<&'a [u8]>,
}

#[inline]
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn box_1d(src: &[f32], dst: &mut [f32], r: usize) {
    let n = src.len();
    let mut sum = 0.0_f32;
    let mut lo = 0;
    let mut hi = 0;
    for (x, out) in dst.iter_mut().enumerate() {
        let want_hi = (x + r + 1).min(n);
        while hi < want_hi {
            sum += src[hi];
            hi += 1;
        }
        let want_lo = x.saturating_sub(r);
        while lo < want_lo {
            sum -= src[lo];
            lo += 1;
        }
        *out = sum / (hi - lo) as f32;
    }
}

fn box_h(src: &[f32], dst: &mut [f32], w: usize, r: usize) {
    dst.par_chunks_exact_mut(w)
        .zip(src.par_chunks_exact(w))
        .for_each(|(dst_row, src_row)| box_1d(src_row, dst_row, r));
}

fn box_v(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
    let mut sum = vec![0.0_f32; w];
    let mut lo = 0;
    let mut hi = 0;
    for y in 0..h {
        let want_hi = (y + r + 1).min(h);
        while hi < want_hi {
            let row = &src[hi * w..(hi + 1) * w];
            sum.iter_mut().zip(row).for_each(|(s, &v)| *s += v);
            hi += 1;
        }
        let want_lo = y.saturating_sub(r);
        while lo < want_lo {
            let row = &src[lo * w..(lo + 1) * w];
            sum.iter_mut().zip(row).for_each(|(s, &v)| *s -= v);
            lo += 1;
        }
        let inv = 1.0 / (hi - lo) as f32;
        dst[y * w..(y + 1) * w]
            .iter_mut()
            .zip(&sum)
            .for_each(|(d, &s)| *d = s * inv);
    }
}

fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0_f32; src.len()];
    let mut out = vec![0.0_f32; src.len()];
    box_h(src, &mut tmp, w, r);
    box_v(&tmp, &mut out, w, h, r);
    out
}

/// Gaussian approximation using three box blur passes.
fn gauss_blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma < 0.6 {
        return src.to_vec();
    }
    let ideal_width = (4.0 * sigma * sigma + 1.0).sqrt();
    let r = (((ideal_width - 1.0) / 2.0).round() as usize).max(1);

    let mut a = src.to_vec();
    let mut b = vec![0.0_f32; src.len()];
    for _ in 0..3 {
        box_h(&a, &mut b, w, r);
        box_v(&b, &mut a, w, h, r);
    }
    a
}

/// Normalized convolution: blurs `src` while ignoring pixels with low `weight`.
fn weighted_blur(src: &[f32], weight: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let weighted: Vec<f32> = src
        .par_iter()
        .zip(weight.par_iter())
        .map(|(&v, &k)| v * k)
        .collect();
    let mut num = gauss_blur(&weighted, w, h, sigma);
    let den = gauss_blur(weight, w, h, sigma);
    num.par_iter_mut()
        .zip(den.par_iter())
        .zip(src.par_iter())
        .for_each(|((n, &d), &s)| *n = if d > 1e-5 { *n / d } else { s });
    num
}

struct GuidedFilter<'a> {
    guide: &'a [f32],
    mean_i: Vec<f32>,
    var_i: Vec<f32>,
    w: usize,
    h: usize,
    r: usize,
}

impl<'a> GuidedFilter<'a> {
    fn new(guide: &'a [f32], w: usize, h: usize, r: usize) -> Self {
        let mean_i = box_blur(guide, w, h, r);
        let sq: Vec<f32> = guide.par_iter().map(|&v| v * v).collect();
        let mut var_i = box_blur(&sq, w, h, r);
        var_i
            .par_iter_mut()
            .zip(mean_i.par_iter())
            .for_each(|(v, &m)| *v = (*v - m * m).max(0.0));
        Self {
            guide,
            mean_i,
            var_i,
            w,
            h,
            r,
        }
    }

    fn filter(&self, p: &[f32], eps: f32) -> Vec<f32> {
        let mean_p = box_blur(p, self.w, self.h, self.r);
        let ip: Vec<f32> = self
            .guide
            .par_iter()
            .zip(p.par_iter())
            .map(|(&i, &v)| i * v)
            .collect();
        let mean_ip = box_blur(&ip, self.w, self.h, self.r);

        let mut a = vec![0.0_f32; p.len()];
        let mut b = vec![0.0_f32; p.len()];
        a.par_iter_mut()
            .zip(b.par_iter_mut())
            .enumerate()
            .for_each(|(i, (a_out, b_out))| {
                let cov = mean_ip[i] - self.mean_i[i] * mean_p[i];
                let a_val = cov / (self.var_i[i] + eps);
                *a_out = a_val;
                *b_out = mean_p[i] - a_val * self.mean_i[i];
            });

        let mean_a = box_blur(&a, self.w, self.h, self.r);
        let mut out = box_blur(&b, self.w, self.h, self.r);
        out.par_iter_mut()
            .zip(mean_a.par_iter())
            .zip(self.guide.par_iter())
            .for_each(|((o, &ma), &g)| *o += ma * g);
        out
    }
}

/// Gaussian skin-chroma model fitted to the pixels the user painted over.
struct SkinModel {
    mean: [f32; 2],
    inv_cov: [f32; 3],
}

impl SkinModel {
    #[inline]
    fn dist_sq(&self, cb: f32, cr: f32) -> f32 {
        let dx = cb - self.mean[0];
        let dy = cr - self.mean[1];
        self.inv_cov[0] * dx * dx + 2.0 * self.inv_cov[1] * dx * dy + self.inv_cov[2] * dy * dy
    }

    #[inline]
    fn probability(&self, cb: f32, cr: f32) -> f32 {
        1.0 - smoothstep(2.5, 4.5, self.dist_sq(cb, cr).sqrt())
    }

    /// Like `probability`, but also accepts the skin color washed out towards white by up
    /// to `min_saturation`, which is how specular shine on skin looks.
    #[inline]
    fn probability_desaturated(&self, cb: f32, cr: f32, min_saturation: f32) -> f32 {
        let [mx, my] = self.mean;
        let [a, b, c] = self.inv_cov;
        let along = a * cb * mx + b * (cb * my + cr * mx) + c * cr * my;
        let len = a * mx * mx + 2.0 * b * mx * my + c * my * my;
        let t = (along / len.max(1e-9)).clamp(min_saturation, 1.0);
        let dx = cb - t * mx;
        let dy = cr - t * my;
        let dist_sq = a * dx * dx + 2.0 * b * dx * dy + c * dy * dy;
        1.0 - smoothstep(2.5, 4.5, dist_sq.sqrt())
    }

    fn from_moments(n: f64, sx: f64, sy: f64, sxx: f64, sxy: f64, syy: f64) -> Self {
        const MIN_STD: f64 = 0.014;
        let mx = sx / n;
        let my = sy / n;
        let cxx = sxx / n - mx * mx + MIN_STD * MIN_STD;
        let cyy = syy / n - my * my + MIN_STD * MIN_STD;
        let cxy = sxy / n - mx * my;
        let det = (cxx * cyy - cxy * cxy).max(1e-12);
        Self {
            mean: [mx as f32, my as f32],
            inv_cov: [(cyy / det) as f32, (-cxy / det) as f32, (cxx / det) as f32],
        }
    }

    fn fit(y: &[f32], cb: &[f32], cr: &[f32], mask: &[u8]) -> Self {
        let fit_where = |pred: &dyn Fn(usize) -> bool| -> Option<(Self, usize)> {
            let (mut n, mut sx, mut sy, mut sxx, mut sxy, mut syy) =
                (0usize, 0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
            for i in 0..y.len() {
                if mask[i] > 76 && pred(i) {
                    let (x, v) = (cb[i] as f64, cr[i] as f64);
                    n += 1;
                    sx += x;
                    sy += v;
                    sxx += x * x;
                    sxy += x * v;
                    syy += v * v;
                }
            }
            (n > 0).then(|| (Self::from_moments(n as f64, sx, sy, sxx, sxy, syy), n))
        };

        let Some((all_painted, painted)) = fit_where(&|i| y[i] > 0.08) else {
            return Self::from_moments(1.0, -0.06, 0.08, 0.0036, -0.0048, 0.0064);
        };

        // Broad range that covers skin of any tone under reasonable white balance.
        let looks_like_skin = |i: usize| {
            y[i] > 0.08
                && y[i] < 0.98
                && cr[i] > 0.012
                && cr[i] < 0.25
                && cb[i] > -0.23
                && cb[i] < 0.02
        };
        let mut model = match fit_where(&looks_like_skin) {
            Some((m, n)) if n >= (painted / 20).max(64) => m,
            _ => all_painted,
        };

        for _ in 0..2 {
            let refined = fit_where(&|i| y[i] > 0.08 && model.dist_sq(cb[i], cr[i]) < 6.25);
            if let Some((refined, n)) = refined
                && n >= 64
            {
                model = refined;
            }
        }
        model
    }
}

/// Finds small compact spots that differ from the surrounding skin and fills them
/// with the surrounding tone plus texture borrowed from a clean neighbour.
#[allow(clippy::too_many_arguments)]
fn heal_blemishes(
    y: &mut [f32],
    cb: &mut [f32],
    cr: &mut [f32],
    skin: &[f32],
    mask: &[u8],
    w: usize,
    h: usize,
    scale: f32,
    amount: f32,
    zone: Option<&[u8]>,
) {
    let n = w * h;
    let sigma_b = (scale / 80.0).clamp(2.0, 24.0);
    let skin_weight: Vec<f32> = skin.par_iter().map(|&v| v + 0.02).collect();

    let fine_y = gauss_blur(y, w, h, (sigma_b / 3.0).max(0.8));
    let bg_y = weighted_blur(y, &skin_weight, w, h, sigma_b * 2.0);
    let fine_cr = gauss_blur(cr, w, h, (sigma_b / 3.0).max(0.8));
    let bg_cr = weighted_blur(cr, &skin_weight, w, h, sigma_b * 2.0);

    let (mut dev_y, mut dev_c, mut count) = (0.0_f64, 0.0_f64, 0usize);
    for i in 0..n {
        if mask[i] > 76 && skin[i] > 0.5 {
            dev_y += (fine_y[i] - bg_y[i]).abs() as f64;
            dev_c += (fine_cr[i] - bg_cr[i]).abs() as f64;
            count += 1;
        }
    }
    if count < 64 {
        return;
    }
    let sig_y = ((1.2533 * dev_y / count as f64) as f32).max(0.006);
    let sig_c = ((1.2533 * dev_c / count as f64) as f32).max(0.003);

    // Nostrils, mouth corners and ear canals are far darker than any blemish. They are
    // anatomy, so they and their rims are kept out of the spot search.
    let deep_shadow: Vec<f32> = (0..n)
        .into_par_iter()
        .map(|i| 1.0 - smoothstep(0.55, 0.75, fine_y[i] / bg_y[i].max(1e-3)))
        .collect();
    let mut shadow_guard = gauss_blur(&deep_shadow, w, h, sigma_b * 1.2);
    shadow_guard
        .par_iter_mut()
        .for_each(|v| *v = (*v * 8.0).min(1.0));

    // Spots are darker and/or redder than their surroundings.
    let score: Vec<f32> = (0..n)
        .into_par_iter()
        .map(|i| {
            let spot = ((bg_y[i] - fine_y[i]) / sig_y).max((fine_cr[i] - bg_cr[i]) / sig_c);
            spot * (1.0 - shadow_guard[i])
        })
        .collect();
    // How blob-like the score is around a pixel, from its Hessian: 1 for a round spot, 0
    // for a line, and nothing at all where the score is not a local bump.
    let roundness_of = |smooth: &[f32], step: usize, px: usize, py: usize| -> Option<f32> {
        let (x0, x1) = (px.saturating_sub(step), (px + step).min(w - 1));
        let (y0, y1) = (py.saturating_sub(step), (py + step).min(h - 1));
        let c = smooth[py * w + px];
        let lxx = smooth[py * w + x0] + smooth[py * w + x1] - 2.0 * c;
        let lyy = smooth[y0 * w + px] + smooth[y1 * w + px] - 2.0 * c;
        let lxy =
            (smooth[y1 * w + x1] + smooth[y0 * w + x0] - smooth[y0 * w + x1] - smooth[y1 * w + x0])
                * 0.25;
        let trace = lxx + lyy;
        (trace < 0.0).then(|| 4.0 * (lxx * lyy - lxy * lxy) / (trace * trace))
    };

    // A spot is round both up close and from further away. Folds, wrinkles, lash lines
    // and lip edges can look like a string of spots up close, but from further away they
    // are lines, and lines are never touched.
    let near = gauss_blur(&score, w, h, sigma_b * 0.6);
    let near_step = ((sigma_b * 0.6).round() as usize).max(1);
    let far = gauss_blur(&score, w, h, sigma_b * 1.6);
    let far_step = ((sigma_b * 1.6).round() as usize).max(1);
    let threshold = 4.5 - 2.5 * amount;

    let mut spots = vec![0.0_f32; n];
    spots
        .par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(py, row)| {
            for (px, out) in row.iter_mut().enumerate() {
                let i = py * w + px;
                if mask[i] == 0 {
                    continue;
                }
                let in_zone = zone.map_or(1.0, |zone| zone[i] as f32 / 255.0);
                let strength = smoothstep(threshold, threshold + 1.0, score[i]) * skin[i] * in_zone;
                if strength <= 0.0 {
                    continue;
                }
                let Some(roundness) = roundness_of(&near, near_step, px, py)
                    .zip(roundness_of(&far, far_step, px, py))
                    .map(|(near, far)| near.min(far))
                else {
                    continue;
                };
                *out = strength * smoothstep(0.3, 0.6, roundness);
            }
        });

    let mut cover = gauss_blur(&spots, w, h, sigma_b * 0.8);
    cover
        .par_iter_mut()
        .zip(spots.par_iter())
        .zip(shadow_guard.par_iter())
        .for_each(|((c, &s), &guard)| *c = (*c * 4.0).max(s).min(1.0) * (1.0 - guard));

    let clean_weight: Vec<f32> = cover
        .par_iter()
        .zip(skin_weight.par_iter())
        .map(|(&c, &s)| (1.0 - c) * s)
        .collect();

    let base_y = weighted_blur(y, &clean_weight, w, h, sigma_b * 1.5);
    let base_cb = weighted_blur(cb, &clean_weight, w, h, sigma_b * 1.5);
    let base_cr = weighted_blur(cr, &clean_weight, w, h, sigma_b * 1.5);

    let low = gauss_blur(y, w, h, (scale / 250.0).clamp(1.0, 6.0));
    let texture: Vec<f32> = y
        .par_iter()
        .zip(low.par_iter())
        .map(|(&v, &l)| v - l)
        .collect();
    let reach = (sigma_b * 3.0).ceil() as isize;
    let offsets = [(reach, 0), (-reach, 0), (0, reach), (0, -reach)];

    let healed_y: Vec<f32> = (0..n)
        .into_par_iter()
        .map(|i| {
            let c = cover[i];
            if c <= 0.003 {
                return y[i];
            }
            let (px, py) = ((i % w) as isize, (i / w) as isize);
            let mut best_weight = 0.05_f32;
            let mut borrowed = 0.0_f32;
            for (dx, dy) in offsets {
                let (qx, qy) = (px + dx, py + dy);
                if qx < 0 || qy < 0 || qx >= w as isize || qy >= h as isize {
                    continue;
                }
                let q = qy as usize * w + qx as usize;
                if clean_weight[q] > best_weight {
                    best_weight = clean_weight[q];
                    borrowed = texture[q];
                }
            }
            y[i] + c * (base_y[i] + borrowed - y[i])
        })
        .collect();

    y.copy_from_slice(&healed_y);
    cb.par_iter_mut()
        .zip(base_cb.par_iter())
        .zip(cover.par_iter())
        .for_each(|((v, &b), &c)| *v += c * (b - *v));
    cr.par_iter_mut()
        .zip(base_cr.par_iter())
        .zip(cover.par_iter())
        .for_each(|((v, &b), &c)| *v += c * (b - *v));
}

fn percentile(hist: &[u32], total: u32, fraction: f32) -> f32 {
    let target = (total as f32 * fraction) as u32;
    let mut acc = 0;
    for (bin, &count) in hist.iter().enumerate() {
        acc += count;
        if acc >= target {
            return bin as f32 / (hist.len() - 1) as f32;
        }
    }
    1.0
}

/// Portrait skin retouch on an sRGB encoded RGB8 buffer.
///
/// `mask` is the painted area and `scale` the approximate size in pixels of the region
/// being retouched (roughly the face width), which sets every filter radius.
pub fn retouch_skin(
    rgb: &[u8],
    mask: &[u8],
    w: usize,
    h: usize,
    scale: f32,
    params: &SkinRetouchParams,
    hints: Option<FaceHints>,
) -> Vec<u8> {
    let n = w * h;
    let scale = scale.clamp(80.0, 4000.0);

    let mut y = vec![0.0_f32; n];
    let mut cb = vec![0.0_f32; n];
    let mut cr = vec![0.0_f32; n];
    y.par_iter_mut()
        .zip(cb.par_iter_mut())
        .zip(cr.par_iter_mut())
        .zip(rgb.par_chunks_exact(3))
        .for_each(|(((y_out, cb_out), cr_out), px)| {
            let r = px[0] as f32 / 255.0;
            let g = px[1] as f32 / 255.0;
            let b = px[2] as f32 / 255.0;
            let luma = 0.299 * r + 0.587 * g + 0.114 * b;
            *y_out = luma;
            *cb_out = (b - luma) * 0.564;
            *cr_out = (r - luma) * 0.713;
        });

    let model = SkinModel::fit(&y, &cb, &cr, mask);
    let mut luma_hist = [0u32; 256];
    let mut skin_count = 0u32;
    for i in 0..n {
        if mask[i] > 76 && model.probability(cb[i], cr[i]) > 0.5 {
            luma_hist[(y[i].clamp(0.0, 1.0) * 255.0) as usize] += 1;
            skin_count += 1;
        }
    }
    let skin_luma = if skin_count > 0 {
        percentile(&luma_hist, skin_count, 0.5)
    } else {
        0.5
    };

    let skin_raw: Vec<f32> = (0..n)
        .into_par_iter()
        .map(|i| {
            // Only pixels clearly brighter than the skin may be desaturated shine.
            let washout = smoothstep(skin_luma + 0.08, skin_luma + 0.30, y[i]);
            let by_color = model.probability_desaturated(cb[i], cr[i], 1.0 - 0.7 * washout)
                * smoothstep(0.03, 0.10, y[i]);
            match hints {
                Some(hints) => {
                    let skin = hints.skin[i] as f32 / 255.0;
                    let features = hints.features[i] as f32 / 255.0;
                    (by_color + (1.0 - by_color) * 0.6 * skin) * (1.0 - features)
                }
                None => by_color,
            }
        })
        .collect();
    let skin = gauss_blur(&skin_raw, w, h, (scale / 250.0).clamp(1.0, 4.0));
    let skin_weight: Vec<f32> = skin.par_iter().map(|&v| v + 0.02).collect();

    if params.blemish > 0.001 {
        heal_blemishes(
            &mut y,
            &mut cb,
            &mut cr,
            &skin,
            mask,
            w,
            h,
            scale,
            params.blemish,
            hints.and_then(|hints| hints.blemish_zone),
        );
    }

    // Frequency separation: fine texture is kept apart while tone is evened out below it.
    let low = gauss_blur(&y, w, h, (scale / 250.0).clamp(1.0, 6.0));
    let texture_gain = 0.25 + 0.75 * params.texture;
    let mut high: Vec<f32> = y
        .par_iter()
        .zip(low.par_iter())
        .map(|(&v, &l)| (v - l) * texture_gain)
        .collect();

    let radius = ((scale / 30.0).round() as usize).clamp(4, 96);
    let guided = GuidedFilter::new(&low, w, h, radius);
    let eps = (0.02 + 0.06 * params.smoothing).powi(2);

    let low_smooth = guided.filter(&low, eps);
    let mut y_low: Vec<f32> = low
        .par_iter()
        .zip(low_smooth.par_iter())
        .map(|(&l, &s)| l + params.smoothing * (s - l))
        .collect();

    if params.even_tone > 0.001 {
        for plane in [&mut cb, &mut cr] {
            let local = guided.filter(plane, eps);
            let broad = weighted_blur(plane, &skin_weight, w, h, radius as f32 * 2.0);
            plane
                .par_iter_mut()
                .zip(local.par_iter())
                .zip(broad.par_iter())
                .for_each(|((v, &l), &b)| {
                    *v += params.even_tone * (l - *v) + 0.5 * params.even_tone * (b - l);
                });
        }
    }

    if params.shine > 0.001 {
        let mut hist = [0u32; 1024];
        let (mut total, mut high_dev) = (0u32, 0.0_f64);
        for i in 0..n {
            if mask[i] > 76 && skin[i] > 0.5 {
                hist[(y_low[i].clamp(0.0, 1.0) * 1023.0) as usize] += 1;
                high_dev += high[i].abs() as f64;
                total += 1;
            }
        }

        if total >= 64 {
            let median = percentile(&hist, total, 0.5);
            let peak = percentile(&hist, total, 0.995);
            let range = ((peak - median) * 0.6).max(0.04);
            let strength = params.shine;

            // Shine is whatever rises above the broad local skin brightness.
            let ambient = weighted_blur(&y_low, &skin_weight, w, h, scale / 8.0);
            let mut shine = vec![0.0_f32; n];
            y_low
                .par_iter_mut()
                .zip(shine.par_iter_mut())
                .zip(ambient.par_iter())
                .for_each(|((v, s), &a)| {
                    let floor = a + 0.02;
                    let excess = *v - floor;
                    if excess > 0.0 {
                        *s = smoothstep(0.0, range, excess);
                        *v = floor + excess / (1.0 + 3.0 * strength * excess / range);
                    }
                });

            // Specular highlights are desaturated, so bring back the surrounding skin color.
            let matte_weight: Vec<f32> = skin_weight
                .par_iter()
                .zip(shine.par_iter())
                .map(|(&k, &s)| k * (1.0 - s))
                .collect();
            for plane in [&mut cb, &mut cr] {
                let reference = weighted_blur(plane, &matte_weight, w, h, radius as f32 * 1.5);
                plane
                    .par_iter_mut()
                    .zip(reference.par_iter())
                    .zip(shine.par_iter())
                    .for_each(|((v, &r), &s)| *v += 0.8 * strength * s * (r - *v));
            }

            // Sweat sparkles live in the texture layer as isolated bright outliers.
            let sig_h = ((1.2533 * high_dev / total as f64) as f32).max(0.002);
            high.par_iter_mut().for_each(|v| {
                *v *= 1.0 - 0.85 * strength * smoothstep(2.5, 4.5, *v / sig_h);
            });
        }
    }

    let mut out = vec![0u8; n * 3];
    out.par_chunks_exact_mut(3)
        .zip(rgb.par_chunks_exact(3))
        .enumerate()
        .for_each(|(i, (dst, src))| {
            if mask[i] == 0 {
                dst.copy_from_slice(src);
                return;
            }
            let m = mask[i] as f32 / 255.0;
            let blend = m * m * (3.0 - 2.0 * m) * (1.0 - params.skin_protection * (1.0 - skin[i]));

            let luma = y_low[i] + high[i];
            let result = [
                luma + 1.403 * cr[i],
                luma - 0.344 * cb[i] - 0.714 * cr[i],
                luma + 1.773 * cb[i],
            ];
            for c in 0..3 {
                let original = src[c] as f32;
                let target = result[c] * 255.0;
                dst[c] = (original + blend * (target - original))
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        });
    out
}

/// Faces wider than this are retouched on a reduced copy; see `retouch_skin_scaled`.
const WORKING_SCALE: f32 = 640.0;

/// Area-averaging reduction of an interleaved 8-bit buffer.
fn shrink(
    src: &[u8],
    w: usize,
    h: usize,
    channels: usize,
    small_w: usize,
    small_h: usize,
) -> Vec<u8> {
    let mut out = vec![0u8; small_w * small_h * channels];
    out.par_chunks_exact_mut(small_w * channels)
        .enumerate()
        .for_each(|(sy, row)| {
            let y0 = sy * h / small_h;
            let y1 = ((sy + 1) * h / small_h).max(y0 + 1).min(h);
            for sx in 0..small_w {
                let x0 = sx * w / small_w;
                let x1 = ((sx + 1) * w / small_w).max(x0 + 1).min(w);
                let count = ((x1 - x0) * (y1 - y0)) as u32;
                for c in 0..channels {
                    let mut sum = 0u32;
                    for y in y0..y1 {
                        for x in x0..x1 {
                            sum += src[(y * w + x) * channels + c] as u32;
                        }
                    }
                    row[sx * channels + c] = ((sum + count / 2) / count) as u8;
                }
            }
        });
    out
}

/// Same result as `retouch_skin`, but large faces are processed on a reduced copy and only
/// the change is brought back to full size, so the cost no longer grows with the face.
///
/// Everything the retouch alters is coarser than the reduced copy can represent except
/// the finest skin texture, which is handled separately at full size.
pub fn retouch_skin_scaled(
    rgb: &[u8],
    mask: &[u8],
    w: usize,
    h: usize,
    scale: f32,
    params: &SkinRetouchParams,
    hints: Option<FaceHints>,
) -> Vec<u8> {
    let factor = scale / WORKING_SCALE;
    if factor <= 1.25 {
        return retouch_skin(rgb, mask, w, h, scale, params, hints);
    }

    let small_w = ((w as f32 / factor).round() as usize).max(8);
    let small_h = ((h as f32 / factor).round() as usize).max(8);
    let small = shrink(rgb, w, h, 3, small_w, small_h);
    let small_mask = shrink(mask, w, h, 1, small_w, small_h);
    let small_hints = hints.map(|hints| {
        (
            shrink(hints.skin, w, h, 1, small_w, small_h),
            shrink(hints.features, w, h, 1, small_w, small_h),
            hints
                .blemish_zone
                .map(|zone| shrink(zone, w, h, 1, small_w, small_h)),
        )
    });

    let retouched = retouch_skin(
        &small,
        &small_mask,
        small_w,
        small_h,
        WORKING_SCALE,
        params,
        small_hints
            .as_ref()
            .map(|(skin, features, blemish_zone)| FaceHints {
                skin,
                features,
                blemish_zone: blemish_zone.as_deref(),
            }),
    );

    let texture_gain = 0.25 + 0.75 * params.texture;
    let (step_x, step_y) = (small_w as f32 / w as f32, small_h as f32 / h as f32);
    let mut out = vec![0u8; rgb.len()];
    out.par_chunks_exact_mut(w * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = ((y as f32 + 0.5) * step_y - 0.5).clamp(0.0, (small_h - 1) as f32);
            let y0 = fy as usize;
            let y1 = (y0 + 1).min(small_h - 1);
            let ty = fy - y0 as f32;

            for x in 0..w {
                let i = y * w + x;
                let src = &rgb[i * 3..i * 3 + 3];
                let dst = &mut row[x * 3..x * 3 + 3];
                if mask[i] == 0 {
                    dst.copy_from_slice(src);
                    continue;
                }

                let fx = ((x as f32 + 0.5) * step_x - 0.5).clamp(0.0, (small_w - 1) as f32);
                let x0 = fx as usize;
                let x1 = (x0 + 1).min(small_w - 1);
                let tx = fx - x0 as f32;
                let sample = |buf: &[u8], c: usize| {
                    let at = |sx: usize, sy: usize| buf[(sy * small_w + sx) * 3 + c] as f32;
                    let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
                    let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
                    top + (bottom - top) * ty
                };

                // Pores finer than the reduced copy follow the texture setting on skin only.
                let fine_weight = match hints {
                    Some(hints) => {
                        let skin =
                            hints.skin[i] as f32 * (255 - hints.features[i]) as f32 / 65025.0;
                        mask[i] as f32 / 255.0 * skin * (texture_gain - 1.0)
                    }
                    None => 0.0,
                };
                for c in 0..3 {
                    let original = src[c] as f32;
                    let coarse = sample(&small, c);
                    let change = sample(&retouched, c) - coarse;
                    dst[c] = (original + change + fine_weight * (original - coarse))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        });
    out
}

/// Eye and teeth regions of a face, as `0..=255` planes aligned with the image buffer,
/// and how strongly (`0.0..=1.0`) each should be enhanced.
pub struct FeatureEnhance<'a> {
    pub eyes: &'a [u8],
    pub eye_whites: &'a [u8],
    pub teeth: &'a [u8],
    pub eye_amount: f32,
    pub teeth_amount: f32,
}

/// Adds clarity to the eyes, cleans up their whites and whitens teeth, in place on an
/// sRGB encoded RGB8 buffer.
pub fn enhance_eyes_and_teeth(
    rgb: &mut [u8],
    w: usize,
    h: usize,
    scale: f32,
    features: &FeatureEnhance,
) {
    let luma_of =
        |px: &[u8]| (0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32) / 255.0;

    // Clarity compares each eye pixel with a blurred copy; only the box around the eyes
    // is blurred, since that is the only place the result is used.
    let sigma = (scale / 150.0).clamp(1.0, 6.0);
    let mut eye_box = None;
    if features.eye_amount > 0.0 {
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for (i, &eye) in features.eyes.iter().enumerate() {
            if eye > 0 {
                x0 = x0.min(i % w);
                x1 = x1.max(i % w);
                y0 = y0.min(i / w);
                y1 = y1.max(i / w);
            }
        }
        if x0 <= x1 {
            let margin = (sigma * 3.0).ceil() as usize;
            let (x0, y0) = (x0.saturating_sub(margin), y0.saturating_sub(margin));
            let (x1, y1) = ((x1 + margin + 1).min(w), (y1 + margin + 1).min(h));
            let (bw, bh) = (x1 - x0, y1 - y0);
            let mut luma = vec![0.0_f32; bw * bh];
            luma.par_chunks_exact_mut(bw)
                .enumerate()
                .for_each(|(by, row)| {
                    for (bx, value) in row.iter_mut().enumerate() {
                        let i = ((y0 + by) * w + x0 + bx) * 3;
                        *value = luma_of(&rgb[i..i + 3]);
                    }
                });
            eye_box = Some((x0, y0, bw, bh, gauss_blur(&luma, bw, bh, sigma)));
        }
    }

    rgb.par_chunks_exact_mut(3).enumerate().for_each(|(i, px)| {
        let clarity = features.eyes[i] as f32 / 255.0 * features.eye_amount;
        let whites = features.eye_whites[i] as f32 / 255.0 * features.eye_amount;
        let teeth = features.teeth[i] as f32 / 255.0 * features.teeth_amount;
        if clarity <= 0.0 && teeth <= 0.0 {
            return;
        }

        let (r, b) = (px[0] as f32 / 255.0, px[2] as f32 / 255.0);
        let mut y = luma_of(px);
        let mut cb = (b - y) * 0.564;
        let mut cr = (r - y) * 0.713;

        if let Some((x0, y0, bw, bh, soft)) = &eye_box {
            let (x, row) = (i % w, i / w);
            if clarity > 0.0 && x >= *x0 && row >= *y0 && x < x0 + bw && row < y0 + bh {
                y += 0.9 * clarity * (y - soft[(row - y0) * bw + (x - x0)]);
            }
        }
        y *= 1.0 + 0.22 * whites + 0.16 * teeth;
        let keep_color = (1.0 - 0.45 * whites) * (1.0 - 0.6 * teeth);
        cb *= keep_color;
        cr *= keep_color;

        let result = [y + 1.403 * cr, y - 0.344 * cb - 0.714 * cr, y + 1.773 * cb];
        for c in 0..3 {
            px[c] = (result[c] * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: usize = 240;

    fn params() -> SkinRetouchParams {
        SkinRetouchParams {
            smoothing: 0.5,
            texture: 0.75,
            blemish: 0.6,
            shine: 0.5,
            even_tone: 0.4,
            skin_protection: 0.85,
        }
    }

    fn skin_image() -> Vec<u8> {
        let mut seed = 12345_u32;
        let mut rgb = Vec::with_capacity(SIZE * SIZE * 3);
        for _ in 0..SIZE * SIZE {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = ((seed >> 24) as i32 % 7) - 3;
            for base in [205_i32, 155, 130] {
                rgb.push((base + noise) as u8);
            }
        }
        rgb
    }

    fn paint_disc(rgb: &mut [u8], cx: usize, cy: usize, radius: i32, color: [u8; 3]) {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx * dx + dy * dy <= radius * radius {
                    let i = ((cy as i32 + dy) as usize * SIZE + (cx as i32 + dx) as usize) * 3;
                    rgb[i..i + 3].copy_from_slice(&color);
                }
            }
        }
    }

    fn luma_at(rgb: &[u8], x: usize, y: usize) -> f32 {
        let i = (y * SIZE + x) * 3;
        0.299 * rgb[i] as f32 + 0.587 * rgb[i + 1] as f32 + 0.114 * rgb[i + 2] as f32
    }

    #[test]
    fn removes_dark_spot_and_keeps_unmasked_pixels() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 120, 120, 4, [150, 95, 80]);

        let mut mask = vec![255u8; SIZE * SIZE];
        for row in mask.chunks_exact_mut(SIZE).take(20) {
            row.fill(0);
        }

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &params(), None);

        assert_eq!(&out[..20 * SIZE * 3], &rgb[..20 * SIZE * 3]);

        let surround = luma_at(&rgb, 60, 120);
        let before = surround - luma_at(&rgb, 120, 120);
        let after = surround - luma_at(&out, 120, 120);
        assert!(after < before * 0.4, "spot went from {before} to {after}");
    }

    #[test]
    fn tames_specular_highlight() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 120, 120, 14, [250, 240, 235]);
        let mask = vec![255u8; SIZE * SIZE];

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &params(), None);
        assert!(luma_at(&out, 120, 120) < luma_at(&rgb, 120, 120) - 8.0);
    }

    #[test]
    fn face_hints_protect_skin_colored_features() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 120, 120, 4, [150, 95, 80]);
        let mask = vec![255u8; SIZE * SIZE];
        let skin = vec![255u8; SIZE * SIZE];
        let mut features = vec![0u8; SIZE * SIZE];
        for y in 100..140 {
            features[y * SIZE + 100..y * SIZE + 140].fill(255);
        }
        let hints = FaceHints {
            skin: &skin,
            features: &features,
            blemish_zone: None,
        };

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &params(), Some(hints));
        assert!((luma_at(&out, 120, 120) - luma_at(&rgb, 120, 120)).abs() < 6.0);
    }

    #[test]
    fn whitens_teeth_only_where_marked() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 120, 120, 10, [200, 185, 140]);
        let original = rgb.clone();
        let none = vec![0u8; SIZE * SIZE];
        let mut teeth = vec![0u8; SIZE * SIZE];
        for y in 112..128 {
            teeth[y * SIZE + 112..y * SIZE + 128].fill(255);
        }

        enhance_eyes_and_teeth(
            &mut rgb,
            SIZE,
            SIZE,
            480.0,
            &FeatureEnhance {
                eyes: &none,
                eye_whites: &none,
                teeth: &teeth,
                eye_amount: 1.0,
                teeth_amount: 1.0,
            },
        );

        let i = (120 * SIZE + 120) * 3;
        let yellowness = |px: &[u8]| px[0] as i32 - px[2] as i32;
        assert!(yellowness(&rgb[i..i + 3]) < yellowness(&original[i..i + 3]) / 2);
        assert!(luma_at(&rgb, 120, 120) > luma_at(&original, 120, 120));
        assert_eq!(&rgb[..60 * SIZE * 3], &original[..60 * SIZE * 3]);
    }

    #[test]
    fn keeps_nostril_like_deep_shadows() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 120, 120, 5, [70, 38, 30]);
        paint_disc(&mut rgb, 60, 120, 4, [150, 95, 80]);
        let mask = vec![255u8; SIZE * SIZE];
        let strong = SkinRetouchParams {
            blemish: 1.0,
            ..params()
        };

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &strong, None);

        let nostril_before = luma_at(&rgb, 120, 120);
        assert!(
            luma_at(&out, 120, 120) < nostril_before + 12.0,
            "nostril went from {nostril_before} to {}",
            luma_at(&out, 120, 120)
        );
        // A real blemish next to it is still removed.
        let surround = luma_at(&rgb, 60, 60);
        assert!(surround - luma_at(&out, 60, 120) < (surround - luma_at(&rgb, 60, 120)) * 0.4);
    }

    #[test]
    fn scaled_retouch_matches_full_size_retouch() {
        const BIG: usize = 720;
        let mut seed = 99_u32;
        let mut rgb = Vec::with_capacity(BIG * BIG * 3);
        for _ in 0..BIG * BIG {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = ((seed >> 24) as i32 % 7) - 3;
            for base in [205_i32, 155, 130] {
                rgb.push((base + noise) as u8);
            }
        }
        let center = (BIG / 2) as i32;
        for dy in -12_i32..=12 {
            for dx in -12_i32..=12 {
                if dx * dx + dy * dy <= 144 {
                    let i = ((center + dy) as usize * BIG + (center + dx) as usize) * 3;
                    rgb[i..i + 3].copy_from_slice(&[150, 95, 80]);
                }
            }
        }
        let mut mask = vec![255u8; BIG * BIG];
        mask[..40 * BIG].fill(0);
        let luma = |buf: &[u8], x: usize, y: usize| {
            let i = (y * BIG + x) * 3;
            0.299 * buf[i] as f32 + 0.587 * buf[i + 1] as f32 + 0.114 * buf[i + 2] as f32
        };

        let scale = 1440.0;
        let full = retouch_skin(&rgb, &mask, BIG, BIG, scale, &params(), None);
        let scaled = retouch_skin_scaled(&rgb, &mask, BIG, BIG, scale, &params(), None);

        assert_eq!(&scaled[..40 * BIG * 3], &rgb[..40 * BIG * 3]);
        let c = BIG / 2;
        let spot = luma(&rgb, 60, c) - luma(&rgb, c, c);
        assert!(luma(&rgb, 60, c) - luma(&scaled, c, c) < spot * 0.4);
        assert!((luma(&scaled, c, c) - luma(&full, c, c)).abs() < 12.0);
    }

    #[test]
    fn removes_spots_only_inside_the_blemish_zone() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 60, 120, 4, [150, 95, 80]);
        paint_disc(&mut rgb, 180, 120, 4, [150, 95, 80]);
        let mask = vec![255u8; SIZE * SIZE];
        let skin = vec![255u8; SIZE * SIZE];
        let features = vec![0u8; SIZE * SIZE];
        let mut zone = vec![0u8; SIZE * SIZE];
        for row in zone.chunks_exact_mut(SIZE) {
            row[..120].fill(255);
        }
        let hints = FaceHints {
            skin: &skin,
            features: &features,
            blemish_zone: Some(&zone),
        };
        let only_blemish = SkinRetouchParams {
            smoothing: 0.0,
            texture: 1.0,
            blemish: 1.0,
            shine: 0.0,
            even_tone: 0.0,
            skin_protection: 0.85,
        };

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &only_blemish, Some(hints));

        let surround = luma_at(&rgb, 120, 60);
        let spot = surround - luma_at(&rgb, 60, 120);
        assert!(
            surround - luma_at(&out, 60, 120) < spot * 0.4,
            "inside the zone"
        );
        assert!(
            surround - luma_at(&out, 180, 120) > spot * 0.9,
            "outside the zone"
        );
    }

    #[test]
    fn keeps_fold_like_shadows() {
        let mut rgb = skin_image();
        // A soft dark crease, like a nasolabial fold, and a real spot away from it.
        for step in 0..90 {
            let (x, y) = (80 + step / 3, 70 + step);
            paint_disc(&mut rgb, x, y, 3, [178, 128, 104]);
        }
        paint_disc(&mut rgb, 180, 120, 4, [150, 95, 80]);
        let mask = vec![255u8; SIZE * SIZE];
        let only_blemish = SkinRetouchParams {
            smoothing: 0.0,
            texture: 1.0,
            blemish: 1.0,
            shine: 0.0,
            even_tone: 0.0,
            skin_protection: 0.85,
        };

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &only_blemish, None);

        let surround = luma_at(&rgb, 30, 30);
        for step in [20, 45, 70] {
            let (x, y) = (80 + step / 3, 70 + step);
            let before = surround - luma_at(&rgb, x, y);
            let after = surround - luma_at(&out, x, y);
            assert!(
                after > before * 0.8,
                "fold at {x},{y} went from {before} to {after}"
            );
        }
        let spot = surround - luma_at(&rgb, 180, 120);
        assert!(surround - luma_at(&out, 180, 120) < spot * 0.4, "spot");
    }

    #[test]
    fn protects_non_skin_colors() {
        let mut rgb = skin_image();
        paint_disc(&mut rgb, 120, 120, 12, [40, 90, 160]);
        let mask = vec![255u8; SIZE * SIZE];

        let out = retouch_skin(&rgb, &mask, SIZE, SIZE, 480.0, &params(), None);
        let i = (120 * SIZE + 120) * 3;
        for c in 0..3 {
            assert!((out[i + c] as i32 - rgb[i + c] as i32).abs() <= 12);
        }
    }
}
