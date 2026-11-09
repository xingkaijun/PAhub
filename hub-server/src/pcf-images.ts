import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fail } from './pcf-model.ts';

// Content-addressed PCF attachments. A stored PCF image is a reference
// { id, name, mime, hash, width, height }: hash is the sha256 of the decoded
// bytes and the file lives once per project at pcf/<project>/.images/<aa>/<hash>.<ext>.
// Offline copies (Builder/complete exports) still carry inline data URLs; they
// are re-inlined on export and turned back into references on import.
export const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]*)$/;
export const HASH = /^[a-f0-9]{64}$/;

export const isInlineImage = (im: any) => !!im && typeof im === 'object' && typeof im.data === 'string' && im.data.startsWith('data:');
export const isImageRef = (im: any) => !!im && typeof im === 'object' && typeof im.hash === 'string' && im.data === undefined;

/** Calls fn on every `images` array in a PCF document (comments, rounds, deleted records, tombstones). */
export function eachImageList(value: any, fn: (images: any[]) => void) {
  if (Array.isArray(value)) { for (const item of value) eachImageList(item, fn); return; }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (key === 'images' && Array.isArray(child)) fn(child);
    else if (child && typeof child === 'object') eachImageList(child, fn);
  }
}
export function hasInlineImages(data: any) {
  let found = false;
  eachImageList(data, images => { if (images.some(isInlineImage)) found = true; });
  return found;
}
/** Fast string pre-check for raw JSON text before parsing it. */
export const mayHaveInlineImages = (json: string) => json.includes('"data:image/');

export function decodeDataURL(dataURL: string) {
  const m = DATA_URL.exec(dataURL);
  if (!m) fail('Invalid image');
  const bytes = Buffer.from(m![2].replace(/[\r\n]/g, ''), 'base64');
  return { ext: m![1], bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}
/** The stored reference form of an image record; key order is fixed. */
export function refRecord(im: any, hash: string) {
  return { id: im.id, name: String(im.name || ''), mime: String(im.mime || ''), hash, width: Number(im.width) || 0, height: Number(im.height) || 0 };
}
/** The offline (inline) form of an image record; the same shape the template has always used. */
export function inlineRecord(im: any, data: string) {
  return { id: im.id, name: String(im.name || ''), mime: String(im.mime || ''), data, width: Number(im.width) || 0, height: Number(im.height) || 0 };
}

function writeBytes(file: string, bytes: Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(temp, 'wx');
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export class PcfImageStore {
  constructor(readonly dataDir: string) {}
  dir(p: string) { return path.join(this.dataDir, 'pcf', p, '.images'); }
  file(p: string, hash: string, ext: string) { return path.join(this.dir(p), hash.slice(0, 2), hash + '.' + ext); }
  find(p: string, hash: string) {
    if (!HASH.test(hash)) return undefined;
    for (const ext of Object.keys(IMAGE_TYPES)) {
      const file = this.file(p, hash, ext);
      if (existsSync(file)) return { file, ext, mime: IMAGE_TYPES[ext] };
    }
    return undefined;
  }
  has(p: string, hash: string) { return !!this.find(p, hash); }
  /** Stores the decoded bytes of a data URL once (content addressed) and returns their hash. */
  put(p: string, dataURL: string, write = true) {
    const { ext, bytes, hash } = decodeDataURL(dataURL);
    if (write && !existsSync(this.file(p, hash, ext))) writeBytes(this.file(p, hash, ext), bytes);
    return hash;
  }
  read(p: string, hash: string) {
    const found = this.find(p, hash);
    if (!found) return undefined;
    return { bytes: readFileSync(found.file), mime: found.mime, ext: found.ext };
  }
  dataURL(p: string, hash: string) {
    const found = this.read(p, hash);
    if (!found) fail('PCF image file missing: ' + hash, 500);
    return 'data:' + found!.mime + ';base64,' + found!.bytes.toString('base64');
  }
  /**
   * Converts every inline image of `data` (in place) to a reference, writing the bytes
   * when `write` is set. With `verify`, references must point at a stored file.
   * Returns the number of images converted.
   */
  externalize(p: string, data: any, { write = true, verify = false }: { write?: boolean; verify?: boolean } = {}) {
    let converted = 0;
    eachImageList(data, images => {
      for (let i = 0; i < images.length; i++) {
        const im = images[i];
        if (isInlineImage(im)) { images[i] = refRecord(im, this.put(p, im.data, write)); converted++; }
        else if (verify && isImageRef(im) && !this.has(p, im.hash)) fail('Unknown image reference: ' + im.hash);
      }
    });
    return converted;
  }
  /** A copy of `data` with every reference replaced by its inline data URL (for offline copies and exports). */
  hydrate<T>(p: string, data: T): T {
    const copy = structuredClone(data), cache = new Map<string, string>();
    eachImageList(copy, images => {
      for (let i = 0; i < images.length; i++) {
        const im = images[i];
        if (!isImageRef(im)) continue;
        if (!cache.has(im.hash)) cache.set(im.hash, this.dataURL(p, im.hash));
        images[i] = inlineRecord(im, cache.get(im.hash)!);
      }
    });
    return copy;
  }
}

/**
 * Reference form of an untrusted copy, for comparisons only: inline images become
 * { ..., hash } without touching disk, so an inline image and the reference of the
 * same bytes compare equal.
 */
export function comparableImages<T>(data: T): T {
  const copy = structuredClone(data);
  eachImageList(copy, images => {
    for (let i = 0; i < images.length; i++) if (isInlineImage(images[i])) images[i] = refRecord(images[i], decodeDataURL(images[i].data).hash);
  });
  return copy;
}
