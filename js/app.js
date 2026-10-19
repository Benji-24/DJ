import { db } from './db.js';
import { analyzeBuffer, ANALYSIS_VERSION, camelotCompat } from './analyze.js';
import { tempoRatio } from './brain.js';
import { Engine } from './engine.js';
import { isVideo, extractAudio } from './convert.js';
import { makeStems, pickMode, usesMainThread } from './stems.js';

const engine = new Engine();
window.__engine = engine; // utile pour les tests

const state = {
  tracks: new Map(),     // id -> infos du morceau
  playlists: [],
  queue: [],             // ids des morceaux du set
  qi: -1,                // position du morceau en cours dans la file
  style: 'auto',
  tab: 'queue',
  search: '',
};
window.__state = state;
window.__app = { getBuffer: id => getBuffer(id), playIndex: i => playIndex(i) };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
};

// ---------- Messages ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function sheet(title, items) {
  const s = $('#sheet');
  s.innerHTML = (title ? `<h3>${esc(title)}</h3>` : '') +
    items.map((it, i) => `<button data-i="${i}" class="${it.cls || ''}">${it.html ?? esc(it.label)}</button>`).join('') +
    `<button data-close="1" style="text-align:center;color:var(--dim)">Fermer</button>`;
  $('#sheetBg').classList.remove('hidden');
  s.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.close) return closeSheet();
    const it = items[+b.dataset.i];
    if (!it.keepOpen) closeSheet();
    it.fn && it.fn();
  };
}
function closeSheet() { $('#sheetBg').classList.add('hidden'); }
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });

// ---------- Audio ----------
// Débloque le son sur iPhone au premier toucher
['click', 'touchend'].forEach(ev => document.addEventListener(ev, () => engine.init(), { capture: true }));

const cache = new Map();
async function getBuffer(id) {
  if (cache.has(id)) return cache.get(id);
  const p = (async () => {
    engine.init();
    const t = state.tracks.get(id);
    if (t && t.stems === 'ready') {
      try {
        if (t.v !== ANALYSIS_VERSION) {
          const ob = await db.getBlob(id);
          await upgradeAnalysis(id, await engine.ctx.decodeAudioData(await ob.arrayBuffer()));
        }
        return await loadStems(t);
      } catch (e) { console.error('pistes illisibles', e); }
    }
    const blob = await db.getBlob(id);
    if (!blob) throw new Error('Fichier introuvable');
    const buf = await engine.ctx.decodeAudioData(await blob.arrayBuffer());
    await upgradeAnalysis(id, buf);
    return { mix: buf };
  })();
  cache.set(id, p);
  try { return await p; } catch (e) { cache.delete(id); throw e; }
}
// Pistes séparées → buffers prêts à jouer (décalage d'encodage corrigé)
async function loadStems(t) {
  const media = {};
  for (const name of ['vox', 'drums', 'rest']) {
    const b = await db.getBlob(`${t.id}:${name}`);
    if (!b) throw new Error('piste manquante ' + name);
    let buf = await engine.ctx.decodeAudioData(await b.arrayBuffer());
    const sh = Math.round((t.stemOfs || 0) * buf.sampleRate);
    if (sh) {
      const nb = engine.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const src = buf.getChannelData(c), dst = nb.getChannelData(c);
        if (sh > 0) dst.set(src.subarray(sh)); else dst.set(src.subarray(0, buf.length + sh), -sh);
      }
      buf = nb;
    }
    media[name] = buf;
  }
  return media;
}

// ---------- Séparation des pistes par l'IA (en arrière-plan, une fois par morceau) ----------
state.stemJob = null;
let stemRunning = false;
async function stemQueue() {
  if (stemRunning) return;
  stemRunning = true;
  try {
    for (;;) {
      const t = [...state.tracks.values()].sort((a, b) => a.added - b.added).find(x => !x.stems && x.v === ANALYSIS_VERSION);
      if (!t) break;
      // sur la page (sans travailleur) on évite de séparer pendant un set : ça pourrait saccader
      await pickMode();
      while (usesMainThread() && engine.playing) await new Promise(r => setTimeout(r, 3000));
      state.stemJob = { id: t.id, phase: 'decode', progress: 0 };
      renderLibrary();
      try {
        const blob = await db.getBlob(t.id);
        const res = await makeStems(blob, {
          loud: 0.16 / (t.gain || 1),
          onProgress: e => { state.stemJob = { id: t.id, ...e }; },
        });
        for (const [name, b] of Object.entries(res.blobs)) await db.putBlob(`${t.id}:${name}`, b);
        Object.assign(t, { stems: 'ready', vox: res.vox, drm: res.drm, stemOfs: res.stemOfs, stemBackend: res.backend });
        await db.putTrack(t);
        cache.delete(t.id);
        if (state.queue[state.qi + 1] === t.id && !engine.committed && (!engine.plan || engine.plan.T0 - engine.now > 20)) prepareNext(true);
      } catch (e) {
        console.error('séparation', e);
        t.stems = 'failed'; t.stemError = String(e && e.message || e);
        await db.putTrack(t);
      }
      state.stemJob = null;
      renderLibrary(); renderQueue();
    }
  } finally { stemRunning = false; }
}
function stemLabel(t) {
  const j = state.stemJob;
  if (j && j.id === t.id) {
    const P = Math.round((j.progress || 0) * 100);
    return { model: `IA : téléchargement ${P} %`, decode: 'IA : préparation', separate: `IA : séparation ${P} %`, encode: 'IA : compression', check: 'IA : vérification' }[j.phase] || 'IA…';
  }
  if (t.stems === 'ready') return 'pistes IA';
  if (t.stems === 'failed') return 'pistes indisponibles';
  return 'IA en attente';
}

