async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = new URL('/', page.url()).href, measurements = [];
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
    await page.goto(base);
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'PG-VLEC-H2684', exact: true }) }).click();
    await page.getByRole('heading', { name: 'Select Project', exact: true }).waitFor({ state: 'detached' });
    const papcHeight = await page.locator('header').first().evaluate(el => el.getBoundingClientRect().height);
    await page.goto(base + 'pcf/proj-test-001/dwg-005');
    await page.locator('#pahub-hosted-actions').waitFor();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator('header.banner').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await page.locator('header.banner').evaluate(el => {
        const box = node => node.getBoundingClientRect(), nav = el.querySelector('.banner-nav'), style = getComputedStyle(nav);
        const buttons = [...nav.children].filter(node => getComputedStyle(node).display !== 'none');
        const brand = box(el.querySelector('.brand')), tools = box(el.querySelector('.banner-actions')), hosted = box(el.querySelector('.pahub-hosted-actions'));
        const rows = [...el.querySelectorAll('.pahub-hosted-actions button')].map(box);
        return { height: box(el).height, toolbarWidth: box(nav).width, buttonsWidth: buttons.reduce((sum, node) => sum + box(node).width, 0), padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
          logoHeight: box(el.querySelector('.logo')).height, singleLine: rows.every(row => Math.abs(row.top - rows[0].top) <= 1),
          centerError: Math.abs((hosted.left + hosted.right - brand.right - tools.left) / 2), overflow: el.scrollWidth > el.clientWidth };
      });
      if (Math.abs(metrics.height - papcHeight) > 2 || metrics.toolbarWidth - metrics.buttonsWidth > metrics.padding + 4 || !metrics.singleLine || metrics.centerError > 2 || metrics.overflow || metrics.logoHeight !== 32) throw Error(JSON.stringify({ width, theme, papcHeight, ...metrics }));
      measurements.push({ width, theme, papcHeight, ...metrics });
      await page.screenshot({ path: 'output/playwright/banner-toolbar-' + theme + '-' + width + '.png' });
    }
  }
  for (const width of [900, 375]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.locator('header.banner').evaluate(el => el.scrollWidth > el.clientWidth)) throw Error('Narrow overflow at ' + width);
  }
  await page.emulateMedia({ media: 'print' });
  if (await page.locator('#pahub-hosted-actions').evaluate(el => getComputedStyle(el).display !== 'none')) throw Error('Print behavior changed');
  await page.emulateMedia({ media: 'screen' });
  if (errors.length) throw Error(JSON.stringify(errors));
  return { pageerrors: 0, measurements, narrow: 'passed', print: 'passed' };
}
