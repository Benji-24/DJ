// Analyse d'un morceau : tempo (BPM), grille des temps, début/fin utiles,
// "passage fort" (pour démarrer un remix dessus) et forme d'onde.

const FPS = 100; // trames d'analyse par seconde

export function analyzeBuffer(buffer) {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const hop = Math.round(sr / FPS);
  const frames = Math.floor(buffer.length / hop);
  const duration = buffer.duration;

  // 1) Énergie (RMS) de tout le morceau
  const rms = new Float32Array(frames);
  let maxRms = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const o = f * hop;
    for (let i = 0; i < hop; i += 4) { const x = (L[o + i] + R[o + i]) * 0.5; s += x * x; }
    const v = Math.sqrt(s / (hop / 4));
    rms[f] = v;
    if (v > maxRms) maxRms = v;
  }

  // 2) Début et fin utiles (on saute les silences)
  const thr = maxRms * 0.04;
  let fStart = 0; while (fStart < frames - 1 && rms[fStart] < thr) fStart++;
  let fEnd = frames - 1; while (fEnd > fStart && rms[fEnd] < thr) fEnd--;
  const contentStart = fStart / FPS;
  const contentEnd = Math.min(duration, (fEnd + 1) / FPS);

  // 3) Tempo : on écoute les basses (grosse caisse) sur un extrait de 45 s
  const exStart = Math.min(Math.max(contentStart, duration * 0.25), Math.max(0, contentEnd - 45));
  const exLen = Math.min(45, contentEnd - exStart);
  const s0 = Math.floor(exStart * sr), n = Math.floor(exLen * sr);
  const a = 1 - Math.exp(-2 * Math.PI * 150 / sr); // filtre passe-bas ~150 Hz
  const exFrames = Math.floor(n / hop);
  const env = new Float32Array(exFrames);
  let y = 0;
  for (let f = 0; f < exFrames; f++) {
    let s = 0;
    const o = s0 + f * hop;
    for (let i = 0; i < hop; i++) { const x = (L[o + i] + R[o + i]) * 0.5; y += a * (x - y); s += y * y; }
    env[f] = Math.sqrt(s / hop);
  }
  // Attaques (hausse d'énergie)
  const onset = new Float32Array(exFrames);
  let mean = 0;
  for (let f = 1; f < exFrames; f++) { const d = env[f] - env[f - 1]; onset[f] = d > 0 ? d : 0; mean += onset[f]; }
  mean /= Math.max(1, exFrames);
  for (let f = 0; f < exFrames; f++) onset[f] = Math.max(0, onset[f] - mean);

  const scoreFor = (bpm) => {
    const p = FPS * 60 / bpm;
    let best = -1, bestPhase = 0;
    for (let ph = 0; ph < p; ph += 1) {
      let s = 0, c = 0;
      for (let k = ph; k < exFrames; k += p) { const i = Math.round(k); if (i < exFrames) { s += onset[i]; c++; } }
      s /= Math.max(1, c);
      if (s > best) { best = s; bestPhase = ph; }
    }
    return { score: best, phase: bestPhase };
  };

  let bestBpm = 120, bestScore = -1;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const { score } = scoreFor(bpm);
    // léger favoritisme autour de 120 BPM pour éviter les erreurs de moitié/double
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 122) / 0.6, 2));
    const w = score * (0.6 + 0.4 * prior);
    if (w > bestScore) { bestScore = w; bestBpm = bpm; }
  }
  // affinage
  let fine = bestBpm, fineScore = -1, phase = 0;
  for (let bpm = bestBpm - 0.6; bpm <= bestBpm + 0.6; bpm += 0.05) {
    const r = scoreFor(bpm);
    if (r.score > fineScore) { fineScore = r.score; fine = bpm; phase = r.phase; }
  }
  let bpm = Math.round(fine * 100) / 100;
  if (bpm < 85) bpm *= 2;
  const period = 60 / bpm;
  const firstBeatInExcerpt = exStart + phase / FPS;
  const beat = ((firstBeatInExcerpt % period) + period) % period; // position d'un temps

  const snapUp = t => beat + Math.ceil((t - beat) / period - 1e-6) * period;
  const snapDown = t => beat + Math.floor((t - beat) / period + 1e-6) * period;

  const start = Math.max(0, snapUp(contentStart));
  const end = Math.max(start + period, snapDown(contentEnd));

  // 4) Passage fort : premier bloc de 8 temps très énergique
  const block = period * 8;
  const blocks = [];
  for (let t = start; t + block <= end; t += block) {
    const f0 = Math.floor(t * FPS), f1 = Math.floor((t + block) * FPS);
    let s = 0; for (let f = f0; f < f1; f++) s += rms[f] || 0;
    blocks.push({ t, e: s / (f1 - f0) });
  }
  let drop = start;
  if (blocks.length) {
    const emax = Math.max(...blocks.map(b => b.e));
    const lo = duration * 0.08, hi = duration * 0.7;
    const cand = blocks.find(b => b.t >= lo && b.t <= hi && b.e >= emax * 0.85)
      || blocks.find(b => b.e >= emax * 0.85);
    if (cand) drop = cand.t;
  }

  // 5) Forme d'onde (pour l'affichage)
  const N = 160, peaks = [];
  for (let i = 0; i < N; i++) {
    const f0 = Math.floor(i * frames / N), f1 = Math.max(f0 + 1, Math.floor((i + 1) * frames / N));
    let m = 0; for (let f = f0; f < f1; f++) if (rms[f] > m) m = rms[f];
    peaks.push(Math.round(100 * m / (maxRms || 1)));
  }

  return { duration, bpm, beat, start, end, drop, peaks };
}
