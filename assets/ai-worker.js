// Real-ESRGAN (realesr-general-x4v3) inference off the main thread.
// Tiling follows the approach used by MyStudio / NextGenUp (MIT): pad each tile,
// infer, then keep only the tile's centre so the padding absorbs the seams.
// WebGPU when the browser has it, WebAssembly otherwise, with one retry on CPU
// if the GPU dies mid-run.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort.webgpu.min.mjs';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/';
const MODEL_URL = new URL('./models/realesr-general-x4v3.onnx', import.meta.url).href;
const MODEL_SCALE = 4;
const WEBGPU = { name: 'webgpu', preferredLayout: 'NCHW' };

ort.env.logLevel = 'fatal';
ort.env.wasm.wasmPaths = ORT_BASE;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let session = null;
let backend = 'wasm';
let tile = 128;
let pad = 12;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function createSession(kind) {
  const created = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: [kind === 'webgpu' ? WEBGPU : 'wasm'],
    graphOptimizationLevel: 'all',
  });
  // Some kernels only fail at run time, so prove this one works before using it.
  await created.run({
    [created.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 32 * 32), [1, 3, 32, 32]),
  });
  return created;
}

async function start() {
  if (session) return;
  let gpu = false;
  if (self.navigator?.gpu) {
    try {
      gpu = Boolean(await navigator.gpu.requestAdapter());
    } catch {
      gpu = false;
    }
  }
  if (gpu) {
    try {
      session = await createSession('webgpu');
      backend = 'webgpu';
      tile = 128;
      pad = 12;
      post({ type: 'backend', backend });
      return;
    } catch {
      // Fall through to WebAssembly, slower but works everywhere.
    }
  }
  session = await createSession('wasm');
  backend = 'wasm';
  tile = 64;
  pad = 8;
  post({ type: 'backend', backend });
}

function tileCanvas(width, height, data) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const img = new ImageData(width, height);
  const dst = img.data;
  for (let i = 0, p = 0; i < data.length; i += 3, p += 4) {
    dst[p] = data[i];
    dst[p + 1] = data[i + 1];
    dst[p + 2] = data[i + 2];
    dst[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function upscale({ pixels, width, height, scale }) {
  const src = new Uint8ClampedArray(pixels);
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);
  const out = new OffscreenCanvas(outW, outH);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';

  const cols = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const total = cols * rows;
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const sx = tx * tile;
      const sy = ty * tile;
      const x0 = Math.max(0, sx - pad);
      const y0 = Math.max(0, sy - pad);
      const x1 = Math.min(width, sx + tile + pad);
      const y1 = Math.min(height, sy + tile + pad);
      const tw = x1 - x0;
      const th = y1 - y0;

      const plane = tw * th;
      const input = new Float32Array(3 * plane);
      for (let row = 0; row < th; row++) {
        for (let col = 0; col < tw; col++) {
          const from = ((y0 + row) * width + x0 + col) * 4;
          const to = row * tw + col;
          input[to] = src[from] / 255;
          input[plane + to] = src[from + 1] / 255;
          input[plane * 2 + to] = src[from + 2] / 255;
        }
      }

      const results = await session.run({
        [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, th, tw]),
      });
      const output = results[session.outputNames[0]];
      const data = output.data;
      const dims = output.dims;
      const channelsLast = dims.length === 4 && dims[3] === 3;
      const oW = tw * MODEL_SCALE;
      const oH = th * MODEL_SCALE;
      const oPlane = oW * oH;

      // Re-pack to RGBA so a canvas can scale it (2x output = 4x model, halved).
      const rgba = new Uint8ClampedArray(oW * oH * 3);
      if (channelsLast) {
        for (let i = 0, p = 0; i < oPlane; i++, p += 3) {
          rgba[p] = data[i * 3] * 255;
          rgba[p + 1] = data[i * 3 + 1] * 255;
          rgba[p + 2] = data[i * 3 + 2] * 255;
        }
      } else {
        for (let i = 0, p = 0; i < oPlane; i++, p += 3) {
          rgba[p] = data[i] * 255;
          rgba[p + 1] = data[oPlane + i] * 255;
          rgba[p + 2] = data[oPlane * 2 + i] * 255;
        }
      }

      const tileBitmap = tileCanvas(oW, oH, rgba);
      const padX = (sx - x0) * MODEL_SCALE;
      const padY = (sy - y0) * MODEL_SCALE;
      const copyW = Math.min(tile, width - sx) * MODEL_SCALE;
      const copyH = Math.min(tile, height - sy) * MODEL_SCALE;

      octx.drawImage(
        tileBitmap,
        padX, padY, copyW, copyH,
        sx * scale, sy * scale, copyW * (scale / MODEL_SCALE), copyH * (scale / MODEL_SCALE),
      );

      output.dispose?.();
      done++;
      post({ type: 'tile', done, total, backend });
    }
  }

  const final = octx.getImageData(0, 0, outW, outH);
  post({ type: 'done', pixels: final.data.buffer, width: outW, height: outH, backend }, [final.data.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    await start();
    try {
      await upscale(data);
    } catch (error) {
      if (backend !== 'webgpu') throw error;
      try { session.release(); } catch { /* already gone */ }
      session = await createSession('wasm');
      backend = 'wasm';
      tile = 64;
      pad = 8;
      post({ type: 'backend', backend });
      await upscale(data);
    }
  } catch (error) {
    post({ type: 'error', message: String(error && error.message ? error.message : error) });
  }
};
