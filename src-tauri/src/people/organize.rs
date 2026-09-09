use super::{database, history, matching};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_SUGGESTIONS: usize = 200;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub a: String,
    pub b: String,
    pub score: f32,
}

pub fn suggestions(db: &Connection) -> Result<Vec<Suggestion>> {
    Ok(db
        .prepare("SELECT a,b,score FROM suggestions ORDER BY score DESC,a,b LIMIT 200")?
        .query_map([], |r| {
            Ok(Suggestion {
                a: r.get(0)?,
                b: r.get(1)?,
                score: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[derive(Default, Clone)]
struct Candidate {
    best: Option<(usize, f32)>,
    second: Option<f32>,
}
impl Candidate {
    fn add(&mut self, other: usize, score: f32) {
        if self.best.is_none_or(|(_, best)| score > best) {
            self.second = self.best.map(|(_, score)| score);
            self.best = Some((other, score));
        } else if self.second.is_none_or(|second| score > second) {
            self.second = Some(score);
        }
    }
    fn clear(&self, score: f32) -> bool {
        self.second
            .is_none_or(|next| score - next >= matching::MARGIN)
    }
}
type Pair = (usize, usize, f32);

// O(people) candidate memory, even when many thousands of faces resemble one another.
fn evaluate(
    db: &Connection,
    profiles: &[matching::Profile],
    cancel: &AtomicBool,
) -> Result<(Vec<Candidate>, Vec<Pair>)> {
    let rejections = matching::rejections(db)?;
    let mut candidates = vec![Candidate::default(); profiles.len()];
    let mut review: Vec<Pair> = Vec::new();
    for (i, a) in profiles.iter().enumerate() {
        for (j, b) in profiles.iter().enumerate().skip(i + 1) {
            if cancel.load(Ordering::Relaxed) {
                return Ok((candidates, review));
            }
            if matching::is_rejected(&rejections, &a.id, &b.id) {
                continue;
            }
            if let Some(score) = matching::score(a, b).filter(|s| *s >= matching::REVIEW) {
                candidates[i].add(j, score);
                candidates[j].add(i, score);
                let position = review.partition_point(|&(_, _, s)| s >= score);
                if position < MAX_SUGGESTIONS {
                    review.insert(position, (i, j, score));
                    review.truncate(MAX_SUGGESTIONS);
                }
            }
        }
    }
    Ok((candidates, review))
}
fn save_review(db: &Connection, profiles: &[matching::Profile], review: Vec<Pair>) -> Result<()> {
    db.execute("DELETE FROM suggestions", [])?;
    for (i, j, score) in review {
        db.execute(
            "INSERT INTO suggestions VALUES(?,?,?,?)",
            params![profiles[i].id, profiles[j].id, score, matching::VERSION],
        )?;
    }
    Ok(())
}

pub fn run(db: &mut Connection, explicit: bool, cancel: &AtomicBool) -> Result<()> {
    let tx = db.transaction()?;
    let mut recorded = false;
    if explicit
        && tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM faces WHERE provenance='legacy')",
            [],
            |r| r.get::<_, bool>(0),
        )?
    {
        history::record(&tx, "organize")?;
        recorded = true;
        tx.execute(
            "UPDATE faces SET provenance='auto' WHERE provenance='legacy'",
            [],
        )?;
    }
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let profiles = matching::profiles(&tx)?;
        let (candidates, review) = evaluate(&tx, &profiles, cancel)?;
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        } // rollback the entire pass
        let protected = |p: &matching::Profile| p.named || p.manual || (!explicit && p.legacy);
        let mut chosen = candidates
            .iter()
            .enumerate()
            .filter_map(|(i, candidate)| {
                let (j, score) = candidate.best?;
                (i < j
                    && score >= matching::STRONG
                    && candidates[j].best.is_some_and(|(other, _)| other == i)
                    && candidate.clear(score)
                    && candidates[j].clear(score)
                    && !(protected(&profiles[i]) && protected(&profiles[j])))
                .then_some((i, j, score))
            })
            .collect::<Vec<_>>();
        chosen.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
        let groups = if chosen.is_empty() {
            super::cohorts::coherent(
                &tx,
                &profiles,
                &candidates
                    .iter()
                    .map(|c| c.best.map(|(_, s)| s))
                    .collect::<Vec<_>>(),
                &profiles.iter().map(protected).collect::<Vec<_>>(),
                cancel,
            )?
        } else {
            chosen.into_iter().map(|(i, j, _)| vec![i, j]).collect()
        };
        if groups.is_empty() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            save_review(&tx, &profiles, review)?;
            break;
        }
        if !recorded {
            history::record(&tx, "organize")?;
            recorded = true;
        }
        // Chosen groups are disjoint; re-evaluate all references before the next round.
        for members in groups {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let target = members
                .iter()
                .copied()
                .find(|&i| protected(&profiles[i]))
                .unwrap_or(members[0]);
            for source in members.into_iter().filter(|&i| i != target) {
                tx.execute(
                    "UPDATE faces SET person_id=? WHERE person_id=?",
                    params![profiles[target].id, profiles[source].id],
                )?;
            }
        }
        database::cleanup(&tx)?;
    }
    database::rebuild_all_centroids(&tx)?;
    tx.commit()?;
    Ok(())
}

pub fn refresh_suggestions(db: &Connection) -> Result<()> {
    let profiles = matching::profiles(db)?;
    let (_, review) = evaluate(db, &profiles, &AtomicBool::new(false))?;
    save_review(db, &profiles, review)
}
