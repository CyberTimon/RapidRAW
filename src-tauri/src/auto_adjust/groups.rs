use super::{
    analysis::{default_target, quantile},
    types::*,
};

pub fn establish(entries: &mut [Entry]) -> Vec<Group> {
    // Sort canonical paths so selection order cannot change grouping or reference selection.
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let mut groups: Vec<Group> = Vec::new();
    let mut anchors: Vec<Analysis> = Vec::new();
    for e in entries.iter_mut() {
        let a = &e.analysis;
        let index = anchors.iter().position(|b| compatible(a, b)).unwrap_or_else(|| {
            let id = format!("lighting-{}", groups.len() + 1);
            groups.push(Group {
                id,
                scene: a.scene,
                confidence: a.confidence,
                paths: vec![],
                target: default_target(a.scene, !a.faces.is_empty()),
                warmth: 0.,
                tint: 0.,
            });
            anchors.push(a.clone());
            groups.len() - 1
        });
        e.group_id = groups[index].id.clone();
        groups[index].paths.push(e.path.clone());
    }
    for g in &mut groups {
        let members = entries.iter().filter(|e| e.group_id == g.id).collect::<Vec<_>>();
        if let Some(best) =
            members.iter().max_by(|a, b| a.analysis.confidence.total_cmp(&b.analysis.confidence))
        {
            g.scene = best.analysis.scene;
            g.target = default_target(g.scene, members.iter().any(|e| !e.analysis.faces.is_empty()));
        }
        let reliable = members
            .iter()
            .filter(|e| {
                e.analysis.subject > default_target(g.scene, !e.analysis.faces.is_empty()) * 0.85
                    && e.analysis.subject < 0.7
                    && e.analysis.clipped < 0.03
                    && e.analysis.noise < 0.4
            })
            .collect::<Vec<_>>();
        let mut brightness = reliable.iter().map(|e| e.analysis.subject).collect::<Vec<_>>();
        if !brightness.is_empty() && members.len() > 1 {
            g.target = quantile(&mut brightness, 0.5).clamp(0.25, 0.58);
        }
        let mut warmth = reliable
            .iter()
            .filter(|e| e.analysis.neutral_confidence > 0.5)
            .map(|e| e.analysis.warmth)
            .collect::<Vec<_>>();
        let mut tint = reliable
            .iter()
            .filter(|e| e.analysis.neutral_confidence > 0.5)
            .map(|e| e.analysis.tint)
            .collect::<Vec<_>>();
        g.warmth = quantile(&mut warmth, 0.5);
        g.tint = quantile(&mut tint, 0.5);
        g.confidence = members.iter().map(|e| e.analysis.confidence).sum::<f64>() / members.len() as f64;
    }
    groups
}
fn compatible(a: &Analysis, b: &Analysis) -> bool {
    let time_close = match (a.captured, b.captured) {
        (Some(x), Some(y)) => (x - y).abs() < 1800,
        _ => false,
    };
    let uncertain_pair = a.scene == Scene::Uncertain || b.scene == Scene::Uncertain;
    let compatible_day = matches!(a.scene, Scene::Daylight | Scene::WarmIndoor)
        || matches!(b.scene, Scene::Daylight | Scene::WarmIndoor);
    let same_scene = a.scene == b.scene || (uncertain_pair && (time_close || compatible_day));
    same_scene
        && (a.warmth - b.warmth).abs() < 0.16
        && (a.tint - b.tint).abs() < 0.10
        && (a.color_variance - b.color_variance).abs() < 0.6
        && match (a.captured, b.captured) {
            (Some(x), Some(y)) => (x - y).abs() < 7200,
            _ => true,
        }
}
