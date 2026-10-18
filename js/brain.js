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

export function planTransition(out, inn, { pos, playedFrom, mode = 'club', lead = 4 }) {
  const steady = out.conf >= 1.25 && inn.conf >= 1.25;
  const r = tempoRatio(out.bpm, inn.bpm);
  const tempoOk = steady && Math.abs(r - 1) <= 0.10;
  const keyOk = camelotCompat(out.camelot, inn.camelot);
  let type = tempoOk ? (keyOk ? 'blend' : 'quick') : (steady ? 'echo' : 'fade');

  const B = beatLen(out);
  const mixLen = ty => ty === 'blend' ? 32 * B : ty === 'quick' ? 16 * B : ty === 'echo' ? 4 * B : 8;
  const valid = (q, ty) => q >= pos + lead && q + mixLen(ty) <= out.end + B && energy(out, q, q + mixLen(ty)) >= 0.18;

  // 1) point de sortie : début d'une phrase (8 mesures)
  let cands = phrases(out, Math.max(out.start, pos + lead), out.end).filter(q => valid(q, type));
  let outPos = null;
  if (cands.length) {
    const target = (playedFrom ?? out.start) + (TARGET[mode] || Infinity);
    const minPos = Math.min(out.drop + 8 * barLen(out), cands[cands.length - 1]);
    const after = cands.filter(q => q >= target && q >= minPos);
    outPos = mode === 'full' || !after.length ? cands[cands.length - 1] : after[0];
  }
  // 2) trop tard pour une phrase : on se rabat sur la prochaine mesure, mix plus court
  if (outPos === null) {
    for (const ty of type === 'blend' ? ['quick', 'echo'] : type === 'quick' ? ['echo'] : [type]) {
      const q = steady ? nextBar(out, pos + Math.min(lead, 2.5)) : pos + 2.5;
      if (q + mixLen(ty) <= out.end + B || ty === 'echo' || ty === 'fade') { type = ty; outPos = q; break; }
    }
    if (outPos === null) { type = 'echo'; outPos = steady ? nextBar(out, pos + 1.5) : pos + 1.5; }
  }

  // 3) point d'entrée du morceau suivant
  let inPos;
  if (!steady || type === 'fade') inPos = inn.start;
  else {
    const ph = phrases(inn, inn.start - 0.1, inn.end);
    inPos = ph.length ? ph[0] : inn.start;
    if (inPos - inn.start > 4 * barLen(inn)) inPos = inn.start; // ne pas sauter une longue intro
    if (mode !== 'full') {
      const bars16 = 16 * barLen(inn);
      if (type === 'echo') inPos = Math.max(inn.start, inn.drop);
      else if (inn.drop - inPos > bars16 + 0.1) inPos = inn.drop - bars16; // intro raccourcie
    }
  }

  const reason = {
    blend: `Blend harmonique · 8 mesures`,
    quick: `Mix court · tonalités différentes`,
    echo: steady ? `Sortie en écho · tempos éloignés` : `Sortie en écho`,
    fade: `Fondu doux · rythme libre`,
  }[type];

  return {
    type, outPos, inPos, mixBeats: type === 'blend' ? 32 : type === 'quick' ? 16 : 0,
    r: tempoOk ? r : 1, tempoOk, keyOk, steady, reason,
  };
}

// Point d'entrée « fort » pour le bouton Remix
export function remixInPos(inn) {
  return inn.conf >= 1.25 ? Math.max(inn.start, inn.drop) : inn.start;
}
export { mod };
