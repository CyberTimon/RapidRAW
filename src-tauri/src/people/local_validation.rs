use super::{database as db, organize};
use std::sync::atomic::AtomicBool;
#[test]
#[ignore = "Requires an explicit local index snapshot; never modifies the source"]
fn local_index_regroup() {
    let source = std::env::var("RAPIDRAW_PEOPLE_INDEX").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    std::fs::copy(source, &path).unwrap();
    let mut conn = db::open(&path).unwrap();
    let old: std::collections::HashMap<_, _> = db::faces(&conn, None)
        .unwrap()
        .into_iter()
        .map(|f| (f.id, f.person_id))
        .collect();
    let before = db::summaries(&conn).unwrap().len();
    let started = std::time::Instant::now();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    println!(
        "Local index: {before} -> {} people; {} suggestions; {:?}",
        db::summaries(&conn).unwrap().len(),
        organize::suggestions(&conn).unwrap().len(),
        started.elapsed()
    );
    let assignments = db::faces(&conn, None)
        .unwrap()
        .into_iter()
        .map(|f| (f.id, f.person_id))
        .collect::<Vec<_>>();
    organize::run(&mut conn, true, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        assignments,
        db::faces(&conn, None)
            .unwrap()
            .into_iter()
            .map(|f| (f.id, f.person_id))
            .collect::<Vec<_>>()
    );
    if let Ok(destination) = std::env::var("RAPIDRAW_PEOPLE_REVIEW_IMAGE") {
        contact_sheet(&conn, &old, &destination);
    }
    if let Ok(destination) = std::env::var("RAPIDRAW_PEOPLE_VALIDATION_OUTPUT") {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        std::fs::copy(path, destination).unwrap();
    }
}

fn contact_sheet(
    db: &rusqlite::Connection,
    old: &std::collections::HashMap<String, String>,
    destination: &str,
) {
    let mut groups = std::collections::BTreeMap::<String, Vec<_>>::new();
    for face in super::database::faces(db, None).unwrap() {
        groups.entry(face.person_id.clone()).or_default().push(face);
    }
    let mut sheet = image::RgbImage::from_pixel(448, 1120, image::Rgb([35, 35, 35]));
    let mut row = 0;
    for faces in groups.values() {
        if faces
            .iter()
            .map(|f| &old[&f.id])
            .collect::<std::collections::HashSet<_>>()
            .len()
            < 2
        {
            continue;
        }
        let mut col = 0;
        let mut used = std::collections::HashSet::new();
        for face in faces {
            if !used.insert(&old[&face.id]) {
                continue;
            }
            let Ok(preview) = super::preview::load(&face.path) else {
                continue;
            };
            let points = face.landmarks.map(|p| {
                [
                    p[0] * preview.width() as f32,
                    p[1] * preview.height() as f32,
                ]
            });
            let crop = super::geometry::align(&preview, &points).unwrap();
            image::imageops::replace(&mut sheet, &crop, col * 112, row * 112);
            col += 1;
            if col == 4 {
                break;
            }
        }
        if col > 0 {
            row += 1;
        }
        if row == 10 {
            break;
        }
    }
    sheet.save(destination).unwrap();
}
