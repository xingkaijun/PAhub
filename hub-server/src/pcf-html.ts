import { fail, type PcfData } from './pcf-model.ts';

// HTML is an interchange format only; authoritative documents are JSON files.
function dataBlock(html: string) {
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m => /\bid\s*=\s*(['"])pcf-data\1/i.test(m[1]));
  if (matches.length !== 1 || !/\btype\s*=\s*(['"])application\/json\1/i.test(matches[0][1])) fail('Expected one #pcf-data JSON script');
  return matches[0];
}
export function parseHTML(html: string): PcfData {
  try { return JSON.parse(dataBlock(html)[2]); } catch (e: any) { if (e.status) throw e; fail('Invalid pcf-data JSON'); }
}
export const scriptJSON = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
export function replaceData(html: string, data: PcfData) {
  const m = dataBlock(html), start = m.index! + m[0].indexOf('>') + 1;
  return html.slice(0, start) + scriptJSON(data) + html.slice(start + m[2].length);
}
