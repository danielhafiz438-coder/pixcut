# PixCut

One screen: **drop an image → press Upscale or Remove background → Download.** Every byte of
processing happens in the visitor's browser — no uploads, no accounts, no analytics.

**Live:** https://danielhafiz438-coder.github.io/pixcut/

## The flow

1. Drop an image anywhere on the page (or click the drop zone, or press <kbd>Ctrl</kbd>+<kbd>V</kbd>).
2. The original shows up as a preview, with its pixel size and file size.
3. Press **Upscale** (2× or 4×) or **Remove background**.
4. The result appears next to the original, over a transparency checkerboard.
5. Press **Download** — the file name carries the operation, e.g. `photo_2x.jpg` or `photo_no-bg.png`.
6. **Start over** clears everything; dropping another image replaces the current one.

There are no option panels: the only choice left is 2× / 4×. Sharpening, encoding and the
cut-out mode are picked automatically.

## What each action does

- **Upscale** — Lanczos resampling with an unsharp mask (pica), 2× or 4×. Instant, no model
  download. PNG out when the source has transparency, JPEG (q 0.92) otherwise.
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

## Limits

- Input: 48 MP per image (memory, not patience).
- Output: 192 MP and 16384 px on the longest side — 2× of a 48 MP photo fits, 4× does not.
  The hint under the toolbar shows the exact output size, and Upscale is disabled when the
  chosen factor would exceed the cap.
- Background removal keeps the original resolution.

## Licence

Code: MIT. Pica: MIT. ISNet (via `@imgly/background-removal`): AGPL-3.0 — review that licence
before using this commercially.
