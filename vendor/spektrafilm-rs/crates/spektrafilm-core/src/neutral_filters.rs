/// Per-stock neutral print filter database loader.
///
/// Python parity: `spektrafilm/runtime/params_builder.py:apply_database_neutral_print_filters`.
/// The JSON file maps (print_stock, illuminant, film_stock) → (c, m, y) filter CC values.
/// Without this lookup, Rust used hardcoded (0, 65, 55) which produced ~5% per-channel drift
/// from Python on common film/paper/illuminant combinations.
use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

/// Nested map: print_stock → illuminant → film_stock → [c, m, y].
type FilterDb = HashMap<String, HashMap<String, HashMap<String, [f64; 3]>>>;

#[derive(Debug, Clone)]
pub struct NeutralFilters {
    db: FilterDb,
}

impl NeutralFilters {
    /// Load the JSON database from `<data_dir>/filters/neutral_print_filters.json`.
    /// Returns an empty database if the file is missing — matches Python's behavior.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("filters").join("neutral_print_filters.json");
        let db = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<RawDb>(&s).ok())
            .map(|raw| raw.0)
            .unwrap_or_default();
        Self { db }
    }

    /// Look up filter CC values for a (print_stock, illuminant, film_stock) combination.
    /// Returns `None` if the combination isn't in the database.
    pub fn lookup(
        &self,
        print_stock: &str,
        illuminant: &str,
        film_stock: &str,
    ) -> Option<[f64; 3]> {
        self.db
            .get(print_stock)?
            .get(illuminant)?
            .get(film_stock)
            .copied()
    }
}

#[derive(Deserialize)]
struct RawDb(FilterDb);
