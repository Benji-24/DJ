import { db } from './db.js';
import { analyzeBuffer } from './analyze.js';
import { Engine } from './engine.js';
import { isVideo, extractAudio } from './convert.js';

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
    const blob = await db.getBlob(id);
    if (!blob) throw new Error('Fichier introuvable');
    const ab = await blob.arrayBuffer();
    engine.init();
    return await engine.ctx.decodeAudioData(ab);
  })();
  cache.set(id, p);
  try { return await p; } catch (e) { cache.delete(id); throw e; }
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
async function prepareNext() {
  if (engine.committed) return;
  const id = state.queue[state.qi + 1];
  if (!id) { engine.setNext(null); return; }
  if (engine.next && engine.next.track.id === id) return;
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

function startSet(ids, shuffle) {
  ids = ids.filter(id => state.tracks.has(id));
  if (!ids.length) return toast('Cette liste est vide');
  if (shuffle) for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
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
  st.textContent = ok ? `${ok} musique${ok > 1 ? 's' : ''} ajoutée${ok > 1 ? 's' : ''} ✔︎` : '';
  setTimeout(() => { if (st.textContent.includes('✔︎')) st.textContent = ''; }, 4000);
}
$('#fileInput').addEventListener('change', e => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) importFiles(files);
});

// ---------- Rendu ----------
function trackRow(t, extra = '', cls = '') {
  return `<div class="row ${cls}" data-id="${t.id}">
    <div class="info"><div class="t">${esc(t.title)}</div><div class="a">${esc(t.artist || '—')} · ${fmt(t.duration)}</div></div>
    <span class="bpm">${Math.round(t.bpm)}</span>${extra}</div>`;
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
    h += trackRow(t, locked ? `<span class="act hot">Arrive</span>` :
      `<button class="act hot" data-now="${idx}">⚡ Maintenant</button><button class="icon-btn" data-rm="${idx}">✕</button>`);
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
  el.innerHTML = `<div class="pl-actions" style="margin:8px 0 4px">
      <button class="act" data-all="0">▶ Tout lancer</button><button class="act" data-all="1">🔀 Mélanger</button>
      <span style="flex:1"></span><span class="a" style="color:var(--dim);font-size:13px;align-self:center">${all.length} titres</span></div>` +
    list.map(t => trackRow(t, `<button class="act" data-next="${t.id}">+ Ensuite</button><button class="icon-btn" data-more="${t.id}">⋯</button>`)).join('');
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
      <button class="act hot" data-play="${p.id}">▶</button><button class="act" data-shuf="${p.id}">🔀</button><button class="icon-btn" data-plmore="${p.id}">⋯</button></div>`;
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
    { label: '🔀 Lancer mélangé', fn: () => startSet([...p.ids], true) },
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

// ---------- Platine (affichage en direct) ----------
const canvas = $('#wave'), g = canvas.getContext('2d');
function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const v = engine.cur;
  const t = v?.track;
  const peaks = t?.peaks || new Array(160).fill(6);
  const prog = v ? Math.min(1, Math.max(0, v.posAt(engine.now) / t.duration)) : 0;
  const n = peaks.length, bw = w / n;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#ff2e88'); grad.addColorStop(.55, '#a855f7'); grad.addColorStop(1, '#22d3ee');
  for (let i = 0; i < n; i++) {
    const ph = Math.max(2, (peaks[i] / 100) * (h - 4));
    g.fillStyle = (i / n) < prog ? grad : '#34344a';
    g.fillRect(i * bw + 0.5, (h - ph) / 2, Math.max(1, bw - 1.5), ph);
  }
  if (v && engine.plan) {
    const mx = v.posAt(engine.plan.T0) / t.duration * w;
    g.fillStyle = '#a3e635'; g.fillRect(mx, 0, 2, h);
  }
  if (v) { g.fillStyle = '#fff'; g.fillRect(prog * w - 1, 0, 2, h); }
}

function renderDeck() {
  const v = engine.cur, t = v?.track;
  $('#nowTitle').textContent = t ? t.title : 'Aucune musique';
  if (t) {
    const bpm = Math.round(t.bpm * v.rate);
    $('#nowMeta').textContent = `${t.artist || 'Artiste inconnu'} · ${bpm} BPM · ${fmt(v.posAt(engine.now))} / ${fmt(t.duration)}`;
  } else {
    $('#nowMeta').textContent = state.tracks.size ? 'Lance une playlist ou touche une musique' : 'Importe tes musiques (MP3, MKV…) dans la Bibliothèque pour commencer';
  }
  const nextId = state.queue[state.qi + 1];
  const nt = state.tracks.get(nextId);
  let line = '';
  if (engine.committed && engine.inc) line = `<span class="live">● Transition</span> → <b>${esc(engine.inc.track.title)}</b>`;
  else if (t && nt) {
    const p = engine.plan;
    line = `Ensuite : <b>${esc(nt.title)}</b>` + (p ? ` · mix auto dans ${fmt(p.T0 - engine.now)}` : ' · préparation…');
  } else if (t) line = 'Rien à la suite — ajoute une musique avec « Ensuite »';
  $('#nextLine').innerHTML = line;
  const playing = !!t;
  $('#btnPlayPause').disabled = !playing && !state.queue.length;
  $('#btnPlayPause').classList.toggle('playing', playing && !engine.paused);
  $('#btnRemix').disabled = !playing;
  drawWave();
}
setInterval(renderDeck, 200);

function renderAll() { renderDeck(); renderQueue(); renderLibrary(); renderPlaylists(); }

// ---------- Commandes ----------
$('#btnRemix').addEventListener('click', doRemix);
$('#btnPlayPause').addEventListener('click', () => {
  if (!engine.playing) { if (state.queue.length) playIndex(Math.max(0, state.qi)); return; }
  if (engine.paused) { engine.resume(); keepAwake(); } else engine.pause();
  renderDeck();
});
$('#remixStyles').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  state.style = b.dataset.style; store.set('dj-style', state.style);
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
});
document.querySelector('.pads').addEventListener('click', e => {
  const b = e.target.closest('.pad'); if (!b || !engine.playing) return;
  const fx = b.dataset.fx;
  if (fx === 'echo') { engine.echoThrow(); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); return; }
  const on = !b.classList.contains('on');
  engine[fx](on);
  b.classList.toggle('on', on);
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
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.style === state.style));
  try {
    const [tracks, pls] = await Promise.all([db.allTracks(), db.allPlaylists()]);
    tracks.forEach(t => state.tracks.set(t.id, t));
    state.playlists = pls.sort((a, b) => a.created - b.created);
  } catch (e) { toast('Stockage indisponible'); }
  if (!state.tracks.size) switchTab('library');
  renderAll();
  setTimeout(hideSplash, Math.max(0, 2300 - (Date.now() - splashStart)));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
