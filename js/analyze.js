// Analyse musicale complète d'un morceau (faite une seule fois, à l'import) :
// - tempo précis + grille des temps + fiabilité
// - premier temps de chaque mesure et début des phrases (8 mesures)
// - passage fort (drop), début/fin utiles
// - tonalité (notation Camelot, comme les DJ)
// - volume (pour que tous les morceaux sonnent au même niveau)
// - forme d'onde 3 bandes (basses / médiums / aigus) pour l'affichage

export const ANALYSIS_VERSION = 2;
const FPS = 100;

const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const PROF_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROF_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function analyzeBuffer(buffer) {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const len = buffer.length, duration = buffer.duration;
  const hop = sr / FPS;
  const frames = Math.floor(len / hop);

  // ---------- 1) Passage unique : bandes de fréquences par trame ----------
  const aLow = 1 - Math.exp(-2 * Math.PI * 180 / sr);
  const aMid = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
  let yl = 0, ym = 0;
  const eFull = new Float32Array(frames), eLow = new Float32Array(frames),
    eMid = new Float32Array(frames), eHigh = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = Math.floor(f * hop), e = Math.floor((f + 1) * hop);
    let sf = 0, sl = 0, sm = 0, sh = 0;
    for (let i = o; i < e; i++) {
      const x = (L[i] + R[i]) * 0.5;
      yl += aLow * (x - yl);
      ym += aMid * (x - ym);
      const lo = yl, mi = ym - yl, hi = x - ym;
      sf += x * x; sl += lo * lo; sm += mi * mi; sh += hi * hi;
    }
    const n = e - o || 1;
    eFull[f] = Math.sqrt(sf / n); eLow[f] = Math.sqrt(sl / n); eMid[f] = Math.sqrt(sm / n); eHigh[f] = Math.sqrt(sh / n);
  }
  let maxFull = 1e-9;
  for (let f = 0; f < frames; f++) if (eFull[f] > maxFull) maxFull = eFull[f];

  // ---------- 2) Début / fin utiles ----------
  const thr = maxFull * 0.05;
  let fs = 0; while (fs < frames - 1 && eFull[fs] < thr) fs++;
  let fe = frames - 1; while (fe > fs && eFull[fe] < thr) fe--;
  const contentStart = fs / FPS, contentEnd = Math.min(duration, (fe + 1) / FPS);

  // ---------- 3) Courbe d'attaques (grosse caisse + caisse claire/charley) ----------
  const onset = new Float32Array(frames);
  const onLow = new Float32Array(frames);
  {
    const lg = v => Math.log(1 + 1000 * v);
    let pl = lg(eLow[0]), ph = lg(eHigh[0] + eMid[0] * 0.5);
    for (let f = 1; f < frames; f++) {
      const l = lg(eLow[f]), h = lg(eHigh[f] + eMid[f] * 0.5);
      const dl = Math.max(0, l - pl), dh = Math.max(0, h - ph);
      onLow[f] = dl; onset[f] = dl * 0.65 + dh * 0.35;
      pl = l; ph = h;
    }
    // on retire la moyenne locale (≈ 1 s) pour ne garder que les pics
    const W = 50; let acc = 0; const tmp = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      acc += onset[f]; if (f >= 2 * W) acc -= onset[f - 2 * W];
      const c = f - W; if (c >= 0) tmp[c] = Math.max(0, onset[c] - acc / (2 * W));
    }
    onset.set(tmp);
  }
  const at = (arr, x) => { const i = Math.floor(x); if (i < 0 || i + 1 >= arr.length) return 0; const t = x - i; return arr[i] * (1 - t) + arr[i + 1] * t; };

  // Score d'une grille (tempo, phase) sur une zone
  const combScore = (bpm, f0, f1, phaseStep = 1) => {
    const p = FPS * 60 / bpm;
    let best = -1, bestPh = 0;
    for (let ph = 0; ph < p; ph += phaseStep) {
      let s = 0, c = 0;
      for (let k = f0 + ph; k < f1; k += p) { s += at(onset, k); c++; }
      s /= Math.max(1, c);
      if (s > best) { best = s; bestPh = ph; }
    }
    return { score: best, phase: bestPh };
  };

  // ---------- 4) Tempo ----------
  const fA = Math.floor(contentStart * FPS), fB = Math.floor(contentEnd * FPS);
  const mid = Math.floor((fA + fB) / 2);
  const ex0 = Math.max(fA, mid - 3000), ex1 = Math.min(fB, mid + 3000); // ~60 s au milieu
  const cand = [];
  let sum = 0, cnt = 0;
  for (let bpm = 70; bpm <= 185; bpm += 0.25) {
    const { score } = combScore(bpm, ex0, ex1, 1);
    cand.push({ bpm, score }); sum += score; cnt++;
  }
  const mean = sum / cnt;
  const scoreOf = b => { let best = 0; for (const c of cand) if (Math.abs(c.bpm - b) < 0.6 && c.score > best) best = c.score; return best; };
  let bestBpm = 120, bestW = -1;
  for (const c of cand) {
    // un tempo « vrai » est aussi soutenu par sa moitié et son double
    const support = c.score + 0.35 * scoreOf(c.bpm / 2) + 0.2 * scoreOf(c.bpm * 2);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(c.bpm / 124) / 0.55, 2));
    const w = support * (0.55 + 0.45 * prior);
    if (w > bestW) { bestW = w; bestBpm = c.bpm; }
  }
  // affinage sur tout le morceau (précision ~0.01 BPM)
  let bpm = bestBpm, phase = 0, bestS = -1;
  for (let b = bestBpm - 0.4; b <= bestBpm + 0.4; b += 0.02) {
    const r = combScore(b, fA, fB, 0.5);
    if (r.score > bestS) { bestS = r.score; bpm = b; phase = r.phase; }
  }
  bpm = Math.round(bpm * 100) / 100;
  const conf = Math.min(5, bestS / (mean || 1e-9));
  const period = 60 / bpm;
  const beat0 = (fA + phase) / FPS; // un temps, en secondes

  // ---------- 5) Premier temps des mesures & phrases ----------
  const beatsN = Math.floor((contentEnd - beat0) / period);
  const nrgAt = (t0, t1) => { const a = Math.max(0, Math.floor(t0 * FPS)), b = Math.min(frames, Math.floor(t1 * FPS)); let s = 0; for (let f = a; f < b; f++) s += eFull[f]; return b > a ? s / (b - a) / maxFull : 0; };
  const lowAtBeat = i => { const f = (beat0 + i * period) * FPS; return Math.max(at(onLow, f - 1), at(onLow, f), at(onLow, f + 1)); };
  const novelty = (t, w) => Math.abs(nrgAt(t, t + w) - nrgAt(t - w, t));
  let downPh = 0, bestD = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0, c = 0;
    for (let i = ph; i < beatsN; i += 4) { s += lowAtBeat(i) + 3 * novelty(beat0 + i * period, 4 * period); c++; }
    s /= Math.max(1, c);
    if (s > bestD) { bestD = s; downPh = ph; }
  }
  const bar0 = beat0 + downPh * period;
  const barLen = 4 * period;
  const barsN = Math.floor((contentEnd - bar0) / barLen);
  let phrasePh = 0, bestP = -1;
  for (let ph = 0; ph < 8; ph++) {
    let s = 0, c = 0;
    for (let m = ph; m < barsN; m += 8) { s += novelty(bar0 + m * barLen, 4 * barLen); c++; }
    s /= Math.max(1, c);
    if (s > bestP) { bestP = s; phrasePh = ph; }
  }
  const phrase0 = bar0 + phrasePh * barLen;
  const phraseLen = 8 * barLen;
  const mod = (x, m) => ((x % m) + m) % m;

  // début = premier temps de mesure après le début du son
  const firstBar = bar0 + Math.ceil((contentStart - 0.05 - bar0) / barLen) * barLen;
  const start = Math.max(0, firstBar);
  const end = Math.max(start + barLen, contentEnd);

  // ---------- 6) Drop : première phrase très énergique ----------
  const phrases = [];
  for (let t = mod(phrase0, phraseLen); t < contentEnd; t += phraseLen) if (t + phraseLen * 0.5 > start) phrases.push(t);
  let drop = start;
  if (phrases.length) {
    const en = phrases.map(t => nrgAt(Math.max(t, start), Math.min(t + phraseLen, end)));
    const emax = Math.max(...en);
    const i = en.findIndex((e, k) => e >= emax * 0.82 && phrases[k] >= start);
    if (i >= 0) drop = Math.max(start, phrases[i]);
  }

  // ---------- 7) Volume perçu (moyenne des passages forts) ----------
  const sorted = Array.from(eFull.subarray(fs, fe + 1)).sort((a, b) => a - b);
  let sq = 0, nn = 0;
  for (let i = Math.floor(sorted.length * 0.5); i < sorted.length; i++) { sq += sorted[i] * sorted[i]; nn++; }
  const loud = Math.sqrt(sq / Math.max(1, nn)) || 1e-4;
  const gain = Math.min(2.2, Math.max(0.3, 0.2 / loud));

  // ---------- 8) Tonalité ----------
  const { key, camelot, keyConf, chroma, bassChroma } = detectKey(L, R, sr, contentStart, contentEnd);
  const keyInfo = { key, camelot, keyConf };
  if (globalThis.__keyDebug) globalThis.__keyDebug.push({ chroma, bassChroma });

  // ---------- 9) Formes d'onde ----------
  const WF = 50, step = FPS / WF, wn = Math.floor(frames / step);
  const wl = new Uint8Array(wn), wm = new Uint8Array(wn), wh = new Uint8Array(wn);
  let mx = 1e-9;
  for (let f = 0; f < frames; f++) mx = Math.max(mx, eLow[f], eMid[f] * 1.6, eHigh[f] * 3);
  for (let i = 0; i < wn; i++) {
    let a = 0, b = 0, c = 0;
    for (let k = 0; k < step; k++) { const f = i * step + k; a = Math.max(a, eLow[f]); b = Math.max(b, eMid[f]); c = Math.max(c, eHigh[f]); }
    wl[i] = Math.min(255, 255 * a / mx); wm[i] = Math.min(255, 255 * b * 1.6 / mx); wh[i] = Math.min(255, 255 * c * 3 / mx);
  }
  const nr = Math.floor(frames / 10), nrg = new Uint8Array(nr);
  for (let i = 0; i < nr; i++) { let s = 0; for (let k = 0; k < 10; k++) s += eFull[i * 10 + k]; nrg[i] = Math.min(255, 255 * s / 10 / maxFull); }
  const peaks = [];
  for (let i = 0; i < 160; i++) {
    const a = Math.floor(i * frames / 160), b = Math.max(a + 1, Math.floor((i + 1) * frames / 160));
    let m = 0; for (let f = a; f < b; f++) if (eFull[f] > m) m = eFull[f];
    peaks.push(Math.round(100 * m / maxFull));
  }

  return {
    v: ANALYSIS_VERSION, duration, bpm, conf: Math.round(conf * 100) / 100,
    beat: mod(beat0, period), bar: mod(bar0, barLen), phrase: mod(phrase0, phraseLen),
    start, end, drop, gain, ...keyInfo,
    wave: { fps: WF, low: wl, mid: wm, high: wh }, nrg, peaks,
  };
}

