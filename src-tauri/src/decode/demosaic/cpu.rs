use std::sync::LazyLock;

use glam::{Vec3, Vec4, Vec4Swizzles};
use rawler::imgop::Rect;
use rayon::prelude::*;

use super::{Mosaic, Pattern};

const TILE: usize = 256;

const EPS: f32 = 1e-5;
const EPSSQ: f32 = 1e-10;
const CARDINAL_FLAT: f32 = EPS + 1e-4;
const CARDINAL_EDGE: f32 = EPS + 1e-3;
const DEBIAS: [f32; 7] = [1.0, 6.0, 15.0, 20.0, 15.0, 6.0, 1.0];
const DEBIAS_NORM: f32 = 1.0 / 64.0;
const DEBIAS_LIMIT: f32 = 0.04;
const RB_EPS: f32 = 1e-5;
const RB_SHOT: f32 = 1e-4;
const RB_SIGMA: f32 = 1.5;
const RB_TINY: f32 = 1e-20;
const RB_RADIUS: usize = 4;
const RB_AREA: f32 = 81.0;

const STATE: usize = 0;
const STATS: usize = 2;
const COEF: usize = 6;
const CRIT: usize = 9;
const EDGES: usize = STATS;
const SMOOTH: usize = COEF;
const TENTATIVE: usize = STATE;
const REFINED: usize = 1;

const DIAGONALS: [[isize; 2]; 4] = [[1, 0], [0, 1], [1, 1], [-1, 1]];

static GAUSS: LazyLock<([f32; 11], f32)> = LazyLock::new(|| {
    let kernel = std::array::from_fn(|s| (-0.5 * sq((s as f32 - 5.0) / RB_SIGMA)).exp());
    (kernel, kernel.iter().sum())
});

type Stage = (fn(&mut Tile, [usize; 2]), [usize; 2]);
type Output = (fn(&Tile, usize) -> [f32; 3], [usize; 2]);

const BAYER: (&[Stage], Output) = (
    &[
        (Tile::rcd_vh, [4, 4]),
        (Tile::rcd_green, [4, 4]),
        (Tile::rcd_debias_h, [3, 0]),
        (Tile::rcd_debias_v, [0, 3]),
        (Tile::rb_prepare, [2, 2]),
        (Tile::rb_stats, [RB_RADIUS, 0]),
        (Tile::rb_coef, [0, RB_RADIUS]),
        (Tile::rb_average, [RB_RADIUS, 0]),
        (Tile::rb_tentative, [0, RB_RADIUS]),
        (Tile::rb_residual, [1, 1]),
        (Tile::rb_edges, [1, 1]),
        (Tile::rb_smooth, [5, 0]),
    ],
    (Tile::rb_out, [0, 5]),
);

const MARKESTEIJN: (&[Stage], Output) = (
    &[
        (Tile::xt_minmax, [2, 2]),
        (Tile::xt_green, [3, 3]),
        (|tile, reach| tile.xt_solitary(reach, 0), [2, 2]),
        (|tile, reach| tile.xt_redblue(reach, 0), [3, 3]),
        (|tile, reach| tile.xt_greens(reach, 0), [2, 2]),
        (|tile, reach| tile.xt_recalc(reach, 0), [2, 2]),
        (|tile, reach| tile.xt_commit(reach, 0), [0, 0]),
        (|tile, reach| tile.xt_solitary(reach, 4), [2, 2]),
        (|tile, reach| tile.xt_redblue(reach, 4), [3, 3]),
        (|tile, reach| tile.xt_greens(reach, 4), [2, 2]),
        (|tile, reach| tile.xt_recalc(reach, 4), [2, 2]),
        (|tile, reach| tile.xt_commit(reach, 4), [0, 0]),
        (|tile, reach| tile.xt_solitary(reach, 4), [2, 2]),
        (|tile, reach| tile.xt_redblue(reach, 4), [3, 3]),
        (|tile, reach| tile.xt_greens(reach, 4), [2, 2]),
        (Tile::xt_drv, [1, 1]),
        (Tile::xt_homo, [1, 1]),
    ],
    (Tile::xt_out, [2, 2]),
);

