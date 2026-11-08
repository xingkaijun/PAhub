async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = new URL('/', page.url()).href;
  await page.goto(base);
  await page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'PG-VLEC-H2684', exact: true }) }).click();
  await page.getByRole('heading', { name: 'Select Project', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Import Builder Replies', exact: true }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles('output/playwright/cost-affect-builder.html');
  await page.getByRole('button', { name: 'Preview replies', exact: true }).click();
  await page.getByRole('dialog').getByText('Cost Affect', { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: 'output/playwright/cost-affect-import-' + theme + '.png' });
  }
  if (errors.length) throw Error(JSON.stringify(errors));
  return { pageerrors: 0, importSummary: 'Cost Affect visible' };
}
