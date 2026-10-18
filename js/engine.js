// Moteur DJ : deux "platines" virtuelles, transitions calées sur le tempo,
// remix pour passer à la suivante, effets en direct.

export function matchRate(outBpm, inBpm) {
  // On cherche la vitesse qui cale le morceau entrant sur le tempo actuel
  // (en acceptant moitié/double tempo). Au-delà de ±8 %, on ne force pas.
  const cands = [outBpm / inBpm, (outBpm * 2) / inBpm, outBpm / (inBpm * 2)];
  let best = cands[0];
  for (const c of cands) if (Math.abs(c - 1) < Math.abs(best - 1)) best = c;
  if (Math.abs(best - 1) <= 0.08) return { rate: best, matched: true };
  return { rate: 1, matched: false };
}

class Voice {
  constructor(engine, track, buffer) {
    const c = engine.ctx;
    this.e = engine; this.ctx = c; this.track = track; this.buffer = buffer;
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220; this.low.gain.value = 0;
    this.hp = c.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.7;
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.7;
    this.out = c.createGain();
    this.send = c.createGain(); this.send.gain.value = 0;
    this.low.connect(this.hp); this.hp.connect(this.lp); this.lp.connect(this.out); this.out.connect(engine.bus);
    this.lp.connect(this.send); this.send.connect(engine.delayIn);
    this.period = 60 / track.bpm;
    this.rate = 1; this.anchorT = 0; this.anchorP = 0;
    this.src = null; this.extra = []; this.loopSrc = null;
    this.endT = Infinity;
  }
  mk(rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer; s.playbackRate.value = rate; s.connect(this.low);
    return s;
  }
  start(when, pos, rate) {
    pos = Math.max(0, Math.min(pos, this.buffer.duration - 0.5));
    this.rate = rate; this.anchorT = when; this.anchorP = pos;
    this.src = this.mk(rate);
    this.src.start(when, pos);
    this.endT = when + (this.buffer.duration - pos) / rate;
  }
  posAt(t) { return this.anchorP + (t - this.anchorT) * this.rate; }
  timeOfPos(p) { return this.anchorT + (p - this.anchorP) / this.rate; }
  nextBeatTime(t) {
    const p = this.posAt(t), off = this.track.beat;
    const k = Math.ceil((p - off) / this.period - 1e-6);
    return this.timeOfPos(off + k * this.period);
  }
  beatSec() { return this.period / this.rate; }
  setRate(r, when) {
    const p = this.posAt(when);
    this.anchorP = p; this.anchorT = when; this.rate = r;
    if (this.src) this.src.playbackRate.setValueAtTime(r, when);
    this.endT = when + (this.buffer.duration - p) / r;
  }
  stopSrc(s, when) { try { s && s.stop(when); } catch (e) { /* déjà arrêté */ } }
  stop(when) {
    this.stopSrc(this.src, when);
    this.stopSrc(this.loopSrc, when);
    this.extra.forEach(s => this.stopSrc(s, when));
  }
  dispose() {
    this.stop(this.ctx.currentTime);
    try { this.out.disconnect(); this.send.disconnect(); } catch (e) { }
  }
}

function ramp(param, value, t0, dur, exp = false) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  if (exp) param.exponentialRampToValueAtTime(Math.max(value, 0.0001), t0 + dur);
  else param.linearRampToValueAtTime(value, t0 + dur);
}

