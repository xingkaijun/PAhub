import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TemplateCache } from '../src/template-cache.ts';
import { currentTemplate, renderTemplate } from '../src/pcf-template.ts';
import { parseHTML } from '../src/pcf-html.ts';

test('production template remains in memory; development reloads changed template', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pahub-template-cache-'));
  try {
    const file = path.join(dir, 'template.html'); writeFileSync(file, 'first', 'utf8');
    const production = new TemplateCache(file), development = new TemplateCache(file, true);
    writeFileSync(file, 'second-longer', 'utf8');
    assert.equal(production.read(), 'first'); assert.equal(development.read(), 'second-longer');
    rmSync(file);
    assert.equal(production.read(), 'first');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rendering from the startup template round-trips JSON including HTML delimiters', () => {
  const data = parseHTML(currentTemplate());
  data.project.planTitle = '中文 </script><script> & < >';
  const html = renderTemplate(data);
  assert.deepEqual(parseHTML(html), data);
  assert.ok(!html.includes('中文 </script><script>'));
});