// Ancienne analyse ? on la refait avec le nouveau moteur
async function upgradeAnalysis(id, buf) {
  const t = state.tracks.get(id);
  if (!t || t.v === ANALYSIS_VERSION) return;
  const a = analyzeBuffer(buf);
  Object.assign(t, a);
  await db.putTrack(t);
}
async function migrateLibrary() {
  const old = [...state.tracks.values()].filter(t => t.v !== ANALYSIS_VERSION);
  if (!old.length) return;
  const st = $('#importStatus');
  for (let i = 0; i < old.length; i++) {
    const t = old[i];
    if (t.v === ANALYSIS_VERSION) continue;
    st.textContent = `Nouvelle analyse (tempo, tonalité, phrases) ${i + 1}/${old.length}…`;
    try {
      const blob = await db.getBlob(t.id);
      engine.init();
      const buf = await engine.ctx.decodeAudioData(await blob.arrayBuffer());
      await upgradeAnalysis(t.id, buf);
    } catch (e) { console.error(e); }
    renderLibrary(); renderQueue();
    await new Promise(r => setTimeout(r, 30));
  }
  st.textContent = '';
}

function trimCache() {
  const keep = new Set([state.queue[state.qi], state.queue[state.qi + 1], state.queue[state.qi + 2]]);
  if (engine.cur) keep.add(engine.cur.track.id);
  if (engine.inc) keep.add(engine.inc.track.id);
  for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && engine.playing) keepAwake(); });

async function playIndex(i) {
  const id = state.queue[i]; if (!id) return;
  state.qi = i;
  const t = state.tracks.get(id);
  try {
    const buf = await getBuffer(id);
    engine.play(t, buf);
    keepAwake();
  } catch (e) { toast('Impossible de lire « ' + t.title + ' »'); }
  prepareNext(); renderAll();
}

let preparing = null;
async function prepareNext(force) {
  if (engine.committed) return;
  const id = state.queue[state.qi + 1];
  if (!id) { engine.setNext(null); return; }
  if (!force && engine.next && engine.next.track.id === id) return;
  engine.setNext(null);
  preparing = id;
  try {
    const buf = await getBuffer(id);
    if (state.queue[state.qi + 1] === id && !engine.committed) engine.setNext({ track: state.tracks.get(id), buffer: buf });
  } catch (e) {
    toast('Impossible de lire « ' + (state.tracks.get(id)?.title || '?') + ' »');
  } finally { if (preparing === id) preparing = null; }
  trimCache();
}

engine.on('change', track => {
  const q = state.queue;
  if (q[state.qi + 1] === track.id) state.qi++;
  else if (q[state.qi] !== track.id) { const i = q.indexOf(track.id); if (i >= 0) state.qi = i; }
  document.querySelectorAll('.pad.on').forEach(p => p.classList.remove('on'));
  prepareNext(); renderQueue();
});
engine.on('transition', () => renderQueue());
engine.on('end', () => {
  if (state.queue[state.qi + 1]) playIndex(state.qi + 1);
  else { toast('Fin du set 🎧'); renderAll(); }
});

// Où insérer "Jouer ensuite" (après le morceau en cours, ou après celui qui arrive)
const insertPos = () => state.qi + 1 + (engine.committed ? 1 : 0);

function playNext(id) {
  if (!engine.playing) {
    state.queue.splice(state.qi + 1, 0, id);
    return playIndex(state.qi + 1);
  }
  state.queue.splice(insertPos(), 0, id);
  toast('Joué juste après ✔︎');
  prepareNext(); renderQueue();
}

async function playNow(id, fromIndex = -1) {
  if (!engine.playing) {
    if (fromIndex > state.qi) state.queue.splice(fromIndex, 1);
    state.queue.splice(state.qi + 1, 0, id);
    return playIndex(state.qi + 1);
  }
  if (engine.committed) return toast('Transition déjà en cours…');
  if (fromIndex > state.qi) state.queue.splice(fromIndex, 1);
  state.queue.splice(state.qi + 1, 0, id);
  renderQueue();
  await doRemix();
}

async function doRemix() {
  if (!engine.playing) return;
  if (engine.committed) return toast('Transition déjà en cours…');
  if (!state.queue[state.qi + 1]) return toast('Ajoute une musique à la suite d\'abord');
  if (!engine.next) { toast('Préparation…'); await prepareNext(); }
  const r = engine.remix(state.style);
  const names = { echo: 'Écho', filter: 'Montée', loop: 'Boucle', brake: 'Frein' };
  if (names[r]) {
    const b = $('#btnRemix'); b.classList.remove('fire'); void b.offsetWidth; b.classList.add('fire');
    toast('Remix : ' + names[r] + ' 🔥');
  } else if (r === 'busy') toast('Transition déjà en cours…');
  renderQueue();
}

