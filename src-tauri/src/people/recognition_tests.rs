use super::{
    database as db, history, matching,
    mutations::{Mutation, apply},
    organize, shortcuts,
    types::Detection,
};
use std::sync::atomic::AtomicBool;

fn detection(angle: f32) -> Detection {
    let mut embedding = vec![0.; 128];
    embedding[0] = angle.cos();
    embedding[1] = angle.sin();
    Detection {
        bounds: [0.1, 0.1, 0.2, 0.2],
        landmarks: [[0.2, 0.2]; 5],
        confidence: 0.99,
        embedding,
    }
}
fn split(db: &rusqlite::Connection) {
    let faces = super::database::faces(db, None).unwrap();
    for f in faces {
        db.execute("INSERT OR IGNORE INTO people(id) VALUES(?)", [&f.id])
            .unwrap();
        db.execute("UPDATE faces SET person_id=? WHERE id=?", [&f.id, &f.id])
            .unwrap();
    }
    super::database::cleanup(db).unwrap();
}
fn index() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("people.sqlite")).unwrap();
    (dir, conn)
}
#[test]
fn regroup_existing_faces_and_undo_without_changing_detections() {
    let (_dir, mut conn) = index();
    db::replace(&mut conn, "a", "1", &[detection(0.)]).unwrap();
    db::replace(&mut conn, "b", "1", &[detection(0.1)]).unwrap();
    split(&conn);
    conn.execute("UPDATE faces SET provenance='legacy'", [])
        .unwrap();
    organize::run(&mut conn, false, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 1);
    history::undo(&mut conn).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
    assert_eq!(db::faces(&conn, None).unwrap().len(), 2);
}
#[test]
fn same_photo_and_weak_bridge_never_merge() {
    let (_dir, mut conn) = index();
    let mut other = detection(0.01);
    other.bounds[0] = 0.6;
    db::replace(&mut conn, "group", "1", &[detection(0.), other]).unwrap();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
    assert!(organize::suggestions(&conn).unwrap().is_empty());
    let profile = |id: &str, angles: &[f32]| matching::Profile {
        id: id.into(),
        named: false,
        manual: false,
        legacy: false,
        paths: [id.into()].into(),
        references: angles.iter().map(|a| detection(*a).embedding).collect(),
    };
    assert!(matching::score(&profile("a", &[0., 0.9]), &profile("b", &[1.8])).is_none());
}
#[test]
fn ambiguity_stays_in_review_and_named_people_are_preserved() {
    let (_dir, mut conn) = index();
    for (path, angle) in [("a", 0.), ("b", 0.65), ("c", -0.65)] {
        db::replace(&mut conn, path, "1", &[detection(angle)]).unwrap();
    }
    split(&conn);
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 3);
    assert_eq!(organize::suggestions(&conn).unwrap().len(), 2);
    let ids = db::summaries(&conn)
        .unwrap()
        .iter()
        .map(|p| p.id.clone())
        .collect::<Vec<_>>();
    apply(
        &mut conn,
        Mutation::Rename {
            id: ids[0].clone(),
            name: "Alex".into(),
        },
    )
    .unwrap();
    apply(
        &mut conn,
        Mutation::Rename {
            id: ids[1].clone(),
            name: "Sam".into(),
        },
    )
    .unwrap();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        db::summaries(&conn)
            .unwrap()
            .iter()
            .filter(|p| p.name.is_some())
            .count(),
        2
    );
}
#[test]
fn rejected_match_survives_regroup_rescan_and_restart() {
    let (dir, mut conn) = index();
    for path in ["a", "b"] {
        db::replace(&mut conn, path, "1", &[detection(0.)]).unwrap();
    }
    split(&conn);
    let people = db::summaries(&conn).unwrap();
    apply(
        &mut conn,
        Mutation::Reject {
            a: people[0].id.clone(),
            b: people[1].id.clone(),
        },
    )
    .unwrap();
    db::replace(&mut conn, "a", "1", &[detection(0.)]).unwrap();
    drop(conn);
    let mut conn = db::open(&dir.path().join("people.sqlite")).unwrap();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
    assert!(organize::suggestions(&conn).unwrap().is_empty());
}
#[test]
fn moved_face_is_not_suggested_back_and_can_be_explicitly_merged() {
    let (_dir, mut conn) = index();
    for path in ["a", "b", "c"] {
        db::replace(&mut conn, path, "1", &[detection(0.)]).unwrap();
    }
    let faces = db::faces(&conn, None).unwrap();
    apply(
        &mut conn,
        Mutation::Move {
            faces: vec![faces[0].id.clone()],
            target: None,
        },
    )
    .unwrap();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
    assert!(organize::suggestions(&conn).unwrap().is_empty());
    let ids = db::summaries(&conn)
        .unwrap()
        .iter()
        .map(|p| p.id.clone())
        .collect::<Vec<_>>();
    apply(
        &mut conn,
        Mutation::Merge {
            target: ids[0].clone(),
            ids,
        },
    )
    .unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 1);
    assert!(matching::rejections(&conn).unwrap().is_empty());
    history::undo(&mut conn).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
}
#[test]
fn cancelled_organization_rolls_back_history_and_assignments() {
    let (_dir, mut conn) = index();
    db::replace(&mut conn, "a", "1", &[detection(0.)]).unwrap();
    organize::run(&mut conn, true, &AtomicBool::new(true)).unwrap();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM people_history", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn version_one_migration_preserves_identity_and_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT,representative TEXT,created INTEGER,updated INTEGER);
        CREATE TABLE scanned_files(path TEXT PRIMARY KEY,fingerprint TEXT,model TEXT,status TEXT,error TEXT,scanned INTEGER);
        CREATE TABLE faces(id TEXT PRIMARY KEY,path TEXT,person_id TEXT,bounds TEXT,landmarks TEXT,confidence REAL,quality REAL,embedding TEXT,ignored INTEGER,model TEXT);
        INSERT INTO people VALUES('p','Alex','f',1,1);
        INSERT INTO faces VALUES('f','photo','p','[0,0,1,1]','[[0,0],[0,0],[0,0],[0,0],[0,0]]',1,1,'[]',1,'old');
        PRAGMA user_version=1;").unwrap();
    drop(conn);
    let conn = db::open(&path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        conn.query_row("SELECT name FROM people", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Alex"
    );
    let face = db::face(&conn, "f").unwrap();
    assert!(face.ignored);
    assert_eq!(face.person_id, "p");
    assert_eq!(
        conn.query_row("SELECT provenance FROM faces", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "legacy"
    );
    drop(conn);
    assert!(db::open(&path).is_ok());
}

#[test]
fn detailed_scan_does_not_skip_standard_results_or_downgrade_them() {
    let (_dir, mut conn) = index();
    db::replace(&mut conn, "a", "1", &[detection(0.)]).unwrap();
    assert!(db::unchanged_for(&conn, "a", "1", false).unwrap());
    assert!(!db::unchanged_for(&conn, "a", "1", true).unwrap());
    conn.execute(
        "UPDATE scanned_files SET settings=?",
        [super::types::DETAILED_DETECTION_VERSION],
    )
    .unwrap();
    assert!(db::unchanged_for(&conn, "a", "1", false).unwrap());
    assert!(db::unchanged_for(&conn, "a", "1", true).unwrap());
    assert!(!db::unchanged_for(&conn, "a", "changed", true).unwrap());
}

#[test]
fn coherent_duplicate_buckets_group_without_treating_each_other_as_rivals() {
    let (_dir, mut conn) = index();
    for (path, angle) in [("a", 0.), ("b", 0.1), ("c", -0.1)] {
        db::replace(&mut conn, path, "1", &[detection(angle)]).unwrap();
    }
    split(&conn);
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 1);
    history::undo(&mut conn).unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 3);
}

