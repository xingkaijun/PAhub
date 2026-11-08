import type { ProjectComment } from '../types/comments';

export const REPORT_DISCIPLINES_PER_PAGE = 8;
export const REPORT_AGE_BANDS = ['0–7', '8–14', '15–30', '>30', 'Unknown'] as const;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function commentAge(row: ProjectComment, asOf: string): number | null {
  const created = Date.parse(row.createdAt || '');
  const end = Date.parse(asOf);
  if (!Number.isFinite(created) || !Number.isFinite(end) || created > end) return null;
  return Math.floor((end - created) / 86_400_000);
}

export function isClosedComment(row: ProjectComment): boolean {
  return row.status.trim().toLowerCase() === 'closed';
}

export function disciplineLabel(value: string): string {
  const name = value.trim();
  if (!name) return 'Unassigned';
  if (name.toLowerCase() === 'cargo handling system') return 'CHS';
  if (name.toLowerCase() === 'cargo containment system') return 'CCS';
  return name;
}

export function reportPercent(value: number, total: number): string {
  return total ? (value / total * 100).toFixed(1) + '%' : '—';
}

export interface ReportDiscipline {
  name: string;
  open: number;
  closed: number;
  total: number;
}

export interface ReportDrawing extends ReportDiscipline {
  id: string;
  title: string;
  discipline: string;
  olderThan30: number;
}

export function buildCommentReport(comments: ProjectComment[], asOf: string) {
  const seen = new Set<string>();
  const rows = comments.filter(row => {
    const key = JSON.stringify([row.drawingId, row.commentId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const disciplines = new Map<string, ReportDiscipline>();
  const drawings = new Map<string, ReportDrawing>();
  const ageing = REPORT_AGE_BANDS.map(band => ({ band, count: 0 }));
  let closed = 0;
  for (const row of rows) {
    const discipline = row.discipline.trim();
    const disc = disciplines.get(discipline) || { name: discipline, open: 0, closed: 0, total: 0 };
    const drawing = drawings.get(row.drawingId) || {
      id: row.drawingId, name: row.drawingNo, title: row.drawingTitle, discipline,
      open: 0, closed: 0, total: 0, olderThan30: 0,
    };
    disc.total++;
    drawing.total++;
    if (isClosedComment(row)) {
      closed++;
      disc.closed++;
      drawing.closed++;
    } else {
      disc.open++;
      drawing.open++;
      const age = commentAge(row, asOf);
      ageing[age === null ? 4 : age <= 7 ? 0 : age <= 14 ? 1 : age <= 30 ? 2 : 3].count++;
      if (age !== null && age > 30) drawing.olderThan30++;
    }
    disciplines.set(discipline, disc);
    drawings.set(row.drawingId, drawing);
  }
  const openRows = rows.filter(row => !isClosedComment(row));
  const priorityRows = [...openRows].sort((a, b) => {
    const ageA = commentAge(a, asOf), ageB = commentAge(b, asOf);
    return (ageB ?? -1) - (ageA ?? -1) || b.round - a.round
      || collator.compare(a.drawingNo, b.drawingNo) || a.number - b.number
      || collator.compare(a.commentId, b.commentId);
  });
  const topDrawings = [...drawings.values()].filter(row => row.open > 0)
    .sort((a, b) => b.open - a.open || b.olderThan30 - a.olderThan30 || collator.compare(a.name, b.name) || collator.compare(a.id, b.id))
    .slice(0, 10);
  const sortedDisciplines = [...disciplines.values()]
    .sort((a, b) => b.open - a.open || b.total - a.total || collator.compare(a.name, b.name));
  return {
    rows, openRows, total: rows.length, closed, open: openRows.length,
    disciplines: sortedDisciplines, ageing, topDrawings,
    olderThan30: ageing[3].count, unknownAge: ageing[4].count,
    drawingsWithOpen: [...drawings.values()].filter(row => row.open > 0).length,
    topOpen: topDrawings.reduce((sum, row) => sum + row.open, 0),
    priorityRows: priorityRows.slice(0, 6),
    overviewPages: Math.max(1, Math.ceil(sortedDisciplines.length / REPORT_DISCIPLINES_PER_PAGE)),
  };
}

export type CommentReport = ReturnType<typeof buildCommentReport>;

export type ReportSelection =
  | { kind: 'discipline'; value: string; label: string }
  | { kind: 'drawing'; value: string; label: string }
  | { kind: 'age'; value: string; label: string }
  | { kind: 'comment'; value: string; drawingId: string; label: string };

export function selectedReportComments(report: CommentReport, selection: ReportSelection, asOf: string): ProjectComment[] {
  return report.rows.filter(row => {
    if (selection.kind === 'discipline') return row.discipline.trim() === selection.value;
    if (selection.kind === 'drawing') return row.drawingId === selection.value && !isClosedComment(row);
    if (selection.kind === 'comment') return row.commentId === selection.value && row.drawingId === selection.drawingId;
    if (isClosedComment(row)) return false;
    const age = commentAge(row, asOf);
    const band = age === null ? 'Unknown' : age <= 7 ? '0–7' : age <= 14 ? '8–14' : age <= 30 ? '15–30' : '>30';
    return band === selection.value;
  });
}
