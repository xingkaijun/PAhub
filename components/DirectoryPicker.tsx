import React, { useEffect, useState } from 'react';
import { teamDirectory, type DirectoryPerson, type DirectoryResult } from '../services/api/teamApi';
import type { Reviewer } from '../types';
import {useStore} from '../store';

export function DirectoryPicker({ discipline = '', onSelect, label = 'Select reviewer', value, currentName, onClear }: { discipline?: string; onSelect: (person: Reviewer) => void; label?: string; value?: string; currentName?: string; onClear?: () => void }) {
  const projectId = useStore(state=>state.activeProjectId);
  const [result, setResult] = useState<DirectoryResult>();
  const [name, setName] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setResult(undefined);
    teamDirectory(discipline, controller.signal, projectId || undefined).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(() => { if (!controller.signal.aborted) setResult({ ok: false, fallback: true }); });
    return () => controller.abort();
  }, [discipline,projectId]);
  if (!result) return <p role="status" className="text-xs text-slate-500">Loading directory…</p>;
  if (result.ok) return <select aria-label={label} {...(value === undefined ? {defaultValue:''} : {value})} onChange={event => {
    const person: DirectoryPerson | undefined = result.users.find(user => user.id === event.target.value);
    if (person) onSelect({ id: person.id, name: person.name }); else if(onClear)onClear();
    if(value === undefined)event.target.value = '';
  }} className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-700">
    <option value="">{label}</option>{value && !result.users.some(user=>user.id===value) && <option value={value}>{currentName || value}</option>}{result.users.map(person => <option key={person.id} value={person.id}>{person.name}{person.title ? ' — ' + person.title : ''}</option>)}
  </select>;
  return <div className="space-y-2">{value !== undefined && <select aria-label={label} value={value} onChange={event=>{if(!event.target.value)onClear?.();}} className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm"><option value="">{label}</option>{value && <option value={value}>{currentName || value}</option>}</select>}<p role="status" className="text-xs text-amber-700">Directory unavailable, enter the name manually.</p><div className="flex gap-2">
    <input aria-label={label + ' manually'} placeholder="Reviewer name" value={name} onChange={event => setName(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-200 p-2 text-sm" />
    <button type="button" disabled={!name.trim()} onClick={() => { if (name.trim()) { onSelect({ id: 'manual-' + crypto.randomUUID(), name: name.trim() }); setName(''); } }} className="rounded-full bg-teal-700 px-3 text-xs font-bold text-white disabled:opacity-50">Add</button>
  </div></div>;
}
