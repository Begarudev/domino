// Cuts recorded takes into the edit described by a script module, burns in caption bands and title cards, and writes
// the mp4, captions.srt and an edit log.
//   node video/assemble.mjs --script video/script-pivot.mjs --takes video/out --out ~/Documents/domino-video/domino-draft.mp4
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderOverlays, APP } from './overlays.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
const TAKES = resolve(args.takes || 'video/out');
const OUTFILE = resolve(args.out || 'video/out/domino.mp4');
const WORK = join(TAKES, '_work');
mkdirSync(WORK, { recursive: true });
mkdirSync(dirname(OUTFILE), { recursive: true });
const FPS = 30;

const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const probeDur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

// Load takes: frames, marks, facts.
const takes = {};
function take(name) {
  if (takes[name]) return takes[name];
  const dir = join(TAKES, name);
  const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
  const marks = JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8'));
  const facts = existsSync(join(dir, 'facts.json')) ? JSON.parse(readFileSync(join(dir, 'facts.json'), 'utf8')) : {};
  const t0 = frames[0].t;
  const master = join(dir, 'master.mp4');
  if (!existsSync(master) || statSync(master).mtimeMs < statSync(join(dir, 'frames.json')).mtimeMs) {
    const lines = [];
    for (let i = 0; i < frames.length; i++) {
      const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 0.5;
      lines.push(`file '${join(dir, 'frames', frames[i].file)}'`, `duration ${d.toFixed(4)}`);
    }
    lines.push(`file '${join(dir, 'frames', frames.at(-1).file)}'`);
    writeFileSync(join(dir, 'frames.txt'), lines.join('\n'));
    console.log(`master ${name}: ${frames.length} frames`);
    ff('-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-fps_mode', 'cfr', '-r', String(FPS),
      '-vf', 'scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'veryfast', master);
  }
  const at = (ref) => {
    if (typeof ref === 'number') return ref;
    const { mark, off = 0, last } = typeof ref === 'string' ? { mark: ref } : ref;
    const hits = marks.filter(m => m.name === mark);
    if (!hits.length) throw new Error(`take ${name}: no mark ${mark}`);
    return (last ? hits.at(-1) : hits[0]).t - t0 + off;
  };
  const has = mark => marks.some(m => m.name === mark);
  return (takes[name] = { name, dir, frames, marks, facts, t0, master, at, has, duration: frames.at(-1).t - t0 });
}

const scriptMod = await import(pathToFileURL(resolve(args.script || 'video/script-pivot.mjs')).href);
const facts = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? take(k).facts : undefined) });
const items = scriptMod.beats({ facts, has: (t, m) => { try { return take(t).has(m); } catch { return false; } } }).filter(Boolean);

// Overlays.
const overlayItems = items.map((it, i) => ({ id: `ov-${String(i).padStart(2, '0')}`, card: it.card, band: it.band }));
await renderOverlays(overlayItems, WORK);

// Segments.
const segs = [];
let clock = 0;
const srt = [];
const log = [];
const fmt = s => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, x = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const ov = join(WORK, `${overlayItems[i].id}.png`);
  const out = join(WORK, `seg-${String(i).padStart(2, '0')}.mp4`);
  let dur;
  if (it.card) {
    dur = it.dur ?? 5;
    ff('-loop', '1', '-t', String(dur), '-i', ov, '-vf', `fps=${FPS},format=yuv420p,fade=in:st=0:d=0.35,fade=out:st=${(dur - 0.35).toFixed(2)}:d=0.35`,
      '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-r', String(FPS), out);
    log.push({ i, kind: 'card', dur, title: it.card.title });
  } else {
    const T = take(it.take);
    const a = Math.max(0, T.at(it.from));
    let b = Math.min(T.duration, T.at(it.to));
    const speed = it.speed ?? 1;
    if (it.maxDur && (b - a) / speed > it.maxDur) b = a + it.maxDur * speed;
    const src = b - a;
    const hold = it.holdEnd ?? 0;
    dur = src / speed + hold;
    const pad = hold ? `,tpad=stop_mode=clone:stop_duration=${hold}` : '';
    const vf = `[0:v]trim=duration=${src.toFixed(3)},setpts=(PTS-STARTPTS)/${speed},fps=${FPS}${pad},scale=${APP.w}:${APP.h}:flags=lanczos,` +
      `fade=in:st=0:d=0.18[a];[1:v][a]overlay=${APP.x}:${APP.y}:eof_action=endall,format=yuv420p`;
    ff('-ss', a.toFixed(3), '-i', T.master, '-loop', '1', '-i', ov, '-filter_complex', vf, '-t', dur.toFixed(3),
      '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-r', String(FPS), '-an', out);
    log.push({ i, kind: 'clip', take: it.take, from: it.from, to: it.to, srcStart: +a.toFixed(2), srcDur: +src.toFixed(2), speed, dur: +dur.toFixed(2), headline: it.band?.headline });
  }
  dur = probeDur(out);
  const text = it.card ? [it.card.kicker, it.card.title, it.card.sub].filter(Boolean).join('\n') :
    [it.band.step ? `[${it.band.step}/${it.band.total} ${it.band.stepLabel}] ${it.band.headline}` : it.band.headline, it.band.sub,
      (it.band.pills || []).map(p => `(${p.text})`).join(' ')].filter(Boolean).join('\n');
  srt.push(`${srt.length + 1}\n${fmt(clock)} --> ${fmt(clock + dur)}\n${text}\n`);
  segs.push(out);
  clock += dur;
}

const list = join(WORK, 'concat.txt');
writeFileSync(list, segs.map(s => `file '${s}'`).join('\n'));
ff('-f', 'concat', '-safe', '0', '-i', list, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', OUTFILE);
const total = probeDur(OUTFILE);
const base = OUTFILE.replace(/\.mp4$/, '');
writeFileSync(`${base}.srt`, srt.join('\n'));
writeFileSync(`${base}.edit.json`, JSON.stringify({ total, items: log }, null, 1));
console.log(`wrote ${OUTFILE} ${total.toFixed(2)}s, ${segs.length} segments`);