fn cardinal_eps(grad: f32) -> f32 {
    let u = ((grad - CARDINAL_FLAT) / (CARDINAL_EDGE - CARDINAL_FLAT)).clamp(0.0, 1.0);
    EPS * (1.0 - u * u * (3.0 - 2.0 * u))
}

fn sq(v: f32) -> f32 {
    v * v
}

fn shifted(i: usize, offset: isize) -> usize {
    i.wrapping_add_signed(offset)
}

fn region(w: usize, h: usize, [rx, ry]: [usize; 2]) -> impl Iterator<Item = (usize, usize, usize)> {
    (ry..h - ry).flat_map(move |y| (rx..w - rx).map(move |x| (x, y, y * w + x)))
}

fn fold(v: isize, lo: usize, len: usize, period: isize) -> usize {
    let (lo, hi) = (lo as isize, (lo + len) as isize);
    let mut r = v;
    if v < lo {
        r = 2 * lo - v;
        r -= (r - v).rem_euclid(period);
        if r < lo {
            r += period;
        }
    } else if v >= hi {
        r = 2 * (hi - 1) - v;
        r += (v - r).rem_euclid(period);
        if r >= hi {
            r -= period;
        }
    }
    r.clamp(lo, hi - 1) as usize
}

fn window<const N: usize>(b1: &[Vec4], n: usize, plane: usize, i: usize, step: usize) -> [Vec4; N] {
    let mut sums = [Vec4::ZERO; N];
    for q in (i - RB_RADIUS * step..=i + RB_RADIUS * step).step_by(step) {
        for (k, sum) in sums.iter_mut().enumerate() {
            *sum += b1[(plane + k) * n + q];
        }
    }
    sums
}

fn color_coef(s0: Vec4, s1: Vec4) -> ([f32; 2], [f32; 3]) {
    let n = s0.x.max(1e-12);
    let mg = s0.y / n;
    let mx = s0.z / n;
    let a = (s1.y / n - mg * mx) / (s0.w / n - mg * mg + RB_EPS + RB_SHOT * mg);
    let b = mx - a * mg;
    let a2 = s1.z / (s1.w + RB_EPS + RB_SHOT * 20.0 * s0.y);
    let b2 = mx - a2 * mg;
    let e = (s1.x - 2.0 * a2 * s1.y - 2.0 * b2 * s0.z
        + a2 * a2 * s0.w
        + 2.0 * a2 * b2 * s0.y
        + b2 * b2 * s0.x)
        / n;
    let wt = 1.0 / e.max(1e-10);
    ([a, b], [wt * a2, wt * b2, wt])
}

fn yuv(c: Vec4) -> Vec3 {
    let y = 0.2627 * c.x + 0.6780 * c.y + 0.0593 * c.z;
    Vec3::new(y, (c.z - y) * 0.56433, (c.x - y) * 0.67815)
}

struct Tile {
    w: usize,
    h: usize,
    n: usize,
    phase: [usize; 2],
    solitary: [usize; 2],
    hex: [[[isize; 8]; 3]; 3],
    tint: Vec<u8>,
    cfa: Vec<f32>,
    b0: Vec<[f32; 2]>,
    b1: Vec<Vec4>,
    b2: Vec<f32>,
    words: Vec<u32>,
}

impl Tile {
    fn new(pattern: Pattern, texels: usize) -> Self {
        let [_, _, b1, b2, words] = pattern.texel_bytes().map(|bytes| bytes as usize);
        Self {
            w: 0,
            h: 0,
            n: 0,
            phase: [0; 2],
            solitary: [0; 2],
            hex: Default::default(),
            tint: vec![0; texels],
            cfa: vec![0.0; texels],
            b0: vec![[0.0; 2]; texels],
            b1: vec![Vec4::ZERO; texels * b1 / 16],
            b2: vec![0.0; texels * b2 / 4],
            words: vec![0; texels * words / 4],
        }
    }

