async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'Comments 6000 Acceptance', exact: true }) }).click();
  await page.getByRole('button', { name: 'Comments', exact: true }).click();
  const register = page.locator('section[aria-label="Comments register"]');
  await register.waitFor(); await page.waitForFunction(() => document.querySelector('section[aria-label="Comments register"]').getAttribute('aria-busy') === 'false');
  if (await register.locator('tbody tr').count() !== 25) throw Error('Expected paginated 25 rows');
  if (!await page.getByLabel('Tag', { exact: true }).locator('option[value="Cost Affect"]').count()) throw Error('Cost Affect filter missing');
  await page.evaluate(() => {
    window.__perf = { longTasks: [] };
    new PerformanceObserver(list => window.__perf.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: false });
  });
  const measured = async (name, action, expected) => {
    await page.evaluate(() => {
      const box = document.querySelector('section[aria-label="Comments register"]');
      window.__perf.result = null;
      document.addEventListener('click', () => {
        const start = performance.now(); let busy = false;
        const observer = new MutationObserver(() => {
          busy ||= box.getAttribute('aria-busy') === 'true';
          if (busy && box.getAttribute('aria-busy') === 'false') { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__perf.result = performance.now() - start; })); }
        }); observer.observe(box, { attributes: true, attributeFilter: ['aria-busy'] });
      }, { capture: true, once: true });
    });
    await action(); await page.waitForFunction(() => window.__perf.result !== null);
    const ms = await page.evaluate(() => window.__perf.result);
    if (!await register.getByText(expected, { exact: true }).count()) throw Error(name + ' wrong result count');
    return { name, ms: +ms.toFixed(2) };
  };
  await page.getByLabel('Tag', { exact: true }).selectOption('Cost Affect');
  const filter = await measured('Cost Affect filter', () => page.getByRole('button', { name: 'Apply filters', exact: true }).click(), '2,000 matching comments');
  await page.getByLabel('Search all round text', { exact: true }).fill('equipment 10/');
  const search = await measured('Search within tag', () => page.getByRole('button', { name: 'Apply filters', exact: true }).click(), '10 matching comments');
  const reset = await measured('Reset to all', () => page.getByRole('button', { name: 'Reset', exact: true }).click(), '6,000 matching comments');
  const pageMs = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now(), box = document.querySelector('section[aria-label="Comments register"]');
    const observer = new MutationObserver(() => { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))); });
    observer.observe(box.querySelector('tbody'), { childList: true, subtree: true });
    document.querySelector('button[aria-label="Next page"]').click();
  }));
  const scroll = await page.evaluate(async () => {
    const box = [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 20 && ['auto','scroll'].includes(getComputedStyle(el).overflowY)).sort((a,b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;
    const frames = []; let last = performance.now(), start = last;
    for (let i = 0; i < 90; i++) { box.scrollTop = box.scrollHeight * ((i % 30) / 29); await new Promise(requestAnimationFrame); const now = performance.now(); frames.push(now - last); last = now; }
    const sorted = frames.slice(2).sort((a,b) => a-b);
    return { durationMs: +(last-start).toFixed(2), p95FrameMs: +sorted[Math.floor(sorted.length * .95)].toFixed(2), maxFrameMs: +Math.max(...sorted).toFixed(2) };
  });
  await page.evaluate(() => { for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0; });
  await page.screenshot({ path: 'output/playwright/comments-6000-light.png' });
  const lightPalette = await page.locator('.inventory-theme').evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color, colorScheme: style.colorScheme };
  });
  if (lightPalette.background !== 'rgb(255, 255, 255)' || lightPalette.colorScheme !== 'light') throw Error('Comments must use the light palette');
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkSystemPalette = await page.locator('.inventory-theme').evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color, colorScheme: style.colorScheme };
  });
  if (JSON.stringify(darkSystemPalette) !== JSON.stringify(lightPalette)) throw Error('System dark mode changed Comments palette');
  await page.screenshot({ path: 'output/playwright/comments-6000-dark-system.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  if (await page.getByRole('button', { name: 'Intelligence', exact: true }).count()) throw Error('Retired navigation returned');
  const link = register.locator('tbody a').first(), popupReady = page.waitForEvent('popup');
  await link.click(); const popup = await popupReady;
  const expectedId = decodeURIComponent(new URL(popup.url()).hash.split('=')[1]);
  await popup.locator('[data-comment-focus="true"]').waitFor();
  if (await popup.locator('[data-comment-focus="true"]').getAttribute('data-cid') !== expectedId) throw Error('Stable ID focus failed');
  await popup.screenshot({ path: 'output/playwright/comments-id-focus.png' }); await popup.close();
  const report = { stableIdFocus: 'passed', intelligenceAbsent: true, pagination: { pageSize: 25, domRows: await register.locator('tbody tr').count(), total: 6000 }, filter, search, reset, pageMs: +pageMs.toFixed(2), scroll, longTasks: await page.evaluate(() => window.__perf.longTasks), pageerrors: errors };
  if (errors.length) throw Error(JSON.stringify(report));
  return report;
}
