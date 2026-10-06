// EXIF of Fuji RAF files for the library, without reading the whole file.
// The library reads the EXIF of every photo in a folder as soon as it opens (read_exif_for_paths). For a RAF,
// RapidRAW gets it through rawler, which reads far more of the 30–45 MB file than the metadata; for a folder shared
// on demand from a browsing computer, that means fetching nearly every file over the network. The camera's
// embedded JPEG carries the same EXIF in its header (~65 KB): the relay saves just that header as a temporary .raf
// file (from the browsing computer: "rafexif" in rrweb/files/remote.ts; on the server: read from the file) and
// lets RapidRAW's own parser read it. Photos whose .rrdata already holds EXIF are left to RapidRAW.
// Relies on read_exif_for_paths trying kamadak-exif (extract_metadata) before rawler for RAW files;
// rrweb/check-shims.mjs fails the build if that changes.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PRIO } from './remote.mjs';

const EXIF_PARALLEL = 8;
// EXIF fields that describe the embedded JPEG rather than the RAW (preview size, compression…)
const JPEG_ONLY = new Set(['PixelXDimension', 'PixelYDimension', 'Compression', 'CompressedBitsPerPixel', 'JPEGInterchangeFormat',
  'JPEGInterchangeFormatLength', 'XResolution', 'YResolution', 'ResolutionUnit', 'YCbCrPositioning', 'ComponentsConfiguration',
  'MakerNote', 'UserComment', 'InteroperabilityIndex', 'InteroperabilityVersion', 'FlashpixVersion', 'ColorSpace', 'Orientation']);

const isRaf = (p) => typeof p === 'string' && /\.raf$/i.test(p) && !p.includes('?vc=');

// SOI … APP1 Exif segment, EOI: enough for an EXIF parser (rrweb/files/remote.ts "rafexif" does the same in the browser)
function exifHead(j) {
  for (let i = 2; i + 10 <= j.length && j[i] === 0xff;) {
    const seg = 2 + j.readUInt16BE(i + 2);
    if (j[i + 1] === 0xe1 && j.toString('latin1', i + 4, i + 8) === 'Exif') return Buffer.concat([j.subarray(0, i + seg), Buffer.from([0xff, 0xd9])]);
    i += seg;
  }
  return null;
}

// RAF on the server's disk: the EXIF header of the embedded JPEG (RAF header: its offset and length at 84 and 88,
// big-endian)
async function localExifHead(p) {
  const fh = await fsp.open(p, 'r');
  try {
    const head = Buffer.alloc(92);
    await fh.read(head, 0, 92, 0);
    if (head.toString('latin1', 0, 15) !== 'FUJIFILMCCD-RAW') return null;
    const j = Buffer.alloc(Math.min(head.readUInt32BE(88), 1 << 18));
    await fh.read(j, 0, j.length, head.readUInt32BE(84));
    return exifHead(j);
  } finally { await fh.close(); }
}

// .rrdata with EXIF (RapidRAW reads it before the RAW; the user may have edited it)
const sidecarHasExif = (text) => { try { return !!JSON.parse(text)?.exif; } catch { return false; } };

// locate(p) → { share, rel } for a file in an on-demand folder, or null; offline(p) → is its browser disconnected;
// bridge(cmd, args) → call a RapidRAW command; work → work folder (RR_WORK)
export function createExif({ locate, offline, bridge, work }) {
  const cache = new Map(); // file key (size, time) → EXIF map

  // RAF in an on-demand folder: { share, rel, entry, edited } or null
  async function remoteRaf(p) {
    const hit = locate(p);
    if (!hit || hit.share.local.has(hit.rel)) return null;
    const slash = hit.rel.lastIndexOf('/');
    const name = hit.rel.slice(slash + 1);
    const entries = await hit.share.list(slash < 0 ? '' : hit.rel.slice(0, slash), false);
    const entry = entries.get(name);
    if (entry?.kind !== 'file') return null;
    return { ...hit, entry, edited: entries.has(`${name}.rrdata`) || hit.share.local.has(`${hit.rel}.rrdata`) };
  }

  // EXIF of one RAF from the embedded JPEG's header, through RapidRAW's parser; null → let RapidRAW read it itself
  async function exifOf(p, exifDir) {
    if (!isRaf(p)) return null;
    let key;
    let head;
    const raf = locate(p) ? await remoteRaf(p) : null;
    if (raf) {
      key = `${raf.share.id}:${raf.rel}:${raf.entry.size}:${raf.entry.mtime}`;
      if (cache.has(key)) return cache.get(key);
      if (raf.edited) {
        const side = await raf.share.cached(`${raf.rel}.rrdata`).catch(() => null);
        if (!side || sidecarHasExif((await side.read(0, side.size)).toString('utf8'))) return null;
      }
      ({ data: head } = await raf.share.requestAt(PRIO.META, { op: 'rafexif', path: raf.rel }));
    } else {
      const st = await fsp.stat(p).catch(() => null);
      if (!st?.isFile() || locate(p)) return null;
      key = `local:${p}:${st.size}:${st.mtimeMs}`;
      if (cache.has(key)) return cache.get(key);
      const side = await fsp.readFile(`${p}.rrdata`, 'utf8').catch(() => null);
      if (side !== null && sidecarHasExif(side)) return null;
      head = await localExifHead(p);
      if (!head) return null;
    }
    // a fixed name per photo, so RapidRAW's .rrcache doesn't grow
    const tmp = path.join(exifDir, `${createHash('sha256').update(p).digest('hex').slice(0, 32)}.raf`);
    await fsp.writeFile(tmp, head);
    return { key, tmp };
  }

  return {
    // read_exif_for_paths from the UI (the library reads the EXIF of every photo in a folder): RAFs from the
    // embedded JPEG, everything else (and anything that fails) normally through RapidRAW; photos from disconnected
    // folders are skipped
    async readExif(paths) {
      paths = paths.filter((p) => !offline(p));
      if (!paths.some(isRaf)) return paths.length ? bridge('read_exif_for_paths', { paths }) : {};
      const exifDir = path.join(work, 'exif');
      await fsp.mkdir(exifDir, { recursive: true });
      const found = new Map();
      const todo = [...paths];
      await Promise.all(Array.from({ length: EXIF_PARALLEL }, async () => {
        for (let p; (p = todo.shift()) !== undefined;) {
          try { found.set(p, await exifOf(p, exifDir)); } catch (e) {
            if (e.code !== 'ENOENT') console.warn(`[exif] ${p}: ${e.message}`);
            found.set(p, null);
          }
        }
      }));
      const tmps = [...found.values()].filter((v) => v?.tmp);
      const direct = paths.filter((p) => !found.get(p));
      const result = (direct.length || tmps.length ? await bridge('read_exif_for_paths', { paths: [...direct, ...tmps.map((t) => t.tmp)] }) : null) ?? {};
      for (const [p, v] of found) {
        if (!v) continue;
        let map = v.tmp ? result[v.tmp] : v;
        if (v.tmp) {
          delete result[v.tmp];
          if (!map) continue; // RapidRAW didn't understand the header: the normal way next time
          map = Object.fromEntries(Object.entries(map).filter(([k]) => !JPEG_ONLY.has(k) && !k.startsWith('Tag(')));
          if (map.PhotographicSensitivity && !map.ISOSpeedRatings) map.ISOSpeedRatings = map.PhotographicSensitivity;
          if (cache.size > 50000) cache.clear();
          cache.set(v.key, map);
        }
        result[p] = map;
      }
      await Promise.all(tmps.map((t) => fsp.rm(t.tmp, { force: true })));
      return result;
    },
  };
}
