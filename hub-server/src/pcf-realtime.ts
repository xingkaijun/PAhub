import type { Actor } from './pcf-model.ts';

export type Presence = { clientId: string; clientName: string; entity: string | null; at: number };
export type HubEvent = { type: 'hello' | 'changed' | 'presence' | 'ping' | 'drawing-changed'; data: any; id?: number };
// Replace the bus AND presence store with shared adapters before running multiple processes.
export interface DrawingBroadcast {
  subscribe(key: string, listener: (event: HubEvent) => void): () => void;
  publish(key: string, event: HubEvent): void;
}
export class MemoryBroadcast implements DrawingBroadcast {
  private listeners = new Map<string, Set<(event: HubEvent) => void>>();
  subscribe(key: string, listener: (event: HubEvent) => void) {
    const set = this.listeners.get(key) || new Set(); set.add(listener); this.listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key); };
  }
  publish(key: string, event: HubEvent) { for (const listener of this.listeners.get(key) || []) listener(event); }
}
export class PcfRealtime {
  private people = new Map<string, Map<string, Presence>>();
  private connections = new Map<string, Map<string, Set<() => void>>>();
  private projectListeners = new Map<string, Set<(event: HubEvent) => void>>();
  private projectConnections = new Map<string, Set<() => void>>();
  private presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval>;
  private accessChecks = new Map<() => void, { project: string; authorized: () => boolean }>();
  recheckProject(project: string) { for(const [stop,check] of [...this.accessChecks]) if(check.project===project && !check.authorized()) stop(); }
  constructor(readonly bus: DrawingBroadcast = new MemoryBroadcast(), private now = Date.now) {
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
  }
  list(key: string) { this.sweep(); return [...(this.people.get(key)?.values() || [])]; }
  project(projectId: string) {
    this.sweep(); const drawings: Record<string, Presence[]> = {};
    for (const [key, people] of this.people) if (key.startsWith(projectId + '/')) drawings[key.slice(projectId.length + 1)] = [...people.values()];
    return { drawings };
  }
  private announce(key: string) { this.bus.publish(key, { type: 'presence', data: { online: [...(this.people.get(key)?.values() || [])] } }); }
  private projectPresence(projectId: string) {
    this.publishProject(projectId, { type: 'presence', data: this.projectCounts(projectId) });
  }
  private projectCounts(projectId: string) {
    const drawings: Record<string, number> = {};
    for (const [id, people] of Object.entries(this.project(projectId).drawings)) drawings[id] = people.length;
    return { drawings };
  }
  private publishProject(projectId: string, event: HubEvent) {
    for (const listener of this.projectListeners.get(projectId) || []) listener(event);
  }
  projectChanged(projectId: string, drawingId: string, fields: string[]) {
    this.publishProject(projectId, { type: 'drawing-changed', data: { drawingId, fields: [...new Set(fields)] } });
  }
  private scheduleProjectPresence(projectId: string) {
    if (this.presenceTimers.has(projectId)) return;
    const timer = setTimeout(() => { this.presenceTimers.delete(projectId); this.projectPresence(projectId); }, 200);
    timer.unref(); this.presenceTimers.set(projectId, timer);
  }
  projectStream(projectId: string, signal: AbortSignal, authorized = () => true) {
    const encoder = new TextEncoder(); let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const send = (event: HubEvent) => { if (!authorized()) { stop(); return; } if (!closed) controller.enqueue(encoder.encode('event: ' + event.type + '\ndata: ' + JSON.stringify(event.data) + '\n\n')); };
        const listeners = this.projectListeners.get(projectId) || new Set(); listeners.add(send); this.projectListeners.set(projectId, listeners);
        const stops = this.projectConnections.get(projectId) || new Set<() => void>(); this.projectConnections.set(projectId, stops);
        const ping = setInterval(() => send({ type: 'ping', data: { at: this.now() } }), 25000); ping.unref();
        stop = () => {
          if (closed) return; closed = true; this.accessChecks.delete(stop); clearInterval(ping); listeners.delete(send);
          if (!listeners.size) this.projectListeners.delete(projectId);
          stops.delete(stop); if (!stops.size) this.projectConnections.delete(projectId);
          signal.removeEventListener('abort', stop); controller.close();
        };
        stops.add(stop);this.accessChecks.set(stop,{project:projectId,authorized});
        send({ type: 'presence', data: this.projectCounts(projectId) });
        signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      },
      cancel: () => stop(),
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' } });
  }
  update(key: string, actor: Actor, entity: string | null, leave = false) {
    const people = this.people.get(key) || new Map();
    if (leave) people.delete(actor.clientId);
    else people.set(actor.clientId, { clientId: actor.clientId, clientName: actor.clientName || 'Editor-' + actor.clientId.slice(0, 4), entity, at: this.now() });
    if (people.size) this.people.set(key, people); else this.people.delete(key);
    this.announce(key);
    this.scheduleProjectPresence(key.slice(0, key.indexOf('/')));
  }
  sweep() {
    // Remove the check before closing: stop() can publish presence recursively.
    for(const [stop,check] of [...this.accessChecks])if(!check.authorized()){this.accessChecks.delete(stop);stop();}
    for (const [key, people] of this.people) {
      let changed = false;
      for (const [id, person] of people) if (this.now() - person.at >= 60000) { people.delete(id); changed = true; }
      if (!people.size) this.people.delete(key);
      if (changed) { this.announce(key); this.scheduleProjectPresence(key.slice(0, key.indexOf('/'))); }
    }
  }
  stream(key: string, actor: Actor, rev: number, fromRev: number, signal: AbortSignal, expires = Infinity, authorized = () => true) {
    const encoder = new TextEncoder(); let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const send = (event: HubEvent) => { if (!authorized() || this.now() >= expires) { stop(); return; } if (!closed) controller.enqueue(encoder.encode((event.id !== undefined ? 'id: ' + event.id + '\n' : '') + 'event: ' + event.type + '\ndata: ' + JSON.stringify(event.data) + '\n\n')); };
        const unsubscribe = this.bus.subscribe(key, send);
        const ping = setInterval(() => { if (this.now() >= expires) stop(); else send({ type: 'ping', data: { at: this.now() } }); }, 25000); ping.unref();
        const drawing = this.connections.get(key) || new Map(), sockets = drawing.get(actor.clientId) || new Set<() => void>();
        stop = () => {
          if (closed) return; closed = true; this.accessChecks.delete(stop); clearInterval(ping); unsubscribe(); signal.removeEventListener('abort', stop);
          sockets.delete(stop); if (!sockets.size) { drawing.delete(actor.clientId); this.update(key, actor, null, true); }
          if (!drawing.size) this.connections.delete(key);
          controller.close();
        };
        sockets.add(stop);this.accessChecks.set(stop,{project:key.slice(0,key.indexOf('/')),authorized}); drawing.set(actor.clientId, sockets); this.connections.set(key, drawing);
        send({ type: 'hello', id: rev, data: { rev, online: this.list(key), resync: fromRev !== rev } });
        this.update(key, actor, null);
        signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      }, cancel: () => stop(),
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer' } });
  }
  changed(key: string, result: any, actor: Actor, replace = false) {
    this.bus.publish(key, { type: 'changed', id: result.rev, data: { rev: result.rev, clientId: actor.clientId, clientName: actor.clientName, replace,
      entities: Object.entries(result.data.hub.entities).filter(([, clock]: any) => clock.rev === result.rev).map(([entity, clock]) => ({ entity, clock })), ops: result.applied || [] } });
    const slash = key.indexOf('/');
    if (slash > 0) this.projectChanged(key.slice(0, slash), key.slice(slash + 1), replace ? ['*'] : [...new Set<string>((result.applied || []).map((op: any) => String(op.entity || op.type || 'data')))]);
  }
  close() { clearInterval(this.timer); for (const timer of this.presenceTimers.values()) clearTimeout(timer); this.presenceTimers.clear(); for (const drawing of [...this.connections.values()]) for (const sockets of [...drawing.values()]) for (const stop of [...sockets]) stop(); for (const connections of [...this.projectConnections.values()]) for (const stop of [...connections]) stop(); }
}
