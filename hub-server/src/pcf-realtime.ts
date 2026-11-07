import type { Actor } from './pcf-model.ts';

export type Presence = { clientId: string; clientName: string; entity: string | null; at: number };
export type HubEvent = { type: 'hello' | 'changed' | 'presence' | 'ping'; data: any; id?: number };
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
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly bus: DrawingBroadcast = new MemoryBroadcast(), private now = Date.now) {
    this.timer = setInterval(() => this.sweep(), 5000); this.timer.unref();
  }
  list(key: string) { this.sweep(); return [...(this.people.get(key)?.values() || [])]; }
  project(projectId: string) {
    this.sweep(); const drawings: Record<string, Presence[]> = {};
    for (const [key, people] of this.people) if (key.startsWith(projectId + '/')) drawings[key.slice(projectId.length + 1)] = [...people.values()];
    return { drawings };
  }
  private announce(key: string) { this.bus.publish(key, { type: 'presence', data: { online: [...(this.people.get(key)?.values() || [])] } }); }
  update(key: string, actor: Actor, entity: string | null, leave = false) {
    const people = this.people.get(key) || new Map();
    if (leave) people.delete(actor.clientId);
    else people.set(actor.clientId, { clientId: actor.clientId, clientName: actor.clientName || '编辑者-' + actor.clientId.slice(0, 4), entity, at: this.now() });
    if (people.size) this.people.set(key, people); else this.people.delete(key);
    this.announce(key);
  }
  sweep() {
    for (const [key, people] of this.people) {
      let changed = false;
      for (const [id, person] of people) if (this.now() - person.at >= 60000) { people.delete(id); changed = true; }
      if (!people.size) this.people.delete(key);
      if (changed) this.announce(key);
    }
  }
  stream(key: string, actor: Actor, rev: number, fromRev: number, signal: AbortSignal, expires = Infinity) {
    const encoder = new TextEncoder(); let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const send = (event: HubEvent) => { if (!closed) controller.enqueue(encoder.encode((event.id !== undefined ? 'id: ' + event.id + '\n' : '') + 'event: ' + event.type + '\ndata: ' + JSON.stringify(event.data) + '\n\n')); };
        const unsubscribe = this.bus.subscribe(key, send);
        const ping = setInterval(() => { if (this.now() >= expires) stop(); else send({ type: 'ping', data: { at: this.now() } }); }, 25000); ping.unref();
        const drawing = this.connections.get(key) || new Map(), sockets = drawing.get(actor.clientId) || new Set<() => void>();
        stop = () => {
          if (closed) return; closed = true; clearInterval(ping); unsubscribe(); signal.removeEventListener('abort', stop);
          sockets.delete(stop); if (!sockets.size) { drawing.delete(actor.clientId); this.update(key, actor, null, true); }
          if (!drawing.size) this.connections.delete(key);
          controller.close();
        };
        sockets.add(stop); drawing.set(actor.clientId, sockets); this.connections.set(key, drawing);
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
  }
  close() { clearInterval(this.timer); for (const drawing of [...this.connections.values()]) for (const sockets of [...drawing.values()]) for (const stop of [...sockets]) stop(); }
}
