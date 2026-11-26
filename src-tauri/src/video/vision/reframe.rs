use super::lp::{Program, Rows};

const REFERENCE_FPS: f64 = 30.0;
const FOLLOW: f64 = 0.02;
const CENTER: f64 = 0.005;
const BAND: f64 = 2.0;
const SMOOTHNESS: [f64; 3] = [1.0, 10.0, 100.0];
const DIFFERENCES: [&[f64]; 3] = [&[-1.0, 1.0], &[1.0, -2.0, 1.0], &[-1.0, 3.0, -3.0, 1.0]];
const MIN_ROOM: f64 = 1e-3;
const FLOOR: f64 = 0.15;
const BINS_PER_WINDOW: f64 = 48.0;
const SCAN_STEPS: f64 = 96.0;
const SHIFT_ROUNDS: usize = 4;
const SWITCH_GAIN: f64 = 1.4;
const MIN_MASS_SHARE: f64 = 0.002;
const CLEAR: f64 = 0.15;
const SURE: f64 = 0.5;
const EDGE_SHARE: f64 = 0.05;
const MARGIN: f64 = 0.04;
const MIN_BAND: f64 = 0.12;
const LOOSE: f64 = 0.5;
const HEAD_ROOM: f64 = 0.1;
const HEAD_SHARE: f64 = 0.4;
const BODY_WEIGHT: f64 = 0.3;
const EYE_LINE: f64 = 0.45;
const SMOOTH_SECONDS: f64 = 0.15;
const HOLD_SECONDS: f64 = 1.0;

pub struct Framing {
    pub content: [f64; 6],
    pub canvas: [f64; 2],
    pub fps: f64,
}

pub struct FrameView<'a> {
    pub saliency: &'a [u8],
    pub place: [f64; 6],
    pub room: [f64; 4],
    pub cut: bool,
}

type Mass = ([f64; 2], f64);

#[derive(Clone, Copy)]
struct Sighting {
    aim: f64,
    low: f64,
    high: f64,
    weight: f64,
}

struct Span {
    cover: (f64, f64),
    band: Option<(f64, f64, f64)>,
    aim: f64,
    weight: f64,
}

struct Profile {
    origin: f64,
    bin: f64,
    below: Vec<f64>,
}

impl Profile {
    fn new(points: impl Iterator<Item = (f64, f64)>, origin: f64, end: f64, bin: f64) -> Self {
        let count = ((end - origin) / bin).ceil().max(1.0) as usize;
        let mut bins = vec![0.0; count];
        for (position, mass) in points {
            let at = ((position - origin) / bin - 0.5).clamp(0.0, (count - 1) as f64);
            let index = at.floor() as usize;
            let fraction = at - index as f64;
            bins[index] += mass * (1.0 - fraction);
            if index + 1 < count {
                bins[index + 1] += mass * fraction;
            }
        }
        let mut below = Vec::with_capacity(count + 1);
        below.push(0.0);
        for mass in bins {
            below.push(below.last().copied().unwrap_or(0.0) + mass);
        }
        Self { origin, bin, below }
    }

    fn total(&self) -> f64 {
        self.below.last().copied().unwrap_or(0.0)
    }

    fn up_to(&self, position: f64) -> f64 {
        let at = ((position - self.origin) / self.bin).clamp(0.0, (self.below.len() - 1) as f64);
        let index = (at.floor() as usize).min(self.below.len() - 2);
        let fraction = at - index as f64;
        self.below[index] + (self.below[index + 1] - self.below[index]) * fraction
    }

    fn mass(&self, (from, to): (f64, f64)) -> f64 {
        self.up_to(to) - self.up_to(from)
    }

    fn quantile(&self, (from, to): (f64, f64), share: f64) -> f64 {
        let base = self.up_to(from);
        let wanted = base + share * (self.up_to(to) - base);
        let index = self
            .below
            .partition_point(|&value| value < wanted)
            .clamp(1, self.below.len() - 1);
        let (lower, upper) = (self.below[index - 1], self.below[index]);
        let fraction = if upper > lower {
            (wanted - lower) / (upper - lower)
        } else {
            0.0
        };
        (self.origin + (index as f64 - 1.0 + fraction) * self.bin).clamp(from, to)
    }
}

