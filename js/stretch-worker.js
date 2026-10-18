// Étirement du tempo SANS changer la hauteur (comme le « key lock » des platines).
// Méthode WSOLA : on recolle de petits morceaux de son en cherchant à chaque fois
// la position qui s'enchaîne le mieux avec le morceau précédent.
//
// Carte de tempo : vitesse r0 pendant `hold` secondes (calage sur l'autre morceau),
// puis retour progressif à la vitesse normale (1) pendant `glide` secondes.

self.onmessage = ({ data }) => {
  const { id, L, R, sr, r0, hold, glide } = data;
  try {
    const out = stretch(L, R, sr, r0, hold, glide);
    self.postMessage({ id, ...out }, [out.L.buffer, out.R.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};

function stretch(L, R, sr, r0, hold, glide) {
  const N = 2048, Hs = N / 4, SEARCH = 128; // recouvrement 75 % : temps nets
  const seamT = hold + glide;
  const T = seamT + 0.15; // un peu de marge pour le fondu de raccord
  // position dans le morceau d'origine (s) pour un instant de sortie t (s)
  const pin = t => {
    if (t <= hold) return r0 * t;
    const u = Math.min(t - hold, glide);
    return r0 * hold + r0 * u + (1 - r0) * u * u / (2 * glide || 1) + Math.max(0, t - hold - glide);
  };
  const outLen = Math.ceil(T * sr) + N;
  const oL = new Float32Array(outLen), oR = new Float32Array(outLen);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)) * 0.5;
  const inLen = L.length;
  const M = new Float32Array(inLen);
  for (let i = 0; i < inLen; i++) M[i] = L[i] + R[i];

  let prev = 0; // position (échantillons) du morceau précédent dans l'entrée
  const frames = Math.ceil(T * sr / Hs) + 1;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(pin(k * Hs / sr) * sr);
    let pos = nominal;
    if (k > 0) {
      const target = Math.min(prev + Hs, inLen - N - 1); // suite « naturelle » du morceau précédent
      let best = -Infinity, bestD = 0;
      const lo = Math.max(-SEARCH, -nominal), hi = Math.min(SEARCH, inLen - N - nominal - 1);
      // recherche grossière (pas de 4), puis fine (pas de 1)
      for (let d = lo; d <= hi; d += 4) {
        let s = 0; const a = nominal + d;
        for (let i = 0; i < N; i += 8) s += M[a + i] * M[target + i];
        if (s > best) { best = s; bestD = d; }
      }
      const c = bestD; best = -Infinity;
      for (let d = Math.max(lo, c - 3); d <= Math.min(hi, c + 3); d++) {
        let s = 0; const a = nominal + d;
        for (let i = 0; i < N; i += 2) s += M[a + i] * M[target + i];
        if (s > best) { best = s; bestD = d; }
      }
      pos = nominal + bestD;
    }
    if (pos < 0) pos = 0;
    if (pos + N >= inLen) break;
    const o = k * Hs;
    for (let i = 0; i < N && o + i < outLen; i++) {
      const w = win[i];
      oL[o + i] += w * L[pos + i];
      oR[o + i] += w * R[pos + i];
    }
    prev = pos;
  }
  const n = Math.ceil(T * sr);
  return { L: oL.slice(0, n), R: oR.slice(0, n), seamT, seamPos: pin(seamT) };
}
