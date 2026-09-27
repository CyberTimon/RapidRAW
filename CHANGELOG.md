# Fork changelog

Changes added by this fork to RapidRAW. Upstream application changes remain in the [upstream history](https://github.com/CyberTimon/RapidRAW/commits/main/). Versioned entries identify fork releases; older date-only entries record development milestones. Native bridge versions are separate from the upstream application version and the MCP server package version.

## Unreleased

### Local editing

- Add rename, duplicate, duplicate-and-invert, copy/paste, reset, and delete actions for Local Edits and their selection components through context menus. Duplicated repairs discard generated pixels and candidate state while keeping independent selection geometry.

### Generative editing

- Add **Qwen remove PE** as a separate 1 MP workflow. PE expands a short removal request from the crop and selection guide without referring to the guide; Qwen receives the PE instruction unchanged and only the photo crop as an image input. RapidRAW still composites through the original selection.

### Release process

- Build packages for code pull requests and tagged releases. Keep PR build artifacts on the existing PR run for 7 days so they remain downloadable after merge; do not run a second package build on `main`. Skip documentation-only pull requests. Stop duplicate MCP runs on `codex/**` branch pushes and require the release tag commit to be on `main`.
- Retire Intel Mac packaging for subsequent fork releases. Published 0.4.0 Intel assets remain available; Apple Silicon and Linux x86_64 stay in the release matrix.

## 0.4.0 — 2026-09-24

Release tag: `fork-v0.4.0`. See the [release notes](docs/releases/0.4.0.md).

### Local editing

- Add a unified **Local Edits** workspace for named repairs and local adjustments. Create, reorder, hide, remove and refine edits, then copy supported selections between a repair and an adjustment while keeping each copy independent. Shape Light and Surface Colour selections remain adjustment-only.
- Bring selection and effect controls into the local edit workflow, including clear guidance when an analysis needs the AI Connector.

### Generative editing

- Send the visible crop and its matching selection to compatible AI Connectors, then map the generated result back through the photo's crop and orientation.
- Apply the final inpaint result automatically after a complete batch. Stopped or failed batches keep completed candidates in history without applying one; make candidate deletion a two-step action.

### Mask and preview correctness

- Reduce stale mask reuse and repeated preview work with content-sensitive image and patch cache keys and a byte-bounded mask bitmap cache.
- Keep cached Marigold surface components reusable while preserving subsequent subtractive and intersection mask edits.

## 0.3.0 — 2026-09-22

Release tag: `fork-v0.3.0`. See the [release notes](docs/releases/0.3.0.md).

### Inpaint studio

- Generate 1–4 variations from a fixed source and selection, then click a result to apply it or click again to disable it. Basic inpaint generates one candidate.
- Keep generation history scoped to each edit in the sidecar across restarts, reuse settings, delete unwanted candidates, and stop a batch after its running variation finishes.
- Add up to four reference images in a separate collapsible section for Qwen Image 2.1 and supporting Klein edit workflows. Keep Variations in its own row. Unsupported workflows reject references rather than silently ignoring them.

### MCP host

- Use the independently versioned Node host `@sheldonxxxx/rapidraw-mcp@0.2.0` for the public removal-coverage and preview options added in this fork release; it was released separately under the `mcp-v0.2.0` tag.

### Development checks

- Exclude generated Python virtual environments and pytest caches from Prettier checks. Allow unused Linux runtime helpers on other platforms while keeping strict Clippy checks on their supported targets.

### Editor responsiveness

- Keep the latest pending slider preview and avoid copying cached mask and repair images on each edit. Normal live previews use at most 1,920 pixels on the long edge while dragging, then restore the requested preview resolution on release; the Full quality setting keeps its requested resolution.
- Send pan and zoom transforms directly to the native renderer, and redraw mask controls with their resized canvas to prevent a delayed jump after zooming.
- Generate mask overlays on a background worker and discard outdated overlay responses when the selection or photograph changes.

### Automatic repair colour matching

- Match small generated colour differences to surrounding source pixels before RapidRAW composites Klein and Qwen repairs. Preserve the original mask and record skipped corrections in generation receipts.
- On uniform grainy surfaces, let Qwen repairs borrow fine texture from a nearby source area that passes colour and texture checks. Record the decision in the private receipt.

### Qwen Image 2.1 workflow

- When references are attached, identify the source photo as the image to edit and the uploads as auxiliary references in the Qwen prompt. Keep the original user prompt and the effective model instruction in the generation receipt.

- Add a discoverable Qwen Image 2.1 connector profile with 1 MP and 2 MP options, native reference conditioning and a 30-step sampling starting default. Keep the existing default workflow.
- Add a separate Qwen Remove workflow for brush-selected cleanup without a typed prompt. Send literal prompts in the ordinary Qwen workflow when no references are attached and record the removal instruction in the private receipt.

### Native removal coverage

- Add opt-in source-pixel removal expansion and outward feathering to desktop and MCP local/generative retouch. Apply subtractive and intersection protection after expansion; preserve existing masks when controls are omitted or zero.
- Preview the effective mask without generating or changing the session. Save removal settings with native patches for regeneration, recipe validation and portable sessions.

### Photographer-facing light, colour and depth tools

- Present optional Marigold analysis as Shape Light, Surface Colour and Depth Selection, with a [photographer guide](docs/creative-selections.md) and matching setup labels.
- Add light-direction buttons, a strength control and a gentle starting edit; pick surface colours on the photograph through crop, rotation and flips; add Near/Middle/Far depth starting ranges and a direct brush-intersection action for light and colour.
- Keep technical light/colour maps under Analysis details and recolouring optional. Preserve existing saved maps, MCP parameters and offline rendering.

### Desktop mask geometry

- Preserve existing local and AI-backed mask placement when rotating, fine-rotating, flipping or straightening an image.

### MCP-only CI and release matrix

- Restrict push, pull-request and manual release packaging to MCP-enabled macOS ARM64/x86_64 and Linux x86_64 builds; remove Windows, Linux ARM and tethering variants.

### MCP asset-descriptor round trip

- Resolve model-facing asset descriptors against live session state: a mutating call carrying read-back state with its `session_id` now rehydrates each `{_rapidraw_asset, sha256, state_path}` reference from the session's current full adjustments after a digest check, instead of rejecting the call. Stale digests, missing paths, and descriptors without session context keep the original rejection with a `STALE_DESCRIPTOR` (or unchanged `INVALID_ARGUMENT`) error, so no new pixels can enter the engine through this path. This enables round-trip edits such as pruning retouch patches via `set_adjustments`. Response projection, the response-size budget, and native save/bundle persistence are unchanged; workflow, server instructions, and the execution skill document the new semantics.

### Optional pinned NVIDIA runtime packaging and activation

- Support an independently versioned, optional Linux x86_64 NVIDIA runtime pack (official ONNX Runtime 1.30.0 CUDA 13, cuDNN 9.20.0, CUDA 13.2/13.3 user-space libraries; supported driver baseline 595.58.03+) with pinned release metadata (`packaging/linux-nvidia-runtime.release.json`) and SHA-verified non-root install under the XDG data directory.
- On Linux x86_64 startup, auto-discover the installed pack (`RAPIDRAW_NVIDIA_RUNTIME` explicit path, `off` disable, or the XDG `current` symlink), pin its `runtime.json` identity, re-exec with pack-first libraries before ONNX initialization, and default unset ONNX/Nonlocal providers to CUDA. Explicit provider choices (including `cpu`) are preserved; desktop setup no longer overwrites a caller-supplied `ORT_DYLIB_PATH`. The NIND denoise model keeps its narrow `CuDNNConvAlgorithmSearch::Default` compatibility exception while foreground/sky/depth and Nonlocal remain HEURISTIC, and normal CPU packages embed no NVIDIA payload.

### Nonlocal provider defaults

- Default `RAPIDRAW_NONLOCAL_PROVIDER` to Linux CUDA and macOS CoreML when unset (previously silent CPU) while keeping explicit values strict with no fallback, and update the denoise README, root README, install guidance and skill reference to the new platform-aware default. The Linux production launcher now derives `RAPIDRAW_NONLOCAL_PROVIDER` from `RAPIDRAW_ONNX_PROVIDER` when unset, so the ONNX and Nonlocal providers can no longer diverge in one process.

### Experimental GPU RAW denoising

- Integrate optional Nonlocal inference with MCP `start_denoise` via an in-process native ONNX Runtime backend (CPU or Linux CUDA, explicit provider, no fallback) and a pinned FP32 bundle. Return a separate float Bayer DNG and retain captured edits, using RapidRAW's existing decoder, demosaic and colour pipeline. Add one-pass/four-rotation modes, runtime-aware reusable verified predictions, tile-boundary cancellation and persistent job results. Keep NIND and BM3D available. Python remains research/export tooling only.
- Add a macOS-only direct CoreML.framework Nonlocal backend (`RAPIDRAW_NONLOCAL_PROVIDER=coreml`) reusing the shared Rust conditioning/tiling/ensemble pipeline through a backend-neutral tile predictor contract. The pinned FP32 `.mlpackage` is validated fail-closed (package digest plus runtime tree hash), compiled natively to `.mlmodelc`, and loaded once per job with all compute units and no low-precision GPU accumulation. CoreML uses its own `native-coreml-v1` generation, cache namespace and provenance; cross-family ONNX↔CoreML resume is rejected. No Python, coremltools or ONNX Runtime is needed for CoreML inference.
- Publish the exact accepted Nonlocal runtime artifacts (CoreML `.mlpackage` + ONNX bundle with hashed `distribution.json`) to the public model repo `sheldonxxxx/RapidRAW-Nonlocal-Denoise` at a pinned commit, and add `install_model kind="nonlocal"`: streamed, staged, hash-verified provider-specific download with existing inner bundle validation before atomic install. `RAPIDRAW_NONLOCAL_BUNDLE` stays an explicit override; otherwise installed bundles under workspace `models/nonlocal/` resolve automatically with `MODEL_NOT_INSTALLED` guidance and no hidden downloads. CoreML receipts now validate `runtime=coreml`, and CoreML cache identity carries the real macOS product/kernel build.
- Add an optional Python Bayer RAW denoising backend with per-channel noise estimation, tiled GPU inference, native-resolution sRGB exports and source/model provenance. Preserve the existing desktop/MCP NIND denoiser.
- Add reproducible noise-synthesis evaluation, approximate real-pair diagnostics and scene-separated adaptation tools with regression gates. This is a research implementation; commercial parity is not established.
- Extend GPU research with a fixed 40-scene study, content-selected crops, matched RAW/gradient-loss adaptation, tile-context diagnostics and checkpoint-hash-verified held-out evaluation. Preserve failed experiments and the existing lightweight denoiser.
- Fix real-pair registration metadata serialization for nonzero crop origins.
- Fix the native Nonlocal acceptance runner's provenance check to assert the backend generation (`native-onnx-v1`/`native-coreml-v1`) matching the provider under test instead of the retired Python-worker sampler field. Verified end to end on macOS with both the ONNX CPU and direct CoreML backends.

### Setup and connection guidance

- Publish the Node MCP host as `@sheldonxxxx/rapidraw-mcp@0.1.0` (public, AGPL-3.0-only) so packaged setups no longer require cloning this repository to build the host. Add the agent-agnostic [agent setup guide](AGENT_SETUP.md) with the pinned GitHub Release + npm host install flow, provider notes, generic MCP config, and verification checklist.
- Support independently versioned npm MCP host releases through GitHub Actions npm Trusted Publishing/OIDC with provenance, without a long-lived publish token.
- Add Codex project/user configuration, skill installation, environment and timeout examples, isolated-workspace preflight, and separate registration/native-render verification steps.
- Align the Linux SSH launcher with the documented release build and check executable paths before connection. Clarify inherited-sidecar baselines and recovery without reconnecting after oversized responses.
- Declare the `cc` build dependency unconditionally so Linux and Windows native builds compile (the CoreML bridge source itself is still compiled and linked on macOS only). Release builds verified end to end on macOS and Linux with the engine regression suite.
- Forward the full process environment through the engine, advanced, and asset acceptance runners when spawning the MCP server. The MCP SDK v2 client only inherits a safe allowlist by default, which dropped `DISPLAY`/`GDK_BACKEND`/`ORT_DYLIB_PATH` and broke headless Linux runs; this matches the existing behavior of the denoise, review-jobs, surfaces, and coverage runners.
- Document the `target` directory layout needed for unbundled macOS resource discovery when reusing a custom Cargo build cache.

### Optional Marigold directional light and colour

- Add opt-in Marigold V2 normals/albedo endpoints on the existing connector and ComfyUI queue, with pinned models and cached RGB16 maps.
- Add optional desktop/MCP mask controls for directional dodge/burn and albedo colour selection/recolouring, with saved RGB16 maps, offline rendering, native exports and portable-session support. Invalidate maps after lens/perspective or retouch changes; preserve alignment through display rotation, flips and crop. Existing tools and defaults remain available. See the [surface tools guide](ai-connector/SURFACES.md).
- Include the two chosen surface workflows and an optional CPU preview utility. Keep surface generation separately enabled on both connector and editor.

### Editing guidance

- Add opt-in texture-only healing for clean repairs with mismatched fine texture. It transfers donor detail while retaining broad destination colour and light; ordinary healing remains unchanged.
- Add a combined clone, heal and mask-blending workflow for repairs with mismatched texture or visible joins, including donor-coordinate checks and separate native-resolution boundary inspection.
- Clarify distraction removal through the established connector, local inpainting fallback, and native-detail repair checks while preserving original photographs and retained scene content.
- Add guidance for checking masks against retouched scenes and narrow background openings, and reconsidering treatments when refinements damage edges.
- Link Lightweft as the companion workspace for artistic direction, personal style, and visual review.

### Optional Marigold depth

- Add explicitly selected Marigold V2 depth masks in the desktop editor and MCP, disabled by default. Existing depth and lens-blur paths retain their behavior.
- Reuse the configured AI connector and ComfyUI instance with serialized workflow switching and a sampler-scoped memory budget for CPU offloading.
- Preserve 16-bit depth artifacts in masks, saved sessions and portable bundles; apply range changes without another inference. Guard desktop results against changed photos, geometry and discarded requests.
- Add a read-only depth-map viewer for saved built-in and Marigold masks, with a far-to-near legend and zoom controls. Previewing a map requires no new inference.
- Extend the MCP skill with explicit Marigold selection, saved-map review and shared-GPU recovery guidance. Add a [ComfyUI guide](docs/comfyui.md) with tested revisions and downloads for the five chosen connector workflows.

### MCP context efficiency

- Replace opaque image/model assets in tool and session-resource responses with read-only descriptors while preserving complete native state and preview bytes. Reject descriptors in edit requests to prevent incomplete recipe replacement.
- Add capability overviews and selected schema paths with schema identity and coordinate rules; retain full discovery for existing clients.
- Preserve job IDs, comparison labels, errors and export provenance in the skill client's summaries, support field selection on JSON resources, and document compact per-photo continuation checkpoints.

### Storage

- Use independent filesystem clones for MCP session sources, portable assets, background model snapshots, and local enhancement model imports on supported filesystems, with streaming/copy fallback elsewhere.
- Reuse checksum-verified model seeds across MCP workspaces through a host cache. Model files remain local to each workspace; corrupt cache entries fail validation.
- Disable development incremental compilation and debug symbols by default to reduce compiler-cache growth. Both remain available through Cargo profile overrides.
- Require 20 GiB free on the output volume before MCP native test harness and enhancement benchmark runs, with additional checks between large operations/cases; allow an explicit positive `RAPIDRAW_MIN_FREE_GIB` override.

### Desktop Nonlocal denoise

- Add Nonlocal to the desktop denoise modal's method selection (RAW sources only) with balanced quality, developed through the normal RAW pipeline with in-domain strength blending; NIND is relabeled "NIND (AI - Fast)" and Nonlocal appears as "Nonlocal (AI - Best for RAW)". The model bundle must already be installed (or `RAPIDRAW_NONLOCAL_BUNDLE` set); a missing bundle fails with `MODEL_NOT_INSTALLED` guidance. The Nonlocal backend modules (`raw_denoise`, `nonlocal_onnx`, `nonlocal_coreml`, `nonlocal_install`) are no longer gated behind the `mcp` Cargo feature, so standard desktop builds compile the new modal path.

### Retouch marker visibility

- Add a canvas toggle for clone/heal/liquify/retouch markers plus the active mask overlay in the AI (Inpainting) and Masking panels, plus an `H` shortcut (remappable in Settings → Keyboard shortcuts), so the area under a marker and its selection can be inspected without leaving the panel. Toggling back restores all overlays; per-edit eye toggles and rendering are unchanged.

### Fixed

- macOS packages now receive a complete ad-hoc bundle signature, preventing the invalid-signature “damaged” error caused by an executable-only linker signature. CI checks the complete bundle signature. A scoped library-loading entitlement preserves bundled ONNX Runtime and optional camera-library loading under the hardened runtime. These builds are still not notarized and may require approval in macOS Privacy & Security.
- Double-clicking empty custom title-bar space now toggles maximize/restore through the normal window state instead of entering fullscreen on macOS; single-press dragging and the close/minimize/green-button behavior are unchanged.

## 0.1.0-beta.1 — 2026-09-14

Release tag: `fork-v0.1.0-beta.1`. First whole-fork beta; native bridge `1.2.0` and Node MCP server package `0.1.0` retain separate component versions. See the [release notes](docs/releases/0.1.0-beta.1.md).

### Added

- [Local mask and detail enhancement](docs/local-enhancement.md) in the desktop AI panel and MCP: learned mask refinement, scene and face-part segmentation, experimental motion deblur and conservative 2× enlargement. Optional verified models, CPU/CUDA profiles, cancellation and independent restoration outputs preserve the editing source.

- Optional AI Connector generation settings on MCP `retouch`: an explicit seed, an advertised workflow profile and supported generation megapixels. Settings are saved with the reversible patch, and unsupported requests fail before image upload.
- Desktop AI workflow, resolution and seed controls, with saved patch settings, workflow refresh and explicit fallback for older connectors. Valid connector receipts show and retain the actual generation size and seed in both desktop and MCP edits.
- A configurable [Comfy Connector](ai-connector/README.md) with Klein 4B, closer-context Klein, Klein 9B KV and Boogu Edit Turbo profiles, immutable source caching and private generation receipts. Model weights are installed separately; CPU contract tests cover request handling without a GPU.
- [AI editing workflows](docs/ai-editing-workflows.md) for removal, recoloring, replacement, lettering and high-resolution delivery, with matching MCP skill guidance for profile discovery, reproducible alternatives and native-detail review.
- An [AI editing test report](docs/ai-editing-experiments.md) covering tested models, comparisons, timings and the resulting workflow choices.
- Clear standalone desktop and MCP entry points, an independent-project overview linking optional Lightweft and Insta360 workflows, and focused desktop/contribution guides. Setup, platform and skill guidance distinguish the public MCP contract from native implementation details.

- Opt-in Linux ONNX CUDA inference for foreground/sky masks, depth and AI denoise, with per-model memory limits, initialization-only automatic fallback and MCP provider diagnostics. Subject selection, local inpainting and unvalidated models retain CPU compatibility paths; these existing mask and denoise operations keep CPU as the default on all platforms. CUDA installation uses a separate GPU runtime. See the [CUDA setup and native regression guide](docs/mcp/onnx-cuda.md).
- Linux GPU server setup over SSH using Xvfb and offscreen Vulkan, with a tested Debian 13/NVIDIA configuration. The persistent inspection client accepts a stdio connection file and saves remote previews locally.
- Explicit `adjustment_keys` when saving workspace presets, so reusable looks can retain their LUT and rendered curves while leaving each photo's exposure, white balance and detail corrections intact. Selection validates native keys and required LUT/curve dependencies.
- Film-comparison skill guidance covering installed LUT discovery, explicit scene-referred processing for built-in films, and image-specific visual checks before recommending a look.

The MCP interface grows from 47 to 65 public tools: 60 native methods and five host worker methods. Tool names below omit the `rapidraw_` prefix.

| Addition                                                                                        | New tools                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Local learned masks and photographic reconstruction                                             | `enhancement_models`, `install_enhancement_model`, `enhance`                                                  |
| Independent editing copies, portable bundles, version differences and selective synchronization | `fork_session`, `export_session_bundle`, `import_session_bundle`, `diff_versions`, `copy_adjustments`         |
| Coordinate conversion, resource checks and regional color/white-balance diagnostics             | `map_coordinates`, `preflight`, `sample_region`                                                               |
| Owned workspace preset and LUT libraries                                                        | `manage_presets`, `manage_luts`                                                                               |
| Isolated background operations with durable status, cancellation and explicit resume            | `start_operation`, `get_operation_job`, `list_operation_jobs`, `cancel_operation_job`, `resume_operation_job` |

- Matched photograph, overlay and grayscale mask previews, selection bounds/statistics, and atomic submask add/edit/remove/duplicate/reorder operations.
- Include/exclude point prompts and in-place AI-subject refinement, with retained mask IDs and edits, revision guards, saved native logits, explicit approximate legacy-mask seeds, and captured worker support.
- Dedicated clipping previews and an exact encoded-preview cache with revision/settings/source invalidation.
- Portable sessions containing their required sources, LUTs, masks, patches, history and saved versions; integrity checks and recovery from interrupted imports.
- Background export, merge, negative conversion, mask/depth generation and local retouch using captured inputs, settings and verified model assets.
- Native rendering beyond the GPU's single-texture dimension limit, with bounded processing tiles and a documented 100-megapixel limit.
- Explicit sRGB profile policy for supported exports and independent profile/codec verification.
- Native coverage inventories, photographic fixture/review runners, RAW cache timing, setup checks and portable evidence-contract CI.
- Schema-aware evidence attribution and requirement grouping, explicit derived-state evidence, focused rendering oracles, and photographic point-refinement/panorama regression runners.
- Fresh-mask native-edge and real automatic lens-profile runners, with immutable first-attempt artifacts, explicit photographic criteria and independent calibration expectations.
- Guided masking instructions for choosing an AI or manual starting selection, painting named additive/subtractive corrections, and judging the actual local adjustment at overview and native detail.
- A photographic guided-mask regression runner covering preserved AI baselines, brush corrections, an independent manual mask, selected/protected-region effects, history and exact saved-state/rendering checks.
- Spherical-photo skill guidance for preserving full-sphere geometry, reviewing longitude seams and poles, editing an independently selected flat view, and checking final projection metadata and colour assumptions.

### Changed

- Fork packages install as RapidRAW MCP with independent preferences and model storage. App update notifications follow fork tags, including later prereleases for beta installations.
- Release packaging includes the native MCP bridge, checks the tagged version, and uploads to a draft before publication. Windows packages use NSIS; Apple Silicon packages declare macOS 14+.
- Frontend CI uses Node 22, and packaged builds install locked frontend dependencies.

- Generation result details consistently show generated and placement dimensions. New receipts omit experimental tile metadata; previously saved receipts remain compatible.
- Apple Silicon builds bundle the official ONNX Runtime 1.30.0 library, verified archive and file hashes, and license notices. These builds require macOS 14 or later. Intel Mac builds retain 1.22.0; existing CoreML model restrictions remain in place.
- Apple Silicon LaMa sessions use targeted CPU settings to reduce a 1.30.0 inpainting slowdown. Large repairs remain slower in the tested comparison, and newly generated SAM selections can differ, including additional landscape spill. See the [runtime compatibility notes](docs/local-enhancement.md#apple-silicon-runtime); saved masks are preserved.

### Fixed

- Frontend type and lint checks now cover concrete editor, mask, library, settings and native-response contracts. Clipboard actions tolerate settings that have not loaded, partial metadata refreshes preserve omitted lens values, and legacy masks receive missing defaults without replacing saved values.
- Dragging a new submask into the mask list preserves its insertion position and additive mode. Frontend state regressions, strict type checks, warning-free lint, formatting and translation synchronization are required by the frontend CI job.
- Completed missing translations for AI workflow settings, guide and mask fade controls, view labels and plural forms across supported interface languages.
- Desktop-only builds include the color-profile dependency required by local enhancement exports. The MCP bridge remains optional.
- Closing an MCP session clears the patched preview cache introduced by upstream crop and transform updates.
- Consecutive AI Connector edits now refresh the cached source when earlier retouching changes its pixels, while identical source images can reuse the cache.
- AI Connector crop responses outside the photo canvas are rejected before compositing. Stored generation receipts retain only validated dimensions, settings and duration.
- AI Connector status now verifies backend connectivity and rejects HTTP errors, invalid responses and stalled requests.
- Linux local inpainting rejects nonfinite ONNX output before converting it to pixels. The bundled FP16 LaMa model remains on CPU after CUDA compatibility checks found invalid output at the supported maximum input size.
- Desktop preset strength now blends from the captured pre-preset edit and restores that edit at zero strength. Partial presets preserve omitted exposure, white balance and detail controls; both desktop and MCP preset application fade a newly added LUT from zero effective strength.
- Linear DNG files with constant repeated black-level grids could render almost entirely white. Equivalent spatial repeats now normalize to per-channel black levels before RAW development.
- Incorrect ICC adaptation/tag layout and export profile labeling.
- Invalid JPEG XL output for affected image dimensions/alpha paths. Lossless and transparent compatibility cases use a verified encoder; a transparent fallback reports its quality/file-size tradeoff.
- Extreme-aspect export resizing that could return the wrong requested dimension or a zero-sized companion axis.
- Local-only flare and large/tall-image effect seams caused by tile coordinates or insufficient overlap.
- Mask review responses exceeding common MCP client buffers. Display color previews now consistently use 8-bit encoding; an 8 MiB response budget returns actionable recovery data without silently resizing images or replaying completed mutations. Native processing and high-precision exports retain their precision.
- Worker model/input portability and interrupted session import handling.
- A completed operation could briefly reject the next start as busy while native teardown was still running; subsequent start/resume now waits for that completed worker to close.
- Signed SAM prior conversion, retouch-aware point inference, legacy morphology preservation and stale submask-placement guards.
- Zero-strength and neutral-profile lens correction no longer resamples identity images or changes their border pixels/bit depth; zero strength also matches disabled correction alongside other geometry.
- Saved subject-refinement dimensions encoded as floating JSON values return validation errors instead of terminating the native worker.
- Panorama matching retries low-contrast detection thumbnails with normalized feature detection when the original match graph is disconnected. MCP merges require every input to connect, avoiding a partial panorama whose provenance incorrectly lists excluded inputs.
- Wide panoramas use a central frame as the reference and reject transforms that cross the projection plane before allocating a stitched canvas.
- Lens calibration uses a valid EXIF f-number before the logarithmic aperture fallback, so automatic vignette selection and explicit MCP aperture overrides use the intended aperture.
- Fresh-mask evidence capture explicitly requests full adjustment state; summary-only responses cannot silently stand in for editable-state evidence.

### Verification and limits

The earlier macOS/Metal acceptance run exercised all 62 tools through real MCP, with 1,490 calls and 202 explicit checks. Separate focused builds passed 665 rendering/refinement calls and 40 panorama calls. Lens correction passed 125 native library tests (including Metal) and 67 real lens-profile MCP calls with nine checks. Guided masking reuses that native build and passes 118 MCP calls with 12 checks; the protocol/worker/evidence suite passes 103 tests. See the verification record for each build boundary.

Fresh mask testing records three automatic selections, 53 successful native calls and 37 native-region triplets. All three fail strict full-matte criteria because of hair/claw omissions, unwanted-object spill, filled gaps or coarse sky boundaries. Those limits do not establish that the selections are unusable for restrained local edits. Point prompts improve the tested tail/twig regions; guided brush repairs and actual-grade comparisons address whether a selection is sufficient for the requested edit. The genuine panorama still needs projection/framing improvements, and the real lens photograph retains residual colour fringing; passing execution checks do not imply complete photographic quality.

On the guided bird regression, named AI review finds an AI-plus-brush whole-bird lift and an independent manual breast lift useful, while retaining painted-edge limits. Selected breast pixels change, the protected perch probe remains exact, and both edited sessions retain state and rendered pixels after history changes and restart. This does not approve a complete extraction matte or every photograph.

See the [historical application/MCP capability snapshot](docs/mcp/history/capability-matrix-2026-09.md), [historical verification record](docs/mcp/history/verification-2026-09.md) and [reproducible test instructions](docs/mcp/testing.md). The [Linux SSH guide](docs/mcp/remote-ssh.md) and [ONNX CUDA guide](docs/mcp/onnx-cuda.md) describe the tested Debian/NVIDIA configuration and model-specific boundaries. Other Linux configurations, Windows native acceptance, release packaging, configured remote providers and genuine HDR/focus/negative-film fixtures remain unverified.

## 2026-09-12 — comparison reviews and recoverable denoise

Native bridge 1.1.0 exposed 47 tools.

- Added temporary matched edit comparisons and exposure/adjustment diagnostics.
- Added durable named edit versions and restoration beyond the bounded undo history.
- Added background AI/BM3D denoise with captured inputs, progress, cancellation, restart recovery and explicit resume.
- Added smooth/asymmetric gradient fades in native masks and desktop mask controls.
- Extended the execution skill and file-backed MCP client for reliable image/result capture, error handling and timeout control.
- Expanded native/protocol acceptance for comparisons, masking and denoise jobs.

## 2026-09-11 — fork build configuration

- Disabled Android build jobs in this fork's CI. This does not remove Android support from upstream RapidRAW.

## 2026-09-10 — initial native MCP integration

Native bridge 1.0.0 introduced the optional MCP editing workflow.

- Added an official-SDK stdio server and optional native bridge, enabled with the `mcp` Cargo feature, while retaining the ordinary application and export CLI entry points.
- Exposed RAW development, global/local adjustments, AI masks, depth, retouch, denoise, lens correction, merging, negative conversion, metadata, presets/LUTs and exports through the existing native engine.
- Added isolated working copies, source/sidecar preservation, strict schemas, revision checks, atomic session history, recipes, undo/redo and protected export destinations.
- Added float32 processing with high-precision readback/export and preservation of RAW interpretation in derived denoise sessions.
- Added the optional photo-editing execution skill, setup/integration documentation, and protocol/native CI checks.
- Fixed the four-point panorama homography nullspace calculation and added mathematical regressions.
