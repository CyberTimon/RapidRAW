use std::collections::{HashSet, VecDeque};

pub const CAPACITY: usize = 500;
#[derive(Clone)]
pub struct Job {
    pub path: String,
    pub medium: bool,
    pub background: bool,
    pub request_generation: Option<u64>,
}

/// The back is highest priority. Large requests are bounded before insertion.
pub fn enqueue(queue: &mut VecDeque<Job>, paths: Vec<String>, medium: bool, background: bool) {
    enqueue_request(queue, paths, medium, background, None);
}

pub fn enqueue_request(
    queue: &mut VecDeque<Job>,
    paths: Vec<String>,
    medium: bool,
    background: bool,
    request_generation: Option<u64>,
) {
    let mut seen = HashSet::new();
    let jobs: Vec<_> = paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .take(CAPACITY)
        .map(|path| Job {
            path,
            medium,
            background,
            request_generation,
        })
        .collect();
    for mut job in jobs.into_iter().rev() {
        if let Some(index) = queue.iter().position(|old| old.path == job.path) {
            if background {
                queue[index].medium |= job.medium;
                continue;
            }
            job.medium |= queue.remove(index).unwrap().medium;
        }
        if background {
            if queue.len() < CAPACITY {
                queue.push_front(job);
            }
        } else {
            if queue.len() == CAPACITY {
                queue.pop_front();
            }
            queue.push_back(job);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn medium_upgrade_keeps_foreground_priority_and_generation() {
        let mut queue = VecDeque::new();
        enqueue_request(&mut queue, vec!["a".into()], false, false, Some(7));
        enqueue_request(&mut queue, vec!["a".into()], true, true, Some(7));
        assert_eq!(queue.len(), 1);
        let job = queue.pop_back().unwrap();
        assert!(job.medium);
        assert!(!job.background);
        assert_eq!(job.request_generation, Some(7));
    }
    #[test]
    fn oversized_requests_terminate_and_visible_work_wins() {
        let mut queue = VecDeque::new();
        enqueue(
            &mut queue,
            (0..10_000).map(|i| i.to_string()).collect(),
            false,
            true,
        );
        assert_eq!(queue.len(), CAPACITY);
        enqueue(
            &mut queue,
            vec!["visible".into(), "next".into()],
            false,
            false,
        );
        assert_eq!(queue.len(), CAPACITY);
        assert_eq!(queue.pop_back().unwrap().path, "visible");
        assert_eq!(queue.pop_back().unwrap().path, "next");
    }
    #[test]
    fn duplicates_promote_without_duplicate_decodes() {
        let mut queue = VecDeque::new();
        enqueue(&mut queue, vec!["a".into(), "a".into()], false, true);
        enqueue(&mut queue, vec!["a".into()], true, false);
        enqueue(&mut queue, vec!["a".into()], false, false);
        assert_eq!(queue.len(), 1);
        let job = queue.pop_back().unwrap();
        assert!(job.medium);
        assert!(!job.background);
    }
}
