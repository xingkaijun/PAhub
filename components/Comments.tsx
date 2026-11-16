import React, { useEffect, useMemo, useRef, useState } from 'react';
import { inventoryStyles, inventoryBadgeClass } from './inventoryStyles';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, ExternalLink, Image, MessageSquare, RefreshCw, Search } from 'lucide-react';
import { safeFormatDate } from '../lib/date';
import { roundToLetters } from '../lib/rounds';
import { commentsQuery, exportCommentsXlsx, fetchComments, subscribeToCommentChanges } from '../services/api/commentsApi';
import type { CommentsFilters, CommentsOptions, CommentsResponse, CommentsStreamState, ProjectComment } from '../types/comments';

const actionClass = inventoryStyles.action;
const inputClass = inventoryStyles.input;
const emptyOptions: CommentsOptions = { disciplines: [], drawingStatuses: [], commentStatuses: [], rounds: [], tags: [] };
const numberFormat = new Intl.NumberFormat('en');
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
type SortKey = 'drawingNo' | 'discipline' | 'drawingStatus' | 'number' | 'round' | 'status' | 'tags' | 'ownerName' | 'ownerComment' | 'builderReply' | 'updatedAt';
const columns: Array<{ key: SortKey; label: string; width: string }> = [
  { key: 'drawingNo', label: 'Drawing', width: 'min-w-[180px]' },
  { key: 'discipline', label: 'Discipline', width: 'min-w-[100px]' },
  { key: 'drawingStatus', label: 'Dwg Status', width: 'min-w-[112px]' },
  { key: 'number', label: 'No', width: 'min-w-[58px]' },
  { key: 'round', label: 'Round', width: 'min-w-[70px]' },
  { key: 'status', label: 'Status', width: 'min-w-[90px]' },
  { key: 'tags', label: 'Tags', width: 'min-w-[116px]' },
  { key: 'ownerName', label: 'Issued by', width: 'min-w-[110px]' },
  { key: 'ownerComment', label: 'Owner comment', width: 'min-w-[280px]' },
  { key: 'builderReply', label: 'Builder reply', width: 'min-w-[280px]' },
  { key: 'updatedAt', label: 'Updated', width: 'min-w-[126px]' },
];

function pcfLink(projectId: string, drawingId: string, commentId?: string): string {
  return '/pcf/' + encodeURIComponent(projectId) + '/' + encodeURIComponent(drawingId)
    + (commentId ? '#comment=' + encodeURIComponent(commentId) : '');
}

function sortValue(row: ProjectComment, key: SortKey): string | number | null {
  if (key === 'tags') return row.tags.join(', ');
  if (key === 'ownerName') return row.ownerName.trim() || null;
  if (key === 'updatedAt') {
    const value = Date.parse(row.updatedAt);
    return Number.isNaN(value) ? null : value;
  }
  return row[key];
}

const statusLabel = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Unknown';

