use super::{geometry::normalize, types::*};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub fn is_internal_path(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .starts_with(".rapidraw-auto-evaluation-")
    })
}

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let db = Connection::open(path)?;
    let version: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version <= 3,
        "People database was created by a newer RapidRAW version"
    );
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    if version != 3 {
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT,representative TEXT,created INTEGER DEFAULT(unixepoch()),updated INTEGER DEFAULT(unixepoch()));
        CREATE TABLE IF NOT EXISTS scanned_files(path TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,error TEXT,scanned INTEGER DEFAULT(unixepoch()));
        CREATE TABLE IF NOT EXISTS faces(id TEXT PRIMARY KEY,path TEXT NOT NULL REFERENCES scanned_files(path) ON DELETE CASCADE,person_id TEXT NOT NULL REFERENCES people(id),bounds TEXT NOT NULL,landmarks TEXT NOT NULL,confidence REAL NOT NULL,quality REAL NOT NULL,embedding TEXT NOT NULL,ignored INTEGER NOT NULL DEFAULT 0,model TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id,ignored,path);
        CREATE INDEX IF NOT EXISTS faces_path ON faces(path);
        CREATE TABLE IF NOT EXISTS centroids(person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,embedding TEXT NOT NULL);
        ")?;
        super::history::migrate(&db, version)?;
    }
    remove_internal_artifacts(&db)?;
    Ok(db)
}

fn remove_internal_artifacts(db: &Connection) -> Result<()> {
    let removed = db.execute(
        "DELETE FROM scanned_files WHERE instr(path,'/.rapidraw-auto-evaluation-')>0 OR instr(path,'\\.rapidraw-auto-evaluation-')>0",
        [],
    )?;
    if removed > 0 {
        cleanup(db)?;
        rebuild_all_centroids(db)?;
    }
    Ok(())
}

pub fn unchanged(db: &Connection, path: &str, fingerprint: &str) -> Result<bool> {
    Ok(db.query_row("SELECT 1 FROM scanned_files WHERE path=? AND fingerprint=? AND model=? AND status='complete'",params![path,fingerprint,MODEL_VERSION],|r|r.get::<_,i32>(0)).optional()?.is_some())
}

pub fn unchanged_for(
    db: &Connection,
    path: &str,
    fingerprint: &str,
    detailed: bool,
) -> Result<bool> {
    if !unchanged(db, path, fingerprint)? {
        return Ok(false);
    }
    let settings: String = db.query_row(
        "SELECT settings FROM scanned_files WHERE path=?",
        [path],
        |r| r.get(0),
    )?;
    Ok(settings == DETAILED_DETECTION_VERSION
        || (!detailed && settings == STANDARD_DETECTION_VERSION))
}