#[test]
fn shortcuts_are_scoped_reassigned_and_restored_by_undo() {
    let (_dir, mut conn) = index();
    db::replace(&mut conn, "a", "1", &[detection(0.)]).unwrap();
    db::replace(&mut conn, "b", "1", &[detection(1.)]).unwrap();
    split(&conn);
    let people = db::summaries(&conn).unwrap();
    let first = &people[0].id;
    let second = &people[1].id;
    shortcuts::set(&mut conn, "folder:a", first, Some("D")).unwrap();
    shortcuts::set(&mut conn, "album:a", first, Some("1")).unwrap();
    shortcuts::set(&mut conn, "folder:a", second, Some("d")).unwrap();
    assert_eq!(
        shortcuts::list(&conn, "folder:a").unwrap(),
        vec![shortcuts::PersonShortcut {
            shortcut: "d".into(),
            person_id: second.clone(),
        }]
    );
    apply(
        &mut conn,
        Mutation::Merge {
            ids: vec![first.clone(), second.clone()],
            target: first.clone(),
        },
    )
    .unwrap();
    assert!(shortcuts::list(&conn, "folder:a").unwrap().is_empty());
    history::undo(&mut conn).unwrap();
    assert_eq!(shortcuts::list(&conn, "folder:a").unwrap().len(), 1);
    assert_eq!(shortcuts::list(&conn, "album:a").unwrap().len(), 1);
}

#[test]
fn internal_evaluation_copies_are_removed_on_open() {
    assert!(db::is_internal_path(std::path::Path::new(
        "/photos/.rapidraw-auto-evaluation-job/inputs/a.raw"
    )));
    assert!(!db::is_internal_path(std::path::Path::new(
        "/photos/session/a.raw"
    )));
    let (dir, mut conn) = index();
    let path = "/photos/.rapidraw-auto-evaluation-test/inputs/copy.raw";
    db::replace(&mut conn, path, "1", &[detection(0.)]).unwrap();
    assert_eq!(db::faces(&conn, None).unwrap().len(), 1);
    drop(conn);
    let conn = db::open(&dir.path().join("people.sqlite")).unwrap();
    assert!(db::faces(&conn, None).unwrap().is_empty());
    assert!(db::summaries(&conn).unwrap().is_empty());
}
