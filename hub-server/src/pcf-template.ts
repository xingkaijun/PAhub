import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.ts';
import { parseHTML, replaceData } from './pcf-html.ts';
import { atomicWrite } from './atomic-write.ts';
import { cleanupLegacyImport, type PcfData } from './pcf-model.ts';

export const TEMPLATE_VERSION = 6;
export const currentTemplate = () => readFileSync(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8');
export const templateVersion = (html: string) => Number(html.match(/name="pahub-template-version" content="(\d+)"/)?.[1] || 2);
export const renderTemplate = (data: PcfData) => replaceData(currentTemplate(), data);
export function upgradeFile(file: string, dryRun = false): { file: string; from: number; to: number; status: string; backup?: string; deletedToClean?: number; emptyRoundsToPrune?: number } {
  const original = readFileSync(file, 'utf8'), data = parseHTML(original), from = templateVersion(original);
  if (from >= TEMPLATE_VERSION) return { file, from, to: TEMPLATE_VERSION, status: 'current' };
  const legacy = data.deleted || [];
  data.hub ??= { rev: 0, entities: {} }; data.hub.tombstones ??= [];
  for (const t of legacy) {
    const records = t.type === 'comment' ? [t.data, ...(t.data.rounds || [])] : [t.data];
    for (const record of records) if (!data.hub.tombstones.some((x: any) => x.id === record.id)) data.hub.tombstones.push({ id: record.id, type: record === t.data && t.type === 'comment' ? 'comment' : 'round', parentId: t.type === 'comment' ? (record === t.data ? null : t.data.id) : t.parentId, clock: t.rev || data.hub.entities?.['deleted:' + t.id]?.rev || data.hub.rev, at: t.deletedAt });
  }
  data.deleted ??= []; data.roundRegister ??= []; data.circulation ??= []; data.approvalHistory ??= [];
  const cleanup = cleanupLegacyImport(data);
  const report = { deletedToClean: cleanup.deleted, emptyRoundsToPrune: cleanup.removed.length };
  const next = renderTemplate(data);
  if (JSON.stringify(parseHTML(next)) !== JSON.stringify(data)) throw Error('Template upgrade changed data');
  if (dryRun) return { file, from, to: TEMPLATE_VERSION, status: 'would-upgrade', ...report };
  const backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Date.now();
  writeFileSync(backup, original, { encoding: 'utf8', flag: 'wx' });
  atomicWrite(file, next);
  return { file, from, to: TEMPLATE_VERSION, status: 'upgraded', backup, ...report };
}
