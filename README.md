<p align="center">
  <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/editor.png" alt="RapidRAW Editor">
</p>

<div align="center">

[![Rust](https://img.shields.io/badge/rust-%23000000.svg?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB)](https://react.dev/)
[![Tauri](https://img.shields.io/badge/Tauri-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=for-the-badge)](https://opensource.org/licenses/AGPL-3.0)
[![GitHub stars](https://img.shields.io/github/stars/CyberTimon/RapidRAW?style=for-the-badge&logo=github&label=Stars)](https://github.com/CyberTimon/RapidRAW/stargazers)

</div>

# RapidRAW

> A beautiful, non-destructive, and GPU-accelerated RAW image editor built with performance in mind.

RapidRAW is a modern, high-performance alternative to Adobe Lightroom®. It delivers a simple, beautiful editing experience in a lightweight package (under 20MB) for Windows, macOS, and Linux.

I developed this project as a personal challenge at the age of 18. My goal was to create a high-performance tool for my own photography workflow while deepening my understanding of both React and Rust, with the support from Google Gemini.

<table width="100%">
  <tr>
    <td width="50%" valign="top" align="center">
      <br>
      <a href="https://github.com/CyberTimon/RapidRAW/releases/latest">
        <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/main/src-tauri/icons/full_res_original.png" alt="Download RapidRAW" height="96">
      </a>
      <h3>Download RapidRAW</h3>
      <p>Get the latest release for Windows, macOS, and Linux. Packaged and ready to run.</p>
      <strong><a href="https://github.com/CyberTimon/RapidRAW/releases/latest">Download Latest Version →</a></strong>
      <br><br>
    </td>
    <td width="50%" valign="top" align="center">
      <br>
      <a href="https://github.com/CyberTimon/RapidRAW-Docs">
        <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/main/src-tauri/icons/docs.png" alt="Read the Docs" height="96">
      </a>
      <h3>Read the Docs</h3>
      <p>Learn how to use RapidRAW with step-by-step tutorials, from adjustments to masking.</p>
      <strong><a href="https://github.com/CyberTimon/RapidRAW-Docs">View Tutorials & Examples →</a></strong>
      <br><br>
    </td>
  </tr>
</table>

Have fun!

<details>
<summary><strong>For Who Is This?</strong></summary>
RapidRAW is for photographers who love to edit their photos in a <strong>clean, fast, and simple workflow</strong>. It prioritizes speed, a beautiful user interface, and powerful tools that let you achieve your creative color vision quickly.
<br><br>
It is <strong>not</strong> for users who seek absolute, perfect color accuracy. While the results are great for most purposes, the focus is on a fluid, creative process rather than perfect color precision.
<br><br>
RapidRAW is still in active development and isn't yet as polished as mature tools like Darktable, RawTherapee, or Adobe Lightroom®. Right now, the focus is on building a fast, enjoyable core editing experience. You may encounter bugs - if you do, please report them so I can fix them :) Your feedback really helps!
<br><br>
</details>
<details>
<summary><strong>Recent Changes</strong></summary>

*   **2025-12-07:** Write EXIF metadata to file
*   **2025-12-07:** Color picker for white balance
*   **2025-11-30:** HSL luminance artifacts fix
*   **2025-11-29:** Improved mask stacking & many bug fixes
*   **2025-11-28:** QOI support
*   **2025-11-25:** Update rawler
*   **2025-11-23:** Recursive library view to display images from all subfolders
*   **2025-11-22:** DNG loader improvements
*   **2025-11-18:** Improved vibrancy adjustment
*   **2025-11-15:** Virtual copies & library improvements

<details>
<summary><strong>Expand further</strong></summary>

*   **2025-11-14:** Open-with-file cross plattform compatibilty & single instance lock
*   **2025-11-13:** Rewritten tagging system to support pill-like image tagging
*   **2025-11-10:** Improved folder tree with search functionality
*   **2025-11-08:** Added EXR file format support
*   **2025-11-XX:** Improving AgX
*   **2025-11-02:** Optimize image loading & add processing engine settings
*   **2025-10-31:** Expose highlights compression point to user & improve keybinds detection
*   **2025-10-28:** Copy paste settings & brightness adjustment
*   **2025-10-XX:** Working on tonemapping - ongoing...
*   **2025-10-24:** Getting AgX right isn't as easy as it seems :=)
*   **2025-10-22:** AgX tone mapping
*   **2025-10-19:** Whole image mask component & organize mask components better
*   **2025-10-19:** You can now apply presets to masks & improved auto adjustments
*   **2025-10-17:** New centré adjustment, rawler now as a submodule & improved logger
*   **2025-10-15:** Ability to pin folders, improved session handling & smooth library thumbnail updating
*   **2025-10-11:** Realistic, complex & non-dulling exposure & highlights slider
*   **2025-10-11:** Smooth filmstrip thumbnail updates
*   **2025-10-07:** New watermarking support
*   **2025-10-06:** Improve crop quality by transforming before scaling
*   **2025-10-XX:** Many small improvements - ongoing...
*   **2025-09-27:** Sort library by exif metadata & release cleanup / bug fixes
*   **2025-09-26:** Collage maker to create unique collages with many different layouts, spacing & border radius
*   **2025-09-23:** Color calibration tool to adjust RGB primaries & adjustments visibility settings
*   **2025-09-22:** Issue template & CI/CD improvements
*   **2025-09-20:** Universal presets importer, prioritize dGPU & improved local contrast tools (sharpness, clarity etc.)
*   **2025-09-17:** Automatic image culling (duplicate & blur detection)
*   **2025-09-14:** Grid previews in community panel & improved ComfyUi workflow
*   **2025-09-12:** New community presets panel to share & showcase presets
*   **2025-09-10:** Extended generative AI roadmap & started building RapidRAW website
*   **2025-09-09:** Many shader improvements & bug fixes, invert tint slider
*   **2025-09-06:** New update notifier that alerts users when a new version becomes available
*   **2025-09-04:** Added toggleable clipping warnings (blue = shadows, red = highlights)
*   **2025-09-02:** Transition to Rust 2024 & Cache image on GPU
*   **2025-08-31:** Cancel thumbnail generation on folder change & optimized ai patch saving  
*   **2025-08-30:** Optimize ComfyUI image transfer & speed
*   **2025-08-28:** Chromatic aberration correction & Shader improvements
*   **2025-08-26:** User customisable ComfyUI workflow selection
*   **2025-08-25:** Make LUTs parser more robust (support more advanced formats)
*   **2025-08-24:** Improved keyboard shortcuts
*   **2025-08-23:** Estimate file size before exporting
*   **2025-08-21:** Added LUTs (.cube, .3dl, .png, .jpg, .jpeg, .tiff) support
*   **2025-08-16:** Fast AI sky masks
*   **2025-08-15:** Show full resolution image when zooming in
*   **2025-08-15:** Implement Tauri's IPC as a replacement for the slow Base64 image transfer
*   **2025-08-12:** Relative zoom indicator
*   **2025-08-11:** TypeScript cleanup & many bug fixes
*   **2025-08-09:** Local inpainting without the need for ComfyUI, ability to change thumbnail aspect ratio
*   **2025-08-09:** Frontend refactored to TypeScript thanks to @varjolintu
*   **2025-08-08:** New onnxruntime download strategy & the base for local inpainting
*   **2025-08-05:** Improved HSL cascading, UI & animation improvements, ability to grow & shrink / feather AI masks
*   **2025-08-03:** New high performance, seamless image panorama stitcher (without any dependencies on OpenCV)
*   **2025-08-02:** Added an image straightening tool and improved crop & rotation functionality (especially on portrait images)
*   **2025-08-02:** A new dedicated image importer, ability to rename and batch rename files, improved dark theme, and other fixes
*   **2025-07-31:** Ability to tag & filter images by color labels, refactored image right clicking
*   **2025-07-31:** Reimplemented the functionality of GPU processing (GPU cropping, etc.) -> No longer dependent on TEXTURE_BINDING_ARRAY
*   **2025-07-29:** Refactored generative AI foundation, many small fixes
*   **2025-07-27:** Automatic AI image tagging, overall mask transparency setting per mask
*   **2025-07-25:** Fuji RAF X-Trans sensor support (new x-trans demosaicing algo)
*   **2025-07-24:** Auto crop when cropping an image (to prevent black borders), added drag & drop sort abilty to presets panel
*   **2025-07-22:** Significant improvements to the shader: More accurate exposure slider, better tone mapper (simplified ACES)
*   **2025-07-21:** Remember scroll position when going into the editing section
*   **2025-07-20:** Ability to add presets to folders, export preset folders etc, preset _animations_
*   **2025-07-20:** Tutorials on how to use RapidRAW
*   **2025-07-19:** Initial color negative conversion implementation, shader improvements
*   **2025-07-19:** New color wheels, persistent collapsed / expanded state for UI elements
*   **2025-07-19:** Fixed banding & purple artefacts on RAW images, better color noise reduction, show exposure in stops
*   **2025-07-18:** Smooth zoom slider, new adaptive editor theme setting
*   **2025-07-18:** New export functionality: Export with metadata, GPS metadata remover, batch export file naming scheme using tags
*   **2025-07-18:** Ability to delete the associated RAW/JPEG in right click delete operations
*   **2025-07-17:** Small bug fixes
*   **2025-07-13:** Native looking titlebar and ability to input precise number into sliders
*   **2025-07-13:** Huge update to masks: You can now add multiple masks to a mask containers, subtract / add / combine masks etc.
*   **2025-07-12:** Improved curves tool, more shader improvements, improved handling of very large files
*   **2025-07-11:** More accurate shader, reorganized main library preferences dropdown, smoother histogram, more realistic film grain
*   **2025-07-11:** Added a HUD-like waveform overlay toggle to display specific channel waveforms (w-key)
*   **2025-07-10:** Rewritten batch export system and async thumbnail generation (makes the loading of large folders a lot more fluid)
*   **2025-07-10:** Window transparency can now be toggled in the settings, thanks to @andrewazores
*   **2025-07-08:** Ability to toggle the visibility of individual adjustments sections
*   **2025-07-08:** Fixed top-left zoom bug, corrected scale behavior in crop panel, keep default original aspect ratio
*   **2025-07-08:** Added image rating filter and redesigned the metadata panel with improved layout, clearer sections, and an embedded GPS map
*   **2025-07-07:** Improved generative AI features and updated [AI Roadmap](#ai-roadmap)
*   **2025-07-06:** Initial generative AI integration with [ComfyUI](https://github.com/comfyanonymous/ComfyUI) - for more details, checkout the [AI Roadmap](#ai-roadmap)
*   **2025-07-05:** Ability to overwrite preset with current settings
*   **2025-07-04:** High speed and precise cache to significantly accelerate large image editing
*   **2025-07-04:** Greatly improved shader with better dehaze, more accurate curves etc
*   **2025-07-04:** Predefined 90° clockwise rotation and ability to flip images
*   **2025-07-03:** Switched from [rawloader](https://github.com/pedrocr/rawloader) to [rawler](https://github.com/dnglab/dnglab/tree/main/rawler) to support a wider range of RAW formats
*   **2025-07-02:** AI-powered foreground / background masking
*   **2025-06-30:** AI-powered subject masking
*   **2025-06-30:** Precompiled Linux builds
*   **2025-06-29:** New 5:4 aspect ratio, new low contrast grey theme and more cameras support (DJI Mavic lineup)
*   **2025-06-28:** Release cleanup, CI/CD improvements and minor fixes
*   **2025-06-27:** Initial release. For more information about the earlier progress, look at the [Initial Development Log](#initial-development-log)

</details>
</details>
<br>

**Table of Contents**
- [Key Features](#key-features)
- [Demo & Screenshots](#demo--screenshots)
- [The Idea](#the-idea)
- [Current Priorities](#current-priorities)
- [AI Roadmap](#ai-roadmap)
- [Initial Development Log](#initial-development-log)
- [Getting Started](#getting-started)
- [System Requirements](#system-requirements)
- [Contributing](#contributing)
- [Special Thanks](#special-thanks)
- [Support the Project](#support-the-project)
- [License & Philosophy](#license--philosophy)

---

## Key Features

<table width="100%">
  <tr>
    <td valign="top" width="50%">
      <h4>Core Editing Engine</h4>
      <ul>
        <li><strong>GPU-Accelerated Processing:</strong> All image adjustments are processed on the GPU using a custom WGSL shader for rapid feedback.</li>
        <li><strong>Masking:</strong> Create masks with AI subject, sky and foreground detection. Combine with traditional Brush, Linear, and Radial masks for great control.</li>
        <li><strong>Generative Edits:</strong> Remove objects or add new elements with text prompts. Each edit creates a non-destructive patch layer, powered by an optional ComfyUI backend.</li>
        <li><strong>Full RAW Support:</strong> Supports a wide range of RAW camera formats thanks to rawler.</li>
        <li><strong>Non-Destructive Workflow:</strong> All edits are stored in a <code>.rrdata</code> sidecar file, leaving your original images untouched.</li>
        <li><strong>32-bit Precision:</strong> Ensures high-quality adjustments without banding or data loss.</li>
      </ul>
      <h4>Professional Grade Adjustments</h4>
      <ul>
        <li><strong>Tonal Controls:</strong> Exposure, Contrast, Highlights, Shadows, Whites, and Blacks.</li>
        <li><strong>Tone Curves:</strong> Full control over Luma, Red, Green, and Blue channels.</li>
        <li><strong>Color Grading:</strong> Temperature, Tint, Vibrance, Saturation, and a full HSL color mixer.</li>
        <li><strong>Detail Enhancement:</strong> Sharpening, Clarity, Structure, and Noise Reduction.</li>
        <li><strong>Effects:</strong> LUTs, Dehaze, Vignette, and Film Grain simulation.</li>
        <li><strong>Transform Tools:</strong> Crop with aspect ratio locking, Rotate, and Flip.</li>
      </ul>
    </td>
    <td valign="top" width="50%">
      <h4>Library & Workflow</h4>
      <ul>
        <li><strong>Image Library:</strong> Effortlessly sort, rate, tag, and manage your entire photo collection for a streamlined and efficient workflow.</li>
        <li><strong>Folder Management:</strong> Integrated folder tree, create, rename, and delete folders directly within the app.</li>
        <li><strong>File Operations:</strong> Import, copy, move, rename, and duplicate images and their associated edits.</li>
        <li><strong>Filmstrip View:</strong> Quickly navigate between all the images in your current folder while editing.</li>
        <li><strong>Batch Operations:</strong> Save significant time by applying a consistent set of adjustments or exporting entire batches of images simultaneously.</li>
        <li><strong>EXIF Data Viewer:</strong> Gain insights by inspecting the complete metadata from your camera, including shutter speed, aperture, ISO, and lens information.</li>
      </ul>
      <h4>Productivity & UI</h4>
      <ul>
        <li><strong>Preset System:</strong> Create, save, import, and export your favorite looks.</li>
        <li><strong>Copy & Paste Settings:</strong> Quickly transfer adjustments between images.</li>
        <li><strong>Undo/Redo History:</strong> A robust history system for every edit.</li>
        <li><strong>Customizable UI:</strong> Resizable panels and multiple beautiful UI themes with smooth animations.</li>
        <li><strong>Panorama Stitcher:</strong> Seamlessly combine multiple images into a wide panorama.</li>
        <li><strong>Exporting:</strong> Control file format, quality, naming scheme, metadata, resizing options on export.</li>
      </ul>
    </td>
  </tr>
</table>

## Demo & Screenshots

Here's RapidRAW in action.

<p align="center">
  <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/editor.gif" alt="The main editor interface in action"></img><br>
  <em>The main editor interface in action.</em>
</p>
<br>
<table width="100%">
  <tr>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/batch.gif" alt="Powerful batch operations and export" style="max-width: 100%;">
      <br>
      <em>Powerful batch operations and export.</em>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/customization.gif" alt="Customizable editor layout and panels" style="max-width: 100%;">
      <br>
      <em>Customizable editor layout and panels.</em>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/masks.gif" alt="Advanced masking to speedup workflow" style="max-width: 100%;">
      <br>
      <em>Advanced masking to speedup workflow.</em>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/ai.gif" alt="Experimental generative AI features" style="max-width: 100%;">
      <br>
      <em>Experimental generative AI features.</em>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/library.gif" alt="Library navigation and folder management" style="max-width: 100%;">
      <br>
      <em>Library navigation and folder management.</em>
    </td>
    <td width="50%" align="center">
      <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/themes.gif" alt="Beautiful themes and UI customization" style="max-width: 100%;">
      <br>
      <em>Beautiful themes and UI customization.</em>
    </td>
  </tr>
</table>

> If you like the theme images and want to see more of my own images, checkout my Instagram: [**@timonkaech.photography**](https://www.instagram.com/timonkaech.photography/)

## The Idea

#### The Motivation
As a photography enthusiast, I often found existing software to be sluggish and resource-heavy on my machine. Born from the desire for a more responsive and streamlined photo editing experience, I set out to build my own. The goal was to create a tool that was not only fast but also helped me learn the details of digital image processing and camera technology.

#### The Challenge
I set an ambitious goal to rapidly build a functional, feature-rich application from an empty folder. This personal challenge pushed me to learn quickly and focus intensely on the core architecture and user experience.

#### The Process
The foundation is built on Rust for its safety and performance, and Tauri for its ability to create lightweight, cross-platform desktop apps with a web frontend. The entire image processing pipeline is offloaded to the GPU via WGPU and a custom WGSL shader, ensuring that even on complex edits with multiple masks, the UI remains fluid.

I am **immensely grateful for Google's Gemini suite of AI models.** As an 18-year-old without a formal background in advanced mathematics or image science, the AI Studio's free tier was an invaluable assistant, helping me research and implement concepts like the Menon demosaicing algorithm.

## Current Priorities

While the core functionality is in place, I'm actively working on improving several key areas. Here's a transparent look at the current focus:

| Task                                                                                         | Priority | Difficulty | Status |
|----------------------------------------------------------------------------------------------|----------|------------|--------|
| Find a better X-Trans demosaicing algorithm                                                  | Medium  | High     | [ ]    |
| Refactoring the frontend (reduce prop drilling in React components)                         | Low  | Medium     | [ ]    |
| Write a tutorial on how to connect ComfyUI with RapidRAW                                    | Medium | Medium       | [ ]    |
| Centralize Coordinate Transformation Logic - See [#245](https://github.com/CyberTimon/RapidRAW/issues/245) | Medium      | High | [ ]    |
| Improve speed on older systems (e.g. Pascal GPUs)                                            | Medium   | High       | [ ]    |
| Implement warping tools                                                                     | Low  | High       | [ ]    |

## AI Roadmap

I've designed RapidRAW's AI features with flexibility in mind. You have three ways to use them, giving you the choice between fast local tools, powerful self-hosting, and simple cloud convenience.

### 1. Built-in AI Tools (Local & Free)

These features are integrated directly into RapidRAW and run entirely on your computer. They are fast, free, and require no setup from you.

*   **AI Masking:** Instantly detect and mask subjects, skies, and foregrounds.
*   **Automatic Tagging:** The image library is automatically tagged with keywords using a local CLIP model, making your photos easy to search.
*   **Simple Generative Replace:** A basic, CPU-based inpainting tool for removing small distractions.

### 2. Self-Hosted Integration with ComfyUI (Local & Free)

For users with a capable GPU who want maximum control, I've made it so RapidRAW can connect to your own local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server.

*   **Full Control:** Use your own hardware and any custom Stable Diffusion model or workflow you choose.
*   **Cost-Free Power:** Leverage your existing hardware for advanced generative edits at no extra cost.
*   **Custom Workflow Selection:** Import your own ComfyUI workflows and use your custom nodes.

### 3. Optional Cloud Service (Subscription)

To be clear, **I won't lock features behind a paywall.** All of RapidRAW's functionality is available for free if you use the built-in tools or self-host.

However, I realize that not everyone has the powerful hardware or technical desire to set up and maintain their own ComfyUI server. For those who want a simpler solution, I will be offering an optional **$5/month subscription** (pricing is not final).

This is purely a **convenience service**. It provides the **same high-quality results** as a self-hosted setup without any of the hassle - just log in, and it works. Subscribing is also the best way to support the project and help me dedicate more time to its development.

| Feature                 | Built-in AI (Free)                               | Self-Hosted (ComfyUI)                               | Optional Cloud Service                           |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------ |
| **Cost**                | Free, included                                   | Free (requires your own hardware)                   | $5 / month                                   |
| **Setup**               | None                                             | Manual ComfyUI server setup                         | None (Just log in)                           |
| **Use Case**            | Everyday workflow acceleration                   | Full control for technical users                    | Maximum convenience                          |
| **Status**              | **Available**                                    | **Available**                                       | Coming Soon                                 |

<details>
<summary><strong>Click to see the Generative AI features in action</strong></summary>
<br>
<p align="center">
  <img src="https://raw.githubusercontent.com/CyberTimon/RapidRAW/assets/.github/assets/ai.gif" alt="Experimental generative AI features" style="max-width: 100%;">
  <br>
  <em>Generative Replace, which can be powered by either a local ComfyUI backend or the upcoming optional cloud service.</em>
</p>
</details>

## Initial Development Log

This project began as an intensive sprint to build the core functionality. Here's a summary of the initial progress and key milestones:

<details>
<summary><strong>Click to expand the day-by-day development log</strong></summary>

*   **Day 1: June 13th, 2025** - Project inception, basic Tauri setup, and initial brightness/contrast shader implementation.
*   **Day 2: June 14th** - Core architecture refactor, full library support (folder tree, image list), and optimized image loading. Implemented histogram and curve editor support. Added UI themes.
*   **Day 3: June 15th** - Implemented a working crop tool, preset system, and context menus. Enabled auto-saving of edits to sidecar files and auto-thumbnail generation. Refined color adjustments.
*   **Day 4: June 16th** - Initial prototype for local adjustments with masking. Added mask support to presets. Bug-free image preview switching.
*   **Day 5: June 17th** - Major UI overhaul. Created the filmstrip and resizable panel layout. Fixed mask scaling issues and improved the library/welcome screen.
*   **Day 6: June 18th** - Performance tuning. Reduced GPU calls for adjustments, leading to a much smoother cropping and editing experience. Implemented saving of panel UI state.
*   **Day 7: June 19th** - Enhanced library functionality. Added multi-selection and the ability to copy/paste adjustments across multiple images.
*   **Day 8: June 20th** - Implemented initial RAW file support and an EXIF metadata viewer.
*   **Day 9: June 21st** - Added advanced detail adjustments (Clarity, Sharpening, Dehaze, etc.) and film grain. Developed a linear RAW processing pipeline.
*   **Day 10: June 22nd** - Implemented layer stacking for smooth preview transitions. Built a robust export panel with batch export capabilities. Added import/export for presets.
*   **Day 11: June 23rd** - Added full undo/redo functionality integrated with a custom history hook. Improved context menus and completed the settings panel.
*   **Day 12: June 24th** - Implemented image rotation and fixed all mask scaling/alignment issues related to cropping and rotation.
*   **Day 13: June 25th** - Rewrote the mask system to be bitmap-based. Implemented brush and linear gradient tools, with semi-transparent visualization.
*   **Day 14: June 26th-27th** - Final polish. Added universal keyboard shortcuts, full adjustment support for masks, theme management, and final UI/UX improvements. This ReadMe.

</details>

## Getting Started

You have two options to run RapidRAW:

**1. Download the Latest Release (Recommended)**

**Windows & macOS:**
- Grab the pre-built installer or application bundle for your operating system from the [**Releases**](https://github.com/CyberTimon/RapidRAW/releases) page.

**Linux:**
- The official Flatpak package supports all Linux distributions and is available on [Flathub](https://flathub.org/apps/io.github.CyberTimon.RapidRAW).
- On Debian-based distributions, install the `.deb` package from the [**Releases**](https://github.com/CyberTimon/RapidRAW/releases) page.
- On Arch-based distributions, use the [`rapidraw-bin`](https://aur.archlinux.org/packages/rapidraw-bin) package from the AUR.

**2. Build from Source**

If you want to build the project yourself, you'll need to have [Rust](https://www.rust-lang.org/tools/install) and [Node.js](https://nodejs.org/) installed.

```bash
# 1. Clone the repository (including the rawler/dnglab submodule)
git clone https://github.com/CyberTimon/RapidRAW.git --recurse-submodules
cd RapidRAW

# 2. Install frontend dependencies
npm install

# 3. Build and run the application
npm start
```

## System Requirements

RapidRAW is built to be lightweight and cross-platform. The minimum (tested) requirements are:

*   **Windows:** Windows 10 or newer
*   **macOS:** macOS 13 (Ventura) or newer
*   **Linux:** Ubuntu 22.04+ or a compatible modern distribution

### Common Problems
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

I’m really grateful for any contributions you make to RapidRAW! Whether you’re reporting a bug, suggesting a new feature, or submitting a pull request - your input helps shape the project and makes it better for everyone. Don’t hesitate to open an issue or start a discussion to share your ideas.  

### Image format issues
If your camera’s RAW files aren’t supported, please open a issue here first: [rawler issues](https://github.com/dnglab/dnglab/issues). Once support is added in rawler, create a issue for RapidRAW so I can update the packages and keep everything in sync.  

### Feature requests
Got an idea? Add it in the discussion tab with the **"idea"** tag. This way, the community can vote on features they'd love to see, and I can focus on the most impactful ones.  

### Stale issues
To keep things tidy and relevant, please update your issue if the issue still exists with the latest release. Issues with no updates after 4-6 weeks will be closed as stale.

Thank you for contributing your time and ideas - every bit of feedback makes RapidRAW a stronger and more useful project!  

## Special Thanks

A huge thank you to the following projects and tools that were very important in the development of RapidRAW:

*   **[Google AI Studio](https://aistudio.google.com):** For providing amazing assistance in researching, implementing image processing algorithms and giving an overall speed boost.
*   **[rawler](https://github.com/dnglab/dnglab/tree/main/rawler):** For the excellent Rust crate that provides the foundation for RAW file processing in this project.
*   **[pixls.us](https://discuss.pixls.us/):** For being an incredible community full of knowledgeable people who offered inspiration, advice, and ideas.
*   **[darktable & co.](https://github.com/darktable-org/darktable):** For some reference implementations that guided parts of this work.
*   **You:** For using and supporting RapidRAW. Your interest keeps this project alive and evolving.

## Support the Project

As an 18-year-old developer balancing this project with an apprenticeship, your support means the world. If you find RapidRAW useful or exciting, please consider donating to help me dedicate more time to its development and cover any associated costs.

-   **Ko-fi:** [Donate on Ko-fi](https://ko-fi.com/cybertimon)
-   **Crypto:**
    -   BTC: `36yHjo2dkBwQ63p3YwtqoYAohoZhhUTkCJ` (min. 0.0001 because of broker)
    -   ETH: `0x597e6bdb97f3d0f1602b5efc8f3b7beb21eaf74a` (min. 0.005 because of broker)
    -   SOL: `CkXM3C777S8iJX9h3MGSfwGxb85Yx7GHmynQUFSbZXUL` (min. 0.01 because of broker)

## License & Philosophy

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. I chose this license to ensure that RapidRAW and any of its derivatives will always remain open-source and free for the community. It protects the project from being used in closed-source commercial software, ensuring that improvements benefit everyone.

See the [LICENSE](LICENSE) file for more details.