    fn load(&mut self, mosaic: &Mosaic, origin: [isize; 2], w: usize, h: usize) {
        self.w = w;
        self.h = h;
        self.n = w * h;
        self.phase = origin.map(|o| o.rem_euclid(6) as usize);
        self.solitary = [
            (origin[0] - mosaic.solitary[1] as isize).rem_euclid(3) as usize,
            (origin[1] - mosaic.solitary[0] as isize).rem_euclid(3) as usize,
        ];
        self.hex = mosaic
            .hex
            .map(|row| row.map(|site| site.map(|[dx, dy]| dy as isize * w as isize + dx as isize)));

        let period = mosaic.pattern.period() as isize;
        let domain = mosaic.domain;
        let columns: Vec<usize> = (0..w)
            .map(|x| fold(origin[0] + x as isize, domain.p.x, domain.d.w, period))
            .collect();
        for y in 0..h {
            let ay = fold(origin[1] + y as isize, domain.p.y, domain.d.h, period);
            let line = &mosaic.data[ay * mosaic.stride..];
            let colors = &mosaic.colors[(self.phase[1] + y) % 6];
            for (x, &ax) in columns.iter().enumerate() {
                let color = colors[(self.phase[0] + x) % 6];
                let black = mosaic.black[(ay & 1) * 2 + (ax & 1)];
                self.tint[y * w + x] = color;
                self.cfa[y * w + x] =
                    (line[ax] as f32 - black).max(0.0) * mosaic.scale * mosaic.wb[color as usize];
            }
        }
    }

    fn rcd_vh(&mut self, reach: [usize; 2]) {
        let Self { w, h, cfa, b0, .. } = self;
        let w = *w;
        let hpf = |i: usize, s: usize| {
            sq(cfa[i - 3 * s] - cfa[i - s] - cfa[i + s] + cfa[i + 3 * s]
                - 3.0 * (cfa[i - 2 * s] + cfa[i + 2 * s])
                + 6.0 * cfa[i])
        };
        for (_, _, i) in region(w, *h, reach) {
            let v = EPSSQ.max(hpf(i - w, w) + hpf(i, w) + hpf(i + w, w));
            let hz = EPSSQ.max(hpf(i - 1, 1) + hpf(i, 1) + hpf(i + 1, 1));
            let lowpass = cfa[i]
                + 0.5 * (cfa[i - w] + cfa[i + w] + cfa[i - 1] + cfa[i + 1])
                + 0.25 * (cfa[i - w - 1] + cfa[i - w + 1] + cfa[i + w - 1] + cfa[i + w + 1]);
            b0[i] = [v / (v + hz), lowpass];
        }
    }

    fn rcd_green(&mut self, reach: [usize; 2]) {
        let Self {
            w,
            h,
            tint,
            cfa,
            b0,
            b2,
            ..
        } = self;
        let row = *w as isize;
        for (_, _, i) in region(*w, *h, reach) {
            let c0 = cfa[i];
            if tint[i] == 1 {
                b2[i] = c0;
                continue;
            }
            let mos = |o: isize| cfa[shifted(i, o)];
            let vh = |o: isize| b0[shifted(i, o)][0];
            let lowpass = |o: isize| b0[shifted(i, o)][1];
            let grad = |o: isize| {
                EPS + (mos(o) - mos(-o)).abs()
                    + (c0 - mos(2 * o)).abs()
                    + (mos(o) - mos(3 * o)).abs()
                    + (mos(2 * o) - mos(4 * o)).abs()
            };
            let (north, south, west, east) = (grad(-row), grad(row), grad(-1), grad(1));
            let l = lowpass(0);
            let num = l + l + cardinal_eps(north.max(south).max(west.max(east)));
            let est = |o: isize| mos(o) * num / (EPS + l + lowpass(2 * o));
            let v_est = (south * est(-row) + north * est(row)) / (north + south);
            let h_est = (west * est(1) + east * est(-1)) / (east + west);
            let center = vh(0);
            let around = 0.25 * (vh(-row - 1) + vh(-row + 1) + vh(row - 1) + vh(row + 1));
            let disc = if (0.5 - center).abs() < (0.5 - around).abs() {
                around
            } else {
                center
            }
            .clamp(0.0, 1.0);
            b2[i] = v_est * (1.0 - disc) + h_est * disc;
        }
    }