// Ordre DJ : enchaîne les morceaux qui vont ensemble (tempo proche, tonalités compatibles)
// et fait monter l'énergie progressivement, comme un DJ qui prépare son set.
function djOrder(ids, startId) {
  const T = id => state.tracks.get(id);
  const nrgOf = t => { const n = t.nrg; if (!n || !n.length) return 0.5; let s = 0; for (const x of n) s += x; return s / n.length / 255; };
  const left = new Set(ids);
  let cur = startId && left.has(startId) ? startId : [...left].sort((a, b) => nrgOf(T(a)) - nrgOf(T(b)))[Math.floor(Math.random() * Math.min(3, left.size))];
  const out = [cur]; left.delete(cur);
  while (left.size) {
    const a = T(cur); let best = null, bs = -Infinity;
    for (const id of left) {
      const b = T(id);
      const r = tempoRatio(a.bpm, b.bpm), dt = Math.abs(r - 1);
      let sc = dt <= 0.03 ? 3 : dt <= 0.08 ? 2 : dt <= 0.15 ? 0.5 : -1;
      if (camelotCompat(a.camelot, b.camelot)) sc += 2;
      const de = nrgOf(b) - nrgOf(a); sc += de >= 0 && de < 0.15 ? 0.8 : de < 0 ? -0.3 : 0;
      if (b.stems === 'ready' && a.stems === 'ready') sc += 0.3;
      sc += Math.random() * 0.6;
      if (sc > bs) { bs = sc; best = id; }
    }
    out.push(best); left.delete(best); cur = best;
  }
  return out;
}

function startSet(ids, shuffle) {
  ids = ids.filter(id => state.tracks.has(id));
  if (!ids.length) return toast('Cette liste est vide');
  if (shuffle) ids = djOrder(ids, engine.playing ? engine.cur.track.id : null).filter(id => !engine.playing || id !== engine.cur.track.id);
  if (engine.playing) {
    const keep = state.queue.slice(0, insertPos());
    const cur = new Set(keep.slice(state.qi));
    state.queue = keep.concat(ids.filter(id => !cur.has(id)));
    toast('Le set s\'enchaîne après ce morceau');
    prepareNext(); switchTab('queue');
  } else {
    state.queue = ids; state.qi = -1;
    playIndex(0); switchTab('queue');
  }
}

// ---------- Import ----------
function parseName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.split(/\s+[-–—]\s+/);
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  return { artist: '', title: base };
}

async function importFiles(files) {
  engine.init();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  const st = $('#importStatus');
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const { artist, title } = parseName(f.name);
    const head = `${i + 1}/${files.length} : ${title}`;
    st.textContent = `Analyse ${head}…`;
    try {
      let blob = f;
      if (isVideo(f)) {
        // vidéo (MKV…) : on ne garde que le son
        blob = await extractAudio(f, ({ progress, status }) => {
          if (status === 'loading') st.textContent = 'Chargement du lecteur vidéo (32 Mo, une seule fois)…';
          else if (progress != null && progress >= 0 && progress <= 1) st.textContent = `Extraction du son ${head}… ${Math.round(progress * 100)} %`;
          else st.textContent = `Extraction du son ${head}…`;
        });
        st.textContent = `Analyse ${head}…`;
      }
      const ab = await blob.arrayBuffer();
      const buf = await engine.ctx.decodeAudioData(ab);
      await new Promise(r => setTimeout(r, 0));
      const a = analyzeBuffer(buf);
      const t = { id: uid(), title, artist, added: Date.now(), ...a };
      await db.putBlob(t.id, blob);
      await db.putTrack(t);
      state.tracks.set(t.id, t);
      ok++;
      renderLibrary();
    } catch (e) {
      console.error(e);
      toast(e && e.message === 'noaudio' ? 'Pas de son dans : ' + f.name : 'Fichier non lisible : ' + f.name);
    }
  }
  st.textContent = ok ? `${ok} musique${ok > 1 ? 's' : ''} ajoutée${ok > 1 ? 's' : ''} ✔︎ L'IA sépare maintenant les pistes en arrière-plan.` : '';
  stemQueue();
  setTimeout(() => { if (st.textContent.includes('✔︎')) st.textContent = ''; }, 4000);
}
$('#fileInput').addEventListener('change', e => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) importFiles(files);
});

// ---------- Rendu ----------
const hueOf = str => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const artOf = t => { const h = hueOf(t.artist || t.title); return `linear-gradient(160deg, hsl(${h} 45% 34%), hsl(${(h + 40) % 360} 40% 18%))`; };
const keyHue = cam => cam ? ((parseInt(cam) - 1) * 30 + (cam.endsWith('B') ? 12 : 0)) % 360 : 0;
const keyBadge = t => t.camelot ? `<span class="badge key" style="--h:${keyHue(t.camelot)}">${t.camelot}</span>` : '';
function trackRow(t, extra = '', cls = '') {
  const pending = t.v !== ANALYSIS_VERSION;
  return `<div class="row ${cls}" data-id="${t.id}">
    <div class="art" style="--art:${artOf(t)}"></div>
    <div class="info"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || 'Artiste inconnu')}, ${fmt(t.duration)} <span class="stem ${t.stems === 'ready' ? 'ok' : ''}" data-stem="${t.id}">${stemLabel(t)}</span></div></div>
    <div class="meta">${pending ? '…' : Math.round(t.bpm)}${pending || !t.camelot ? '' : `<span class="key" style="--h:${keyHue(t.camelot)}">${t.camelot}</span>`}</div>${extra}</div>`;
}

