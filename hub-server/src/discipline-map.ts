// Approved 2026-11-14. Free-text project disciplines are normalized here only.
export const DISCIPLINE_MAP: Readonly<Record<string, string>> = Object.freeze({
  hull: 'HULL', machinery: 'MACH', electrical: 'ELEC', outfitting: 'OUTFIT', accommodation: 'OUTFIT',
});
export function kjxDiscipline(value: string): string | undefined {
  return DISCIPLINE_MAP[value.replace(/\s+/g, '').toLowerCase()];
}
