# The RapidRAW sidecar format (`.rrdata`)

RapidRAW never modifies your source images. Every edit, rating and tag lives in a
plain JSON file beside the original, called a sidecar. Because third-party tools
already read and write these files, the format is treated as a public interface:
this document and [`schema/rrdata-v1.schema.json`](../schema/rrdata-v1.schema.json)
describe what a writer may rely on, and what it may not.

The machine-readable schema is the normative reference for field names, types and
ranges. This document covers the parts a schema cannot express: version
negotiation, what survives a round trip, and the merge rules presets depend on.

## File naming

| Situation                         | Sidecar                   |
| --------------------------------- | ------------------------- |
| `IMG_0001.ARW`                    | `IMG_0001.ARW.rrdata`     |
| Virtual copy `2` of the same file | `IMG_0001.ARW.2.rrdata`   |
| Quarantined sidecar (see below)   | `IMG_0001.ARW.rrdata.bak` |

Sidecars are UTF-8 encoded JSON. RapidRAW writes them pretty-printed, but any
valid JSON is accepted.

## The envelope

```json
{
  "version": 1,
  "rating": 4,
  "adjustments": { "exposure": 0.35 },
  "tags": ["color:green", "user:portfolio"],
  "exif": { "Model": "ILCE-7M3" }
}
```