fn quantiles<const N: usize>(values: &mut [(f64, f64)], shares: [f64; N]) -> Option<[f64; N]> {
    values.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = values.iter().map(|&(_, weight)| weight).sum();
    let mut found = [0.0; N];
    let mut next = 0;
    let mut seen = 0.0;
    for &(value, weight) in values.iter() {
        seen += weight;
        while next < N && seen >= shares[next] * total {
            found[next] = value;
            next += 1;
        }
    }
    (total > 0.0 && next == N).then_some(found)
}

fn head_middle(masses: &[Mass], (from, to): (f64, f64)) -> Option<f64> {
    let inside: Vec<Mass> = masses
        .iter()
        .copied()
        .filter(|(position, _)| (from..=to).contains(&position[0]))
        .collect();
    let mut heights: Vec<(f64, f64)> = inside
        .iter()
        .map(|&(position, mass)| (position[1], mass))
        .collect();
    let [top, bottom] = quantiles(&mut heights, [EDGE_SHARE, 1.0 - EDGE_SHARE])?;
    let line = top + HEAD_SHARE * (bottom - top);
    let mut weighted: Vec<(f64, f64)> = inside
        .iter()
        .map(|&(position, mass)| {
            (
                position[0],
                if position[1] > line {
                    mass * BODY_WEIGHT
                } else {
                    mass
                },
            )
        })
        .collect();
    quantiles(&mut weighted, [0.5]).map(|[middle]| middle)
}

fn window(shift: f64, length: f64) -> (f64, f64) {
    (-shift, length - shift)
}

fn widened(low: f64, high: f64, width: f64) -> (f64, f64) {
    let middle = 0.5 * (low + high);
    let half = (0.5 * (high - low)).max(0.5 * width);
    (middle - half, middle + half)
}

struct Spotter {
    axis: usize,
    length: f64,
    previous: Option<f64>,
}

impl Spotter {
    fn sight(&mut self, masses: &[Mass], room: (f64, f64), cells: usize) -> Option<Sighting> {
        let (lo, hi) = room;
        let (axis, length) = (self.axis, self.length);
        let profile = Profile::new(
            masses
                .iter()
                .map(|&(position, mass)| (position[axis], mass)),
            -hi,
            length - lo,
            length / BINS_PER_WINDOW,
        );
        let total = profile.total();
        if total < MIN_MASS_SHARE * cells as f64 {
            self.previous = None;
            return None;
        }
        let steps = ((hi - lo) / length * SCAN_STEPS).ceil().max(1.0) as usize;
        let best = (0..=steps)
            .map(|step| lo + (hi - lo) * step as f64 / steps as f64)
            .max_by(|a, b| {
                profile
                    .mass(window(*a, length))
                    .total_cmp(&profile.mass(window(*b, length)))
            })
            .unwrap_or(0.0);
        let mut shift = self.previous.unwrap_or(best);
        if profile.mass(window(best, length)) > SWITCH_GAIN * profile.mass(window(shift, length)) {
            shift = best;
        }
        for _ in 0..SHIFT_ROUNDS {
            if profile.mass(window(shift, length)) <= 0.0 {
                shift = best;
            }
            let middle = profile.quantile(window(shift, length), 0.5);
            shift = (0.5 * length - middle).clamp(lo, hi);
        }
        self.previous = Some(shift);
        let seen = window(shift, length);
        let uniform = (length / (length + hi - lo)).min(1.0);
        let share = profile.mass(seen) / total;
        let clarity = if uniform < 1.0 {
            (share - uniform) / (1.0 - uniform)
        } else {
            0.0
        };
        let weight = ((clarity - CLEAR) / (SURE - CLEAR)).clamp(0.0, 1.0);
        if weight <= 0.0 {
            return None;
        }
        let first = profile.quantile(seen, EDGE_SHARE);
        let last = profile.quantile(seen, 1.0 - EDGE_SHARE);
        let fits = last - first <= length * (1.0 - 2.0 * MARGIN);
        let aim = match (axis, fits) {
            (1, true) => EYE_LINE * length - 0.5 * (first + last),
            (1, false) => HEAD_ROOM * length - first,
            _ => {
                let middle =
                    head_middle(masses, seen).unwrap_or_else(|| profile.quantile(seen, 0.5));
                0.5 * length - middle
            }
        };
        let (low, high) = if fits {
            (MARGIN * length - first, length * (1.0 - MARGIN) - last)
        } else {
            (aim, aim)
        };
        let (low, high) = widened(low, high, MIN_BAND * length);
        let loose = (1.0 - weight) * LOOSE * length;
        Some(Sighting {
            aim,
            low: low - loose,
            high: high + loose,
            weight,
        })
    }
}

