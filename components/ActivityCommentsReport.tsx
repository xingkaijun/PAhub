import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, RefreshCw, X } from 'lucide-react';
import { fetchComments, subscribeToCommentChanges } from '../services/api/commentsApi';
import type { CommentsResponse } from '../types/comments';
import {
  buildCommentReport, commentAge, disciplineLabel, isClosedComment, REPORT_DISCIPLINES_PER_PAGE,
  reportPercent, selectedReportComments, type CommentReport, type ReportSelection,
} from '../lib/activityReport';
import { roundToLetters } from '../lib/rounds';
import { ReportPage } from './reportLayout';
import './activityReport.css';

const number = new Intl.NumberFormat('en');
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';
};

export function useActivityComments(projectId: string | null) {
  const [snapshot, setSnapshot] = useState<{ projectId: string; data: CommentsResponse } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const changeVersion = useRef(0);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    return subscribeToCommentChanges(projectId, () => {
      changeVersion.current++;
      setStale(true);
    }, state => setOffline(state === 'offline'));
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    if (!projectId) { setLoading(false); return; }
    const version = changeVersion.current;
    setLoading(true);
    setError('');
    void fetchComments(projectId, {}, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setSnapshot({ projectId, data });
      setStale(changeVersion.current !== version);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load the comments register.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, refreshVersion]);
  const data = snapshot?.projectId === projectId ? snapshot.data : null;
  const report = useMemo(() => data ? buildCommentReport(data.comments, data.generatedAt) : null, [data]);
  return { data, report, loading, error, stale, offline, refresh: () => setRefreshVersion(value => value + 1) };
}

export type ActivityCommentsState = ReturnType<typeof useActivityComments>;

function SnapshotHeading({ title, subtitle, asOf }: { title: string; subtitle: string; asOf?: string }) {
  return <header className="comment-report-heading">
    <div><h2>{title}</h2><p>{subtitle}</p></div>
    <div className="comment-report-asof"><span>Current snapshot</span><strong>{asOf ? dateLabel(asOf) : 'Not available'}</strong></div>
  </header>;
}

function CoverageNote({ data }: { data: CommentsResponse }) {
  const coverage = data.coverage;
  const incomplete = coverage ? coverage.missingPcfDrawings + coverage.unreadablePcfDrawings : data.warnings.length;
  return <div className={'comment-report-coverage' + (incomplete ? ' is-incomplete' : '')} role="note">
    {incomplete ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
    <div>{coverage
      ? <><strong>{coverage.parsedPcfDrawings} / {coverage.totalActiveDrawings} drawings covered.</strong> Canonical PCFs only; empty PCFs are included.
        {coverage.missingPcfDrawings > 0 && <> {coverage.missingPcfDrawings} without a PCF.</>}
        {coverage.unreadablePcfDrawings > 0 && <> {coverage.unreadablePcfDrawings} unreadable.</>}
        {!!incomplete && <> Missing or unreadable sources are not zero-comment drawings.</>}</>
      : <><strong>Coverage counts unavailable.</strong> {data.warnings.length ? `${data.warnings.length} PCF source(s) could not be read.` : 'Only readable canonical PCFs are included; missing PCFs may not be reported.'}</>}
    </div>
  </div>;
}

function ReportLegend() {
  return <div className="comment-report-legend" aria-label="Comment status legend">
    <span><Circle size={11} className="report-open-icon" />Open</span>
    <span><CheckCircle2 size={11} className="report-closed-icon" />Closed</span>
  </div>;
}

function BarButton({ open, closed = 0, max, label, stacked = false, unknown = false, onClick }: {
  open: number; closed?: number; max: number; label: string; stacked?: boolean; unknown?: boolean; onClick: () => void;
}) {
  const id = useId().replace(/:/g, '');
  const openWidth = max ? open / max * 100 : 0;
  const closedWidth = max ? closed / max * 100 : 0;
  return <button type="button" className="comment-report-bar" onClick={onClick} aria-label={label}>
    <svg width="100%" height="16" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
      <defs><pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--report-open)" /><line x1="0" x2="0" y1="0" y2="5" stroke="white" strokeWidth="1.5" /></pattern></defs>
      {open > 0 && <rect className={unknown ? 'report-unknown-mark' : 'report-open-mark'} style={{ '--report-print-fill': `url(#${id})` } as React.CSSProperties} x="0" y="2" width={openWidth} height="12" rx="0.7" />}
      {stacked && closed > 0 && <rect className="report-closed-mark" x={openWidth + (open > 0 ? Math.min(0.7, closedWidth / 2) : 0)} y="2" width={Math.max(0, closedWidth - (open > 0 ? Math.min(0.7, closedWidth / 2) : 0))} height="12" rx="0.7" />}
    </svg>
    <span className="comment-report-tooltip" role="tooltip">{label}</span>
  </button>;
}

