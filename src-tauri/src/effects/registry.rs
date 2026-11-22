//! Effect registry: a single seam for registering a Tier-2 render effect.
//!
//! Historically each GPU effect was wired by hand into three separate places:
//! the dispatch block in `render/source.rs`, the cache key in
//! `render/cache_utils.rs::calculate_effects_hash`, and (for the UI) the
//! frontend. Every new effect had to touch all of them, and an external
//! plugin had to patch core source files to add one. This module collapses the
//! two render-side seams into one descriptor so an effect — core or plugin —
//! registers itself from its own module with no edits to the dispatch or cache
//! code.
//!
//! An effect submits one [`EffectDescriptor`] via `inventory::submit!`. The
//! renderer iterates [`all`] to dispatch, and the cache iterates the same list
//! to build the effects hash, so a registered effect can never be dispatched
//! without being hashed (the classic stale-preview bug).

use std::sync::OnceLock;

use serde_json::Value;

use crate::render::geometry::GeometryParams;
use crate::render::gpu::compute::{ComputeEncoder, Slot};

/// Everything an effect needs to decide whether it runs this frame and to
/// build its GPU job. Fields are borrowed for the duration of one dispatch.
pub struct EffectCtx<'a> {
    /// The loose adjustments JSON. Effects read their own fields from it; no
    /// Rust struct change is needed to add fields.
    pub adjustments: &'a Value,
    /// Lens/geometry parameters for effects that are geometry-aware (fog,
    /// relight, lens blur). `None` when the image has identity geometry.
    pub geometry: Option<&'a GeometryParams>,
    /// Zoom-dependent working size the effect renders at.
    pub working_size: (u32, u32),
}

/// A prepared, ready-to-encode effect job. Returned by
/// [`EffectDescriptor::prepare`] when the effect is enabled for this frame.
pub trait EffectJob {
    fn encode(&self, enc: &mut ComputeEncoder, src: &Slot, dst: &Slot);
}

/// Static description of one registered effect.
pub struct EffectDescriptor {
    /// Dispatch/compose order. Lower runs first. Core effects use
    /// relight=10, fog=20, lens blur=30; plugins pick values between or after.
    pub order: i32,
    /// Customize-Panels tool id, e.g. `"fog"`. Must match the frontend tool id.
    pub tool_id: &'static str,
    /// Boolean adjustments key that enables the effect, e.g. `"fogEnabled"`.
    pub enabled_key: &'static str,
    /// Every adjustments field the effect reads. Mirrored into the effects
    /// hash so a change invalidates the effects-stage cache.
    pub hash_keys: &'static [&'static str],
    /// Whether the effect's output depends on orientation/flip (hashed in).
    pub hashes_orientation: bool,
    /// Build the job for this frame, or `None` when the effect is disabled.
    /// Implementations gate on
    /// [`is_effect_enabled`](crate::render::adjustment_utils::is_effect_enabled).
    pub prepare: fn(&EffectCtx) -> Option<Box<dyn EffectJob>>,
}

inventory::collect!(EffectDescriptor);

/// All registered effects, sorted by `order`. Built once and cached, so the
/// per-frame cache hash and dispatch loops stay allocation-free.
pub fn all() -> &'static [&'static EffectDescriptor] {
    static CACHE: OnceLock<Vec<&'static EffectDescriptor>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mut effects: Vec<&'static EffectDescriptor> =
            inventory::iter::<EffectDescriptor>().collect();
        effects.sort_by_key(|effect| effect.order);
        effects
    })
}

#[cfg(test)]
mod tests {
    use super::all;

    /// The three core Tier-2 effects must self-register via `inventory` and
    /// appear in dispatch order. This also proves the link-time registration
    /// survives into a test binary (the registry would otherwise be empty).
    #[test]
    fn core_effects_register_in_dispatch_order() {
        let ids: Vec<&str> = all().iter().map(|effect| effect.tool_id).collect();
        for id in ["relight", "fog", "lensBlur"] {
            assert!(ids.contains(&id), "effect `{id}` is not registered");
        }
        let position = |id: &str| ids.iter().position(|current| *current == id).unwrap();
        assert!(position("relight") < position("fog"));
        assert!(position("fog") < position("lensBlur"));
    }

    /// Every registered effect must carry a non-empty hash-key list, or a
    /// slider change would be dispatched without invalidating the cache.
    #[test]
    fn every_effect_has_hash_keys() {
        for effect in all() {
            assert!(
                !effect.hash_keys.is_empty(),
                "effect `{}` has no hash keys",
                effect.tool_id
            );
        }
    }
}
