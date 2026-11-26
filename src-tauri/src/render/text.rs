use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ab_glyph_rasterizer::{Rasterizer, point};
use image::{Rgba, Rgba32FImage};
use memmap2::Mmap;
use rayon::prelude::*;
use ttf_parser::gpos::{PairAdjustment, PositioningSubtable};
use ttf_parser::{Face, GlyphId, OutlineBuilder, Tag};
use walkdir::WalkDir;

use crate::library::file_ops::read_file_mapped;

const FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "ttc", "otc"];
const FONT_DEPTH: usize = 6;
const WEIGHT_WORDS: [&str; 23] = [
    "thin",
    "hairline",
    "extralight",
    "ultralight",
    "light",
    "semilight",
    "demilight",
    "regular",
    "normal",
    "book",
    "medium",
    "semibold",
    "demibold",
    "demi",
    "bold",
    "extrabold",
    "ultrabold",
    "black",
    "heavy",
    "extrablack",
    "ultrablack",
    "italic",
    "oblique",
];
const WIDTH_WORDS: [&str; 14] = [
    "condensed",
    "semicondensed",
    "extracondensed",
    "ultracondensed",
    "cond",
    "compressed",
    "narrow",
    "expanded",
    "semiexpanded",
    "extraexpanded",
    "ultraexpanded",
    "extended",
    "ext",
    "wide",
];
const STYLE_PREFIXES: [&str; 3] = ["extra", "ultra", "semi"];
const SYSTEM_FONT: &str = "system-ui";
#[cfg(target_os = "windows")]
const DEFAULT_FAMILIES: &[&str] = &["Segoe UI", "Arial"];
#[cfg(target_os = "macos")]
const DEFAULT_FAMILIES: &[&str] = &["Helvetica Neue", "Helvetica", "Arial"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const DEFAULT_FAMILIES: &[&str] = &[
    "Noto Sans",
    "DejaVu Sans",
    "Liberation Sans",
    "Cantarell",
    "Ubuntu",
];
const WEIGHT_AXIS: Tag = Tag::from_bytes(b"wght");
const KERN_FEATURE: Tag = Tag::from_bytes(b"kern");
const KERN_SCRIPTS: [Tag; 2] = [Tag::from_bytes(b"DFLT"), Tag::from_bytes(b"latn")];
const RASTER_PAD: u32 = 1;

struct FontFace {
    path: PathBuf,
    index: u32,
    weight: u16,
    italic: bool,
    variation: Vec<(Tag, f32)>,
}

#[derive(Default)]
struct FontIndex {
    families: Vec<String>,
    faces: Vec<FontFace>,
    by_name: HashMap<String, Vec<(usize, bool)>>,
    uncovered: Mutex<HashSet<char>>,
}

struct ScannedFace {
    variants: Vec<FontFace>,
    names: Vec<(String, usize, bool)>,
}

static FONT_INDEX: OnceLock<FontIndex> = OnceLock::new();

fn font_index() -> &'static FontIndex {
    FONT_INDEX.get_or_init(scan_fonts)
}

fn font_dirs() -> Vec<PathBuf> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let home = env("HOME");
    if cfg!(target_os = "windows") {
        vec![
            env("WINDIR").map(|dir| dir.join("Fonts")),
            env("LOCALAPPDATA").map(|dir| dir.join("Microsoft").join("Windows").join("Fonts")),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            Some(PathBuf::from("/System/Library/Fonts")),
            Some(PathBuf::from("/Library/Fonts")),
            home.map(|dir| dir.join("Library").join("Fonts")),
        ]
    } else {
        vec![
            Some(PathBuf::from("/usr/share/fonts")),
            Some(PathBuf::from("/usr/local/share/fonts")),
            env("XDG_DATA_HOME")
                .or_else(|| home.as_ref().map(|dir| dir.join(".local").join("share")))
                .map(|dir| dir.join("fonts")),
            home.map(|dir| dir.join(".fonts")),
        ]
    }
    .into_iter()
    .flatten()
    .collect()
}

fn localized_name(face: &Face, id: u16) -> Option<String> {
    let names: Vec<_> = face
        .names()
        .into_iter()
        .filter(|name| name.name_id == id)
        .filter_map(|name| Some((name.language(), name.to_string()?)))
        .collect();
    names
        .iter()
        .find(|(language, _)| *language == ttf_parser::Language::English_UnitedStates)
        .or(names.first())
        .map(|(_, name)| name.clone())
}

