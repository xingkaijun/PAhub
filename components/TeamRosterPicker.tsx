import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { teamDirectory, type DirectoryResult } from '../services/api/teamApi';
import type { Reviewer } from '../types';
import { settingsStyles } from './settingsStyles';

export function TeamRosterPicker({ projectId, selected, directory, disabled, onAdd, onRemove }: {
  projectId?: string; selected: Reviewer[]; directory: boolean; disabled?: boolean;
  onAdd: (person: Reviewer) => void; onRemove: (person: Reviewer) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<DirectoryResult>();
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null);
  const panelId = useId(), headingId = useId();
  useEffect(() => {
    if (!directory || disabled) return;
    const controller = new AbortController(); setResult(undefined);
    teamDirectory('', controller.signal, projectId).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(() => { if (!controller.signal.aborted) setResult({ok:false, fallback:true}); });
    return () => controller.abort();
  }, [directory, projectId, retry, disabled]);
  useEffect(() => { setOpen(false); setQuery(''); }, [projectId, disabled]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const people = directory && result?.ok ? result.users : selected;
  const filter = query.trim().toLocaleLowerCase();
  const matches = people.filter(person => [person.name, 'title' in person ? person.title : '', 'disciplines' in person ? String(person.disciplines) : ''].join(' ').toLocaleLowerCase().includes(filter));
  const remove = async (person: Reviewer) => {
    if (busy || disabled) return;
    setBusy(true);
    try { await onRemove(person); } finally { setBusy(false); }
  };
  return <div ref={root} className="relative space-y-3" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" disabled={disabled || busy} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label="Select team members" className={settingsStyles.control + ' flex items-center justify-between gap-2 text-left'}
      onClick={() => setOpen(value => !value)}>
      <span>{selected.length} selected · Team members</span><ChevronDown size={14} className="shrink-0" />
    </button>
    <div className="flex flex-wrap gap-1.5" aria-label="Selected team members">
      {selected.map(person => <span key={person.id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal-100 bg-teal-50 px-2.5 py-1 text-[10px] font-black text-teal-800">
        <span className="truncate" title={person.name}>{person.name}</span>
        <button type="button" disabled={disabled || busy} aria-label={'Remove member ' + person.name} onClick={() => void remove(person)}
          className="rounded-full p-0.5 hover:bg-teal-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:opacity-40"><X size={12} /></button>
      </span>)}
      {!selected.length && <p className="text-[10px] font-bold text-slate-500">No members selected.</p>}
    </div>
    {open && <div id={panelId} role="dialog" aria-labelledby={headingId} aria-busy={busy}
      className="absolute inset-x-0 top-full mt-2 z-30 rounded-2xl border border-teal-200 bg-white p-3 shadow-xl">
      <h3 id={headingId} className={settingsStyles.label + ' mb-2'}>Team members</h3>
      <div className="relative"><Search size={12} className="absolute left-3 top-3 text-slate-400" />
        <input ref={search} aria-label="Search team members" value={query} onChange={event => setQuery(event.target.value)}
          className={settingsStyles.control + ' pl-8'} placeholder="Search name, discipline or title" />
      </div>
      <p className="my-2 text-[10px] text-slate-500">Space toggles a checkbox · Escape closes</p>
      {directory && !result && <p role="status" className="text-[10px] text-slate-500">Loading directory…</p>}
      {directory && result && !result.ok && <div role="status" className="text-[10px] text-amber-700">Directory unavailable. Existing members are retained.
        <button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 underline">Retry directory</button>
      </div>}
      <div className="max-h-56 overflow-y-auto space-y-1">
        {matches.map(person => {
          const checked = selected.some(member => member.id === person.id);
          return <label key={person.id} className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 hover:bg-teal-50 focus-within:ring-2 focus-within:ring-teal-500">
            <input type="checkbox" checked={checked} disabled={disabled || busy} aria-label={person.name}
              onChange={() => checked ? void remove(person) : onAdd({id:person.id, name:person.name})}
              className="h-4 w-4 shrink-0 accent-teal-700" />
            <span className="min-w-0"><span className="block text-[10px] font-black text-slate-700">{person.name}</span>
              {'disciplines' in person && <span className="block text-[9px] font-medium text-slate-500">{[person.title, person.disciplines.join(' / ')].filter(Boolean).join(' · ')}</span>}
            </span>
          </label>;
        })}
        {!matches.length && (!directory || result?.ok) && <p className="py-3 text-[10px] text-slate-500">No matching people.</p>}
      </div>
      <button type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }} className="mt-2 rounded-full border border-slate-200 px-3 py-1 text-[10px] font-black text-slate-600">Done</button>
    </div>}
  </div>;
}