function EmptyReport({ children }: { children: React.ReactNode }) {
  return <div className="comment-report-empty">{children}</div>;
}

function OverviewMetrics({ report }: { report: CommentReport }) {
  const metrics = [
    { label: 'Total comments', value: number.format(report.total), detail: 'Unique comment threads' },
    { label: 'Open', value: number.format(report.open), detail: 'Not yet closed' },
    { label: 'Closed', value: number.format(report.closed), detail: `${reportPercent(report.closed, report.total)} of all comments` },
    { label: 'Open >30 days', value: number.format(report.olderThan30), detail: 'Age, not an overdue flag' },
    { label: 'Drawings with open', value: number.format(report.drawingsWithOpen), detail: 'At least one open comment' },
  ];
  return <section className="comment-report-metrics" aria-label="Comment overview metrics">{metrics.map(metric => <div key={metric.label}>
    <p>{metric.label}</p><strong>{metric.value}</strong><small>{metric.detail}</small>
  </div>)}</section>;
}

export function ActivityCommentsPages({ state, projectName, startPage, totalPages }: {
  state: ActivityCommentsState; projectName: string; startPage: number; totalPages: number;
}) {
  const { data, report, loading, error, stale } = state;
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  useEffect(() => { setSelection(null); }, [data]);
  const available = !!data && !!report;
  const overviewPages = report?.overviewPages || 1;
  return <>
    {Array.from({ length: overviewPages }, (_, page) => <ReportPage key={'comments-overview-' + page} pageNumber={startPage + page} totalPages={totalPages} projectName={projectName}>
      <section className="comment-report-sheet" data-report-section="comments-overview">
        <SnapshotHeading title={page ? 'Comments overview · continued' : 'Comments overview'} subtitle="Where the remaining review work is concentrated" asOf={data?.generatedAt} />
        {available ? <>
          {page === 0 && <><CoverageNote data={data} /><OverviewMetrics report={report} /></>}
          <section className="comment-report-section" aria-label="Comments by discipline">
            <div className="comment-report-section-heading"><h3>Closure by discipline</h3><ReportLegend /></div>
            <p className="comment-report-caption">Ranked by open comments. Closed share describes the current position, not period productivity.</p>
            {report.disciplines.length ? <table className="comment-report-table comment-report-discipline-table">
              <caption className="sr-only">Open and closed comments by discipline, with closed share. Select a bar to inspect the matching comments.</caption>
              <thead><tr><th>Discipline</th><th><span className="sr-only">Open and closed counts</span></th><th>Open</th><th>Closed</th><th>Closed %</th></tr></thead>
              <tbody>{report.disciplines.slice(page * REPORT_DISCIPLINES_PER_PAGE, (page + 1) * REPORT_DISCIPLINES_PER_PAGE).map(row => <tr key={row.name}>
                <th scope="row">{disciplineLabel(row.name)}</th>
                <td><BarButton open={row.open} closed={row.closed} max={Math.max(...report.disciplines.map(disc => disc.total), 1)} stacked label={`${disciplineLabel(row.name)}: ${row.open} open, ${row.closed} closed, ${row.total} total`} onClick={() => setSelection({ kind: 'discipline', value: row.name, label: disciplineLabel(row.name) })} /></td>
                <td>{number.format(row.open)}</td><td>{number.format(row.closed)}</td><td>{reportPercent(row.closed, row.total)}</td>
              </tr>)}</tbody>
            </table> : <EmptyReport>No comments in the readable PCFs for this project.</EmptyReport>}
            {overviewPages > 1 && <p className="comment-report-caption">Discipline page {page + 1} of {overviewPages}; the scale is shared across all disciplines.</p>}
          </section>
          {page === 0 && <section className="comment-report-section" aria-label="Open comment ageing">
            <div className="comment-report-section-heading"><h3>Age of open comments</h3><span className="comment-report-caption">Days since creation</span></div>
            <div className="comment-report-age-layout">
              <table className="comment-report-table comment-report-age-table"><caption className="sr-only">Open comments by age in days</caption>
                <thead><tr><th>Days</th><th><span className="sr-only">Count bar</span></th><th>Open</th></tr></thead>
                <tbody>{report.ageing.filter(row => row.band !== 'Unknown' || row.count > 0).map(row => <tr key={row.band}>
                  <th scope="row">{row.band}</th><td><BarButton open={row.count} max={Math.max(...report.ageing.map(band => band.count), 1)} unknown={row.band === 'Unknown'} label={`${row.band === 'Unknown' ? 'Unknown age' : row.band + ' days'}: ${row.count} open comments`} onClick={() => setSelection({ kind: 'age', value: row.band, label: row.band === 'Unknown' ? 'Open comments · unknown age' : `Open comments · ${row.band} days` })} /></td><td>{number.format(row.count)}</td>
                </tr>)}</tbody>
              </table>
              <div className="comment-report-age-note"><strong>{reportPercent(report.olderThan30, report.open)}</strong><p>of open comments are older than 30 days.</p><p>Age is measured from original creation, not the last reply or reopening. It does not determine whether a comment is overdue.</p>{report.unknownAge > 0 && <p>{report.unknownAge} open comments have missing, invalid or future creation dates and are counted as Unknown.</p>}</div>
            </div>
          </section>}
          <p className="comment-report-method">One thread counted once per drawing. Replies and rounds are not additional comments. Current snapshot, independent of the drawing activity date range.{stale ? ' Project changes detected after this snapshot; refresh before issuing.' : ''}{error ? ' Refresh failed; this is the previous successful snapshot.' : ''}</p>
        </> : <EmptyReport><AlertCircle size={20} /><strong>{loading ? 'Loading the complete comments register…' : 'Comments report unavailable'}</strong><p>{error || 'Comment metrics will appear after the register has loaded. No manual totals are substituted.'}</p>{!loading && <button type="button" onClick={state.refresh}><RefreshCw size={13} />Retry comments</button>}</EmptyReport>}
      </section>
    </ReportPage>)}
    <ReportPage pageNumber={startPage + overviewPages} totalPages={totalPages} projectName={projectName}>
      <section className="comment-report-sheet" data-report-section="comments-follow-up">
        <SnapshotHeading title="Priority follow-up" subtitle="Focus the next review on the largest backlogs and oldest open items" asOf={data?.generatedAt} />
        {available ? <>
          <section className="comment-report-section" aria-label="Top drawings with open comments">
            <div className="comment-report-section-heading"><h3>Top 10 drawings by open comments</h3><span className="comment-report-caption">{reportPercent(report.topOpen, report.open)} of all open comments</span></div>
            {report.topDrawings.length ? <table className="comment-report-table comment-report-top-table">
              <caption className="sr-only">Drawings ranked by open comments, with discipline and open comments older than 30 days</caption>
              <thead><tr><th>Drawing / discipline</th><th><span className="sr-only">Open count bar</span></th><th>Open</th><th>&gt;30 days</th></tr></thead>
              <tbody>{report.topDrawings.map(row => <tr key={row.id}>
                <th scope="row"><span title={row.title}>{row.name || 'Unnumbered drawing'}</span><small>{disciplineLabel(row.discipline)}</small></th>
                <td><BarButton open={row.open} max={report.topDrawings[0]?.open || 1} label={`${row.name}: ${row.title}. ${row.open} open; ${row.olderThan30} older than 30 days`} onClick={() => setSelection({ kind: 'drawing', value: row.id, label: `${row.name} · open comments` })} /></td><td>{number.format(row.open)}</td><td>{number.format(row.olderThan30)}</td>
              </tr>)}</tbody>
            </table> : <EmptyReport>No open comments in the readable PCFs.</EmptyReport>}
          </section>
          <section className="comment-report-section" aria-label="Oldest open comments">
            <div className="comment-report-section-heading"><h3>Oldest open comments</h3><span className="comment-report-caption">{Math.min(6, report.open)} of {number.format(report.open)} open</span></div>
            <p className="comment-report-caption">Oldest first, then latest round. This is an age-based follow-up list, not a severity assessment.</p>
            {report.priorityRows.length ? <table className="comment-report-table comment-report-priority-table"><caption className="sr-only">Up to six oldest open comments, including drawing and comment identifiers</caption>
              <thead><tr><th>Drawing / comment</th><th>Latest owner comment</th><th>Age</th><th>Round</th></tr></thead>
              <tbody>{report.priorityRows.map(row => <tr key={row.drawingId + ':' + row.commentId}>
                <th scope="row"><button type="button" className="comment-report-text-button" onClick={() => setSelection({ kind: 'comment', drawingId: row.drawingId, value: row.commentId, label: `${row.drawingNo} · Comment ${row.number}` })}>{row.drawingNo}<small>Comment {row.number} · {disciplineLabel(row.discipline)}</small></button></th>
                <td><span className="comment-report-excerpt" title={row.ownerComment}>{row.ownerComment || (row.hasImages ? 'Image content — open the comment to review.' : 'No owner text recorded.')}</span></td>
                <td>{commentAge(row, data.generatedAt) === null ? 'Unknown' : commentAge(row, data.generatedAt) + 'd'}</td><td>{roundToLetters(row.round) || '—'}</td>
              </tr>)}</tbody>
            </table> : <EmptyReport>No open comments to follow up.</EmptyReport>}
          </section>
          <p className="comment-report-method">Select a bar or comment reference to inspect its source rows on screen. Printed references use the drawing number and comment number. Unknown ages sort after known ages. Latest round is not the number of effective exchanges.{data.coverage && data.coverage.parsedPcfDrawings < data.coverage.totalActiveDrawings ? ' Source coverage is incomplete; see Comments overview.' : ''}</p>
        </> : <EmptyReport>Follow-up items are unavailable until the complete comments register can be loaded.</EmptyReport>}
      </section>
    </ReportPage>
    {selection && data && report && <CommentDetails key={selection.label} report={report} selection={selection} asOf={data.generatedAt} close={() => setSelection(null)} />}
  </>;
}

