// « Cerveau DJ » : décide COMMENT et QUAND enchaîner deux morceaux,
// comme le ferait un DJ (tempo, tonalité, structure en phrases, énergie).
import { camelotCompat } from './analyze.js';

const mod = (x, m) => ((x % m) + m) % m;
export const beatLen = t => 60 / t.bpm;
export const barLen = t => 240 / t.bpm;
export const phraseLen = t => 1920 / t.bpm;

// énergie moyenne (0..1) d'un morceau entre deux positions
export function energy(t, a, b) {
  const n = t.nrg; if (!n || !n.length) return 1;
  const i0 = Math.max(0, Math.floor(a * 10)), i1 = Math.min(n.length, Math.ceil(b * 10));
  let s = 0; for (let i = i0; i < i1; i++) s += n[i];
  return i1 > i0 ? s / (i1 - i0) / 255 : 0;
}

// toutes les positions de début de phrase (8 mesures) dans [a, b]
function phrases(t, a, b) {
  const L = phraseLen(t), out = [];
  for (let p = t.phrase + Math.ceil((a - t.phrase) / L - 1e-6) * L; p <= b; p += L) out.push(p);
  return out;
}
export function nextBar(t, pos) {
  const L = barLen(t);
  return t.bar + Math.ceil((pos - t.bar) / L - 1e-6) * L;
}

// Vitesse à appliquer au morceau entrant pour caler son tempo (moitié/double acceptés)
export function tempoRatio(outBpm, inBpm) {
  let best = 1, d = Infinity;
  for (const m of [1, 2, 0.5]) {
    const r = outBpm / (inBpm * m);
    if (Math.abs(r - 1) < d) { d = Math.abs(r - 1); best = r; }
  }
  return best;
}

const TARGET = { full: Infinity, club: 150, express: 75 }; // secondes jouées par morceau
const STEADY = 1.5;   // fiabilité minimale de la grille pour caler deux morceaux
const MAXSTRETCH = 0.08;

// Recettes (comme un DJ / l'AutoMix) :
//  blend : long mélange calé, échange des basses au milieu (morceaux compatibles)
//  cut   : mélange court calé (4 mesures max) quand ça risque de se marcher dessus
//  echo  : sortie en écho puis le suivant démarre (tempos trop différents)
//  fade  : fondu filtré propre (rythme irrégulier)
export function planTransition(out, inn, { pos, playedFrom, mode = 'club', lead = 4 }) {
  const steady = out.conf >= STEADY && inn.conf >= STEADY;
  const r = tempoRatio(out.bpm, inn.bpm);
  const tempoOk = steady && Math.abs(r - 1) <= MAXSTRETCH;
  const keyOk = camelotCompat(out.camelot, inn.camelot);
  const B = beatLen(out), BAR = barLen(out);

  // point d'entrée du suivant : début de son intro, calé sur une phrase
  let inPos = inn.start;
  if (steady) {
    const ph = phrases(inn, inn.start - 0.1, inn.end);
    if (ph.length && ph[0] - inn.start <= 4 * barLen(inn)) inPos = ph[0];
    if (mode !== 'full' && inn.drop - inPos > 16 * barLen(inn) + 0.1) inPos = inn.drop - 16 * barLen(inn);
  }
  const introE = energy(inn, inPos, inPos + 8 * barLen(inn));

  let type = !steady ? 'fade' : !tempoOk ? 'echo' : 'blend';
  const mixLen = (ty, beats) => ty === 'blend' || ty === 'cut' ? beats * B : ty === 'echo' ? 2 * BAR : 6;
  const beatsFor = (ty, q) => {
    if (ty === 'cut') return 8;
    if (ty !== 'blend') return 0;
    const oe = energy(out, q, q + 32 * B);
    return keyOk && oe < 0.55 && introE < 0.55 ? 32 : 16;
  };
  const valid = (q, ty) => q >= pos + lead && q + mixLen(ty, beatsFor(ty, q)) <= out.end + B && energy(out, q, q + mixLen(ty, beatsFor(ty, q))) >= 0.12;

  // morceaux qui se marcheraient dessus : mix court
  if (type === 'blend' && (!keyOk || introE >= 0.7 || Math.abs(r - 1) > 0.045 || Math.abs(Math.log2(out.bpm / inn.bpm)) > 0.5)) type = 'cut';

  // point de sortie : début de phrase, de préférence dans une partie plus calme (outro)
  const PH = phraseLen(out);
  const cands = (steady ? phrases(out, Math.max(out.start, pos + lead), out.end) : (() => {
    const c = []; for (let q = Math.max(out.start, pos + lead); q <= out.end; q += 2) c.push(q); return c;
  })()).filter(q => valid(q, type));
  let outPos = null;
  if (cands.length) {
    const target = (playedFrom ?? out.start) + (TARGET[mode] || Infinity);
    let pool;
    if (mode === 'full') pool = cands.slice(-3);
    else {
      const minPos = Math.min(out.drop + 8 * BAR, cands[cands.length - 1]);
      pool = cands.filter(q => q >= minPos && q >= target - 2 * PH && q <= target + 3 * PH);
      if (!pool.length) pool = cands.filter(q => q >= target).slice(0, 1);
      if (!pool.length) pool = cands.slice(-1);
    }
    let best = Infinity;
    for (const q of pool) {
      const e = energy(out, q, q + mixLen(type, beatsFor(type, q)));
      const dist = mode === 'full' ? (cands[cands.length - 1] - q) / PH : Math.abs(q - target) / PH;
      const sc = e + 0.12 * dist;
      if (sc < best) { best = sc; outPos = q; }
    }
  }
  // trop tard pour une phrase : prochaine mesure, mix plus court
  if (outPos === null) {
    if (type === 'blend') type = 'cut';
    const q = steady ? nextBar(out, pos + Math.min(lead, 2.5)) : pos + 2.5;
    if (type === 'cut' && q + 8 * B > out.end + B) type = 'echo';
    outPos = q;
  }
  const mixBeats = beatsFor(type, outPos);

  const reason = {
    blend: mixBeats === 32 ? 'Blend long · 8 mesures' : 'Blend EQ · 4 mesures',
    cut: keyOk ? 'Mix court · intro chargée' : 'Mix court · tonalités différentes',
    echo: 'Sortie en écho · tempos éloignés',
    fade: 'Fondu filtré',
  }[type];

  return { type, outPos, inPos, mixBeats, r: tempoOk ? r : 1, tempoOk, keyOk, steady, reason };
}

// Point d'entrée « fort » pour le bouton Remix (début d'une phrase énergique)
export function remixInPos(inn) {
  return inn.conf >= STEADY ? Math.max(inn.start, inn.drop) : inn.start;
}
export { mod };