fn settle(sightings: &mut [Option<Sighting>], fps: f64) {
    let radius = (SMOOTH_SECONDS * fps).round() as usize;
    let raw = sightings.to_vec();
    for (index, sighting) in sightings.iter_mut().enumerate() {
        if sighting.is_none() {
            continue;
        }
        let near: Vec<Sighting> = raw
            [index.saturating_sub(radius)..(index + radius + 1).min(raw.len())]
            .iter()
            .flatten()
            .copied()
            .collect();
        let count = near.len() as f64;
        let mean = |value: fn(&Sighting) -> f64| near.iter().map(value).sum::<f64>() / count;
        *sighting = Some(Sighting {
            aim: mean(|s| s.aim),
            low: mean(|s| s.low),
            high: mean(|s| s.high),
            weight: mean(|s| s.weight),
        });
    }
    let hold = (HOLD_SECONDS * fps).round() as usize;
    let mut index = 0;
    while index < sightings.len() {
        if sightings[index].is_some() {
            index += 1;
            continue;
        }
        let end = (index..sightings.len())
            .find(|&at| sightings[at].is_some())
            .unwrap_or(sightings.len());
        let before = index.checked_sub(1).and_then(|at| sightings[at]);
        let after = sightings.get(end).copied().flatten();
        if end - index <= hold {
            for (offset, sighting) in sightings[index..end].iter_mut().enumerate() {
                *sighting = match (before, after) {
                    (Some(a), Some(b)) => {
                        let t = (offset + 1) as f64 / (end + 1 - index) as f64;
                        let mix = |x: f64, y: f64| x + (y - x) * t;
                        Some(Sighting {
                            aim: mix(a.aim, b.aim),
                            low: mix(a.low, b.low),
                            high: mix(a.high, b.high),
                            weight: a.weight.min(b.weight),
                        })
                    }
                    (one, other) => one.or(other),
                };
            }
        }
        index = end;
    }
}

fn camera_path(spans: &[Span], length: f64, fps: f64) -> Vec<f64> {
    let unit = length.max(1.0);
    let covers: Vec<(f64, f64)> = spans
        .iter()
        .map(|span| widened(span.cover.0 / unit, span.cover.1 / unit, MIN_ROOM))
        .collect();
    if spans.len() < 2 {
        return spans
            .iter()
            .map(|span| span.aim.clamp(span.cover.0, span.cover.1))
            .collect();
    }
    let rate = fps.max(1.0) / REFERENCE_FPS;
    let mut terms = Rows::new();
    let mut weights = Vec::new();
    let mut limits = Rows::new();
    let mut start = Vec::with_capacity(2 * spans.len());
    for (index, (span, &(low, high))) in spans.iter().zip(&covers).enumerate() {
        let (shift, slack) = (2 * index, 2 * index + 1);
        if span.weight > 0.0 {
            terms.push(&mut [(shift, 1.0)], -span.aim / unit);
            weights.push(span.weight / rate);
        }
        let (band_low, band_high, band_weight) = span
            .band
            .map_or((low, high, MIN_ROOM), |(from, to, weight)| {
                (from / unit, to / unit, weight)
            });
        terms.push(&mut [(slack, 1.0)], 0.0);
        weights.push(BAND * band_weight / rate);
        limits.push(&mut [(shift, 1.0)], -high);
        limits.push(&mut [(shift, -1.0)], low);
        limits.push(&mut [(shift, -1.0), (slack, -1.0)], band_low);
        limits.push(&mut [(shift, 1.0), (slack, -1.0)], -band_high);
        limits.push(&mut [(slack, -1.0)], 0.0);
        let middle = 0.5 * (low + high);
        start.push(middle);
        start.push((band_low - middle).max(middle - band_high).max(0.0) + MIN_ROOM);
    }
    for (order, taps) in DIFFERENCES.iter().enumerate() {
        for at in 0..spans.len().saturating_sub(order + 1) {
            let mut entries: Vec<(usize, f64)> = taps
                .iter()
                .enumerate()
                .map(|(step, &tap)| (2 * (at + step), tap))
                .collect();
            terms.push(&mut entries, 0.0);
            weights.push(SMOOTHNESS[order] * rate.powi(order as i32));
        }
    }
    Program {
        terms,
        weights,
        limits,
    }
    .solve(start)
    .as_chunks::<2>()
    .0
    .iter()
    .zip(&covers)
    .map(|(&[shift, _], &(low, high))| shift.clamp(low, high) * unit)
    .collect()
}

