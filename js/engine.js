// Moteur DJ : deux platines virtuelles + table de mixage (EQ 3 bandes, filtres),
// mix calé sur la grille (temps, mesures, phrases), tempo ajusté SANS changer la hauteur,
// remix propres (sans clic ni saturation) et effets en direct.
import { planTransition, remixInPos, beatLen, tempoRatio } from './brain.js';

const XF = 0.04;   // fondu de raccord étirement → original (s)
const MICRO = 0.012; // micro-fondu anti-clic (s)
const KILL = -30;  // coupure d'une bande d'EQ (dB)

const eqCurve = (shape, n = 128) => {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = shape === 'in' ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2); }
  return c;
};
const CURVE_IN = eqCurve('in'), CURVE_OUT = eqCurve('out');
// fondu à puissance constante (pas de creux ni de bosse de volume)
function powerFade(param, dir, t0, dur, scale = 1) {
  const c = dir === 'in' ? CURVE_IN : CURVE_OUT;
  const curve = scale === 1 ? c : c.map(v => v * scale);
  try { param.setValueAtTime(curve[0], t0 - 0.002); param.setValueCurveAtTime(curve, t0, dur); }
  catch (e) { param.setValueAtTime(curve[0], t0); param.linearRampToValueAtTime(curve[curve.length - 1], t0 + dur); }
}
function ramp(param, value, t0, dur, exp = false) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  if (exp) param.exponentialRampToValueAtTime(Math.max(value, 0.0001), t0 + dur);
  else param.linearRampToValueAtTime(value, t0 + dur);
}
// écrêteur de sécurité : totalement transparent sous -2,5 dB, arrondi au-dessus
function softClipCurve() {
  const n = 4096, c = new Float32Array(n), T = 0.75;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1, a = Math.abs(x);
    c[i] = a <= T ? x : Math.sign(x) * (T + (1 - T) * Math.tanh((a - T) / (1 - T)));
  }
  return c;
}