    fn rcd_debias_h(&mut self, reach: [usize; 2]) {
        let Self {
            w, h, tint, b0, b2, ..
        } = self;
        for (_, _, i) in region(*w, *h, reach) {
            let mut sums = [0.0f32; 2];
            for (k, weight) in DEBIAS.iter().enumerate() {
                let q = i + k - 3;
                let g = b2[q];
                sums[0] += weight * if tint[q] == 1 { -g } else { g };
                sums[1] += weight * g;
            }
            b0[i] = sums.map(|sum| sum * DEBIAS_NORM);
        }
    }

    fn rcd_debias_v(&mut self, reach: [usize; 2]) {
        let Self {
            w, h, tint, b0, b2, ..
        } = self;
        let w = *w;
        for (_, _, i) in region(w, *h, reach) {
            if tint[i] == 1 {
                continue;
            }
            let mut sums = [0.0f32; 2];
            for (k, weight) in DEBIAS.iter().enumerate() {
                let [modulated, level] = b0[i + k * w - 3 * w];
                sums[0] += weight * modulated;
                sums[1] += weight * level;
            }
            let limit = DEBIAS_LIMIT * sums[1] * DEBIAS_NORM;
            b2[i] -= (2.0 * sums[0] * DEBIAS_NORM).max(-limit).min(limit);
        }
    }

    fn rb_prepare(&mut self, reach: [usize; 2]) {
        let Self {
            w,
            h,
            n,
            tint,
            cfa,
            b1,
            b2,
            ..
        } = self;
        let (w, n) = (*w, *n);
        for (_, _, i) in region(w, *h, reach) {
            let mut state = [Vec4::ZERO; 2];
            if tint[i] != 1 {
                let laplacian = |plane: &[f32]| {
                    4.0 * plane[i]
                        - plane[i - 2]
                        - plane[i + 2]
                        - plane[i - 2 * w]
                        - plane[i + 2 * w]
                };
                let (g, x) = (b2[i], cfa[i]);
                let (lg, lx) = (laplacian(b2), laplacian(cfa));
                state = [
                    Vec4::new(1.0, g, x, g * g),
                    Vec4::new(x * x, g * x, lg * lx, lg * lg),
                ];
            }
            b1[STATE * n + i] = state[0];
            b1[(STATE + 1) * n + i] = state[1];
        }
    }

    fn rb_stats(&mut self, reach: [usize; 2]) {
        let Self {
            w, h, n, tint, b1, ..
        } = self;
        let n = *n;
        for (_, _, i) in region(*w, *h, reach) {
            let mut sums = [Vec4::ZERO; 4];
            for q in i - RB_RADIUS..=i + RB_RADIUS {
                let slot = if tint[q] == 0 { 0 } else { 2 };
                sums[slot] += b1[STATE * n + q];
                sums[slot + 1] += b1[(STATE + 1) * n + q];
            }
            for (k, sum) in sums.into_iter().enumerate() {
                b1[(STATS + k) * n + i] = sum;
            }
        }
    }

    fn rb_coef(&mut self, reach: [usize; 2]) {
        let Self { w, h, n, b1, .. } = self;
        let (w, n) = (*w, *n);
        for (_, _, i) in region(w, *h, reach) {
            let [m0, m1, m2, m3] = window(b1, n, STATS, i, w);
            let (r_ri, r_ml) = color_coef(m0 / RB_AREA, m1 / RB_AREA);
            let (b_ri, b_ml) = color_coef(m2 / RB_AREA, m3 / RB_AREA);
            b1[COEF * n + i] = Vec4::new(r_ri[0], r_ri[1], b_ri[0], b_ri[1]);
            b1[(COEF + 1) * n + i] = Vec4::new(r_ml[0], r_ml[1], r_ml[2], b_ml[0]);
            b1[(COEF + 2) * n + i] = Vec4::new(b_ml[1], b_ml[2], 0.0, 0.0);
        }
    }

