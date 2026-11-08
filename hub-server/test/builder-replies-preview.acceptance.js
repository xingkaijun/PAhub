async (page, filePath) => {
  // Start inside a selected project's Inventory or Tracker page. Do not apply
  // replies: a preview must never navigate away or discard the open dialog.
  const navigations = [], errors = [];
  const onNavigation = frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); };
  const onError = error => errors.push(error.message);
  page.on('framenavigated', onNavigation);
  page.on('pageerror', onError);
  try {
    await page.getByRole('button', { name: 'Import Builder Replies', exact: true }).click();
    const newImport = page.getByRole('dialog').getByRole('button', { name: 'New import', exact: true });
    if (await newImport.isVisible()) await newImport.click();
    await page.locator('input[type="file"][accept*=".zip"]').setInputFiles(filePath);
    const ready = page.waitForResponse(response => response.url().includes('/builder-replies/preview') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Preview replies', exact: true }).click();
    const response = await ready, data = await response.json();
    if (!response.ok() || !data.files?.length) throw Error('Import preview failed: ' + JSON.stringify(data));
    const dialog = page.getByRole('dialog');
    await dialog.locator('tbody tr').first().waitFor();
    // Let filesystem notifications and the HMR client process queued HTML writes.
    await page.waitForTimeout(2000);
    if (navigations.length) throw Error('Import preview reloaded the page: ' + JSON.stringify(navigations));
    if (!await dialog.isVisible()) throw Error('Import dialog disappeared');
    if (await page.getByRole('heading', { name: 'Select Project', exact: true }).isVisible().catch(() => false)) throw Error('Import preview returned to the project hall');
    const count = await dialog.locator('tbody tr').count();
    if (count !== data.files.length) throw Error('Preview rows were lost');
    if (errors.length) throw Error(JSON.stringify(errors));
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    return { previewFiles: count, navigations: 0, projectPreserved: true, applied: false };
  } finally {
    page.off('framenavigated', onNavigation);
    page.off('pageerror', onError);
  }
}