fn named_instances(face: &Face) -> Vec<(u16, Vec<f32>)> {
    let Some(table) = face.raw_face().table(Tag::from_bytes(b"fvar")) else {
        return Vec::new();
    };
    let read = |offset: usize| {
        table
            .get(offset..offset + 2)
            .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]) as usize)
    };
    let fixed = |offset: usize| {
        table.get(offset..offset + 4).map(|bytes| {
            i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 65536.0
        })
    };
    let (Some(axes), Some(axis_count), Some(axis_size), Some(count), Some(size)) =
        (read(4), read(8), read(10), read(12), read(14))
    else {
        return Vec::new();
    };
    let first = axes + axis_count * axis_size;
    (0..count)
        .filter_map(|index| {
            let record = first + index * size;
            let coords = (0..axis_count)
                .map(|axis| fixed(record + 4 + axis * 4))
                .collect::<Option<Vec<f32>>>()
                .unwrap_or_default();
            read(record).map(|id| (id as u16, coords))
        })
        .collect()
}

fn strip_styles(name: &str, widths: bool) -> Option<String> {
    let words: Vec<String> = name
        .split_whitespace()
        .map(str::to_ascii_lowercase)
        .collect();
    let is_style =
        |word: &str| WEIGHT_WORDS.contains(&word) || (widths && WIDTH_WORDS.contains(&word));
    let kept: Vec<&str> = name
        .split_whitespace()
        .enumerate()
        .filter(|(index, _)| {
            let word = words[*index].as_str();
            !is_style(word)
                && !(STYLE_PREFIXES.contains(&word)
                    && words.get(index + 1).is_some_and(|next| is_style(next)))
        })
        .map(|(_, word)| word)
        .collect();
    (!kept.is_empty()).then(|| kept.join(" "))
}

fn scan_face(path: &Path, index: u32, face: &Face) -> Option<ScannedFace> {
    let typographic = localized_name(face, ttf_parser::name_id::TYPOGRAPHIC_FAMILY);
    let legacy = localized_name(face, ttf_parser::name_id::FAMILY);
    let base = typographic.clone().or_else(|| legacy.clone())?;
    let weight = face.weight().to_number();
    let italic = face.style() != ttf_parser::Style::Normal;
    let axes: Vec<Tag> = face
        .variation_axes()
        .into_iter()
        .map(|axis| axis.tag)
        .collect();
    let mut variants = vec![FontFace {
        path: path.to_path_buf(),
        index,
        weight,
        italic,
        variation: Vec::new(),
    }];
    let mut names: Vec<(String, usize)> = typographic
        .into_iter()
        .chain(legacy)
        .map(|name| (name, 0))
        .collect();
    for (id, coords) in named_instances(face) {
        let Some(style) = localized_name(face, id) else {
            continue;
        };
        let variation: Vec<(Tag, f32)> = axes.iter().copied().zip(coords).collect();
        let lower = style.to_ascii_lowercase();
        variants.push(FontFace {
            path: path.to_path_buf(),
            index,
            weight: variation
                .iter()
                .find(|(tag, _)| *tag == WEIGHT_AXIS)
                .map_or(weight, |(_, value)| value.round().clamp(1.0, 1000.0) as u16),
            italic: italic || lower.contains("italic") || lower.contains("oblique"),
            variation,
        });
        let family = match strip_styles(&style, false) {
            Some(kept) => format!("{} {}", base, kept),
            None => base.clone(),
        };
        names.push((family, variants.len() - 1));
    }
    let plain: Vec<(String, usize, bool)> = names
        .iter()
        .filter_map(|(name, variant)| strip_styles(name, true).map(|kept| (kept, *variant, false)))
        .collect();
    Some(ScannedFace {
        variants,
        names: names
            .into_iter()
            .map(|(name, variant)| (name, variant, true))
            .chain(plain)
            .collect(),
    })
}

fn scan_file(path: &Path) -> Vec<ScannedFace> {
    let Ok(data) = read_file_mapped(path) else {
        return Vec::new();
    };
    (0..ttf_parser::fonts_in_collection(&data).unwrap_or(1))
        .filter_map(|index| {
            Face::parse(&data, index)
                .ok()
                .and_then(|face| scan_face(path, index, &face))
        })
        .collect()
}

