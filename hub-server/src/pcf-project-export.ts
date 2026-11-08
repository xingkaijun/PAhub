import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PcfStorage } from './pcf-storage.ts';
import { PcfExchange } from './pcf-exchange.ts';
import { safeId, fail, type Actor } from './pcf-model.ts';
import { createZip } from './zip.ts';

export function exportPcfProject(storage: PcfStorage, exchange: PcfExchange, projectId: string, output: string, actor: Actor) {
  const p = safeId(projectId), db = storage.db, target = path.resolve(output);
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(p)) fail('Project not found', 404);
  if (existsSync(target)) throw Error('Output already exists; choose a new ZIP path');
  const drawings = db.prepare('SELECT id,drawing_no,title FROM drawings WHERE project_id=? AND COALESCE(_deleted,0)=0 ORDER BY drawing_no,id').all(p);
  const created: { id: string; exportId: string }[] = [], rows: any[] = [], entries: { name: string; data: string }[] = [];
  const temp = target + '.' + randomUUID() + '.tmp';
  let published = false;
  db.exec('SAVEPOINT pcf_project_export');
  try {
    for (const drawing of drawings) {
      const d = safeId(drawing.id);
      if (!existsSync(storage.file(p, d))) {
        if (existsSync(storage.file(p, d).replace(/\.json$/, '.html'))) throw Error('Legacy HTML found; migrate this project first');
        rows.push({ drawingId: d, drawingNo: drawing.drawing_no, title: drawing.title, status: 'skipped', reason: 'no PCF' }); continue;
      }
      const exportId = randomUUID();
      created.push({ id: d, exportId });
      const record = exchange.createComplete(p, d, actor, exportId);
      // Stable IDs avoid duplicate/unsafe platform filenames and preserve ZIP mapping.
      const name = d + '.html';
      entries.push({ name, data: exchange.download(p, d, record.exportId).html });
      rows.push({ drawingId: d, drawingNo: drawing.drawing_no, title: drawing.title, documentId: storage.load(p, d).data.documentId, status: 'exported', file: name, exportId: record.exportId, baseRev: record.baseRev });
    }
    const manifest = { mode: 'complete', projectId: p, exportedAt: new Date().toISOString(), documents: created.length, skipped: rows.length - created.length, drawings: rows };
    entries.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
    const buffer = createZip(entries);
    mkdirSync(path.dirname(target), { recursive: true });
    const fd = openSync(temp, 'wx'); try { writeFileSync(fd, buffer); fsyncSync(fd); } finally { closeSync(fd); }
    // Hard-link publication is atomic and fails if output appeared since validation.
    linkSync(temp, target); published = true; unlinkSync(temp);
    db.exec('RELEASE pcf_project_export');
    return { ...manifest, output: target, bytes: buffer.length };
  } catch (error) {
    db.exec('ROLLBACK TO pcf_project_export; RELEASE pcf_project_export');
    if (published && existsSync(target)) unlinkSync(target);
    for (const item of created) {
      const file = path.join(storage.dataDir, 'pcf', p, item.id, 'exports', item.exportId + '.html');
      if (existsSync(file)) unlinkSync(file);
    }
    throw error;
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
