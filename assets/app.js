import Pica from './pica.min.mjs';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const REPO_URL = 'https://github.com/danielhafiz438-coder/pixcut';
const MAX_INPUT_MP = 48;      // input cap (memory, not time)
const MAX_OUTPUT_MP = 192;    // 2× of a 48 MP photo still fits
const MAX_SIDE = 16384;       // max canvas side on this class of GPU
const SHARPEN = 35;           // fixed unsharp strength for the Lanczos path
const COLOUR_TOLERANCE = 24;  // flood-fill tolerance for the colour fallback
const BG_CDN = 'https://esm.sh/@imgly/background-removal@1.7.0';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const pica = new Pica();

const els = {
  studio: $('#studio'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  workspace: $('#workspace'),
  panes: $('#panes'),
  originalPreview: $('#originalPreview'),
  originalMeta: $('#originalMeta'),
  resultPane: $('#resultPane'),
  resultPreview: $('#resultPreview'),
  resultMeta: $('#resultMeta'),
  progress: $('#progress'),
  bar: $('#bar'),
  barFill: $('#barFill'),
  progressText: $('#progressText'),
  scaleSeg: $('#scaleSeg'),
  segs: $$('#scaleSeg .seg'),
  btnUpscale: $('#btnUpscale'),
  btnBg: $('#btnBg'),
  btnDownload: $('#btnDownload'),
  btnReset: $('#btnReset'),
  hint: $('#hint'),
  dropOverlay: $('#dropOverlay'),
};

const state = {
  file: null,
  source: null,      // canvas holding the decoded pixels
  width: 0,
  height: 0,
  scale: 2,
  result: null,      // { blob, url, tag }
  originalUrl: null,
  busy: false,
  token: 0,
};

$('#repoLink').href = REPO_URL;

/* ------------------------------------------------------------------ */
/*  Small utilities                                                    */
/* ------------------------------------------------------------------ */

const fmtBytes = n => n < 1024
  ? `${n} B`
  : n < 1048576
    ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;

const baseName = name => (name || 'image')
  .replace(/\.[^.]+$/, '')
  .replace(/[^\w\-. ]+/g, '_')
  .slice(0, 60) || 'image';

const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));

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
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3600);
}

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
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('The browser could not encode the result — the image may be too large.'))),
      type,
      quality,
    );
  });
}

/** True when the image really contains transparent pixels. */
function hasTransparency(source) {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 256;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 256, 256);
  const d = ctx.getImageData(0, 0, 256, 256).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/** Decode any image the browser understands into a canvas (single copy of the pixels). */
async function decodeToCanvas(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    // SVG and a few exotic formats only decode through <img>.
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    bmp = { width: img.naturalWidth, height: img.naturalHeight, draw: img };
  }
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp.draw || bmp, 0, 0);
  bmp.close?.();
  return canvas;
}

/* ------------------------------------------------------------------ */
/*  Progress + busy state                                              */
/* ------------------------------------------------------------------ */

let tickTimer = null;

function startJob(text, indeterminate = true) {
  const token = ++state.token;
  state.busy = true;
  setBusy(true);

  els.progress.hidden = false;
  els.bar.classList.toggle('is-indeterminate', indeterminate);
  els.barFill.style.width = indeterminate ? '38%' : '0%';
  els.progressText.textContent = text;
  els.hint.classList.remove('is-error');

  const t0 = performance.now();
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    els.progressText.textContent = `${text} · ${((performance.now() - t0) / 1000).toFixed(0)}s`;
  }, 300);

  return token;
}

function setProgress(pct, text) {
  clearInterval(tickTimer);
  tickTimer = null;
  els.bar.classList.remove('is-indeterminate');
  els.barFill.style.width = `${clamp(pct)}%`;
  if (text) els.progressText.textContent = text;
}