fn scan_fonts() -> FontIndex {
    let paths: Vec<PathBuf> = font_dirs()
        .into_iter()
        .flat_map(|dir| {
            WalkDir::new(dir)
                .max_depth(FONT_DEPTH)
                .into_iter()
                .flatten()
        })
        .map(walkdir::DirEntry::into_path)
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    FONT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                })
        })
        .collect();
    let scanned: Vec<Vec<ScannedFace>> = paths.par_iter().map(|path| scan_file(path)).collect();
    let mut index = FontIndex::default();
    let mut families = BTreeMap::new();
    for face in scanned.into_iter().flatten() {
        let first = index.faces.len();
        index.faces.extend(face.variants);
        for (name, variant, direct) in face.names {
            let name = name.trim().to_string();
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            let key = name.to_lowercase();
            index
                .by_name
                .entry(key.clone())
                .or_default()
                .push((first + variant, direct));
            families.entry(key).or_insert(name);
        }
    }
    index.families = families.into_values().collect();
    index
}

fn family_faces(index: &FontIndex, family: Option<&str>) -> Vec<(usize, bool)> {
    let lookup = |name: &str| index.by_name.get(&name.trim().to_lowercase());
    let faces = family
        .filter(|family| *family != SYSTEM_FONT)
        .and_then(lookup)
        .or_else(|| DEFAULT_FAMILIES.iter().find_map(|family| lookup(family)))
        .cloned()
        .unwrap_or_else(|| (0..index.faces.len()).map(|face| (face, true)).collect());
    let upright: Vec<(usize, bool)> = faces
        .iter()
        .copied()
        .filter(|(face, _)| !index.faces[*face].italic)
        .collect();
    if upright.is_empty() { faces } else { upright }
}

fn pick_face<'a>(index: &'a FontIndex, family: Option<&str>, weight: u16) -> Option<&'a FontFace> {
    family_faces(index, family)
        .into_iter()
        .min_by_key(|&(face, direct)| {
            let face_weight = index.faces[face].weight;
            (
                face_weight.abs_diff(weight),
                (face_weight > weight) != (weight >= 500),
                !direct,
            )
        })
        .map(|(face, _)| &index.faces[face])
}

fn family_weights(family: Option<&str>) -> Vec<u16> {
    let index = font_index();
    let mut weights: Vec<u16> = family_faces(index, family)
        .into_iter()
        .map(|(face, _)| (index.faces[face].weight.saturating_add(50) / 100 * 100).clamp(100, 900))
        .collect();
    weights.sort_unstable();
    weights.dedup();
    weights
}

struct LoadedFont {
    data: Mmap,
    index: u32,
    variation: Vec<(Tag, f32)>,
}

impl LoadedFont {
    fn open(face: &FontFace) -> Option<Self> {
        let font = Self {
            data: read_file_mapped(&face.path).ok()?,
            index: face.index,
            variation: face.variation.clone(),
        };
        font.face().is_some().then_some(font)
    }

    fn face(&self) -> Option<Face<'_>> {
        let mut face = Face::parse(&self.data, self.index).ok()?;
        for (tag, value) in &self.variation {
            face.set_variation(*tag, *value);
        }
        Some(face)
    }

    fn glyph(&self, character: char) -> Option<GlyphId> {
        self.face()?
            .glyph_index(character)
            .filter(|glyph| glyph.0 != 0)
    }
}

fn fallback_font(
    index: &FontIndex,
    weight: u16,
    character: char,
    fonts: &mut Vec<LoadedFont>,
) -> Option<(usize, GlyphId)> {
    if index.uncovered.lock().unwrap().contains(&character) {
        return None;
    }
    let mut candidates: Vec<&FontFace> = index.faces.iter().filter(|face| !face.italic).collect();
    candidates.sort_by_key(|face| face.weight.abs_diff(weight));
    let mut tried = HashSet::new();
    for face in pick_face(index, None, weight).into_iter().chain(candidates) {
        if !tried.insert((face.path.as_path(), face.index)) {
            continue;
        }
        if let Some(font) = LoadedFont::open(face)
            && let Some(glyph) = font.glyph(character)
        {
            fonts.push(font);
            return Some((fonts.len() - 1, glyph));
        }
    }
    index.uncovered.lock().unwrap().insert(character);
    None
}

fn is_invisible(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'..='\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFF8}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E0FFF}'
    )
}

