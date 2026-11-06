# Film Engine (spektrafilm) Integration

This fork replaces RapidRAW's classic adjustment pipeline with the
[spektrafilm](https://github.com/andreavolpato/spektrafilm) spectral film
simulation, via the Rust port [spektrafilm-rs](https://github.com/turbasvin/spektrafilm-rs)
(vendored in `vendor/spektrafilm-rs`, ported to wgpu 29 with per-pixel
exposure-map extensions).

## What RapidRAW still provides

- Library management (folders, import, ratings, filmstrip, metadata)
- Mask region selection (brush / linear / radial / flow / AI subject / sky /
  foreground / depth / text / face), sub-mask compositing
- `.rrdata` persistence, presets, copy/paste
- Export pipeline

## What the film engine owns

The entire scene-referred → display-referred transform: spectral upsampling,
film exposure, development (density curves, DIR couplers), halation, grain,
printing (enlarger, Y/M dichroic filters, preflash), print chemistry, glare,
scanning, gamut compression. RapidRAW's classic adjustments (tone, HSL,
curves, effects, tone mapper, LUTs) are **bypassed** when film mode is on —
except white balance, which is applied upstream in camera space (physically
equivalent to choosing the scene illuminant), and geometry (crop/rotation/
perspective/lens corrections), applied before the engine.

## Local adjustment via masks (dodging & burning)

Each mask carries two extra values (`adjustments.filmEv`,
`adjustments.printEv`, in EV). They compose into two per-pixel offset maps:

- **print exposure map** — added in the print log-exposure domain
  (`log10(raw) + ev·log10 2`). Physically exact darkroom dodging (-) /
  burning (+).
- **film exposure map** — multiplied into the linear input RGB after AE
  metering, before spectral upsampling. Denser negative ⇒ lighter print
  (negative inverts).

Implemented in the vendored fork as `Pipeline::set_exposure_maps` +
`FilmChainParams::{film,print}_exposure_map_ev`, with a new `ev_map.wgsl`
compute pass (multiply mode / additive-log mode) and CPU-path equivalents in
`filming::expose` / `printing::expose_calibrated`. Verified by
`tests/exposure_maps.rs` (CPU + GPU) and `tests/shared_device.rs`
(RapidRAW-style shared device).

## Render integration

`process_and_get_dynamic_image_inner` branches to `film_render::render_film_frame`
when `adjustments.filmSimulation.enabled`:

1. CPU mirror of the GPU transform chain (`apply_transform_cpu`: warp →
   working fit → frame → output fit, effects excluded)
2. WB multiply using the shader-path matrices (`wb_log_gain_*` + LMS matrices)
3. spektrafilm `Pipeline` (cached by full params hash) on a `WgpuBackend`
   **sharing RapidRAW's wgpu device** (`WgpuBackend::from_device`)
4. Oversized renders (single image buffer > `max_storage_buffer_binding_size`,
   e.g. llvmpipe/weak iGPUs at full res) divert to the staged CPU path —
   measured ~19 s for 24 MP with all effects on.
5. Output: clamped sRGB → display texture / `DynamicImage` (8/16-bit) /
   analytics feed (histogram + waveform keep working in film mode).

## Frontend

- New right-panel **Film** TAB (`Panel.Film`): enable toggle, film stock /
  print paper pickers (`list_film_profiles`), and the full parameter sections
  (exposure, development, halation, grain, diffusion filters, enlarger,
  print chemistry, scanner, color management). Params are stored as
  `filmSimulation.params` (partial spektrafilm `RuntimeParams` overrides,
  snake_case paths, deep-merged over defaults in Rust).
- Mask settings show **Print exposure** / **Film exposure** sliders in film
  mode (classic per-mask adjustments are hidden).
- The classic Adjustments panel shows a "film engine active" notice.
- Copy/paste & presets: `film` section = `filmSimulation` key.
- "Show original" compare never routes through the engine.

## Data & licensing

- `src-tauri/resources/film_data/` — 31 stock/paper profiles + spectral LUTs
  (CC BY-SA 4.0, © spektrafilm; see `vendor/spektrafilm-rs/LICENSE` GPLv3 and
  `resources/film_luts/SPEKTRAFILM_LICENSE.txt`). RapidRAW (AGPLv3) ×
  spektrafilm (GPLv3) are compatible per GPLv3 §13.
- Upstream sync: vendored fork tracks turbasvin/spektrafilm-rs main;
  merge upstream changes into `vendor/`, keeping the local patches
  (wgpu 29, no BLAS, `from_device`, exposure maps, oversized-render guard).

## Build

Windows (primary target): `npm run tauri build` — nothing extra needed; the
vendored crates are pure Rust + wgpu (no BLAS/OpenSSL additions).

WSL/dev check (as done in this repo's CI-less environment): see
`docs/dev-wsl.md` if present; the short version is that system deps are
stubbed via pkg-config stubs and the full check runs with the pinned 1.98
toolchain.
