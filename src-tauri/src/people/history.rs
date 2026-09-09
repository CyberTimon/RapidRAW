use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub fn migrate(db: &Connection, version: u32) -> Result<()> {
    if version >= 3 {
        return Ok(());
    }
    db.execute_batch("BEGIN IMMEDIATE")?;
    let current = db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))?;
    if current >= 3 {
        db.execute_batch("COMMIT")?;
        return Ok(());
    }
    if current < 2 {
        db.execute_batch("
        ALTER TABLE faces ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE scanned_files ADD COLUMN settings TEXT NOT NULL DEFAULT 'standard-v1';
        CREATE TABLE rejected(a TEXT NOT NULL,b TEXT NOT NULL,PRIMARY KEY(a,b));
        CREATE TABLE suggestions(a TEXT NOT NULL,b TEXT NOT NULL,score REAL NOT NULL,version TEXT NOT NULL,PRIMARY KEY(a,b));
        CREATE TABLE people_history(id INTEGER PRIMARY KEY,label TEXT NOT NULL,snapshot TEXT NOT NULL);")?;
    }
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS people_shortcuts(
            scope TEXT NOT NULL,
            shortcut TEXT NOT NULL,
            person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            PRIMARY KEY(scope,shortcut),
            UNIQUE(scope,person_id)
        );
        PRAGMA user_version=3; COMMIT;",
    )?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    people: Vec<(String, Option<String>, Option<String>)>,
    faces: Vec<(String, String, bool, String)>,
    rejected: Vec<(String, String)>,
    #[serde(default)]
    shortcuts: Vec<(String, String, String)>,
}

pub fn record(db: &Connection, label: &str) -> Result<()> {
    let snapshot = Snapshot {
        people: db
            .prepare("SELECT id,name,representative FROM people ORDER BY id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?,
        faces: db
            .prepare("SELECT id,person_id,ignored,provenance FROM faces ORDER BY id")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?,
        rejected: db
            .prepare("SELECT a,b FROM rejected ORDER BY a,b")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?,
        shortcuts: db
            .prepare(
                "SELECT scope,shortcut,person_id FROM people_shortcuts ORDER BY scope,shortcut",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?,
    };
    db.execute(
        "INSERT INTO people_history(label,snapshot) VALUES(?,?)",
        params![label, serde_json::to_string(&snapshot)?],
    )?;
    db.execute("DELETE FROM people_history WHERE id NOT IN (SELECT id FROM people_history ORDER BY id DESC LIMIT 20)", [])?;
    Ok(())
}

pub fn undo(db: &mut Connection) -> Result<()> {
    let tx = db.transaction()?;
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT id,snapshot FROM people_history ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (id, json) = row.ok_or_else(|| anyhow::anyhow!("Nothing to undo"))?;
    let snapshot: Snapshot = serde_json::from_str(&json)?;
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM faces", [], |r| r.get(0))?;
    ensure!(
        count == snapshot.faces.len() as i64,
        "The scan changed; this operation can no longer be undone"
    );
    for (id, name, cover) in snapshot.people {
        tx.execute("INSERT INTO people(id,name,representative) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,representative=excluded.representative", params![id,name,cover])?;
    }
    for (id, person, ignored, provenance) in snapshot.faces {
        ensure!(
            tx.execute(
                "UPDATE faces SET person_id=?,ignored=?,provenance=? WHERE id=?",
                params![person, ignored, provenance, id]
            )? == 1,
            "Face changed since operation"
        );
    }
    tx.execute("DELETE FROM rejected", [])?;
    for (a, b) in snapshot.rejected {
        tx.execute("INSERT INTO rejected VALUES(?,?)", params![a, b])?;
    }
    tx.execute("DELETE FROM people_shortcuts", [])?;
    for (scope, shortcut, person) in snapshot.shortcuts {
        tx.execute(
            "INSERT INTO people_shortcuts(scope,shortcut,person_id) VALUES(?,?,?)",
            params![scope, shortcut, person],
        )?;
    }
    tx.execute("DELETE FROM suggestions", [])?;
    tx.execute("DELETE FROM people_history WHERE id=?", [id])?;
    super::database::cleanup(&tx)?;
    super::database::rebuild_all_centroids(&tx)?;
    super::organize::refresh_suggestions(&tx)?;
    tx.commit()?;
    Ok(())
}