function renderQueue() {
  const el = $('#tab-queue'); const q = state.queue;
  if (!q.length) {
    el.innerHTML = `<div class="empty">La file est vide.<br>Va dans <b>Bibliothèque</b> ou <b>Playlists</b> pour lancer ton set.</div>`;
    return;
  }
  let h = '';
  const cur = state.tracks.get(q[state.qi]);
  if (cur) h += `<div class="section-title">En cours</div>` + trackRow(cur, '', 'current');
  const up = q.slice(state.qi + 1);
  h += `<div class="section-title">À suivre (${up.length})</div>`;
  if (!up.length) h += `<div class="empty">Rien après. Ajoute une musique avec « Ensuite ».</div>`;
  up.forEach((id, k) => {
    const t = state.tracks.get(id); if (!t) return;
    const idx = state.qi + 1 + k;
    const locked = engine.committed && k === 0;
    h += trackRow(t, locked ? `<span class="act live">Entre</span>` :
      `<button class="act go" data-now="${idx}">Maintenant</button><button class="icon-btn" data-rm="${idx}" aria-label="Retirer">✕</button>`, locked ? 'incoming' : '');
  });
  const played = q.slice(0, Math.max(0, state.qi)).slice(-5);
  if (played.length) {
    h += `<div class="section-title">Déjà joués</div>`;
    played.forEach(id => { const t = state.tracks.get(id); if (t) h += trackRow(t, '', 'played'); });
  }
  el.innerHTML = h;
}
$('#tab-queue').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.now) { const i = +b.dataset.now; playNow(state.queue[i], i); }
  if (b.dataset.rm) {
    const i = +b.dataset.rm;
    if (engine.committed && i === state.qi + 1) return;
    state.queue.splice(i, 1);
    if (i === state.qi + 1) prepareNext();
    renderQueue();
  }
});

function renderLibrary() {
  const el = $('#libList');
  const all = [...state.tracks.values()].sort((a, b) => b.added - a.added);
  if (!all.length) {
    el.innerHTML = `<div class="empty">Aucune musique pour l'instant.<br>Touche <b>Importer des musiques</b> et choisis tes MP3 ou MKV dans l'app Fichiers.</div>`;
    return;
  }
  const s = state.search.toLowerCase();
  const list = s ? all.filter(t => (t.title + ' ' + t.artist).toLowerCase().includes(s)) : all;
  el.innerHTML = `<div class="lib-actions">
      <button class="act go" data-all="0">Tout lancer</button><button class="act" data-all="1">Ordre DJ</button>
      <span class="count">${all.length} titres</span></div>` +
    list.map(t => trackRow(t, `<button class="act" data-next="${t.id}">Ensuite</button><button class="icon-btn" data-more="${t.id}" aria-label="Options">⋯</button>`)).join('');
}
$('#search').addEventListener('input', e => { state.search = e.target.value; renderLibrary(); });
$('#libList').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b?.dataset.all) return startSet([...state.tracks.values()].sort((a, b) => a.added - b.added).map(t => t.id), b.dataset.all === '1');
  if (b?.dataset.next) return playNext(b.dataset.next);
  const id = b?.dataset.more || e.target.closest('.row')?.dataset.id;
  if (id) trackMenu(id);
});

function trackMenu(id) {
  const t = state.tracks.get(id); if (!t) return;
  sheet(t.title, [
    { label: '⚡ Jouer maintenant (remix)', fn: () => playNow(id) },
    { label: '↪︎ Jouer ensuite', fn: () => playNext(id) },
    { label: '＋ Ajouter à une playlist', fn: () => addToPlaylistMenu(id) },
    { label: '✎ Renommer', fn: () => renameTrack(id) },
    { label: '🗑 Supprimer de l\'appli', cls: 'danger', fn: () => deleteTrack(id) },
  ]);
}

async function renameTrack(id) {
  const t = state.tracks.get(id);
  const title = prompt('Titre', t.title); if (title === null) return;
  const artist = prompt('Artiste', t.artist || ''); if (artist === null) return;
  t.title = title.trim() || t.title; t.artist = artist.trim();
  await db.putTrack(t); renderAll();
}

async function deleteTrack(id) {
  const cur = engine.cur?.track.id === id || engine.inc?.track.id === id;
  if (cur) return toast('Impossible : ce morceau est en train de jouer');
  if (!confirm('Supprimer « ' + state.tracks.get(id).title + ' » ?')) return;
  await db.deleteTrack(id);
  for (const n of ['vox', 'drums', 'rest']) { try { await db.deleteTrack(`${id}:${n}`); } catch (e) { } }
  state.tracks.delete(id);
  for (let i = state.queue.length - 1; i > state.qi; i--) if (state.queue[i] === id) state.queue.splice(i, 1);
  for (const p of state.playlists) if (p.ids.includes(id)) { p.ids = p.ids.filter(x => x !== id); await db.putPlaylist(p); }
  prepareNext(); renderAll();
}