function endJob(token) {
  if (token !== state.token) return;
  clearInterval(tickTimer);
  tickTimer = null;
  state.busy = false;
  setBusy(false);
  els.bar.classList.remove('is-indeterminate');
  els.barFill.style.width = '100%';
  syncHint();
}

function failJob(err) {
  clearInterval(tickTimer);
  tickTimer = null;
  els.bar.classList.remove('is-indeterminate');
  els.barFill.style.width = '0%';
  els.progressText.textContent = 'Failed';
  els.hint.classList.add('is-error');
  els.hint.textContent = err?.message || String(err);
}

function setBusy(busy) {
  [els.btnUpscale, els.btnBg, els.btnReset, els.btnDownload, ...els.segs]
    .forEach(b => { b.disabled = busy; });
  if (!busy) syncHint();
}

/* ------------------------------------------------------------------ */
/*  Loading an image                                                   */
/* ------------------------------------------------------------------ */

function clearResult() {
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  state.result = null;
  els.resultPane.hidden = true;
  els.resultPreview.removeAttribute('src');
  els.btnDownload.hidden = true;
  els.panes.classList.remove('has-result');
}

function clearSource() {
  state.source = null;
  state.file = null;
  state.width = state.height = 0;
  if (state.originalUrl) {
    URL.revokeObjectURL(state.originalUrl);
    state.originalUrl = null;
  }
  els.originalPreview.removeAttribute('src');
}

async function loadFile(file) {
  if (!file) return;
  if (state.busy) { toast('Hold on — a job is still running.'); return; }
  if (!file.type.startsWith('image/')) { toast('That file is not an image.'); return; }

  let source;
  try {
    source = await decodeToCanvas(file);
  } catch {
    toast('This image could not be read. Try a JPG, PNG or WebP.');
    return;
  }

  const mp = (source.width * source.height) / 1e6;
  if (mp > MAX_INPUT_MP) {
    toast(`Too large: ${mp.toFixed(1)} MP. The limit is ${MAX_INPUT_MP} MP.`);
    return;
  }

  state.token++;              // cancel anything from the previous image
  clearResult();
  clearSource();

  state.file = file;
  state.source = source;
  state.width = source.width;
  state.height = source.height;

  state.originalUrl = URL.createObjectURL(file);
  els.originalPreview.src = state.originalUrl;
  els.originalMeta.innerHTML = `<b>${state.width}×${state.height}</b> · ${fmtBytes(file.size)} · ${file.name}`;

  els.dropzone.hidden = true;
  els.workspace.hidden = false;
  els.progress.hidden = true;
  els.progressText.textContent = '';
  els.barFill.style.width = '0%';

  syncHint();
  setBusy(false);
}