fn shot_path(
    framing: &Framing,
    size: (u32, u32),
    cells: &[(f64, f64)],
    shot: &[FrameView],
    axis: usize,
) -> Vec<f64> {
    let length = framing.canvas[axis];
    let rooms: Vec<(f64, f64)> = shot
        .iter()
        .map(|frame| {
            let (low, high) = (frame.room[2 * axis], frame.room[2 * axis + 1]);
            (low.min(high), low.max(high))
        })
        .collect();
    if rooms
        .iter()
        .all(|&(low, high)| high - low < MIN_ROOM * length)
    {
        return rooms
            .iter()
            .map(|&(low, high)| 0.0f64.clamp(low, high))
            .collect();
    }
    let width = size.0 as usize;
    let mut spotter = Spotter {
        axis,
        length,
        previous: None,
    };
    let mut masses: Vec<Mass> = Vec::with_capacity(cells.len());
    let mut sightings: Vec<Option<Sighting>> = shot
        .iter()
        .zip(&rooms)
        .map(|(frame, &room)| {
            let [a, b, c, d, e, f] = frame.place;
            masses.clear();
            masses.extend(cells.iter().filter_map(|&(u, v)| {
                let x = ((u * size.0 as f64) as usize).min(width - 1);
                let y = ((v * size.1 as f64) as usize).min(size.1 as usize - 1);
                let level = frame.saliency.get(y * width + x).copied().unwrap_or(0) as f64 / 255.0;
                let mass = (level - FLOOR) / (1.0 - FLOOR);
                (mass > 0.0).then_some(([a * u + b * v + c, d * u + e * v + f], mass))
            }));
            spotter.sight(&masses, room, cells.len())
        })
        .collect();
    settle(&mut sightings, framing.fps);
    let spans: Vec<Span> = sightings
        .iter()
        .zip(&rooms)
        .map(|(sighting, &cover)| match sighting {
            Some(sighting) => Span {
                cover,
                band: Some((sighting.low, sighting.high, sighting.weight)),
                aim: sighting.aim.clamp(cover.0, cover.1),
                weight: FOLLOW * sighting.weight,
            },
            None => Span {
                cover,
                band: None,
                aim: 0.0f64.clamp(cover.0, cover.1),
                weight: CENTER,
            },
        })
        .collect();
    camera_path(&spans, length, framing.fps)
}

pub fn reframe(framing: &Framing, size: (u32, u32), frames: &[FrameView]) -> Vec<[f64; 2]> {
    let [a, b, c, d, e, f] = framing.content;
    let cells: Vec<(f64, f64)> = (0..size.1)
        .flat_map(|y| {
            (0..size.0).map(move |x| {
                (
                    (x as f64 + 0.5) / size.0 as f64,
                    (y as f64 + 0.5) / size.1 as f64,
                )
            })
        })
        .filter(|&(u, v)| {
            let (cu, cv) = (a * u + b * v + c, d * u + e * v + f);
            (0.0..=1.0).contains(&cu) && (0.0..=1.0).contains(&cv)
        })
        .collect();
    let mut shifts = vec![[0.0; 2]; frames.len()];
    let mut start = 0;
    while start < frames.len() {
        let end = (start + 1..frames.len())
            .find(|&index| frames[index].cut)
            .unwrap_or(frames.len());
        let paths = [0, 1].map(|axis| shot_path(framing, size, &cells, &frames[start..end], axis));
        for (offset, shift) in shifts[start..end].iter_mut().enumerate() {
            *shift = [paths[0][offset], paths[1][offset]];
        }
        start = end;
    }
    shifts
}
