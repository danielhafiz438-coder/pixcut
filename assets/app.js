import Pica from './pica.min.mjs';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const REPO_URL = 'https://github.com/danielhafiz438-coder/pixcut';
const DEFAULT_SCALE = 2;      // one press = 2×; 4× is offered from the result
const MAX_INPUT_MP = 48;      // input cap (memory, not patience)
const MAX_OUTPUT_MP = 192;    // 2× of a 48 MP photo still fits
const MAX_SIDE = 16384;       // max canvas side on this class of GPU
const SHARPEN = 35;           // fixed unsharp strength for the Lanczos path
const COLOUR_TOLERANCE = 24;  // flood-fill tolerance for the colour fallback
const BG_CDN = 'https://esm.sh/@imgly/background-removal@1.7.0';
const AI_CDN_SR = 'https://cdn.jsdelivr.net/npm/upscaler@1.0.0/+esm';
const AI_MODEL_URL = 'https://esm.sh/@upscalerjs/esrgan-medium@1.0.0/2x';
const AI_MODEL_PATH = 'https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@1.0.0/models/x2/model.json';
const AI_MAX_MP = 6;          // AI enhance is minutes per megapixel, so cap at 6
const AI_TILE = 256;          // input tile size for the super-resolution model
const AI_OVERLAP = 32;        // tile overlap so seams disappear

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
  resultLinks: $('#resultLinks'),
  linkFull: $('#linkFull'),
  btnFour: $('#btnFour'),
  btnDownload: $('#btnDownload'),
  downloadLabel: $('#downloadLabel'),
  btnCompare: $('#btnCompare'),
  compare: $('#compare'),
  compareClose: $('#compareClose'),
  cmpOriginal: $('#cmpOriginal'),
  cmpResult: $('#cmpResult'),
  cmpNote: $('#cmpNote'),
  btnUpscale: $('#btnUpscale'),
  btnAi: $('#btnAi'),
  btnBg: $('#btnBg'),
  btnReset: $('#btnReset'),
  btnCancel: $('#btnCancel'),
  status: $('#status'),
  bar: $('#bar'),
  barFill: $('#barFill'),
  statusText: $('#statusText'),
  hint: $('#hint'),
  dropOverlay: $('#dropOverlay'),
};

const state = {
  file: null,
  source: null,        // canvas holding the decoded pixels
  width: 0,
  height: 0,
  result: null,        // { blob, url, tag, label, seconds, w, h }
  originalUrl: null,
  busy: false,
  token: 0,
  error: '',
};

$('#repoLink').href = REPO_URL;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
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

const extOf = blob => (blob.type === 'image/png' ? 'png' : 'jpg');

const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));

/** <b> element built through the DOM so user text can never be parsed as HTML. */
function strong(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

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
      b => (b ? resolve(b) : reject(new Error('The browser could not encode the result — try a smaller image.'))),
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
/*  Geometry                                                           */
/* ------------------------------------------------------------------ */

function outputSize(scale) {
  return {
    w: Math.round(state.width * scale),
    h: Math.round(state.height * scale),
  };
}

function tooBig({ w, h }) {
  return w > MAX_SIDE || h > MAX_SIDE || (w * h) / 1e6 > MAX_OUTPUT_MP;
}

/* ------------------------------------------------------------------ */
/*  Status + busy state                                                */
/* ------------------------------------------------------------------ */

let tickTimer = null;
let savedTimer = null;

function updateButtons() {
  const idle = !state.busy && !!state.file;
  const aiTooBig = (state.width * state.height) / 1e6 > AI_MAX_MP;
  els.btnUpscale.disabled = !idle || tooBig(outputSize(DEFAULT_SCALE));
  els.btnAi.disabled = !idle || aiTooBig || tooBig(outputSize(DEFAULT_SCALE));
  els.btnBg.disabled = !idle;
  els.btnReset.disabled = !state.file || state.busy;
  els.btnDownload.disabled = state.busy || !state.result;
  els.btnFour.disabled = state.busy;
}

function setBusy(busy) {
  state.busy = busy;
  els.studio.setAttribute('aria-busy', String(busy));
  updateButtons();
}

function startJob(text) {
  const token = ++state.token;
  state.error = '';

  setBusy(true);
  els.status.hidden = false;
  els.btnCancel.hidden = false;
  els.statusText.textContent = text;
  els.bar.classList.add('is-indeterminate');
  els.barFill.style.width = '38%';
  updateHint();

  const t0 = performance.now();
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    els.statusText.textContent = `${text} · ${((performance.now() - t0) / 1000).toFixed(0)}s`;
  }, 300);

  return token;
}