// ---------- Tonalité (profils de Krumhansl sur un chromagramme) ----------
function detectKey(L, R, sr, t0, t1) {
  const D = Math.max(1, Math.round(sr / 11025)); // ~11 kHz
  const fsd = sr / D, N = 4096, HOP = 4096;
  const a = Math.floor(t0 * sr), b = Math.floor(t1 * sr);
  const total = Math.floor((b - a) / D);
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const pcOf = f => ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  const binPc = new Int8Array(N / 2).fill(-1), binBass = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * fsd / N;
    if (f >= 65 && f <= 2100) binPc[k] = pcOf(f);
    if (f >= 55 && f < 260) binBass[k] = pcOf(f);
  }
  const chroma = new Float64Array(12), bassC = new Float64Array(12);
  const maxFrames = 600, stride = Math.max(HOP, Math.floor((total - N) / maxFrames));
  const spec = () => { const m = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) m[k] = Math.hypot(re[k], im[k]); return m; };
  const frameAt = s => {
    for (let i = 0; i < N; i++) {
      const o = a + (s + i) * D;
      let x = 0; for (let d = 0; d < D; d++) x += L[o + d] + R[o + d];
      re[i] = x * win[i]; im[i] = 0;
    }
    fft(re, im); return spec();
  };
  const SUB = 1024;
  for (let s = 0; s + N + 2 * SUB < total; s += stride) {
    // minimum sur 3 trames voisines : garde les notes tenues, enlève les percussions
    const m0 = frameAt(s), m1 = frameAt(s + SUB), m2 = frameAt(s + 2 * SUB);
    const mag = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.min(m0[k], m1[k], m2[k]);
    const fr = new Float64Array(12), fb = new Float64Array(12);
    for (let k = 2; k < N / 2 - 1; k++) {
      if (binPc[k] < 0 && binBass[k] < 0) continue;
      if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue; // pics seulement
      if (binPc[k] >= 0) fr[binPc[k]] += Math.sqrt(mag[k]);
      if (binBass[k] >= 0) fb[binBass[k]] += mag[k];
    }
    let m = 0, mb = 0; for (let i = 0; i < 12; i++) { m = Math.max(m, fr[i]); mb = Math.max(mb, fb[i]); }
    if (m > 0) for (let i = 0; i < 12; i++) chroma[i] += fr[i] / m;
    if (mb > 0) for (let i = 0; i < 12; i++) bassC[i] += fb[i] / mb;
  }
  return { ...keyFromChroma(chroma, bassC), chroma: Array.from(chroma), bassChroma: Array.from(bassC) };
}

