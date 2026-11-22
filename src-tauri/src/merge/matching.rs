use super::features::{DESCRIPTOR_LENGTH, FeatureSet};
use rayon::prelude::*;
use std::collections::HashSet;

const RATIO_THRESHOLD: f32 = 0.8;
const EXHAUSTIVE_PAIR_LIMIT: usize = 10;
const PRESELECTION_FEATURES: usize = 400;
const PRESELECTION_NEIGHBORS: usize = 6;
const PRESELECTION_MIN_MATCHES: usize = 12;

#[inline]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0.0f32; 8];
    for (ca, cb) in a.as_chunks::<8>().0.iter().zip(b.as_chunks::<8>().0) {
        for k in 0..8 {
            acc[k] += ca[k] * cb[k];
        }
    }
    acc.iter().sum()
}

fn best_matches(query: &FeatureSet, train: &FeatureSet) -> Vec<Option<usize>> {
    query
        .descriptors
        .par_chunks_exact(DESCRIPTOR_LENGTH)
        .map(|q| {
            let mut best = (f32::NEG_INFINITY, usize::MAX);
            let mut second = f32::NEG_INFINITY;
            for (j, t) in train
                .descriptors
                .as_chunks::<DESCRIPTOR_LENGTH>()
                .0
                .iter()
                .enumerate()
            {
                let similarity = dot(q, t);
                if similarity > best.0 {
                    second = best.0;
                    best = (similarity, j);
                } else if similarity > second {
                    second = similarity;
                }
            }
            if best.1 == usize::MAX {
                return None;
            }
            let best_dist_sq = (2.0 - 2.0 * best.0).max(0.0);
            let second_dist_sq = (2.0 - 2.0 * second).max(0.0);
            if second == f32::NEG_INFINITY
                || best_dist_sq < RATIO_THRESHOLD * RATIO_THRESHOLD * second_dist_sq
            {
                Some(best.1)
            } else {
                None
            }
        })
        .collect()
}

pub fn match_features(a: &FeatureSet, b: &FeatureSet) -> Vec<(usize, usize)> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let forward = best_matches(a, b);
    let backward = best_matches(b, a);
    forward
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let j = (*m)?;
            (backward[j] == Some(i)).then_some((i, j))
        })
        .collect()
}

pub fn candidate_pairs(features: &[&FeatureSet]) -> Vec<(usize, usize)> {
    let n = features.len();
    let all_pairs: Vec<(usize, usize)> = (0..n)
        .flat_map(|i| (i + 1..n).map(move |j| (i, j)))
        .collect();
    if n <= EXHAUSTIVE_PAIR_LIMIT {
        return all_pairs;
    }

    let subsets: Vec<FeatureSet> = features
        .par_iter()
        .map(|f| f.strongest(PRESELECTION_FEATURES))
        .collect();
    let counts: Vec<((usize, usize), usize)> = all_pairs
        .par_iter()
        .map(|&(i, j)| ((i, j), match_features(&subsets[i], &subsets[j]).len()))
        .collect();

    let mut selected: HashSet<(usize, usize)> = (0..n - 1).map(|i| (i, i + 1)).collect();
    for image in 0..n {
        let mut partners: Vec<((usize, usize), usize)> = counts
            .iter()
            .filter(|((i, j), c)| (*i == image || *j == image) && *c >= PRESELECTION_MIN_MATCHES)
            .cloned()
            .collect();
        partners.sort_by_key(|p| std::cmp::Reverse(p.1));
        for (pair, _) in partners.into_iter().take(PRESELECTION_NEIGHBORS) {
            selected.insert(pair);
        }
    }
    let mut pairs: Vec<(usize, usize)> = selected.into_iter().collect();
    pairs.sort_unstable();
    pairs
}