const SelectFilter: React.FC<{
  label: string; value: string; values: Array<{ value: string; label: string }>; onChange: (value: string) => void;
}> = ({ label, value, values, onChange }) => (
  <label className="flex flex-col gap-1.5">
    <span className="text-[10px] font-bold text-slate-500">{label}</span>
    <select aria-label={label} className={inputClass} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">All</option>
      {value && !values.some(option => option.value === value) && <option value={value}>{label === 'Round' ? roundToLetters(value) || value : value}</option>}
      {values.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>
);

export const Comments: React.FC<{ projectId: string | null }> = ({ projectId }) => {
  const [draft, setDraft] = useState<CommentsFilters>({});
  const [applied, setApplied] = useState<CommentsFilters>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [result, setResult] = useState<{ data: CommentsResponse; filters: CommentsFilters } | null>(null);
  const [options, setOptions] = useState<CommentsOptions>(emptyOptions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [stale, setStale] = useState(false);
  const [streamState, setStreamState] = useState<CommentsStreamState>('connecting');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'updatedAt', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const changeVersion = useRef(0);
  const exportController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!projectId) return;
    return subscribeToCommentChanges(projectId, () => {
      changeVersion.current += 1;
      setStale(true);
    }, setStreamState);
  }, [projectId]);

  // Deliberately independent of the project store, SSE state, and drawing changes.
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const startedAtVersion = changeVersion.current;
    setLoading(true);
    setError(null);
    setExportError(null);
    void fetchComments(projectId, applied, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setResult({ data, filters: applied });
      setOptions(data.options);
      setPage(1);
      // An event arriving during a fetch must not be acknowledged by that fetch.
      setStale(changeVersion.current !== startedAtVersion);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load comments.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [projectId, applied, refreshVersion]);

  useEffect(() => () => { exportController.current?.abort(); }, [projectId]);

  const sortedRows = useMemo(() => {
    const rows = [...(result?.data.comments || [])];
    return rows.sort((a, b) => {
      const left = sortValue(a, sort.key), right = sortValue(b, sort.key);
      // Missing names and dates always sort last, in either direction.
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      const comparison = left === null && right === null ? 0
        : typeof left === 'number' && typeof right === 'number' ? left - right
        : collator.compare(String(left), String(right));
      return comparison * (sort.direction === 'asc' ? 1 : -1)
        || collator.compare(a.drawingNo, b.drawingNo) || a.number - b.number || collator.compare(a.commentId, b.commentId);
    });
  }, [result, sort]);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filtersChanged = commentsQuery(draft) !== commentsQuery(result?.filters || applied);
  const failedFilters = !!result && commentsQuery(applied) !== commentsQuery(result.filters);
  const data = result?.data;

  const updateDraft = (key: keyof CommentsFilters, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied(Object.fromEntries(new URLSearchParams(commentsQuery(draft))) as CommentsFilters);
  };
  const resetFilters = () => { setDraft({}); setApplied({}); };
  const sortBy = (key: SortKey) => {
    setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  };
  const download = async () => {
    if (!projectId || !result || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await exportCommentsXlsx(projectId, result.filters, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser time to consume the blob URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (!controller.signal.aborted) setExportError(reason instanceof Error ? reason.message : 'Unable to export comments.');
    } finally {
      exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  };

  if (!projectId) return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
      <MessageSquare size={28} className="text-teal-600" />
      <h2 className="text-lg font-bold text-slate-800">Comments</h2>
      <p className="text-sm text-slate-500">Select a project to view its comments register.</p>
    </div>
  );

  const stringOptions = (values: string[]) => values.map(value => ({ value, label: value }));
  return (
    <div className="comments-register-page flex min-w-0 flex-1 flex-col text-slate-700">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-7">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-black tracking-tight text-slate-900"><MessageSquare size={20} className="text-teal-600" />Comments</h2>
          <p className="mt-1 text-xs text-slate-500">Latest round per comment · Owner text from the latest nonempty entry.</p>
          <p className="mt-2 text-[10px] text-slate-400">
            Generated {data ? safeFormatDate(data.generatedAt, 'dd MMM yyyy HH:mm:ss') : '—'}
            <span className="mx-2">·</span>
            {streamState === 'live' ? 'Live change notices' : streamState === 'offline' ? 'Live notices unavailable — refresh manually' : 'Connecting live notices…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={actionClass + ' ' + inventoryStyles.secondary} disabled={loading} onClick={() => setRefreshVersion(value => value + 1)}>
            <RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />{loading ? 'Loading' : 'Refresh'}
          </button>
          <button type="button" className={actionClass + ' ' + inventoryStyles.primary} disabled={!result || loading || exporting || filtersChanged || failedFilters} onClick={() => void download()} title="Export all matching rows, not just this page. Apply filter changes first.">
            <Download size={13} />{exporting ? 'Exporting…' : 'Export Excel'}
          </button>
        </div>
      </header>

      {stale && <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-teal-100 bg-teal-50 px-5 py-3 text-xs text-teal-800 sm:px-7">
        <span>Project changes detected. The register is unchanged until you refresh.</span>
        <button type="button" disabled={loading} className={actionClass + ' border-teal-200 bg-white text-teal-700 hover:bg-teal-100'} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={12} />Refresh register</button>
      </div>}
      {(error || exportError) && <div role="alert" className="flex items-start gap-2 border-b border-rose-100 bg-rose-50 px-5 py-3 text-xs text-rose-800 sm:px-7">
        <AlertCircle size={15} className="mt-0.5 shrink-0" />
        <div>{error}{error && result && <span> Showing the previous successful results.</span>}{exportError && <p>{exportError}</p>}</div>
      </div>}

      <form onSubmit={applyFilters} className={inventoryStyles.filterBar}>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-bold text-slate-700">Filters</h3>
          <span className="text-[10px] text-slate-500">{filtersChanged ? 'Filters changed — apply to update the register.' : 'Filters and export use the loaded filters.'}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <SelectFilter label="Discipline" value={draft.discipline || ''} values={stringOptions(options.disciplines)} onChange={value => updateDraft('discipline', value)} />
          <SelectFilter label="Drawing status" value={draft.drawingStatus || ''} values={stringOptions(options.drawingStatuses)} onChange={value => updateDraft('drawingStatus', value)} />
          <SelectFilter label="Comment status" value={draft.commentStatus || ''} values={options.commentStatuses.map(value => ({ value, label: statusLabel(value) }))} onChange={value => updateDraft('commentStatus', value)} />
          <SelectFilter label="Round" value={String(draft.round ?? '')} values={options.rounds.map(value => ({ value: String(value), label: roundToLetters(value) }))} onChange={value => updateDraft('round', value)} />
          <SelectFilter label="Tag" value={draft.tag || ''} values={stringOptions(options.tags)} onChange={value => updateDraft('tag', value)} />
          <label className="flex flex-col gap-1.5"><span className="text-[10px] font-bold text-slate-500">Open older than (days)</span><input className={inputClass} type="number" min={0} step={1} placeholder="Any age" value={draft.openOlderThanDays ?? ''} onChange={event => updateDraft('openOlderThanDays', event.target.value)} /></label>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex min-w-[180px] flex-1 flex-col gap-1.5"><span className="text-[10px] font-bold text-slate-500">Search all round text</span><span className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-slate-400" /><input type="search" className={inputClass + ' pl-9'} value={draft.q || ''} placeholder="Drawing, comment or reply…" onChange={event => updateDraft('q', event.target.value)} /></span></label>
          <button type="submit" className={actionClass + ' border-teal-700 bg-teal-700 text-white hover:bg-teal-800'}>Apply filters</button>
          <button type="button" className={actionClass + ' border-slate-200 bg-white text-slate-500 hover:text-teal-700'} onClick={resetFilters}>Reset</button>
        </div>
      </form>

      {!!data?.warnings.length && <details className="border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs sm:px-7">
        <summary className="cursor-pointer font-semibold text-slate-600">{data.warnings.length} drawing {data.warnings.length === 1 ? 'warning' : 'warnings'} — some source data may be unavailable</summary>
        <ul className="mt-2 space-y-1 text-slate-500">{data.warnings.map((warning, index) => <li key={warning.drawingId + ':' + index}><a className="font-semibold text-teal-700 underline underline-offset-2" href={pcfLink(projectId, warning.drawingId)} target="_blank" rel="noopener noreferrer">{warning.drawingNo || warning.drawingId}</a>: {warning.message}</li>)}</ul>
      </details>}

      <section aria-label="Comments register" aria-busy={loading} className="flex min-h-[240px] min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 sm:px-7">
          <h3 className="text-xs font-bold text-slate-700">Comments register <span className="ml-2 font-normal text-slate-400">{numberFormat.format(sortedRows.length)} matching comments</span></h3>
          <span role="status" className="text-[10px] text-slate-400">{loading ? 'Loading register…' : 'Click a row to open its comment in a new PCF tab.'}</span>
        </div>
        <div className={'max-h-[max(28rem,calc(100dvh-10rem))] flex-none overflow-auto transition-opacity motion-reduce:transition-none ' + (loading && result ? 'opacity-50' : '')} tabIndex={0} role="region" aria-label="Scrollable comments table">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">Project comments, latest round per comment. Sort using column headings.</caption>
            <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-bold text-slate-500">
              <tr>{columns.map(column => <th key={column.key} scope="col" aria-sort={sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={'border-y border-slate-200 px-3 py-3 first:pl-5 ' + column.width}>
                <button type="button" className="flex w-full items-center gap-1.5 whitespace-nowrap text-left transition-colors hover:text-teal-700 focus-visible:outline-teal-500" onClick={() => sortBy(column.key)}>
                  {column.label}{sort.key !== column.key ? <ArrowUpDown size={11} className="text-slate-300" /> : sort.direction === 'asc' ? <ArrowUp size={11} className="text-teal-600" /> : <ArrowDown size={11} className="text-teal-600" />}
                </button>
              </th>)}</tr>
            </thead>
            <tbody className={inventoryStyles.divider}>
              {pageRows.map(row => {
                const href = pcfLink(projectId, row.drawingId, row.commentId);
                const openRow = () => window.open(href, '_blank', 'noopener,noreferrer');
                return <tr key={row.drawingId + ':' + row.commentId} tabIndex={0} aria-label={'Open comment ' + row.number + ' for ' + row.drawingNo}
                  onClick={event => { if (!(event.target as HTMLElement).closest('a,button') && !window.getSelection()?.toString()) openRow(); }}
                  onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') openRow(); }}
                  className={inventoryStyles.row + ' ' + inventoryStyles.rowHover + ' cursor-pointer align-top focus-visible:outline-teal-500'}>
                  <td className="max-w-[240px] px-3 py-3 pl-5"><a className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline focus-visible:outline-teal-500" href={href} target="_blank" rel="noopener noreferrer">{row.drawingNo || 'Untitled drawing'}<ExternalLink size={10} className="shrink-0" /></a><p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-500" title={row.drawingTitle}>{row.drawingTitle}</p></td>
                  <td className="px-3 py-3 text-[11px]">{row.discipline || '—'}</td>
                  <td className="px-3 py-3"><span className={inventoryBadgeClass(row.drawingStatus)}>{row.drawingStatus || '—'}</span></td>
                  <td className="px-3 py-3 tabular-nums"><a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold text-teal-700 hover:underline" aria-label={'Open comment ' + row.number + ' for ' + row.drawingNo}>{row.number}</a>{row.hasImages && <span className="mt-2 flex text-slate-400" title="Images available in PCF"><Image size={12} aria-label="Has images" /></span>}</td>
                  <td className="px-3 py-3"><span className={inventoryBadgeClass(roundToLetters(row.round), 'round')}>{roundToLetters(row.round) || '—'}</span></td>
                  <td className="px-3 py-3"><span className={inventoryBadgeClass(row.status)}>{statusLabel(row.status)}</span></td>
                  <td className="px-3 py-3"><div className="flex max-w-[180px] flex-wrap gap-1">{row.tags.length ? row.tags.map(tag => <span key={tag} className={inventoryBadgeClass(tag, 'tag')}>{tag}</span>) : '—'}</div></td>
                  <td className="px-3 py-3 text-[11px] text-slate-600">{row.ownerName || '—'}</td>
                  <td className="max-w-[360px] px-3 py-3">{row.ownerDate && <p className="mb-1 text-[10px] text-slate-400">{safeFormatDate(row.ownerDate, 'dd MMM yyyy')}</p>}<p className="line-clamp-12 whitespace-pre-wrap break-words text-[11px] leading-relaxed" title={row.ownerComment}>{row.ownerComment || '—'}</p></td>
                  <td className="max-w-[360px] px-3 py-3">{row.builderReplyDate && <p className="mb-1 text-[10px] text-slate-400">{safeFormatDate(row.builderReplyDate, 'dd MMM yyyy')}</p>}<p className="line-clamp-12 whitespace-pre-wrap break-words text-[11px] leading-relaxed" title={row.builderReply}>{row.builderReply || '—'}</p></td>
                  <td className="whitespace-nowrap px-3 py-3 text-[10px] text-slate-500" title={row.updatedAt}>{safeFormatDate(row.updatedAt, 'dd MMM yyyy')}<p className="mt-1 text-slate-400">{safeFormatDate(row.updatedAt, 'HH:mm')}</p></td>
                </tr>;
              })}
              {!pageRows.length && <tr><td colSpan={columns.length} className="px-5 py-14 text-center text-sm text-slate-400">{loading ? 'Loading comments…' : error && !result ? 'Comments are unavailable. Use Refresh to try again.' : result ? 'No comments match the loaded filters.' : 'Load the comments register to get started.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-[10px] text-slate-500 sm:px-7">
          <span>{sortedRows.length ? numberFormat.format((currentPage - 1) * pageSize + 1) + '–' + numberFormat.format(Math.min(currentPage * pageSize, sortedRows.length)) : '0'} of {numberFormat.format(sortedRows.length)} comments</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">Rows per page<select className="rounded border border-slate-200 bg-white px-2 py-1.5 outline-teal-500" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>{[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
            <button type="button" aria-label="Previous page" disabled={currentPage <= 1} className="rounded border border-slate-200 p-1.5 transition-colors hover:bg-teal-50 disabled:opacity-30" onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button>
            <span className="tabular-nums">{currentPage} / {pageCount}</span>
            <button type="button" aria-label="Next page" disabled={currentPage >= pageCount} className="rounded border border-slate-200 p-1.5 transition-colors hover:bg-teal-50 disabled:opacity-30" onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button>
          </div>
        </footer>
      </section>
    </div>
  );
};
