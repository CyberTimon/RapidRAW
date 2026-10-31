# Alt preview: complete control inventory

This lists the controls actually wired to Alt preview, including their UI scope.
Hold Alt before starting a drag, or press it during a drag. Releasing Alt or ending
the drag restores the photograph. No preview checkbox or menu is required.
Shift retains fine adjustment for sliders and curve anchors. Wheels retain their
existing angular/radial modifier behaviour. Ctrl+Alt/AltGr does not activate preview.

## How to read the preview

- **Tone:** the edited greyscale pixels inside the affected region; black outside.
  Darkening looks darker and lightening looks lighter. Global Exposure/Brightness/Contrast use the whole image as coverage, for a consistent greyscale editing view. Target coverage remains
  visible at neutral when it has potential influence.
- **Colour:** the edited RGB pixels inside the affected region; black outside.
  Hue, saturation and luminance follow the actual result.
- **Difference:** a greyscale map of the selected effect's change from its reference.
  Brighter means more change, not a brighter photograph. Moving away from the
  reference in either direction can brighten this map.
- **Coverage:** the effect's reach or falloff. Brighter means greater coverage;
  shape and position changes move or reshape that region.

"Both" means the ordinary adjustment panel and mask adjustment sections, wherever
the existing control is available and enabled. Masked previews are restricted to
the composed adjustment mask, including its opacity and soft edges. The four Basic
tonal controls and curve response probes share their global implementation, with
one additional mask filter. HSL and grading use their existing mask-aware selection
weights. Difference previews measure the actual masked effect.

## Tone and colour controls

| Control                                                          | Scope                                 | Preview and response to dragging                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Highlights                                                       | Both                                  | Tone, restricted to highlight response. Increasing raises the affected highlights; decreasing lowers them.                                                          |
| Shadows                                                          | Both                                  | Tone, restricted to shadow response. Increasing lifts affected shadows; decreasing darkens them.                                                                    |
| Whites                                                           | Both                                  | Tone, restricted to white-end response. Increasing raises the white end; decreasing lowers it.                                                                      |
| Blacks                                                           | Both                                  | Tone, restricted to black-end response. Increasing lifts the black end; decreasing darkens it.                                                                      |
| Exposure                                                         | Both                                  | Tone across the image, or through the mask. Increasing brightens; decreasing darkens.                                                                               |
| Brightness                                                       | Both                                  | Tone across the image, or through the mask. Increasing brightens; decreasing darkens.                                                                               |
| Contrast                                                         | Both                                  | Tone across the image, or through the mask. Increasing separates light/dark tones; decreasing flattens contrast. Different pixels can move in different directions. |
| Hue                                                              | Both                                  | Colour across the image, or through the mask. Dragging rotates the resulting hue in either direction.                                                               |
| Saturation                                                       | Both                                  | Colour across the image, or through the mask. Increasing adds saturation; decreasing moves towards grey.                                                            |
| Vibrance                                                         | Both                                  | Colour across the image, or through the mask. Increasing boosts the renderer's selectively weighted colour response; decreasing reduces it.                         |
| Colour Mixer: Hue                                                | Both, each of the eight bands below   | Colour, limited to the selected source-colour band. Dragging shows the resulting hue.                                                                               |
| Colour Mixer: Saturation                                         | Both, each band                       | Colour. Increasing saturates selected pixels; decreasing desaturates them.                                                                                          |
| Colour Mixer: Luminance                                          | Both, each band                       | Colour. Increasing lightens selected pixels; decreasing darkens them.                                                                                               |
| Monochrome Mix                                                   | Global, each band                     | Tone, isolated by the source-colour band. Increasing lightens that colour's monochrome contribution; decreasing darkens it.                                         |
| Grading wheel pointer                                            | Both, Shadows / Midtones / Highlights | Colour, isolated to that tonal region. Angular movement changes hue; outward movement increases saturation and inward movement reduces it.                          |
| Grading Hue slider                                               | Both, each of those three regions     | Colour. Rotates the resulting grading hue; a hue change at zero grading saturation correctly has no colour effect.                                                  |
| Grading Saturation slider                                        | Both, each region                     | Colour. Increasing strengthens the tint; decreasing weakens it.                                                                                                     |
| Grading Luminance slider (including the compact sun-icon slider) | Both, each region                     | Colour. Increasing raises the affected tones; decreasing lowers them.                                                                                               |

