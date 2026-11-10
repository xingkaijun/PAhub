import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './lobby.css';
import type { LobbyCard } from './lobbyModel';
import { LogoPlaque } from './LobbyParts';
import { runLaunch, runReveal, type LaunchRun } from './lobbyMotion';
import { LobbyBlueprint } from './LobbyBlueprint';

export interface ProjectLobbyProps {
  cards: LobbyCard[];
  loading: boolean;
  /** True while the lobby should be shown (the app's showProjectSelector). */
  open: boolean;
  logoSrc: string;
  manualHref: string;
  showNoProjectsNote: boolean;
  /**
   * Opens the project; resolves true once it is open, false when it stayed closed (cancelled, failed).
   * motionSettled resolves when the loading sheet fills the screen, so a password prompt can wait for it.
   */
  onSelect: (id: string, motionSettled: Promise<void>) => Promise<boolean | void> | void;
  onCreate: () => void;
  onRefresh: () => void;
  onOffline: () => void;
  /** Called when the opening motion starts / when the lobby has fully faded away. */
  onLaunchStart?: () => void;
  onLaunchEnd?: () => void;
}

type Phase = 'idle' | 'launching' | 'revealing';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** The loading sheet the chosen card grows into; it fades out over the real register once that is ready. */
function LaunchLayer({ logoSrc, projectName }: { logoSrc: string; projectName: string }) {
  return (
    <div className="pl-l-sheet">
      <span className="pl-l-sheet-grid" />
      <span className="pl-l-sheet-in">
        <LogoPlaque src={logoSrc} />
        <span className="pl-l-sheet-kicker">Drawing register</span>
        <b className="pl-l-sheet-name">{projectName}</b>
        <span className="pl-l-progress"><i /></span>
      </span>
    </div>
  );
}

export function ProjectLobby(props: ProjectLobbyProps) {
  const { open } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<LaunchRun | null>(null);
  const openRef = useRef(open);
  const [phase, setPhase] = useState<Phase>('idle');
  const [selected, setSelected] = useState<LobbyCard | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  useLayoutEffect(() => { openRef.current = open; }, [open]);

  // Entrance: cards rise in once per mount.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.plEnter = prefersReducedMotion() ? 'reduced' : 'on';
    const t = window.setTimeout(() => { if (root) root.dataset.plEnter = 'done'; }, 900);
    return () => window.clearTimeout(t);
  }, []);

  const reset = useCallback(() => {
    runRef.current?.cancel();
    runRef.current = null;
    setSelected(null);
    setPhase('idle');
  }, []);

  const handleCardClick = useCallback(async (card: LobbyCard, el: HTMLElement) => {
    const root = rootRef.current;
    const layer = layerRef.current;
    if (!root || !layer || phaseRef.current !== 'idle') return;
    const reduced = prefersReducedMotion();
    phaseRef.current = 'launching';
    setPhase('launching');
    setSelected(card);
    root.dataset.plEnter = 'done';
    props.onLaunchStart?.();
    // The layer must be laid out (visible) before positions are read for the motion.
    layer.dataset.active = 'true';
    const run = runLaunch({ root, card: el, layer, reduced });
    runRef.current = run;
    let loadFailed = false;
    const load = Promise.resolve()
      .then(() => props.onSelect(card.id, run.finished))
      .then(opened => { if (opened === false) loadFailed = true; })
      .catch(() => { loadFailed = true; });
    await Promise.all([run.finished, load]);
    await nextFrame();
    if (runRef.current !== run) return;
    if (openRef.current || loadFailed) {
      // Not opened (password prompt, cancelled, or failed): put the room back.
      layer.dataset.active = 'false';
      reset();
      props.onLaunchEnd?.();
      root.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 180, easing: 'linear' });
      return;
    }
    root.dataset.phase = 'revealing';
    setPhase('revealing');
    await runReveal(layer, reduced);
    if (runRef.current !== run) return;
    props.onLaunchEnd?.();
  }, [props, reset]);

  useEffect(() => () => runRef.current?.cancel(), []);

  // Let the browser rasterise the hidden workspace layer as soon as a card is pointed at,
  // so the first frames of the opening motion do not wait for painting.
  const warmLayer = useCallback((e: React.PointerEvent) => {
    const layer = layerRef.current;
    if (layer && layer.dataset.warm !== 'true' && (e.target as HTMLElement).closest?.('[data-pl-card]')) layer.dataset.warm = 'true';
  }, []);

  // Re-opening the lobby ("back to projects") after a launch: start clean.
  useEffect(() => {
    if (open && phaseRef.current === 'revealing') {
      rootRef.current?.getAnimations({ subtree: true }).forEach(a => a.cancel());
      if (layerRef.current) layerRef.current.dataset.active = 'false';
      reset();
    }
  }, [open, reset]);

  const launching = phase !== 'idle';
  return (
    <div
      ref={rootRef}
      className="pl-root"
      data-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label="Project Access Hall"
      aria-busy={props.loading || launching || undefined}
      onPointerOver={warmLayer}
      onPointerDown={warmLayer}
    >
      <LobbyBlueprint
        cards={props.cards}
        loading={props.loading && !launching}
        refreshing={props.loading && !launching && props.cards.length > 0}
        selectedId={selected?.id ?? null}
        launching={launching}
        logoSrc={props.logoSrc}
        manualHref={props.manualHref}
        showNoProjectsNote={props.showNoProjectsNote}
        onCardClick={handleCardClick}
        onCreate={props.onCreate}
        onRefresh={props.onRefresh}
        onOffline={props.onOffline}
      />
      <div ref={layerRef} className="pl-launch" data-active="false" aria-hidden="true">
        <LaunchLayer logoSrc={props.logoSrc} projectName={selected?.name ?? ''} />
      </div>
    </div>
  );
}

export default ProjectLobby;