// ---------- Playlists ----------
async function newPlaylist(withId) {
  const name = prompt('Nom de la playlist'); if (!name || !name.trim()) return null;
  const p = { id: uid(), name: name.trim(), ids: withId ? [withId] : [], created: Date.now() };
  await db.putPlaylist(p); state.playlists.push(p); renderPlaylists();
  return p;
}
function addToPlaylistMenu(id) {
  const items = state.playlists.map(p => ({
    html: `${esc(p.name)}${p.ids.includes(id) ? '<span class="check">✔︎</span>' : ''}`,
    fn: async () => {
      p.ids = p.ids.includes(id) ? p.ids.filter(x => x !== id) : [...p.ids, id];
      await db.putPlaylist(p); renderPlaylists(); addToPlaylistMenu(id);
    },
  }));
  items.push({ label: '+ Nouvelle playlist', fn: async () => { if (await newPlaylist(id)) toast('Ajoutée ✔︎'); } });
  sheet('Ajouter à…', items);
}
function renderPlaylists() {
  const el = $('#plList');
  if (!state.playlists.length) {
    el.innerHTML = `<div class="empty">Pas encore de playlist.<br>Crée-en une, puis ajoute des musiques depuis la Bibliothèque (bouton ⋯).</div>`;
    return;
  }
  el.innerHTML = state.playlists.map(p => {
    const n = p.ids.filter(id => state.tracks.has(id)).length;
    return `<div class="row" data-pl="${p.id}"><div class="info"><div class="t">${esc(p.name)}</div><div class="a">${n} titre${n > 1 ? 's' : ''}</div></div>
      <button class="act go" data-play="${p.id}">Lancer</button><button class="act" data-shuf="${p.id}">Ordre DJ</button><button class="icon-btn" data-plmore="${p.id}">⋯</button></div>`;
  }).join('');
}
$('#btnNewPlaylist').addEventListener('click', () => newPlaylist());
$('#plList').addEventListener('click', e => {
  const b = e.target.closest('button');
  const get = id => state.playlists.find(p => p.id === id);
  if (b?.dataset.play) return startSet([...get(b.dataset.play).ids], false);
  if (b?.dataset.shuf) return startSet([...get(b.dataset.shuf).ids], true);
  const id = b?.dataset.plmore || e.target.closest('.row')?.dataset.pl;
  if (id) playlistMenu(get(id));
});
function playlistMenu(p) {
  sheet(p.name, [
    { label: '▶ Lancer dans l\'ordre', fn: () => startSet([...p.ids], false) },
    { label: 'Lancer dans l\'ordre DJ (tempos et tonalités qui s\'enchaînent)', fn: () => startSet([...p.ids], true) },
    { label: '☰ Voir / retirer des titres', fn: () => playlistContent(p) },
    { label: '✎ Renommer', fn: async () => { const n = prompt('Nouveau nom', p.name); if (n && n.trim()) { p.name = n.trim(); await db.putPlaylist(p); renderPlaylists(); } } },
    { label: '🗑 Supprimer la playlist', cls: 'danger', fn: async () => { if (confirm('Supprimer « ' + p.name + ' » ? (les musiques restent dans la bibliothèque)')) { await db.deletePlaylist(p.id); state.playlists = state.playlists.filter(x => x !== p); renderPlaylists(); } } },
  ]);
}
function playlistContent(p) {
  const items = p.ids.filter(id => state.tracks.has(id)).map(id => ({
    html: `<span style="color:#ff5d5d">✕</span>&nbsp; ${esc(state.tracks.get(id).title)}`,
    fn: async () => { p.ids = p.ids.filter(x => x !== id); await db.putPlaylist(p); renderPlaylists(); playlistContent(p); },
  }));
  if (!items.length) items.push({ label: 'Playlist vide', fn: () => { } });
  sheet(p.name + ' — toucher pour retirer', items);
}

// ---------- Platines, formes d'onde, AutoMix (affichage en direct) ----------
const canvas = $('#scope'), g = canvas.getContext('2d');
const PAL = {
  A: { low: [77, 163, 255], mid: [170, 208, 255], high: [240, 246, 255] },
  B: { low: [255, 154, 61], mid: [255, 211, 168], high: [255, 248, 240] },
};
function fitCanvas(cv, ctx) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [w, h];
}

// Qui est sur quelle platine ?
function deckState() {
  const res = { A: null, B: null };
  for (const v of [engine.cur, engine.inc]) if (v) res[v.deck] = { v, t: v.track, role: v === engine.inc ? 'in' : engine.inc ? 'out' : 'live' };
  const nt = state.tracks.get(state.queue[state.qi + 1]);
  if (engine.cur && !engine.inc && nt) res[engine.cur.deck === 'A' ? 'B' : 'A'] = { v: null, t: nt, role: 'next' };
  if (!engine.cur && state.queue.length) {
    const t = state.tracks.get(state.queue[Math.max(0, state.qi)]);
    if (t) res.A = { v: null, t, role: 'ready' };
  }
  return res;
}

