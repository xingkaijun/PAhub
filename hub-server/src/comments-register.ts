import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PcfStorage, parseHTML } from './pcf-storage.ts';
import { fail, safeId, roundNumber } from './pcf-model.ts';

export type CommentRow = {
  drawingId: string; drawingNo: string; drawingTitle: string; discipline: string; drawingStatus: string;
  commentId: string; number: number; round: number; status: string; tags: string[];
  ownerName: string; ownerDate: string; ownerComment: string; builderReply: string; builderReplyDate: string;
  createdAt: string; updatedAt: string; openDays: number | null; hasImages: boolean;
};
type DerivedComment = Omit<CommentRow, 'drawingId' | 'drawingNo' | 'drawingTitle' | 'discipline' | 'drawingStatus' | 'openDays'> & { search: string };
type Entry = { signature: string; comments: DerivedComment[] };
type SearchRow = CommentRow & { search: string };
type Options = { disciplines: string[]; drawingStatuses: string[]; commentStatuses: string[]; rounds: number[]; tags: string[] };
type Coverage = { totalActiveDrawings: number; parsedPcfDrawings: number; missingPcfDrawings: number; unreadablePcfDrawings: number };
type CommentsResult = { comments: CommentRow[]; statistics: ReturnType<typeof commentStatistics>; options: Options; coverage: Coverage; warnings: { drawingId: string; drawingNo: string; message: string }[]; generatedAt: string };
const text = (value: unknown) => typeof value === 'string' ? value : '';
const isClosed = (status: string) => status.toLowerCase() === 'closed';
const latestDate = (values: string[]) => values.filter(v => Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || '';

export function commentStatistics(comments: CommentRow[]) {
  const disciplines = new Map<string, { discipline: string; status: string; count: number }>();
  const rounds = new Map<number, number>(), statuses = new Map<string, number>();
  const drawings = new Map<string, { drawingId: string; drawingNo: string; open: number; closed: number; total: number }>();
  const ageing = ['0–7', '8–14', '15–30', '>30'].map(band => ({ band, count: 0 }));
  let closed = 0, unknownAge = 0;
  for (const row of comments) {
    const key = JSON.stringify([row.discipline, row.status]), group = disciplines.get(key) || { discipline: row.discipline, status: row.status, count: 0 }; group.count++; disciplines.set(key, group);
    rounds.set(row.round, (rounds.get(row.round) || 0) + 1); statuses.set(row.drawingStatus, (statuses.get(row.drawingStatus) || 0) + 1);
    const drawing = drawings.get(row.drawingId) || { drawingId: row.drawingId, drawingNo: row.drawingNo, open: 0, closed: 0, total: 0 }; drawing.total++;
    if (isClosed(row.status)) { closed++; drawing.closed++; } else {
      drawing.open++;
      const age = row.openDays;
      if (age === null || !Number.isFinite(age) || age < 0) unknownAge++;
      else ageing[age <= 7 ? 0 : age <= 14 ? 1 : age <= 30 ? 2 : 3].count++;
    }
    drawings.set(row.drawingId, drawing);
  }
  if (unknownAge) ageing.push({ band: 'Unknown', count: unknownAge });
  return {
    total: comments.length, open: comments.length - closed, closed,
    byDiscipline: [...disciplines.values()].sort((a, b) => a.discipline.localeCompare(b.discipline) || a.status.localeCompare(b.status)),
    byRound: [...rounds].sort(([a], [b]) => a - b).map(([round, count]) => ({ round, count })),
    byDrawingStatus: [...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([drawingStatus, count]) => ({ drawingStatus, count })),
    ageing, topDrawings: [...drawings.values()].sort((a, b) => b.open - a.open || b.closed - a.closed || a.drawingNo.localeCompare(b.drawingNo)).slice(0, 10),
  };
}

// Memory-only projections: never persist HTML bodies or derived text to SQLite or disk.
export class ProjectComments {
  private cache = new Map<string, Entry>();
  private projects = new Map<string, { signature: string; rows: SearchRow[]; options: Options; expires: number; results: Map<string, CommentsResult> }>();
  private serialized = new WeakMap<CommentsResult, { body: string; etag: string }>();
  constructor(readonly storage: PcfStorage) {}

  query(projectId: string, params = new URLSearchParams(), now = Date.now()) {
    const started = performance.now();
    let parsedFiles = 0;
    const p = safeId(projectId), db = this.storage.db;
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(p)) fail('Project not found', 404);
    const drawings = db.prepare('SELECT d.id,d.drawing_no,d.title,d.discipline,d.status,i.rev FROM drawings d LEFT JOIN pcf_index i ON i.project_id=d.project_id AND i.drawing_id=d.id WHERE d.project_id=? AND COALESCE(d._deleted,0)=0 ORDER BY d.drawing_no,d.id').all(p);
    const coverage: Coverage = { totalActiveDrawings: drawings.length, parsedPcfDrawings: 0, missingPcfDrawings: 0, unreadablePcfDrawings: 0 };
    const warnings: { drawingId: string; drawingNo: string; message: string }[] = [];
    const sources: { drawing: typeof drawings[number]; id: string; entry: Entry }[] = [];
    const signatures: string[] = [];
    const live = new Set<string>();
    for (const drawing of drawings) {
      const d = safeId(drawing.id), file = this.storage.file(p, d); live.add(file);
      let entry: Entry;
      try {
        const stat = statSync(file, { bigint: true });
        const signature = [stat.mtimeNs, stat.ctimeNs, stat.size, drawing.rev ?? ''].join(':');
        const prior = this.cache.get(file);
        if (prior?.signature === signature) entry = prior;
        else { parsedFiles++; entry = { signature, comments: this.derive(readFileSync(file, 'utf8')) }; }
        this.cache.delete(file); this.cache.set(file, entry);
        signatures.push(JSON.stringify([d, drawing.drawing_no, drawing.title, drawing.discipline, drawing.status, signature]));
      } catch (error: any) {
        this.cache.delete(file);
        if (error.code === 'ENOENT') {
          coverage.missingPcfDrawings++;
          signatures.push(JSON.stringify([d, 'missing']));
          continue;
        }
        coverage.unreadablePcfDrawings++;
        signatures.push(JSON.stringify([d, drawing.drawing_no, 'unreadable']));
        // Never expose paths, source fragments or credentials in warnings.
        warnings.push({ drawingId: d, drawingNo: text(drawing.drawing_no), message: 'PCF could not be read or parsed' });
        continue;
      }
      coverage.parsedPcfDrawings++;
      sources.push({ drawing, id: d, entry });
    }
    const scanned = performance.now();
    const signature = signatures.join('|'), priorProject = this.projects.get(p);
    let all: SearchRow[], options: Options;
    if (priorProject?.signature === signature && now < priorProject.expires) {
      all = priorProject.rows; options = priorProject.options;
    } else {
      all = [];
      let expires = Infinity;
      for (const { drawing, id: d, entry } of sources) for (const item of entry.comments) {
        const start = Date.parse(item.createdAt);
        const openDays = !isClosed(item.status) && Number.isFinite(start) && start <= now ? Math.floor((now - start) / 86400000) : null;
        // Future dates become known at creation time; known ages change at their next whole-day boundary.
        if (!isClosed(item.status) && Number.isFinite(start)) expires = Math.min(expires, openDays === null ? start : start + (openDays + 1) * 86400000);
        all.push({ ...item, drawingId: d, drawingNo: text(drawing.drawing_no), drawingTitle: text(drawing.title), discipline: text(drawing.discipline), drawingStatus: text(drawing.status), openDays, search: [drawing.drawing_no, drawing.title, drawing.discipline, drawing.status, item.search].join('\n').toLocaleLowerCase() });
      }
      const unique = (items: string[]) => [...new Set(items)].sort((a, b) => a.localeCompare(b));
      options = { disciplines: unique(all.map(r => r.discipline)), drawingStatuses: unique(all.map(r => r.drawingStatus)), commentStatuses: unique(all.map(r => r.status)), rounds: [...new Set(all.map(r => r.round))].sort((a, b) => a - b), tags: unique(all.flatMap(r => r.tags)) };
      this.projects.delete(p); this.projects.set(p, { signature, rows: all, options, expires, results: new Map() });
      while (this.projects.size > 6) this.projects.delete(this.projects.keys().next().value!);
    }
    // Drop removed files/drawings and bound cross-project memory use (LRU).
    const projectPath = this.storage.file(p, '').slice(0, -5);
    for (const file of this.cache.keys()) if (file.startsWith(projectPath) && !live.has(file)) this.cache.delete(file);
    while (this.cache.size > 3000) this.cache.delete(this.cache.keys().next().value!);
    const snapshot = this.projects.get(p)!;
    const keyParams = new URLSearchParams(params); keyParams.sort();
    const key = keyParams.toString(), cached = snapshot.results.get(key);
    if (cached) {
      if (process.env.PAHUB_COMMENTS_PROFILE === '1') console.info('Comments profile', { parsedFiles, scanMs: +(scanned - started).toFixed(2), queryMs: +(performance.now() - started).toFixed(2), resultHit: true });
      return cached;
    }
    const selections = new Map(['discipline', 'drawingStatus', 'commentStatus', 'round', 'tag'].map(key => [key, params.getAll(key).filter(Boolean)]));
    const values = (key: string) => selections.get(key)!;
    const matches = (key: string, value: string) => !values(key).length || values(key).includes(value);
    const rounds = values('round').map(value => {
      if (!/^(?:[A-Za-z]{1,3}|[1-9]\d{0,3})$/.test(value)) fail('Invalid round filter');
      return roundNumber(value);
    });
    const older = params.get('openOlderThanDays');
    if (older !== null && older !== '' && (!/^\d+$/.test(older) || !Number.isSafeInteger(Number(older)))) fail('Invalid openOlderThanDays filter');
    const q = (params.get('q') || '').trim().toLocaleLowerCase();
    const comments = all.filter(row => matches('discipline', row.discipline) && matches('drawingStatus', row.drawingStatus) && matches('commentStatus', row.status) && (!rounds.length || rounds.includes(row.round)) && (!values('tag').length || values('tag').some(tag => row.tags.includes(tag))) && (!q || row.search.includes(q)) && (!older || row.openDays !== null && row.openDays > Number(older))).map(({ search: _search, ...row }) => row);
    const result = { comments, statistics: commentStatistics(comments), options, coverage, warnings, generatedAt: new Date(now).toISOString() };
    snapshot.results.set(key, result);
    while (snapshot.results.size > 16) snapshot.results.delete(snapshot.results.keys().next().value!);
    if (process.env.PAHUB_COMMENTS_PROFILE === '1') console.info('Comments profile', { parsedFiles, scanMs: +(scanned - started).toFixed(2), queryMs: +(performance.now() - started).toFixed(2), resultHit: false });
    return result;
  }

  json(result: CommentsResult) {
    const prior = this.serialized.get(result);
    if (prior) return prior;
    const started = performance.now(), body = JSON.stringify(result);
    const payload = { body, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' };
    this.serialized.set(result, payload);
    if (process.env.PAHUB_COMMENTS_PROFILE === '1') console.info('Comments serialization', { ms: +(performance.now() - started).toFixed(2), bytes: Buffer.byteLength(body) });
    return payload;
  }

  private derive(html: string): DerivedComment[] {
    const data = parseHTML(html);
    if (data.schemaVersion !== '1.0' || !data.project || !Array.isArray(data.comments) || !Number.isSafeInteger(data.hub?.rev) || data.hub.rev < 1) fail('Invalid stored PCF document');
    const tombstones = new Set((data.hub.tombstones || []).map((t: any) => t.id));
    const ids = new Set<string>();
    return data.comments.filter((c: any) => !tombstones.has(c.id)).map((c: any) => {
      safeId(c.id);
      if (ids.has(c.id) || !Array.isArray(c.rounds) || typeof c.status !== 'string' || !Number.isFinite(c.number) || c.tags && (!Array.isArray(c.tags) || c.tags.some((t: unknown) => typeof t !== 'string'))) fail('Invalid stored PCF comment');
      ids.add(c.id);
      const rounds = c.rounds.filter((r: any) => !tombstones.has(r.id)).sort((a: any, b: any) => b.number - a.number);
      for (const r of rounds) {
        if (!Number.isInteger(r.number) || r.number < 1 || !r.owner || !r.reply || typeof r.owner.text !== 'string' || typeof r.reply.text !== 'string' || !Array.isArray(r.owner.images) || !Array.isArray(r.reply.images)) fail('Invalid stored PCF round');
      }
      const owner = rounds.find((r: any) => r.owner.text.trim() || r.owner.images.length);
      const reply = rounds.find((r: any) => r.reply.text.trim() || r.reply.images.length);
      const register = (r: any) => (data.roundRegister || []).find((row: any) => row.round === r?.number);
      const number = rounds[0]?.number || Number(data.project.currentRound) || 1;
      return {
        commentId: c.id, number: c.number, round: number, status: c.status, tags: c.tags || [],
        ownerName: text(owner?.initiator), ownerDate: text(register(owner)?.ownerDate) || text(owner?.createdAt) || text(c.createdAt),
        ownerComment: text(owner?.owner.text), builderReply: Array.from(text(reply?.reply.text)).slice(0, 200).join(''),
        builderReplyDate: reply ? text(register(reply)?.replyDate) || text(data.hub.entities?.['round:' + reply.id + ':reply']?.at) || text(reply.updatedAt) : '',
        updatedAt: latestDate([text(c.updatedAt), ...rounds.map((r: any) => text(r.updatedAt))]) || text(data.updatedAt),
        createdAt: text(c.createdAt),
        hasImages: rounds.some((r: any) => r.owner.images.length || r.reply.images.length),
        search: [c.number, number, c.status, ...(c.tags || []), ...rounds.flatMap((r: any) => [r.owner.text, r.reply.text, r.initiator, r.responder])].join('\n').toLocaleLowerCase(),
      };
    });
  }
}
