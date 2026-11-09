# PixCut

Dua alat imej dalam satu halaman, semuanya diproses **di dalam pelayar** — tiada fail
dimuat naik ke pelayan.

**Live:** https://danielhafiz438-coder.github.io/pixcut/

- **Naik taraf imej** — 2× / 4× menggunakan resample Lanczos (pica) + unsharp mask.
- **Buang latar** — dua mod:
  - **AI** — model segmentasi ISNet (`@imgly/background-removal`) berjalan melalui
    WebAssembly/ONNX Runtime dalam tab anda.
  - **Warna** — flood fill dari tepi imej untuk latar rata/kosong. Segera, tanpa muat turun.

Tiada backend, tiada API imej, tiada pangkalan data.

## Struktur

```
index.html            UI (tab, dropzone, hasil)
assets/style.css      Gaya
assets/app.js         Logik upsample + remove background
assets/pica.min.mjs   Pica 10.0.3 (MIT) — vendored supaya tiada CDN
server.mjs            Pelayan statik untuk ujian tempatan
```

## Jalankan tempatan

```bash
npm install          # hanya untuk pica (vendoring)
npm run dev          # http://localhost:4321
```

`assets/pica.min.mjs` sudah disertakan dalam repo, jadi `npm install` hanya perlu
jika mahu mengemas kini pica (`npm run vendor`).

## Deploy

**Netlify** — repo ini statik sepenuhnya. `netlify.toml` sudah menetapkan
`publish = "."`. Import repo di Netlify, atau:

```bash
npx netlify deploy --prod --dir=.
```

**GitHub Pages** — Settings → Pages → Deploy from branch → `main` / `/ (root)`.

## Nota teknikal

- Had input naik taraf: 12 MP; had output: 64 MP.
- Mod AI memuat turun model (~40 MB) dari CDN pada penggunaan pertama, kemudian
  disimpan dalam cache HTTP pelayar. Inferens berlaku pada peranti.
- Output naik taraf: PNG jika sumber mungkin telus, JPEG (0.92) untuk JPEG asal.
- Output buang latar: PNG dengan saluran alfa.

## Lesen

Kod: MIT. Pica: MIT. Model ISNet: AGPL-3.0 (melalui `@imgly/background-removal`)
— semak lesen tersebut jika digunakan secara komersial.
