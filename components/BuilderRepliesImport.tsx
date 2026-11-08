import { builderRepliesApi, type BuilderReplyRow as ReplyRow, type BuilderReplyResult } from '../services/api/builderRepliesApi';
import { pcfApi } from '../services/api/pcfApi';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DownloadCloud, FileArchive, Upload, X } from 'lucide-react';
import { useStore } from '../store';
import { roundToLetters } from '../lib/rounds';

const label: Record<string,string> = { clean: 'Ready to apply', conflict: 'Conflict', unchanged: 'No changes', unmatched: 'Unable to match', 'owner-tampered': 'Owner changed', duplicate: 'Duplicate import', applied: 'Applied', failed: 'Failed', skipped: 'Skipped' };

export type BuilderRepliesImportHandle = { openWithFiles: (files: File[]) => void };

export const BuilderRepliesImport = forwardRef<BuilderRepliesImportHandle, { projectId: string }>(function BuilderRepliesImport({ projectId }, ref) {
  const loadProject = useStore(s => s.loadProject), refreshPcfPresence = useStore(s => s.refreshPcfPresence);
  const [open, setOpen] = useState(false), [files, setFiles] = useState<File[]>([]), [rows, setRows] = useState<ReplyRow[]>([]), [setId, setSetId] = useState(''), [busy, setBusy] = useState(false), [drag, setDrag] = useState(false), [message, setMessage] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const accepted = (file: File) => /\.(zip|html?)$/i.test(file.name);
  const openWithFiles = (incoming: File[]) => {
    const valid = incoming.filter(accepted);
    if (!valid.length) return;
    setRows([]); setSetId(''); setMessage(''); setFiles(valid); setOpen(true);
  };
  useImperativeHandle(ref, () => ({ openWithFiles }), [projectId]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    const background = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(dialog.current));
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    dialog.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not([hidden]),a[href],[tabindex="0"]') || []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'builder-reply-applied' || !event.data.fileId) return;
      setRows(old => old.map(row => row.id === event.data.fileId ? { ...row, category: 'applied' } : row));
      void loadProject(projectId); void refreshPcfPresence(projectId);
    };
    window.addEventListener('message', onMessage);
    const controller = new AbortController();
    builderRepliesApi.pending(projectId, controller.signal)
      .then((pending: ReplyRow[]) => { if (pending.length) setRows(old => [...pending, ...old.filter(row => !pending.some(item => item.id === row.id && item.importSetId === row.importSetId))]); }).catch(() => {});
    return () => { controller.abort(); window.removeEventListener('message', onMessage); };
  }, [open, projectId]);
  const add = (incoming: FileList | File[]) => setFiles(old => [...old, ...Array.from(incoming).filter(accepted)]);
  const preview = async () => {
    setBusy(true); setMessage('');
    try {
      const data = await builderRepliesApi.preview(projectId, files);
      setSetId(data.importSetId); setRows(data.files); setFiles([]);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };
  const applyClean = async () => {
    const groups = new Map<string,string[]>();
    for (const row of rows.filter(row => row.category === 'clean' || (row.category === 'owner-tampered' && (row.newReplies || 0) > 0))) { const id = row.importSetId || setId; groups.set(id, [...(groups.get(id) || []), row.id]); }
    if (!groups.size) return;
    setBusy(true); setMessage('');
    try {
      const allResults: BuilderReplyResult[] = [];
      for (const [importSetId, fileIds] of groups) {
        const data = await builderRepliesApi.apply(projectId, importSetId, fileIds, crypto.randomUUID());
        allResults.push(...data.results);
      }
      const results = new Map(allResults.map((r: any) => [r.id, r]));
      setRows(old => old.map(row => { const result: any = results.get(row.id); return result ? { ...row, category: result.category, conflicts: result.conflicts ?? row.conflicts, statusNote: result.status || row.statusNote, reason: result.reason || row.reason } : row; }));
      await loadProject(projectId); await refreshPcfPresence(projectId);
    } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
  };
  const skip = async (row: ReplyRow) => {
    try {
      await builderRepliesApi.skip(projectId, row.importSetId || setId, row.id); setRows(old => old.map(item => item.id === row.id ? { ...item, category: 'skipped' } : item));
    } catch (error: any) { setMessage(error.message); }
  };
  const resolve = async (row: ReplyRow) => {
    const tab = window.open('about:blank', '_blank'); if (!tab) return;
    const href = `/pcf/${encodeURIComponent(projectId)}/${encodeURIComponent(row.drawingId || '')}?builderReplySet=${encodeURIComponent(row.importSetId || setId)}&builderReplyFile=${encodeURIComponent(row.id)}`;
    try { await pcfApi.ensureSession(projectId, row.drawingId || ''); tab.location.href = href; }
    catch (error) { tab.close(); setMessage(String(error)); }
  };
  return <>
    <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-full border border-teal-100 bg-white px-4 py-2 text-[10px] font-black uppercase tracking-widest text-teal-700 shadow-sm hover:bg-teal-50"><DownloadCloud size={13}/> Import Builder Replies</button>
    {open && createPortal(<div className="fixed inset-0 z-[2147483000] flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4 backdrop-blur-[2px]" onClick={e => { if (e.target === e.currentTarget && !busy) setOpen(false); }}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="builder-replies-title" className="builder-replies-dialog flex max-h-[min(88dvh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-700"><div><h2 id="builder-replies-title" className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-slate-100">Import Builder Replies</h2><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Drop a ZIP or multiple PCF HTML files. Up to 50 files and 50 MB per import.</p></div><button aria-label="Close" onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"><X size={18}/></button></header>
        <div className="min-h-0 space-y-4 overflow-auto overscroll-contain p-6">
          {!rows.length && <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }} onClick={() => picker.current?.click()} className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center ${drag ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-slate-50'}`}><Upload className="mx-auto mb-2 text-teal-600"/><p className="text-sm font-bold text-slate-700">Drop builder reply files here</p><p className="mt-1 text-xs text-slate-400">ZIP archives or .html PCF replies</p><input ref={picker} hidden multiple type="file" accept=".zip,.html,text/html,application/zip" onChange={e => e.target.files && add(e.target.files)}/>{files.length > 0 && <p className="mt-3 text-xs font-bold text-teal-700">{files.length} file(s) selected</p>}</div>}
          {rows.length > 0 && <div className="overflow-x-auto rounded-xl border border-slate-100"><table className="w-full text-left text-xs"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500"><tr>{['File','Drawing','Round','New replies','Auto','Conflicts','Result','PAPC status',''].map(x => <th key={x} className="whitespace-nowrap px-3 py-2">{x}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t border-slate-100"><td className="max-w-48 truncate px-3 py-2" title={row.fileName}>{row.fileName}</td><td className="px-3 py-2">{row.drawingNo ? `${row.drawingNo} · ${row.title || ''}` : '—'}{row.tags?.length ? <div className="mt-1 flex flex-wrap gap-1">{row.tags.map(tag => <span key={tag} className={`rounded px-1.5 py-0.5 text-[10px] ${tag === 'Cost Affect' ? 'cost-affect-badge' : 'border border-slate-200 text-slate-500'}`}>{tag}</span>)}</div> : null}</td><td className="px-3 py-2">{row.round ?? '—'}</td><td className="px-3 py-2">{row.newReplies ?? '—'}</td><td className="px-3 py-2">{row.automatic ?? '—'}</td><td className="px-3 py-2">{row.conflicts ?? '—'}</td><td className="whitespace-nowrap px-3 py-2 font-bold">{label[row.category] || row.category}{row.ownerTampered ? <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">Owner changed</span> : null}{row.reason ? <span className="block max-w-52 whitespace-normal font-normal text-rose-600">{row.reason}</span> : null}</td><td className="whitespace-nowrap px-3 py-2">{row.statusNote || '—'}</td><td className="whitespace-nowrap px-3 py-2">{row.category === 'conflict' || (row.category === 'owner-tampered' && (row.conflicts || 0) > 0) ? <button className="mr-2 text-teal-700 underline" onClick={() => resolve(row)}>Resolve…</button> : null}{['conflict','owner-tampered','clean'].includes(row.category) ? <button className="text-slate-500 underline" onClick={() => skip(row)}>Skip</button> : null}</td></tr>)}</tbody></table></div>}
          {message && <p role="alert" className="text-sm text-rose-600">{message}</p>}
        </div>
        <footer className="flex justify-between border-t border-slate-100 px-6 py-4"><button onClick={() => setOpen(false)} className="rounded-full px-4 py-2 text-xs text-slate-500">Close</button><div className="flex gap-2">{rows.length === 0 ? <button disabled={busy || files.length === 0} onClick={preview} className="rounded-full bg-teal-700 px-5 py-2 text-xs font-bold text-white disabled:opacity-40"><FileArchive className="mr-1 inline" size={13}/>{busy ? 'Reading…' : 'Preview replies'}</button> : <><button onClick={() => { setRows([]); setSetId(''); }} className="rounded-full border border-slate-200 px-4 py-2 text-xs">New import</button><button disabled={busy || !rows.some(row => row.category === 'clean' || (row.category === 'owner-tampered' && (row.newReplies || 0) > 0))} onClick={applyClean} className="rounded-full bg-teal-700 px-5 py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? 'Applying…' : 'Apply all clean'}</button></>}</div></footer>
      </section>
    </div>, document.body)}
  </>;
});
