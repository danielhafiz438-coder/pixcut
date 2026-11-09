# PixCut

Two image tools on one page, with every byte of processing happening **in the visitor's browser** —
no uploads, no accounts, no analytics.

**Live:** https://danielhafiz438-coder.github.io/pixcut/

- **Upscale** — two engines:
  - **Lanczos** (pica): 2× / 4× resample + unsharp mask. Instant.
  - **AI super-res** (ESRGAN via UpscalerJS): adds real detail at 2×, processed in 256 px
    tiles with 32 px overlap so memory stays bounded and seams disappear.
- **Remove background** — two modes:
  - **AI**: ISNet segmentation model (`@imgly/background-removal`) on WebAssembly/ONNX Runtime.
  - **Colour**: flood fill from the edges for flat or studio backdrops. Instant, no download.

## Structure

```
index.html            Liquid-glass UI: floating glass bar, centred hero, glass cards
assets/style.css      Material, layout, responsive rules
assets/app.js         Upscale + background removal logic, clipboard paste, toasts
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

## Technical notes

- Upscale limits: 48 MP input (Lanczos), 12 MP input (AI — about 1–1.5 min per MP).
- Output limit: 192 MP, and 16384 px on the long side. 2× of a 48 MP photo fits; 4× of one does not.
- AI engine: ESRGAN 2× model (~1 MB) from a CDN, cached after the first run. Expect roughly
  60–90 s per 1 MP on a mid-range laptop. A 12 MP photo can take 10–20 minutes; the row shows tile progress.
- AI mode does not offer 4× directly; run it twice or use Lanczos 4×.
- Background removal downloads a ~40 MB segmentation model on first use, then the browser caches it.
- Output: PNG when the image has transparency, JPEG 0.92 otherwise.

## Licence

Code: MIT. Pica: MIT. UpscalerJS + default model: MIT. ISNet (via `@imgly/background-removal`):
AGPL-3.0 — review that licence before using this commercially.
