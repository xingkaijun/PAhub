async (page) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.reload();
  // The hall is shown on every mount; its card label changes when data is cached.
  await page.getByRole('heading', { name: 'Select Project', exact: true }).waitFor();
  await page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'PG-VLEC-H2684', exact: true }) }).click();
  await page.getByRole('heading', { name: 'Select Project', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Import Builder Replies' }).waitFor();
  const measurements = [];
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole('button', { name: 'Import Builder Replies' }).click();
      if (width === 1440 && theme === 'light') await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'builder-reply.html', mimeType: 'text/html', buffer: Buffer.from('<html>fixture</html>') });
      await page.getByText('1 file(s) selected').waitFor();
      const metrics = await page.getByRole('dialog').evaluate(el => {
        const b = el.getBoundingClientRect(), s = getComputedStyle(el);
        const button = [...el.querySelectorAll('button')].find(x => x.textContent.includes('Preview replies'));
        const p = button.getBoundingClientRect(), atButton = document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2);
        return { x: b.x, y: b.y, width: b.width, height: b.height, viewportWidth: innerWidth, viewportHeight: innerHeight, background: s.backgroundColor, rootInert: document.getElementById('root').inert, bodyOverflow: document.body.style.overflow, portal: el.parentElement.parentElement === document.body, buttonOnTop: button.contains(atButton) };
      });
      if (!metrics.portal || !metrics.rootInert || !metrics.buttonOnTop || metrics.bodyOverflow !== 'hidden' || metrics.y < 0 || metrics.y + metrics.height > metrics.viewportHeight || Math.abs(metrics.x + metrics.width / 2 - width / 2) > 1 || Math.abs(metrics.y + metrics.height / 2 - metrics.viewportHeight / 2) > 1 || metrics.background.includes('rgba')) throw Error(JSON.stringify(metrics));
      measurements.push({ theme, ...metrics });
      await page.screenshot({ path: 'output/playwright/import-dialog-' + theme + (width === 1440 ? '' : '-1920') + '.png' });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      if (await page.locator('#root').evaluate(el => el.inert)) throw Error('Background stayed inert');
    }
  }
  await page.getByRole('button', { name: 'Tracker', exact: true }).click();
  await page.getByRole('button', { name: 'Import Builder Replies' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.goto(new URL('/pcf/proj-test-001/dwg-005', page.url()).href);
  await page.locator('#pahub-import-file').waitFor({ state: 'attached' });
  const html = await page.evaluate(async () => {
    const base = '/api/pcf/proj-test-001/dwg-005', headers = { 'Content-Type': 'application/json', 'X-PCF-Token': window.PAHUB.credential };
    const response = await fetch(base + '/exports', { method: 'POST', headers, body: JSON.stringify({ clientId: 'acceptance', clientName: 'Acceptance' }) });
    const result = await response.json();
    if (!response.ok) throw Error(JSON.stringify(result));
    return (await fetch(base + '/exports/' + result.exportId + '/download', { headers })).text();
  });
  await page.locator('#pahub-import-file').setInputFiles({ name: 'builder-reply.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await page.locator('#modal[open]').waitFor();
  if (!await page.locator('#modal').evaluate(el => el.matches(':modal'))) throw Error('PCF dialog is not in native modal top layer');
  await page.keyboard.press('Escape');
  await page.locator('#modal[open]').waitFor({ state: 'detached' });
  if (errors.length) throw Error(JSON.stringify(errors));
  console.log(JSON.stringify({ pageerrors: errors.length, measurements, tracker: 'passed', pcfNativeModal: 'passed' }));
}
