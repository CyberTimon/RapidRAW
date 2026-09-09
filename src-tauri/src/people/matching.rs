use super::geometry::cosine;
use anyhow::Result;
use rusqlite::Connection;
use std::collections::{BTreeMap, HashSet};

pub const VERSION: &str = "representatives-v2";
pub const STRONG: f32 = 0.50;
pub const REVIEW: f32 = 0.36;
pub const MARGIN: f32 = 0.08;
const MAX_REFERENCES: usize = 8;

pub struct Profile {
    pub id: String,
    pub named: bool,
    pub manual: bool,
    pub legacy: bool,
    pub paths: HashSet<String>,
    pub references: Vec<Vec<f32>>,
}

pub fn profiles(db: &Connection) -> Result<Vec<Profile>> {
    let mut groups = BTreeMap::<String, Profile>::new();
    let mut stmt = db.prepare("SELECT f.person_id,p.name,f.path,f.embedding,f.provenance FROM faces f JOIN people p ON p.id=f.person_id WHERE f.ignored=0 AND f.model=? ORDER BY f.person_id,(f.provenance='manual') DESC,f.quality DESC,f.path,f.id")?;
    let rows = stmt.query_map([super::types::MODEL_VERSION], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (id, name, path, json, provenance) = row?;
        let profile = groups.entry(id.clone()).or_insert_with(|| Profile {
            id,
            named: name.is_some(),
            manual: false,
            legacy: false,
            paths: HashSet::new(),
            references: Vec::new(),
        });
        profile.manual |= provenance == "manual";
        profile.legacy |= provenance == "legacy";
        profile.paths.insert(path);
        let embedding: Vec<f32> = serde_json::from_str(&json)?;
        anyhow::ensure!(
            embedding.len() == 128 && embedding.iter().all(|v| v.is_finite()),
            "Invalid stored embedding"
        );
        // Retain diverse, quality-ordered examples instead of averaging away different poses.
        if profile.references.len() < MAX_REFERENCES
            && profile
                .references
                .iter()
                .all(|r| cosine(r, &embedding) < 0.95)
        {
            profile.references.push(embedding);
        }
    }
    let mut profiles: Vec<_> = groups.into_values().collect();
    profiles.sort_by(|a, b| {
        a.paths
            .iter()
            .min()
            .cmp(&b.paths.iter().min())
            .then(a.id.cmp(&b.id))
    });
    Ok(profiles)
}

pub fn assign(
    profiles: &[Profile],
    embedding: &[f32],
    path: &str,
    assigned: &HashSet<String>,
) -> Option<String> {
    let mut scores = profiles
        .iter()
        .filter(|p| !p.paths.contains(path) && !assigned.contains(&p.id))
        .filter_map(|p| {
            let scores = p
                .references
                .iter()
                .map(|r| cosine(r, embedding))
                .collect::<Vec<_>>();
            scores
                .iter()
                .all(|s| *s >= REVIEW)
                .then(|| (p, scores.iter().sum::<f32>() / scores.len().max(1) as f32))
        })
        .filter(|(_, s)| *s >= REVIEW)
        .collect::<Vec<_>>();
    scores.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.id.cmp(&b.0.id)));
    let (best, score) = scores.first()?;
    (*score >= STRONG && scores.get(1).is_none_or(|(_, next)| score - next >= MARGIN))
        .then(|| best.id.clone())
}

pub fn score(a: &Profile, b: &Profile) -> Option<f32> {
    if !a.paths.is_disjoint(&b.paths) {
        return None;
    }
    let mut min = 1.0_f32;
    let mut total = 0.0;
    for x in &a.references {
        for y in &b.references {
            let score = cosine(x, y);
            min = min.min(score);
            total += score;
        }
    }
    // Every retained pose must support the merge: no single-link bridge chains.
    (min >= REVIEW).then_some(total / (a.references.len() * b.references.len()).max(1) as f32)
}

pub fn rejections(db: &Connection) -> Result<HashSet<(String, String)>> {
    Ok(db.prepare("SELECT DISTINCT min(a.person_id,b.person_id),max(a.person_id,b.person_id) FROM rejected r JOIN faces a ON a.id=r.a JOIN faces b ON b.id=r.b")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
}

pub fn is_rejected(rejections: &HashSet<(String, String)>, a: &str, b: &str) -> bool {
    rejections.contains(&(a.min(b).into(), a.max(b).into()))
}