    fn rb_average(&mut self, reach: [usize; 2]) {
        let Self { w, h, n, b1, .. } = self;
        let n = *n;
        for (_, _, i) in region(*w, *h, reach) {
            let sums: [Vec4; 3] = window(b1, n, COEF, i, 1);
            for (k, sum) in sums.into_iter().enumerate() {
                b1[(STATS + k) * n + i] = sum;
            }
        }
    }

    fn rb_tentative(&mut self, reach: [usize; 2]) {
        let Self {
            w, h, n, b1, b2, ..
        } = self;
        let (w, n) = (*w, *n);
        for (_, _, i) in region(w, *h, reach) {
            let [s0, s1, s2] = window(b1, n, STATS, i, w);
            let g = b2[i];
            b1[TENTATIVE * n + i] = Vec4::new(
                (s0.x * g + s0.y) / RB_AREA,
                (s1.x * g + s1.y) / s1.z,
                (s0.z * g + s0.w) / RB_AREA,
                (s1.w * g + s2.x) / s2.y,
            );
        }
    }

    fn rb_residual(&mut self, reach: [usize; 2]) {
        let Self {
            w,
            h,
            n,
            tint,
            cfa,
            b1,
            b2,
            ..
        } = self;
        let n = *n;
        let row = *w as isize;
        for (_, _, i) in region(*w, *h, reach) {
            let mut resid = Vec4::ZERO;
            let mut base = [0.0f32; 2];
            for dy in -1..=1isize {
                for dx in -1..=1isize {
                    let q = shifted(i, dy * row + dx);
                    let color = tint[q];
                    if color == 1 {
                        continue;
                    }
                    let k = match (dx == 0, dy == 0) {
                        (true, true) => 1.0,
                        (false, false) => 0.25,
                        _ => 0.5,
                    };
                    let c = cfa[q];
                    let t = b1[TENTATIVE * n + q];
                    if color == 0 {
                        resid += k * Vec4::new(c - t.x, c - t.y, 0.0, 0.0);
                        base[0] += k * (c - b2[q]);
                    } else {
                        resid += k * Vec4::new(0.0, 0.0, c - t.z, c - t.w);
                        base[1] += k * (c - b2[q]);
                    }
                }
            }
            let t = b1[TENTATIVE * n + i];
            let [red, blue] = base.map(|b| b2[i] + b);
            b1[REFINED * n + i] = t + resid;
            b1[CRIT * n + i] = t - Vec4::new(red, red, blue, blue);
        }
    }

    fn rb_edges(&mut self, reach: [usize; 2]) {
        let Self { w, h, n, b1, .. } = self;
        let (w, n) = (*w, *n);
        for (_, _, i) in region(w, *h, reach) {
            let c = CRIT * n + i;
            let d = b1[c];
            let gx = (b1[c + 1] - b1[c - 1]).abs();
            let gy = (b1[c + w] - b1[c - w]).abs();
            b1[EDGES * n + i] = d * d * (gx + gy) * 0.5;
        }
    }

    fn rb_smooth(&mut self, reach: [usize; 2]) {
        let Self { w, h, n, b1, .. } = self;
        let n = *n;
        let (kernel, total) = &*GAUSS;
        for (_, _, i) in region(*w, *h, reach) {
            let mut acc = Vec4::ZERO;
            for (s, k) in kernel.iter().enumerate() {
                acc += *k * b1[EDGES * n + i + s - 5];
            }
            b1[SMOOTH * n + i] = acc / *total;
        }
    }

    fn rb_out(&self, i: usize) -> [f32; 3] {
        let (kernel, total) = &*GAUSS;
        let mut acc = Vec4::ZERO;
        for (s, k) in kernel.iter().enumerate() {
            acc += *k * self.b1[SMOOTH * self.n + i + s * self.w - 5 * self.w];
        }
        let wt = 1.0 / (acc / *total + RB_TINY);
        let x = self.b1[REFINED * self.n + i] * wt;
        let mut r = (x.x + x.y) / (wt.x + wt.y);
        let mut b = (x.z + x.w) / (wt.z + wt.w);
        match self.tint[i] {
            0 => r = self.cfa[i],
            2 => b = self.cfa[i],
            _ => {}
        }
        [r, self.b2[i], b].map(|v| v.max(0.0))
    }