function setProgress(pct, text) {
  clearInterval(tickTimer);
  tickTimer = null;
  els.bar.classList.remove('is-indeterminate');
  els.barFill.style.width = `${clamp(pct)}%`;
  if (text) els.statusText.textContent = text;
}

function endJob(token) {
  if (token !== state.token) return;
  clearInterval(tickTimer);
  tickTimer = null;
  els.btnCancel.hidden = true;
  setBusy(false);
  els.bar.classList.remove('is-indeterminate');
  if (!state.error) els.barFill.style.width = '100%';
}

function failJob(err) {
  clearInterval(tickTimer);
  tickTimer = null;
  els.btnCancel.hidden = true;
  els.bar.classList.remove('is-indeterminate');
  els.barFill.style.width = '0%';
  els.statusText.textContent = 'Failed';
  state.error = err?.message || String(err);
  updateHint();
}

/** Stop whatever is running, keep the image, ignore the pending result. */
function cancelJob() {
  if (!state.busy) return;
  state.token++;
  clearInterval(tickTimer);
  tickTimer = null;

  if (worker) {
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
  }

  setBusy(false);
  els.btnCancel.hidden = true;
  els.bar.classList.remove('is-indeterminate');
  els.barFill.style.width = '0%';
  els.statusText.textContent = 'Cancelled — nothing was changed.';
}

/* ------------------------------------------------------------------ */
/*  Copy that reflects the current state                               */
/* ------------------------------------------------------------------ */

function filenameFor(result = state.result) {
  if (!result) return '';
  return `${baseName(state.file?.name)}_${result.tag}.${extOf(result.blob)}`;
}

function updateHint() {
  const hint = els.hint;
  hint.classList.toggle('is-error', !!state.error);

  if (state.error) {
    hint.textContent = state.error;
    return;
  }
  if (!state.file) {
    hint.textContent = '';
    return;
  }
  if (state.result) {
    hint.innerHTML = `Saved as <b>${esc(filenameFor())}</b> · press <kbd>D</kbd> to download again.`;
    return;
  }
  if (tooBig(outputSize(DEFAULT_SCALE))) {
    hint.textContent = `This image is too large to upscale here (${MAX_SIDE} px a side, ${MAX_OUTPUT_MP} MP). Background removal still works.`;
    return;
  }
  const out = outputSize(DEFAULT_SCALE);
  const aiNote = (state.width * state.height) / 1e6 > AI_MAX_MP
    ? ` · AI enhance needs ≤ ${AI_MAX_MP} MP`
    : ' · AI enhance is slower but rebuilds detail instead of blurring';
  hint.innerHTML = `Original <b>${state.width}×${state.height}</b> px · Upscale 2× → `
    + `<b>${out.w}×${out.h}</b> px in about a second${aiNote}.`;
}

/* ------------------------------------------------------------------ */
/*  Loading an image                                                   */
/* ------------------------------------------------------------------ */

function clearResult() {
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  state.result = null;
  closeCompare();
  els.resultPane.hidden = true;
  els.resultPreview.removeAttribute('src');
  els.btnDownload.hidden = true;
  els.resultLinks.hidden = true;
  els.btnFour.hidden = true;
  els.btnCompare.hidden = true;
  els.panes.classList.remove('has-result');
  els.studio.classList.remove('has-result');
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
  els.originalMeta.replaceChildren();
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

  state.token++;              // cancels anything still running for the old image
  clearResult();
  clearSource();

  state.file = file;
  state.source = source;
  state.width = source.width;
  state.height = source.height;
  state.error = '';

  state.originalUrl = URL.createObjectURL(file);
  els.originalPreview.src = state.originalUrl;
  els.originalPreview.alt = file.name;
  els.originalMeta.replaceChildren(
    strong(`${source.width}×${source.height}`),
    document.createTextNode(` · ${fmtBytes(file.size)} · ${file.name}`),
  );

  els.dropzone.hidden = true;
  els.workspace.hidden = false;
  document.body.classList.add('has-image');
  els.status.hidden = true;
  els.statusText.textContent = '';
  els.barFill.style.width = '0%';
  els.bar.classList.remove('is-indeterminate');

  setBusy(false);
  updateHint();
}

