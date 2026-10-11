use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::panorama_utils::spill::Store;
use rayon::prelude::*;

pub struct BlendTick<'a> {
    done: AtomicU64,
    total: u64,
    last_pct: AtomicU32,
    report: &'a (dyn Fn(&str, f64) + Sync + 'a),
}

impl<'a> BlendTick<'a> {
    pub fn new(total: u64, report: &'a (dyn Fn(&str, f64) + Sync + 'a)) -> Self {
        Self {
            done: AtomicU64::new(0),
            total: total.max(1),
            last_pct: AtomicU32::new(0),
            report,
        }
    }
    pub fn rows(&self, n: u64) {
        if n == 0 {
            return;
        }
        let prev = self.done.fetch_add(n, Ordering::Relaxed);
        let now = prev.saturating_add(n).min(self.total);
        self.emit_at(now);
    }
    pub fn flush(&self) {
        let now = self.done.load(Ordering::Relaxed).min(self.total);
        self.emit_at(now);
    }
    fn emit_at(&self, now: u64) {
        let pct = ((now.saturating_mul(100)) / self.total) as u32;
        let prev = self.last_pct.fetch_max(pct, Ordering::Relaxed);
        if pct > prev {
            let frac = (now as f64 / self.total as f64).min(1.0);
            (self.report)("Blending", frac);
        }
    }
}

pub fn blend_work_rows(
    tile_heights: impl IntoIterator<Item = usize>,
    levels: usize,
    canvas_h: usize,
) -> u64 {
    let mut rows = 0u64;
    for th in tile_heights {
        let mut h = th;
        for l in 0..=levels {
            if l < levels {
                let h2 = h.div_ceil(2);
                rows += 2 * (h as u64 + h2 as u64);
                rows += h as u64;
                rows += h as u64;
                h = h2;
            } else {
                rows += h as u64;
            }
        }
    }
    for l in (0..=levels).rev() {
        let bh = level_dim(canvas_h, l) as u64;
        rows += bh;
        if l != levels {
            rows += bh;
        }
    }
    rows
}

pub fn level_dim(n: usize, level: usize) -> usize {
    let mut s = n.max(1);
    for _ in 0..level {
        s = s.div_ceil(2);
    }
    s
}