    fn xt_minmax(&mut self, reach: [usize; 2]) {
        let Self {
            w,
            h,
            phase,
            hex,
            tint,
            cfa,
            b0,
            ..
        } = self;
        for (x, y, i) in region(*w, *h, reach) {
            if tint[i] == 1 {
                continue;
            }
            let site = &hex[(phase[1] + y) % 3][(phase[0] + x) % 3];
            let mut range = [f32::MAX, 0.0f32];
            for offset in &site[..6] {
                let v = cfa[shifted(i, *offset)];
                range = [range[0].min(v), range[1].max(v)];
            }
            b0[i] = range;
        }
    }

    fn xt_green(&mut self, reach: [usize; 2]) {
        let Self {
            w,
            h,
            n,
            phase,
            solitary,
            hex,
            tint,
            cfa,
            b0,
            b1,
            ..
        } = self;
        let n = *n;
        for (x, y, i) in region(*w, *h, reach) {
            let f = tint[i] as usize;
            let v = cfa[i];
            let mut init = Vec4::ZERO;
            init[f] = v;
            for d in 0..4 {
                b1[d * n + i] = init;
            }
            if f == 1 {
                continue;
            }
            let pick = |o: isize| cfa[shifted(i, o)];
            let [h0, h1, h2, h3, h4, h5, ..] = hex[(phase[1] + y) % 3][(phase[0] + x) % 3];
            let est = [
                (174.0 * (pick(h1) + pick(h0)) - 46.0 * (pick(2 * h1) + pick(2 * h0))) / 256.0,
                (223.0 * pick(h3) + 33.0 * pick(h2) + 92.0 * (v - pick(-h2))) / 256.0,
                (164.0 * pick(h4)
                    + 92.0 * pick(-2 * h4)
                    + 33.0 * (2.0 * v - pick(3 * h4) - pick(-3 * h4)))
                    / 256.0,
                (164.0 * pick(h5)
                    + 92.0 * pick(-2 * h5)
                    + 33.0 * (2.0 * v - pick(3 * h5) - pick(-3 * h5)))
                    / 256.0,
            ];
            let [lo, hi] = b0[i];
            let swap = ((solitary[1] + y) % 3 == 0) as usize;
            for (k, value) in est.into_iter().enumerate() {
                b1[(k ^ swap) * n + i].y = value.max(lo).min(hi);
            }
        }
    }

    fn xt_solitary(&mut self, reach: [usize; 2], base: usize) {
        let Self {
            w,
            h,
            n,
            solitary,
            tint,
            b1,
            ..
        } = self;
        let (w, n) = (*w, *n);
        for (x, y, i) in region(w, *h, reach) {
            if (solitary[1] + y) % 3 != 0 || (solitary[0] + x) % 3 != 0 {
                continue;
            }
            for k in 0..4 {
                let s = (base + k) * n + i;
                let axis = |unit: usize| {
                    let g0 = b1[s].y;
                    let mut out = Vec3::ZERO;
                    for o in [unit, 2 * unit] {
                        let c = tint[i + o] as usize;
                        let (plus, minus) = (b1[s + o], b1[s - o]);
                        let g = 2.0 * g0 - plus.y - minus.y;
                        out[c >> 1] = (g + plus[c] + minus[c]) * 0.5;
                        out.z += sq(plus.y - minus.y - plus[c] + minus[c]) + sq(g);
                    }
                    out
                };
                let rb = match k {
                    0 => axis(1),
                    1 => axis(w),
                    _ => {
                        let (horizontal, vertical) = (axis(1), axis(w));
                        if horizontal.z < vertical.z {
                            horizontal
                        } else {
                            vertical
                        }
                    }
                };
                b1[s].x = rb.x;
                b1[s].z = rb.y;
            }
        }
    }