fn kern_lookups(face: &Face) -> Vec<u16> {
    let Some(gpos) = face.tables().gpos else {
        return Vec::new();
    };
    let Some(language) = KERN_SCRIPTS
        .iter()
        .find_map(|tag| gpos.scripts.find(*tag))
        .or_else(|| gpos.scripts.get(0))
        .and_then(|script| script.default_language)
    else {
        return Vec::new();
    };
    let lookups: BTreeSet<u16> = language
        .feature_indices
        .into_iter()
        .filter_map(|feature| gpos.features.get(feature))
        .filter(|feature| feature.tag == KERN_FEATURE)
        .flat_map(|feature| feature.lookup_indices)
        .collect();
    lookups.into_iter().collect()
}

fn pair_adjustment(pair: &PairAdjustment, left: GlyphId, right: GlyphId) -> Option<i16> {
    let first = pair.coverage().get(left)?;
    let (value, _) = match pair {
        PairAdjustment::Format1 { sets, .. } => sets.get(first)?.get(right)?,
        PairAdjustment::Format2 {
            classes, matrix, ..
        } => matrix.get((classes.0.get(left), classes.1.get(right)))?,
    };
    Some(value.x_advance)
}

fn kerning(face: &Face, lookups: &[u16], left: GlyphId, right: GlyphId) -> f32 {
    if let Some(gpos) = face.tables().gpos.filter(|_| !lookups.is_empty()) {
        return lookups
            .iter()
            .filter_map(|index| gpos.lookups.get(*index))
            .filter_map(|lookup| {
                lookup
                    .subtables
                    .into_iter::<PositioningSubtable>()
                    .find_map(|subtable| match subtable {
                        PositioningSubtable::Pair(pair) => pair_adjustment(&pair, left, right),
                        _ => None,
                    })
            })
            .map(f32::from)
            .sum();
    }
    face.tables().kern.map_or(0.0, |kern| {
        kern.subtables
            .into_iter()
            .filter(|table| table.horizontal && !table.variable && !table.has_cross_stream)
            .filter_map(|table| table.glyphs_kerning(left, right))
            .map(f32::from)
            .sum()
    })
}

type Pt = (f32, f32);

enum Segment {
    Line(Pt, Pt),
    Quad(Pt, Pt, Pt),
    Cubic(Pt, Pt, Pt, Pt),
}

struct Outliner<'a> {
    outline: &'a mut Vec<Segment>,
    bounds: &'a mut [f32; 4],
    scale: f32,
    offset: f32,
    start: Pt,
    last: Pt,
}

impl Outliner<'_> {
    fn map(&mut self, x: f32, y: f32) -> Pt {
        let point = (self.offset + x * self.scale, y * self.scale);
        let [min_x, min_y, max_x, max_y] = self.bounds;
        *min_x = min_x.min(point.0);
        *min_y = min_y.min(point.1);
        *max_x = max_x.max(point.0);
        *max_y = max_y.max(point.1);
        point
    }
}

impl OutlineBuilder for Outliner<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.start = self.map(x, y);
        self.last = self.start;
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let to = self.map(x, y);
        self.outline.push(Segment::Line(self.last, to));
        self.last = to;
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let control = self.map(x1, y1);
        let to = self.map(x, y);
        self.outline.push(Segment::Quad(self.last, control, to));
        self.last = to;
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let first = self.map(x1, y1);
        let second = self.map(x2, y2);
        let to = self.map(x, y);
        self.outline
            .push(Segment::Cubic(self.last, first, second, to));
        self.last = to;
    }

    fn close(&mut self) {
        if self.last != self.start {
            self.outline.push(Segment::Line(self.last, self.start));
        }
        self.last = self.start;
    }
}

pub struct TextBlock {
    pub width: u32,
    pub height: u32,
    left: f32,
    top: f32,
    outline: Vec<Segment>,
}

