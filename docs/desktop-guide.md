# Use RapidRAW as a standalone editor

RapidRAW is a GPU-accelerated photo editor created by [Timon Käch](https://github.com/CyberTimon/RapidRAW). Its desktop interface and original export CLI work independently of MCP, Lightweft and Insta360 tools. This guide covers those entry points; use the [MCP guide](../mcp/README.md) to connect an AI agent.

## Get the application

Use the [upstream releases page](https://github.com/CyberTimon/RapidRAW/releases) for the original application's available installers and bundles. Linux packaging also includes [Flathub](https://flathub.org/apps/io.github.CyberTimon.RapidRAW) and the community [AUR package](https://aur.archlinux.org/packages/rapidraw-bin). Follow the selected package's platform and dependency requirements.

Those upstream packages do not include this fork's MCP bridge. Use [this fork's beta packages](https://github.com/sheldonxxxx/RapidRAW/releases) or build this fork for fork-specific fixes or MCP. The fork installs as **RapidRAW MCP** with separate preferences and model storage; existing upstream settings are not automatically migrated. To connect an agent, also set up the [Node MCP host](../AGENT_SETUP.md). Its tested MCP configurations are listed separately in the [repository overview](../README.md#tested-configurations-and-current-limits).

For interface tutorials and the original editor's example photographs, visit the [upstream documentation](https://www.getrapidraw.com/docs/) and [showcase](https://github.com/CyberTimon/RapidRAW#showcase--edits).

### macOS Beta 1 signature error

The Apple Silicon `fork-v0.1.0-beta.1` package has an incomplete app-bundle signature. macOS may report the application as damaged even when the download is intact. Direct MCP executable tests do not cover Finder/Gatekeeper installation checks.

Only for a Beta 1 download verified against the release's SHA256 digest, repair the installed bundle signature:

```sh
codesign --force --deep --sign - "/Applications/RapidRAW MCP.app"
codesign --verify --deep --strict --verbose=2 "/Applications/RapidRAW MCP.app"
```

Then open the app. Because the beta is not notarized, macOS may still require **System Settings → Privacy & Security → Open Anyway**. See [Apple's instructions](https://support.apple.com/en-us/102445). Do not disable Gatekeeper globally. Future builds apply a complete ad-hoc signature automatically; a Developer ID signature and notarization are separate distribution requirements.

## Editing and organization

- **Develop and grade:** exposure, tone mapping, white balance, colour mixer, curves, sharpening, manual noise reduction, lens corrections and geometric transforms.
- **Make local edits:** brush and gradient masks, colour/luminance ranges, AI selections, depth and local retouching.
- **Explore looks:** presets, LUTs, grain and creative effects, with adjustable strength.
- **Compare and check:** a before/after split view with a draggable divider (Y), Show Original (B) and clipping warnings (J). Shortcuts can be changed in the keybind settings.
- **Organize a library:** folders, albums, virtual copies, ratings, labels, metadata, library filtering and a culling view.
- **Deliver:** batch processing and export to JPEG, PNG, WebP, AVIF, TIFF, JPEG XL or CUBE LUTs, with the options supported by the selected entry point.

In **Local Edits**, select a repair and choose **Use selection for adjustment** to copy its selection into a new, neutral local adjustment. You can also copy a supported adjustment selection into a new AI repair; Shape Light and Surface Colour selections are adjustment-only. Each copy has its own selection and controls, while generated repair pixels stay with the original repair.

Ordinary adjustments are saved in `.rrdata` sidecars. The desktop application also has explicit file-management operations such as move, rename and delete; its library behaviour is separate from MCP's isolated working-copy contract.

AI tools need model assets. The GUI can manage local models; remote generative editing uses a separately configured provider. Review the provider and image-transfer behaviour before using it. Local model inference and GPU image rendering are different processing paths.

### Generative editing controls

In **Inpaint studio**, draw a selection, describe the repair, and choose **1–4 variations**. Each variation uses the same starting photo and selection. When the full batch finishes, RapidRAW applies its final result automatically. Basic inpaint produces one result and applies it when complete.

Click a result thumbnail in **Photo generation history** to apply it; click the applied result again to disable it. History shows only results for the selected edit and is saved in the photo sidecar across restarts. **Reuse settings** copies a result's prompt and generation options to the current selection. To remove an unwanted candidate, click **Delete result**, then **Confirm delete** in the same place. An already applied repair stays on the photo. Retained candidates increase sidecar size.

**Stop after current** saves the running result and skips the rest of the batch. Stopped or failed batches keep completed results without applying one automatically. A fixed seed increments for each variation; leave it blank for new random seeds. Applying a historical result keeps the current selection; return to its original crop, orientation and geometry first if those have changed.

**Reference images** is a separate collapsible section below Variations. Expand it to add up to four images, select several files at once, or remove an image individually. Each image can be PNG, JPEG or WebP, up to 9 MiB and 16 megapixels. Choose **Qwen Image 2.1** or a supporting **Klein edit** workflow, then describe how each reference should guide the repair. The source photo remains the first workflow image; your references follow in thumbnail order. For Qwen, the connector adds instructions distinguishing the source scene from auxiliary references while retaining your original prompt in the receipt. Describe the intended pose and placement explicitly, then inspect the applied result at native size. Uploads are disabled for unsupported workflows, including removal-only workflows and older connectors. References are sent to the configured connector, retained with the generation settings, and reduced to at most 1536 pixels on their longest edge for inference; the original photo is not resized.

With an AI Connector that advertises generation workflows, Local Edits lets you choose a workflow, its supported **AI resolution**, and an optional **Seed**. These controls require a current build of this fork; the included [Comfy Connector setup](../ai-connector/README.md) explains the matching server and model profiles. Leave the seed empty for a new variation. Keep the same image, selection, prompt and generation settings when comparing repeat runs; changing the model, runtime or hardware can also change the result.

AI resolution applies to the generated area. The photograph retains its original canvas size, and a generated patch may be enlarged to fit its placement. When the connector returns a valid generation receipt, the panel shows the actual generated dimensions, placement dimensions and seed. Inspect repaired texture and seams at native magnification before accepting an edit.

Settings stay with each reversible AI patch. If the connector changes or a saved workflow is unavailable, choose a supported workflow or explicitly use connector defaults. **Refresh workflows** discovers changes without reopening the editor. Older connectors continue to work with their defaults; workflow and seed controls require a compatible connector.

Follow the [AI editing workflows](ai-editing-workflows.md) for removal, recolouring, object replacement and lettering, including when to use photographic adjustments and when to compare another generated result.

### Formats, lenses and languages

RAW decoding uses [rawler](https://github.com/dnglab/dnglab/tree/main/rawler). The file extension alone does not establish camera support; consult the [supported-camera list](https://github.com/dnglab/dnglab/blob/main/SUPPORTED_CAMERAS.md) and test a file from the actual camera. Standard raster formats are also supported, including JPEG, PNG, TIFF and WebP.

Lens correction uses the bundled [Lensfun database](../src-tauri/lensfun_db) for distortion, transverse chromatic aberration and vignetting. Matching a profile does not establish perfect optical correction; inspect geometry, colour fringes and corner illumination.

Translations are maintained in the [application locale files](../src/i18n/locales). Translation completeness can vary by language and version.

## Build this fork

Install Node.js 22.12 or later, Rust 1.98 or later, and the [Tauri prerequisites for your platform](https://v2.tauri.app/start/prerequisites/). A working graphics backend and sufficient memory for your photos are required. The commands below use a POSIX shell on macOS or Linux. The pinned Rust example leaves the machine's default toolchain unchanged.

Apple Silicon builds require macOS 14 or later and bundle ONNX Runtime 1.30.0. Intel Mac source builds and the published 0.4.0 Intel packages retain the existing 1.22.0 runtime; new fork releases no longer package Intel Macs. See the [runtime guide](local-enhancement.md#apple-silicon-runtime).

```sh
git clone https://github.com/sheldonxxxx/RapidRAW.git
cd RapidRAW
rustup toolchain install 1.98.1 --profile minimal
npm ci
RUSTUP_TOOLCHAIN=1.98.1 npm start
```

To create an application build:

```sh
RUSTUP_TOOLCHAIN=1.98.1 npm run tauri -- build
```

Use the output location reported by the build. `CARGO_TARGET_DIR` changes the native target directory. For the separate MCP-enabled build, use the [native build and connection instructions](../mcp/README.md#build-and-connect).

## Camera tethering

The optional `tethering` Cargo feature uses [libgphoto2](http://gphoto.org/) on macOS and Linux. It provides capture, live view, camera settings, autofocus and library ingestion where the connected camera supports those operations. Camera support and individual remote-control features vary; consult the [libgphoto2 camera list](http://gphoto.org/proj/libgphoto2/support.php).

Set the camera's USB mode to the appropriate remote, tethering or PTP setting. RapidRAW does not expose tethering through its MCP tools. Windows and Android tethering are unsupported by this integration.

Install the system library before building or running a binary linked to it:

```sh
# macOS with Homebrew
brew install libgphoto2 pkg-config
```

```sh
# Debian or Ubuntu
sudo apt-get install libgphoto2-dev pkg-config
```

Then run or build the optional feature:

```sh
RUSTUP_TOOLCHAIN=1.98.1 npm run start:tethering
RUSTUP_TOOLCHAIN=1.98.1 npm run tauri -- build --features tethering
```

Tethering binaries depend on the installed system libraries. A standard build omits that dependency. Upstream releases may provide a separately labelled tethering variant; use its installation instructions.

## Command-line export

The original CLI exports a source image or directory using adjacent `.rrdata` adjustments, or a supplied adjustment JSON file. It does not require an MCP connection and does not expose the full MCP editing/session interface. Native graphics and platform dependencies still apply.

Replace these clearly labelled placeholder paths with your executable, photographs and output locations:

```sh
RAPIDRAW_APP=/absolute/RapidRAW/src-tauri/target/release/RapidRAW

# Export a directory using each source's existing sidecar.
"$RAPIDRAW_APP" export /absolute/photos \
  --output /absolute/exports --format jpeg --quality 90

# Export one photograph to a specific file.
"$RAPIDRAW_APP" export /absolute/photos/example.cr3 \
  --output /absolute/exports/example.png --format png

# Override sidecar adjustments with a native adjustment object.
"$RAPIDRAW_APP" export /absolute/photos \
  --output /absolute/exports --adjustments /absolute/presets/adjustments.json
```

| Option                 | Meaning                                                 | Default               |
| ---------------------- | ------------------------------------------------------- | --------------------- |
| `<source>`             | An image file or directory                              | Required              |
| `--output <path>`      | Output file or directory                                | Required              |
| `--format <fmt>`       | `jpeg`, `png`, `webp`, `avif`, `tiff`, `jxl`, or `cube` | `jpeg`                |
| `--quality <1-100>`    | Requested export quality                                | `90`                  |
| `--keep-metadata`      | Retain capture metadata                                 | Off                   |
| `--adjustments <path>` | Native adjustment JSON overriding sidecars              | Use adjacent sidecars |

JPEG, PNG, TIFF and WebP exports carry a verified sRGB ICC profile even when capture metadata is off or GPS is stripped. Capture-metadata retention is supported for JPEG, PNG and WebP output from non-TIFF sources. An unsupported `--keep-metadata` request fails before an output file is written; omit the flag to export without capture metadata. TIFF exports use the requested 8-bit or 16-bit depth, with 16-bit as the default.

Use a separate output location and inspect exported dimensions, metadata and pixels. MCP-only parameters such as `expected_revision`, `long_edge`, `resize` and `color_profile` are not flags of this CLI. For agent-managed originals protection, portable state and structured per-item results, use the [execution skill](../skills/rapidraw-mcp/SKILL.md).

## Troubleshooting

If opening a photograph fails or the editor crashes, check the actual GPU/backend in **Settings → Processing**. Select a supported backend and restart. High-resolution inputs, masks and undo history can require substantial memory; reduce competing workloads and retain the original file when diagnosing a failure.

On Linux, WebKit/Wayland and GPU driver combinations may need different launch settings. The upstream [Wayland issue](https://github.com/CyberTimon/RapidRAW/issues/306) documents reported failures. For a tested server configuration, use the fork's [SSH/Xvfb guide](mcp/remote-ssh.md).

Report issues with the exact build, OS, GPU, affected entry point and a minimal reproduction using the [contribution guide](../CONTRIBUTING.md). A desktop release, an MCP debug build and a headless export can have different dependency and test boundaries.
