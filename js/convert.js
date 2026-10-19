// Extraction du son des vidéos (MKV, MP4, MOV, WEBM, AVI…)
let worker = null;
let seq = 0;
const jobs = new Map();

export const isVideo = f =>
  /^video\//.test(f.type) || /\.(mkv|mka|mp4|m4v|mov|webm|avi|ts|flv)$/i.test(f.name);

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ffworker.js', import.meta.url));
  worker.onmessage = ({ data }) => {
    // la progression arrive sans id : elle concerne la tâche en cours
    const job = data.id != null ? jobs.get(data.id) : [...jobs.values()][0];
    if (!job) return;
    if (data.type === 'progress') job.onProgress && job.onProgress({ progress: data.p });
    else if (data.type === 'status') job.onProgress && job.onProgress({ status: data.s });
    else if (data.type === 'done') { jobs.delete(data.id); job.resolve(new Blob([data.bytes], { type: data.mime })); }
    else if (data.type === 'error') { jobs.delete(data.id); job.reject(new Error(data.msg)); }
  };
  worker.onerror = e => {
    for (const j of jobs.values()) j.reject(new Error('worker'));
    jobs.clear(); worker = null;
  };
  return worker;
}

// Les tâches passent une par une (ffmpeg ne fait qu'une chose à la fois)
let chain = Promise.resolve();
export function extractAudio(file, onProgress) {
  const p = chain.then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, file });
  }));
  chain = p.catch(() => { });
  return p;
}

// Encodage AAC d'une piste (pcm = Float32Array stéréo entrelacée)
export function encodeAAC(pcm, sr, onProgress, kbps = 192, fmt = 'aac') {
  const p = chain.then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, type: 'encode', pcm, sr, kbps, fmt }, [pcm.buffer]);
  }));
  chain = p.catch(() => { });
  return p;
}