const ROLE = { live: 'en lecture', in: 'entre', out: 'sort', next: 'suivant', ready: 'prêt' };
const deckEls = {};
function deckEl(letter) {
  if (deckEls[letter]) return deckEls[letter];
  const el = document.getElementById('deck' + letter);
  const o = { el, title: el.querySelector('.deck-title'), artist: el.querySelector('.deck-artist'), bpm: el.querySelector('.deck-bpm b'),
    meta: el.querySelector('.deck-meta'), ov: el.querySelector('.overview'), ring: el.querySelector('.jog-ring') };
  o.ovg = o.ov.getContext('2d'); o.rg = o.ring.getContext('2d');
  return (deckEls[letter] = o);
}
function renderDeckCard(letter, d) {
  const o = deckEl(letter), now = engine.now;
  const live = d && d.v;
  o.el.classList.toggle('on', !!live);
  o.el.classList.toggle('empty', !d);
  o.el.classList.toggle('spin', !!live && !engine.paused);
  o.title.textContent = d ? d.t.title : (letter === 'A' ? 'Aucune musique' : 'Platine libre');
  o.artist.textContent = d ? (d.t.artist || 'Artiste inconnu') : (letter === 'A' ? 'Importe tes musiques' : 'Ajoute une musique à la suite');
  const ok = d && d.t.v === ANALYSIS_VERSION;
  const rate = live ? d.v.rateAt(now) : (d && d.role === 'next' && engine.plan ? engine.plan.r : 1);
  o.bpm.textContent = ok ? (d.t.bpm * rate).toFixed(1) : '—';
  let m = '';
  if (ok) {
    if (d.t.camelot) m += `<span class="key" style="--h:${keyHue(d.t.camelot)}">${d.t.camelot}</span>`;
    const pct = (rate - 1) * 100;
    m += `<span class="pitch ${pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : ''}">${Math.abs(pct) < 0.05 ? '±' : pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)} %</span>`;
    if (live) m += `<span>−${fmt(d.t.duration - d.v.posAt(now))}</span>`;
    else m += `<span>${fmt(d.t.duration)}</span>`;
  }
  if (d) m += `<span class="role">${ROLE[d.role]}</span>`;
  if (o.meta.innerHTML !== m) o.meta.innerHTML = m;
  drawOverview(o, letter, d, now);
  drawRing(o, letter, d, now);
}
function drawOverview(o, letter, d, now) {
  const [w, h] = fitCanvas(o.ov, o.ovg); const g2 = o.ovg;
  g2.clearRect(0, 0, w, h);
  const peaks = d && d.t.peaks; if (!peaks) { g2.fillStyle = '#1c2330'; g2.fillRect(0, h / 2 - 1, w, 2); return; }
  const prog = d.v ? Math.min(1, Math.max(0, d.v.posAt(now) / d.t.duration)) : (d.role === 'next' && engine.plan ? engine.plan.inPos / d.t.duration : 0);
  const n = peaks.length, bw = w / n, col = PAL[letter].low;
  for (let i = 0; i < n; i++) {
    const ph = Math.max(1.5, peaks[i] / 100 * h);
    g2.fillStyle = i / n < prog ? `rgba(${col},0.35)` : `rgba(${col},0.9)`;
    g2.fillRect(i * bw, (h - ph) / 2, Math.max(1, bw - 1), ph);
  }
  // zone de mix prévue
  if (d.v && d.v === engine.cur && engine.plan && !engine.inc) {
    const x = d.v.posAt(engine.plan.T0) / d.t.duration * w;
    g2.fillStyle = 'rgba(255,255,255,0.85)'; g2.fillRect(x, 0, 1.5, h);
  }
  g2.fillStyle = '#fff'; g2.fillRect(prog * w - 1, 0, 2, h);
}
function drawRing(o, letter, d, now) {
  const g2 = o.rg, S = 120; g2.clearRect(0, 0, S, S);
  const col = PAL[letter].low, segs = 40;
  const prog = d && d.v ? Math.min(1, Math.max(0, d.v.posAt(now) / d.t.duration)) : 0;
  for (let i = 0; i < segs; i++) {
    const a0 = -Math.PI / 2 + i / segs * Math.PI * 2 + 0.03, a1 = a0 + Math.PI * 2 / segs - 0.06;
    g2.beginPath(); g2.arc(60, 60, 56, a0, a1);
    g2.strokeStyle = i / segs < prog ? `rgb(${col})` : '#232a37'; g2.lineWidth = 5; g2.stroke();
  }
}

