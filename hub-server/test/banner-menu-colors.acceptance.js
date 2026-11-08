async (page) => {
  // Start on a hosted PCF. Check real computed colors, not only CSS selectors.
  await page.locator('header.pahub-unified').waitFor();
  const measurements = [];
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  try {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const key of ['save', 'json', 'excel', 'pahub-io']) {
        const trigger = page.locator('#' + key + '-menu-btn');
        const panel = page.locator('#' + key + (key === 'pahub-io' ? '-panel' : '-menu-panel'));
        await trigger.focus();
        await trigger.press('ArrowDown');
        await panel.waitFor({ state: 'visible' });
        for (const state of ['normal', 'hover', 'focus']) {
          await page.mouse.move(0, 0);
          await trigger.focus();
          const item = panel.locator('button:not(:disabled)').first();
          if (state === 'hover') await item.hover();
          if (state === 'focus') await item.focus();
          const items = await panel.evaluate(panel => {
            const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = color => rgb(color).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
            return [...panel.querySelectorAll('button:not(:disabled)')].map(button => {
              const style = getComputedStyle(button);
              const background = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(panel).backgroundColor : style.backgroundColor;
              const a = luminance(style.color), b = luminance(background);
              return { id: button.id, color: style.color, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
            });
          });
          if (!items.length || items.some(item => !Number.isFinite(item.contrast) || item.contrast < 4.5)) throw Error(JSON.stringify({ theme, key, state, items }));
          measurements.push({ theme, key, state, items });
        }
        await panel.locator('button:not(:disabled)').first().focus();
        await page.keyboard.press('Escape');
        if (await trigger.getAttribute('aria-expanded') !== 'false') throw Error(key + ' did not close');
      }
    }
    return { passed: true, measurements };
  } finally {
    await page.evaluate(theme => {
      if (theme === null) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
    }, originalTheme);
  }
}
