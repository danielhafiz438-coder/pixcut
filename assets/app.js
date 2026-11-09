import Pica from './pica.min.mjs';

const REPO_URL = 'https://github.com/danielhafiz438-coder/pixcut';
const MAX_INPUT_MP = 12;          // had input untuk naik taraf
const MAX_OUTPUT_MP = 64;         // had output selepas pembesaran
const AI_CDN = 'https://esm.sh/@imgly/background-removal@1.7.0';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pica = new Pica();
let repoLink = $('#repoLink');
if (repoLink) repoLink.href = REPO_URL;

/* ------------------------------------------------------------------ */
/*  Tab                                                                */
/* ------------------------------------------------------------------ */

const HERO = {
  upscale: {
    title: 'Upscale image',
    sub: 'Increase resolution up to 4× with a local AI model or Lanczos resampling, right in your browser.',
  },
  bg: {
    title: 'Remove background',
    sub: 'Cut out the subject from JPG and PNG images with a segmentation model that runs on your device.',
  },
};

function setTab(name) {
  $$('.navitem[data-tab]').forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $$('.tool-panel').forEach(p => {
    const on = p.id === `panel-${name}`;
    p.classList.toggle('is-active', on);
    p.hidden = !on;
  });
  const hero = HERO[name] || HERO.upscale;
  if ($('#heroTitle')) $('#heroTitle').textContent = hero.title;
  if ($('#heroSub')) $('#heroSub').textContent = hero.sub;
  if ($('#uploaderUpscale')) $('#uploaderUpscale').hidden = name !== 'upscale';
  if ($('#uploaderBg')) $('#uploaderBg').hidden = name !== 'bg';
}
$$('.navitem[data-tab]').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
const initialTab = location.hash === '#bg' ? 'bg' : 'upscale';
setTab(initialTab);

/* ------------------------------------------------------------------ */
/*  Util                                                               */
/* ------------------------------------------------------------------ */

const fmtBytes = n => n < 1024
  ? `${n} B`
  : n < 1048576
    ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;

const baseName = name => name.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_');

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Failed to encode image')), type, quality);
  });
}

/** Semak sama ada imej benar-benar ada piksel lutsinar. */
function hasTransparency(source) {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 96;
  const ctx = probe.getContext('2d');
  ctx.drawImage(source, 0, 0, 96, 96);
  const d = ctx.getImageData(0, 0, 96, 96).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 240) return true;
  return false;
}

/** Isi trek slider ikut nilai semasa (--p dipakai oleh CSS). */
function syncRangeFill(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', `${pct}%`);
}

/** Sambungkan dropzone: klik, Enter/Space, drag & drop. */
function wireDropzone(zone, input, onFiles) {
  const open = () => input.click();
  zone.addEventListener('click', open);
  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  });
  let depth = 0;
  ['dragenter', 'dragover'].forEach(evt =>
    zone.addEventListener(evt, e => {
      e.preventDefault();
      if (evt === 'dragenter') depth++;
      zone.classList.add('is-drag');
    }));
  ['dragleave', 'drop'].forEach(evt =>
    zone.addEventListener(evt, e => {
      e.preventDefault();
      if (evt === 'dragleave' && --depth > 0) return;
      depth = 0;
      zone.classList.remove('is-drag');
    }));
  zone.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) onFiles(files);
  });
}

const loadBitmap = file => createImageBitmap(file);

/* ------------------------------------------------------------------ */
/*  Sumber input: butang bulat, tampal papan klip, notifikasi          */
/* ------------------------------------------------------------------ */

let toastTimer = null;

function toast(msg) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

