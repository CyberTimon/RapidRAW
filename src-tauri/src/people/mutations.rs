use super::database;
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Mutation {
    Reject {
        a: String,
        b: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Merge {
        ids: Vec<String>,
        target: String,
    },
    Move {
        faces: Vec<String>,
        target: Option<String>,
    },
    Ignore {
        faces: Vec<String>,
        ignored: bool,
    },
    Representative {
        id: String,
        face: String,
    },
}

pub fn apply(db: &mut Connection, mutation: Mutation) -> Result<()> {
    let tx = db.transaction()?;
    super::history::record(&tx, "correction")?;
    match mutation {
        Mutation::Reject { a, b } => {
            ensure!(a != b, "Choose different people");
            reject_groups(&tx, &a, &b)?;
        }
        Mutation::Rename { id, name } => {
            let name = name.trim();
            ensure!(name.chars().count() <= 120, "Name is too long");
            ensure!(
                tx.execute(
                    "UPDATE people SET name=?,updated=unixepoch() WHERE id=?",
                    params![(!name.is_empty()).then_some(name), id]
                )? == 1,
                "Person not found"
            );
        }
        Mutation::Merge { ids, target } => {
            ensure!(
                ids.len() >= 2 && ids.contains(&target),
                "Select two people and a target"
            );
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM people WHERE id=?)",
                [&target],
                |r| r.get(0),
            )?;
            ensure!(exists, "Target not found");
            for id in &ids {
                ensure!(
                    tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM people WHERE id=?)",
                        [id],
                        |r| r.get::<_, bool>(0)
                    )?,
                    "Person not found"
                );
                tx.execute("DELETE FROM rejected WHERE (a IN (SELECT id FROM faces WHERE person_id=?1) AND b IN (SELECT id FROM faces WHERE person_id=?2)) OR (b IN (SELECT id FROM faces WHERE person_id=?1) AND a IN (SELECT id FROM faces WHERE person_id=?2))",params![target,id])?;
            }
            for id in ids {
                tx.execute(
                    "UPDATE faces SET person_id=?,provenance='manual' WHERE person_id=?",
                    params![target, id],
                )?;
            }
        }
        Mutation::Move { faces, target } => {
            ensure!(!faces.is_empty(), "No faces selected");
            let id = if let Some(id) = target {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM people WHERE id=?)",
                    [&id],
                    |r| r.get(0),
                )?;
                ensure!(exists, "Target not found");
                id
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute("INSERT INTO people(id) VALUES(?)", [&id])?;
                id
            };
            for face in &faces {
                // Negative examples survive identity merges because they reference face IDs.
                tx.execute("INSERT OR IGNORE INTO rejected SELECT min(?1,id),max(?1,id) FROM faces WHERE person_id=(SELECT person_id FROM faces WHERE id=?1) AND id!=?1", [face])?;
            }
            for face in &faces {
                tx.execute("DELETE FROM rejected WHERE (a=?1 AND b IN (SELECT id FROM faces WHERE person_id=?2)) OR (b=?1 AND a IN (SELECT id FROM faces WHERE person_id=?2))",params![face,id])?;
            }
            for a in &faces {
                for b in &faces {
                    tx.execute(
                        "DELETE FROM rejected WHERE a=min(?1,?2) AND b=max(?1,?2)",
                        params![a, b],
                    )?;
                }
            }
            for face in faces {
                ensure!(
                    tx.execute(
                        "UPDATE faces SET person_id=?,ignored=0,provenance='manual' WHERE id=?",
                        params![id, face]
                    )? == 1,
                    "Face not found"
                );
            }
        }
        Mutation::Ignore { faces, ignored } => {
            for face in faces {
                ensure!(
                    tx.execute(
                        "UPDATE faces SET ignored=? WHERE id=?",
                        params![ignored, face]
                    )? == 1,
                    "Face not found"
                );
            }
        }
        Mutation::Representative { id, face } => {
            ensure!(tx.execute("UPDATE people SET representative=?1 WHERE id=?2 AND EXISTS(SELECT 1 FROM faces WHERE id=?1 AND person_id=?2 AND ignored=0)",params![face,id])?==1,"Face does not belong to person");
        }
    }
    tx.execute("DELETE FROM suggestions", [])?;
    database::cleanup(&tx)?;
    database::rebuild_all_centroids(&tx)?;
    super::organize::refresh_suggestions(&tx)?;
    tx.commit()?;
    Ok(())
}

fn reject_groups(db: &Connection, a: &str, b: &str) -> Result<()> {
    ensure!(db.execute("INSERT OR IGNORE INTO rejected SELECT min(a.id,b.id),max(a.id,b.id) FROM faces a CROSS JOIN faces b WHERE a.person_id=? AND b.person_id=?",params![a,b])?>0, "People missing or match already rejected");
    Ok(())
}
