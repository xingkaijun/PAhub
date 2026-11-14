import React from 'react';
import { lobbyTotals, STATUS_LABEL } from './lobbyModel';
import {
  CreateCard, EmptyState, LockMark, LogoPlaque, ManualLink, NoProjectsNote, OfflineButton,
  RefreshButton, Skeletons, cardLabel, type LobbyViewProps,
} from './LobbyParts';

/** 3 · 蓝图 Blueprint — drawing sheets with title blocks; the sheet is lifted and becomes the register. */
export function LobbyBlueprint(p: LobbyViewProps) {
  const t = lobbyTotals(p.cards);
  return (
    <div className="pl-scroll">
      <header className="pl-top" data-pl-chrome>
        <div className="pl-brand">
          <LogoPlaque src={p.logoSrc} dataRole="logo" />
          <span className="pl-brand-text">
            <span className="pl-brand-title">Plan Approval Platform</span>
            <span className="pl-brand-sub">Sheet index · Project Access Hall</span>
          </span>
        </div>
        <div className="pl-actions">
          <ManualLink href={p.manualHref} />
          <RefreshButton onClick={p.onRefresh} spinning={p.refreshing} />
        </div>
      </header>

      <section className="pl-hero" data-pl-chrome>
        <div className="pl-hero-main">
          <p className="pl-kicker">No. 01 — Index of projects</p>
          <h1 className="pl-title">Project <em>Access Hall</em></h1>
        </div>
        <dl className="pl-stats">
          <div><dt>Projects</dt><dd>{String(t.projects).padStart(2, '0')}</dd></div>
          <div><dt>Drawings</dt><dd>{t.drawings.toLocaleString('en-US')}</dd></div>
          <div><dt>Approved</dt><dd>{t.completion}%</dd></div>
        </dl>
      </section>

      <div className="pl-grid">
        {p.loading && p.cards.length === 0 ? <Skeletons count={6} className="pl-card pl-skel" /> : null}
        {!p.loading && p.cards.length === 0 ? <EmptyState /> : null}
        {p.cards.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className="pl-card"
            data-pl-card
            data-project-id={c.id}
            data-status={c.status}
            data-selected={p.selectedId === c.id || undefined}
            style={{ '--pl-i': Math.min(i, 12), '--pl-pct': c.completion / 100 } as React.CSSProperties}
            aria-label={cardLabel(c)}
            disabled={p.launching}
            onClick={e => p.onCardClick(c, e.currentTarget)}
          >
            <span className="pl-corner pl-c1" aria-hidden="true" />
            <span className="pl-corner pl-c2" aria-hidden="true" />
            <span className="pl-card-in">
              <span className="pl-sheet-no">SHEET {String(i + 1).padStart(2, '0')}</span>
              <span className="pl-card-row">
                <span className="pl-code">{c.code}{c.locked ? <LockMark /> : null}</span>
                <span className="pl-figure">{c.total > 0 ? <>{c.completion}<small>%</small></> : '—'}</span>
              </span>
              <span className="pl-name" data-pl-name>{c.name}</span>
              <span className="pl-scale" aria-hidden="true"><span /></span>
              <span className="pl-block">
                <span><i>Hull</i><b>{c.hull || '—'}</b></span>
                <span><i>Assets</i><b>{c.total || '—'}</b></span>
                <span><i>Updated</i><b>{c.updated || '—'}</b></span>
                <span className="pl-block-status"><i>Status</i><b><em />{STATUS_LABEL[c.status]}</b></span>
              </span>
            </span>
          </button>
        ))}
        {p.canCreate !== false && (!p.loading || p.cards.length > 0) ? (
          <CreateCard onCreate={p.onCreate} className="pl-card pl-create">
            <span className="pl-create-sub">New project register</span>
          </CreateCard>
        ) : null}
      </div>

      <footer className="pl-foot" data-pl-chrome>
        <OfflineButton onClick={p.onOffline} />
        {p.showNoProjectsNote ? <NoProjectsNote /> : null}
      </footer>
    </div>
  );
}