impl TextBlock {
    pub fn layout(text: &str, family: Option<&str>, weight: u16) -> Result<Self, String> {
        let index = font_index();
        let primary = pick_face(index, family, weight)
            .and_then(LoadedFont::open)
            .ok_or_else(|| "No usable font found".to_string())?;
        let mut fonts = vec![primary];
        let mut glyphs = Vec::new();
        for character in text
            .chars()
            .filter(|&character| !character.is_control() && !is_invisible(character))
        {
            let found = fonts
                .iter()
                .enumerate()
                .find_map(|(slot, font)| font.glyph(character).map(|glyph| (slot, glyph)))
                .or_else(|| fallback_font(index, weight, character, &mut fonts));
            glyphs.push(found.unwrap_or((0, GlyphId(0))));
        }

        let faces = fonts
            .iter()
            .map(LoadedFont::face)
            .collect::<Option<Vec<Face>>>()
            .ok_or_else(|| "Font could not be read".to_string())?;
        let units = faces[0].units_per_em() as f32;
        let metrics: Vec<(Vec<u16>, f32)> = faces
            .iter()
            .map(|face| {
                (
                    kern_lookups(face),
                    units / face.units_per_em().max(1) as f32,
                )
            })
            .collect();

        let mut outline = Vec::new();
        let mut bounds = [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        let mut pen = 0.0;
        let mut previous: Option<(usize, GlyphId)> = None;
        for (slot, glyph) in glyphs {
            let (face, (lookups, ratio)) = (&faces[slot], &metrics[slot]);
            if let Some((last_slot, last_glyph)) = previous
                && last_slot == slot
            {
                pen += kerning(face, lookups, last_glyph, glyph) * ratio;
            }
            face.outline_glyph(
                glyph,
                &mut Outliner {
                    outline: &mut outline,
                    bounds: &mut bounds,
                    scale: *ratio,
                    offset: pen,
                    start: (0.0, 0.0),
                    last: (0.0, 0.0),
                },
            );
            pen += face.glyph_hor_advance(glyph).map_or(0.0, f32::from) * ratio;
            previous = Some((slot, glyph));
        }

        let [min_x, min_y, max_x, max_y] = bounds;
        if outline.is_empty() || min_x >= max_x || min_y >= max_y {
            return Ok(Self {
                width: 0,
                height: 0,
                left: 0.0,
                top: 0.0,
                outline,
            });
        }
        let (left, top) = (min_x.floor(), max_y.ceil());
        Ok(Self {
            width: (max_x.ceil() - left) as u32,
            height: (top - min_y.floor()) as u32,
            left,
            top,
            outline,
        })
    }

    pub fn fit(&self, max_size: u32) -> (u32, u32) {
        let scale = max_size as f32 / self.width.max(self.height).max(1) as f32;
        (
            ((self.width as f32 * scale).round() as u32).max(1),
            ((self.height as f32 * scale).round() as u32).max(1),
        )
    }

    pub fn render(&self, width: u32, height: u32, color: [u8; 3]) -> Rgba32FImage {
        let [red, green, blue] = color.map(|channel| channel as f32 / 255.0);
        let mut image = Rgba32FImage::from_pixel(width, height, Rgba([red, green, blue, 0.0]));
        if self.width == 0 || self.height == 0 || width == 0 || height == 0 {
            return image;
        }
        let scale = width as f32 / self.width as f32;
        let pad = RASTER_PAD as f32;
        let shift = (height as f32 - self.height as f32 * scale) / 2.0 + pad;
        let at = |(x, y): Pt| {
            point(
                (x - self.left) * scale + pad,
                (self.top - y) * scale + shift,
            )
        };
        let mut raster = Rasterizer::new(
            (width + 2 * RASTER_PAD) as usize,
            (height + 2 * RASTER_PAD) as usize,
        );
        for segment in &self.outline {
            match *segment {
                Segment::Line(from, to) => raster.draw_line(at(from), at(to)),
                Segment::Quad(from, control, to) => raster.draw_quad(at(from), at(control), at(to)),
                Segment::Cubic(from, first, second, to) => {
                    raster.draw_cubic(at(from), at(first), at(second), at(to))
                }
            }
        }
        raster.for_each_pixel_2d(|x, y, coverage| {
            if let (Some(x), Some(y)) = (x.checked_sub(RASTER_PAD), y.checked_sub(RASTER_PAD))
                && x < width
                && y < height
            {
                image.get_pixel_mut(x, y)[3] = coverage.min(1.0);
            }
        });
        image
    }
}

#[tauri::command]
pub async fn system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| font_index().families.clone())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn font_weights(family: Option<String>) -> Result<Vec<u16>, String> {
    tauri::async_runtime::spawn_blocking(move || family_weights(family.as_deref()))
        .await
        .map_err(|e| e.to_string())
}
