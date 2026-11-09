// Worker untuk mod AI — supaya UI kekal responsif semasa inferens.
// Model dimuatkan dari CDN tetapi inferens berlaku pada peranti ini.

let engine = null;

self.onmessage = async (e) => {
  const { file, cdn } = e.data || {};
  try {
    if (!engine) {
      self.postMessage({ type: 'status', text: 'Memuatkan enjin AI…' });
      engine = await import(cdn);
    }
    const blob = await engine.removeBackground(file, {
      model: 'isnet_fp16',
      output: { format: 'image/png' },
      progress: (key, current, total) =>
        self.postMessage({ type: 'progress', key, current, total }),
    });
    self.postMessage({ type: 'done', blob });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
