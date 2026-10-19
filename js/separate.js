// Séparation des pistes par IA (htdemucs, Meta) directement sur l'iPhone.
// Le modèle est découpé en 21 morceaux exécutés à la suite sur la puce graphique (WebGPU).
// Sortie : voix et batterie (le reste = morceau − voix − batterie, calculé ensuite).
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';
import { prepareModelInput, standaloneIspec } from '../vendor/demucs-web/processor.js';
import { CONSTANTS } from '../vendor/demucs-web/constants.js';

const { TRAINING_SAMPLES: SEG, MODEL_SPEC_BINS: BINS, MODEL_SPEC_FRAMES: FRAMES } = CONSTANTS;
const BASE = new URL('../vendor/demucs/', import.meta.url).href;
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];
const OVERLAP = 0.25;
const TRACK = { drums: 0, bass: 1, other: 2, vocals: 3 };

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

let sessions = null, manifest = null, lastUse = null, provider = null, loading = null;

async function fetchBytes(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('model ' + r.status);
  const total = +r.headers.get('Content-Length') || 0;
  if (!r.body || !onBytes) { const b = await r.arrayBuffer(); onBytes && onBytes(b.byteLength); return b; }
  const reader = r.body.getReader(), chunks = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; onBytes(value.length); }
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

// WebGPU utilisable pour ce modèle (il lui faut les calculs en demi-précision « shader-f16 »)
export async function hasWebGPU() {
  try {
    const nav = globalThis.navigator; if (!nav || !nav.gpu) return false;
    const a = await nav.gpu.requestAdapter(); return !!(a && a.features && a.features.has('shader-f16'));
  } catch (e) { return false; }
}

// Chargement (une seule fois) : ~126 Mo, gardés hors-ligne par l'appli
export function load({ onProgress, prefer } = {}) {
  if (loading) return loading;
  loading = (async () => {
    manifest = await (await fetch(BASE + 'htdemucs_split_manifest.json')).json();
    provider = prefer || ((await hasWebGPU()) ? 'webgpu' : 'wasm');
    const sizes = 126e6; let got = 0;
    const tick = n => { got += n; onProgress && onProgress({ phase: 'model', progress: Math.min(1, got / sizes) }); };
    // dernière utilisation de chaque tenseur intermédiaire (pour libérer la mémoire au plus tôt)
    lastUse = new Map();
    manifest.pieces.forEach((p, i) => p.inputs.forEach(n => lastUse.set(n, i)));
    sessions = [];
    for (let i = 0; i < manifest.pieces.length; i++) {
      const p = manifest.pieces[i];
      const bytes = await fetchBytes(BASE + p.file, tick);
      const final = p.outputs.includes(manifest.outputs.freq) || p.outputs.includes(manifest.outputs.time);
      const opts = { graphOptimizationLevel: 'all' };
      if (provider === 'webgpu') {
        opts.executionProviders = [i === 0 ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu'];
        opts.preferredOutputLocation = final ? 'cpu' : 'gpu-buffer';
      } else {
        opts.executionProviders = ['wasm'];
        opts.enableCpuMemArena = false;
      }
      sessions.push(await ort.InferenceSession.create(bytes, opts));
    }
    return provider;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

async function runSegment(waveform, magSpec) {
  const t = new Map();
  t.set('mix', new ort.Tensor('float32', waveform, [1, 2, SEG]));
  t.set('mag', new ort.Tensor('float32', magSpec, [1, 4, BINS, FRAMES]));
  const keepCpu = new Set(['mix', 'mag']);
  let x = null, xt = null;
  for (let i = 0; i < manifest.pieces.length; i++) {
    const p = manifest.pieces[i], feeds = {};
    for (const n of p.inputs) feeds[n] = t.get(n);
    const res = await sessions[i].run(feeds);
    for (const n of p.outputs) t.set(n, res[n]);
    // libérer ce qui ne servira plus
    for (const n of p.inputs) if (lastUse.get(n) === i && !keepCpu.has(n)) { const v = t.get(n); try { v.dispose && v.dispose(); } catch (e) { } t.delete(n); }
    if (res[manifest.outputs.freq]) x = res[manifest.outputs.freq];
    if (res[manifest.outputs.time]) xt = res[manifest.outputs.time];
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }
  const xd = x.location === 'cpu' || !x.getData ? x.data : await x.getData();
  const xtd = xt.location === 'cpu' || !xt.getData ? xt.data : await xt.getData();
  for (const v of t.values()) { try { v.location && v.location !== 'cpu' && v.dispose(); } catch (e) { } }
  return { x: xd, xt: xtd };
}

// Spectre d'une piste (sortie fréquentielle) → signal
function freqTrack(x, track) {
  const per = BINS * FRAMES, base = track * 4 * per;
  return standaloneIspec({
    leftReal: x.subarray(base, base + per), leftImag: x.subarray(base + per, base + 2 * per),
    rightReal: x.subarray(base + 2 * per, base + 3 * per), rightImag: x.subarray(base + 3 * per, base + 4 * per),
  }, SEG);
}

// left/right : Float32Array à 44,1 kHz. Renvoie { vocals, drums } (stéréo).
export async function separate(left, right, { onProgress, tracks = ['vocals', 'drums'] } = {}) {
  if (!sessions) await load({ onProgress });
  const total = left.length;
  const stride = Math.floor(SEG * (1 - OVERLAP));
  const nSeg = Math.max(1, Math.ceil((total - SEG) / stride) + 1);
  const out = {}; for (const k of tracks) out[k] = { left: new Float32Array(total), right: new Float32Array(total) };
  const weights = new Float32Array(total);
  let k = 0;
  for (let start = 0; start < total; start += stride) {
    const end = Math.min(start + SEG, total), len = end - start;
    const sl = new Float32Array(SEG), sr = new Float32Array(SEG);
    sl.set(left.subarray(start, end)); sr.set(right.subarray(start, end));
    const inp = prepareModelInput(sl, sr);
    const { x, xt } = await runSegment(inp.waveform, inp.magSpec);
    const win = new Float32Array(len);
    for (let i = 0; i < len; i++) win[i] = Math.min(1, i / (stride * 0.5), (len - i) / (stride * 0.5));
    for (const name of tracks) {
      const ti = TRACK[name], f = freqTrack(x, ti), o = out[name];
      const tl = ti * 2 * SEG, tr = tl + SEG;
      for (let i = 0; i < len; i++) {
        o.left[start + i] += (xt[tl + i] + f.left[i]) * win[i];
        o.right[start + i] += (xt[tr + i] + f.right[i]) * win[i];
      }
    }
    for (let i = 0; i < len; i++) weights[start + i] += win[i];
    k++;
    onProgress && onProgress({ phase: 'separate', progress: k / nSeg });
    await new Promise(r => setTimeout(r, 0));
    if (end >= total) break;
  }
  for (const name of tracks) {
    const o = out[name];
    for (let i = 0; i < total; i++) { const w = weights[i]; if (w > 0) { o.left[i] /= w; o.right[i] /= w; } }
  }
  return out;
}

export function backend() { return provider; }
