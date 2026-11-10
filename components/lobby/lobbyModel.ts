// Data model of the project lobby (Project Access Hall). Pure functions only.

export interface LobbyProjectInput {
  id: string;
  name: string;
  drawingCount: number;
  approvedCount: number;
  lastUpdated?: string | number | Date | null;
  locked?: boolean;
}

export type LobbyStatus = 'completed' | 'active' | 'ready';

export interface LobbyCard {
  id: string;
  name: string;
  /** Ship type or the most telling part of the name, e.g. VLEC. */
  code: string;
  /** Hull number when the name carries one, e.g. H2684. */
  hull: string;
  total: number;
  approved: number;
  completion: number;
  status: LobbyStatus;
  updated: string;
  locked: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function formatUpdated(value: LobbyProjectInput['lastUpdated']): string {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function splitProjectName(name: string): { code: string; hull: string } {
  const tokens = name.split(/[-_\s/]+/).filter(Boolean);
  const hullToken = tokens.find(t => /^H?\d{3,5}[A-Z]?$/i.test(t));
  const hull = hullToken ? hullToken.toUpperCase() : '';
  // Skip a short owner prefix such as PG, then take the next token (usually the ship type).
  const rest = tokens.filter(t => t !== hullToken);
  const typeToken = rest.length > 1 && rest[0].length <= 3 ? rest[1] : rest[0];
  const code = (typeToken || name.slice(0, 4) || '—').toUpperCase().slice(0, 6);
  return { code, hull };
}

export function toLobbyCards(projects: LobbyProjectInput[]): LobbyCard[] {
  return projects.map(p => {
    const total = Math.max(0, p.drawingCount || 0);
    const approved = Math.min(total, Math.max(0, p.approvedCount || 0));
    const completion = total > 0 ? Math.round((approved / total) * 100) : 0;
    const status: LobbyStatus = total === 0 ? 'ready' : completion === 100 ? 'completed' : 'active';
    const { code, hull } = splitProjectName(p.name);
    return {
      id: p.id, name: p.name, code, hull, total, approved, completion, status,
      updated: formatUpdated(p.lastUpdated), locked: !!p.locked,
    };
  });
}

export const STATUS_LABEL: Record<LobbyStatus, string> = {
  completed: 'Completed',
  active: 'Active',
  ready: 'Ready to Load',
};

export function lobbyTotals(cards: LobbyCard[]) {
  const drawings = cards.reduce((s, c) => s + c.total, 0);
  const approved = cards.reduce((s, c) => s + c.approved, 0);
  return {
    projects: cards.length,
    drawings,
    approved,
    completion: drawings > 0 ? Math.round((approved / drawings) * 100) : 0,
    active: cards.filter(c => c.status === 'active').length,
  };
}