function waveCol(t, pos) {
  const w = t.wave; if (!w) return null;
  const i = Math.floor(pos * w.fps);
  if (i < 0 || i >= w.low.length) return null;
  return [w.low[i] / 255, w.mid[i] / 255, w.high[i] / 255];
}
function drawLane(y0, h, letter, d, now, cx, pps, w) {
  const pal = PAL[letter], mid = y0 + h / 2;
  if (!d || d.t.v !== ANALYSIS_VERSION) {
    g.fillStyle = '#1a202b'; g.fillRect(0, mid, w, 1);
    return;
  }
  const t = d.t;
  let posAt, startT;
  if (d.v) { posAt = x => d.v.posAt(x); startT = d.v.str ? d.v.str.when : d.v.lin.t; }
  else if (d.role === 'next' && engine.plan) { const p = engine.plan; posAt = x => p.inPos + (x - p.T0) * p.r; startT = p.T0; }
  else { g.fillStyle = '#1a202b'; g.fillRect(0, mid, w, 1); return; }
  const P = 60 / t.bpm, bar = 4 * P;
  let lb = null, lbar = null;
  for (let x = 0; x < w; x += 2) {
    const tt = now + (x - cx) / pps;
    if (tt < startT) { lb = lbar = null; continue; }
    const pos = posAt(tt);
    const v = waveCol(t, pos);
    if (!v) continue;
    const a = x < cx ? 0.45 : 1;
    const hl = v[0] * h * 0.47, hm = v[1] * h * 0.36, hh = v[2] * h * 0.24;
    g.fillStyle = `rgba(${pal.low},${0.95 * a})`; g.fillRect(x, mid - hl, 2, hl * 2);
    g.fillStyle = `rgba(${pal.mid},${0.85 * a})`; g.fillRect(x, mid - hm, 2, hm * 2);
    g.fillStyle = `rgba(${pal.high},${0.9 * a})`; g.fillRect(x, mid - hh, 2, hh * 2);
    if (t.conf >= 1.5) {
      const bi = Math.floor((pos - t.beat) / P), ba = Math.floor((pos - t.bar) / bar);
      if (lb !== null && bi !== lb) {
        const isBar = ba !== lbar;
        g.fillStyle = isBar ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.22)';
        const th = isBar ? 7 : 4;
        g.fillRect(x, y0, 1, th); g.fillRect(x, y0 + h - th, 1, th);
      }
      lb = bi; lbar = ba;
    }
  }
  if (d.v && d.v === engine.cur && engine.plan && !engine.inc) {
    const p = engine.plan, x0 = cx + (p.T0 - now) * pps;
    const len = p.mixBeats ? p.mixBeats * P / d.v.rateAt(now) : (p.type === 'fade' ? 6 : 2 * P);
    if (x0 < w && x0 + len * pps > 0) {
      g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(x0, y0, len * pps, h);
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x0, y0, 1.5, h);
    }
  }
}
function drawScope() {
  const [w, h] = fitCanvas(canvas, g);
  g.clearRect(0, 0, w, h);
  const now = engine.now, ds = deckState();
  const cx = Math.round(w * 0.4), pps = 70, gap = 4, lane = (h - gap) / 2;
  drawLane(0, lane, 'A', ds.A, now, cx, pps, w);
  g.fillStyle = '#151a23'; g.fillRect(0, lane, w, gap);
  drawLane(lane + gap, lane, 'B', ds.B, now, cx, pps, w);
  g.fillStyle = '#ff4d5e'; g.fillRect(cx - 1, 0, 2, h);
}

const MIXNAME = { stems: 'Mix par pistes', blend: 'Blend EQ', cut: 'Mix court', echo: 'Sortie en écho', fade: 'Fondu filtré', filter: 'Montée', loop: 'Boucle', brake: 'Frein' };
let lastAm = '';
engine.on('plan', () => { lastAm = ''; });
function renderAutomix() {
  let st = 'en attente', text = '', tags = [], live = false;
  const p = engine.plan, cur = engine.cur;
  const nt = state.tracks.get(state.queue[state.qi + 1]);
  if (!state.tracks.size) text = 'Importe tes musiques dans la bibliothèque.';
  else if (!cur) text = state.queue.length ? 'Prêt. Appuie sur lecture pour lancer le set.' : 'Lance une playlist ou toute ta bibliothèque.';
  else if (engine.inc) { st = 'en train de mixer'; live = true; text = `${MIXNAME[engine.lastKind] || 'Transition'} vers ${esc(engine.inc.track.title)}`; }
  else if (!nt) { st = 'en écoute'; text = 'Ajoute une musique à la suite pour préparer la transition.'; }
  else if (!p || nt.v !== ANALYSIS_VERSION) { st = 'analyse'; text = `Analyse de ${esc(nt.title)}…`; }
  else {
    st = p.ready ? 'transition prête' : 'calage du tempo…';
    text = `${p.reason} dans <span class="count">${fmt(p.T0 - engine.now)}</span>`;
    const o = cur.track;
    tags.push([`${Math.round(o.bpm)} → ${Math.round(nt.bpm)} BPM`, p.tempoOk ? 'ok' : 'no']);
    if (o.camelot && nt.camelot) tags.push([`${o.camelot} → ${nt.camelot}`, p.keyOk ? 'ok' : 'no']);
    if (p.type === 'stems') tags.push(['voix, batterie et musique séparées', 'ok']);
    else if (cur.track.stems !== 'ready' || nt.stems !== 'ready') tags.push(['pistes IA pas encore prêtes', '']);
    if (p.tempoOk && Math.abs(p.r - 1) > 0.003) tags.push([`tempo ${(p.r - 1) * 100 > 0 ? '+' : '−'}${Math.abs((p.r - 1) * 100).toFixed(1)} % sans changer la voix`, '']);
  }
  const key = `${st}|${text}|${tags.map(x => x.join(':')).join(',')}`;
  if (key !== lastAm) {
    lastAm = key;
    $('#amState').textContent = st; $('#amState').classList.toggle('live', live);
    $('#amText').innerHTML = text;
    $('#amTags').innerHTML = tags.map(([l, c]) => `<span class="${c}">${l}</span>`).join('');
  }
  // crossfader
  let x = cur && cur.deck === 'B' ? 1 : 0, fill = null;
  if (engine.inc && engine.mix) {
    const m = engine.mix, k = Math.min(1, Math.max(0, (engine.now - m.t0) / Math.max(0.1, m.t1 - m.t0)));
    x = m.from === 'A' ? k : 1 - k;
  }
  const f = $('#fader');
  f.style.setProperty('--x', x.toFixed(3));
  f.classList.toggle('live', live);
  const fl = f.querySelector('.fader-fill');
  fl.style.left = `${Math.min(x, cur && cur.deck === 'B' ? 1 : 0) * 100}%`;
  fl.style.width = `${Math.abs(x - (engine.mix && engine.inc ? (engine.mix.from === 'A' ? 0 : 1) : x)) * 100}%`;
}