| Field         | Required | Notes                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------- |
| `version`     | yes      | Schema version. See [Versioning](#versioning).                             |
| `rating`      | yes      | Integer `0`–`5`. `0` means unrated.                                        |
| `adjustments` | yes      | The edit, or `null` for an image that has never been edited.               |
| `tags`        | no       | Namespaced string list. See [Tags](#tags).                                 |
| `exif`        | no       | Cached EXIF string pairs. RapidRAW populates this; writers rarely need to. |

## Versioning

`version` is the negotiation anchor for the format. It has been written into
every sidecar RapidRAW has ever produced, always as `1`, so existing files on
disk already carry a usable marker and no migration is required.

A reader must compare `version` against the highest version it understands:

- **Equal or lower**: parse normally.
- **Higher**: the file was written by a newer RapidRAW. Do not parse it as if it
  were the version you know, and above all do not overwrite it.

RapidRAW itself implements the second case by _quarantining_: it copies the file
to `<name>.rrdata.bak`, logs a warning, and continues with defaults so that one
unreadable file cannot make an image uneditable. The same happens for a sidecar
that is not valid JSON or is missing a required field.

This matters because sidecar writes are read-modify-write. `load_sidecar`
supplies the base that the application mutates and writes back, so a file that
silently degraded to defaults would have the user's rating, tags and cached EXIF
destroyed by the very next save. The quarantine copy is what makes that
recoverable.

Quarantine never destroys data. If a backup already exists with different
contents, the next free slot is used (`.rrdata.bak.1`, `.rrdata.bak.2`, and so
on). If an identical backup already exists, nothing happens, so the repeated
loads performed by the thumbnail and metadata workers cannot pile up copies.

**Bumping the version.** Increment `SIDECAR_SCHEMA_VERSION`
(`src-tauri/src/image_processing.rs`) only for a change that an older build
cannot safely read. Adding a new optional adjustment key does not qualify:
unknown keys are preserved, so old and new builds interoperate without a bump.

## What survives a round trip

RapidRAW guarantees that loading a sidecar and saving it again preserves keys it
does not recognise, at two levels:

- **Inside `adjustments`**: the whole object is held as opaque JSON, so any
  structure you put there comes back unchanged.
- **At the envelope level**: unrecognised top-level keys are captured and
  re-emitted verbatim.

So a tool may annotate a sidecar with its own bookkeeping:

```json
{
  "version": 1,
  "rating": 3,
  "adjustments": { "exposure": 0.2, "myPipeline:sourceHash": "9f86d0…" },
  "producedBy": "my-culling-tool/1.4"
}
```

Both custom keys survive edits made in the GUI. This is covered by tests in
`src-tauri/src/exif_processing.rs`.

What is **not** guaranteed:

- **Key ordering.** RapidRAW re-serialises from its own structures.
- **Numeric formatting.** `0.50` may come back as `0.5`.
- **Long EXIF values.** Entries over 500 characters are truncated on load and the
  file is rewritten. This keeps sidecars small and is not a compatibility failure.
- **Sub-mask `parameters`.** Deliberately unconstrained in the schema. It is the
  least stable part of the format and is not covered by the v1 guarantee.

## Adjustments

Refer to the schema for the full field list, types and ranges. The traps below
are the ones that actually bite integrators.

### `centré` is spelled with an acute accent

The detail-centring key is literally `centré`, ending in U+00E9. The accented
spelling is historical, and it is load-bearing all the way through the renderer.
There is no ASCII alias: a writer emitting `centre` produces an unknown key,
which is preserved but ignored.

```json
{ "adjustments": { "centré": 15 } }
```

If your toolchain mangles non-ASCII keys, this is where it will show up.

### `hue` means two different things

Three differently-scaled hue values share the same name:

| Location                              | Range        | Meaning                            |
| ------------------------------------- | ------------ | ---------------------------------- |
| `adjustments.hue`                     | `-180`–`180` | Global hue rotation, in degrees    |
| `adjustments.hsl.<band>.hue`          | `-100`–`100` | Per-band shift in the colour mixer |
| `adjustments.colorGrading.<zone>.hue` | `0`–`360`    | Absolute wheel angle               |

The last two are the same TypeScript type but are not interchangeable.

### Asymmetric parametric curve levels

Within `parametricCurve.<channel>`, `whiteLevel` is `-100`–`0` and `blackLevel`
is `0`–`100`. This is not a transcription error; it matches the controls.

### Noise reduction differs inside masks

`lumaNoiseReduction` and `colorNoiseReduction` are `0`–`100` globally, but
`-100`–`100` inside a mask, because a mask can subtract noise reduction applied
globally. The schema models these as separate definitions.

### Presentation-only fields

`sectionVisibility` and `showClipping` record UI state. They live in the edit but
do not affect rendering, so a headless writer can ignore them.

## Tags

`tags` is a flat list with a prefix convention rather than nested structure:

| Prefix   | Meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| `color:` | Colour label. At most one; `red`, `yellow`, `green`, `blue` or `purple`. |
| `user:`  | User-authored tag.                                                       |
| _(none)_ | AI-generated tag from background indexing.                               |

```json
{ "tags": ["color:green", "user:portfolio", "landscape", "mountains"] }
```

Setting a colour label replaces any existing `color:` entry and leaves the rest
alone. Writers must preserve prefixes exactly, since RapidRAW filters on them.

## Presets and merge semantics

Presets are stored separately from sidecars, in `presets.json` under the
application config directory, not next to your images. They matter here because
applying one produces the `adjustments` object that lands in a sidecar, and the
merge rule is easy to get wrong.

### The two preset types

| `presetType` | What gets stored                                                          |
| ------------ | ------------------------------------------------------------------------- |
| `"tool"`     | Only keys whose value differs from the defaults, so the preset is sparse. |
| `"style"`    | Every copyable key, so the preset is complete.                            |

A `tool` preset is intended as a targeted adjustment ("add my sharpening"), a
`style` preset as a complete look.

### Applying is a single shallow merge

```js
setAdjustments((prev) => ({ ...prev, ...preset.adjustments }));
```

That is one spread, one level deep. The consequences:

- A key **absent** from the preset keeps the image's current value. This is why
  `tool` presets compose: they only name what they change.
- A key **present** in the preset replaces the current value **wholesale**.

The second point is the trap. There is no deep merge, so a preset containing
`hsl` replaces the entire object, all eight bands times three properties. If you
generate a preset intending only to shift the blues, you must still emit the
other seven bands, or they will be reset to whatever your partial object omits:

```json
// Resets all bands except blues. Almost never what you want.
{ "presetType": "tool", "adjustments": { "hsl": { "blues": { "hue": -12 } } } }
```

The same applies to every nested object: `curves`, `parametricCurve`,
`colorGrading`, `colorCalibration`, `crop` and `masks`.

Because the spread is over the image's current adjustments rather than over the
defaults, even a `style` preset does not reset keys it does not carry, such as
geometry keys when the preset was saved without crop and transform included.

## Validating your output

```bash
npx ajv-cli validate -s schema/rrdata-v1.schema.json -d path/to/IMG_0001.ARW.rrdata
```

The schema is intentionally permissive about unknown keys (`additionalProperties`
is `true`) because rejecting them would contradict the preservation guarantee
above. It is strict about the keys it does know, so a mistyped value or an
out-of-range number is caught while a forward-compatible addition is not.

Worked examples live in [`schema/examples/`](../schema/examples/); CI validates
them against the schema on every run.

## Keeping this in sync

`npm run schema:check` fails if the schema and the TypeScript defaults in
`src/utils/adjustments.ts` disagree about which adjustment keys exist, so adding
a slider without describing it is a CI failure rather than silent rot. Run it
after touching either file.