const CommentDetails: React.FC<{ report: CommentReport; selection: ReportSelection; asOf: string; close: () => void }> = ({ report, selection, asOf, close }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  const rows = selectedReportComments(report, selection, asOf);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="comment-report-dialog no-print" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="report-detail-title">
    <div className="comment-report-detail-body">
      <header><div><h2 id="report-detail-title">{selection.label}</h2><p>{rows.length} matching comments · Snapshot {dateLabel(asOf)}</p></div><button type="button" onClick={close} aria-label="Close comment details" autoFocus><X size={20} /></button></header>
      <div className="comment-report-detail-scroll">{rows.slice(page * 20, (page + 1) * 20).map(row => <article key={row.drawingId + ':' + row.commentId}>
        <h3>{row.drawingNo} · Comment {row.number}</h3><p>{row.drawingTitle}</p>
        <div className="comment-report-detail-meta"><span>{disciplineLabel(row.discipline)}</span><span>{isClosedComment(row) ? 'Closed' : 'Open'}</span><span>Latest round {roundToLetters(row.round)}</span><span>{isClosedComment(row) ? 'Age: not applicable' : `Age: ${commentAge(row, asOf) === null ? 'Unknown' : commentAge(row, asOf) + ' days'}`}</span></div>
        <h4>Latest owner comment</h4><p className="comment-report-detail-text">{row.ownerComment || 'No owner text recorded.'}</p>
        <h4>Latest builder reply preview</h4><p className="comment-report-detail-text">{row.builderReply || 'No reply text recorded.'}</p>
        {row.hasImages && <p>Contains images. Review the original PCF for image content.</p>}
      </article>)}{!rows.length && <p>No matching comments.</p>}</div>
      <footer><span>Owner and reply previews may belong to different rounds.</span><div><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 20))}</span><button type="button" disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(value => value + 1)}>Next</button></div></footer>
    </div>
  </dialog>;
}