class Voice {
  constructor(engine, track, buffer) {
    const c = engine.ctx;
    this.e = engine; this.ctx = c; this.track = track; this.buffer = buffer;
    this.input = c.createGain();
    // EQ 3 bandes comme sur une table de mixage DJ
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 250;
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
    this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.hp = c.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.7;
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.7;
    this.out = c.createGain();
    this.norm = c.createGain(); this.norm.gain.value = track.gain || 1;
    this.send = c.createGain(); this.send.gain.value = 0;
    this.input.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high);
    this.high.connect(this.hp); this.hp.connect(this.lp); this.lp.connect(this.out);
    this.out.connect(this.norm); this.norm.connect(engine.bus);
    this.lp.connect(this.send); this.send.connect(engine.delayIn);
    this.period = 60 / track.bpm;
    this.src = null; this.srcs = []; this.loopSrc = null;
    this.str = null; this.lin = { t: 0, p: 0, rate: 1 };
    this.startPos = 0; this.endT = Infinity;
  }
  mk(buffer, rate = 1, dest = this.input) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer; s.playbackRate.value = rate; s.connect(dest);
    this.srcs.push(s);
    return s;
  }
  fadeIn(when) {
    this.input.gain.setValueAtTime(0, Math.max(this.ctx.currentTime, when - 0.001));
    this.input.gain.linearRampToValueAtTime(1, when + MICRO);
  }
  // coupe proprement à l'instant t (micro-fondu)
  cutAt(t) {
    this.input.gain.setValueAtTime(1, t - MICRO);
    this.input.gain.linearRampToValueAtTime(0, t);
    this.stop(t + 0.02);
  }
  startLinear(when, pos, rate = 1, fade = true) {
    pos = Math.max(0, Math.min(pos, this.buffer.duration - 0.5));
    this.startPos = pos;
    this.lin = { t: when, p: pos, rate };
    if (fade) this.fadeIn(when);
    this.src = this.mk(this.buffer, rate);
    this.src.start(when, pos);
    this.endT = when + (this.buffer.duration - pos) / rate;
  }
  // Début calé : version étirée (même hauteur) puis raccord invisible avec l'original
  startStretched(when, pos, st) {
    this.startPos = pos;
    const c = this.ctx;
    const gS = c.createGain(), gO = c.createGain();
    gS.connect(this.input); gO.connect(this.input);
    const s1 = this.mk(st.buffer, 1, gS);
    s1.start(when);
    const seam = when + st.seamT, p2 = pos + st.seamPos;
    gS.gain.setValueAtTime(1, seam - XF); gS.gain.linearRampToValueAtTime(0, seam + XF);
    gO.gain.setValueAtTime(0, c.currentTime); gO.gain.setValueAtTime(0, seam - XF); gO.gain.linearRampToValueAtTime(1, seam + XF);
    s1.stop(seam + XF + 0.02);
    this.src = this.mk(this.buffer, 1, gO);
    this.src.start(seam - XF, Math.max(0, p2 - XF));
    this.str = { when, pos, r0: st.r0, hold: st.hold, glide: st.glide, seam };
    this.lin = { t: seam, p: p2, rate: 1 };
    this.endT = seam + (this.buffer.duration - p2);
  }
  pin(u) {
    const { r0, hold, glide } = this.str;
    if (u <= hold) return r0 * u;
    const v = Math.min(u - hold, glide);
    return r0 * hold + r0 * v + (1 - r0) * v * v / (2 * glide || 1);
  }
  posAt(t) {
    if (this.str && t < this.str.seam) return this.str.pos + this.pin(t - this.str.when);
    return this.lin.p + (t - this.lin.t) * this.lin.rate;
  }
  rateAt(t) {
    if (this.str && t < this.str.seam) {
      const u = t - this.str.when, { r0, hold, glide } = this.str;
      return u <= hold ? r0 : r0 + (1 - r0) * Math.min(1, (u - hold) / (glide || 1));
    }
    return this.lin.rate;
  }
  timeOfPos(p) {
    if (this.str && p < this.lin.p) {
      let a = this.str.when - 600, b = this.str.seam;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (this.posAt(m) < p) a = m; else b = m; }
      return (a + b) / 2;
    }
    return this.lin.t + (p - this.lin.p) / this.lin.rate;
  }
  nextGridTime(t, len, off) {
    const p = this.posAt(t);
    return this.timeOfPos(off + Math.ceil((p - off) / len - 1e-6) * len);
  }
  nextBeatTime(t) { return this.nextGridTime(t, this.period, this.track.beat); }
  nextBarTime(t) { return this.nextGridTime(t, 4 * this.period, this.track.bar); }
  beatSec(t) { return this.period / this.rateAt(t ?? this.ctx.currentTime); }
  get stretching() { return !!(this.str && this.ctx.currentTime < this.str.seam); }
  setRate(r, when) {
    const p = this.posAt(when);
    this.str = null;
    this.lin = { t: when, p, rate: r };
    if (this.src) this.src.playbackRate.setValueAtTime(r, when);
    this.endT = when + (this.buffer.duration - p) / r;
  }
  // morceau de son en boucle, avec micro-fondus (aucun clic à la jonction)
  loopBuffer(p0, len) {
    const b = this.buffer, sr = b.sampleRate, n = Math.max(64, Math.round(len * sr)), a = Math.floor(p0 * sr);
    const out = this.ctx.createBuffer(b.numberOfChannels, n, sr);
    const f = Math.min(Math.floor(n / 4), Math.round(0.003 * sr));
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const src = b.getChannelData(ch), dst = out.getChannelData(ch);
      for (let i = 0; i < n; i++) dst[i] = src[a + i] || 0;
      for (let i = 0; i < f; i++) { const g = i / f; dst[i] *= g; dst[n - 1 - i] *= g; }
    }
    return out;
  }
  stopSrc(s, when) { try { s && s.stop(when); } catch (e) { } }
  stop(when) { this.srcs.forEach(s => this.stopSrc(s, when)); }
  dispose() {
    this.stop(this.ctx.currentTime);
    try { this.out.disconnect(); this.send.disconnect(); this.norm.disconnect(); } catch (e) { }
  }
}

