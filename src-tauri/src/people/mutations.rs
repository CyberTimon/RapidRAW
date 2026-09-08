use super::database;
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Mutation {
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
    match mutation {
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
            for id in ids {
                tx.execute(
                    "UPDATE faces SET person_id=? WHERE person_id=?",
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
            for face in faces {
                ensure!(
                    tx.execute(
                        "UPDATE faces SET person_id=?,ignored=0 WHERE id=?",
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
    database::cleanup(&tx)?;
    database::rebuild_all_centroids(&tx)?;
    tx.commit()?;
    Ok(())
}
