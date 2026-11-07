import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.ts';
import { parseHTML, replaceData, atomicWrite } from './pcf-storage.ts';
import type { PcfData } from './pcf-model.ts';

export const TEMPLATE_VERSION = 4;
export const currentTemplate = () => readFileSync(path.join(ROOT_DIR, 'pcf/template/PG-PCF-hub.html'), 'utf8');
export const templateVersion = (html: string) => Number(html.match(/name="pahub-template-version" content="(\d+)"/)?.[1] || 2);
export const renderTemplate = (data: PcfData) => replaceData(currentTemplate(), data);
export function upgradeFile(file: string, dryRun = false) {
  const original = readFileSync(file, 'utf8'), data = parseHTML(original), from = templateVersion(original);
  if (from >= TEMPLATE_VERSION) return { file, from, to: TEMPLATE_VERSION, status: 'current' };
  const next = renderTemplate(data);
  if (JSON.stringify(parseHTML(next)) !== JSON.stringify(data)) throw Error('Template upgrade changed data');
  if (dryRun) return { file, from, to: TEMPLATE_VERSION, status: 'would-upgrade' };
  const backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Date.now();
  writeFileSync(backup, original, { encoding: 'utf8', flag: 'wx' });
  atomicWrite(file, next);
  return { file, from, to: TEMPLATE_VERSION, status: 'upgraded', backup };
}