const PROF_T_MAJ = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
const PROF_T_MIN = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];
export function keyFromChroma(chroma, bassC, opt = {}) {
  const { bassW = 0, profiles = 'mix' } = opt;
  const norm = v => { let m = 0; for (const x of v) m = Math.max(m, x); return Array.from(v, x => x / (m || 1)); };
  const c = norm(chroma), bc = norm(bassC);
  const corr = (vec, prof, rot) => {
    let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += vec[(i + rot) % 12]; my += prof[i]; }
    mx /= 12; my /= 12;
    let n = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) { const x = vec[(i + rot) % 12] - mx, y = prof[i] - my; n += x * y; dx += x * x; dy += y * y; }
    return n / Math.sqrt(dx * dy || 1);
  };
  const sets = profiles === 'k' ? [[PROF_MAJ, PROF_MIN]] : profiles === 't' ? [[PROF_T_MAJ, PROF_T_MIN]] : [[PROF_MAJ, PROF_MIN], [PROF_T_MAJ, PROF_T_MIN]];
  let best = -9, tonic = 0, minor = false;
  for (let r = 0; r < 12; r++) for (const mi of [false, true]) {
    let sc = 0;
    for (const [M, m] of sets) sc += corr(c, mi ? m : M, r) / sets.length;
    // la basse insiste souvent sur la tonique (et sa quinte)
    sc += bassW * (bc[r] - 0.5 * (bc[(r + 5) % 12] + bc[(r + 7) % 12]) * 0.5);
    if (sc > best) { best = sc; tonic = r; minor = mi; }
  }
  return {
    key: PITCH[tonic] + (minor ? 'm' : ''),
    camelot: minor ? CAMELOT_MIN[tonic] : CAMELOT_MAJ[tonic],
    keyConf: Math.round(best * 100) / 100,
  };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, ang = -2 * Math.PI / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let s = 0; s < n; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = s + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Compatibilité harmonique (roue Camelot)
export function camelotCompat(a, b) {
  if (!a || !b) return false;
  const na = parseInt(a), nb = parseInt(b), la = a.slice(-1), lb = b.slice(-1);
  if (na === nb) return true;                      // même tonalité ou relative
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  return la === lb && d === 1;                     // voisine sur la roue
}