export class Engine {
  constructor() {
    this.ctx = null; this.cur = null; this.next = null;
    this.committed = false; this.events = []; this.plan = null;
    this.listeners = {}; this.fx = { filter: false, bass: false, loop: false };
  }
  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, ...a) { (this.listeners[name] || []).forEach(f => f(...a)); }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = this.ctx = new AC({ latencyHint: 'playback' });
    this.bus = c.createGain();
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 4; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.2;
    this.bus.connect(lim); lim.connect(c.destination);
    // Écho partagé (avec filtre dans la boucle, façon dub)
    this.delayIn = c.createGain();
    this.delay = c.createDelay(4);
    this.fb = c.createGain(); this.fb.gain.value = 0.5;
    this.echoHP = c.createBiquadFilter(); this.echoHP.type = 'highpass'; this.echoHP.frequency.value = 300;
    this.delayIn.connect(this.delay); this.delay.connect(this.echoHP); this.echoHP.connect(this.fb); this.fb.connect(this.delay);
    this.delay.connect(this.bus);
    // Bruit blanc pour la montée (riser)
    const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = nb;
    // petit son muet pour débloquer l'audio sur iPhone
    try { const u = c.createBufferSource(); u.buffer = c.createBuffer(1, 1, c.sampleRate); u.connect(c.destination); u.start(); } catch (e) { }
    if (c.state === 'suspended') c.resume();
    this.timer = setInterval(() => this.tick(), 100);
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  get playing() { return !!this.cur; }
  at(t, fn) { this.events.push({ t, fn }); }

  pause() { if (this.ctx) { this.paused = true; this.ctx.suspend(); } }
  resume() { if (this.ctx) { this.paused = false; this.ctx.resume(); } }

  stopAll() {
    this.events = [];
    if (this.cur) this.cur.dispose();
    if (this.inc) this.inc.dispose();
    this.cur = this.inc = this.next = null; this.committed = false; this.plan = null;
    this.fx = { filter: false, bass: false, loop: false };
  }

  play(track, buffer) {
    this.stopAll();
    if (this.paused) this.resume();
    const v = new Voice(this, track, buffer);
    v.out.gain.value = 1;
    v.start(this.now + 0.08, track.start, 1);
    this.cur = v;
    this.emit('change', track);
  }

  setNext(item) {
    if (this.committed) return;
    this.next = item; // {track, buffer} ou null
  }

  // ---------- Transition automatique ----------
  planAuto() {
    const cur = this.cur, nx = this.next;
    if (!cur || !nx || this.committed) return null;
    const now = this.now;
    const { rate, matched } = matchRate(cur.track.bpm * cur.rate, nx.track.bpm);
    const beats = matched ? 32 : 16;
    const off = cur.track.beat, per = cur.period;
    let mixP = cur.track.end - beats * per;
    mixP = off + Math.floor((mixP - off) / per) * per;
    let T0 = cur.timeOfPos(mixP);
    if (T0 < now + 0.25) T0 = cur.nextBeatTime(now + 0.25);
    let D = matched ? beats * cur.beatSec() : Math.min(10, beats * cur.beatSec());
    const remaining = cur.endT - T0;
    D = Math.max(1, Math.min(D, remaining));
    return { T0, D, rate, matched };
  }

  transition(plan) {
    const { T0, D, rate, matched } = plan;
    const out = this.cur, nx = this.next, c = this.ctx;
    if (this.fx.loop) this.loop(false);
    const v = new Voice(this, nx.track, nx.buffer);
    v.out.gain.setValueAtTime(0, c.currentTime);
    v.out.gain.setValueAtTime(0, T0);
    const mid = T0 + D / 2;
    if (matched) {
      const beat = out.beatSec();
      v.out.gain.linearRampToValueAtTime(1, mid);
      // échange des basses au milieu du mix (comme un vrai DJ)
      v.low.gain.setValueAtTime(-26, c.currentTime);
      v.low.gain.setValueAtTime(-26, Math.max(T0, mid - beat));
      v.low.gain.linearRampToValueAtTime(0, mid);
      out.low.gain.setValueAtTime(out.low.gain.value, Math.max(T0, mid - beat));
      out.low.gain.linearRampToValueAtTime(-26, mid);
      out.out.gain.setValueAtTime(1, mid);
      out.out.gain.linearRampToValueAtTime(0, T0 + D);
    } else {
      v.out.gain.linearRampToValueAtTime(1, T0 + D * 0.6);
      out.lp.frequency.setValueAtTime(22000, T0);
      out.lp.frequency.exponentialRampToValueAtTime(300, T0 + D);
      out.out.gain.setValueAtTime(1, T0 + D * 0.3);
      out.out.gain.linearRampToValueAtTime(0, T0 + D);
    }
    v.start(T0, nx.track.start, rate);
    out.stop(T0 + D + 0.05);
    this.commit(v, out, mid, T0 + D + 0.5, 'mix');
  }

  commit(v, old, switchAt, cleanupAt, kind) {
    this.committed = true; this.next = null; this.inc = v; this.plan = null;
    this.emit('transition', { kind, track: v.track, at: switchAt });
    this.at(switchAt, () => {
      this.cur = v; this.inc = null; this.committed = false;
      this.fx = { filter: false, bass: false, loop: false };
      this.emit('change', v.track);
      // retour progressif à la vitesse normale
      if (Math.abs(v.rate - 1) > 0.001) {
        const r0 = v.rate;
        for (let i = 1; i <= 10; i++) {
          this.at(switchAt + 4 + i * 1.5, () => { if (this.cur === v && !this.committed && !this.fx.loop) v.setRate(r0 + (1 - r0) * i / 10, this.now + 0.05); });
        }
      }
    });
    this.at(cleanupAt, () => old.dispose());
  }

  // ---------- Remix : passer à la suivante façon DJ ----------
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
    const B = out.beatSec();
    const t1 = out.nextBeatTime(now + 0.08);
    const { rate } = matchRate(out.track.bpm * out.rate, nx.track.bpm);
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
      this.fb.gain.linearRampToValueAtTime(0.3, tIn + 8 * B);
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
      out.stopSrc(out.src, t1);
      let t = t1;
      for (const [len, rep] of [[1, 2], [0.5, 2], [0.25, 4], [0.125, 8]]) {
        const s = out.mk(out.rate);
        s.loop = true; s.loopStart = p0; s.loopEnd = p0 + len * per;
        s.start(t, p0);
        const dur = len * rep * B;
        s.stop(t + dur);
        out.extra.push(s);
        t += dur;
      }
      out.hp.frequency.setValueAtTime(20, t1);
      out.hp.frequency.exponentialRampToValueAtTime(1200, t);
      out.out.gain.setValueAtTime(out.out.gain.value, t - 0.02);
      out.out.gain.linearRampToValueAtTime(0, t);
      tIn = t;
    } else { // 'brake' : arrêt de vinyle
      const pr = out.src.playbackRate;
      pr.cancelScheduledValues(t1);
      pr.setValueAtTime(out.rate, t1);
      pr.linearRampToValueAtTime(0.02, t1 + 1.4);
      out.out.gain.setValueAtTime(out.out.gain.value, t1 + 1.0);
      out.out.gain.linearRampToValueAtTime(0, t1 + 1.4);
      out.stop(t1 + 1.5);
      tIn = t1 + 1.45;
    }

    const v = new Voice(this, nx.track, nx.buffer);
    v.out.gain.value = 1;
    v.start(tIn, nx.track.drop, rate);
    this.commit(v, out, tIn, tIn + 12, type);
    return type;
  }

  riser(t0, t1) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
    const g = c.createGain();
    bp.frequency.setValueAtTime(400, t0); bp.frequency.exponentialRampToValueAtTime(7000, t1);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.16, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1);
    s.connect(bp); bp.connect(g); g.connect(this.bus);
    s.start(t0); s.stop(t1 + 0.05);
  }

  // ---------- Effets en direct ----------
  echoThrow() {
    const v = this.cur; if (!v) return;
    const now = this.now, B = v.beatSec(), t1 = v.nextBeatTime(now + 0.03);
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
    ramp(v.low.gain, on ? -30 : 0, this.now, 0.06);
  }
  loop(on) {
    const v = this.cur; if (!v) return;
    const now = this.now;
    if (on) {
      if (this.fx.loop) return;
      const t1 = v.nextBeatTime(now + 0.03), p0 = v.posAt(t1);
      const s = v.mk(v.rate);
      s.loop = true; s.loopStart = p0; s.loopEnd = p0 + 4 * v.period;
      v.stopSrc(v.src, t1);
      s.start(t1, p0);
      v.loopSrc = s; this.fx.loop = true;
    } else {
      if (!this.fx.loop) return;
      // reprise là où le morceau en serait (comme le mode "slip" des platines)
      const t = now + 0.02;
      v.stopSrc(v.loopSrc, t); v.loopSrc = null;
      const s = v.mk(v.rate); s.start(t, Math.max(0, v.posAt(t)));
      v.src = s; this.fx.loop = false;
    }
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
    if (this.cur && !this.committed) {
      this.plan = this.next ? this.planAuto() : null;
      if (this.plan && this.plan.T0 - now <= 1.0) {
        this.transition(this.plan);
      } else if (!this.next && now >= this.cur.endT) {
        const t = this.cur.track;
        this.cur.dispose(); this.cur = null; this.plan = null;
        this.emit('end', t);
      }
    }
  }
}