    fn xt_redblue(&mut self, reach: [usize; 2], base: usize) {
        let Self {
            w,
            h,
            n,
            solitary,
            tint,
            b1,
            ..
        } = self;
        let (w, n) = (*w, *n);
        for (_, y, i) in region(w, *h, reach) {
            let own = tint[i] as usize;
            if own == 1 {
                continue;
            }
            let f = 2 - own;
            let vertical = (solitary[1] + y) % 3 != 0;
            let (close, far) = if vertical { (w, 3) } else { (1, 3 * w) };
            for k in 0..4 {
                let s = (base + k) * n + i;
                let g0 = b1[s].y;
                let slope = |o: usize| (g0 - b1[s + o].y).abs() + (g0 - b1[s - o].y).abs();
                let use_close = k > 1
                    || (if vertical { k } else { k ^ 1 }) & 1 != 0
                    || slope(close) < 2.0 * slope(far);
                let o = if use_close { close } else { far };
                let (plus, minus) = (b1[s + o], b1[s - o]);
                b1[s][f] = (plus[f] + minus[f] + 2.0 * g0 - plus.y - minus.y) * 0.5;
            }
        }
    }

    fn xt_greens(&mut self, reach: [usize; 2], base: usize) {
        let Self {
            w,
            h,
            n,
            phase,
            solitary,
            hex,
            tint,
            b1,
            ..
        } = self;
        let n = *n;
        for (x, y, i) in region(*w, *h, reach) {
            if tint[i] != 1 || (solitary[1] + y) % 3 == 0 || (solitary[0] + x) % 3 == 0 {
                continue;
            }
            let site = &hex[(phase[1] + y) % 3][(phase[0] + x) % 3];
            for k in 0..4 {
                let s = (base + k) * n + i;
                let (a, b) = (site[2 * k], site[2 * k + 1]);
                let g0 = b1[s].y;
                let (ca, cb) = (b1[shifted(s, a)], b1[shifted(s, b)]);
                let (red, blue) = if a + b != 0 {
                    let g = 3.0 * g0 - 2.0 * ca.y - cb.y;
                    ((g + 2.0 * ca.x + cb.x) / 3.0, (g + 2.0 * ca.z + cb.z) / 3.0)
                } else {
                    let g = 2.0 * g0 - ca.y - cb.y;
                    ((g + ca.x + cb.x) * 0.5, (g + ca.z + cb.z) * 0.5)
                };
                b1[s].x = red;
                b1[s].z = blue;
            }
        }
    }

    fn xt_recalc(&mut self, reach: [usize; 2], src: usize) {
        let Self {
            w,
            h,
            n,
            phase,
            solitary,
            hex,
            tint,
            b0,
            b1,
            b2,
            ..
        } = self;
        let n = *n;
        for (x, y, i) in region(*w, *h, reach) {
            let own = tint[i] as usize;
            if own == 1 {
                continue;
            }
            for k in 0..4 {
                b2[k * n + i] = b1[(src + k) * n + i].y;
            }
            let site = &hex[(phase[1] + y) % 3][(phase[0] + x) % 3];
            let [lo, hi] = b0[i];
            let swap = ((solitary[1] + y) % 3 == 0) as usize;
            for (k, a) in site[3..6].iter().enumerate() {
                let t = (k + 1) ^ swap;
                let s = (src + t) * n + i;
                let (far, near, here) = (b1[shifted(s, -2 * a)], b1[shifted(s, *a)], b1[s]);
                let value = far.y + 2.0 * near.y - far[own] - 2.0 * near[own] + 3.0 * here[own];
                b2[t * n + i] = (value / 3.0).max(lo).min(hi);
            }
        }
    }

    fn xt_commit(&mut self, reach: [usize; 2], src: usize) {
        let Self {
            w,
            h,
            n,
            tint,
            b1,
            b2,
            ..
        } = self;
        let n = *n;
        for (_, _, i) in region(*w, *h, reach) {
            for k in 0..4 {
                let mut value = b1[(src + k) * n + i];
                if tint[i] != 1 {
                    value.y = b2[k * n + i];
                }
                b1[(4 + k) * n + i] = value;
            }
        }
    }

