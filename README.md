# RapidRAW + MCP

An independent companion to **[Lightweft](https://github.com/sheldonxxxx/lightweft)**, the main project for AI photo-editing direction, personal style and visual review.

**Give your AI agent a native, reversible photo editor.**

This independent fork of [RapidRAW](https://github.com/CyberTimon/RapidRAW) adds an optional Model Context Protocol (MCP) interface to its GPU-accelerated RAW editor. An agent can inspect a photograph, adjust light and colour, refine masks, compare rendered alternatives, and export a finished image while preserving the original and its existing sidecar.

Use RapidRAW on its own, connect it to your preferred MCP client, or pair it with [Lightweft](https://github.com/sheldonxxxx/lightweft), the central workspace for photographic direction, rendered review and personal style exploration. Lightweft and the [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit) are separate, optional projects.

**[Agent setup](AGENT_SETUP.md)** · **[MCP package](mcp/README.md)** · **[MCP docs](docs/mcp/README.md)** · **[Use the desktop editor](docs/desktop-guide.md)** · **[Explore Lightweft](https://github.com/sheldonxxxx/lightweft)**

> A beautiful, non-destructive, and GPU-accelerated RAW image editor built with performance in mind.

RapidRAW is a modern, high-performance alternative to Adobe Lightroom®. The fork release workflow packages Apple Silicon and Linux x86_64, each with the native MCP bridge. The published 0.4.0 release also includes Intel Mac packages.

<table width="100%">
  <tr>
    <td width="50%" valign="top" align="center">
      <br>
      <a href="https://github.com/sheldonxxxx/RapidRAW/releases/latest">
        <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/main/src-tauri/icons/full_res_original.png" alt="Download RapidRAW" height="96">
      </a>
      <h3>Download RapidRAW</h3>
      <p>Download the latest fork release for macOS or Linux x86_64, with the native MCP bridge included.</p>
      <strong><a href="https://github.com/sheldonxxxx/RapidRAW/releases/latest">Download RapidRAW + MCP →</a></strong>
      <br><br>
    </td>
    <td width="50%" valign="top" align="center">
      <br>
      <a href="https://www.getrapidraw.com/docs/">
        <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/main/src-tauri/icons/docs.png" alt="Read the Docs" height="96">
      </a>
      <h3>Read the Docs</h3>
      <p>Learn how RapidRAW works with step-by-step tutorials, from adjustments to masking.</p>
      <strong><a href="https://www.getrapidraw.com/docs/">View Tutorials & Docs →</a></strong>
      <br><br>
    </td>
  </tr>
</table>

<details>
<summary><strong>For Who Is This?</strong></summary>
RapidRAW is for photographers who love to edit their photos in a <strong>clean, fast, and simple workflow</strong>. It prioritizes speed, a beautiful user interface, and powerful tools that let you achieve your creative color vision quickly.
<br><br>
RapidRAW is still in active development and isn't yet as polished as mature tools like Darktable, RawTherapee, or Adobe Lightroom®. Right now, the focus is on building a fast, enjoyable core editing experience. You may encounter bugs - if you do, please report them so I can fix them :) Your feedback really helps!
<br><br>
</details>
<details>
<summary><strong>Recent Changes</strong></summary>

- **2026-09-17:** Rewrite vibrance & local contrast preserving highlights adjustment
- **2026-09-16:** Add highlights color reconstruction & improve exposure shader
- **2026-09-14:** Add neutral grey canvas toggle
- **2026-09-13:** Improve RAW highlight recovery and color clipping
- **2026-09-12:** Add Ctrl crop pan/zoom and optimize preview transform caching
- **2026-09-09:** Add masonry thumbnail layout mode
- **2026-09-09:** Add back and forward navigation history for library
- **2026-09-06:** Support exporting to original folder with subfolder
- **2026-09-03:** Rewrite Wayland/Nvidia workaround
- **2026-09-02:** Refactor crop panel & integrate transform/lens correction directly into main canvas

<details>
<summary><strong>Expand further</strong></summary>

- **2026-09-01:** Implemented guided perspective correction thanks to @hogar1977
- **2026-09-01:** Add context menu option to auto apply lens correction
- **2026-08-31:** New edge-aware filter for ai masks, improved sharpening & mobile UI improvements
- **2026-08-29:** Improved EXIF ​​metadata processing during export
- **2026-08-29:** Implement folder-level EXIF caching and prevent redundant adjustment saves
- **2026-08-28:** Categorize mask creation panel
- **2026-08-27:** Split thumbnail resolution settings into separate grid and editor preview sizes
- **2026-08-26:** Introduced a retouch tool to effortlessly smooth skin
- **2026-08-25:** Added a liquify tool to reshape and warp parts of an image
- **2026-08-24:** New global shift+drag straighten shortcut & improved auto-crop calculation
- **2026-08-20:** Add drag & drop image move system to quickly organize library
- **2026-08-19:** Restored side panels on tablets
- **2026-08-17:** Integrated built-in analog film emulations powered by Spektrafilm, featuring a scene-referred V-Log color pipeline in the WGSL shader
- **2026-08-16:** Added native Camera Tethering with real-time Live View, exposure controls, ghost overlay, and direct library ingestion (macOS & Linux)
- **2026-08-16:** Added Focus Stacking to merge multi-focus brackets into a single sharp image
- **2026-08-14:** Export now preserves and writes full EXIF metadata
- **2026-08-13:** Replaced local contrast sharpening with a high-quality multi-scale filter
- **2026-08-11:** Added automatic canvas cropping for generative AI inpainting workflows
- **2026-08-07:** Updated Lensfun database for latest camera bodies and lenses
- **2026-08-06:** Added customizable keyboard shortcuts and visibility toggles for left, right, and bottom panels
- **2026-08-05:** Added Catalan language support and folder tree shortcut
- **2026-08-03:** Added support for image-based LUTs (.png, .jpg, .jpeg, .tiff) and batch importing multiple presets
- **2026-08-01:** Implemented customizable workspace layout system with drag & drop panels
- **2026-07-31:** Enabled White Balance color picker tool for the WGPU renderer
- **2026-07-29:** Added Cmd/Ctrl+L keyboard shortcut to quickly copy image file paths to the clipboard
- **2026-07-26:** Added AI Lens Blur (Bokeh) for realistic depth-of-field background blurring
- **2026-07-25:** Added headless CLI batch export supporting custom JSON adjustments
- **2026-07-24:** Added Ctrl/Cmd+F search shortcut and optimized library & scope performance
- **2026-07-23:** Significantly improved HDD thumbnail loading and resolved Linux NVIDIA crash issues
- **2026-07-22:** Calibrated JPEG XL (JXL) export quality curves
- **2026-07-20:** Made automatic adjustment synchronization optional for multi-selections
- **2026-07-19:** Introduced new Culling View (up to 6 images side-by-side) with star ratings and metadata
- **2026-07-16:** Enhanced crop tool with area preservation and crop-centered rotation
- **2026-07-15:** Fixed Canon multi-exposure WB, reduced export RAM usage, and added settings shortcut
- **2026-07-14:** Improved EXIF lens metadata extraction and fixed crop scaling bugs
- **2026-07-12:** Added layout-aware keybinds, adjusted black levels, and fixed patch offsets on transformed images
- **2026-07-11:** Added new local Clone and Heal cleanup tools with highly optimized, parallelized processing. Also fixed Android back-button navigation and resolved an issue causing freezes with iCloud
- **2026-07-08:** Improved thumbnail loading speeds using native file transfers and updated core rendering engines for better overall performance and compatibility
- **2026-07-06:** Fixed copying adjustments directly from the filmstrip, resolved AI model and LUT download issues on Android, and fixed several Windows-specific bugs (including offscreen windows and folder exports)
- **2026-07-05:** Implemented advanced HDR deghosting with new grayscale image alignment and warping mechanics to prevent visual artifacts during HDR merges
- **2026-07-03:** Added "Open With" external editor support and implemented a fallback to embedded previews for undecodable or unsupported RAW files
- **2026-06-29:** Completely reworked the shadows and blacks adjustments, and introduced a new LUT preview panel with hover-to-test functionality, easy importing, and removal support
- **2026-06-25:** Implemented folder sorting, reliable image/album counts, and fixed folder expansion race conditions
- **2026-06-20:** Added quick filters to the bottom bar and integrated global hue shifts into the copy-paste system
- **2026-06-18:** New preset intensity slider
- **2026-06-14:** Added Korean translation support and integrated the global hue slider
- **2026-06-12:** Refined and standardized Traditional Chinese translations
- **2026-06-10:** Completed i18next configuration and added Traditional Chinese locale support
- **2026-06-08:** Resolved infinite indexing loops, brightness bugs, and general compiler warnings
- **2026-06-07:** Fixed copy-pasting, improved library performance & eight new languages
- **2026-06-01:** Improved thumbnail performance, polished metadata panel & non-blocking exif reading
- **2026-05-30:** Implemented reliable edited status, sorting & filtering options
- **2026-05-29:** Refactor exporting to be resource aware
- **2026-05-27:** Added German language
- **2026-05-26:** Converted all components to support full internalization (multilingual / i18n support)
- **2026-05-25:** Implemented dynamic high-resolution rendering for the canvas UI and added copy/pasting of lens correction parameters
- **2026-05-24:** Added advanced library filtering capabilities (queries)
- **2026-05-20:** Introduced a dedicated EXIF data overlay display directly inside the library and list views
- **2026-05-18:** Added global image preprocessing settings, numpad support for customizable keyboard shortcuts, and updated the "Grey" theme color variables
- **2026-05-16:** Initial backend implementation of the cloud service functionality alongside a preview worker backpressure mechanism for better handling of high-quality live previews
- **2026-05-15:** Added the ability to assign custom icons to individual folders in the library tree
- **2026-05-14:** Expanded the library architecture to support multi-root folders and introduced a custom album system
- **2026-05-11:** Improved brush tool
- **2026-05-05:** Major refactor to zustand...
- **2026-05-04:** Added EXIF editing to the metadata panel, accumulating shader execution order, and improved UI responsiveness with triple buffering
- **2026-05-03:** Introduced a "focus mode" for distraction-free editing and enhanced filmic exposure. Batch editing now correctly respects copy/paste settings
- **2026-05-01:** Implemented manual noise reduction with separate controls for luma and color. Optimized the thumbnail generation and request system for better performance
- **2026-04-30:** Major backend refactoring for improved stability and performance. Fixed key issues with cropping, including preserving position when changing aspect ratios
- **2026-04-29:** Added a tonemapper override option and significantly improved the UI on vertical/mobile screens
- **2026-04-27:** Implemented parametric curves tool and introduced thumbnail workers to speed up library browsing
- **2026-04-24:** Overhauled the controls system, adding a dedicated settings section for fully customizable keyboard shortcuts
- **2026-04-22:** Improved auto-adjustment logic, fixed lens correction on Android, and added an import button for mobile devices
- **2026-04-21:** Signed Android APKs, added canvas shortcuts to keybinds, added reset adjustments confirm submenu, and fixed WGPU renderer bugs
- **2026-04-20:** Added style/tool preset mode, improved auto-adjustments via thumbnail caching, and optimized WGPU renderer with custom transform wrapper
- **2026-04-19:** Added brightness to auto-adjust and replicated pixelated rendering logic in WGPU display
- **2026-04-18:** Implemented direct WGPU renderer and fixed macOS GPU context initialization
- **2026-04-17:** Added comprehensive touch support for masks, curves, sliders, and scrolling
- **2026-04-16:** Presets and copy/paste settings now support masks and crops; added mask intersect mode
- **2026-04-15:** Native rotation slider, mask duplication improvements, and Android AI mask fixes
- **2026-04-14:** Implemented `.rrexif` format to keep EXIF when denoising/stitching and added batch denoising
- **2026-04-13:** Added option to preserve folder structure when batch exporting and removed mask limit
- **2026-04-12:** Implemented option to keep export file timestamps from EXIF capture date
- **2026-04-11:** Added flow mask controls/rasterization and dynamic gradient sliders for color grading wheels
- **2026-04-10:** Improved downscaling algorithm, optimized zoom handling, and implemented global UI text layout upgrades
- **2026-04-09:** Fixed Linux touchpad pinch zoom scaling and optimized Masks/AI panel space efficiency
- **2026-04-08:** Redesigned color grading wheels for a minimalistic, consistent look
- **2026-04-07:** Added AVIF export support and fixed adjustment race conditions on fast image switching
- **2026-04-04:** Fixed filmstrip additive multi-range selection
- **2026-04-02:** Added Android URI support and Android file management integration
- **2026-04-01:** Added depth masking with depth anything v2 & improved ROI rendering performance
- **2026-03-30:** LaMa inpainting for lightweight local content-aware fill and object removal
- **2026-03-26:** Performance improvements & new flat list mode for library
- **2026-03-25:** Optimize folder loading & tree fetching
- **2026-03-23:** Generate thumbnails only for visible viewport items
- **2026-03-22:** Dependency migrations and other bug fixes
- **2026-03-21:** Colored sliders for temperature and tint
- **2026-03-18:** Implemented AI NIND denoising
- **2026-03-16:** LRU cache for instant image loading
- **2026-03-15:** Improved high quality subject mask models, various UI improvements and shader improvements
- **2026-03-14:** New image analytics panel which can display vectorscopes, waveforms, parades & histograms
- **2026-03-13:** JPEG XL, WebP, and additional format support, including the ability to export LUTs
- **2026-03-12:** Added parametric color & luminance masks
- **2026-03-10:** Implement region of interest rendering to improve performance when zooming in
- **2026-03-07:** Batch negative conversion & various shader improvements
- **2026-03-06:** Performance optimizations and UI cleanup
- **2026-03-05:** Initial draw support for linear & radial masks
- **2026-03-04:** Real-time mask overlay rendering & pixel perfect zooming
- **2026-03-03:** Instant image rendering & real-time histogram update
- **2026-03-02:** Remember last export settings & lens correction auto cropping
- **2026-03-01:** Optimized pixelated interpolation at maximum zoom level
- **2026-02-27:** Refactored fullscreen handling, smooth and integrated fullscreen viewer
- **2026-02-24:** Improved tonal adjustments using detail masks, remember zoom level & faster fullscreen preview
- **2026-02-23:** Custom AI tag lists, clear button for tag settings & improved window state restoration
- **2026-02-23:** Improved RAW processing, incorrect thumbnail crop scaling & improved mask handles
- **2026-02-21:** XMP metadata read/sync
- **2026-02-20:** Main window size/position persistence, right-click history dropdown & new library organization panel
- **2026-02-19:** Exponential zoom scaling, right-click to delete curve points & selected image count display
- **2026-02-18:** Added a setting for Linear RAW mode for advanced processing & improved right panel switcher
- **2026-02-17:** Display RAW image counts in the folder tree & improved folder reading performance
- **2026-02-16:** New composition guide overlays for cropping
- **2026-02-16:** Added the ability to export masks as separate images
- **2026-02-13:** Optimized live previews, instant metadata loading and new jpeg encoder
- **2026-02-13:** Added ability to merge multiple bracketed images to a HDR
- **2026-02-12:** Straight brush mask lines using shift click and enhanced Lensfun DB parsing
- **2026-02-10:** Improved image loading performance
- **2026-02-06:** Refactored negative conversion logic using characteristic curves.
- **2026-02-04:** Global tooltips & major UI polish
- **2026-02-03:** New creative effects: Glow, Halation & Lens Flares
- **2026-01-31:** Accurate color noise reduction for RAW images & improved image loading
- **2026-01-30:** Enhanced Lensfun DB parsing and improved lens matching logic
- **2026-01-29:** Add cross-channel copy/paste & flat-line clipping logic for curves
- **2026-01-26:** Favorite lens saving, improved rotation controls (finer grid), better local contrast adjustments
- **2026-01-25:** Filmstrip performance boost, improved sorting, lens distortion fixes for AI masks & crop
- **2026-01-24:** Added automatic lens, TCA & vignette correction using lensfun
- **2026-01-22:** Improved and centralized EXIF data handling for greater accuracy and support
- **2026-01-21:** Inpainting now works correctly on images with geometry transformations
- **2026-01-20:** Export preset management for saving export settings
- **2026-01-19:** Preload library for faster startup & automatic geometry transformation helper lines
- **2026-01-18:** Implement image geometry transformation utils
- **2026-01-17:** Refactor AI panel to correctly work with the new masking system
- **2026-01-16:** Major masking system overhaul with drag & drop, per-mask opacity/invert & UI improvements
- **2026-01-13:** New python middleware client for external generative AI integration (ComfyUI)
- **2026-01-12:** Created a RapidRAW community discord server
- **2026-01-11:** Separate preview worker, optional high-quality live previews & mask/ai patch caching
- **2026-01-10:** Enhanced EXIF UI, optimized color wheels/curves & rawler update
- **2026-01-09:** Live previews for all adjustments & masks with optimized GPU processing
- **2026-01-05:** Collage maker upgrade (drag & drop, zoom, ratio options)
- **2026-01-05:** 'Prefer RAW' filter option added to library
- **2026-01-05:** Support for uppercase file extensions
- **2026-01-05:** Flush thumbnail cache on folder switch
- **2025-12-27:** Fix LUT banding issues with improved sampling
- **2025-12-26:** AI masking stability improvements under load
- **2025-12-23:** Metadata card in toolbar & context menu export
- **2025-12-23:** Monochromatic grain & white balance picker improvements
- **2025-12-22:** BM3D Denoising with comparison slider
- **2025-12-20:** Batch export stability improvements & RAM optimization
- **2025-12-14:** Exposure slider added to masking tools
- **2025-12-14:** Improved delete workflow
- **2025-12-08:** Improved mask eraser tool behavior & ORT v2 migration
- **2025-12-07:** Write EXIF metadata to file
- **2025-12-07:** Color picker for white balance
- **2025-11-30:** HSL luminance artifacts fix
- **2025-11-29:** Improved mask stacking & many bug fixes
- **2025-11-28:** QOI support
- **2025-11-25:** Update rawler
- **2025-11-23:** Recursive library view to display images from all subfolders
- **2025-11-22:** DNG loader improvements
- **2025-11-18:** Improved vibrancy adjustment
- **2025-11-15:** Virtual copies & library improvements
- **2025-11-14:** Open-with-file cross plattform compatibilty & single instance lock
- **2025-11-13:** Rewritten tagging system to support pill-like image tagging
- **2025-11-10:** Improved folder tree with search functionality
- **2025-11-08:** Added EXR file format support
- **2025-11-XX:** Improving AgX
- **2025-11-02:** Optimize image loading & add processing engine settings
- **2025-10-31:** Expose highlights compression point to user & improve keybinds detection
- **2025-10-28:** Copy paste settings & brightness adjustment
- **2025-10-XX:** Working on tonemapping - ongoing...
- **2025-10-24:** Getting AgX right isn't as easy as it seems :=)
- **2025-10-22:** AgX tone mapping
- **2025-10-19:** Whole image mask component & organize mask components better
- **2025-10-19:** You can now apply presets to masks & improved auto adjustments
- **2025-10-17:** New centré adjustment, rawler now as a submodule & improved logger
- **2025-10-15:** Ability to pin folders, improved session handling & smooth library thumbnail updating
- **2025-10-11:** Realistic, complex & non-dulling exposure & highlights slider
- **2025-10-11:** Smooth filmstrip thumbnail updates
- **2025-10-07:** New watermarking support
- **2025-10-06:** Improve crop quality by transforming before scaling
- **2025-10-XX:** Many small improvements - ongoing...
- **2025-09-27:** Sort library by exif metadata & release cleanup / bug fixes
- **2025-09-26:** Collage maker to create unique collages with many different layouts, spacing & border radius
- **2025-09-23:** Color calibration tool to adjust RGB primaries & adjustments visibility settings
- **2025-09-22:** Issue template & CI/CD improvements
- **2025-09-20:** Universal presets importer, prioritize dGPU & improved local contrast tools (sharpness, clarity etc.)
- **2025-09-17:** Automatic image culling (duplicate & blur detection)
- **2025-09-14:** Grid previews in community panel & improved ComfyUi workflow
- **2025-09-12:** New community presets panel to share & showcase presets
- **2025-09-10:** Extended generative AI roadmap & started building RapidRAW website
- **2025-09-09:** Many shader improvements & bug fixes, invert tint slider
- **2025-09-06:** New update notifier that alerts users when a new version becomes available
- **2025-09-04:** Added toggleable clipping warnings (blue = shadows, red = highlights)
- **2025-09-02:** Transition to Rust 2024 & Cache image on GPU
- **2025-08-31:** Cancel thumbnail generation on folder change & optimized ai patch saving
- **2025-08-30:** Optimize ComfyUI image transfer & speed
- **2025-08-28:** Chromatic aberration correction & Shader improvements
- **2025-08-26:** User customisable ComfyUI workflow selection
- **2025-08-25:** Make LUTs parser more robust (support more advanced formats)
- **2025-08-24:** Improved keyboard shortcuts
- **2025-08-23:** Estimate file size before exporting
- **2025-08-21:** Added LUTs (.cube, .3dl, .png, .jpg, .jpeg, .tiff) support
- **2025-08-16:** Fast AI sky masks
- **2025-08-15:** Show full resolution image when zooming in
- **2025-08-15:** Implement Tauri's IPC as a replacement for the slow Base64 image transfer
- **2025-08-12:** Relative zoom indicator
- **2025-08-11:** TypeScript cleanup & many bug fixes
- **2025-08-09:** Local inpainting without the need for ComfyUI, ability to change thumbnail aspect ratio
- **2025-08-09:** Frontend refactored to TypeScript thanks to @varjolintu
- **2025-08-08:** New onnxruntime download strategy & the base for local inpainting
- **2025-08-05:** Improved HSL cascading, UI & animation improvements, ability to grow & shrink / feather AI masks
- **2025-08-03:** New high performance, seamless image panorama stitcher (without any dependencies on OpenCV)
- **2025-08-02:** Added an image straightening tool and improved crop & rotation functionality (especially on portrait images)
- **2025-08-02:** A new dedicated image importer, ability to rename and batch rename files, improved dark theme, and other fixes
- **2025-07-31:** Ability to tag & filter images by color labels, refactored image right clicking
- **2025-07-31:** Reimplemented the functionality of GPU processing (GPU cropping, etc.) -> No longer dependent on TEXTURE_BINDING_ARRAY
- **2025-07-29:** Refactored generative AI foundation, many small fixes
- **2025-07-27:** Automatic AI image tagging, overall mask transparency setting per mask
- **2025-07-25:** Fuji RAF X-Trans sensor support (new x-trans demosaicing algo)
- **2025-07-24:** Auto crop when cropping an image (to prevent black borders), added drag & drop sort abilty to presets panel
- **2025-07-22:** Significant improvements to the shader: More accurate exposure slider, better tone mapper (simplified ACES)
- **2025-07-21:** Remember scroll position when going into the editing section
- **2025-07-20:** Ability to add presets to folders, export preset folders etc, preset _animations_
- **2025-07-20:** Tutorials on how to use RapidRAW
- **2025-07-19:** Initial color negative conversion implementation, shader improvements
- **2025-07-19:** New color wheels, persistent collapsed / expanded state for UI elements
- **2025-07-19:** Fixed banding & purple artefacts on RAW images, better color noise reduction, show exposure in stops
- **2025-07-18:** Smooth zoom slider, new adaptive editor theme setting
- **2025-07-18:** New export functionality: Export with metadata, GPS metadata remover, batch export file naming scheme using tags
- **2025-07-18:** Ability to delete the associated RAW/JPEG in right click delete operations
- **2025-07-17:** Small bug fixes
- **2025-07-13:** Native looking titlebar and ability to input precise number into sliders
- **2025-07-13:** Huge update to masks: You can now add multiple masks to a mask containers, subtract / add / combine masks etc.
- **2025-07-12:** Improved curves tool, more shader improvements, improved handling of very large files
- **2025-07-11:** More accurate shader, reorganized main library preferences dropdown, smoother histogram, more realistic film grain
- **2025-07-11:** Added a HUD-like waveform overlay toggle to display specific channel waveforms (w-key)
- **2025-07-10:** Rewritten batch export system and async thumbnail generation (makes the loading of large folders a lot more fluid)
- **2025-07-10:** Window transparency can now be toggled in the settings, thanks to @andrewazores
- **2025-07-08:** Ability to toggle the visibility of individual adjustments sections
- **2025-07-08:** Fixed top-left zoom bug, corrected scale behavior in crop panel, keep default original aspect ratio
- **2025-07-08:** Added image rating filter and redesigned the metadata panel with improved layout, clearer sections, and an embedded GPS map
- **2025-07-07:** Improved generative AI features and updated [AI Roadmap](#ai-roadmap)
- **2025-07-06:** Initial generative AI integration with [ComfyUI](https://github.com/comfyanonymous/ComfyUI) - for more details, checkout the [AI Roadmap](#ai-roadmap)
- **2025-07-05:** Ability to overwrite preset with current settings
- **2025-07-04:** High speed and precise cache to significantly accelerate large image editing
- **2025-07-04:** Greatly improved shader with better dehaze, more accurate curves etc
- **2025-07-04:** Predefined 90° clockwise rotation and ability to flip images
- **2025-07-03:** Switched from [rawloader](https://github.com/pedrocr/rawloader) to [rawler](https://github.com/dnglab/dnglab/tree/main/rawler) to support a wider range of RAW formats
- **2025-07-02:** AI-powered foreground / background masking
- **2025-06-30:** AI-powered subject masking
- **2025-06-30:** Precompiled Linux builds
- **2025-06-29:** New 5:4 aspect ratio, new low contrast grey theme and more cameras support (DJI Mavic lineup)
- **2025-06-28:** Release cleanup, CI/CD improvements and minor fixes
- **2025-06-27:** Initial release. For more information about the earlier progress, look at the [Initial Development Log](#initial-development-log)

</details>
</details>

<details>
<summary><strong>Table of Contents</strong></summary>

- [Showcase & Edits](#showcase--edits)
- [The Idea](#the-idea)
- [Key Features](#key-features)
- [Supported Formats, Lenses & Languages](#supported-formats-lenses--languages)
- [Current Priorities](#current-priorities)
- [AI Roadmap](#ai-roadmap)
- [Initial Development Log](#initial-development-log)
- [Getting Started](#getting-started)
- [Camera Tethering](#camera-tethering)
- [Command Line Interface (CLI)](#command-line-interface-cli)
- [System Requirements](#system-requirements)
- [Contributing](#contributing)
- [Special Thanks](#special-thanks)
- [Support the Project](#support-the-project)
- [License & Philosophy](#license--philosophy)

</details>

---

## Showcase & Edits

Watch RapidRAW in action:

<p align="center">
  <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/editor.jpg" alt="Upstream RapidRAW desktop editor showing a photograph and adjustment controls">
</p>

_Desktop screenshot from upstream RapidRAW. The MCP interface is an addition maintained in this fork._

**[AI editing test report](docs/ai-editing-experiments.md):** what we tested on a 16 GB GPU and how we chose the current workflows.

**Removal coverage and protection:** desktop and MCP removal controls separate core expansion from the outer blend. Preview the effective mask before running local inpaint or generative editing, and use subtractive components to protect retained details. The same native mask is used for generation and final compositing. See the [removal workflow](skills/rapidraw-mcp/references/generative-editing.md#native-removal-coverage-and-protection).

**[ComfyUI integration guide](docs/comfyui.md):** one connector for generative editing and optional depth, tested ComfyUI revisions, GPU memory guidance and [downloadable chosen workflows](ai-connector/workflows/README.md).

For repeated MCP editing and test runs, see [storage and model-cache guidance](mcp/README.md#runtime-contract).

**Shape light, colour and depth:** [three optional editing tools](docs/creative-selections.md) help you shape directional light, select surface colours across light and shadow, and adjust nearer or more distant parts of a photo. Pick colours on the photograph, choose a light direction or a depth starting range, then refine the edit with local controls. Saved analysis works offline in native previews and exports. These source-build tools use Marigold through the [shared AI connector](ai-connector/MARIGOLD.md) and are disabled by default.

**Local Edits:** manage masked repairs and adjustments together, refine each selection, rename/duplicate/copy/paste edits and selection components, and copy supported selections between edit types while keeping the edits independent. Shape Light and Surface Colour selections are adjustment-only. Generative repairs use the active crop and return to the original photo geometry.

## Choose your starting point

| You want to…                                                      | Start here                                                                                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit photographs directly in a desktop application                | [Desktop guide](docs/desktop-guide.md) and [fork application downloads](https://github.com/sheldonxxxx/RapidRAW/releases/latest)                                                             |
| Let an AI agent use RapidRAW's native engine                      | Install a fork release package and connect the pinned npm host with the [agent setup guide](AGENT_SETUP.md) (package-first normal path; source build is the fallback)                        |
| Give your agent an editing workflow and a place to review results | Start with [Lightweft](https://github.com/sheldonxxxx/lightweft), then add RapidRAW as an optional execution tool                                                                            |
| Prepare saved Insta360 files before editing                       | Use the independent [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit), then follow the [spherical handoff guide](skills/rapidraw-mcp/references/spherical-photos.md) |

**Fork packages include the native MCP bridge.** Choose a matching asset from the [fork releases](https://github.com/sheldonxxxx/RapidRAW/releases), then connect the pinned npm host [`@sheldonxxxx/rapidraw-mcp@0.2.0`](AGENT_SETUP.md) without cloning this repository. Upstream application downloads do not contain this fork's bridge. Fresh-machine acceptance of packaged MCP downloads has not been established; the source-build workflows retain their recorded test boundaries. The server uses your MCP client's model; it does not include a language model or a hosted editing service.

Apple Silicon builds require macOS 14 or later and bundle ONNX Runtime 1.30.0 for local AI inference. The published 0.4.0 Intel Mac packages retain the existing runtime; subsequent releases no longer package Intel Macs. See the [runtime and hardware guide](docs/local-enhancement.md#apple-silicon-runtime).

**Apple Silicon Beta 1 installation:** the published package has an incomplete bundle signature and can be reported as damaged. See the [installation troubleshooting guide](docs/desktop-guide.md#macos-beta-1-signature-error).

**First beta:** `fork-v0.1.0-beta.1`, installed as **RapidRAW MCP** with separate application preferences and model storage. See the [release notes](docs/releases/0.1.0-beta.1.md) for installation and beta limits.

## What an agent can do

- **Develop the photograph:** exposure, white balance, colour, curves, crop, perspective, lens corrections, presets and LUTs through the native RAW pipeline.
- **Work selectively:** AI subject, sky, foreground and depth selections; point-guided refinement; additive and subtractive brush repairs; geometric and range masks.
- **Review actual pixels:** original and edited previews, matched alternatives, mask overlays, native detail crops, histograms and regional measurements.
- **Keep edits recoverable:** revision guards, undo/redo, named versions, independent session forks, portable bundles, recipes and saved native sidecars.
- **Finish and deliver:** local retouch, BM3D/AI denoise, background operations, batch exports, explicit sRGB profile handling and high-precision 16-bit TIFF output.

The desktop AI panel and MCP also offer [local mask and detail enhancement](docs/local-enhancement.md): learned edge refinement, scene and portrait-part masks, experimental motion deblur and conservative 2× enlargement. Optional model assets run locally, with profiles for smaller computers and Linux NVIDIA servers.

The desktop **Inpaint studio** offers 1–4 variations, automatically applies the final result when a full batch finishes, and keeps click-to-apply history for each edit. It accepts up to four reference images with supporting Qwen Image 2.1 and Klein edit workflows. Compatible AI Connectors also expose workflow, AI resolution and seed choices in Local Edits and generative MCP retouch. Actual generation dimensions stay with the patch when the provider supplies them. Set up the included [Comfy Connector](ai-connector/README.md) and see the [generative editing controls](docs/desktop-guide.md#generative-editing-controls) for resolution and compatibility details. These controls require a current build of this fork.

The optional AI Connector automatically [matches small repair colour differences at selection boundaries](ai-connector/README.md#automatic-repair-colour-matching) and also supports the **Qwen Image 2.1** removal workflow; see its [model and node requirements](ai-connector/README.md#qwen-image-21).

For removal, recolouring, adding objects and lettering, follow the [AI editing workflows](docs/ai-editing-workflows.md). Start with Klein 4B at 1 MP and compare the rendered result before changing models or resolution.

Current source builds expose **66 MCP tools** over stdio. Local AI operations need their model assets installed. HDR, focus merging, panorama and negative conversion are also exposed, with photographic acceptance limits documented in the [historical capability snapshot](docs/mcp/history/capability-matrix-2026-09.md). The live `rapidraw_capabilities` response defines the available tools and schemas for your build.

## Connect an agent

1. Install a fork release package and connect the pinned npm host using the [agent setup guide](AGENT_SETUP.md). Source builds via the [source-build fallback](mcp/README.md#build-and-connect) or the [Linux GPU server guide](docs/mcp/remote-ssh.md) remain the fallback for development or unsupported platforms.
2. Optionally install the execution skill:

   ```sh
   npx skills add sheldonxxxx/RapidRAW --skill rapidraw-mcp
   ```

3. Reconnect your MCP client and call `rapidraw_capabilities`. Installing the skill alone does not connect the engine.
4. Start with one photograph and a clear brief. Review the original, an edited overview and native detail before exporting.

For example:

> Edit this landscape for natural evening light. Preserve the original and its sidecar, show me a restrained edit beside a warmer alternative, and export the chosen result with an editable session.

The [execution skill](skills/rapidraw-mcp/SKILL.md) covers state, masks, comparisons and delivery. It works with a direct brief or your preferred art-direction skill; Lightweft supplies an optional shared workflow around it.

## Three independent projects, one connected workflow

| Project                                                                   | Responsibility                                                               | Handoff                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Lightweft](https://github.com/sheldonxxxx/lightweft)                     | Central workspace for direction, review and personal style                   | An image-specific brief and rendered candidates for comparison |
| **RapidRAW + MCP**                                                        | Native photographic editing, persistent state and exports                    | Previews, editable sessions, recipes and delivery files        |
| [Insta360 AI Toolkit](https://github.com/sheldonxxxx/insta360-ai-toolkit) | Postprocessing saved Insta360 media and preparing verified photo derivatives | A stitched sphere or selected flat reframe for editing         |

Each project has its own installation, dependencies and repository. RapidRAW does not require either companion. When combined, the agent coordinates their file handoffs; installing one project does not automatically install or configure the others.

RapidRAW edits the pixels it receives. Camera-native fisheye stitching and spherical reframing belong to the preparation tool. Review a full sphere's seams and poles and verify its final projection metadata after editing; the [handoff guide](skills/rapidraw-mcp/references/spherical-photos.md) explains the boundary.

## Tested configurations and current limits

| Configuration                                                 | Evidence and setup                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS with Metal, native debug build                          | Native editing, state, rendering and export acceptance in the [historical verification snapshot](docs/mcp/history/verification-2026-09.md); [setup](mcp/README.md#build-and-connect) |
| Debian 13 x86-64, NVIDIA GPU, SSH and Xvfb                    | Exercised server workflow documented in the [Linux guide](docs/mcp/remote-ssh.md); this is a specific tested configuration                                                           |
| Optional Linux ONNX CUDA inference                            | Foreground/sky masks, depth and AI denoise via the pinned x86_64 runtime pack; [model policy and runtime setup](docs/mcp/onnx-cuda.md)                                               |
| Windows, packaged MCP releases and fresh-machine installation | No completed native acceptance claim                                                                                                                                                 |

Without the pinned NVIDIA runtime pack, existing mask and denoise operations default to CPU on every platform; with the pack installed, an unset provider defaults to CUDA (an explicit `cpu` is always preserved). Their Linux CUDA support is opt-in and separate from GPU photo rendering; subject selection and local inpainting retain CPU compatibility paths.

For GPU RAW denoising on an NVIDIA server, the optional [Nonlocal backend](denoise/README.md) integrates with MCP background jobs. It produces a Bayer DNG that uses RapidRAW's normal demosaic and colour pipeline, with captured edits in a separate session. The existing lightweight NIND option remains available. Nonlocal runs in-process through native ONNX Runtime from a pinned installed bundle (`RAPIDRAW_NONLOCAL_PROVIDER`: unset defaults to Linux CUDA and macOS CoreML, `cpu` is explicit), or directly through CoreML.framework on macOS (`RAPIDRAW_NONLOCAL_PROVIDER=coreml`); install it once with `install_model kind="nonlocal"` (`RAPIDRAW_NONLOCAL_BUNDLE` remains an explicit manual-bundle override); it is experimental, and commercial parity has not been established.

Passing an operation or test does not establish the quality of a photograph. Fine hair/feather masks, wide panorama framing, genuine HDR/focus brackets and film-negative quality have remaining acceptance gaps. See the [historical verification snapshot](docs/mcp/history/verification-2026-09.md), [historical capability snapshot](docs/mcp/history/capability-matrix-2026-09.md) and [historical gap assessment](docs/mcp/history/gap-assessment-2026-09.md) for precise boundaries; the live `rapidraw_capabilities` response defines the available tools and schemas for your build. Upstream platform availability is separate from this fork's MCP testing.

## Originals, privacy and local state

MCP editing uses isolated working copies in a workspace you choose. Original images and existing sidecars remain read-only to the workflow. Working files, model assets and saved exports are stored on the machine running the engine. With SSH, that is the server's filesystem.

Your MCP host receives requested previews and structured results, so choose its model and data handling accordingly. Model installation downloads local assets. Remote generative retouch is a separate, explicitly selected provider operation that sends image content and requires authorization and configuration.

Exports go under the MCP workspace's `exports` directory; replacing an existing export requires an explicit overwrite option. GPS stripping defaults on. These MCP protections are described in the [preservation contract](mcp/README.md#preservation-and-error-behavior); the desktop application and original export CLI have their own file-management behaviour.

## Documentation and contributions

| Guide                                                           | Use it for                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [MCP setup and tool reference](mcp/README.md)                   | Builds, connections, examples, preservation and recovery                        |
| [Desktop guide](docs/desktop-guide.md)                          | Standalone editing, build commands, CLI export and tethering                    |
| [Local masks and detail enhancement](docs/local-enhancement.md) | Native learned masks, experimental deblur, 2× enlargement and hardware profiles |
| [AI editing workflows](docs/ai-editing-workflows.md)            | Choose a use-case workflow, write a precise prompt and inspect generative edits |
| [Execution skill](skills/rapidraw-mcp/SKILL.md)                 | Agent editing, mask review, comparisons and delivery                            |
| [Portable sessions and presets](docs/mcp/portable-sessions.md)  | Independent alternatives, reusable looks and moving edits                       |
| [Geometry and review](docs/mcp/geometry-review.md)              | Coordinate mapping, native detail and diagnostic previews                       |
| [Testing and evidence](docs/mcp/testing.md)                     | Reproducing protocol, native and photographic checks                            |
| [Contribution guide](CONTRIBUTING.md)                           | Reporting issues and proposing changes                                          |
| [Native integration guide](MCP.md)                              | Developing the optional bridge and merging upstream changes                     |
| [Fork changelog](CHANGELOG.md)                                  | Additions and fixes, with unreleased changes identified                         |

Report fork/MCP issues in [this repository](https://github.com/sheldonxxxx/RapidRAW/issues). Contributions that improve edit quality, recovery, installation and reproducible photographic review are welcome.

## Credits and license

RapidRAW was created by [Timon Käch](https://github.com/CyberTimon). This fork preserves the original editor and adds its optional MCP integration. Follow [upstream RapidRAW](https://github.com/CyberTimon/RapidRAW) for the original application's releases, development history and community, or [support the original author](https://ko-fi.com/cybertimon).

RapidRAW and this fork are licensed under [AGPL-3.0](LICENSE). See the [acknowledgments](docs/acknowledgments.md) for the libraries, models and communities behind the project.

```bash
# macOS (Homebrew)
brew install libgphoto2 pkg-config

# Linux (Ubuntu / Debian)
sudo apt-get install -y libgphoto2-dev pkg-config
```

Then run or build using the `tethering` feature flag:

```bash
# Development mode with Tethering
npm run start:tethering
# or: npm start -- -- --features tethering

# Release build with Tethering
npm run tauri build -- --features tethering
```

</details>

## Camera Tethering

RapidRAW includes camera tethering for studio, portrait, and product photography workflows. Connect your camera via USB to control exposure settings, monitor your shot in real time, and automatically ingest files directly into your workspace.

<table width="100%">
  <tr>
    <td width="65%" valign="top">
      <h3>Key Capabilities</h3>
      <ul>
        <li><strong>Real-Time Live View:</strong> High-frame-rate live view with composition guides, 90° rotation, and horizontal flip.</li>
        <li><strong>Full Camera Control:</strong> Adjust Aperture, Shutter Speed, ISO, White Balance, Exposure Compensation, Exposure Mode, and Metering Mode directly from RapidRAW.</li>
        <li><strong>Autofocus Control:</strong> Trigger autofocus directly from RapidRAW.</li>
        <li><strong>Ghost Overlay:</strong> Overlay previous captures with adjustable opacity to maintain consistent framing and perspective.</li>
        <li><strong>Battery Monitoring:</strong> View the connected camera's battery level directly in RapidRAW.</li>
        <li><strong>Automatic Presets:</strong> Automatically apply a selected preset to newly captured images.</li>
        <li><strong>Instant Ingestion:</strong> Captured images are automatically saved to your active library, indexed, and optionally opened in the editor.</li>
        <br>
      </ul>
    </td>
    <td width="35%" valign="top" align="center">
      <br>
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/tethering.jpeg" alt="RapidRAW Camera Tethering Setup" width="100%" style="border-radius: 8px;">
      <br><br>
      <strong>Live Camera Tethering</strong><br>
      <sub>Sony α7 III connected with real-time Live View</sub>
    </td>
  </tr>
</table>

### Supported Cameras

Tethering is powered by **[libgphoto2](http://gphoto.org/)** and supports over **2,500+ camera models** across Canon, Nikon, Sony, Fujifilm, Olympus, Panasonic, and other manufacturers.

- **[View the Full List of Supported Cameras](http://gphoto.org/proj/libgphoto2/support.php)**

> **Note:** Ensure your camera's USB connection mode is set to **PC Remote**, **Tether Shooting**, or **PTP** in the camera settings.

### Platform Support & Installation

Tethering is supported on **macOS** and **Linux**. Windows and Android are not supported.

<details>
<summary><strong>Why Does Tethering Require a Separate Build?</strong></summary>

The tethering build dynamically links directly against `libgphoto2`. If these system libraries are not present on a machine, an executable linked against them will fail to launch entirely. This fork does not publish a tethering-enabled package; build from source with the `tethering` feature after installing the system dependencies below.

</details>

<details>
<summary><strong>Why is Windows Unsupported?</strong></summary>

`libgphoto2` is designed for POSIX environments and requires direct low-level access via `libusb`. On Windows, connected cameras are claimed by the operating system's native Windows Portable Device (WPD) drivers. Interfacing with `libgphoto2` on Windows requires overriding OEM drivers with WinUSB (using tools like Zadig), which breaks standard file transfer and camera utilities. Because of these driver conflicts and platform limitations, Windows is fully unsupported.

</details>

#### Setting up the Tethering Build

For a tethering-enabled source build, you **must install `libgphoto2` on your machine first**.

<details>
<summary><strong>How to install libgphoto2 dependencies</strong></summary>

**macOS (via Homebrew):**

```bash
brew install libgphoto2 pkg-config
```

**Linux (Ubuntu / Debian):**

```bash
sudo apt-get update
sudo apt-get install -y libgphoto2-dev pkg-config
```

**Linux (Arch Linux):**

```bash
sudo pacman -S libgphoto2 pkgconf
```

**Linux (Fedora):**

```bash
sudo dnf install libgphoto2-devel pkgconf-pkg-config
```

</details>

After installing the system dependencies, run/build from source using the `tethering` feature flag.

## Command Line Interface (CLI)

RapidRAW includes a headless export tool for batch processing photos in automated scripts, terminal pipelines, or server environments without opening the GUI:

```bash
# Export an entire folder using edits found in .rrdata sidecar files
rapidraw export /path/to/photos --output /path/to/output_dir --format jpeg --quality 90

# Export a single image directly to a specific target file
rapidraw export /path/to/photo.raw --output /path/to/output.png --format png

# Export a true 16-bit TIFF (the TIFF default; use 8 for an RGB8 TIFF)
rapidraw export /path/to/photo.raw --output /path/to/output.tiff --format tiff --tiff-bit-depth 16

# Batch export a folder using a custom adjustments JSON file to override sidecars
rapidraw export /path/to/photos --output /path/to/output_dir --adjustments /path/to/preset.json
```

> **Note:** By default, headless export automatically detects and applies edits stored in `.rrdata` sidecar files located alongside your source images. You can override sidecars for all exported images by passing a custom JSON file using the `--adjustments` flag.

| Option                 | Description                                                            | Default           |
| :--------------------- | :--------------------------------------------------------------------- | :---------------- |
| `<source>`             | Path to an image file or directory containing images                   | _(Required)_      |
| `--output <path>`      | Target directory or specific output file path                          | _(Required)_      |
| `--format <fmt>`       | Output format (`jpeg`, `png`, `webp`, `avif`, `tiff`, `jxl`, `cube`)   | `jpeg`            |
| `--quality <1-100>`    | Image export quality                                                   | `90`              |
| `--tiff-bit-depth <n>` | TIFF channel depth (`8` or `16`)                                       | `16`              |
| `--keep-metadata`      | Retain EXIF/capture metadata in exported files                         | `false`           |
| `--adjustments <path>` | Path to a custom JSON file containing adjustments to override sidecars | _(Auto-detected)_ |

## System Requirements

The RapidRAW 0.4.0 fork packages support these minimum operating systems:

- **Apple Silicon Mac:** macOS 14 or newer
- **Intel Mac:** macOS 13 (Ventura) or newer
- **Linux x86_64:** Ubuntu 22.04 or a compatible modern distribution

These requirements describe the fork's release packages. Source-build targets are a separate path; Windows packaged support and fresh-machine installation have not been verified for this fork.

Intel Mac support above applies to the published 0.4.0 packages. The release workflow no longer builds Intel Mac packages for subsequent versions.

**Hardware Recommendations:**

- **RAM:** **16GB or more is highly recommended.** While the application may run on systems with less memory, performance is best with 16GB+ to handle high-resolution RAW files, undo history, and complex layer masking without slowdowns.
- **GPU:** A dedicated GPU is recommended. RapidRAW relies heavily on GPU acceleration for its processing pipeline. Very old GPU architectures (generally pre-2015) or older integrated graphics may struggle, leading to instability or graphical artifacts.

### Common Problems

<details>
<summary>App crashes when opening an image / entering edit mode</summary>

If the application crashes immediately when you try to start editing a picture, it is often due to the automatic selection of the GPU backend.

1.  Open **Settings** on the **Home Screen** (Gear icon).
2.  Navigate to the **Processing** tab.
3.  Locate the **Processing Backend** setting.
4.  Change it from **Auto** to a specific backend supported by your OS (e.g., **Vulkan**, **DirectX12**, **OpenGL**, or **Metal**).
5.  Restart the application and try opening the image again. Experiment with different backends if the first one doesn't work.

</details>

<details>
<summary>Linux Wayland/WebKit Crash</summary>

If RapidRAW crashes on Wayland (e.g. GNOME + NVIDIA), try launching it with:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 RapidRAW
```

or

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 RapidRAW
```

This issue is related to **WebKit** and **NVIDIA drivers**, not RapidRAW directly. Switching to **X11** or using **AMD / Intel GPUs** may also help.

See [#306](https://github.com/CyberTimon/RapidRAW/issues/306) for more information.

</details>

## Contributing

I’m really grateful for any contributions you make to RapidRAW! Whether you’re reporting a bug, suggesting a new feature, or submitting a pull request - your input helps shape the project and makes it better for everyone. Don’t hesitate to open an issue or share your ideas.

### Image format issues

If your camera’s RAW files aren’t supported, please open a issue here first: [rawler issues](https://github.com/dnglab/dnglab/issues). Once support is added in rawler, create a issue for RapidRAW so I can update the packages and keep everything in sync.

## Special Thanks

A huge thank you to the following projects and tools that were very important in the development of RapidRAW:

- **[Google AI Studio](https://aistudio.google.com):** For providing amazing assistance in researching, implementing image processing algorithms and giving an overall speed boost.
- **[rawler](https://github.com/dnglab/dnglab/tree/main/rawler):** For the excellent Rust crate that provides the foundation for RAW file processing in this project.
- **[lensfun](https://lensfun.github.io/):** For its invaluable open-source library and comprehensive database for automatic lens correction.
- **[LaMa](https://github.com/advimman/lama):** For the powerful & simple image inpainting model, which enables content-aware fill and object removal.
- **[SAM 2](https://github.com/facebookresearch/sam2):** For providing the foundation model used for the AI subject detection capabilities.
- **[U-2-Net](https://github.com/xuebinqin/U-2-Net):** For providing the robust architecture used for the AI sky and foreground detection capabilities.
- **[Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2):** For the powerful monocular depth estimation model that enables the AI depth masking capabilities.
- **[nind-denoise](https://github.com/trougnouf/nind-denoise):** For providing AI models that power the AI noise reduction capabilities in RapidRAW.
- **[NegPy](https://github.com/marcinz606/NegPy):** For the inspiration behind the negative conversion logic, particularly the mathematical approach to film inversion using characteristic curves.
- **[pixls.us](https://discuss.pixls.us/):** For being an incredible community full of knowledgeable people who offered inspiration, advice, and ideas.
- **[darktable & co.](https://github.com/darktable-org/darktable):** For some reference implementations that guided parts of this work.
- **[libgphoto2](http://gphoto.org/):** For the comprehensive camera communication library powering RapidRAW's tethering and remote capture subsystem.
- **[spektrafilm](https://github.com/andreavolpato/spektrafilm):** For the spectrally-based film emulation LUTs by Andrea Volpato, used to power RapidRAW's built-in film emulations.
- **You:** For using and supporting RapidRAW. Your interest keeps this project alive and evolving.

## Support the Project

As a young developer balancing this project with an apprenticeship, your support means the world. If you find RapidRAW useful or exciting, please consider donating to help me dedicate more time to its development and cover any associated costs.

- **Ko-fi:** [Donate on Ko-fi](https://ko-fi.com/cybertimon)
- **Crypto:**
  - BTC: `36yHjo2dkBwQ63p3YwtqoYAohoZhhUTkCJ` (min. 0.0001)
  - ETH: `0x597e6bdb97f3d0f1602b5efc8f3b7beb21eaf74a` (min. 0.005)
  - SOL: `CkXM3C777S8iJX9h3MGSfwGxb85Yx7GHmynQUFSbZXUL` (min. 0.01)

## License & Philosophy

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. I chose this license to ensure that RapidRAW and any of its derivatives will always remain open-source and free for the community. It protects the project from being used in closed-source commercial software, ensuring that improvements benefit everyone.

See the [LICENSE](LICENSE) file for more details.
