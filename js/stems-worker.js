// Travailleur d'arrière-plan : séparation des pistes sans bloquer l'appli.
import { separate, load, hasWebGPU, backend } from './separate.js';

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'probe') { self.postMessage({ id, type: 'done', gpu: await hasWebGPU() }); return; }
    if (type === 'separate') {
      const prog = e => self.postMessage({ id, type: 'progress', ...e });
      await load({ onProgress: prog, prefer: data.prefer });
      const out = await separate(data.left, data.right, { onProgress: prog });
      const t = [out.vocals.left.buffer, out.vocals.right.buffer, out.drums.left.buffer, out.drums.right.buffer];
      self.postMessage({ id, type: 'done', backend: backend(), vocals: out.vocals, drums: out.drums }, t);
    }
  } catch (e) {
    self.postMessage({ id, type: 'error', msg: String(e && e.message || e) });
  }
};
