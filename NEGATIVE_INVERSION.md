# Negative Inversion

In-editor, non-destructive color negative inversion. Lives as its own right-panel pane (Film icon) and renders inside the existing GPU adjustment pipeline so all downstream tools — Basic, Color, Curves, Effects — apply to the inverted positive.

Inspired by [NegPy](https://github.com/marcinz606/NegPy) by marcinz606 (GPL-3.0). Adapted from NegPy's density-space pipeline into our linear-light shader.

## How to use

1. Open a scanned negative.
2. Switch to the **Negative** pane (Film icon in the right-panel switcher).
3. Toggle **Enable negative inversion**. On first enable for a given image with default bounds, an auto-analysis runs.
4. (Optional) **Auto-Analyze Bounds** at any time to re-derive per-channel min/max log-density from the current scan. The analysis applies upstream transformations (crop, rotation, lens correction) first, so scanner borders outside the crop don't pollute the result.
5. Tweak look knobs:
   - **Dynamic Range** — Black Clip / White Clip: shift the analyzed bounds inward (clip extremes, more contrast) or outward (recover headroom).
   - **Print Grade** — Exposure / Contrast: pivot and slope of the print sigmoid (analogous to enlarger exposure + paper grade).
   - **Curve Shape** — Toe / Shoulder (+ widths): sigmoid-masked local lifts/compressions in the shadow and highlight regions, giving a film-like rolloff.
6. Compose on top with Basic, Color, Curves, etc. as usual.

Bounds are per-image (specific to the scan) and are stripped from presets at save time. The look knobs (weights, exposure, contrast, toe/shoulder, clips) are preserved in presets.

## Pipeline overview

The inversion runs as the first stage in `apply_negative_inversion` (in `src-tauri/src/shaders/shader.wgsl`), before any other adjustment touches the image:

```
linear_rgb
  → log-density       (Beer-Lambert: D = -log10(T))
  → per-channel normalize against analyzed [mins, maxs] bounds
  → apply per-channel weights
  → print sigmoid (with toe/shoulder masks + slope damping)
  → renormalize to (0,0)–(1,1)
  → linear positive RGB → rest of editor pipeline
```

## Math

### 1. Linear → log-density

```wgsl
let log_rgb = -log(max(rgb_linear, 1e-6)) / log(10.0);
```

**Background: Beer-Lambert and optical density.** When monochromatic light passes through an absorbing medium, the fraction transmitted falls off exponentially with the amount of absorber in the path: `T = I/I_0 = 10^(-εcl)` where `ε` is the absorber's molar absorptivity, `c` its concentration, and `l` the path length. This is the **Beer-Lambert law**, originally formulated for chemical spectroscopy in the 1800s. For photographic film the absorbers are the developed dye clouds (color film) or silver grains (B&W); they sit in a thin emulsion layer of roughly uniform depth, so for our purposes `T = 10^(-D)` where `D` (optical density) bundles all the constants together. `D` is what densitometers actually report.

**Why log instead of linear?** Two big reasons:
1. **Density is additive.** Stack two filters of densities `D1` and `D2` and the combined density is `D1 + D2` — because their transmittances multiply (`T = T1·T2`), and the log of a product is a sum. This makes density the right unit any time you're composing optical layers (negative + paper + enlarger filtration).
2. **Film is approximately linear in *log-exposure*.** The classic **Hurter-Driffield (H&D) curve** plots developed density on the Y axis against the *logarithm* of exposure on the X axis. In its central straight-line region the slope (called **gamma**, `γ`) is roughly constant, so a one-stop exposure change produces a uniform density change. Inverting back into linear light loses that structure; working in log space keeps it. Human brightness perception is also roughly logarithmic (Weber-Fechner), so density coordinates are perceptually closer to "uniform tone steps" than linear light is.

The `max(..., 1e-6)` floor prevents `log(0) = -∞` blowups on pure-black pixels (rare in real scans, but possible after upstream adjustments).

### 2. Per-channel bound normalization

```wgsl
let adj_mins = mins + black_clip * raw_range;
let adj_maxs = maxs - white_clip * raw_range;
let range    = max(adj_maxs - adj_mins, 1e-4);
let n = clamp((log_rgb - adj_mins) / range, 0.0, 1.0) * weights;
```

**Why per-channel bounds.** Color negative film has three dye layers (cyan, magenta, yellow) and an **orange mask** baked into the base to correct cross-contamination between them. The result is that the three channels of a scan don't span the same range — red is typically the densest (suppressed most by the orange mask), blue the least. If you normalized them uniformly you'd preserve the orange cast forever; normalizing each channel against its own analyzed `[min, max]` is the simplest unbiased way to neutralize that cast and recover something close to a balanced positive. NegPy and most film-inversion tools do the same.

**Sign convention.** Linear light `→` log via `-log`, so:
- Thin film (high transmittance, bright on the scan) → small `log_rgb` → small `n` → output **shadow** after the sigmoid.
- Dense film (low transmittance, dark on the scan) → large `log_rgb` → large `n` → output **highlight**.

So `mins` is the output-shadow end and `maxs` the output-highlight end. "Black Clip" pushing `mins` up clips near-shadow detail; "White Clip" pushing `maxs` down clips near-highlight detail.

**Black/White Clip.** `-0.5..0.5` each (default `0`). Positive shrinks the analyzed range inward (more contrast, more clipping); negative widens it outward (more headroom, recovers detail formerly clipped by overconfident auto-analysis).

**Weights** (Red/Green/Blue, `0.5..2.0`, default `1`). Multiplicative scalars on each channel's normalized log-density. Since `n` then feeds the sigmoid's input position, weighting effectively *shifts where in the sigmoid each channel sits* — lower weight pulls a channel toward the toe and dims its contribution to the output. Important: they are **amplitude / sensitivity** controls, not color-cast neutralizers. The cast is already neutralized by the per-channel bound stretch above; touch weights to tune color *response*, not to balance white.

### 3. Print sigmoid

```
s(n) = 1 / (1 + exp(-k · (n - x0)))
```

**Background: paper as a transfer function.** Photographic paper has its own H&D curve, also sigmoidal: a flat toe (no response until enough light hits it), a roughly straight middle (where most of the image lives), and a flat shoulder (saturated black, can't get darker). When you print a negative, you're convolving two H&D curves — the negative's response, then the paper's response — and the paper's sigmoid is what gives prints their characteristic tonality. Different papers come in **grades** (#0 softest through #5 hardest); higher grade = steeper sigmoid = punchier contrast, less tolerance for exposure error. Variable-contrast (VC) papers achieve the same gradation by changing the color of the enlarger light through filters.

**Why the logistic specifically.** The **logistic function** `σ(x) = 1/(1 + e^(-x))` is the canonical sigmoid: smooth, monotonic, asymptotic to 0 and 1, symmetric around `x = 0`, and analytically tractable. It isn't a literal model of paper response (real H&D curves have asymmetric toe and shoulder, which is what step 4 adds back in), but it captures the dominant S-shape with just two intuitive knobs: pivot and slope.

**Slope: `k = 4 · contrast`.** The derivative `σ'(x) = σ(x)·(1 - σ(x))` peaks at `x = 0` with value `1/4`. So for a logistic stretched by `k` (i.e., `σ(kx)`), the slope at the pivot is `k/4`. Picking `k = 4 · contrast` makes `contrast = 1` correspond to a **unit slope at the midpoint** — a sigmoid that passes naturally through the corners of the (0,0)–(1,1) box after renormalization. Bumping contrast steepens the curve toward print-paper grades #3–#5; lowering it softens it toward grade #1.

**Pivot: `x0 = 0.6 - exposure · 0.25`.** Horizontal shifts of the sigmoid are exposure changes — in darkroom terms, longer enlarger exposure burns deeper into the negative, sliding the response curve along the log-exposure axis. We bias the default pivot slightly above the geometric mid (0.6 instead of 0.5) because the perceptual midpoint of an inverted scan tends to land high without the bias; the **Exposure** slider then nudges it ±0.5 (the `0.25` × ±2 range).

Sliders: **Exposure** (`-2..2`, default `0`), **Contrast** (`0.5..2.5`, default `1`).

### 4. Toe and shoulder

Real film and paper don't have a pure logistic response — they have **asymmetric rolloff** at the extremes, with a softer compression in the toe (shadows) and shoulder (highlights) regions. This is what gives film prints their distinctive look: shadows that hold detail down to near-black without crushing, highlights that roll off gracefully into white instead of clipping flat.

NegPy reconstructs this with **sigmoidal masks** — using a second pair of sigmoids to *spatially* select the toe and shoulder regions of the curve, then locally lifting/compressing and dampening the slope there. We adopt the same construction:

```wgsl
let diff = n - x0;
let toe_mask      = sigmoid(toe_width      · (-diff / x0           - 0.5));
let shoulder_mask = sigmoid(shoulder_width · ( diff / (1.0 - x0)   - 0.5));

let diff_adj = diff + toe · toe_mask · 0.25 - shoulder · shoulder_mask · 0.25;
let damp     = toe · toe_mask · 0.5 + shoulder · shoulder_mask · 0.5;
let k_mod    = clamp(vec3(1.0) - damp, vec3(0.1), vec3(2.0));

let arg = k · diff_adj · k_mod;
```

**Reading the masks.** Each mask is itself a logistic that turns "on" (output near 1) in one region of `diff = n - x0` and "off" (near 0) in the other. The toe mask is active where `diff` is sufficiently negative (shadow side, `n < x0`); the shoulder mask is active where `diff` is sufficiently positive (highlight side). The `0.5` shift inside each mask sigmoid places its transition zone at the **quarter-point** of its half of the curve (so for `x0 = 0.6`, toe ramps in around `diff = -0.3`, i.e., `n = 0.3`). The `width` sliders control the steepness of the transition: bigger width = sharper boundary, smaller width = more gradual blend.

**What the masks do.** Inside the active region:
1. **Offset (`± 0.25 · slider · mask`)** — shifts `diff` toward or away from the pivot. Positive **Toe** pushes `diff` up (less negative) → less curve depth in the shadows → blacks lift. Positive **Shoulder** pushes `diff` down → less curve height in highlights → whites compress. Negative values do the opposite (crush blacks / harden whites).
2. **Slope damp (`k_mod`)** — reduces the effective gamma `k` *only* where a mask is active. This is what makes the lift/compression feel like a real H&D rolloff instead of just a brightness offset: the local contrast drops along with the local tone shift. The `clamp(..., 0.1, 2.0)` keeps `k_mod` from going non-positive (which would invert the curve) when both sliders are pushed hard.

The constants `0.25` (offset magnitude) and `0.5` (damp magnitude) come straight from NegPy and we adopt them verbatim — they're empirically tuned to give the sliders a useful working range without making the effect dominate.

**Sign-flip from NegPy.** NegPy works in density space throughout — its sigmoid output is a *density*, so high values are output shadows. Our shader works in linear light — the same sigmoid output is a *brightness*, so high values are output highlights. The polarity of `n` itself is the same in both (`n` close to 1 means dense film), but the mask polarities and offset signs are flipped here so toe still lifts shadows and shoulder still compresses highlights as a user expects.

Sliders: **Toe** / **Shoulder** (`-1..1`, default `0`), **Toe Width** / **Shoulder Width** (`0.5..5`, default `2.5`).

### 5. Endpoint renormalization

```wgsl
let y0 = 1.0 / (1.0 + exp(k · x0));
let y1 = 1.0 / (1.0 + exp(-k · (1.0 - x0)));
return clamp((s - y0) / (y1 - y0), 0.0, 1.0);
```

A logistic is asymptotic — it approaches but never reaches 0 and 1. Plugging `n = 0` and `n = 1` into the bare sigmoid gives values `y0` and `y1` somewhere inside `(0, 1)`, which means a naive output would have lifted blacks and crushed whites. The renormalization is an affine remap so that `n = 0 → 0` and `n = 1 → 1` for the **un-toe/shouldered** case.

`y0` and `y1` are computed off the bare `σ(k·(n - x0))` evaluated at `n = 0` and `n = 1`. With strong toe/shoulder the *actual* curve no longer hits exactly those endpoints (because the masks modulate `diff` and `k`), so blacks may lift slightly and whites may not fully clip — accepted as a PoC-level tradeoff. NegPy avoids this by routing through density → transmittance instead of renormalizing the sigmoid directly; we don't, partly because the downstream editor (Basic, Curves) can recover the endpoints if needed, and partly because the visual difference is small at typical slider values.

## Bounds analysis

The **Auto-Analyze Bounds** button calls the Tauri command `analyze_negative_bounds` (in `src-tauri/src/negative_conversion.rs`):

1. Load the full-resolution image.
2. Apply all upstream transformations (`crate::adjustment_utils::apply_all_transformations`) so the cropped/oriented/lens-corrected view is what gets analyzed — scanner edges outside the crop don't contribute.
3. Downscale to ~1080p for speed.
4. Per channel, compute `log10(1/T)` and take min/max.
5. Return 6 floats `[redMin, redMax, greenMin, greenMax, blueMin, blueMax]`.

The result is written into the `NegativeAdjustment` block in editor state. It auto-fires the first time the user enables inversion on a fresh image (i.e., when bounds are still at their identity defaults), so the common case is one-click.

## Data flow

- **TS interface**: `NegativeAdjustment` in `src/utils/adjustments.ts` (enabled flag, 6 bounds, 3 weights, exposure, contrast, toe/shoulder + widths, black/white clip).
- **Rust uniform**: `GlobalAdjustments.negative_*` fields in `src-tauri/src/image_processing.rs`; JSON parsed in `get_global_adjustments_from_json`.
- **WGSL struct**: matching layout in `src-tauri/src/shaders/shader.wgsl`. Sized so the trailing block is a multiple of 16 bytes to satisfy the std140-ish alignment of the surrounding `GlobalAdjustments` struct (a `mat3x3` member forces 16-byte alignment).
- **Shader entry**: `apply_negative_inversion(rgb_linear) -> vec3<f32>`, invoked early in the main pipeline when `negative_enabled == 1u`.
- **UI**: `src/components/panel/right/NegativePanel.tsx` — pulls adjustments + setter from the editor store; rendered when `Panel.Negative` is the active right-panel.

## Presets

Per-image bounds (the 6 floats from analysis) are scan-specific and don't transfer. The preset save path in `src/hooks/usePresets.ts` strips them via `stripNegativeBounds` (`src/utils/adjustments.ts`); the apply path in `PresetsPanel.tsx` deep-merges the incoming `negative` block over the current image's `negative`, preserving its bounds. Everything else — enable flag, weights, exposure, contrast, toe/shoulder + widths, black/white clip — round-trips normally.

## Attribution

The inversion math (log-space normalization, sigmoidal print, toe/shoulder masks, the `0.25`/`0.5` magic numbers) is adapted from [NegPy](https://github.com/marcinz606/NegPy) by marcinz606, licensed under [GPL-3.0](https://github.com/marcinz606/NegPy/blob/main/LICENSE). The adaptation translates NegPy's density-space outputs into our linear-light shader path (sign-flipping the toe/shoulder masks and offsets accordingly) and replaces NegPy's density→transmittance step with an in-shader sigmoid renormalization.

## Further reading

If you want to dig deeper into any layer of the math, these are the topics worth searching for (Wikipedia is fine for all of them — they're standard, well-covered subjects):

**Film & densitometry:**
- **Beer-Lambert law** — the exponential transmittance relationship that motivates working in density space at all.
- **Optical density** — what densitometers measure, and how `D` relates to `T`.
- **Hurter-Driffield curve** (also "characteristic curve" or "sensitometric curve") — the canonical density-vs-log-exposure plot for film and paper, including the toe / straight-line / shoulder regions and how slope (gamma) defines contrast.
- **Sensitometry** — the broader field; useful for understanding how film stocks are characterized and how the H&D curve maps onto real exposure decisions.
- **Photographic paper grades and variable-contrast paper** — direct background for the contrast slider and toe/shoulder controls.
- **Color negative film and the orange mask** — explains why per-channel bound normalization works and what cast it's neutralizing.

**Sigmoid / logistic math:**
- **Logistic function** — algebraic properties, derivative `σ'(x) = σ(x)(1 - σ(x))`, why slope at midpoint is `k/4` when stretched by `k`. This is the property that makes `k = 4 · contrast` give a unit-slope sigmoid at default.
- **Sigmoid function** (general) — for context on why this family of curves shows up everywhere from neural activations to dose-response models. The logistic is one of several; the choice here is for tractability, not biological accuracy.

**Perception (optional but useful intuition):**
- **Weber-Fechner law** and **Stevens's power law** — why log-density coordinates feel more perceptually uniform than linear light, and why the editor pipeline does most of its tonal work in log-ish spaces.

**The reference implementation:**
- **NegPy** — [github.com/marcinz606/NegPy](https://github.com/marcinz606/NegPy). The `docs/PIPELINE.md` in that repo walks through the same pipeline from the density-space perspective; useful for cross-checking sign conventions when reading our adapted version. The `negpy/features/exposure/logic.py` file (`_apply_photometric_fused_kernel`) is the direct source for our toe/shoulder block and the `0.25` / `0.5` constants.

## Out of scope (for now)

- Per-channel toe/shoulder (NegPy supports this; we apply uniformly across R/G/B).
- B&W and E-6 reversal modes.
- Eyedropper white balance (incompatible with our GPU acceleration model).
- Batch / rolling bounds analysis across a whole film roll.
- Migration of stale `dynamicRangeClip` values from older test presets to the new Black/White Clip pair.
