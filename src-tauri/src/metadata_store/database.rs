//! Keeps every record in one SQLite database (sqlx) in the app data folder, so photo
//! folders stay free of sidecar files. Records are keyed by path, so they follow moves and
//! renames made inside RapidRAW but not ones made in the file manager.

use std::error::Error;
use std::future::Future;
use std::io;
use std::path::{MAIN_SEPARATOR, Path};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sqlx::Row;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteRow,
    SqliteSynchronous,
};

use super::{ImageKey, MetadataProvider, Removal};

// The rest of the app calls into the store from plain threads, rayon and async tasks alike,
// so queries run on a runtime of their own and callers wait on a channel. That is safe from
// any thread, including the app's own tokio workers.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("metadata-db")
        .enable_all()
        .build()
        .expect("failed to start the metadata database runtime")
});

fn block_on<T, E>(future: impl Future<Output = Result<T, E>> + Send + 'static) -> io::Result<T>
where
    T: Send + 'static,
    E: Into<Box<dyn Error + Send + Sync>> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    RUNTIME.spawn(async move {
        let _ = tx.send(future.await);
    });
    rx.recv()
        .map_err(|_| io::Error::other("metadata database task was cancelled"))?
        .map_err(io::Error::other)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct Columns {
    source_path: String,
    copy_id: String,
    folder: String,
}

fn columns(key: &ImageKey) -> Columns {
    Columns {
        source_path: key.source.to_string_lossy().into_owned(),
        copy_id: key.copy_id.clone().unwrap_or_default(),
        folder: key
            .source
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

fn key_from_row(row: &SqliteRow) -> ImageKey {
    let source: String = row.get("source_path");
    let copy_id: String = row.get("copy_id");
    if copy_id.is_empty() {
        ImageKey::primary(source)
    } else {
        ImageKey::with_copy(source, copy_id)
    }
}

/// `dir` without a trailing separator, and with one, for matching it and its subfolders.
fn folder_bounds(dir: &Path) -> (String, String) {
    let dir = dir.to_string_lossy();
    let trimmed = dir.trim_end_matches(['/', MAIN_SEPARATOR]).to_string();
    let prefix = format!("{trimmed}{MAIN_SEPARATOR}");
    (trimmed, prefix)
}

struct Indexed {
    rating: i64,
    flag: Option<String>,
    tags: Option<String>,
}

fn indexed(json: &str) -> Indexed {
    let value: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    Indexed {
        rating: value.get("rating").and_then(Value::as_i64).unwrap_or(0),
        flag: value
            .get("flag")
            .and_then(Value::as_str)
            .map(str::to_string),
        tags: value
            .get("tags")
            .filter(|tags| tags.is_array())
            .map(Value::to_string),
    }
}

pub struct DatabaseProvider {
    pool: SqlitePool,
}

impl DatabaseProvider {
    pub fn open(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));

        let pool = block_on(async move {
            let pool = SqlitePoolOptions::new()
                .max_connections(4)
                .connect_with(options)
                .await?;
            sqlx::migrate!("./resources/migrations").run(&pool).await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(pool)
        })?;
        log::info!("Opened metadata database at {}", path.display());
        Ok(Self { pool })
    }

    fn run<T, F>(&self, query: impl FnOnce(SqlitePool) -> F) -> io::Result<T>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, sqlx::Error>> + Send + 'static,
    {
        block_on(query(self.pool.clone()))
    }

    fn keys_where_folder_under(&self, dir: &Path) -> io::Result<Vec<ImageKey>> {
        let (folder, prefix) = folder_bounds(dir);
        self.run(move |pool| async move {
            let rows = sqlx::query(
                "SELECT source_path, copy_id FROM image_metadata
                 WHERE folder = ?1 OR substr(folder, 1, length(?2)) = ?2",
            )
            .bind(folder)
            .bind(prefix)
            .fetch_all(&pool)
            .await?;
            Ok(rows.iter().map(key_from_row).collect())
        })
    }
}

impl MetadataProvider for DatabaseProvider {
    fn read(&self, key: &ImageKey) -> io::Result<Option<String>> {
        let c = columns(key);
        self.run(move |pool| async move {
            sqlx::query_scalar::<_, String>(
                "SELECT data FROM image_metadata WHERE source_path = ?1 AND copy_id = ?2",
            )
            .bind(c.source_path)
            .bind(c.copy_id)
            .fetch_optional(&pool)
            .await
        })
    }

    fn write(&self, key: &ImageKey, json: &str) -> io::Result<()> {
        let c = columns(key);
        let data = json.to_string();
        let indexed = indexed(json);
        self.run(move |pool| async move {
            // modified_ms always moves forward so two writes in one millisecond still differ.
            sqlx::query(
                "INSERT INTO image_metadata
                     (source_path, copy_id, folder, data, rating, flag, tags, modified_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (source_path, copy_id) DO UPDATE SET
                     folder = excluded.folder,
                     data = excluded.data,
                     rating = excluded.rating,
                     flag = excluded.flag,
                     tags = excluded.tags,
                     modified_ms = max(excluded.modified_ms, image_metadata.modified_ms + 1)",
            )
            .bind(c.source_path)
            .bind(c.copy_id)
            .bind(c.folder)
            .bind(data)
            .bind(indexed.rating)
            .bind(indexed.flag)
            .bind(indexed.tags)
            .bind(now_ms())
            .execute(&pool)
            .await
            .map(drop)
        })
    }

    fn create(&self, key: &ImageKey, json: &str) -> io::Result<bool> {
        let c = columns(key);
        let data = json.to_string();
        let indexed = indexed(json);
        self.run(move |pool| async move {
            let result = sqlx::query(
                "INSERT INTO image_metadata
                     (source_path, copy_id, folder, data, rating, flag, tags, modified_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (source_path, copy_id) DO NOTHING",
            )
            .bind(c.source_path)
            .bind(c.copy_id)
            .bind(c.folder)
            .bind(data)
            .bind(indexed.rating)
            .bind(indexed.flag)
            .bind(indexed.tags)
            .bind(now_ms())
            .execute(&pool)
            .await?;
            Ok(result.rows_affected() == 1)
        })
    }

    fn remove(&self, keys: &[ImageKey], _removal: Removal) -> io::Result<()> {
        let keys: Vec<Columns> = keys.iter().map(columns).collect();
        self.run(move |pool| async move {
            let mut tx = pool.begin().await?;
            for c in keys {
                sqlx::query("DELETE FROM image_metadata WHERE source_path = ?1 AND copy_id = ?2")
                    .bind(c.source_path)
                    .bind(c.copy_id)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await
        })
    }

    fn copy(&self, from: &ImageKey, to: &ImageKey) -> io::Result<()> {
        let from = columns(from);
        let to = columns(to);
        self.run(move |pool| async move {
            sqlx::query(
                "INSERT INTO image_metadata
                     (source_path, copy_id, folder, data, rating, flag, tags, modified_ms)
                 SELECT ?1, ?2, ?3, data, rating, flag, tags, ?4
                 FROM image_metadata WHERE source_path = ?5 AND copy_id = ?6
                 ON CONFLICT (source_path, copy_id) DO UPDATE SET
                     folder = excluded.folder,
                     data = excluded.data,
                     rating = excluded.rating,
                     flag = excluded.flag,
                     tags = excluded.tags,
                     modified_ms = max(excluded.modified_ms, image_metadata.modified_ms + 1)",
            )
            .bind(to.source_path)
            .bind(to.copy_id)
            .bind(to.folder)
            .bind(now_ms())
            .bind(from.source_path)
            .bind(from.copy_id)
            .execute(&pool)
            .await
            .map(drop)
        })
    }

    fn rename(&self, from: &ImageKey, to: &ImageKey) -> io::Result<()> {
        let from = columns(from);
        let to = columns(to);
        self.run(move |pool| async move {
            sqlx::query(
                "UPDATE OR REPLACE image_metadata
                 SET source_path = ?1, copy_id = ?2, folder = ?3
                 WHERE source_path = ?4 AND copy_id = ?5",
            )
            .bind(to.source_path)
            .bind(to.copy_id)
            .bind(to.folder)
            .bind(from.source_path)
            .bind(from.copy_id)
            .execute(&pool)
            .await
            .map(drop)
        })
    }

    fn exists(&self, key: &ImageKey) -> bool {
        self.modified_ms(key).is_some()
    }

    fn modified_ms(&self, key: &ImageKey) -> Option<u64> {
        let c = columns(key);
        let modified = self.run(move |pool| async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT modified_ms FROM image_metadata WHERE source_path = ?1 AND copy_id = ?2",
            )
            .bind(c.source_path)
            .bind(c.copy_id)
            .fetch_optional(&pool)
            .await
        });
        match modified {
            Ok(modified) => modified.map(|ms| ms as u64),
            Err(e) => {
                log::warn!("Failed to read metadata for {}: {}", key.virtual_path(), e);
                None
            }
        }
    }

    fn quarantine(&self, key: &ImageKey, reason: &str) {
        let c = columns(key);
        let reason = reason.to_string();
        let result = self.run(move |pool| async move {
            let mut tx = pool.begin().await?;
            sqlx::query(
                "INSERT INTO quarantined_metadata (source_path, copy_id, data, reason, quarantined_ms)
                 SELECT source_path, copy_id, data, ?3, ?4
                 FROM image_metadata WHERE source_path = ?1 AND copy_id = ?2",
            )
            .bind(&c.source_path)
            .bind(&c.copy_id)
            .bind(reason)
            .bind(now_ms())
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM image_metadata WHERE source_path = ?1 AND copy_id = ?2")
                .bind(&c.source_path)
                .bind(&c.copy_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await
        });
        match result {
            Ok(()) => log::error!(
                "Unreadable metadata for {}, moved to quarantined_metadata",
                key.virtual_path()
            ),
            Err(e) => log::error!(
                "Unreadable metadata for {}, could not move it aside: {}",
                key.virtual_path(),
                e
            ),
        }
    }

    fn records_for(&self, source: &Path) -> io::Result<Vec<ImageKey>> {
        let source_path = source.to_string_lossy().into_owned();
        self.run(move |pool| async move {
            let rows = sqlx::query(
                "SELECT source_path, copy_id FROM image_metadata WHERE source_path = ?1",
            )
            .bind(source_path)
            .fetch_all(&pool)
            .await?;
            Ok(rows.iter().map(key_from_row).collect())
        })
    }

    fn records_under(&self, root: &Path) -> Vec<ImageKey> {
        self.keys_where_folder_under(root).unwrap_or_else(|e| {
            log::error!("Failed to list metadata under {}: {}", root.display(), e);
            Vec::new()
        })
    }

    fn clear_under(&self, root: &Path) -> io::Result<usize> {
        let (folder, prefix) = folder_bounds(root);
        self.run(move |pool| async move {
            let result = sqlx::query(
                "DELETE FROM image_metadata
                 WHERE folder = ?1 OR substr(folder, 1, length(?2)) = ?2",
            )
            .bind(folder)
            .bind(prefix)
            .execute(&pool)
            .await?;
            Ok(result.rows_affected() as usize)
        })
    }

    fn records_in_folder(&self, dir: &Path, recursive: bool) -> Vec<ImageKey> {
        if recursive {
            return self.records_under(dir);
        }
        let (folder, _) = folder_bounds(dir);
        self.run(move |pool| async move {
            let rows =
                sqlx::query("SELECT source_path, copy_id FROM image_metadata WHERE folder = ?1")
                    .bind(folder)
                    .fetch_all(&pool)
                    .await?;
            Ok(rows.iter().map(key_from_row).collect())
        })
        .unwrap_or_else(|e| {
            log::error!("Failed to list metadata in {}: {}", dir.display(), e);
            Vec::new()
        })
    }

    fn folder_renamed(&self, old: &Path, new: &Path) -> io::Result<()> {
        let (old_folder, old_prefix) = folder_bounds(old);
        let (new_folder, _) = folder_bounds(new);
        self.run(move |pool| async move {
            sqlx::query(
                "UPDATE OR REPLACE image_metadata
                 SET source_path = ?1 || substr(source_path, length(?2) + 1),
                     folder = ?1 || substr(folder, length(?2) + 1)
                 WHERE folder = ?2 OR substr(folder, 1, length(?3)) = ?3",
            )
            .bind(new_folder)
            .bind(old_folder)
            .bind(old_prefix)
            .execute(&pool)
            .await
            .map(drop)
        })
    }

    fn folder_removed(&self, dir: &Path) -> io::Result<()> {
        self.clear_under(dir).map(drop)
    }
}
