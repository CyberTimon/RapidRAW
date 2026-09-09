use anyhow::{Result, ensure};
use rusqlite::{Connection, params};

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersonShortcut {
    pub shortcut: String,
    pub person_id: String,
}

pub fn list(db: &Connection, scope: &str) -> Result<Vec<PersonShortcut>> {
    valid_scope(scope)?;
    Ok(db
        .prepare("SELECT shortcut,person_id FROM people_shortcuts WHERE scope=? ORDER BY shortcut")?
        .query_map([scope], |row| {
            Ok(PersonShortcut {
                shortcut: row.get(0)?,
                person_id: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn set(db: &mut Connection, scope: &str, person: &str, shortcut: Option<&str>) -> Result<()> {
    valid_scope(scope)?;
    uuid::Uuid::parse_str(person)?;
    let tx = db.transaction()?;
    ensure!(
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM people WHERE id=?)",
            [person],
            |row| row.get::<_, bool>(0),
        )?,
        "Person not found"
    );
    tx.execute(
        "DELETE FROM people_shortcuts WHERE scope=? AND person_id=?",
        params![scope, person],
    )?;
    if let Some(shortcut) = shortcut {
        let shortcut = shortcut.trim().to_ascii_lowercase();
        ensure!(
            shortcut.len() == 1 && shortcut.bytes().all(|byte| byte.is_ascii_alphanumeric()),
            "Use one letter or number"
        );
        tx.execute(
            "DELETE FROM people_shortcuts WHERE scope=? AND shortcut=?",
            params![scope, shortcut],
        )?;
        tx.execute(
            "INSERT INTO people_shortcuts(scope,shortcut,person_id) VALUES(?,?,?)",
            params![scope, shortcut, person],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn valid_scope(scope: &str) -> Result<()> {
    ensure!(
        !scope.trim().is_empty() && scope.chars().count() <= 4096,
        "Invalid shortcut scope"
    );
    Ok(())
}
