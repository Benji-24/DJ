// Moteur DJ : deux platines virtuelles, mix calé sur la grille (temps, mesures, phrases),
// tempo ajusté SANS changer la hauteur, échange des basses, remix, effets en direct.
import { planTransition, remixInPos, beatLen, barLen } from './brain.js';

const XF = 0.04; // fondu de raccord (s)

function curve(from, to, shape = 'sin', n = 128) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const y = shape === 'sin' ? Math.sin(x * Math.PI / 2) : shape === 'cos' ? Math.cos(x * Math.PI / 2) : x;
    c[i] = shape === 'cos' ? to + (from - to) * y : from + (to - from) * y;
  }
  return c;
}
function setCurve(param, from, to, t0, dur, shape) {
  try { param.setValueAtTime(from, t0 - 0.003); param.setValueCurveAtTime(curve(from, to, shape), t0, dur); }
  catch (e) { param.setValueAtTime(from, t0); param.linearRampToValueAtTime(to, t0 + dur); }
}
function ramp(param, value, t0, dur, exp = false) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  if (exp) param.exponentialRampToValueAtTime(Math.max(value, 0.0001), t0 + dur);
  else param.linearRampToValueAtTime(value, t0 + dur);
}

class Voice {
  constructor(engine, track, buffer) {
    const c = engine.ctx;
    this.e = engine; this.ctx = c; this.track = track; this.buffer = buffer;
    this.input = c.createGain();
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 200; this.low.gain.value = 0;
    this.hp = c.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.7;
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.7;
    this.out = c.createGain();
    this.norm = c.createGain(); this.norm.gain.value = track.gain || 1;
    this.send = c.createGain(); this.send.gain.value = 0;
    this.input.connect(this.low); this.low.connect(this.hp); this.hp.connect(this.lp); this.lp.connect(this.out);
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
  startLinear(when, pos, rate = 1) {
    pos = Math.max(0, Math.min(pos, this.buffer.duration - 0.5));
    this.startPos = pos;
    this.lin = { t: when, p: pos, rate };
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
  pin(u) { // position relative dans la partie étirée
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
    this.bus = c.createGain(); this.bus.gain.value = 0.9;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 3; lim.ratio.value = 14; lim.attack.value = 0.002; lim.release.value = 0.15;
    this.bus.connect(lim); lim.connect(c.destination);
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 256; lim.connect(this.analyser);
    this.delayIn = c.createGain();
    this.delay = c.createDelay(4);
    this.fb = c.createGain(); this.fb.gain.value = 0.5;
    this.echoHP = c.createBiquadFilter(); this.echoHP.type = 'highpass'; this.echoHP.frequency.value = 280;
    this.delayIn.connect(this.delay); this.delay.connect(this.echoHP); this.echoHP.connect(this.fb); this.fb.connect(this.delay);
    this.delay.connect(this.bus);
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
    v.out.gain.linearRampToValueAtTime(1, this.now + 0.15);
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
    const needStretch = (p.type === 'blend' || p.type === 'quick') && Math.abs(p.r - 1) > 0.003;
    if (needStretch) {
      p.ready = false;
      const B = beatLen(cur.track);
      const hold = p.mixBeats * B;
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
    const out = this.cur, nx = this.next, c = this.ctx;
    if (this.fx.loop) this.loop(false);
    if (this.fx.filter) this.filter(false);
    if (this.fx.bass) this.bass(false);
    const v = new Voice(this, nx.track, nx.buffer);
    v.deck = out.deck === 'A' ? 'B' : 'A';
    const T0 = p.T0;
    const B = out.beatSec(T0);
    let swapAt, endAt;

    if (p.type === 'blend' || p.type === 'quick') {
      const L = p.mixBeats * B, half = L / 2;
      if (p.st) v.startStretched(T0, p.inPos, p.st);
      else {
        v.startLinear(T0, p.inPos, p.r);
        if (Math.abs(p.r - 1) > 0.003) { // secours si l'étirement n'est pas prêt
          for (let i = 1; i <= 16; i++) this.at(T0 + L + i * 0.5, () => { if (this.cur === v && !v.str) v.setRate(p.r + (1 - p.r) * i / 16, this.now + 0.03); });
        }
      }
      v.out.gain.setValueAtTime(0, c.currentTime);
      setCurve(v.out.gain, 0, 1, T0, half, 'sin');
      v.low.gain.setValueAtTime(-40, c.currentTime);
      v.low.gain.setValueAtTime(-40, T0 + half - B);
      v.low.gain.linearRampToValueAtTime(0, T0 + half);
      v.hp.frequency.setValueAtTime(220, c.currentTime);
      v.hp.frequency.setValueAtTime(220, T0);
      v.hp.frequency.exponentialRampToValueAtTime(10, T0 + half);
      out.low.gain.setValueAtTime(out.low.gain.value, T0 + half - B);
      out.low.gain.linearRampToValueAtTime(-40, T0 + half);
      out.hp.frequency.setValueAtTime(10, T0 + half);
      out.hp.frequency.exponentialRampToValueAtTime(260, T0 + L);
      setCurve(out.out.gain, 1, 0, T0 + half, half, 'cos');
      out.stop(T0 + L + 0.05);
      swapAt = T0 + half; endAt = T0 + L;
    } else if (p.type === 'echo') {
      this.delay.delayTime.setValueAtTime(B * 0.75, T0 - 0.05);
      this.fb.gain.setValueAtTime(0.55, T0 - 0.05);
      out.send.gain.setValueAtTime(0, c.currentTime);
      out.send.gain.setValueAtTime(1, T0);
      out.send.gain.setValueAtTime(0, T0 + B);
      out.out.gain.setValueAtTime(1, T0 + B * 0.5);
      out.out.gain.linearRampToValueAtTime(0, T0 + B);
      out.stop(T0 + B + 0.05);
      const tIn = T0 + 2 * B;
      v.startLinear(tIn, p.inPos, 1);
      v.out.gain.value = 1;
      swapAt = tIn; endAt = tIn + 6;
    } else { // fondu doux
      const D = 8;
      v.startLinear(T0, p.inPos, 1);
      v.out.gain.setValueAtTime(0, c.currentTime);
      setCurve(v.out.gain, 0, 1, T0, D * 0.6, 'sin');
      setCurve(out.out.gain, 1, 0, T0 + D * 0.3, D * 0.7, 'cos');
      out.lp.frequency.setValueAtTime(22000, T0);
      out.lp.frequency.exponentialRampToValueAtTime(500, T0 + D);
      out.stop(T0 + D + 0.05);
      swapAt = T0 + D / 2; endAt = T0 + D;
    }
    this.commit(v, out, swapAt, endAt + 0.5, p.type);
  }

  commit(v, old, swapAt, cleanupAt, kind) {
    this.committed = true; this.next = null; this.inc = v; this.lastKind = kind;
    this.emit('transition', { kind, track: v.track, at: swapAt });
    this.at(swapAt, () => {
      this.cur = v; this.inc = null; this.committed = false; this.plan = null;
      this.fx = { filter: false, bass: false, loop: false };
      this.emit('change', v.track);
    });
    this.at(cleanupAt, () => old.dispose());
  }

  // ---------- Remix : passer tout de suite à la suivante ----------
  remix(type) {
    if (!this.cur) return 'nocur';
    if (this.committed) return 'busy';
    if (!this.next) return 'nonext';
    if (this.paused) this.resume();
    const c = this.ctx, out = this.cur, nx = this.next, now = c.currentTime;
    if (this.fx.loop) this.loop(false);
    if (type === 'auto') {
      const types = ['echo', 'filter', 'loop', 'brake'].filter(t => t !== this.lastRemix);
      type = types[Math.floor(Math.random() * types.length)];
    }
    this.lastRemix = type;
    const B = out.beatSec(now);
    const t1 = out.nextBeatTime(now + 0.06);
    const rate = out.rateAt(t1);
    let tIn;

    if (type === 'echo') {
      this.delay.delayTime.setValueAtTime(B * 0.75, now);
      this.fb.gain.setValueAtTime(0.6, now);
      out.send.gain.setValueAtTime(0, now);
      out.send.gain.setValueAtTime(1, t1);
      out.send.gain.setValueAtTime(0, t1 + B);
      out.out.gain.setValueAtTime(out.out.gain.value, t1 + B * 0.25);
      out.out.gain.linearRampToValueAtTime(0, t1 + B * 0.5);
      out.stop(t1 + B + 0.05);
      tIn = t1 + 2 * B;
      this.fb.gain.setValueAtTime(0.6, tIn + 4 * B);
      this.fb.gain.linearRampToValueAtTime(0.35, tIn + 8 * B);
    } else if (type === 'filter') {
      const tEnd = t1 + 4 * B;
      out.hp.frequency.setValueAtTime(20, t1);
      out.hp.frequency.exponentialRampToValueAtTime(2500, tEnd);
      out.hp.Q.setValueAtTime(5, t1);
      this.riser(t1, tEnd);
      out.out.gain.setValueAtTime(out.out.gain.value, tEnd - 0.03);
      out.out.gain.linearRampToValueAtTime(0, tEnd);
      out.stop(tEnd + 0.05);
      tIn = tEnd;
    } else if (type === 'loop') {
      const p0 = out.posAt(t1), per = out.period;
      out.srcs.forEach(s => out.stopSrc(s, t1));
      let t = t1;
      for (const [len, rep] of [[1, 2], [0.5, 2], [0.25, 4], [0.125, 8]]) {
        const s = out.mk(out.buffer, rate);
        s.loop = true; s.loopStart = p0; s.loopEnd = p0 + len * per;
        s.start(t, p0);
        const dur = len * rep * B;
        s.stop(t + dur);
        t += dur;
      }
      out.hp.frequency.setValueAtTime(20, t1);
      out.hp.frequency.exponentialRampToValueAtTime(1200, t);
      out.out.gain.setValueAtTime(out.out.gain.value, t - 0.02);
      out.out.gain.linearRampToValueAtTime(0, t);
      tIn = t;
    } else { // frein de vinyle
      out.srcs.forEach(s => {
        const pr = s.playbackRate;
        pr.cancelScheduledValues(t1); pr.setValueAtTime(pr.value, t1); pr.linearRampToValueAtTime(0.02, t1 + 1.4);
      });
      out.out.gain.setValueAtTime(out.out.gain.value, t1 + 1.0);
      out.out.gain.linearRampToValueAtTime(0, t1 + 1.4);
      out.stop(t1 + 1.5);
      tIn = t1 + 1.45;
    }

    const v = new Voice(this, nx.track, nx.buffer);
    v.deck = out.deck === 'A' ? 'B' : 'A';
    v.out.gain.value = 1;
    v.startLinear(tIn, remixInPos(nx.track), 1);
    this.plan = null;
    this.commit(v, out, tIn, tIn + 12, type);
    return type;
  }

  riser(t0, t1) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
    const g = c.createGain();
    bp.frequency.setValueAtTime(400, t0); bp.frequency.exponentialRampToValueAtTime(7000, t1);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.14, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1);
    s.connect(bp); bp.connect(g); g.connect(this.bus);
    s.start(t0); s.stop(t1 + 0.05);
  }

  // ---------- Effets en direct ----------
  echoThrow() {
    const v = this.cur; if (!v) return;
    const now = this.now, B = v.beatSec(now), t1 = v.nextBeatTime(now + 0.03);
    this.delay.delayTime.setValueAtTime(B * 0.75, now);
    this.fb.gain.setValueAtTime(0.55, now);
    v.send.gain.setValueAtTime(0, now);
    v.send.gain.setValueAtTime(1, t1);
    v.send.gain.setValueAtTime(0, t1 + B);
  }
  filter(on) {
    const v = this.cur; if (!v) return;
    this.fx.filter = on;
    const B = v.beatSec();
    ramp(v.lp.frequency, on ? 350 : 22000, this.now, on ? 2 * B : B, true);
    ramp(v.lp.Q, on ? 4 : 0.7, this.now, B);
  }
  bass(on) {
    const v = this.cur; if (!v) return;
    this.fx.bass = on;
    ramp(v.low.gain, on ? -40 : 0, this.now, 0.06);
  }
  loop(on) {
    const v = this.cur; if (!v) return false;
    const now = this.now;
    if (on) {
      if (this.fx.loop || v.stretching) return false;
      const t1 = v.nextBeatTime(now + 0.03), p0 = v.posAt(t1);
      const s = v.mk(v.buffer, v.lin.rate);
      s.loop = true; s.loopStart = p0; s.loopEnd = p0 + 4 * v.period;
      v.stopSrc(v.src, t1);
      s.start(t1, p0);
      v.loopSrc = s; this.fx.loop = true;
    } else {
      if (!this.fx.loop) return false;
      const t = now + 0.02;
      v.stopSrc(v.loopSrc, t); v.loopSrc = null;
      const s = v.mk(v.buffer, v.lin.rate); s.start(t, Math.max(0, v.posAt(t)));
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
      if (p.T0 < now + 0.15) { this.plan = null; return; } // raté : on replanifie
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
