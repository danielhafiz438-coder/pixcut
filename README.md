# PixCut

One screen: **drop an image → press Upscale or Remove background → Download.** Every byte of
processing happens in the visitor's browser — no uploads, no accounts, no analytics.

**Live:** https://danielhafiz438-coder.github.io/pixcut/

## The flow

1. Drop an image anywhere on the page (or click the drop zone, or press <kbd>Ctrl</kbd>+<kbd>V</kbd>).
2. The original shows up as a preview, with its pixel size and file size.
3. Press **Upscale 2×** (instant), **AI enhance** (slower, rebuilds detail) or **Remove background**
   — one button each, no settings.
4. The result appears next to the original, over a transparency checkerboard.
5. **Download** sits in the result header; the file name carries the operation,
   e.g. `photo_2x.jpg` or `photo_no-bg.png`.
6. Need more resolution? **Try 4× instead** re-runs from the original. **Open full size**
   opens the result in a new tab to check it at 100%.
7. **Start over** clears everything; dropping another image replaces the current one.

Shortcuts: <kbd>U</kbd> upscale, <kbd>B</kbd> background, <kbd>D</kbd> download.

Sharpening, encoding and the cut-out mode are picked automatically.

## What each action does

- **Upscale 2×** — Lanczos resampling with an unsharp mask (pica). About a second, no model
  download. It adds pixels and edge contrast; it cannot invent detail that was never captured.
  PNG out when the source has transparency, JPEG (q 0.92) otherwise.
- **AI enhance** — Real-ESRGAN (`realesr-general-x4v3`, BSD-3-Clause) through ONNX Runtime
  Web, in a module worker so the page stays responsive. WebGPU when the browser has it,
  WebAssembly otherwise, with one automatic CPU retry if the GPU dies mid-run. The model is
  fixed at 4×; a 2× result is the 4× output downscaled, which still beats a native 2× model.
  Measured in Chrome on a laptop GPU: 320×240 → 2× in 3.1 s, → 4× in 3.2 s; 1200×900 → 2×
  in 37.9 s (≈35 s/MP). Capped at 4 MP for 2× and 1.5 MP for 4×, with tile progress and a
  Cancel button that takes effect immediately because inference is off the main thread.
  The 4.7 MB model is committed under `assets/models/` so no third-party host is involved. The model is ~1 MB and is
  cached by the browser after the first run. PNG out when the source has transparency
  (alpha is resampled separately), otherwise JPEG q 0.94.
- **Remove background** — ISNet segmentation (`@imgly/background-removal`) inside a module
  worker so the UI stays responsive; the ~40 MB model is downloaded once and cached by the
  browser. If the model cannot load (offline, blocked CDN), it falls back automatically to a
  flood-fill cut-out based on the background colour, so the button always produces something.

## Structure

```
index.html            One-screen studio: drop zone, before/after previews, toolbar
assets/style.css      Liquid-glass material, layout, responsive rules
assets/app.js         Decoding, previews, upscaling, background removal, drag & drop, paste
assets/bg-worker.js   Module worker for the segmentation model
assets/pica.min.mjs   Pica 10.0.3 (MIT), vendored so no CDN is needed
assets/ai-worker.js    Real-ESRGAN worker: ONNX Runtime Web, tiled, WebGPU/WASM
assets/models/        realesr-general-x4v3.onnx (4.7 MB, BSD-3-Clause)
server.mjs            Dev-only static server
```

## Run locally

```bash
npm install      # only needed to re-vendor pica
npm run dev      # http://localhost:4321
```

`assets/pica.min.mjs` is committed, so `npm install` is only required when updating pica
(`npm run vendor`).

## Deploy

Static hosting, no build step.

**GitHub Pages** — Settings → Pages → Deploy from branch → `main` / `/ (root)`.

**Netlify** — `netlify.toml` already sets `publish = "."`; import the repo or run
`npx netlify deploy --prod --dir=.`.

## Interface notes

- Liquid-glass surfaces over an aurora backdrop, one accent colour, system font stack — no
  webfont to download.
- **Light is the default.** The sun/moon button in the header switches to dark and remembers the
  choice in `localStorage` (`data-theme` on `<html>`, no flash on load). Every text pair clears WCAG AA
  (body 16.5:1 light / 17.5:1 dark, muted labels 6.4:1 / 7.5:1, links 6.8:1 / 11.5:1).
- One primary action per state: before a result it is Upscale, afterwards it is the
  Download button in the result header (Upscale steps back to a secondary style).
- Every control is keyboard reachable with a visible focus ring; the drop zone is a real
  button (`role="button"`, Enter/Space) and progress is announced through `aria-live`.
- **Compare at 100%** opens the same crop twice — original enlarged by the browser next to
  the result at 1:1, taken from the busiest part of the image — because a fit-to-screen
  preview cannot show what upscaling did.
- Motion is limited to a 300 ms result reveal and is disabled under
  `prefers-reduced-motion`.

## Limits

- Input: 48 MP per image (memory, not patience).
- AI enhance: 6 MP input (time, not memory) — 2× output, tile progress, cancellable.
- Output: 192 MP and 16384 px on the longest side — 2× of a 48 MP photo fits, 4× does not.
  The hint under the toolbar shows the exact output size, and Upscale is disabled when the
  chosen factor would exceed the cap.
- Background removal keeps the original resolution.

## Licence

Code: MIT. Pica: MIT. Real-ESRGAN weights (`realesr-general-x4v3`): BSD-3-Clause — the
`.onnx` here is a single-file conversion of the official weights (Hugging Face
`vlad-grig/realesr-general-x4v3-onnx`), not the Qualcomm static-shape export. ONNX Runtime
Web: MIT. ISNet (via `@imgly/background-removal`): AGPL-3.0 — review that licence before
using this commercially.