function wireSourceButtons(input, pick, paste, onFiles) {
  pick?.addEventListener('click', e => {
    e.stopPropagation();
    input.click();
  });
  paste?.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          onFiles([new File([blob], `tampal.${type.split('/')[1]}`, { type })]);
          return;
        }
      }
      toast('No image found in the clipboard.');
    } catch {
      toast('The browser blocked clipboard access — press Ctrl+V on this page instead.');
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Alat 1 — Naik taraf imej                                           */
/* ------------------------------------------------------------------ */

const resultsEl = $('#resultsUpscale');
const controlsU = $('#upscaleControls');
const btnUpscale = $('#btnUpscale');
const inputUpscale = $('#inputUpscale');

let scale = 2;
let sharpen = 35;
let engine = 'lanczos';
const queue = [];   // { id, file, status, blob, w, h, ow, oh, thumb }

/** AI super-res sentiasa 2× (model dilatih pada skala itu). */
const outScale = () => (engine === 'ai' ? 2 : scale);

$$('#engineSeg .seg').forEach(b => b.addEventListener('click', () => {
  $$('#engineSeg .seg').forEach(x => x.classList.toggle('is-active', x === b));
  engine = b.dataset.engine;
  $('#scaleControl').hidden = engine === 'ai';
  $('#upscaleHint').innerHTML = engine === 'ai'
    ? 'The AI engine uses an ESRGAN model (~1&nbsp;MB, downloaded once) that adds real detail instead of interpolating. Output is 2×; input is limited to ' + AI_MAX_MP + '&nbsp;MP and each tile takes a few seconds.'
    : 'Use 2× for large images, 4× for icons or small images. Input limit 12&nbsp;MP per image.';
  updateDimLabels();
  queue.forEach(renderRow);
}));

$$('#scaleSeg .seg').forEach(b => b.addEventListener('click', () => {
  $$('#scaleSeg .seg').forEach(x => x.classList.toggle('is-active', x === b));
  scale = Number(b.dataset.scale);
  updateDimLabels();
}));

$('#sharpen').addEventListener('input', e => {
  sharpen = Number(e.target.value);
  $('#sharpenVal').textContent = sharpen;
  syncRangeFill(e.target);
});

function updateDimLabels() {
  queue.forEach(item => {
    const meta = $(`#meta-${item.id}`);
    if (meta && item.ow && item.status !== 'done' && item.status !== 'error') {
      meta.innerHTML = dimHtml(item.ow, item.oh, item.ow * outScale(), item.oh * outScale());
    }
  });
}

function dimHtml(ow, oh, nw, nh) {
  return `<b>${ow}×${oh}</b> → <b>${nw}×${nh}</b>${nw * nh > 40e6 ? ' · besar' : ''}`;
}

let seq = 0;

function addFiles(files) {
  const rejected = [];
  for (const file of files) {
    const item = { id: `r${++seq}`, file, status: 'queued', ow: 0, oh: 0 };
    queue.push(item);
    const li = document.createElement('li');
    li.className = 'result';
    li.id = `row-${item.id}`;
    li.innerHTML = `
      <div class="thumb"><img alt=""></div>
      <div class="result-body">
        <div class="result-name"></div>
        <div class="result-meta" id="meta-${item.id}">Sedia</div>
      </div>
      <div class="result-action"></div>`;
    $('.result-name', li).textContent = file.name;
    resultsEl.appendChild(li);
    renderRow(item);
    inspectImage(item).catch(() => rejected.push(file.name));
  }
  controlsU.hidden = queue.length === 0;
  if (rejected.length) console.warn('Imej tidak dapat dibaca:', rejected);
}

async function inspectImage(item) {
  const bmp = await loadBitmap(item.file);
  item.ow = bmp.width;
  item.oh = bmp.height;
  item.bmp = bmp;
  const mp = (bmp.width * bmp.height) / 1e6;
  if (mp > MAX_INPUT_MP) {
    item.status = 'error';
    item.error = `Too large (${mp.toFixed(1)} MP, limit ${MAX_INPUT_MP} MP)`;
  }
  $(`#row-${item.id} .thumb img`).src = bmpToDataUrl(bmp, 54);
  const meta = $(`#meta-${item.id}`);
  if (item.status !== 'error' && meta) {
    meta.innerHTML = dimHtml(bmp.width, bmp.height, bmp.width * outScale(), bmp.height * outScale());
  }
  renderRow(item);
}

function bmpToDataUrl(bmp, size) {
  const c = document.createElement('canvas');
  const s = Math.min(bmp.width, bmp.height);
  c.width = c.height = size * 2;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function renderRow(item) {
  const action = $(`#row-${item.id} .result-action`);
  if (!action) return;
  const meta = $(`#meta-${item.id}`);
  if (item.status === 'error') {
    if (meta) meta.textContent = item.error;
    action.innerHTML = '';
    return;
  }
  if (item.status === 'working') {
    if (meta) meta.textContent = item.statusText || 'Processing…';
    action.innerHTML = '<span class="spinner" role="status" aria-label="Processing"></span>';
    return;
  }
  if (item.status === 'done') {
    if (meta) {
      meta.innerHTML = dimHtml(item.ow, item.oh, item.w, item.h) +
        ` · result <b>${fmtBytes(item.blob.size)}</b>`;
    }
    action.innerHTML = '<button class="btn btn-primary" type="button">Download</button>';
    $('button', action).addEventListener('click', () => {
      const ext = item.blob.type === 'image/jpeg' ? 'jpg' : 'png';
      download(item.blob, `${baseName(item.file.name)}_${item.scale}x${item.engineTag ? '-' + item.engineTag : ''}.${ext}`);
    });
    return;
  }
  action.innerHTML = '';
}

async function upscaleItem(item) {
  if (item.status === 'error') return;
  item.status = 'working';
  item.statusText = 'Processing…';
  renderRow(item);
  if (engine === 'ai') return upscaleItemAI(item);
  try {
    const bmp = item.bmp || await loadBitmap(item.file);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    if ((w * h) / 1e6 > MAX_OUTPUT_MP) throw new Error(`Output terlalu besar (${w}×${h})`);

    const src = document.createElement('canvas');
    src.width = bmp.width;
    src.height = bmp.height;
    src.getContext('2d').drawImage(bmp, 0, 0);

    const dst = document.createElement('canvas');
    dst.width = w;
    dst.height = h;

    await pica.resize(src, dst, {
      unsharpAmount: Math.round(sharpen * 2.2),
      unsharpRadius: 0.6,
      unsharpThreshold: 2,
    });

    const hasAlpha = hasTransparency(dst);
    const blob = hasAlpha
      ? await canvasToBlob(dst, 'image/png')
      : await canvasToBlob(dst, 'image/jpeg', 0.92);

    item.blob = blob;
    item.scale = scale;
    item.w = w;
    item.h = h;
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.error = err.message || 'Failed';
  }
  renderRow(item);
}

/* ------------------------------------------------------------------ */
/*  Enjin AI — Swin? Tidak: ESRGAN melalui UpscalerJS (TFJS/WebGL)     */
/* ------------------------------------------------------------------ */

const AI_MAX_MP = 1;          // had input untuk mod AI (masa pemprosesan)
const AI_TILE = 256;          // saiz jubin input
const AI_OVERLAP = 32;        // pertindihan antara jubin (elak garis sambung)
const AI_CDN_SR = 'https://cdn.jsdelivr.net/npm/upscaler@1.0.0/+esm';

let aiModulePromise = null;

/** Import modul UpscalerJS (dimuat turun sekali, disimpan dalam cache pelayar). */
function getUpscalerModule() {
  if (!aiModulePromise) {
    aiModulePromise = import(AI_CDN_SR)
      .then(mod => mod.default ? mod : (mod.Upscaler ? { default: mod.Upscaler } : mod))
      .catch(err => {
        aiModulePromise = null;
        throw new Error('Model AI gagal dimuat turun (' + (err.message || err) + ')');
      });
  }
  return aiModulePromise;
}

// Jeda ringkas untuk benarkan UI dilukis. JANGAN guna requestAnimationFrame:
// ia tidak dijalankan langsung pada tab latar belakang, jadi proses akan tersekat.
const nextFrame = () => new Promise(r => setTimeout(r, 16));

// diagnostik ringkas (?debug=1): rakam langkah ke window.__dbg
const DBG = new URLSearchParams(location.search).has('debug');
const dbg = (...a) => { if (DBG) (window.__dbg ||= []).push(a.join(' ')); };

function dataUrlToBlob(url) {
  const comma = url.indexOf(',');
  const header = url.slice(0, comma);
  const mime = (header.match(/:(.*?);/) || [, 'image/png'])[1];
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function imageFromUrl(url) {
  // createImageBitmap jauh lebih stabil daripada <img>.decode() untuk data URL
  return createImageBitmap(dataUrlToBlob(url));
}

/** Naik taraf satu imej dengan model AI (jubin + jahitan). */
async function upscaleItemAI(item) {
  try {
    const bmp = item.bmp || await loadBitmap(item.file);
    const mp = (bmp.width * bmp.height) / 1e6;
    if (mp > AI_MAX_MP) {
      throw new Error(`AI is limited to ${AI_MAX_MP} MP (this image is ${mp.toFixed(1)} MP) — use Lanczos`);
    }

    item.statusText = 'Loading AI model…';
    renderRow(item);
    dbg('getUpscaler start');
    const mod = await getUpscalerModule();
    dbg('getUpscaler ok', typeof mod.default);

    const src = document.createElement('canvas');
    src.width = bmp.width;
    src.height = bmp.height;
    src.getContext('2d').drawImage(bmp, 0, 0);

    const hasAlpha = hasTransparency(src);
    const out = await aiUpscaleCanvas(src, mod, (done, total) => {
      item.statusText = `AI: tile ${done}/${total}…`;
      renderRow(item);
    });

    if (hasAlpha) {
      // kekalkan ketelusan: alpha di-resample dengan pica
      const alpha = document.createElement('canvas');
      alpha.width = out.width;
      alpha.height = out.height;
      await pica.resize(src, alpha);
      const ctx = out.getContext('2d');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(alpha, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }

    item.blob = hasAlpha
      ? await canvasToBlob(out, 'image/png')
      : await canvasToBlob(out, 'image/jpeg', 0.92);
    item.scale = 2;
    item.engineTag = 'ai';
    item.w = out.width;
    item.h = out.height;
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.error = err.message || 'Failed';
  }
  renderRow(item);
}

/**
 * Jubin berlapis: setiap jubin di-uperes 2×, bahagian tengahnya dicantum
 * supaya tiada garis sambungan pada sempadan.
 *
 * Nota penting: instans Upscaler dibuat baharu untuk setiap jubin. Menggunakan
 * satu instans berulang kali menyebabkan panggilan kedua tersekat pada sesetengah
 * pemacu GPU (Intel/D3D11). Mencipta + dispose setiap kali mengambil ~0.2s kerana
 * pemberat model sudah dicache.
 */
async function aiUpscaleCanvas(src, mod, onProgress) {
  const Upscaler = mod.default;
  const W = src.width, H = src.height, S = 2;
  const STEP = AI_TILE - AI_OVERLAP;
  const cols = Math.max(1, Math.ceil((W - AI_TILE) / STEP) + 1);
  const rows = Math.max(1, Math.ceil((H - AI_TILE) / STEP) + 1);
  const pw = (cols - 1) * STEP + AI_TILE;
  const ph = (rows - 1) * STEP + AI_TILE;

  const padded = document.createElement('canvas');
  padded.width = pw;
  padded.height = ph;
  padded.getContext('2d').drawImage(src, 0, 0);

  const out = document.createElement('canvas');
  out.width = W * S;
  out.height = H * S;
  const octx = out.getContext('2d');

  const half = AI_OVERLAP / 2;
  const total = cols * rows;
  let done = 0;
  onProgress(0, total);

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * STEP;
      const y0 = ty * STEP;

      const tile = document.createElement('canvas');
      tile.width = AI_TILE;
      tile.height = AI_TILE;
      tile.getContext('2d').drawImage(padded, x0, y0, AI_TILE, AI_TILE, 0, 0, AI_TILE, AI_TILE);
      dbg('tile', tx, ty, 'drawn', performance.now().toFixed(0));

      const upscaler = new Upscaler();
      let dataUrl;
      try {
        await upscaler.warmup?.();
        dataUrl = await upscaler.upscale(tile);
      } finally {
        try { upscaler.dispose?.(); } catch { /* abaikan */ }
      }
      dbg('tile', tx, ty, 'upscaled', performance.now().toFixed(0));

      const img = await imageFromUrl(dataUrl);
      dbg('tile', tx, ty, 'decoded');
      const ratio = img.width / AI_TILE;

      const sX = x0 + (x0 === 0 ? 0 : half);
      const sY = y0 + (y0 === 0 ? 0 : half);
      const eX = Math.min(x0 + AI_TILE - (x0 + AI_TILE >= pw ? 0 : half), W);
      const eY = Math.min(y0 + AI_TILE - (y0 + AI_TILE >= ph ? 0 : half), H);

      if (eX > sX && eY > sY) {
        octx.drawImage(
          img,
          (sX - x0) * ratio, (sY - y0) * ratio, (eX - sX) * ratio, (eY - sY) * ratio,
          sX * S, sY * S, (eX - sX) * S, (eY - sY) * S,
        );
      }

      done++;
      onProgress(done, total);
      await nextFrame();
    }
  }
  return out;
}

btnUpscale.addEventListener('click', async () => {
  const pending = queue.filter(i => i.status === 'queued' || i.status === 'error' && i.bmp);
  if (!pending.length) return;
  btnUpscale.disabled = true;
  btnUpscale.textContent = 'Processing…';
  for (const item of pending) {
    item.status = 'queued';
    await upscaleItem(item);
  }
  btnUpscale.disabled = false;
  btnUpscale.textContent = 'Upscale';
});

$('#btnClearUpscale').addEventListener('click', () => {
  queue.length = 0;
  resultsEl.innerHTML = '';
  controlsU.hidden = true;
});

wireDropzone($('#dzUpscale'), inputUpscale, addFiles);

/* ------------------------------------------------------------------ */
/*  Alat 2 — Buang latar                                              */
/* ------------------------------------------------------------------ */

const dzBg = $('#dzBg');
const inputBg = $('#inputBg');
const bgControls = $('#bgControls');
const bgStage = $('#bgStage');
const bgPreview = $('#bgPreview');
let bgPreviewUrl = null;

/** Tunjuk imej dalam kotak semak (img, bukan canvas — lebih tepat & ringan). */
function setPreview(source) {
  if (bgPreviewUrl) URL.revokeObjectURL(bgPreviewUrl);
  bgPreviewUrl = URL.createObjectURL(source);
  bgPreview.src = bgPreviewUrl;
  bgPreview.hidden = false;
}
const bgMeta = $('#bgMeta');
const bgProgress = $('#bgProgress');
const bgBar = $('#bgBar');
const bgStatus = $('#bgStatus');
const btnBgDownload = $('#btnBgDownload');
const btnBg = $('#btnBg');

let bgFile = null;
let bgResult = null;
let bgMode = 'ai';
let tolerance = 24;
let aiModule = null;

$$('#modeSeg .seg').forEach(b => b.addEventListener('click', () => {
  $$('#modeSeg .seg').forEach(x => x.classList.toggle('is-active', x === b));
  bgMode = b.dataset.mode;
  $('#tolWrap').hidden = bgMode !== 'fast';
  $('#bgHint').hidden = bgMode !== 'ai';
}));

$('#tolerance').addEventListener('input', e => {
  tolerance = Number(e.target.value);
  $('#tolVal').textContent = tolerance;
  syncRangeFill(e.target);
});

async function loadBgFile(files) {
  bgFile = files[0];
  bgResult = null;
  bgControls.hidden = false;
  bgStage.hidden = false;
  btnBgDownload.hidden = true;
  bgProgress.hidden = true;
  $('#bgHint').hidden = bgMode !== 'ai';

  const bmp = await loadBitmap(bgFile);
  setPreview(bgFile);
  bgMeta.textContent = `${bgFile.name} · ${bmp.width}×${bmp.height} · ${fmtBytes(bgFile.size)}`;
}

wireDropzone(dzBg, inputBg, loadBgFile);

$('#btnClearBg').addEventListener('click', () => {
  bgFile = null;
  bgResult = null;
  bgControls.hidden = true;
  bgStage.hidden = true;
  if (bgPreviewUrl) { URL.revokeObjectURL(bgPreviewUrl); bgPreviewUrl = null; }
  bgPreview.removeAttribute('src');
  bgPreview.hidden = true;
});

function setProgress(pct, text) {
  bgProgress.hidden = false;
  bgBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) bgStatus.textContent = text;
}

btnBg.addEventListener('click', async () => {
  if (!bgFile) return;
  btnBg.disabled = true;
  btnBgDownload.hidden = true;
  const t0 = performance.now();
  try {
    const blob = bgMode === 'ai'
      ? await removeWithAI(bgFile)
      : await removeByColor(bgFile);
    bgResult = blob;
    await drawResult(blob);
    setProgress(100, `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    btnBgDownload.hidden = false;
  } catch (err) {
    console.error(err);
    setProgress(0, `Failed: ${err.message || err}`);
  } finally {
    btnBg.disabled = false;
  }
});

async function drawResult(blob) {
  const bmp = await loadBitmap(blob);
  setPreview(blob);
  bgMeta.textContent = `${bmp.width}×${bmp.height} · PNG · ${fmtBytes(blob.size)}`;
}

btnBgDownload.addEventListener('click', () => {
  if (bgResult) download(bgResult, `${baseName(bgFile.name)}_no-bg.png`);
});

/* --- mod AI (model segmentasi, jalan dalam browser) --- */

let aiWorker = null;

function runInWorker(file, onMessage) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      if (!aiWorker) aiWorker = new Worker('./assets/bg-worker.js', { type: 'module' });
      worker = aiWorker;
    } catch {
      reject(new Error('Worker tidak disokong'));
      return;
    }
    const onMsg = event => {
      const data = event.data || {};
      if (data.type === 'progress') onMessage(data);
      else if (data.type === 'status') onMessage(data);
      else if (data.type === 'done') { cleanup(); resolve(data.blob); }
      else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); }
    };
    const onErr = event => {
      cleanup();
      aiWorker = null;
      reject(new Error(event.message || 'Worker gagal dimulakan'));
    };
    function cleanup() {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    }
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({ file, cdn: AI_CDN });
  });
}

const mapAiProgress = data => {
  if (data.type === 'status') return setProgress(8, data.text);
  const pct = data.total ? (data.current / data.total) * 100 : 0;
  if (String(data.key).startsWith('fetch')) {
    setProgress(8 + pct * 0.5, `Downloading model ${Math.round(pct)}%`);
  } else {
    setProgress(60 + pct * 0.38, 'Processing image…');
  }
};

async function removeWithAI(file) {
  setProgress(4, 'Preparing…');
  // Cuba dalam worker dahulu; jika gagal, jalankan di thread utama.
  try {
    return await runInWorker(file, mapAiProgress);
  } catch (err) {
    console.warn('Worker AI gagal, guna thread utama:', err);
    setProgress(10, 'Loading model…');
    if (!aiModule) aiModule = await import(AI_CDN);
    return aiModule.removeBackground(file, {
      model: 'isnet_fp16',
      output: { format: 'image/png' },
      progress: (key, current, total) => mapAiProgress({ type: 'progress', key, current, total }),
    });
  }
}

/* --- mod warna: flood fill dari tepi --- */

async function removeByColor(file) {
  setProgress(35, 'Menganalisis latar…');
  const bmp = await loadBitmap(file);
  const w = bmp.width;
  const h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // warna latar = purata piksel sempadan
  let sr = 0, sg = 0, sb = 0, n = 0;
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    if (d[i + 3] < 16) return;
    sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 60));
  for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
  const br = sr / n, bgc = sg / n, bb = sb / n;

  const tol2 = tolerance * tolerance * 3;
  const mask = new Uint8Array(w * h);      // 1 = latar
  const stack = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (mask[p]) return;
    const i = p * 4;
    const dr = d[i] - br, dg = d[i + 1] - bgc, db = d[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > tol2) return;
    mask[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  setProgress(70, 'Melembutkan tepi…');

  // alpha = 0 pada latar, dengan blur ringan untuk tepi
  const alpha = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) alpha[p] = mask[p] ? 0 : 1;
  const tmp = new Float32Array(w * h);
  const blur = (srcA, dstA) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += srcA[yy * w + xx]; cnt++;
          }
        }
        dstA[y * w + x] = sum / cnt;
      }
    }
  };
  blur(alpha, tmp);

  for (let p = 0; p < w * h; p++) d[p * 4 + 3] = Math.round(tmp[p] * 255);
  ctx.putImageData(img, 0, 0);
  setProgress(92, 'Mengekod PNG…');
  return canvasToBlob(canvas, 'image/png');
}

// isi trek slider pada muatan pertama
['#sharpen', '#tolerance'].forEach(sel => { const el = $(sel); if (el) syncRangeFill(el); });

/* butang bulat + tampal papan klip */
wireSourceButtons(inputUpscale, $('#pickUpscale'), $('#pasteUpscale'), addFiles);
wireSourceButtons(inputBg, $('#pickBg'), $('#pasteBg'), loadBgFile);

document.addEventListener('paste', e => {
  const items = [...(e.clipboardData?.items || [])];
  const file = items.find(i => i.type.startsWith('image/'))?.getAsFile();
  if (!file) return;
  e.preventDefault();
  const active = $('.tool-panel.is-active');
  if (active?.id === 'panel-bg') loadBgFile([file]);
  else addFiles([file]);
  toast('Image pasted from clipboard.');
});