    fn xt_drv(&mut self, reach: [usize; 2]) {
        let Self {
            w, h, n, b1, b2, ..
        } = self;
        let n = *n;
        let row = *w as isize;
        for (_, _, i) in region(*w, *h, reach) {
            for d in 0..8 {
                let [dx, dy] = DIAGONALS[d & 3];
                let o = dy * row + dx;
                let s = d * n + i;
                let t = 2.0 * yuv(b1[s]) - yuv(b1[shifted(s, o)]) - yuv(b1[shifted(s, -o)]);
                b2[s] = t.dot(t);
            }
        }
    }

    fn xt_homo(&mut self, reach: [usize; 2]) {
        let Self {
            w, h, n, b2, words, ..
        } = self;
        let (w, n) = (*w, *n);
        for (_, _, i) in region(w, *h, reach) {
            let threshold = 8.0 * (0..8).map(|d| b2[d * n + i]).fold(f32::MAX, f32::min);
            let mut packed = 0u32;
            for d in 0..8 {
                let s = d * n + i;
                let mut count = 0u32;
                for q in [s - w, s, s + w] {
                    count += b2[q - 1..=q + 1]
                        .iter()
                        .filter(|&&v| v <= threshold)
                        .count() as u32;
                }
                packed |= count << (4 * d);
            }
            words[i] = packed;
        }
    }

    fn xt_out(&self, i: usize) -> [f32; 3] {
        let (mut even, mut odd) = (0u32, 0u32);
        for row in (i - 2 * self.w..=i + 2 * self.w).step_by(self.w) {
            for word in &self.words[row - 2..=row + 2] {
                even += word & 0x0f0f0f0f;
                odd += (word >> 4) & 0x0f0f0f0f;
            }
        }
        let mut votes: [u32; 8] = std::array::from_fn(|d| {
            ((if d & 1 == 1 { odd } else { even }) >> (8 * (d >> 1))) & 0xff
        });
        let mut top = votes.into_iter().max().unwrap_or(0);
        top -= top >> 3;
        for d in 0..4 {
            if votes[d] < votes[d + 4] {
                votes[d] = 0;
            } else if votes[d] > votes[d + 4] {
                votes[d + 4] = 0;
            }
        }
        let mut sum = Vec3::ZERO;
        let mut count = 0.0f32;
        for (d, vote) in votes.into_iter().enumerate() {
            if vote >= top {
                sum += self.b1[d * self.n + i].xyz();
                count += 1.0;
            }
        }
        (sum / count.max(1.0)).max(Vec3::ZERO).to_array()
    }
}

impl Mosaic<'_> {
    pub(super) fn demosaic(&self, crop: Rect) -> Vec<[f32; 3]> {
        let (stages, (output, last)) = match self.pattern {
            Pattern::Bayer => BAYER,
            Pattern::XTrans => MARKESTEIJN,
        };
        let margin = stages.iter().fold(last, |sum, (_, radius)| {
            [sum[0] + radius[0], sum[1] + radius[1]]
        });
        let width = crop.d.w;
        let mut out = vec![[0.0f32; 3]; width * crop.d.h];
        out.par_chunks_mut(TILE * width).enumerate().for_each_init(
            || {
                Tile::new(
                    self.pattern,
                    (TILE + 2 * margin[0]) * (TILE + 2 * margin[1]),
                )
            },
            |tile, (strip, rows)| {
                let height = rows.len() / width;
                let top = (crop.p.y + strip * TILE) as isize - margin[1] as isize;
                for left in (0..width).step_by(TILE) {
                    let cols = TILE.min(width - left);
                    let origin = [(crop.p.x + left) as isize - margin[0] as isize, top];
                    tile.load(self, origin, cols + 2 * margin[0], height + 2 * margin[1]);
                    let mut reach = [0; 2];
                    for (stage, radius) in stages {
                        reach = [reach[0] + radius[0], reach[1] + radius[1]];
                        stage(tile, reach);
                    }
                    for (y, row) in rows.chunks_exact_mut(width).enumerate() {
                        let start = (margin[1] + y) * tile.w + margin[0];
                        for (x, pixel) in row[left..left + cols].iter_mut().enumerate() {
                            *pixel = output(tile, start + x);
                        }
                    }
                }
            },
        );
        out
    }
}
