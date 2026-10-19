// Préparation des pistes séparées d'un morceau (faite une fois, en arrière-plan) :
// 1) séparation voix / batterie par l'IA, 2) reste = morceau − voix − batterie (somme exacte),
// 3) courbes de présence (voix, batterie), 4) compression AAC, 5) mesure du décalage d'encodage.
import { encodeAAC } from './convert.js';

const SR = 44100;
let worker = null, seq = 0, mode = null;
const jobs = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./stems-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const j = jobs.get(data.id); if (!j) return;
    if (data.type === 'progress') j.onProgress && j.onProgress(data);
    else { jobs.delete(data.id); data.type === 'error' ? j.reject(new Error(data.msg)) : j.resolve(data); }
  };
  worker.onerror = e => { for (const j of jobs.values()) j.reject(new Error('worker ' + (e.message || ''))); jobs.clear(); worker = null; };
  return worker;
}
function call(msg, transfer = [], onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq; jobs.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

// Où faire tourner l'IA : travailleur + puce graphique, sinon page + puce graphique, sinon processeur
export async function pickMode() {
  if (mode) return mode;
  let wGpu = false;
  try { wGpu = (await Promise.race([call({ type: 'probe' }), new Promise(r => setTimeout(() => r({ gpu: false }), 8000))])).gpu; } catch (e) { }
  if (wGpu) return (mode = 'worker-gpu');
  const S = await import('./separate.js');
  if (await S.hasWebGPU()) return (mode = 'main-gpu');
  return (mode = 'worker-cpu');
}
export const usesMainThread = () => mode === 'main-gpu';

async function separate(L, R, onProgress) {
  const m = await pickMode();
  if (m === 'main-gpu') {
    const S = await import('./separate.js');
    const out = await S.separate(L, R, { onProgress });
    return { vocals: out.vocals, drums: out.drums, backend: 'webgpu' };
  }
  const res = await call({ type: 'separate', left: L.slice(), right: R.slice(), prefer: m === 'worker-gpu' ? 'webgpu' : 'wasm' }, [], onProgress);
  return res;
}

function curve(L, R, ref) {
  const hop = SR / 10, n = Math.floor(L.length / hop), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const o = i * hop;
    for (let k = 0; k < hop; k += 2) { const a = L[o + k], b = R[o + k]; s += a * a + b * b; }
    const rms = Math.sqrt(s / hop);
    out[i] = Math.min(255, Math.round(255 * rms / (ref * 0.6)));
  }
  return out;
}
function interleave(L, R) {
  const out = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { out[2 * i] = L[i]; out[2 * i + 1] = R[i]; }
  return out;
}
// décalage introduit par l'encodage : corrélation entre la piste encodée et l'original
function measureOffset(src, dec) {
  const n = src.length, W = Math.min(SR * 3, Math.floor(n / 3)), a = Math.floor(n / 2 - W / 2), MAX = 4096;
  let e0 = 0; for (let i = 0; i < W; i += 4) e0 += src[a + i] * src[a + i];
  if (e0 < 1e-6) return 0;
  let best = -Infinity, lag = 0;
  for (let d = -MAX; d <= MAX; d++) {
    let s = 0;
    for (let i = 0; i < W; i += 8) s += src[a + i] * (dec[a + i + d] || 0);
    if (s > best) { best = s; lag = d; }
  }
  return lag;
}

export async function makeStems(blob, { onProgress, loud = 0.2 } = {}) {
  const say = (phase, progress) => onProgress && onProgress({ phase, progress });
  say('decode', 0);
  const oc = new OfflineAudioContext(2, 1, SR);
  const buf = await oc.decodeAudioData(await blob.arrayBuffer());
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0);
  const sep = await separate(L, R, e => say(e.phase === 'model' ? 'model' : 'separate', e.progress));
  const v = sep.vocals, d = sep.drums;
  // reste = morceau − voix − batterie (ainsi les 3 pistes redonnent exactement le morceau)
  const rL = new Float32Array(L.length), rR = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) { rL[i] = L[i] - v.left[i] - d.left[i]; rR[i] = R[i] - v.right[i] - d.right[i]; }
  const vox = curve(v.left, v.right, loud), drm = curve(d.left, d.right, loud);
  const blobs = {};
  // AAC (iPhone) ; MP3 si l'appareil ne sait pas lire l'AAC
  let fmt = 'aac';
  try { if (!new Audio().canPlayType('audio/mp4; codecs="mp4a.40.2"')) fmt = 'mp3'; } catch (e) { }
  const parts = [['vox', v.left, v.right], ['drums', d.left, d.right], ['rest', rL, rR]];
  for (let k = 0; k < parts.length; k++) {
    const [name, a, b] = parts[k];
    say('encode', k / parts.length);
    blobs[name] = await encodeAAC(interleave(a, b), SR, null, 192, fmt);
  }
  say('check', 1);
  let ofs = 0;
  try {
    const dec = await new OfflineAudioContext(2, 1, SR).decodeAudioData(await blobs.rest.arrayBuffer());
    ofs = measureOffset(rL, dec.getChannelData(0)) / SR;
  } catch (e) { }
  return { blobs, vox, drm, stemOfs: ofs, backend: sep.backend || 'webgpu' };
}