The eight Colour Mixer and Monochrome Mix bands are **Reds, Oranges, Yellows,
Greens, Aquas, Blues, Purples and Magentas**. All three Colour Mixer sliders are
supported for each band. Monochrome Mix has one mix slider per band.

## Curves

All of these apply to **Luma, Red, Green and Blue**, in both ordinary and mask
adjustments. Luma uses Tone presentation; Red/Green/Blue use Colour presentation.

| Control                                                          | Preview and response to dragging                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Point-curve anchors, including endpoints and newly added anchors | Isolates the response of the dragged anchor and the neighbouring interpolation. Up raises the output tone/channel; down lowers it. Horizontal movement changes the input-tone interval and the preview follows that interval.                                                |
| Parametric White Level                                           | Isolates its curve response. Increasing towards zero raises the white endpoint; decreasing lowers it.                                                                                                                                                                        |
| Parametric Highlights                                            | Increasing raises the highlight response; decreasing lowers it.                                                                                                                                                                                                              |
| Parametric Lights                                                | Increasing raises the lighter-tone response; decreasing lowers it.                                                                                                                                                                                                           |
| Parametric Darks                                                 | Increasing raises the darker-tone response; decreasing lowers it.                                                                                                                                                                                                            |
| Parametric Shadows                                               | Increasing raises the shadow response; decreasing lowers it.                                                                                                                                                                                                                 |
| Parametric split handles (all three)                             | Isolates the tonal neighbourhood of the dragged region boundary, including at neutral settings. Left/right moves that neighbourhood towards darker/lighter input tones. The preview shows the current edited tone or channel colour; a neutral curve itself stays unchanged. |
| Parametric Black Level                                           | Increasing raises the black endpoint; decreasing lowers it.                                                                                                                                                                                                                  |

The renderer supports up to sixteen point-curve anchors per channel. Tonal and
curve targeting uses fixed renderer-response probes: stable potential coverage,
not a claim of exact sensitivity at every current value. Point-anchor coverage
follows its input position while remaining independent of its dragged output value.

## Detail and creative effects

| Control             | Scope  | Preview and response                                                                                                                                                        |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sharpness amount    | Both   | Difference. Increasing adds sharpening; decreasing softens/reverses it according to the normal renderer. The map highlights changed edges.                                  |
| Clarity             | Both   | Difference. Increasing boosts local contrast; decreasing softens it. The map highlights changed structure.                                                                  |
| Structure           | Both   | Difference. Increasing enhances structure/detail; decreasing reduces it.                                                                                                    |
| Dehaze              | Both   | Difference. Increasing removes haze; decreasing adds it.                                                                                                                    |
| Centré              | Global | Tone, within its spatial response. Positive values emphasise the centre; negative values reverse that treatment. The actual centre/edge tones determine preview brightness. |
| Glow                | Both   | Difference. Increasing adds glow; decreasing reduces it towards its neutral reference.                                                                                      |
| Halation            | Both   | Difference. Increasing adds halation; decreasing reduces it.                                                                                                                |
| Light Flares        | Global | Difference. Increasing strengthens flares; decreasing reduces them.                                                                                                         |
| Lens Blur Amount    | Global | Difference against zero blur. Increasing adds blur in the selected depth region; decreasing reduces it.                                                                     |
| Lens Blur Diffusion | Global | Difference against zero diffusion. Increasing adds diffusion; decreasing reduces it.                                                                                        |

## Vignette

These controls are global.

| Control   | Preview and response                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Amount    | Tone within the falloff. Negative values darken it, positive values lighten it, and moving towards zero removes that tonal treatment. |
| Midpoint  | Coverage. Increasing pushes the falloff boundary outward, leaving a larger clear centre; decreasing brings it inward.                 |
| Roundness | Coverage. Moving either way reshapes the editor's vignette contour; the preview shows the resulting boundary.                         |
| Feather   | Coverage. Increasing widens/softens the transition; decreasing sharpens it. Zero shows a hard boundary.                               |

