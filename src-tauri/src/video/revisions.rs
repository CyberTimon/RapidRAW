use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::video::model::{LookJson, VideoProject};
use crate::video::{VideoState, blocking};

const KEPT: usize = 8;
const KEPT_BYTES: usize = 64 << 20;
const MIN_KEPT: usize = 2;
const MALFORMED: &str = "Malformed project revision";
pub const UNKNOWN: &str = "Unknown project revision";

pub struct Revision {
    pub project: VideoProject,
    rest: Vec<u8>,
    received: usize,
}

impl Revision {
    pub fn file_json(&self) -> Result<Vec<u8>, String> {
        let mut looks: Vec<_> = self.project.looks.iter().collect();
        looks.sort_unstable_by_key(|(id, _)| id.as_str());
        let mut json = Vec::with_capacity(self.received + self.rest.len());
        json.extend_from_slice(b"{\"looks\":{");
        for (index, (id, look)) in looks.into_iter().enumerate() {
            if index > 0 {
                json.push(b',');
            }
            serde_json::to_writer(&mut json, id).map_err(|e| e.to_string())?;
            json.push(b':');
            serde_json::to_writer(&mut json, look.json()).map_err(|e| e.to_string())?;
        }
        json.push(b'}');
        match self.rest.get(1..).filter(|rest| rest.len() > 1) {
            Some(rest) => {
                json.push(b',');
                json.extend_from_slice(rest);
            }
            None => json.push(b'}'),
        }
        Ok(json)
    }
}

#[derive(Deserialize)]
struct Header {
    base: Option<u64>,
    #[serde(default)]
    keep: Vec<String>,
    #[serde(default)]
    looks: HashMap<String, LookJson>,
}

type Kept = VecDeque<(u64, Arc<Revision>)>;

#[derive(Default)]
pub struct Revisions {
    next: AtomicU64,
    kept: Mutex<Kept>,
}

impl Revisions {
    fn lock(&self) -> MutexGuard<'_, Kept> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn get(&self, id: u64) -> Result<Arc<Revision>, String> {
        let mut kept = self.lock();
        let entry = kept
            .iter()
            .position(|(kept_id, _)| *kept_id == id)
            .and_then(|index| kept.remove(index))
            .ok_or(UNKNOWN)?;
        let revision = Arc::clone(&entry.1);
        kept.push_back(entry);
        Ok(revision)
    }

    fn insert(&self, revision: Revision) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut evicted = Vec::new();
        {
            let mut kept = self.lock();
            kept.push_back((id, Arc::new(revision)));
            let mut bytes: usize = kept.iter().map(|(_, kept)| kept.received).sum();
            while kept.len() > MIN_KEPT && (kept.len() > KEPT || bytes > KEPT_BYTES) {
                let Some((_, dropped)) = kept.pop_front() else {
                    break;
                };
                bytes -= dropped.received;
                evicted.push(dropped);
            }
        }
        id
    }

    pub fn release(&self) {
        let evicted: Vec<_> = {
            let mut kept = self.lock();
            let stale = kept.len().saturating_sub(1);
            kept.drain(..stale).collect()
        };
        if !evicted.is_empty() {
            std::thread::spawn(move || drop(evicted));
        }
    }

    fn parse(&self, body: &[u8]) -> Result<Revision, String> {
        let (length, body) = body.split_first_chunk::<4>().ok_or(MALFORMED)?;
        let (header, rest) = body
            .split_at_checked(u32::from_le_bytes(*length) as usize)
            .ok_or(MALFORMED)?;
        let Header {
            base,
            keep,
            mut looks,
        } = serde_json::from_slice(header).map_err(|e| e.to_string())?;
        if !keep.is_empty() {
            let base = self.get(base.ok_or(UNKNOWN)?)?;
            for id in keep {
                let look = base.project.looks.get(&id).ok_or(UNKNOWN)?.clone();
                looks.insert(id, look);
            }
        }
        let mut project: VideoProject = serde_json::from_slice(rest).map_err(|e| e.to_string())?;
        project.looks = looks;
        Ok(Revision {
            project,
            rest: rest.to_vec(),
            received: header.len() + rest.len(),
        })
    }
}

#[tauri::command]
pub async fn video_set_project(request: Request<'_>, app_handle: AppHandle) -> Result<u64, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a raw project".to_string());
    };
    let body = bytes.clone();
    blocking(move || {
        let revisions = &app_handle.state::<VideoState>().revisions;
        let revision = revisions.parse(&body)?;
        Ok(revisions.insert(revision))
    })
    .await?
}
