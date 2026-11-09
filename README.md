# PixCut

Dua alat imej dalam satu halaman, semuanya diproses **di dalam pelayar** — tiada fail
dimuat naik ke pelayan.

**Live:** https://danielhafiz438-coder.github.io/pixcut/

- **Naik taraf imej** — dua enjin:
  - **Lanczos** (pica) — resample 2×/4× + unsharp mask. Segera.
  - **AI super-res** (ESRGAN melalui UpscalerJS) — menambah butiran sebenar pada 2×,
    diproses berjubin 256px supaya memori terkawal.
- **Buang latar** — dua mod:
  - **AI** — model segmentasi ISNet (`@imgly/background-removal`) berjalan melalui
    WebAssembly/ONNX Runtime dalam tab anda.
  - **Warna** — flood fill dari tepi imej untuk latar rata/kosong. Segera, tanpa muat turun.

Tiada backend, tiada API imej, tiada pangkalan data.

## Struktur

```
index.html            UI: header putih, hero tengah, workarea kelabu (gaya iLoveIMG)
assets/style.css      Gaya
assets/app.js         Logik upsample + remove background
assets/pica.min.mjs   Pica 10.0.3 (MIT) — vendored supaya tiada CDN
server.mjs            Pelayan statik untuk ujian tempatan
```

Susun atur meniru iLoveIMG (header 60px, H1 42/600, butang utama #4d90fe radius 12,
workarea #f5f5fa) tetapi dengan brand, ikon dan teks sendiri; nav hanya menyenaraikan
alat yang benar-benar ada.

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

- Had input naik taraf: 12 MP (Lanczos), 1 MP (AI, sebab masa pemprosesan).
- Enjin AI: model ESRGAN 2× (~1 MB) dari CDN, dimuat turun sekali. Imej dipecah
  kepada jubin 256px dengan pertindihan 32px lalu dicantum — tiada garis sambungan.
  Anggaran 60–90 saat untuk 1 MP pada CPU/GPU bersepadu kelas pertengahan.
- Mod AI tidak menyokong 4× secara langsung; jalankan dua kali atau guna Lanczos 4×.
- Buang latar AI memuat turun model segmentasi (~40 MB) dari CDN pada penggunaan
  pertama, kemudian disimpan dalam cache HTTP pelayar.
- Output naik taraf: PNG jika ada ketelusan, JPEG (0.92) jika tiada.
- Output buang latar: PNG dengan saluran alfa.

## Lesen

Kod: MIT. Pica: MIT. Model ISNet: AGPL-3.0 (melalui `@imgly/background-removal`)
— semak lesen tersebut jika digunakan secara komersial.
