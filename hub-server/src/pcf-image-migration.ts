import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite } from './atomic-write.ts';
import { PcfImageStore, eachImageList, isInlineImage, mayHaveInlineImages } from './pcf-images.ts';

const id = /^[A-Za-z0-9_-]{1,128}$/;

/** Current PCF JSON documents and history snapshots under data/pcf, as paths relative to it. */
function pcfJsonFiles(base: string) {
  const files: string[] = [];
  if (!existsSync(base)) return files;
  for (const project of readdirSync(base, { withFileTypes: true })) {
    if (!project.isDirectory() || !id.test(project.name)) continue;
    const dir = path.join(base, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name)) files.push(project.name + '/' + entry.name);
    }
    const history = path.join(dir, '.history');
    if (!existsSync(history)) continue;
    for (const drawing of readdirSync(history, { withFileTypes: true })) {
      if (!drawing.isDirectory() || !id.test(drawing.name)) continue;
      for (const entry of readdirSync(path.join(history, drawing.name), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(project.name + '/.history/' + drawing.name + '/' + entry.name);
      }
    }
  }
  return files.sort();
}

const normalizeInline = (data: any) => {
  const copy = structuredClone(data);
  eachImageList(copy, images => { for (const im of images) if (isInlineImage(im)) im.data = im.data.replace(/[\r\n]/g, ''); });
  return copy;
};

/**
 * One-off, idempotent conversion of inline (base64) PCF images to content-addressed files.
 * Each changed JSON file is first copied to <dataDir>/pcf-image-migration-backup/<stamp>/ (same
 * relative path), the image files are written, the converted document is checked to re-inline to
 * exactly the original, and only then the JSON is replaced atomically (temp file + rename).
 * Files without inline images are left untouched, so a second run changes nothing.
 */
export function migratePcfImages(options: { dataDir: string; dryRun?: boolean; now?: Date }) {
  const base = path.join(options.dataDir, 'pcf'), store = new PcfImageStore(options.dataDir);
  const stamp = (options.now || new Date()).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(options.dataDir, 'pcf-image-migration-backup', stamp);
  const report = { dataDir: options.dataDir, dryRun: !!options.dryRun, scanned: 0, converted: 0, documents: 0, snapshots: 0, images: 0, uniqueImages: 0, bytesBefore: 0, bytesAfter: 0, backupDir: null as string | null, files: [] as string[] };
  const hashes = new Set<string>();
  for (const relative of pcfJsonFiles(base)) {
    report.scanned++;
    const file = path.join(base, relative), text = readFileSync(file, 'utf8');
    if (!mayHaveInlineImages(text)) continue;
    const original = JSON.parse(text), data = structuredClone(original);
    const project = relative.split('/')[0];
    const count = store.externalize(project, data, { write: !options.dryRun });
    if (!count) continue;
    eachImageList(data, images => { for (const im of images) if (im?.hash) hashes.add(project + '/' + im.hash); });
    const next = JSON.stringify(data);
    report.converted++; report.images += count; report.files.push(relative);
    report.bytesBefore += Buffer.byteLength(text); report.bytesAfter += Buffer.byteLength(next);
    if (relative.includes('/.history/')) report.snapshots++; else report.documents++;
    if (options.dryRun) continue;
    if (!isDeepStrictEqual(store.hydrate(project, data), normalizeInline(original))) throw Error('Image migration round-trip check failed: ' + relative);
    const backup = path.join(backupDir, relative);
    mkdirSync(path.dirname(backup), { recursive: true });
    copyFileSync(file, backup);
    const { atime, mtime } = statSync(file);
    atomicWrite(file, next);
    utimesSync(file, atime, mtime);
    report.backupDir = backupDir;
  }
  report.uniqueImages = hashes.size;
  return report;
}