pub fn prune(db: &mut Connection) -> Result<()> {
    let paths = db
        .prepare("SELECT path FROM scanned_files")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let tx = db.transaction()?;
    for path in paths {
        if !Path::new(&path).exists() && Path::new(&path).parent().is_some_and(Path::is_dir) {
            tx.execute("DELETE FROM scanned_files WHERE path=?", [path])?;
        }
    }
    cleanup(&tx)?;
    rebuild_all_centroids(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn cleanup(db: &Connection) -> Result<()> {
    db.execute(
        "DELETE FROM people WHERE NOT EXISTS(SELECT 1 FROM faces WHERE person_id=people.id)",
        [],
    )?;
    db.execute("UPDATE people SET representative=(SELECT id FROM faces WHERE person_id=people.id AND ignored=0 ORDER BY quality DESC,id LIMIT 1) WHERE representative IS NULL OR NOT EXISTS(SELECT 1 FROM faces WHERE id=people.representative AND person_id=people.id AND ignored=0)",[])?;
    Ok(())
}

#[cfg(test)]
pub fn replace(
    db: &mut Connection,
    path: &str,
    fingerprint: &str,
    detections: &[Detection],
) -> Result<()> {
    replace_scanned(
        db,
        path,
        fingerprint,
        detections,
        STANDARD_DETECTION_VERSION,
    )
}

pub fn replace_scanned(
    db: &mut Connection,
    path: &str,
    fingerprint: &str,
    detections: &[Detection],
    settings: &str,
) -> Result<()> {
    let tx = db.transaction()?;
    // Preserve explicit corrections and identity assignments for overlapping detections on rescan.
    let old = query_faces(&tx, None, Some(path), None)?;
    tx.execute("INSERT INTO scanned_files(path,fingerprint,model,status,settings) VALUES(?,?,?,'complete',?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,model=excluded.model,settings=excluded.settings,status='complete',error=NULL,scanned=unixepoch()",params![path,fingerprint,MODEL_VERSION,settings])?;
    let provenance = tx
        .prepare("SELECT id,provenance FROM faces WHERE path=?")?
        .query_map([path], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?;
    tx.execute("DELETE FROM faces WHERE path=?", [path])?;
    rebuild_centroids(&tx, &old.iter().map(|f| f.person_id.clone()).collect())?;
    let profiles = super::matching::profiles(&tx)?;
    let mut used = std::collections::HashSet::new();
    let mut assigned = std::collections::HashSet::new();
    for detection in detections {
        ensure!(detection.embedding.len() == 128, "Invalid embedding size");
        let mut embedding = detection.embedding.clone();
        normalize(&mut embedding)?;
        let previous = old
            .iter()
            .filter(|f| !used.contains(&f.id))
            .filter(|f| super::geometry::iou(&f.bounds, &detection.bounds) > 0.7)
            .max_by(|a, b| {
                super::geometry::iou(&a.bounds, &detection.bounds)
                    .total_cmp(&super::geometry::iou(&b.bounds, &detection.bounds))
            });
        let person = previous
            .map(|f| f.person_id.clone())
            .or_else(|| super::matching::assign(&profiles, &embedding, path, &assigned))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        tx.execute("INSERT OR IGNORE INTO people(id) VALUES(?)", [&person])?;
        assigned.insert(person.clone());
        let id = previous
            .map(|f| {
                used.insert(f.id.clone());
                f.id.clone()
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let quality = detection.confidence * detection.bounds[2] * detection.bounds[3];
        tx.execute("INSERT INTO faces(id,path,person_id,bounds,landmarks,confidence,quality,embedding,ignored,model,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![id,path,person,serde_json::to_string(&detection.bounds)?,serde_json::to_string(&detection.landmarks)?,detection.confidence,quality,serde_json::to_string(&embedding)?,previous.is_some_and(|f|f.ignored),MODEL_VERSION,previous.and_then(|f|provenance.get(&f.id)).map(String::as_str).unwrap_or("auto")])?;
    }
    rebuild_centroids(&tx, &assigned)?;
    cleanup(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn rebuild_centroids(db: &Connection, ids: &std::collections::HashSet<String>) -> Result<()> {
    for id in ids {
        let mut sum = vec![0.0; 128];
        let mut count = 0;
        let mut stmt =
            db.prepare("SELECT embedding FROM faces WHERE person_id=? AND ignored=0 AND model=?")?;
        for row in stmt.query_map(params![id, MODEL_VERSION], |r| r.get::<_, String>(0))? {
            let embedding: Vec<f32> = serde_json::from_str(&row?)?;
            ensure!(embedding.len() == 128, "Invalid stored embedding");
            for (s, v) in sum.iter_mut().zip(embedding) {
                *s += v;
            }
            count += 1;
        }
        if count == 0 {
            db.execute("DELETE FROM centroids WHERE person_id=?", [id])?;
        } else {
            normalize(&mut sum)?;
            db.execute("INSERT INTO centroids(person_id,embedding) VALUES(?,?) ON CONFLICT(person_id) DO UPDATE SET embedding=excluded.embedding",params![id,serde_json::to_string(&sum)?])?;
        }
    }
    Ok(())
}

pub fn rebuild_all_centroids(db: &Connection) -> Result<()> {
    let ids = db
        .prepare("SELECT id FROM people")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
    rebuild_centroids(db, &ids)
}

pub fn summaries(db: &Connection) -> Result<Vec<PersonSummary>> {
    Ok(db.prepare("SELECT p.id,p.name,p.representative,COUNT(DISTINCT f.path) FROM people p JOIN faces f ON f.person_id=p.id AND f.ignored=0 GROUP BY p.id ORDER BY p.name IS NULL,p.name,p.id")?.query_map([],|r|Ok(PersonSummary{id:r.get(0)?,name:r.get(1)?,representative_face:r.get(2)?,photo_count:r.get(3)?}))?.collect::<rusqlite::Result<_>>()?)
}

pub fn faces(db: &Connection, person: Option<&str>) -> Result<Vec<FaceRecord>> {
    query_faces(db, person, None, None)
}
pub fn face(db: &Connection, id: &str) -> Result<FaceRecord> {
    query_faces(db, None, None, Some(id))?
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("Face not found"))
}
pub fn query_faces(
    db: &Connection,
    person: Option<&str>,
    path: Option<&str>,
    id: Option<&str>,
) -> Result<Vec<FaceRecord>> {
    let mut stmt=db.prepare("SELECT id,path,person_id,bounds,landmarks,confidence,quality,ignored FROM faces WHERE (?1 IS NULL OR person_id=?1) AND (?2 IS NULL OR path=?2) AND (?3 IS NULL OR id=?3) ORDER BY quality DESC,id")?;
    let rows = stmt.query_map(params![person, path, id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, f32>(5)?,
            r.get::<_, f32>(6)?,
            r.get::<_, bool>(7)?,
        ))
    })?;
    rows.map(|r| {
        let (id, path, person_id, bounds, landmarks, confidence, quality, ignored) = r?;
        Ok(FaceRecord {
            id,
            path,
            person_id,
            bounds: serde_json::from_str(&bounds)?,
            landmarks: serde_json::from_str(&landmarks)?,
            confidence,
            quality,
            ignored,
        })
    })
    .collect()
}

pub fn paths(db: &Connection, person: &str) -> Result<Vec<String>> {
    Ok(db
        .prepare("SELECT DISTINCT path FROM faces WHERE person_id=? AND ignored=0 ORDER BY path")?
        .query_map([person], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}
