export type ActorRow = { actorId?: string | null; actorName?: string | null };
export const actorLabel = (row: ActorRow) => row.actorId && row.actorName ? row.actorName : '—';
export function actorOptions(rows: ActorRow[]) {
  const people = new Map<string, string>();
  for (const row of rows) if (row.actorId) people.set(row.actorId, row.actorName || '—');
  return [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
export const filterActor = <T extends ActorRow>(rows: T[], actor: string) => actor ? rows.filter(row => row.actorId === actor) : rows;
export function actorExport<T extends ActorRow>(headers: string[], rows: T[], cells: (row: T) => string[], csv: boolean) {
  const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const line = (values: string[]) => csv ? values.map(quote).join(',') : values.join('\t\t');
  return [line([...headers, 'Actor']), ...rows.map(row => line([...cells(row), actorLabel(row)]))].join('\n');
}
