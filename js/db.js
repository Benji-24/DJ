// Stockage local (IndexedDB) : musiques, fichiers audio et playlists.
const DB_NAME = 'dj-app';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    let result;
    const r = fn(st);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  allTracks: () => run('tracks', 'readonly', s => s.getAll()),
  putTrack: t => run('tracks', 'readwrite', s => s.put(t)),
  deleteTrack: id => Promise.all([
    run('tracks', 'readwrite', s => s.delete(id)),
    run('blobs', 'readwrite', s => s.delete(id)),
  ]),
  putBlob: (id, blob) => run('blobs', 'readwrite', s => s.put(blob, id)),
  getBlob: id => run('blobs', 'readonly', s => s.get(id)),
  allPlaylists: () => run('playlists', 'readonly', s => s.getAll()),
  putPlaylist: p => run('playlists', 'readwrite', s => s.put(p)),
  deletePlaylist: id => run('playlists', 'readwrite', s => s.delete(id)),
};
