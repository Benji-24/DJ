// Travailleur en arrière-plan : extrait la piste audio d'une vidéo (MKV, MP4, MOV…)
// grâce à ffmpeg (version web), sans bloquer l'appli.
const base = new URL('../vendor/ffmpeg/core/', self.location).href;
let core = null;
let logs = [];

async function load() {
  if (core) return;
  importScripts(base + 'ffmpeg-core.js');
  const wasmURL = base + 'ffmpeg-core.wasm';
  core = await self.createFFmpegCore({
    mainScriptUrlOrBlob: base + 'ffmpeg-core.js#' + btoa(JSON.stringify({ wasmURL, workerURL: '' })),
  });
  core.setLogger(l => { if (logs.length < 400) logs.push(l.message); });
  core.setProgress(p => self.postMessage({ type: 'progress', p: p.progress }));
}

function run(args) {
  core.setTimeout(-1);
  core.exec(...args);
  const r = core.ret;
  core.reset();
  return r;
}

self.onmessage = async ({ data }) => {
  const { id, file } = data;
  let mounted = false;
  try {
    self.postMessage({ id, type: 'status', s: core ? 'ready' : 'loading' });
    await load();
    try { core.FS.mkdir('/in'); } catch (e) { }
    core.FS.mount(core.FS.filesystems.WORKERFS, { files: [file] }, '/in');
    mounted = true;
    const inp = '/in/' + file.name;
    // 1) quel est le format du son ?
    logs = [];
    run(['-hide_banner', '-i', inp]);
    const info = logs.join('\n');
    if (!/Audio:/.test(info)) throw new Error('noaudio');
    const codec = (info.match(/Audio:\s*([a-z0-9_]+)/i) || [])[1] || '';
    // 2) AAC ou MP3 : on récupère le son tel quel (rapide, sans perte)
    //    sinon (Opus, AC3, Vorbis…) : on le convertit en AAC
    let out, mime, args;
    if (codec === 'aac') { out = '/out.m4a'; mime = 'audio/mp4'; args = ['-i', inp, '-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'copy', '-y', out]; }
    else if (codec === 'mp3') { out = '/out.mp3'; mime = 'audio/mpeg'; args = ['-i', inp, '-vn', '-sn', '-dn', '-map', '0:a:0', '-c:a', 'copy', '-y', out]; }
    else { out = '/out.m4a'; mime = 'audio/mp4'; args = ['-i', inp, '-vn', '-sn', '-dn', '-map', '0:a:0', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-y', out]; }
    let r = run(args);
    if (r !== 0 && codec === 'aac') { // dernier recours : conversion
      out = '/out.m4a'; mime = 'audio/mp4';
      r = run(['-i', inp, '-vn', '-sn', '-dn', '-map', '0:a:0', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-y', out]);
    }
    core.FS.unmount('/in'); mounted = false;
    if (r !== 0) throw new Error('convert');
    const bytes = core.FS.readFile(out);
    core.FS.unlink(out);
    self.postMessage({ id, type: 'done', bytes, mime, codec }, [bytes.buffer]);
  } catch (e) {
    if (mounted) { try { core.FS.unmount('/in'); } catch (_) { } }
    self.postMessage({ id, type: 'error', msg: e && e.message ? e.message : String(e) });
  }
};
