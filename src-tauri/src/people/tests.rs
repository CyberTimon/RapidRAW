use super::{
    database as db,
    mutations::{Mutation, apply},
    types::*,
};

fn face(axis: usize, x: f32) -> Detection {
    let mut embedding = vec![0.0; 128];
    embedding[axis] = 1.0;
    Detection {
        bounds: [x, 0.1, 0.2, 0.2],
        landmarks: [[0.2, 0.2]; 5],
        confidence: 0.99,
        embedding,
    }
}

#[test]
fn two_people_share_a_photo_and_persist() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("people.sqlite");
    let mut conn = db::open(&path).unwrap();
    db::replace(&mut conn, "group.jpg", "1", &[face(0, 0.1), face(1, 0.6)]).unwrap();
    db::replace(&mut conn, "portrait.jpg", "2", &[face(0, 0.1)]).unwrap();
    let people = db::summaries(&conn).unwrap();
    assert_eq!(people.len(), 2);
    assert!(people.iter().all(|p| {
        db::paths(&conn, &p.id)
            .unwrap()
            .contains(&"group.jpg".into())
    }));
    assert_eq!(people.iter().map(|p| p.photo_count).sum::<u32>(), 3);
    assert!(db::unchanged(&conn, "portrait.jpg", "2").unwrap());
    assert!(!db::unchanged(&conn, "portrait.jpg", "3").unwrap());
    drop(conn);
    assert_eq!(db::summaries(&db::open(&path).unwrap()).unwrap().len(), 2);
}

#[test]
fn corrections_rescan_and_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = db::open(&dir.path().join("db")).unwrap();
    db::replace(&mut conn, "a", "1", &[face(0, 0.1), face(1, 0.6)]).unwrap();
    let people = db::summaries(&conn).unwrap();
    let id = people[0].id.clone();
    apply(
        &mut conn,
        Mutation::Rename {
            id: id.clone(),
            name: "Alex".into(),
        },
    )
    .unwrap();
    apply(
        &mut conn,
        Mutation::Merge {
            ids: people.iter().map(|p| p.id.clone()).collect(),
            target: id.clone(),
        },
    )
    .unwrap();
    assert_eq!(db::paths(&conn, &id).unwrap().len(), 1);
    let faces = db::faces(&conn, Some(&id)).unwrap();
    apply(
        &mut conn,
        Mutation::Move {
            faces: vec![faces[0].id.clone()],
            target: None,
        },
    )
    .unwrap();
    assert_eq!(db::summaries(&conn).unwrap().len(), 2);
    apply(
        &mut conn,
        Mutation::Ignore {
            faces: vec![faces[0].id.clone()],
            ignored: true,
        },
    )
    .unwrap();
    db::replace(&mut conn, "a", "2", &[face(0, 0.1), face(1, 0.6)]).unwrap();
    assert!(db::faces(&conn, None).unwrap().iter().any(|f| f.ignored));
    assert!(
        apply(
            &mut conn,
            Mutation::Move {
                faces: vec!["missing".into()],
                target: None
            }
        )
        .is_err()
    );
    assert_eq!(db::faces(&conn, None).unwrap().len(), 2);
    let mut invalid = face(0, 0.1);
    invalid.embedding = vec![f32::NAN; 128];
    assert!(db::replace(&mut conn, "a", "3", &[invalid]).is_err());
    assert!(db::unchanged(&conn, "a", "2").unwrap());
    let stale = dir.path().join("missing.jpg").to_string_lossy().to_string();
    db::replace(&mut conn, &stale, "1", &[face(2, 0.1)]).unwrap();
    db::prune(&mut conn).unwrap();
    assert!(
        db::faces(&conn, None)
            .unwrap()
            .iter()
            .all(|f| f.path != stale)
    );
}

#[test]
fn no_faces_is_an_incrementally_cached_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = db::open(&dir.path().join("db")).unwrap();
    db::replace(&mut conn, "empty", "1", &[]).unwrap();
    assert!(db::unchanged(&conn, "empty", "1").unwrap());
    assert!(db::summaries(&conn).unwrap().is_empty());
}

#[test]
#[ignore = "Requires local models and a user-provided photo; never downloads or uploads"]
fn local_model_smoke() {
    let dir = std::env::var("RAPIDRAW_PEOPLE_MODELS").expect("Set model directory");
    let photo = std::env::var("RAPIDRAW_PEOPLE_PHOTO").expect("Set fixture photo");
    let count: usize = std::env::var("RAPIDRAW_PEOPLE_FACE_COUNT")
        .expect("Set expected face count")
        .parse()
        .unwrap();
    let mut models = super::models::Models::from_dir(std::path::Path::new(&dir)).unwrap();
    let detected = models
        .detect(&super::preview::load(&photo).unwrap())
        .unwrap();
    assert_eq!(detected.len(), count);
    assert!(
        models
            .detect(&image::RgbImage::new(640, 640))
            .unwrap()
            .is_empty()
    );
    let index = tempfile::tempdir().unwrap();
    let mut conn = db::open(&index.path().join("db")).unwrap();
    db::replace(&mut conn, "group", "1", &detected).unwrap();
    db::replace(&mut conn, "repeat", "1", &detected).unwrap();
    let buckets = db::summaries(&conn).unwrap();
    assert_eq!(buckets.len(), count);
    for bucket in buckets {
        assert_eq!(
            db::paths(&conn, &bucket.id).unwrap(),
            vec!["group", "repeat"]
        );
    }
    // Match the application's existing macOS ONNX shutdown handler only after assertions.
    crate::register_exit_handler();
}