function reset() {
  state.token++;
  setBusy(false);
  state.error = '';
  clearResult();
  clearSource();

  els.workspace.hidden = true;
  els.dropzone.hidden = false;
  document.body.classList.remove('has-image');
  els.status.hidden = true;
  els.statusText.textContent = '';
  els.barFill.style.width = '0%';
  els.bar.classList.remove('is-indeterminate');
  els.hint.textContent = '';
  els.hint.classList.remove('is-error');
  els.fileInput.value = '';
  updateButtons();
}

async function showResult({ blob, tag, label, seconds }) {
  if (state.result?.url) URL.revokeObjectURL(state.result.url);

  const url = URL.createObjectURL(blob);
  const img = els.resultPreview;
  img.src = url;
  await img.decode().catch(() => { /* dimensions stay 0 if decoding fails */ });

  state.result = {
    blob,
    url,
    tag,
    label,
    seconds,
    w: img.naturalWidth,
    h: img.naturalHeight,
  };
  state.error = '';

  const ext = extOf(blob);
  els.resultMeta.replaceChildren(
    strong(`${img.naturalWidth}×${img.naturalHeight}`),
    document.createTextNode(` · ${ext.toUpperCase()} · ${fmtBytes(blob.size)}`),
  );

  els.downloadLabel.textContent = `Download ${ext.toUpperCase()}`;
  els.btnDownload.hidden = false;
  els.btnDownload.classList.remove('is-saved');

  els.linkFull.href = url;
  els.resultLinks.hidden = false;
  els.btnCompare.hidden = !(img.naturalWidth > state.width);
  els.btnFour.hidden = !(tag === '2x' && !tooBig(outputSize(4)));

  els.resultPane.hidden = false;
  els.panes.classList.add('has-result');
  els.studio.classList.add('has-result');

  els.status.hidden = false;
  els.statusText.textContent = `${label} · ${seconds}s`;
  els.barFill.style.width = '100%';

  updateButtons();
  updateHint();

  if (matchMedia('(max-width: 820px)').matches) {
    els.resultPane.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

async function upscale(scale = DEFAULT_SCALE) {
  if (!state.file || state.busy) return;

  const out = outputSize(scale);
  if (tooBig(out)) {
    state.error = `${scale}× would be ${out.w}×${out.h} px — past the ${MAX_OUTPUT_MP} MP limit.`;
    updateHint();
    return;
  }

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

    const blob = hasTransparency(dst)
      ? await canvasToBlob(dst, 'image/png')
      : await canvasToBlob(dst, 'image/jpeg', 0.92);
    if (token !== state.token) return;

    setProgress(100, `Upscaled ${scale}×`);
    await showResult({
      blob,
      tag: `${scale}x`,
      label: `Upscaled ${scale}×`,
      seconds: ((performance.now() - t0) / 1000).toFixed(1),
    });
  } catch (err) {
    if (token === state.token) failJob(err);
  } finally {
    endJob(token);
  }
}

/* ------------------------------------------------------------------ */
/*  AI enhance — ESRGAN super-resolution, tiled                       */
/* ------------------------------------------------------------------ */

let upscalerPromise = null;

const normaliseUpscaler = mod => {
  if (typeof mod?.default === 'function') return mod.default;
  if (typeof mod?.Upscaler === 'function') return mod.Upscaler;
  if (typeof mod?.default?.default === 'function') return mod.default.default;
  throw new Error('The AI module loaded in an unexpected shape');
};

/**
 * The engine ships a small default model. ESRGAN Medium is ~2.7 MB instead of
 * ~1 MB, runs at the same speed per tile, and is the one that actually rebuilds
 * texture — measured against the default, slim and thick variants.
 */
function getUpscaler() {
  if (!upscalerPromise) {
    upscalerPromise = (async () => {
      const [core, modelModule] = await Promise.all([
        import(AI_CDN_SR),
        import(AI_MODEL_URL).catch(() => null),
      ]);

      const Upscaler = normaliseUpscaler(core);
      let model = null;

      if (modelModule?.default) {
        model = modelModule.default;
        model.path = AI_MODEL_PATH;
        if (model._internals) model._internals.path = AI_MODEL_PATH;
      }
      return { Upscaler, model };
    })().catch(() => {
      upscalerPromise = null;
      throw new Error('The AI model could not be downloaded — check your connection, or use Upscale 2×.');
    });
  }
  return upscalerPromise;
}

const dataUrlToBlob = url => {
  const comma = url.indexOf(',');
  const mime = (url.slice(0, comma).match(/:(.*?);/) || [, 'image/png'])[1];
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const imageFromUrl = url => createImageBitmap(dataUrlToBlob(url));

const nextFrame = () => new Promise(r => setTimeout(r, 16));

/**
 * Tile the source, upscale each tile 2×, and stitch only the tiles' centres so
 * the overlaps hide the seams. A fresh Upscaler per tile avoids a WebGL
 * deadlock seen on some Intel drivers after the first inference.
 */
async function aiUpscale(src, Upscaler, model, onProgress, shouldStop) {
  const W = src.width;
  const H = src.height;
  const S = 2;
  const STEP = AI_TILE - AI_OVERLAP;
  const cols = Math.max(1, Math.ceil((W - AI_TILE) / STEP) + 1);
  const rows = Math.max(1, Math.ceil((H - AI_TILE) / STEP) + 1);
  const pw = (cols - 1) * STEP + AI_TILE;
  const ph = (rows - 1) * STEP + AI_TILE;

  const padded = document.createElement('canvas');
  padded.width = pw;
  padded.height = ph;
  const pctx = padded.getContext('2d');
  pctx.drawImage(src, 0, 0);
  // Extend the edge pixels so the model never sees a transparent void.
  if (pw > W) pctx.drawImage(src, W - 1, 0, 1, H, W, 0, pw - W, H);
  if (ph > H) pctx.drawImage(src, 0, H - 1, W, 1, 0, H, W, ph - H);
  if (pw > W && ph > H) pctx.drawImage(src, W - 1, H - 1, 1, 1, W, H, pw - W, ph - H);

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
      if (shouldStop()) throw new Error('Cancelled');
      const x0 = tx * STEP;
      const y0 = ty * STEP;

      const tile = document.createElement('canvas');
      tile.width = AI_TILE;
      tile.height = AI_TILE;
      tile.getContext('2d').drawImage(padded, x0, y0, AI_TILE, AI_TILE, 0, 0, AI_TILE, AI_TILE);

      const upscaler = new Upscaler(model ? { model } : undefined);
      let dataUrl;
      try {
        await upscaler.warmup?.();
        dataUrl = await upscaler.upscale(tile);
      } finally {
        try { upscaler.dispose?.(); } catch { /* already gone */ }
      }

      const img = await imageFromUrl(dataUrl);
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
      img.close?.();

      done++;
      onProgress(done, total);
      await nextFrame();
    }
  }

  // The model smears the outermost pixels; copy a 2px band inward.
  const edge = 2;
  if (out.width > edge * 2 && out.height > edge * 2) {
    octx.drawImage(out, edge, 0, 1, out.height, 0, 0, edge, out.height);
    octx.drawImage(out, out.width - edge - 1, 0, 1, out.height, out.width - edge, 0, edge, out.height);
    octx.drawImage(out, 0, edge, out.width, 1, 0, 0, out.width, edge);
    octx.drawImage(out, 0, out.height - edge - 1, out.width, 1, 0, out.height - edge, out.width, edge);
  }
  return out;
}