fn tick_row(tick: Option<&BlendTick>) {
    if let Some(tick) = tick {
        tick.rows(1);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Buf {
    pub w: usize,
    pub h: usize,
    pub c: usize,
    pub data: Store<f32>,
}

impl Buf {

    pub fn new(w: usize, h: usize, c: usize) -> Buf {
        Buf {
            w,
            h,
            c,
            data: Store::zeroes(w * h * c),
        }
    }
    pub fn try_new(
        w: usize,
        h: usize,
        c: usize,
        scratch: Option<&crate::panorama_utils::spill::SpillFile>,
    ) -> Result<Buf, String> {
        Ok(Buf {
            w,
            h,
            c,
            data: Store::try_mapped(w * h * c, scratch)?,
        })
    }
    pub fn empty() -> Buf {
        Buf {
            w: 0,
            h: 0,
            c: 0,
            data: Store::empty(),
        }
    }
    #[inline]
    fn at(&self, x: isize, y: isize, ch: usize) -> f32 {
        let x = x.clamp(0, self.w as isize - 1) as usize;
        let y = y.clamp(0, self.h as isize - 1) as usize;
        self.data[(y * self.w + x) * self.c + ch]
    }
}

const K: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

fn tap_covered(covered: Option<&[f32]>, w: usize, h: usize, x: isize, y: isize) -> bool {
    let Some(covered) = covered else {
        return true;
    };
    if w == 0 || h == 0 {
        return false;
    }
    let inside = x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h;
    let (x, y) = if inside {
        (x as usize, y as usize)
    } else {
        (
            x.clamp(0, w as isize - 1) as usize,
            y.clamp(0, h as isize - 1) as usize,
        )
    };
    covered[y * w + x] > 0.0
}

fn reduce_axis(
    src: &Buf,
    covered: Option<&[f32]>,
    horizontal: bool,
    tick: Option<&BlendTick>,
) -> (Buf, Vec<f32>) {
    let (w2, h2) = if horizontal {
        (src.w.div_ceil(2), src.h)
    } else {
        (src.w, src.h.div_ceil(2))
    };
    let mut out = Buf::new(w2, h2, src.c);
    let mut painted = vec![0.0f32; w2 * h2];
    out.data
        .par_chunks_mut(w2 * src.c)
        .zip(painted.par_chunks_mut(w2))
        .enumerate()
        .for_each(|(y, (row, prow))| {
            for x in 0..w2 {
                let mut ws = 0.0f32;
                let mut use_k = [false; 5];
                for (k, wk) in K.iter().enumerate() {
                    let (sx, sy) = if horizontal {
                        (2 * x as isize + k as isize - 2, y as isize)
                    } else {
                        (x as isize, 2 * y as isize + k as isize - 2)
                    };
                    if tap_covered(covered, src.w, src.h, sx, sy) {
                        use_k[k] = true;
                        ws += wk;
                    }
                }
                prow[x] = if ws > 0.0 { 1.0 } else { 0.0 };
                for ch in 0..src.c {
                    if ws == 0.0 {
                        row[x * src.c + ch] = 0.0;
                        continue;
                    }
                    let mut s = 0.0f32;
                    for (k, wk) in K.iter().enumerate() {
                        if !use_k[k] {
                            continue;
                        }
                        let (sx, sy) = if horizontal {
                            (2 * x as isize + k as isize - 2, y as isize)
                        } else {
                            (x as isize, 2 * y as isize + k as isize - 2)
                        };
                        s += wk * src.at(sx, sy, ch);
                    }
                    row[x * src.c + ch] = s / ws;
                }
            }
            tick_row(tick);
        });
    (out, painted)
}

pub fn down(b: &Buf, covered: Option<&Buf>, tick: Option<&BlendTick>) -> Buf {
    let (tmp, painted) = reduce_axis(b, covered.map(|m| &m.data[..]), true, tick);
    reduce_axis(&tmp, Some(&painted), false, tick).0
}

pub fn up(b: &Buf, w: usize, h: usize, tick: Option<&BlendTick>) -> Buf {
    let mut out = Buf::new(w, h, b.c);
    out.data
        .par_chunks_mut(w * b.c)
        .enumerate()
        .for_each(|(y, row)| {
            let fy = (y as f32 + 0.5) / 2.0 - 0.5;
            let y0 = fy.floor();
            let ty = fy - y0;
            let y0 = y0 as isize;
            for x in 0..w {
                let fx = (x as f32 + 0.5) / 2.0 - 0.5;
                let x0 = fx.floor();
                let tx = fx - x0;
                let x0 = x0 as isize;
                for ch in 0..b.c {
                    let a = b.at(x0, y0, ch);
                    let bb = b.at(x0 + 1, y0, ch);
                    let c = b.at(x0, y0 + 1, ch);
                    let d = b.at(x0 + 1, y0 + 1, ch);
                    let top = a + (bb - a) * tx;
                    let bot = c + (d - c) * tx;
                    row[x * b.c + ch] = top + (bot - top) * ty;
                }
            }
            tick_row(tick);
        });
    out
}

pub fn push_pull(vals: &mut Buf, wgt: &[f32]) {
    if wgt.iter().all(|&w| w > 0.0) || !wgt.iter().any(|&w| w > 0.0) {
        return;
    }
    let (w, h, c) = (vals.w, vals.h, vals.c);
    let mut pm = Buf::new(w, h, c + 1);
    for (i, &wi) in wgt.iter().enumerate() {
        let a = wi.clamp(0.0, 1.0);
        for ch in 0..c {
            pm.data[i * (c + 1) + ch] = vals.data[i * c + ch] * a;
        }
        pm.data[i * (c + 1) + c] = a;
    }
    let (mut levels, mut l) = (Vec::new(), pm);
    while l.w > 1 || l.h > 1 {
        let d = down(&l, None, None);
        levels.push(std::mem::replace(&mut l, d));
    }
    let mut filled = {
        let mut f = Buf::new(l.w, l.h, c);
        for i in 0..l.w * l.h {
            let a = l.data[i * (c + 1) + c];
            for ch in 0..c {
                f.data[i * c + ch] = if a > 1e-12 {
                    l.data[i * (c + 1) + ch] / a
                } else {
                    0.0
                };
            }
        }
        f
    };
    for l in levels.iter().rev() {
        let coarse = up(&filled, l.w, l.h, None);
        let mut f = Buf::new(l.w, l.h, c);
        for i in 0..l.w * l.h {
            let a = l.data[i * (c + 1) + c].min(1.0);
            for ch in 0..c {
                let v = if a > 1e-12 {
                    l.data[i * (c + 1) + ch] / l.data[i * (c + 1) + c]
                } else {
                    0.0
                };
                f.data[i * c + ch] = v * a + coarse.data[i * c + ch] * (1.0 - a);
            }
        }
        filled = f;
    }
    for (i, &wi) in wgt.iter().enumerate() {
        if wi <= 0.0 {
            for ch in 0..c {
                vals.data[i * c + ch] = filled.data[i * c + ch];
            }
        }
    }
}

pub struct Blender {
    pub levels: usize,
    pub w: usize,
    pub h: usize,
    pub acc: Vec<Buf>,
    pub wsum: Vec<Buf>,
}

impl Blender {

    pub fn try_new(
        w: usize,
        h: usize,
        levels: usize,
        scratch: Option<&crate::panorama_utils::spill::SpillFile>,
    ) -> Result<Blender, String> {
        let mut acc = Vec::new();
        let mut wsum = Vec::new();
        for l in 0..=levels {
            acc.push(Buf::try_new(level_dim(w, l), level_dim(h, l), 3, scratch)?);
            wsum.push(Buf::try_new(level_dim(w, l), level_dim(h, l), 1, scratch)?);
        }
        Ok(Blender {
            levels,
            w,
            h,
            acc,
            wsum,
        })
    }
    pub fn spill_levels(
        &mut self,
        file: &crate::panorama_utils::spill::SpillFile,
        mut needed: u64,
    ) {
        for l in 0..=self.levels {
            if needed == 0 {
                break;
            }
            let size = ((self.acc[l].data.len() + self.wsum[l].data.len())
                * std::mem::size_of::<f32>()) as u64;
            if size >= needed {
                continue;
            }
            let _ = self.acc[l].data.to_disk(file);
            let _ = self.wsum[l].data.to_disk(file);
            needed = needed.saturating_sub(size);
        }
    }
    pub fn add(
        &mut self,
        x0: usize,
        y0: usize,
        vals: Buf,
        mask: Buf,
        covered: Buf,
        tick: Option<&BlendTick>,
    ) {
        let mut g = vals;
        let mut m = mask;
        let mut c = covered;
        for l in 0..=self.levels {
            let (ox, oy) = (x0 >> l, y0 >> l);
            let (gn, mn, cn) = if l < self.levels {
                (
                    Some(down(&g, Some(&c), tick)),
                    Some(down(&m, Some(&c), tick)),
                    Some(down(&c, Some(&c), tick)),
                )
            } else {
                (None, None, None)
            };
            let lap = match &gn {
                Some(gn) => {
                    let u = up(gn, g.w, g.h, tick);
                    let mut lap = g.clone();
                    for (a, b) in lap.data.iter_mut().zip(&u.data[..]) {
                        *a -= b;
                    }
                    lap
                }
                None => g.clone(),
            };
            let (acc, ws) = (&mut self.acc[l], &mut self.wsum[l]);
            let aw = acc.w;
            let tw = lap.w;
            acc.data
                .par_chunks_mut(aw * 3)
                .zip(ws.data.par_chunks_mut(aw))
                .enumerate()
                .for_each(|(y, (arow, wrow))| {
                    if y < oy || y >= oy + lap.h {
                        return;
                    }
                    let ty = y - oy;
                    for tx in 0..tw {
                        let x = ox + tx;
                        if x >= aw {
                            break;
                        }
                        let mk = m.data[ty * tw + tx];
                        if mk <= 0.0 {
                            continue;
                        }
                        for ch in 0..3 {
                            arow[x * 3 + ch] += lap.data[(ty * tw + tx) * 3 + ch] * mk;
                        }
                        wrow[x] += mk;
                    }
                    tick_row(tick);
                });
            if let Some(tick) = tick {
                tick.flush();
            }
            if let (Some(gn), Some(mn), Some(cn)) = (gn, mn, cn) {
                g = gn;
                m = mn;
                c = cn;
            }
        }
    }
    pub fn finish(self, tick: Option<&BlendTick>) -> Buf {
        let mut res: Option<Buf> = None;
        let mut acc = self.acc;
        for l in (0..=self.levels).rev() {
            let mut b = std::mem::replace(&mut acc[l], Buf::empty());
            let ws = &self.wsum[l];
            for y in 0..b.h {
                for x in 0..b.w {
                    let i = y * b.w + x;
                    let s = ws.data[i];
                    for ch in 0..3 {
                        b.data[i * 3 + ch] = if s > 1e-8 {
                            b.data[i * 3 + ch] / s
                        } else {
                            0.0
                        };
                    }
                }
                tick_row(tick);
            }
            if let Some(r) = res {
                let u = up(&r, b.w, b.h, tick);
                for i in 0..b.w * b.h {
                    if ws.data[i] <= 1e-8 {
                        continue;
                    }
                    for ch in 0..3 {
                        b.data[i * 3 + ch] += u.data[i * 3 + ch];
                    }
                }
            }
            if let Some(tick) = tick {
                tick.flush();
            }
            res = Some(b);
        }
        res.unwrap_or_else(|| Buf::new(self.w, self.h, 3))
    }
}