function reset() {
  state.token++;
  state.busy = false;
  clearResult();
  clearSource();
  els.workspace.hidden = true;
  els.dropzone.hidden = false;
  els.progress.hidden = true;
  els.progressText.textContent = '';
  els.barFill.style.width = '0%';
  els.hint.textContent = '';
  els.hint.classList.remove('is-error');
  els.fileInput.value = '';
  setBusy(false);
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

function outputSize(scale = state.scale) {
  return {
    w: Math.round(state.width * scale),
    h: Math.round(state.height * scale),
  };
}

function tooBig({ w, h }) {
  return w > MAX_SIDE || h > MAX_SIDE || (w * h) / 1e6 > MAX_OUTPUT_MP;
}

function syncHint() {
  if (!state.file) { els.hint.textContent = ''; return; }
  const out = outputSize();
  const over = tooBig(out);

  els.hint.classList.toggle('is-error', over);
  els.hint.innerHTML = over
    ? `${state.scale}× would be ${out.w}×${out.h} px — past the ${MAX_OUTPUT_MP} MP limit. Use 2×.`
    : `Original <b>${state.width}×${state.height}</b> px. Upscaling ${state.scale}× gives <b>${out.w}×${out.h}</b> px. Background removal keeps the original size.`;

  els.btnUpscale.disabled = state.busy || over;
}

async function showResult(blob, tag, label) {
  if (state.result?.url) URL.revokeObjectURL(state.result.url);

  const url = URL.createObjectURL(blob);
  const img = els.resultPreview;
  img.src = url;
  await img.decode().catch(() => { /* naturalWidth stays 0 if decode fails */ });

  state.result = { blob, url, tag };

  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  els.resultMeta.innerHTML = `<b>${img.naturalWidth || '?'}×${img.naturalHeight || '?'}</b> · ${ext.toUpperCase()} · ${fmtBytes(blob.size)}`;
  els.resultPane.hidden = false;
  els.panes.classList.add('has-result');
  els.btnDownload.hidden = false;
  els.btnDownload.textContent = `Download ${ext.toUpperCase()}`;

  els.progressText.textContent = `${label} — press Download to save it.`;
}

async function upscale() {
  if (!state.file || state.busy) return;

  const scale = state.scale;
  const out = outputSize(scale);
  if (tooBig(out)) { syncHint(); return; }

  const token = startJob(`Upscaling ${scale}× with Lanczos`);
  const t0 = performance.now();

  try {
    const dst = document.createElement('canvas');
    dst.width = out.w;
    dst.height = out.h;

    await pica.resize(state.source, dst, {
      unsharpAmount: Math.round(SHARPEN * 2.2),
      unsharpRadius: 0.6,
      unsharpThreshold: 2,
    });
    if (token !== state.token) return;

    const hasAlpha = hasTransparency(dst);
    const blob = hasAlpha
      ? await canvasToBlob(dst, 'image/png')
      : await canvasToBlob(dst, 'image/jpeg', 0.92);
    if (token !== state.token) return;

    setProgress(100, `Upscaled ${scale}× in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    await showResult(blob, `${scale}x`, `Upscaled ${scale}×`);
  } catch (err) {
    if (token === state.token) failJob(err);
  } finally {
    endJob(token);
  }
}

/* ------------------------------------------------------------------ */
/*  Background removal — AI model first, colour flood fill as fallback */
/* ------------------------------------------------------------------ */

let worker = null;

function runInWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      try {
        worker = new Worker('./assets/bg-worker.js', { type: 'module' });
      } catch (err) {
        reject(err);
        return;
      }
    }
    const w = worker;

    const onMessage = event => {
      const data = event.data || {};
      if (data.type === 'progress' || data.type === 'status') onProgress(data);
      else if (data.type === 'done') { cleanup(); resolve(data.blob); }
      else if (data.type === 'error') { cleanup(); reject(new Error(data.message || 'Background removal failed')); }
    };
    const onError = event => {
      cleanup();
      try { w.terminate(); } catch { /* already gone */ }
      if (worker === w) worker = null;
      reject(new Error(event.message || 'The worker could not start'));
    };
    function cleanup() {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    }

    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ file, cdn: BG_CDN });
  });
}

function mapProgress(data) {
  if (data.type === 'status') return setProgress(6, data.text);
  const pct = data.total ? (data.current / data.total) * 100 : 0;
  if (String(data.key).startsWith('fetch')) setProgress(6 + pct * 0.5, `Downloading model ${Math.round(pct)}%`);
  else setProgress(58 + pct * 0.4, 'Cutting out the subject…');
}

async function removeWithAI(file) {
  setProgress(4, 'Preparing…');
  try {
    return await runInWorker(file, mapProgress);
  } catch (err) {
    // Worker unavailable (old browser, blocked module import): same model on the main thread.
    console.warn('Worker failed, running on the main thread:', err);
    setProgress(10, 'Loading model…');
    const mod = await import(BG_CDN);
    return mod.removeBackground(file, {
      model: 'isnet_fp16',
      output: { format: 'image/png' },
      progress: (key, current, total) => mapProgress({ type: 'progress', key, current, total }),
    });
  }
}

async function removeByColor(source) {
  setProgress(35, 'Analysing the background…');
  const w = source.width;
  const h = source.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  // Background colour = average of the border pixels.
  let sr = 0, sg = 0, sb = 0, n = 0;
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    if (d[i + 3] < 16) return;
    sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 60));
  for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }

  const br = n ? sr / n : 255;
  const bg = n ? sg / n : 255;
  const bb = n ? sb / n : 255;

  const tol2 = COLOUR_TOLERANCE * COLOUR_TOLERANCE * 3;
  const mask = new Uint8Array(w * h);   // 1 = background
  const stack = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (mask[p]) return;
    const i = p * 4;
    const dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
    if (dr * dr + dg * dg + db * db > tol2) return;
    mask[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  setProgress(70, 'Softening the edges…');

  // alpha = 0 on the background, blurred by one pass for a clean edge
  const alpha = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) alpha[p] = mask[p] ? 0 : 1;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += alpha[yy * w + xx];
          cnt++;
        }
      }
      tmp[y * w + x] = sum / cnt;
    }
  }

  for (let p = 0; p < w * h; p++) d[p * 4 + 3] = Math.round(tmp[p] * 255);
  ctx.putImageData(image, 0, 0);

  setProgress(92, 'Encoding PNG…');
  return canvasToBlob(canvas, 'image/png');
}

async function cutout() {
  if (!state.file || state.busy) return;
  const token = startJob('Removing the background');

  try {
    let blob;
    try {
      blob = await removeWithAI(state.file);
    } catch (err) {
      if (token !== state.token) return;
      console.warn('AI cut-out unavailable:', err);
      setProgress(20, 'AI model unavailable — cutting by background colour instead…');
      blob = await removeByColor(state.source);
    }
    if (token !== state.token) return;

    setProgress(100, 'Background removed');
    await showResult(blob, 'no-bg', 'Background removed');
  } catch (err) {
    if (token === state.token) failJob(err);
  } finally {
    endJob(token);
  }
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                             */
/* ------------------------------------------------------------------ */

els.btnUpscale.addEventListener('click', upscale);
els.btnBg.addEventListener('click', cutout);
els.btnReset.addEventListener('click', reset);

els.btnDownload.addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const ext = r.blob.type === 'image/png' ? 'png' : 'jpg';
  download(r.blob, `${baseName(state.file?.name)}_${r.tag}.${ext}`);
});

els.segs.forEach(btn => btn.addEventListener('click', () => {
  state.scale = Number(btn.dataset.scale) || 2;
  els.segs.forEach(b => {
    const on = b === btn;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  syncHint();
}));

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  els.fileInput.value = '';
  if (file) loadFile(file);
});

function openPicker() {
  if (!state.busy) els.fileInput.click();
}

els.dropzone.addEventListener('click', e => {
  if (e.target === els.fileInput) return;
  openPicker();
});
els.dropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openPicker();
  }
});

// Whole page is a drop target: no "drop it on the small box" guessing.
let dragDepth = 0;

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  els.studio.classList.add('is-drag');
  els.dropOverlay.hidden = !state.file;
});

window.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    els.studio.classList.remove('is-drag');
    els.dropOverlay.hidden = true;
  }
});

window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.studio.classList.remove('is-drag');
  els.dropOverlay.hidden = true;

  const files = [...(e.dataTransfer?.files || [])];
  const image = files.find(f => f.type.startsWith('image/'));
  if (!image) { toast('Drop an image file — JPG, PNG or WebP.'); return; }
  if (files.length > 1) toast('Using the first image.');
  loadFile(image);
});

document.addEventListener('paste', e => {
  const file = [...(e.clipboardData?.items || [])]
    .find(i => i.type.startsWith('image/'))
    ?.getAsFile();
  if (!file) return;
  e.preventDefault();
  loadFile(file);
  toast('Image pasted from the clipboard.');
});

// Hint line reflects the current scale choice.
syncHint();
