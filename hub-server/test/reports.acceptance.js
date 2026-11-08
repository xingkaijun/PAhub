async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(new URL('/', page.url()).href);
  await page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'PG-VLEC-H2684', exact: true }) }).click();
  await page.getByRole('heading', { name: 'Select Project', exact: true }).waitFor({ state: 'detached' });
  if (await page.getByRole('button', { name: 'Intelligence', exact: true }).count()) throw Error('Retired tab remains');
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  if (await edit.count()) { page.once('dialog', dialog => dialog.accept('')); await edit.click(); }
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await page.getByText('Daily Logs', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/daily-log.png' });
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByText('Activity Report', { exact: true }).first().waitFor();
  await page.screenshot({ path: 'output/playwright/activity-report.png' });
  if (errors.length) throw Error(JSON.stringify(errors));
  console.log(JSON.stringify({ pageerrors: 0, intelligenceAbsent: true, dailyLog: 'passed', activityReport: 'passed' }));
}