export class Engine {
  constructor() {
    this.ctx = null; this.cur = null; this.inc = null; this.next = null;
    this.committed = false; this.events = []; this.plan = null; this.mode = 'club';
    this.listeners = {}; this.fx = { filter: false, bass: false, loop: false };
    this.jobId = 0; this.jobs = new Map();
  }
  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, ...a) { (this.listeners[name] || []).forEach(f => f(...a)); }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = this.ctx = new AC({ latencyHint: 'playback' });
    // Chaîne master : marge de volume → compresseur doux → écrêteur doux (jamais de saturation dure)
    this.bus = c.createGain(); this.bus.gain.value = 0.78;
    const glue = c.createDynamicsCompressor();
    glue.threshold.value = -14; glue.knee.value = 12; glue.ratio.value = 2.5; glue.attack.value = 0.012; glue.release.value = 0.3;
    const clip = c.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = '2x';
    this.master = c.createGain(); this.master.gain.value = 0.92;
    this.bus.connect(glue); glue.connect(clip); clip.connect(this.master); this.master.connect(c.destination);
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 256; this.master.connect(this.analyser);
    // Écho (chaud : filtré dans la boucle)
    this.delayIn = c.createGain();
    this.delay = c.createDelay(4);
    this.fb = c.createGain(); this.fb.gain.value = 0.4;
    const ehp = c.createBiquadFilter(); ehp.type = 'highpass'; ehp.frequency.value = 250;
    const elp = c.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 4500;
    this.echoOut = c.createGain(); this.echoOut.gain.value = 0.75;
    this.delayIn.connect(this.delay); this.delay.connect(ehp); ehp.connect(elp); elp.connect(this.fb); this.fb.connect(this.delay);
    elp.connect(this.echoOut); this.echoOut.connect(this.bus);
    const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
    try { const u = c.createBufferSource(); u.buffer = c.createBuffer(1, 1, c.sampleRate); u.connect(c.destination); u.start(); } catch (e) { }
    if (c.state === 'suspended') c.resume();
    this.stretcher = new Worker(new URL('./stretch-worker.js', import.meta.url));
    this.stretcher.onmessage = ({ data }) => { const j = this.jobs.get(data.id); if (j) { this.jobs.delete(data.id); j(data); } };
    this.timer = setInterval(() => this.tick(), 50);
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  get playing() { return !!this.cur; }
  at(t, fn) { this.events.push({ t, fn }); }
  pause() { if (this.ctx) { this.paused = true; this.ctx.suspend(); } }
  resume() { if (this.ctx) { this.paused = false; this.ctx.resume(); } }
  setMode(m) { this.mode = m; if (!this.committed) this.plan = null; }

  stopAll() {
    this.events = [];
    if (this.cur) this.cur.dispose();
    if (this.inc) this.inc.dispose();
    this.cur = this.inc = this.next = null; this.committed = false; this.plan = null;
    this.fx = { filter: false, bass: false, loop: false };
  }

  play(track, buffer, pos) {
    this.stopAll();
    if (this.paused) this.resume();
    const v = new Voice(this, track, buffer);
    v.deck = 'A';
    v.out.gain.setValueAtTime(0, this.now);
    v.out.gain.linearRampToValueAtTime(1, this.now + 0.2);
    v.startLinear(this.now + 0.05, pos ?? track.start, 1);
    this.cur = v;
    this.emit('change', track);
  }

  setNext(item) {
    if (this.committed) return;
    this.next = item;
    this.plan = null;
  }

  // ---------- Préparation de la transition ----------
  makePlan() {
    const cur = this.cur, nx = this.next, now = this.now;
    const p = planTransition(cur.track, nx.track, { pos: cur.posAt(now), playedFrom: cur.startPos, mode: this.mode });
    p.T0 = cur.timeOfPos(p.outPos);
    p.ready = true;
    const overlap = p.type === 'blend' || p.type === 'cut';
    if (overlap && Math.abs(p.r - 1) > 0.003) {
      p.ready = false;
      const hold = p.mixBeats * beatLen(cur.track);
      const glide = 16 * beatLen(nx.track);
      const sr = nx.buffer.sampleRate;
      const need = (p.r * hold + (p.r + 1) / 2 * glide + 1.2) * sr;
      const a = Math.floor(p.inPos * sr), b = Math.min(nx.buffer.length, a + Math.ceil(need));
      const L = nx.buffer.getChannelData(0).slice(a, b);
      const R = (nx.buffer.numberOfChannels > 1 ? nx.buffer.getChannelData(1) : nx.buffer.getChannelData(0)).slice(a, b);
      const id = ++this.jobId;
      this.jobs.set(id, res => {
        if (this.plan !== p || res.error) return;
        const buf = this.ctx.createBuffer(2, res.L.length, sr);
        buf.copyToChannel(res.L, 0); buf.copyToChannel(res.R, 1);
        p.st = { buffer: buf, seamT: res.seamT, seamPos: res.seamPos, r0: p.r, hold, glide };
        p.ready = true;
        this.emit('plan', p);
      });
      this.stretcher.postMessage({ id, L, R, sr, r0: p.r, hold, glide }, [L.buffer, R.buffer]);
    }
    this.plan = p;
    this.emit('plan', p);
  }

  transition(p) {
    const out = this.cur, nx = this.next, c = this.ctx, now = c.currentTime;
    if (this.fx.loop) this.loop(false);
    if (this.fx.filter) this.filter(false);
    if (this.fx.bass) this.bass(false);
    const v = new Voice(this, nx.track, nx.buffer);
    v.deck = out.deck === 'A' ? 'B' : 'A';
    const T0 = p.T0;
    const B = out.beatSec(T0);
    let swapAt, endAt;

    if (p.type === 'blend' || p.type === 'cut') {
      // Mix calé façon DJ : le suivant entre sans basses et médiums réduits,
      // échange des basses au milieu, puis le précédent s'efface.
      const L = p.mixBeats * B, half = L / 2;
      if (p.st) v.startStretched(T0, p.inPos, p.st);
      else {
        v.startLinear(T0, p.inPos, p.r, false);
        if (Math.abs(p.r - 1) > 0.003) {
          for (let i = 1; i <= 16; i++) this.at(T0 + L + i * 0.5, () => { if (this.cur === v && !v.str) v.setRate(p.r + (1 - p.r) * i / 16, this.now + 0.03); });
        }
      }
      const midCut = p.type === 'cut' ? -9 : -6;
      v.out.gain.setValueAtTime(0, now);
      powerFade(v.out.gain, 'in', T0, half, 0.92);
      v.out.gain.setValueAtTime(0.92, T0 + half);
      v.out.gain.linearRampToValueAtTime(1, T0 + half + B);
      v.low.gain.setValueAtTime(KILL, now);
      v.low.gain.setValueAtTime(KILL, T0 + half - B / 2);
      v.low.gain.linearRampToValueAtTime(0, T0 + half);
      v.mid.gain.setValueAtTime(midCut, now);
      v.mid.gain.setValueAtTime(midCut, T0);
      v.mid.gain.linearRampToValueAtTime(0, T0 + half);
      out.low.gain.setValueAtTime(out.low.gain.value, T0 + half - B / 2);
      out.low.gain.linearRampToValueAtTime(KILL, T0 + half);
      out.mid.gain.setValueAtTime(out.mid.gain.value, T0 + half);
      out.mid.gain.linearRampToValueAtTime(-6, T0 + L);
      out.high.gain.setValueAtTime(out.high.gain.value, T0 + half);
      out.high.gain.linearRampToValueAtTime(-8, T0 + L);
      if (p.type === 'cut') {
        out.lp.frequency.setValueAtTime(22000, T0);
        out.lp.frequency.exponentialRampToValueAtTime(2500, T0 + half);
      }
      out.out.gain.setValueAtTime(1, T0 + half - 0.01);
      powerFade(out.out.gain, 'out', T0 + half, half);
      out.stop(T0 + L + 0.05);
      swapAt = T0 + half; endAt = T0 + L;
    } else if (p.type === 'echo') {
      this.echoSetup(B, now);
      out.send.gain.setValueAtTime(0, now);
      out.send.gain.setValueAtTime(0.8, T0);
      out.send.gain.setValueAtTime(0, T0 + B);
      out.out.gain.setValueAtTime(1, T0 + B * 0.5);
      out.out.gain.linearRampToValueAtTime(0, T0 + B);
      out.stop(T0 + B + 0.05);
      const tIn = T0 + 2 * B;
      v.startLinear(tIn, p.inPos, 1);
      v.out.gain.value = 1;
      this.echoRelease(tIn + 4 * B);
      swapAt = tIn; endAt = tIn + 6;
    } else { // fondu filtré (rythmes non calables)
      const D = 6;
      v.startLinear(T0, p.inPos, 1, false);
      v.out.gain.setValueAtTime(0, now);
      powerFade(v.out.gain, 'in', T0, D * 0.7);
      v.hp.frequency.setValueAtTime(700, now);
      v.hp.frequency.setValueAtTime(700, T0);
      v.hp.frequency.exponentialRampToValueAtTime(10, T0 + D * 0.8);
      out.out.gain.setValueAtTime(1, T0 + D * 0.3 - 0.01);
      powerFade(out.out.gain, 'out', T0 + D * 0.3, D * 0.7);
      out.lp.frequency.setValueAtTime(22000, T0);
      out.lp.frequency.exponentialRampToValueAtTime(300, T0 + D);
      out.stop(T0 + D + 0.05);
      swapAt = T0 + D / 2; endAt = T0 + D;
    }
    this.commit(v, out, swapAt, endAt + 0.5, p.type, p.type === 'echo' ? T0 : T0, endAt);
  }

  echoSetup(B, t) {
    this.delay.delayTime.setValueAtTime(B * 0.75, t);
    this.fb.gain.cancelScheduledValues(t);
    this.fb.gain.setValueAtTime(0.45, t);
  }
  echoRelease(t) {
    this.fb.gain.setValueAtTime(0.45, t);
    this.fb.gain.linearRampToValueAtTime(0.2, t + 3);
  }

  commit(v, old, swapAt, cleanupAt, kind, t0, t1) {
    this.committed = true; this.next = null; this.inc = v; this.lastKind = kind;
    this.mix = { t0: t0 ?? this.now, t1: Math.max(t1 ?? swapAt, swapAt), from: old.deck, to: v.deck };
    this.emit('transition', { kind, track: v.track, at: swapAt });
    this.at(swapAt, () => {
      this.cur = v; this.inc = null; this.committed = false; this.plan = null;
      this.fx = { filter: false, bass: false, loop: false };
      this.emit('change', v.track);
    });
    this.at(cleanupAt, () => old.dispose());
  }

  // ---------- Remix : passer tout de suite à la suivante, comme un DJ ----------
  remix(type) {
    if (!this.cur) return 'nocur';
    if (this.committed) return 'busy';
    if (!this.next) return 'nonext';
    if (this.paused) this.resume();
    const c = this.ctx, out = this.cur, nx = this.next, now = c.currentTime;
    if (this.fx.loop) this.loop(false);
    if (type === 'auto') {
      const close = Math.abs(tempoRatio(out.track.bpm, nx.track.bpm) - 1) <= 0.08;
      const pool = (close ? ['filter', 'loop', 'echo'] : ['echo', 'brake', 'filter']).filter(t => t !== this.lastRemix);
      type = pool[Math.floor(Math.random() * pool.length)];
    }
    this.lastRemix = type;
    const B = out.beatSec(now);
    const t1 = out.nextBeatTime(now + 0.06);
    let tIn;

    if (type === 'echo') {
      // écho sur 1 temps puis le suivant tombe sur la mesure
      this.echoSetup(B, now);
      out.send.gain.setValueAtTime(0, now);
      out.send.gain.setValueAtTime(0.8, t1);
      out.send.gain.setValueAtTime(0, t1 + B);
      out.out.gain.setValueAtTime(out.out.gain.value, t1 + B * 0.5);
      out.out.gain.linearRampToValueAtTime(0, t1 + B);
      out.stop(t1 + B + 0.05);
      tIn = t1 + 2 * B;
      this.echoRelease(tIn + 4 * B);
    } else if (type === 'filter') {
      // montée : filtre qui ouvre les aigus sur 1 mesure, le suivant tombe sur le « 1 »
      const tEnd = out.nextBarTime(t1 + 4 * B - 0.05);
      out.hp.frequency.setValueAtTime(20, t1);
      out.hp.frequency.exponentialRampToValueAtTime(900, tEnd);
      out.hp.Q.setValueAtTime(0.9, t1);
      out.low.gain.setValueAtTime(out.low.gain.value, t1);
      out.low.gain.linearRampToValueAtTime(KILL, tEnd - B);
      this.riser(t1, tEnd);
      out.cutAt(tEnd);
      tIn = tEnd;
    } else if (type === 'loop') {
      // boucle qui se resserre (1 temps → ½ → ¼), sans clic
      const p0 = out.posAt(t1), per = out.period, rate = out.rateAt(t1);
      out.input.gain.setValueAtTime(1, t1);
      out.srcs.forEach(s => out.stopSrc(s, t1 + 0.004));
      let t = t1;
      for (const [len, rep] of [[1, 2], [0.5, 2], [0.25, 4]]) {
        const s = out.mk(out.loopBuffer(p0, len * per), rate);
        s.loop = true;
        s.start(t);
        const dur = len * rep * B;
        s.stop(t + dur);
        t += dur;
      }
      out.hp.frequency.setValueAtTime(20, t1);
      out.hp.frequency.exponentialRampToValueAtTime(600, t);
      out.out.gain.setValueAtTime(out.out.gain.value, t - MICRO);
      out.out.gain.linearRampToValueAtTime(0, t);
      tIn = t;
    } else { // frein de vinyle
      out.srcs.forEach(s => {
        const pr = s.playbackRate;
        pr.cancelScheduledValues(t1); pr.setValueAtTime(pr.value, t1); pr.linearRampToValueAtTime(0.001, t1 + 1.2);
      });
      out.out.gain.setValueAtTime(out.out.gain.value, t1 + 0.7);
      out.out.gain.linearRampToValueAtTime(0, t1 + 1.2);
      out.stop(t1 + 1.25);
      tIn = t1 + 1.15;
    }

    const v = new Voice(this, nx.track, nx.buffer);
    v.deck = out.deck === 'A' ? 'B' : 'A';
    v.out.gain.value = 1;
    v.startLinear(tIn, remixInPos(nx.track), 1);
    this.plan = null;
    this.commit(v, out, tIn, tIn + 12, type, now, tIn + 0.3);
    return type;
  }

  riser(t0, t1) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000;
    const g = c.createGain();
    bp.frequency.setValueAtTime(300, t0); bp.frequency.exponentialRampToValueAtTime(4500, t1);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.045, t1 - 0.05); g.gain.linearRampToValueAtTime(0, t1);
    s.connect(bp); bp.connect(lp); lp.connect(g); g.connect(this.bus);
    s.start(t0); s.stop(t1 + 0.05);
  }

  // ---------- Effets en direct ----------
  echoThrow() {
    const v = this.cur; if (!v) return;
    const now = this.now, B = v.beatSec(now), t1 = v.nextBeatTime(now + 0.03);
    this.echoSetup(B, now);
    v.send.gain.setValueAtTime(0, now);
    v.send.gain.setValueAtTime(0.7, t1);
    v.send.gain.setValueAtTime(0, t1 + B);
  }
  filter(on) {
    const v = this.cur; if (!v) return;
    this.fx.filter = on;
    const B = v.beatSec();
    ramp(v.lp.frequency, on ? 600 : 22000, this.now, on ? 2 * B : B, true);
    ramp(v.lp.Q, on ? 1.4 : 0.7, this.now, B);
  }
  bass(on) {
    const v = this.cur; if (!v) return;
    this.fx.bass = on;
    ramp(v.low.gain, on ? KILL : 0, this.now, 0.08);
  }
  loop(on) {
    const v = this.cur; if (!v) return false;
    const now = this.now;
    if (on) {
      if (this.fx.loop || v.stretching) return false;
      const t1 = v.nextBeatTime(now + 0.03), p0 = v.posAt(t1);
      const s = v.mk(v.loopBuffer(p0, 4 * v.period), v.lin.rate);
      s.loop = true;
      v.stopSrc(v.src, t1 + 0.004);
      s.start(t1);
      v.loopSrc = s; this.fx.loop = true;
    } else {
      if (!this.fx.loop) return false;
      const t = now + 0.03;
      v.stopSrc(v.loopSrc, t + 0.004); v.loopSrc = null;
      const s = v.mk(v.buffer, v.lin.rate);
      const g = this.ctx.createGain(); s.disconnect(); s.connect(g); g.connect(v.input);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.006);
      s.start(t, Math.max(0, v.posAt(t)));
      v.src = s; this.fx.loop = false;
    }
    return true;
  }

  // ---------- Horloge ----------
  tick() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.events.length) {
      const due = this.events.filter(e => e.t <= now);
      this.events = this.events.filter(e => e.t > now);
      due.sort((a, b) => a.t - b.t).forEach(e => { try { e.fn(); } catch (err) { console.error(err); } });
    }
    if (!this.cur || this.committed) return;
    if (this.next && !this.plan) this.makePlan();
    const p = this.plan;
    if (p) {
      if (p.T0 < now + 0.15) { this.plan = null; return; }
      if (p.T0 - now <= 0.8) {
        if (this.fx.loop) this.loop(false);
        this.transition(p);
      }
    } else if (!this.next && now >= this.cur.endT) {
      const t = this.cur.track;
      this.cur.dispose(); this.cur = null; this.plan = null;
      this.emit('end', t);
    }
  }
}
