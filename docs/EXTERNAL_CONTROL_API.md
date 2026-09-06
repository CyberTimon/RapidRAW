# RapidRAW External Control API

Protocol version **1**. Lets a hardware controller (the MX Creative Console plugin, a MIDI
bridge, a test script) drive RapidRAW's develop sliders live and fire editor actions.

## Transport

* TCP, **loopback only**: `127.0.0.1:47820` by default.
* Newline-delimited JSON (one UTF-8 JSON object per `\n`-terminated line), both directions.
* Any number of clients may connect. Every client receives every outbound message.
* No authentication: the socket is bound to loopback, which is the trust boundary.

Configuration, in RapidRAW's `settings.json` (both optional):

```json
{ "enableExternalControl": true, "externalControlPort": 47820 }
```

`RAPIDRAW_CONTROL_PORT=<n>` in the environment overrides the port. If the port cannot be
bound, RapidRAW logs a warning and runs normally without the server.

## Session start

On connect the server sends a greeting and, if it has one, the most recent state snapshot:

```json
{"type":"hello","app":"RapidRAW","version":"1.6.3","protocol":1}
{"type":"state", ...}
```

`ping` is answered by the Rust server even before the UI is up; everything else is handled
by the editor UI, so expect no replies until the main window has loaded.

## Requests (client → RapidRAW)

Every request may carry a `ref` (any JSON value). Replies that answer a specific request
echo it back, so a client can correlate. Messages without `ref` get anonymous replies.
(`action` uses `id` for the action name; `ref` is separate.)

| `type`        | fields                                 | effect                                                                                                                    |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `set`         | `param`, `value`                       | Set a parameter to an absolute value. Snapped to the parameter's step and clamped to its range.                          |
| `adjust`      | `param`, `delta`                       | Add `delta` (in parameter units) to the current value.                                                                    |
| `step`        | `param`, `ticks` (default 1), `multiplier` (default 1) | Add `ticks × step × multiplier`. Meant for dials: one detent = one tick; use `multiplier` for a fine/coarse modifier. |
| `reset`       | `param`                                | Return the parameter to its default.                                                                                       |
| `tracking`    | `active` (bool)                        | Explicitly begin/end "dial is being turned" mode (see below). Optional.                                                    |
| `action`      | `id`                                   | Fire a named editor action (see list below). Same code path as the keyboard shortcut.                                     |
| `get_state`   | —                                      | Reply with a `state` snapshot.                                                                                             |
| `get_params`  | —                                      | Reply with the parameter table: `{"type":"params","params":[{id,group,min,max,step,default},…]}`.                        |
| `get_actions` | —                                      | Reply with `{"type":"actions","actions":["undo","redo",…]}`.                                                              |
| `ping`        | —                                      | `{"type":"pong"}` (echoes `ref`).                                                                                          |

Value changes are ignored (reply `{"type":"ignored","reason":…}`) when no image is open in
the editor view. Unknown parameters, actions or message types produce `{"type":"error","message":…}`.

### Tracking

RapidRAW renders a fast low-resolution preview while a slider is being dragged and a full
quality render once it is released; the release also triggers the auto-save. The same
mechanism is used for controllers:

* **Automatic** (default): every `set`/`adjust`/`step`/`reset` marks the editor as "dragging".
  If no further value change arrives for ~180 ms the editor is released. A dial spun
  continuously therefore gets live previews, and the full render + save happen as soon as
  it stops. Nothing to do on the client side.
* **Explicit**: send `{"type":"tracking","active":true}` before a burst and
  `{"type":"tracking","active":false}` after it. While explicit tracking is active the
  automatic release is suspended. Use this if the controller knows when a dial is touched
  and released (e.g. a touch-sensitive encoder).

Undo history is coalesced the same way as for slider drags (one history step per burst).

## Notifications (RapidRAW → client)

### `state`

Sent on connect (replay), on request, and whenever anything in it changes — throttled to
roughly 30 messages/s during a burst.

```json
{
  "type": "state",
  "view": "editor",
  "image": { "path": "D:\\shoot\\DSC_0001.NEF", "name": "DSC_0001.NEF", "isReady": true, "rating": 3 },
  "canUndo": true,
  "canRedo": false,
  "showOriginal": false,
  "params": { "exposure": 0.35, "contrast": 12, "hsl.reds.hue": 0, … }
}
```

`view` is `library` or `editor`; `image` is `null` when nothing is open. `params` lists every
controllable parameter with its current value, so a controller can render dial positions
without asking.

### Others

* `{"type":"action-result","action":"preview_next","result":"ok"|"ignored"}` — `ignored` means
  the action's preconditions were not met (e.g. `preview_next` while in the library).
* `{"type":"error","message":"…"}`
* `{"type":"pong"}`

## Parameters

Identifiers are the field names of RapidRAW's `Adjustments` object; nested ones are joined
with dots. Ranges mirror the sliders in the UI. `get_params` returns the authoritative table
for the running build; the list below is the one shipped with protocol 1.

