import { randomUUID } from 'node:crypto';
import { lettersToRound, roundToLetters } from '../../lib/rounds.ts';
import { countOpen, reconcileApproval, roundCleanupPlan, pruneRounds, cleanupLegacyImport, nextCommentNumber } from './pcf-v26.ts';
export { countOpen, reconcileApproval, roundCleanupPlan, pruneRounds, cleanupLegacyImport, nextCommentNumber } from './pcf-v26.ts';
export type PcfData = Record<string, any>;
export type Op = { type: string; baseRev?: number; [key: string]: any };
export type Actor = { clientId: string; clientName: string; ip: string };
export type RequestActor = { sub: string; name: string; initiators?: Record<string, { id: string; name: string }> };
export const projectFields = ['name', 'planNo', 'planTitle', 'revision', 'folder', 'approval', 'currentRound'];
export const registerFields = ['revision', 'ownerRef', 'ownerDate', 'replyRef', 'replyDate'];
export function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('Invalid identifier');
  return value;
}
export const blankContent = () => ({ text: '', html: '', fill: '', images: [] });
export const roundLabel = (n: number): string => roundToLetters(n);
export function roundNumber(value: unknown): number {
  const s = String(value || 'A').toUpperCase();
  if (/^[A-Z]{1,3}$/.test(s)) return lettersToRound(s);
  return /^[1-9]\d{0,3}$/.test(s) ? Number(s) : 1;
}
export function ensureRound(d: PcfData, n: number) {
  let r = d.roundRegister.find((x: any) => x.round === n);
  if (!r) { r = { id: randomUUID(), round: n, revision: d.project.revision || '', ownerRef: '', ownerDate: '', replyRef: '', replyDate: '' }; d.roundRegister.push(r); }
  return r;
}
export function renumber(d: PcfData) {
  d.comments.sort((a: any, b: any) => a.number - b.number || String(a.createdAt).localeCompare(String(b.createdAt)));
  d.comments.forEach((c: any, i: number) => c.number = i + 1); d.nextCommentNumber = d.comments.length + 1;
  for (const t of d.deleted) if (t.type === 'round') {
    const c = d.comments.find((x: any) => x.id === t.parentId); if (c) t.parentNumber = c.number;
  }
}
export function reconcile(d: PcfData) { reconcileApproval(d); }