## Relight

All shared sliders and all per-light sliders below support Alt. Selecting a light
can leave its on-image picker armed; that no longer blocks a panel preview.

| Control                          | Preview and response                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambient                          | Tone across the image. Increasing raises ambient illumination; decreasing lowers it.                                                                                |
| Softness                         | Difference against the default softness. Increasing broadens/softens illumination; decreasing makes it more directional. Brighter map pixels show changed lighting. |
| Shine                            | Difference against zero shine. Increasing strengthens specular contributions; decreasing reduces them.                                                              |
| Shadow Softness                  | Difference against default shadow softness. Increasing softens shadow boundaries; decreasing sharpens them. Available when Shadows is enabled.                      |
| Selected light: Intensity        | Tone within that light's reach. Increasing strengthens illumination; decreasing weakens it.                                                                         |
| Selected light: Depth            | Coverage. Moves the light along the depth axis in either direction; the illuminated region follows it.                                                              |
| Selected light: Falloff (radius) | Coverage. A larger value extends reach; a smaller value contracts it.                                                                                               |
| Selected light: Angle            | Coverage. Rotates the light direction; the receiving surfaces change with it.                                                                                       |
| Selected light: Elevation        | Coverage. Tilts the light direction; the receiving surfaces change with it.                                                                                         |
| Selected light: Cone             | Coverage. Increasing widens a spot beam; decreasing narrows it.                                                                                                     |
| Selected light: Feather          | Coverage. Increasing softens the spot-beam boundary; decreasing sharpens it.                                                                                        |
| Selected light: Temperature      | Colour within its reach. Increasing warms the illumination; decreasing cools it.                                                                                    |
| Selected light: Tint             | Colour within its reach. Increasing shifts towards magenta; decreasing shifts towards green.                                                                        |

Intensity, Temperature and Tint are available for all light types. Depth and Falloff
apply to Point and Spot lights. Angle and Elevation apply to Spot and Directional
lights. Cone and Feather apply to Spot lights. A valid stored normal map is required;
Alt preview does not generate one.

## Atmospheric Fog

All eight sliders support Alt. A valid stored depth map is required.

| Control     | Preview and response                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amount      | Tone within the potential fog region. Increasing adds fog; decreasing reveals the clearer image. The tones follow actual scattering and scene colour, so fog need not brighten every pixel. Potential coverage remains visible at zero. |
| Start       | Coverage. Increasing pushes the start farther away; decreasing brings fog closer.                                                                                                                                                       |
| Density     | Coverage. Increasing builds fog more rapidly with distance; decreasing makes that build-up gentler.                                                                                                                                     |
| Height      | Coverage. Increasing concentrates fog nearer the bottom/ground; decreasing spreads it more vertically.                                                                                                                                  |
| Variation   | Coverage. Increasing produces patchier coverage; decreasing makes it more uniform.                                                                                                                                                      |
| Glow        | Difference against the default glow setting (25). Brighter pixels indicate a greater change from that reference in either direction.                                                                                                    |
| Temperature | Colour within fog coverage. Increasing warms it; decreasing cools it.                                                                                                                                                                   |
| Tint        | Colour within fog coverage. Increasing shifts it towards magenta; decreasing towards green.                                                                                                                                             |

## Controls without Alt preview

Luminance Noise Reduction, Color Noise Reduction, AI Denoise Amount and AI Denoise
Detail have **no Alt behaviour**, including in mask sections where present.

The following also retain their ordinary editing behaviour: White Balance Temperature/Tint;
Global grading wheel/sliders; grading Balance/Blending; colour calibration;
monochrome film/filter/toning controls; Sharpness Threshold; chromatic aberration;
negative-conversion controls; LUT intensity; Grain Amount/Size/Roughness;
crop/geometry; mask construction/opacity; stored
patch controls; on-image light/centre positioning handles; colour fields and
colour swatches. Selecting a band, channel or preset alone does not start preview.

Coverage can legitimately fill much of the image, and a slider can legitimately
make little visible difference when its prerequisite strength is zero, pixels are
clipped, or the effect produces the same result as its input. No fake brightness
boost or per-frame normalisation is added to make those cases appear responsive.