| group         | id                                                                                                           | range            | step |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- | ---- |
| basic         | `exposure`, `brightness`                                                                                     | −5 … 5           | 0.01 |
| basic         | `contrast`, `highlights`, `shadows`, `whites`, `blacks`                                                      | −100 … 100       | 1    |
| color         | `temperature`, `tint`, `vibrance`, `saturation`                                                              | −100 … 100       | 1    |
| color         | `hue`                                                                                                        | −180 … 180       | 1    |
| hsl           | `hsl.<color>.hue` / `.saturation` / `.luminance` — colors: reds, oranges, yellows, greens, aquas, blues, purples, magentas | −100 … 100 | 1 |
| colorGrading  | `colorGrading.<range>.hue` — ranges: shadows, midtones, highlights, global                                    | 0 … 360          | 1    |
| colorGrading  | `colorGrading.<range>.saturation`                                                                            | 0 … 100          | 1    |
| colorGrading  | `colorGrading.<range>.luminance`                                                                             | −100 … 100       | 1    |
| colorGrading  | `colorGrading.blending`                                                                                      | 0 … 100          | 1    |
| colorGrading  | `colorGrading.balance`                                                                                       | −100 … 100       | 1    |
| calibration   | `colorCalibration.shadowsTint`, `.redHue`, `.redSaturation`, `.greenHue`, `.greenSaturation`, `.blueHue`, `.blueSaturation` | −100 … 100 | 1 |
| details       | `sharpness`, `clarity`, `dehaze`, `structure`, `centré`, `chromaticAberrationRedCyan`, `chromaticAberrationBlueYellow` | −100 … 100 | 1 |
| details       | `sharpnessThreshold`                                                                                         | 0 … 80           | 1    |
| details       | `lumaNoiseReduction`, `colorNoiseReduction`                                                                  | 0 … 100          | 1    |
| effects       | `glowAmount`, `halationAmount`, `flareAmount`, `lensBlurAmount`, `lensBlurDiffusion`, `vignetteMidpoint`, `vignetteFeather`, `grainAmount`, `grainSize`, `grainRoughness`, `lutIntensity` | 0 … 100 | 1 |
| effects       | `vignetteAmount`, `vignetteRoundness`                                                                        | −100 … 100       | 1    |
| transform     | `rotation`, `transformRotate`                                                                                | −45 … 45         | 0.1  |
| transform     | `transformVertical`, `transformHorizontal`, `transformDistortion`, `transformAspect`, `transformXOffset`, `transformYOffset` | −100 … 100 | 1 |
| transform     | `transformScale`                                                                                             | 50 … 150         | 1    |

Note the accent in `centré` — it is the real field name in RapidRAW.

## Actions

Exactly the named actions RapidRAW binds to keyboard shortcuts; `get_actions` returns the
live list. Useful ones for a console:

`undo`, `redo`, `show_original`, `preview_prev`, `preview_next`, `open_image`,
`rate_0` … `rate_5`, `color_label_none|red|yellow|green|blue|purple`,
`rotate_left`, `rotate_right`, `zoom_in`, `zoom_out`, `zoom_fit`, `zoom_100`, `cycle_zoom`,
`copy_adjustments`, `paste_adjustments`, `toggle_crop`, `toggle_masks`, `toggle_presets`,
`toggle_left_panel`, `toggle_right_panel`, `toggle_bottom_panel`, `toggle_fullscreen`,
`brush_size_up`, `brush_size_down`, `delete_selected`, `select_all`.

`rate_n` behaves like the keyboard shortcut: rating an image that already has `n` stars
clears it to 0.

Actions run through their own `shouldFire` guards, so a `preview_next` in the library or a
`brush_size_up` outside the mask panel is reported as `ignored`, never misapplied.

## Example session

```
→ {"type":"get_params","ref":1}
← {"type":"params","protocol":1,"params":[…],"ref":1}
→ {"type":"step","param":"exposure","ticks":3}
→ {"type":"step","param":"exposure","ticks":2}
← {"type":"state",…,"params":{"exposure":0.05,…}}
→ {"type":"action","id":"rate_4"}
← {"type":"action-result","action":"rate_4","result":"ok"}
← {"type":"state",…,"image":{…,"rating":4},…}
```

Quick manual test from a shell:

```
# Windows (PowerShell)
$c = New-Object Net.Sockets.TcpClient('127.0.0.1', 47820); $s = $c.GetStream()
$w = New-Object IO.StreamWriter($s); $w.AutoFlush = $true
$w.WriteLine('{"type":"adjust","param":"exposure","delta":0.5}')

# macOS / Linux
printf '{"type":"adjust","param":"exposure","delta":0.5}\n' | nc 127.0.0.1 47820
```

## Versioning

`protocol` in `hello` increments only for incompatible changes. Adding parameters, actions
or message fields is backwards compatible and does not bump it. A client should read the
parameter table from `get_params` rather than hard-coding ranges.
