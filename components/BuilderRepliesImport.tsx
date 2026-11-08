import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DownloadCloud, FileArchive, Upload, X } from 'lucide-react';
import { useStore } from '../store';
import { roundToLetters } from '../lib/rounds';

type ReplyRow = { id: string; fileName: string; importSetId?: string; drawingId?: string; drawingNo?: string; title?: string; round?: number | string; newReplies?: number; automatic?: number; conflicts?: number; papcStatus?: string; statusNote?: string; category: string; reason?: string; ownerTampered?: boolean };
const label: Record<string,string> = { clean: 'Ready to apply', conflict: 'Conflict', unchanged: 'No changes', unmatched: 'Unable to match', 'owner-tampered': 'Owner changed', duplicate: 'Duplicate import', applied: 'Applied', failed: 'Failed', skipped: 'Skipped' };

export type BuilderRepliesImportHandle = { openWithFiles: (files: File[]) => void };

export const BuilderRepliesImport = forwardRef<BuilderRepliesImportHandle, { projectId: string }>(function BuilderRepliesImport({ projectId }, ref) {
  const loadProject = useStore(s => s.loadProject), refreshPcfPresence = useStore(s => s.refreshPcfPresence);
  const [open, setOpen] = useState(false), [files, setFiles] = useState<File[]>([]), [rows, setRows] = useState<ReplyRow[]>([]), [setId, setSetId] = useState(''), [busy, setBusy] = useState(false), [drag, setDrag] = useState(false), [message, setMessage] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const accepted = (file: File) => /\.(zip|html?)$/i.test(file.name);
  const openWithFiles = (incoming: File[]) => {
    const valid = incoming.filter(accepted);
    if (!valid.length) return;
    setRows([]); setSetId(''); setMessage(''); setFiles(valid); setOpen(true);
  };
  useImperativeHandle(ref, () => ({ openWithFiles }), [projectId]);
  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'builder-reply-applied' || !event.data.fileId) return;
      setRows(old => old.map(row => row.id === event.data.fileId ? { ...row, category: 'applied' } : row));
      void loadProject(projectId); void refreshPcfPresence(projectId);
    };
    window.addEventListener('message', onMessage);
    const token = import.meta.env.VITE_DATA_API_TOKEN?.trim();
    fetch(`/api/projects/${encodeURIComponent(projectId)}/builder-replies/pending`, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      .then(r => r.ok ? r.json() : []).then((pending: ReplyRow[]) => { if (pending.length) setRows(old => [...pending, ...old.filter(row => !pending.some(item => item.id === row.id && item.importSetId === row.importSetId))]); }).catch(() => {});
    return () => window.removeEventListener('message', onMessage);
  }, [open, projectId]);
  const headers = () => { const token = import.meta.env.VITE_DATA_API_TOKEN?.trim(); return token ? { Authorization: 'Bearer ' + token } : {}; };
  const add = (incoming: FileList | File[]) => setFiles(old => [...old, ...Array.from(incoming).filter(accepted)]);
  const preview = async () => {
    setBusy(true); setMessage('');
    try {
      const form = new FormData(); files.forEach(file => form.append('files', file));
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/builder-replies/preview`, { method: 'POST', headers: headers(), body: form });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Upload failed');
      setSetId(data.importSetId); setRows(data.files); setFiles([]);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };
  const applyClean = async () => {
    const groups = new Map<string,string[]>();
    for (const row of rows.filter(row => row.category === 'clean' || (row.category === 'owner-tampered' && (row.newReplies || 0) > 0))) { const id = row.importSetId || setId; groups.set(id, [...(groups.get(id) || []), row.id]); }
    if (!groups.size) return;
    setBusy(true); setMessage('');
    try {
      const allResults: any[] = [];
      for (const [importSetId, fileIds] of groups) {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/builder-replies/${encodeURIComponent(importSetId)}/apply`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds, batchId: crypto.randomUUID() }) });
        const data = await response.json(); if (!response.ok) throw Error(data.error || 'Apply failed'); allResults.push(...data.results);
      }
      const results = new Map(allResults.map((r: any) => [r.id, r]));
      setRows(old => old.map(row => { const result: any = results.get(row.id); return result ? { ...row, category: result.category, conflicts: result.conflicts ?? row.conflicts, statusNote: result.status || row.statusNote, reason: result.reason || row.reason } : row; }));
      await loadProject(projectId); await refreshPcfPresence(projectId);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };
  const skip = async (row: ReplyRow) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/builder-replies/${encodeURIComponent(row.importSetId || setId)}/skip`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: row.id }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error); setRows(old => old.map(item => item.id === row.id ? { ...item, category: 'skipped' } : item));
    } catch (error: any) { setMessage(error.message); }
  };
  const resolve = async (row: ReplyRow) => {
    const tab = window.open('about:blank', '_blank'); if (!tab) return;
    const href = `/pcf/${encodeURIComponent(projectId)}/${encodeURIComponent(row.drawingId || '')}?builderReplySet=${encodeURIComponent(row.importSetId || setId)}&builderReplyFile=${encodeURIComponent(row.id)}`;
    const token = import.meta.env.VITE_DATA_API_TOKEN?.trim();
    try { if (token) { const response = await fetch(`/api/pcf/${encodeURIComponent(projectId)}/${encodeURIComponent(row.drawingId || '')}/session`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); if (!response.ok) throw Error('PCF access failed'); } tab.location.href = href; }
    catch (error) { tab.close(); setMessage(String(error)); }
  };
  return <>
    <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-full border border-teal-100 bg-white px-4 py-2 text-[10px] font-black uppercase tracking-widest text-teal-700 shadow-sm hover:bg-teal-50"><DownloadCloud size={13}/> Import Builder Replies</button>
    {open && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4" onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <section className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-6 py-4"><div><h2 className="text-sm font-black uppercase tracking-widest text-slate-800">Import Builder Replies</h2><p className="mt-1 text-xs text-slate-400">Drop a ZIP or multiple PCF HTML files. Up to 50 files and 50 MB per import.</p></div><button aria-label="Close" onClick={() => setOpen(false)}><X size={18}/></button></header>
        <div className="space-y-4 overflow-auto p-6">
          {!rows.length && <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }} onClick={() => picker.current?.click()} className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center ${drag ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-slate-50'}`}><Upload className="mx-auto mb-2 text-teal-600"/><p className="text-sm font-bold text-slate-700">Drop builder reply files here</p><p className="mt-1 text-xs text-slate-400">ZIP archives or .html PCF replies</p><input ref={picker} hidden multiple type="file" accept=".zip,.html,text/html,application/zip" onChange={e => e.target.files && add(e.target.files)}/>{files.length > 0 && <p className="mt-3 text-xs font-bold text-teal-700">{files.length} file(s) selected</p>}</div>}
          {rows.length > 0 && <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500"><tr>{['File','Drawing','Round','New replies','Auto','Conflicts','Result','PAPC status',''].map(x => <th key={x} className="whitespace-nowrap px-3 py-2">{x}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t border-slate-100"><td className="max-w-48 truncate px-3 py-2" title={row.fileName}>{row.fileName}</td><td className="px-3 py-2">{row.drawingNo ? `${row.drawingNo} · ${row.title || ''}` : '—'}</td><td className="px-3 py-2">{row.round ?? '—'}</td><td className="px-3 py-2">{row.newReplies ?? '—'}</td><td className="px-3 py-2">{row.automatic ?? '—'}</td><td className="px-3 py-2">{row.conflicts ?? '—'}</td><td className="whitespace-nowrap px-3 py-2 font-bold">{label[row.category] || row.category}{row.ownerTampered ? <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">Owner changed</span> : null}{row.reason ? <span className="block max-w-52 whitespace-normal font-normal text-rose-600">{row.reason}</span> : null}</td><td className="whitespace-nowrap px-3 py-2">{row.statusNote || '—'}</td><td className="whitespace-nowrap px-3 py-2">{row.category === 'conflict' || (row.category === 'owner-tampered' && (row.conflicts || 0) > 0) ? <button className="mr-2 text-teal-700 underline" onClick={() => resolve(row)}>Resolve…</button> : null}{['conflict','owner-tampered','clean'].includes(row.category) ? <button className="text-slate-500 underline" onClick={() => skip(row)}>Skip</button> : null}</td></tr>)}</tbody></table></div>}
          {message && <p role="alert" className="text-sm text-rose-600">{message}</p>}
        </div>
        <footer className="flex justify-between border-t border-slate-100 px-6 py-4"><button onClick={() => setOpen(false)} className="rounded-full px-4 py-2 text-xs text-slate-500">Close</button><div className="flex gap-2">{rows.length === 0 ? <button disabled={busy || files.length === 0} onClick={preview} className="rounded-full bg-teal-700 px-5 py-2 text-xs font-bold text-white disabled:opacity-40"><FileArchive className="mr-1 inline" size={13}/>{busy ? 'Reading…' : 'Preview replies'}</button> : <><button onClick={() => { setRows([]); setSetId(''); }} className="rounded-full border border-slate-200 px-4 py-2 text-xs">New import</button><button disabled={busy || !rows.some(row => row.category === 'clean' || (row.category === 'owner-tampered' && (row.newReplies || 0) > 0))} onClick={applyClean} className="rounded-full bg-teal-700 px-5 py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? 'Applying…' : 'Apply all clean'}</button></>}</div></footer>
      </section>
    </div>}
  </>;
});