function renderDeck() {
  const playing = !!engine.cur;
  $('#btnPlayPause').disabled = !playing && !state.queue.length;
  $('#btnPlayPause').classList.toggle('playing', playing && !engine.paused);
  $('#btnRemix').disabled = !playing;
}
setInterval(renderDeck, 250);
let lastStemTxt = '';
setInterval(() => {
  const j = state.stemJob; if (!j) return;
  const t = state.tracks.get(j.id); if (!t) return;
  const txt = stemLabel(t); if (txt === lastStemTxt) return; lastStemTxt = txt;
  document.querySelectorAll(`[data-stem="${j.id}"]`).forEach(el => { el.textContent = txt; });
}, 400);
(function loop() {
  if (document.visibilityState === 'visible') {
    const ds = deckState();
    renderDeckCard('A', ds.A); renderDeckCard('B', ds.B);
    drawScope(); renderAutomix();
  }
  requestAnimationFrame(loop);
})();

function renderAll() { renderDeck(); renderQueue(); renderLibrary(); renderPlaylists(); }

// ---------- Commandes ----------
$('#btnRemix').addEventListener('click', doRemix);
$('#btnPlayPause').addEventListener('click', () => {
  if (!engine.playing) { if (state.queue.length) playIndex(Math.max(0, state.qi)); return; }
  if (engine.paused) { engine.resume(); keepAwake(); } else engine.pause();
  renderDeck();
});
$('#remixStyles').addEventListener('click', e => {
  const b = e.target.closest('#remixStyles button'); if (!b) return;
  state.style = b.dataset.style; store.set('dj-style', state.style);
  document.querySelectorAll('#remixStyles button').forEach(c => c.classList.toggle('on', c === b));
});
document.querySelector('.pads').addEventListener('click', e => {
  const b = e.target.closest('.pad'); if (!b || !engine.playing) return;
  const fx = b.dataset.fx;
  if (fx === 'echo') { engine.echoThrow(); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); return; }
  const on = !b.classList.contains('on');
  const r = engine[fx](on);
  if (fx === 'loop' && r === false) return toast('Boucle possible juste après la transition');
  b.classList.toggle('on', on);
});

// Durée jouée de chaque morceau : Entier / Club (~2:30) / Express (~1:15)
function setMode(m) {
  state.mode = m; store.set('dj-mode', m); engine.setMode(m);
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
}
$('#modeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  setMode(b.dataset.mode);
  toast({ full: 'Morceaux en entier', club: 'Mode Club : ~2 min 30 par morceau', express: 'Mode Express : ~1 min 15 par morceau' }[b.dataset.mode]);
});

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
}
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });

// ---------- Démarrage ----------
// Animation d'ouverture (touche l'écran pour la passer)
const splash = document.getElementById('splash');
const splashStart = Date.now();
function hideSplash() { if (!splash || splash.classList.contains('out')) return; splash.classList.add('out'); setTimeout(() => splash.remove(), 600); }
splash && splash.addEventListener('click', hideSplash);

(async function boot() {
  state.style = store.get('dj-style', 'auto');
  setMode(store.get('dj-mode', 'club'));
  document.querySelectorAll('#remixStyles button').forEach(c => c.classList.toggle('on', c.dataset.style === state.style));
  try {
    const [tracks, pls] = await Promise.all([db.allTracks(), db.allPlaylists()]);
    tracks.forEach(t => state.tracks.set(t.id, t));
    state.playlists = pls.sort((a, b) => a.created - b.created);
  } catch (e) { toast('Stockage indisponible'); }
  if (!state.tracks.size) switchTab('library');
  renderAll();
  setTimeout(hideSplash, Math.max(0, 2300 - (Date.now() - splashStart)));
  setTimeout(async () => { await migrateLibrary(); stemQueue(); }, 2600);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
