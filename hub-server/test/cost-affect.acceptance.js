async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = new URL('/', page.url()).href;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + 'pcf/proj-test-001/dwg-005');
  await page.getByRole('button', { name: '+ Add comment', exact: true }).click();
  const comment = page.locator('#comments .comment').first(), tag = comment.getByRole('button', { name: 'Cost Affect', exact: true });
  await comment.locator('.editor[data-side="owner"]').fill('Review equipment specification changes for project cost impact.');
  const save = async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/ops') && r.request().method() === 'POST');
    await page.locator('header.banner').getByRole('button', { name: 'Save', exact: true }).click();
    if (!(await response).ok()) throw Error('Save failed');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.includes('Saved to server'));
  };
  await tag.click(); await save(); await page.reload();
  if (await tag.getAttribute('aria-pressed') !== 'true') throw Error('Tag lost on reload');
  await tag.click(); await save(); await page.reload();
  if (await tag.getAttribute('aria-pressed') !== 'false') throw Error('Tag removal lost on reload');
  await tag.click(); await save(); await page.reload();
  await page.getByRole('combobox', { name: 'Filter properties' }).selectOption('Cost Affect');
  if (await page.locator('#comments .comment').count() !== 1) throw Error('Tag filter failed');
  const metrics = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.waitForFunction(theme => { const tag = [...document.querySelectorAll('.tag-toggle.active')].find(el => el.textContent === 'Cost Affect'); return getComputedStyle(tag).backgroundColor === (theme === 'dark' ? 'rgb(100, 52, 15)' : 'rgb(255, 237, 213)'); }, theme);
    metrics.push({ theme, ...(await tag.evaluate(el => { const s = getComputedStyle(el); return { color: s.color, background: s.backgroundColor, border: s.borderColor }; })) });
    await page.screenshot({ path: 'output/playwright/cost-affect-' + theme + '.png' });
  }
  await page.emulateMedia({ media: 'print' });
  if (!await tag.isVisible()) throw Error('Print hides Cost Affect');
  await page.screenshot({ path: 'output/playwright/cost-affect-print.png' });
  await page.emulateMedia({ media: 'screen' });
  let pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export to Builder', exact: true }).click();
  await (await pending).saveAs('output/playwright/cost-affect-builder.html');
  await page.getByRole('button', { name: 'Excel options', exact: true }).click();
  pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Excel', exact: true }).click();
  await (await pending).saveAs('output/playwright/cost-affect.xlsx');
  if (errors.length) throw Error(JSON.stringify(errors));
  return { pageerrors: 0, addRemoveRefresh: 'passed', filter: 'passed', print: 'passed', builder: 'downloaded', excel: 'downloaded', metrics };
}