async function aiEnhance() {
  if (!state.file || state.busy) return;

  const mp = (state.width * state.height) / 1e6;
  if (mp > AI_MAX_MP) {
    state.error = `AI enhance is limited to ${AI_MAX_MP} MP (this image is ${mp.toFixed(1)} MP) — use Upscale 2× instead.`;
    updateHint();
    return;
  }
  const out = outputSize(2);
  if (tooBig(out)) {
    state.error = `2× would be ${out.w}×${out.h} px — past the ${MAX_OUTPUT_MP} MP limit.`;
    updateHint();
    return;
  }

  const token = startJob('Loading the AI model');
  const t0 = performance.now();

  try {
    const { Upscaler, model } = await getUpscaler();
    if (token !== state.token) return;

    const hasAlpha = hasTransparency(state.source);
    setProgress(4, 'Enhancing — first tile…');

    const canvas = await aiUpscale(
      state.source,
      Upscaler,
      model,
      (done, total) => {
        if (token !== state.token) return;
        setProgress(3 + (done / total) * 92, `AI tile ${done}/${total} · ${((performance.now() - t0) / 1000).toFixed(0)}s`);
      },
      () => token !== state.token,
    );
    if (token !== state.token) return;

    if (hasAlpha) {
      // The model works on RGB only; bring the alpha back through pica.
      const alpha = document.createElement('canvas');
      alpha.width = canvas.width;
      alpha.height = canvas.height;
      await pica.resize(state.source, alpha);
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(alpha, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }

    const blob = hasAlpha
      ? await canvasToBlob(canvas, 'image/png')
      : await canvasToBlob(canvas, 'image/jpeg', 0.94);
    if (token !== state.token) return;

    setProgress(100, 'AI enhance done');
    await showResult({
      blob,
      tag: 'ai2x',
      label: 'AI enhanced 2×',
      seconds: ((performance.now() - t0) / 1000).toFixed(1),
    });
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

    const finish = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    const drop = () => {
      try { w.terminate(); } catch { /* already gone */ }
      if (worker === w) worker = null;
    };
    function onMessage(event) {
      const data = event.data || {};
      if (data.type === 'progress' || data.type === 'status') { onProgress(data); return; }
      finish();
      if (data.type === 'done') resolve(data.blob);
      else if (data.type === 'error') {
        drop();                       // a fresh worker retries the import cleanly
        reject(new Error(data.message || 'Background removal failed'));
      }
    }
    function onError(event) {
      finish();
      drop();
      reject(new Error(event.message || 'The worker could not start'));
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
  const bgc = n ? sg / n : 255;
  const bb = n ? sb / n : 255;

  const tol2 = COLOUR_TOLERANCE * COLOUR_TOLERANCE * 3;
  const mask = new Uint8Array(w * h);   // 1 = background
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
  const t0 = performance.now();

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
    await showResult({
      blob,
      tag: 'no-bg',
      label: 'Background removed',
      seconds: ((performance.now() - t0) / 1000).toFixed(1),
    });
  } catch (err) {
    if (token === state.token) failJob(err);
  } finally {
    endJob(token);
  }
}

/* ------------------------------------------------------------------ */
/*  100% comparison — the only view where an upscale is visible         */
/* ------------------------------------------------------------------ */

let compareReturnFocus = null;

/** Pick the busiest window instead of the centre — smooth sky proves nothing. */
function detailCrop(canvas, cw, ch) {
  const W = canvas.width;
  const H = canvas.height;
  if (W <= cw || H <= ch) return { x: 0, y: 0 };
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;

  let best = { x: Math.round((W - cw) / 2), y: Math.round((H - ch) / 2), score: -1 };
  const stepX = Math.max(8, Math.floor(cw / 8));
  const stepY = Math.max(8, Math.floor(ch / 8));

  for (let y = 0; y + ch <= H; y += stepY) {
    for (let x = 0; x + cw <= W; x += stepX) {
      let score = 0;
      for (let yy = y + 4; yy < y + ch - 8; yy += 10) {
        for (let xx = x + 4; xx < x + cw - 12; xx += 10) {
          const i = (yy * W + xx) * 4;
          const right = i + 12;          // 3 px across
          const down = i + W * 12;       // 3 px down
          score += Math.abs(data[i] - data[right]) + Math.abs(data[i] - data[down]);
        }
      }
      if (score > best.score) best = { x, y, score };
    }
  }
  return { x: best.x, y: best.y };
}

function openCompare() {
  const r = state.result;
  if (!r || !state.source || !r.w) return;

  const scale = r.w / state.width;
  const cw = Math.min(360, r.w);
  const ch = Math.max(1, Math.round(cw * (r.h / r.w)));

  // The result canvas is needed to find the most detailed region.
  const full = document.createElement('canvas');
  full.width = r.w;
  full.height = r.h;
  full.getContext('2d').drawImage(els.resultPreview, 0, 0);
  const { x: sx, y: sy } = detailCrop(full, cw, ch);

  const rc = els.cmpResult;
  rc.width = cw;
  rc.height = ch;
  const rctx = rc.getContext('2d');
  rctx.imageSmoothingEnabled = false;
  rctx.drawImage(els.resultPreview, sx, sy, cw, ch, 0, 0, cw, ch);

  const oc = els.cmpOriginal;
  oc.width = cw;
  oc.height = ch;
  const octx = oc.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  // Same content region, stretched to the result's pixel grid: this is what a
  // normal image viewer shows when it enlarges the original.
  octx.drawImage(state.source, sx / scale, sy / scale, cw / scale, ch / scale, 0, 0, cw, ch);

  els.cmpNote.textContent = `${cw}×${ch} px at 1:1 from the busiest part of the image · original `
    + `${state.width}×${state.height} px · result ${r.w}×${r.h} px (${scale}×)`;

  compareReturnFocus = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : els.btnCompare;
  els.compare.hidden = false;
  document.body.classList.add('is-comparing');
  els.compareClose.focus();
}

function closeCompare() {
  if (els.compare.hidden) return;
  els.compare.hidden = true;
  document.body.classList.remove('is-comparing');
  compareReturnFocus?.focus?.();
  compareReturnFocus = null;
}

els.btnCompare.addEventListener('click', openCompare);
els.compareClose.addEventListener('click', closeCompare);
els.compare.addEventListener('click', e => {
  if (e.target === els.compare) closeCompare();
});

/* ------------------------------------------------------------------ */
/*  Wiring                                                             */
/* ------------------------------------------------------------------ */

els.btnUpscale.addEventListener('click', () => upscale(DEFAULT_SCALE));
els.btnAi.addEventListener('click', aiEnhance);
els.btnBg.addEventListener('click', cutout);
els.btnReset.addEventListener('click', reset);
els.btnFour.addEventListener('click', () => upscale(4));
els.btnCancel.addEventListener('click', cancelJob);

els.btnDownload.addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  download(r.blob, filenameFor(r));

  const ext = extOf(r.blob);
  clearTimeout(savedTimer);
  els.btnDownload.classList.add('is-saved');
  els.downloadLabel.textContent = 'Saved';
  savedTimer = setTimeout(() => {
    els.btnDownload.classList.remove('is-saved');
    els.downloadLabel.textContent = `Download ${ext.toUpperCase()}`;
  }, 1600);
});

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

/* Whole page is a drop target — no aiming at a small box. */
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

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !els.compare.hidden) {
    e.preventDefault();
    closeCompare();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!state.file) return;

  const key = e.key.toLowerCase();
  if (key === 'u') { e.preventDefault(); upscale(DEFAULT_SCALE); }
  else if (key === 'a') { e.preventDefault(); aiEnhance(); }
  else if (key === 'b') { e.preventDefault(); cutout(); }
  else if (key === 'd' && state.result) { e.preventDefault(); els.btnDownload.click(); }
});

/* Mac users get ⌘V instead of Ctrl+V in the paste hint. */
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  const hint = $('#pasteHint');
  if (hint) hint.innerHTML = '<kbd>⌘</kbd><kbd>V</kbd>';
}

/* First paint */
updateButtons();
updateHint();
