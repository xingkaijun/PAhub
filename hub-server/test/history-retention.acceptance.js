async (page) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const base = new URL('/', page.url()).href, endpoint = base + 'api/pcf/proj-test-001/dwg-004/';
  const api = async (tail, body) => {
    const response = await page.request[body ? 'post' : 'get'](endpoint + tail, body ? { data: { clientId: 'retention-acceptance', clientName: 'Acceptance', ...body } } : {});
    if (!response.ok()) throw Error(tail + ' HTTP ' + response.status()); return response.json();
  };
  await api('create', {});
  let current = await api('data');
  for (let i = 0; i < 3; i++) current = await api('ops', { baseRev: current.rev, ops: [{ type: 'project.set', field: 'planTitle', value: 'History retention edit ' + i, baseRev: current.data.hub.entities['project:planTitle']?.rev || 0 }] });
  const entries = await api('history');
  if (entries.length !== 1 || entries[0].rev !== 1 || current.rev !== 4) throw Error(JSON.stringify({ entries, rev: current.rev }));
  await page.goto(base + 'pcf/proj-test-001/dwg-004');
  await page.locator('#pahub-hosted-actions').waitFor();
  await page.screenshot({ path: 'output/playwright/history-retention.png' });
  if (errors.length) throw Error(JSON.stringify(errors));
  return { pageerrors: 0, currentRev: current.rev, baselineRev: entries[0].rev, historyCount: entries.length };
}

