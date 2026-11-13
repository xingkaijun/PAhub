import React from 'react';
import { BookOpen, Lock, Plus, RefreshCw, WifiOff } from 'lucide-react';
import type { LobbyCard } from './lobbyModel';

export interface LobbyViewProps {
  cards: LobbyCard[];
  /** First load with nothing to show yet: skeleton cards. */
  loading: boolean;
  refreshing: boolean;
  selectedId: string | null;
  launching: boolean;
  logoSrc: string;
  manualHref: string;
  showNoProjectsNote: boolean;
  onCardClick: (card: LobbyCard, el: HTMLElement) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onOffline: () => void;
}

export const LOGO_ALT = 'PG SHIPMANAGEMENT PTE. LTD. Logo';

/** The PG logo on its white plaque. The image itself is never altered; cover only trims its white margin. */
export function LogoPlaque({ src, className = '', dataRole }: { src: string; className?: string; dataRole?: string }) {
  return (
    <span className={`pl-logo ${className}`} data-pl-role={dataRole}>
      <img src={src} alt={LOGO_ALT} draggable={false} />
    </span>
  );
}

export function ManualLink({ href, className = 'pl-icon-btn' }: { href: string; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener" className={className} title="Guide" aria-label="Guide">
      <BookOpen size={16} strokeWidth={2} />
    </a>
  );
}

export function RefreshButton({ onClick, spinning, className = 'pl-icon-btn' }: { onClick: () => void; spinning: boolean; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={className} title="Refresh project list" aria-label="Refresh project list" data-spinning={spinning || undefined}>
      <RefreshCw size={16} strokeWidth={2} />
    </button>
  );
}

export function LockMark() {
  return <span className="pl-lock" title="Password protected" aria-label="Password protected"><Lock size={11} strokeWidth={2.5} /></span>;
}

export function CreateCard({ onCreate, className, children }: { onCreate: () => void; className: string; children?: React.ReactNode }) {
  return (
    <button type="button" className={className} onClick={onCreate} data-pl-chrome>
      <span className="pl-create-icon"><Plus size={22} strokeWidth={2} /></span>
      <span className="pl-create-label">Create Workspace</span>
      {children}
    </button>
  );
}

export function OfflineButton({ onClick, className = 'pl-offline' }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" className={className} onClick={onClick}>
      <WifiOff size={13} strokeWidth={2} />
      <span>Skip / Enter Offline Mode (Local Cache)</span>
    </button>
  );
}

export function NoProjectsNote() {
  return <span className="pl-note">Note: No projects found. Cloud sync might be required.</span>;
}

export function Skeletons({ count, className }: { count: number; className: string }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={className} aria-hidden="true"><span className="pl-shimmer" /></div>
      ))}
    </>
  );
}

export function EmptyState({ className = 'pl-empty' }: { className?: string }) {
  return (
    <div className={className} data-pl-chrome>
      <span className="pl-empty-title">No projects yet</span>
      <span className="pl-empty-text">Create a workspace, refresh the list, or continue with the local cache.</span>
    </div>
  );
}

export const cardLabel = (c: LobbyCard) =>
  `${c.name}${c.total ? `, ${c.completion}% approved, ${c.total} drawings` : ', ready to load'}${c.locked ? ', password protected' : ''}`;
