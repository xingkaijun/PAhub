// A different drawing, actor, date, event type or discontinuous count breaks the chain.
export function mergeContinuousComments<T extends {date:string; eventId?:number; drawingId:string; actorId?:string|null; eventType:string; detail:string; time:string; occurredAt:number; note:string}>(rows:T[]):T[] {
  const merged:T[]=[];
  for(const row of rows) {
    const previous=merged.at(-1);
    const start=previous?.detail.match(/Comments:\s*([\d/]+)\s*->/)?.[1];
    const previousEnd=previous?.detail.match(/->\s*([\d/]+)\s*$/)?.[1];
    const nextStart=row.detail.match(/Comments:\s*([\d/]+)\s*->/)?.[1];
    const end=row.detail.match(/->\s*([\d/]+)\s*$/)?.[1];
    if(previous && row.eventType==='Comments' && previous.eventType==='Comments' && row.actorId && row.actorId===previous.actorId && row.drawingId===previous.drawingId && row.date===previous.date && start && end && previousEnd===nextStart) {
      Object.assign(previous,{detail:'Comments: '+start+' -> '+end,time:row.time,occurredAt:row.occurredAt,note:row.note,eventId:row.eventId});
    } else merged.push({...row});
  }
  return merged;
}