export function cleanContent(value: any) {
  if (!value || typeof value.text !== 'string' || typeof value.html !== 'string' || !Array.isArray(value.images)) fail('Invalid content');
  // A restricted formatting grammar, not a browser DOM. Attributes outside style are discarded.
  const html = value.html.replace(/<[^>]*>/g, (tag: string) => {
    if (/^<\/(?:b|strong|i|em|u|s|strike|span|font|br|div|p)\s*>$/i.test(tag)) return tag;
    const m = tag.match(/^<(b|strong|i|em|u|s|strike|span|font|br|div|p)\b([^>]*)>$/i); if (!m) return '';
    const attr = m[2].match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i); const style = (attr?.[2] || attr?.[3] || '').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
    const safe = style.split(';').filter((p: string) => /^\s*(font-weight|font-style|text-decoration(?:-line)?|font-family|color)\s*:\s*[A-Za-z0-9#(),.% ,"'-]+\s*$/.test(p)).join(';');
    return '<' + m[1] + (safe ? ' style="' + safe.replace(/"/g, '&quot;') + '"' : '') + '>';
  });
  const images = value.images.map((im: any) => {
    safeId(im.id);
    // Stored images are content-addressed references (pcf-images.ts); offline copies and new uploads carry data URLs.
    if (im.data === undefined && typeof im.hash === 'string') {
      if (!/^[a-f0-9]{64}$/.test(im.hash)) fail('Invalid image');
      return { id: im.id, name: String(im.name || ''), mime: String(im.mime || ''), hash: im.hash, width: Number(im.width) || 0, height: Number(im.height) || 0 };
    }
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]*$/.test(im.data || '')) fail('Invalid image');
    return { id: im.id, name: String(im.name || ''), mime: String(im.mime || ''), data: im.data, width: Number(im.width) || 0, height: Number(im.height) || 0 };
  });
  return { text: value.text, html, fill: /^#[a-f0-9]{6}$/i.test(value.fill || '') ? value.fill : '', images };
}
export function initData(d: PcfData) {
  if (d.schemaVersion !== '1.0' || typeof d.documentId !== 'string' || !d.project || !Array.isArray(d.comments)) fail('Invalid PCF document');
  d.deleted ??= []; d.roundRegister ??= []; d.circulation ??= []; d.approvalHistory ??= []; d.settings ??= { fontSize: 15, autoSaveSeconds: 60 };
  d.hub ??= { rev: 0, entities: {} }; d.hub.entities ??= {}; d.hub.tombstones ??= []; d.project.currentRound = Number(d.project.currentRound) || 1;
  const ids = new Set<string>();
  for (const c of d.comments) {
    safeId(c.id); if (ids.has(c.id)) fail('Duplicate comment ID'); ids.add(c.id);
    if (!Array.isArray(c.rounds) || !['open', 'closed'].includes(c.status)) fail('Invalid comment'); c.tags ??= []; c.page ??= '';
    for (const r of c.rounds) {
      safeId(r.id); if (ids.has(r.id)) fail('Duplicate round ID'); ids.add(r.id);
      for (const side of ['owner', 'reply']) r[side] = cleanContent(r[side]);
    }
  }
  ensureRound(d, d.project.currentRound); for (const c of d.comments) for (const r of c.rounds) ensureRound(d, r.number);
  renumber(d); reconcile(d); return d;
}
export function entity(d: PcfData, key: string) { return d.hub.entities[key] || { rev: 0, clientId: '', clientName: '', at: '' }; }
export function opKey(op: Op): string {
  switch (op.type) {
    case 'content.set': return 'round:' + op.roundId + ':' + op.side;
    case 'comment.status': return 'comment:' + op.commentId + ':status';
    case 'comment.meta': return 'comment:' + op.commentId + ':meta';
    case 'round.meta': return 'round:' + op.roundId + ':' + op.field;
    case 'project.set': return 'project:' + op.field;
    case 'settings.set': return 'settings:' + op.field;
    case 'roundRegister.set': return 'register:' + op.round;
    case 'record.restore': return 'deleted:' + op.deleteId;
    case 'history.set': return 'history:' + op.field;
    case 'rounds.addAll': return 'project:currentRound';
    case 'round.add': return op.baseRev === undefined ? '' : 'comment:' + op.commentId + ':record';
    case 'record.delete': return (op.roundId ? 'round:' + op.roundId : 'comment:' + op.commentId) + ':record';
    default: return '';
  }
}
export function summarize(op: Op) {
  const out: Record<string, unknown> = { type: op.type };
  const allowed: Record<string, string[]> = {
    'comment.add': ['id', 'roundIdNew'], 'round.add': ['commentId', 'id'],
    'content.set': ['commentId', 'roundId', 'side'], 'comment.status': ['commentId'],
    'comment.meta': ['commentId'], 'round.meta': ['commentId', 'roundId', 'field'],
    'project.set': ['field'], 'settings.set': ['field'], 'roundRegister.set': [], 'history.set': ['field'], 'rounds.addAll': ['number'],
    'record.delete': ['commentId', 'roundId', 'deleteId'], 'record.restore': ['deleteId'],
  };
  for (const field of allowed[op.type] || []) if (op[field] !== undefined) out[field] = op[field];
  if (op.type === 'roundRegister.set') out.round = op.round;
  if (op.type === 'comment.meta' || op.type === 'roundRegister.set') out.fields = Object.keys(op.value || {});
  return out;
}
export function applyOps(d: PcfData, ops: Op[], actor: Actor, rev: number, requestActor?: RequestActor) {
  // kjx IDs are server-owned; legacy retains its existing invalid-field rejection.
  if (requestActor) ops = ops.filter(op => !(op?.type === 'round.meta' && ['initiatorId', 'responderId'].includes(op.field)));
  // Validate identifiers/field names before mutation; extra body properties never enter logs.
  for (const op of ops) {
    if (!op || !['comment.add', 'round.add', 'content.set', 'comment.status', 'comment.meta', 'round.meta', 'project.set', 'settings.set', 'roundRegister.set', 'record.delete', 'record.restore', 'rounds.addAll', 'history.set'].includes(op.type)) fail('Unsupported op');
    const required: Record<string, string[]> = { 'comment.add': ['id'], 'round.add': ['commentId', 'id'], 'content.set': ['commentId', 'roundId'], 'comment.status': ['commentId'], 'comment.meta': ['commentId'], 'round.meta': ['commentId', 'roundId'], 'record.delete': ['commentId'], 'record.restore': ['deleteId'] };
    for (const k of required[op.type] || []) safeId(op[k]);
    for (const k of ['id', 'commentId', 'roundId', 'roundIdNew', 'deleteId']) if (op[k] !== undefined) safeId(op[k]);
    if (op.type === 'project.set' && !projectFields.includes(op.field)) fail('Invalid project field');
    if (op.type === 'round.meta' && !['initiator', 'responder', 'minHeight'].includes(op.field)) fail('Invalid round field');
    if (op.type === 'settings.set' && !['fontSize', 'autoSaveSeconds', 'theme', 'participantDefaults'].includes(op.field)) fail('Invalid settings field');
    if (op.type === 'content.set' && !['owner', 'reply'].includes(op.side)) fail('Invalid side');
    if (opKey(op) && (!Number.isSafeInteger(op.baseRev) || op.baseRev! < 0)) fail('Entity baseRev required');
  }
  const initialClocks = structuredClone(d.hub.entities);
  const suppliedApproval = ops.some(op => op.type === 'history.set' && op.field === 'approvalHistory');
  d.hub.tombstones ??= [];
  let structuralConflict = false;
  const applied: any[] = [], conflicts: any[] = [], assigned: Record<string, any> = {};
  const stamp = (key: string) => d.hub.entities[key] = { rev, clientId: actor.clientId, clientName: actor.clientName, at: new Date().toISOString() };
  const exists = (id: string) => d.hub.tombstones.some((t: any) => t.id === id) || d.comments.some((c: any) => c.id === id || c.rounds.some((r: any) => r.id === id)) || d.deleted.some((t: any) => t.id === id || t.data.id === id || t.data.rounds?.some((r: any) => r.id === id));
  for (const op of ops) {
    if (!op || typeof op.type !== 'string') fail('Invalid op');
    let c = d.comments.find((x: any) => x.id === op.commentId), r = c?.rounds.find((x: any) => x.id === op.roundId);
    const key = opKey(op), current = initialClocks[key] || { rev: 0, clientId: '', clientName: '', at: '' };
    const conflict = (reason: string, value: any, who = current) => { if (['record.delete','round.add','rounds.addAll','comment.add'].includes(op.type)) structuralConflict = true; return conflicts.push({ op: summarize(op), entity: key, reason, server: value ?? null, entityRev: who.rev, updatedBy: { clientId: who.clientId, clientName: who.clientName, at: who.at }, commentNumber: c?.number }); };
    if (structuralConflict && (['history.set','roundRegister.set'].includes(op.type) || op.type === 'project.set' && op.field === 'currentRound')) { conflict('Dependent structure changed', null); continue; }
    if (key && (!Number.isSafeInteger(op.baseRev) || op.baseRev !== current.rev)) {
      const value = op.type === 'content.set' ? r?.[op.side] : op.type === 'round.meta' ? r?.[op.field] : op.type === 'project.set' ? d.project[op.field] : op.type === 'settings.set' ? d.settings[op.field] : op.type === 'roundRegister.set' ? d.roundRegister.find((x: any) => x.round === op.round) : op.type === 'comment.status' ? c?.status : op.type === 'comment.meta' ? { page: c?.page, tags: c?.tags } : r || c || d.deleted.find((x: any) => x.id === op.deleteId);
      conflict('Entity changed', value); continue;
    }
    if (op.commentId && !c) { conflict('Comment deleted or missing', null, entity(d, 'comment:' + op.commentId + ':record')); continue; }
    if (op.roundId && !r) { conflict('Round deleted or missing', null, entity(d, 'round:' + op.roundId + ':record')); continue; }
    if (c?.status === 'closed' && !['comment.status', 'record.restore'].includes(op.type)) { conflict('Reopen this comment before editing', c.status, entity(d, 'comment:' + c.id + ':status')); continue; }
    switch (op.type) {
      case 'comment.add': {
        const id = safeId(op.id), roundId = safeId(op.roundIdNew || randomUUID());
        if (exists(id) || exists(roundId) || id === roundId) { conflict('ID already exists', null); continue; }
        const number = d.nextCommentNumber++, at = new Date().toISOString();
        c = { id, number, page: '', tags: [], status: 'open', createdAt: at, updatedAt: at, rounds: [] };
        r = { id: roundId, number: d.project.currentRound, initiator: requestActor?.name ?? '', ...(requestActor ? { initiatorId: requestActor.sub } : {}), responder: '', owner: blankContent(), reply: blankContent(), minHeight: 0, createdAt: at, updatedAt: at };
        c.rounds.push(r); d.comments.push(c); assigned[id] = { number, roundId, roundNumber: r.number }; break;
      }
      case 'round.add': {
        const id = safeId(op.id); if (exists(id)) { conflict('ID already exists', null); continue; }
        const used = [...c.rounds.map((x: any) => x.number), ...d.deleted.filter((t: any) => t.type === 'round' && t.parentId === c.id).map((t: any) => t.data.number)];
        const expected = Math.max(d.project.currentRound, Math.max(0, ...used) + 1);
        if (op.number !== undefined && op.number !== expected) { conflict('Round changed; refresh before adding', null); continue; }
        const number = expected, previous = c.rounds.at(-1), at = new Date().toISOString();
        r = { id, number, initiator: requestActor ? requestActor.name : previous?.initiator || '', ...(requestActor ? { initiatorId: requestActor.sub } : {}), responder: previous?.responder || '', owner: blankContent(), reply: blankContent(), minHeight: 0, createdAt: at, updatedAt: at };
        c.rounds.push(r); ensureRound(d, number); if (number > d.project.currentRound) { d.project.currentRound = number; stamp('project:currentRound'); }
        assigned[id] = { number }; break;
      }
      case 'rounds.addAll': {
        if (!Array.isArray(op.rounds) || !Number.isSafeInteger(op.number)) fail('Invalid bulk round');
        const open = d.comments.filter((x: any) => x.status === 'open');
        const expected = Math.max(d.project.currentRound, ...open.flatMap((x: any) => x.rounds.map((r: any) => r.number + 1)));
        const ids = op.rounds.map((x: any) => safeId(x.id));
        if (!open.length || op.number !== expected || op.rounds.length !== open.length || new Set(ids).size !== ids.length || new Set(op.rounds.map((x: any) => x.commentId)).size !== open.length || ids.some((id: string) => exists(id)) || open.some((x: any) => !op.rounds.some((y: any) => y.commentId === x.id && y.recordRev === (initialClocks['comment:' + x.id + ':record']?.rev || 0)))) {
          conflict('Open comments or rounds changed; add-all was not applied', null); continue;
        }
        const at = new Date().toISOString();
        for (const x of open) {
          const item = op.rounds.find((y: any) => y.commentId === x.id), previous = x.rounds.at(-1);
          x.rounds.push({ id: item.id, number: op.number, initiator: requestActor ? requestActor.name : previous?.initiator || '', ...(requestActor ? { initiatorId: requestActor.sub } : {}), responder: previous?.responder || '', owner: blankContent(), reply: blankContent(), minHeight: 0, createdAt: at, updatedAt: at });
          stamp('comment:' + x.id + ':record'); stamp('round:' + item.id + ':record'); x.updatedAt = at;
          assigned[item.id] = { number: op.number };
        }
        d.project.currentRound = op.number; ensureRound(d, op.number); break;
      }
      case 'history.set': {
        if (op.field === 'approvalHistory' && op.control?.lastOpen !== countOpen(d)) { conflict('Approval depends on concurrently changed comments', d.approvalHistory); continue; }
        if (!['circulation', 'approvalHistory'].includes(op.field) || !Array.isArray(op.value)) fail('Invalid history field');
        const ids = new Set<string>();
        for (const row of op.value) {
          safeId(row.id); if (ids.has(row.id)) fail('Duplicate history ID'); ids.add(row.id);
          if (row.round != null && (!Number.isSafeInteger(row.round) || row.round < 1)) fail('Invalid history round');
          const allowed = op.field === 'approvalHistory' ? ['id','at','round','from','to','source','reason'] : ['id','kind','round','revision','ownerRef','ownerDate','replyRef','replyDate','date','approval','note','from','to','updatedAt','rev'];
          if (Object.keys(row).some(k => !allowed.includes(k) || (k === 'rev' ? !Number.isSafeInteger(row[k]) : k !== 'round' && typeof row[k] !== 'string'))) fail('Invalid history value');
        }
        d[op.field] = structuredClone(op.value);
        if (op.field === 'approvalHistory') {
          if (!op.control || op.control.lastOpen !== countOpen(d) || !['auto','manual'].includes(op.control.source) || typeof op.control.reason !== 'string' || !['Not submitted','Under review','Approved','Approved with comments','Rejected'].includes(op.approval)) fail('Invalid approval control');
          d.approvalControl = structuredClone(op.control); d.project.approval = op.approval; stamp('project:approval');
        }
        break;
      }
      case 'content.set':
        if (!['owner', 'reply'].includes(op.side)) fail('Invalid side'); r[op.side] = cleanContent(op.value); r[op.side + 'Rev'] = rev; break;
      case 'comment.status': {
        if (!['open', 'closed'].includes(op.value)) fail('Invalid status');
        if (c.status === op.value) continue;
        c.status = op.value; c.statusRev = rev;
        if (op.value === 'closed') {
          const closer = requestActor ? requestActor.name : (actor.clientName.trim().slice(0, 100) || 'Editor-' + actor.clientId.slice(0, 4));
          if (closer) c.closedBy = closer; else delete c.closedBy;
          if (requestActor?.sub) c.closedById = requestActor.sub; else delete c.closedById;
        } else {
          delete c.closedBy;
          delete c.closedById;
        }
        break;
      }
      case 'comment.meta':
        if (!op.value || Object.keys(op.value).some(k => !['page', 'tags'].includes(k))) fail('Invalid comment field');
        if (op.value.page !== undefined) c.page = String(op.value.page);
        if (op.value.tags !== undefined) { if (!Array.isArray(op.value.tags) || op.value.tags.some((x: any) => typeof x !== 'string')) fail('Invalid tags'); c.tags = op.value.tags; }
        c.metaRev = rev; break;
      case 'round.meta': {
        if (!['initiator', 'responder', 'minHeight'].includes(op.field)) fail('Invalid round field');
        const person = op.field === 'initiator' ? requestActor?.initiators?.[op.initiatorId] : undefined;
        if (person) { r.initiatorId = person.id; r.initiator = person.name; }
        else r[op.field] = op.field === 'minHeight' ? Math.max(0, Math.min(3000, Number(op.value) || 0)) : String(op.value);
        break;
      }
      case 'project.set':
        if (!projectFields.includes(op.field)) fail('Invalid project field');
        if (op.field === 'currentRound' && (!Number.isSafeInteger(op.value) || op.value < 1 || op.value > 9999)) fail('Invalid round');
        if (op.field !== 'currentRound' && typeof op.value !== 'string') fail('Invalid project value');
        if (op.field === 'approval') {
          if (!['Approved', 'Approved with comments', 'Rejected', 'Under review', 'Not submitted'].includes(op.value)) fail('Invalid approval');
          d.approvalHistory.push({ id: randomUUID(), at: new Date().toISOString(), round: d.project.currentRound, from: d.project.approval, to: op.value, source: 'manual', reason: 'Manually selected' });
          Object.assign(d.approvalControl, { source: 'manual', reason: 'Manually selected' });
        }
        d.project[op.field] = op.value; ensureRound(d, d.project.currentRound); break;
      case 'roundRegister.set': {
        if (!Number.isSafeInteger(op.round) || op.round < 1 || op.round > 9999 || !op.value || Object.keys(op.value).some(k => !registerFields.includes(k))) fail('Invalid register');
        const row = ensureRound(d, op.round); for (const k of Object.keys(op.value)) { if (typeof op.value[k] !== 'string') fail('Invalid register value'); row[k] = op.value[k]; }
        row.rev = rev; row.updatedAt = new Date().toISOString(); if (!ops.some(x => x.type === 'history.set' && x.field === 'circulation')) { d.circulation.push({ ...row, id: randomUUID(), kind: 'round-registration', date: row.replyDate || row.ownerDate || '', approval: d.project.approval, note: 'Drawing-round dates registered' }); stamp('history:circulation'); } break;
      }
      case 'settings.set':
        if (op.field === 'theme') { if (!['light','dark'].includes(op.value)) fail('Invalid theme'); d.settings.theme = op.value; }
        else if (op.field === 'participantDefaults') { if (!op.value || Object.keys(op.value).some(k => !['initiator','responder'].includes(k) || typeof op.value[k] !== 'string')) fail('Invalid participants'); d.settings.participantDefaults = structuredClone(op.value); }
        else { if (!['fontSize', 'autoSaveSeconds'].includes(op.field) || !Number.isFinite(op.value)) fail('Invalid settings'); d.settings[op.field] = op.field === 'fontSize' ? Math.min(22, Math.max(12, op.value)) : Math.min(86400, Math.max(0, op.value)); }
        break;
      case 'record.delete': {
        if (r && (r.reply.text.replace(/[\s\u200b-\u200d\ufeff]/g, '') || r.reply.html.replace(/<[^>]*>/g, '').replace(/[\s\u200b-\u200d\ufeff]/g, '') || r.reply.images.length)) { conflict('A round with a reply cannot be deleted', r.reply); continue; }
        const remaining = d.comments.filter((x: any) => r || x.id !== c.id).map((x: any) => r && x.id === c.id ? { ...x, rounds: x.rounds.filter((y: any) => y.id !== r.id) } : x);
        const plan = roundCleanupPlan(d, remaining);
        const cleanup = { currentRound: plan.target, roundRegister: plan.affected.map((x: any) => x.id), circulation: plan.circulation.map((x: any) => x.id), approvalHistory: plan.approvals.map((x: any) => x.id) };
        if (op.cleanup && JSON.stringify(op.cleanup) !== JSON.stringify(cleanup)) { conflict('Deletion cascade changed; review deletion again', cleanup); continue; }
        if (op.cleanup) {
          const clocks = ['project:currentRound', 'history:circulation', 'history:approvalHistory', ...plan.affected.map((x: any) => 'register:' + x.round)];
          if (clocks.some(key => (initialClocks[key]?.rev || 0) > (op.documentRev ?? rev - 1))) { conflict('Deletion cascade was concurrently modified', cleanup); continue; }
        }
        const at = new Date().toISOString(), records = r ? [r] : [c, ...c.rounds];
        for (const record of records) { d.hub.tombstones.push({ id: record.id, type: record === c ? 'comment' : 'round', parentId: record === c ? null : c.id, clock: rev, at }); stamp((record === c ? 'comment:' : 'round:') + record.id + ':record'); }
        d.comments = remaining; d.deleted = []; pruneRounds(d, plan.target); renumber(d);
        stamp('project:currentRound'); stamp('history:circulation'); stamp('history:approvalHistory');
        for (const row of plan.affected) stamp('register:' + row.round);
        assigned[op.deleteId || (r?.id || c.id)] = { deleted: true }; break;
      }
      case 'record.restore': {
        const t = d.deleted.find((x: any) => x.id === op.deleteId); if (!t) { conflict('Deleted item missing', null); continue; }
        if (t.type === 'round') {
          c = d.comments.find((x: any) => x.id === t.parentId); if (!c || c.status === 'closed' || c.rounds.some((x: any) => x.number === t.data.number)) { conflict('Restore parent first, reopen it, or round number occupied', null); continue; }
          c.rounds.push(t.data); c.rounds.sort((a: any, b: any) => a.number - b.number); r = t.data;
        } else { c = t.data; const pos = Math.min(Math.max(1, Number(c.number) || d.comments.length + 1), d.comments.length + 1); d.comments.splice(pos - 1, 0, c); d.comments.forEach((x: any, i: number) => x.number = i + 1); }
        d.deleted = d.deleted.filter((x: any) => x.id !== t.id); renumber(d); break;
      }
      default: fail('Unsupported op: ' + op.type);
    }
    if (key) stamp(key);
    if (c) { c.rev = rev; c.updatedAt = new Date().toISOString(); stamp('comment:' + c.id + ':record'); }
    if (r) { r.rev = rev; r.updatedAt = new Date().toISOString(); stamp('round:' + r.id + ':record'); }
    const before = d.project.approval, history = d.approvalHistory.length; if (!suppliedApproval) reconcile(d); if (before !== d.project.approval) stamp('project:approval'); if (history !== d.approvalHistory.length) stamp('history:approvalHistory');
    applied.push({ ...summarize(op), entity: key, entityRev: key ? entity(d, key).rev : rev });
  }
  reconcile(d);
  return { applied, conflicts, assigned };
}
