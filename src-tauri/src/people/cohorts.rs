use super::matching::{self, Profile};
use anyhow::Result;
use rusqlite::Connection;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

fn root(parents: &mut [usize], mut i: usize) -> usize {
    while parents[i] != i {
        parents[i] = parents[parents[i]];
        i = parents[i];
    }
    i
}

// Duplicate unnamed buckets are not necessarily competing identities. Only collapse a
// near-best component when EVERY pair supports it and every outside candidate is weaker.
pub fn coherent(
    db: &Connection,
    profiles: &[Profile],
    best: &[Option<f32>],
    protected: &[bool],
    cancel: &AtomicBool,
) -> Result<Vec<Vec<usize>>> {
    let rejected = matching::rejections(db)?;
    let score = |i: usize, j: usize| {
        let (a, b) = (&profiles[i], &profiles[j]);
        if matching::is_rejected(&rejected, &a.id, &b.id) {
            None
        } else {
            matching::score(a, b)
        }
    };
    let mut parents = (0..profiles.len()).collect::<Vec<_>>();
    for i in 0..profiles.len() {
        for j in i + 1..profiles.len() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(Vec::new());
            }
            if score(i, j).is_some_and(|s| {
                s >= matching::STRONG
                    && [i, j]
                        .iter()
                        .all(|&n| best[n].is_some_and(|b| b - s < matching::MARGIN))
            }) {
                let (a, b) = (root(&mut parents, i), root(&mut parents, j));
                parents[b] = a;
            }
        }
    }
    let mut groups = BTreeMap::<usize, Vec<usize>>::new();
    for i in 0..profiles.len() {
        groups.entry(root(&mut parents, i)).or_default().push(i);
    }
    let mut result = Vec::new();
    for members in groups.into_values().filter(|g| g.len() > 1) {
        if members.iter().filter(|&&i| protected[i]).count() > 1 {
            continue;
        }
        let mut minimum = 1.0_f32;
        let mut complete = true;
        for (pos, &i) in members.iter().enumerate() {
            for &j in members.iter().skip(pos + 1) {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(Vec::new());
                }
                match score(i, j) {
                    Some(s) if s >= matching::STRONG => minimum = minimum.min(s),
                    _ => {
                        complete = false;
                        break;
                    }
                }
            }
            if !complete {
                break;
            }
        }
        if !complete {
            continue;
        }
        let mut separated = true;
        for &i in &members {
            for j in 0..profiles.len() {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(Vec::new());
                }
                if members.binary_search(&j).is_ok() {
                    continue;
                }
                if score(i, j)
                    .is_some_and(|s| s >= matching::REVIEW && minimum - s < matching::MARGIN)
                {
                    separated = false;
                    break;
                }
            }
            if !separated {
                break;
            }
        }
        if separated {
            result.push(members);
        }
    }
    Ok(result)
}
