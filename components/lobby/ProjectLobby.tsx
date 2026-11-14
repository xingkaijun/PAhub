import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './lobby.css';
import type { LobbyCard } from './lobbyModel';
import { LogoPlaque } from './LobbyParts';
import { runLaunch, runReveal, type LaunchRun } from './lobbyMotion';
import { LobbyBlueprint } from './LobbyBlueprint';

export type RequestProjectPassword = (error?: string) => Promise<string | null>;

export interface ProjectLobbyProps {
  /** Resume a protected URL/last project through exactly the same sheet as a card click. */
  autoSelectId?: string;
  cards: LobbyCard[];
  loading: boolean;
  /** True while the lobby should be shown (the app's showProjectSelector). */
  open: boolean;
  logoSrc: string;
  manualHref: string;
  showNoProjectsNote: boolean;
  /**
   * Opens the project; resolves true once it is open, false when it stayed closed (cancelled, failed).
   * requestPassword renders the challenge directly on the full-screen loading sheet.
   */
  onSelect: (id: string, motionSettled: Promise<void>, requestPassword: RequestProjectPassword, signal: AbortSignal) => Promise<boolean | void> | void;
  canCreate?: boolean;
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
function LaunchLayer({ logoSrc, projectName, challenge, onSubmit, onCancel }: {
  logoSrc: string; projectName: string; challenge: { error?: string } | null;
  onSubmit: (password: string) => void; onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setPassword('');
    if (challenge) inputRef.current?.focus();
  }, [challenge]);
  return (
    <div className="pl-l-sheet">
      <span className="pl-l-sheet-grid" />
      <div className="pl-l-sheet-in">
        <LogoPlaque src={logoSrc} />
        <span className="pl-l-sheet-kicker">Drawing register</span>
        <b className="pl-l-sheet-name">{projectName}</b>
        {challenge ? (
          <form className="pl-password" onSubmit={e => { e.preventDefault(); if (password) { onSubmit(password); setPassword(''); } }}>
            <label htmlFor="project-unlock-password">Project password</label>
            <p>This project is password protected. Enter the password to continue.</p>
            <input ref={inputRef} id="project-unlock-password" name="project-password" type="password"
              autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}
              aria-invalid={!!challenge.error} aria-describedby={challenge.error ? 'project-password-error' : undefined} required />
            {challenge.error ? <p id="project-password-error" role="alert">{challenge.error}</p> : null}
            <div className="pl-password-actions">
              <button type="button" onClick={onCancel}>Cancel</button>
              <button type="submit" disabled={!password}>Unlock</button>
            </div>
          </form>
        ) : <span className="pl-l-progress"><i /></span>}
      </div>
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
  const [challenge, setChallenge] = useState<{ error?: string } | null>(null);
  const passwordResolve = useRef<((password: string | null) => void) | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const originCardRef = useRef<HTMLElement | null>(null);
  const autoSelectedRef = useRef<string | undefined>(undefined);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  useEffect(() => {
    if (phase === 'idle' && originCardRef.current) originCardRef.current.focus();
  }, [phase]);

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

  const answerPassword = useCallback((password: string | null) => {
    const resolve = passwordResolve.current;
    passwordResolve.current = null;
    setChallenge(null);
    resolve?.(password);
  }, []);
  const cancelLaunch = useCallback(() => {
    controllerRef.current?.abort();
    answerPassword(null);
  }, [answerPassword]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (phaseRef.current !== 'launching') return;
      if (e.key === 'Escape') { e.preventDefault(); cancelLaunch(); }
      // Keep keyboard focus on the sheet, not the obscured hall/workspace.
      if (e.key === 'Tab') {
        const controls = Array.from<HTMLElement>(layerRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || []);
        if (!controls.length) return;
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && index <= 0) { e.preventDefault(); controls.at(-1)?.focus(); }
        else if (!e.shiftKey && (index === -1 || index === controls.length - 1)) { e.preventDefault(); controls[0].focus(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [cancelLaunch]);

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
    originCardRef.current = el;
    const controller = new AbortController();
    controllerRef.current = controller;
    // The layer must be laid out (visible) before positions are read for the motion.
    layer.dataset.active = 'true';
    const run = runLaunch({ root, card: el, layer, reduced });
    runRef.current = run;
    let loadFailed = false;
    const requestPassword: RequestProjectPassword = async error => {
      await run.finished;
      if (controller.signal.aborted) return null;
      return new Promise(resolve => { passwordResolve.current = resolve; setChallenge({ error }); });
    };
    const load = Promise.resolve()
      .then(() => props.onSelect(card.id, run.finished, requestPassword, controller.signal))
      .then(opened => { if (opened === false) loadFailed = true; })
      .catch(() => { loadFailed = true; });
    await Promise.all([run.finished, load]);
    await nextFrame();
    if (runRef.current !== run) return;
    if (openRef.current || loadFailed) {
      // Cancel/error: fade the loading sheet away, then restore the original room and focus.
      await runReveal(layer, reduced);
      if (runRef.current !== run) return;
      layer.dataset.active = 'false';
      reset();
      props.onLaunchEnd?.();
      requestAnimationFrame(() => originCardRef.current?.focus());
      root.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 180, easing: 'linear' });
      return;
    }
    root.dataset.phase = 'revealing';
    setPhase('revealing');
    await runReveal(layer, reduced);
    if (runRef.current !== run) return;
    props.onLaunchEnd?.();
  }, [props, reset]);

  useEffect(() => () => { controllerRef.current?.abort(); passwordResolve.current?.(null); runRef.current?.cancel(); }, []);

  useEffect(() => {
    const id = props.autoSelectId;
    if (!id || autoSelectedRef.current === id || props.loading || phaseRef.current !== 'idle') return;
    const card = props.cards.find(c => c.id === id);
    const el = Array.from<HTMLElement>(rootRef.current?.querySelectorAll<HTMLElement>('[data-pl-card]') || []).find(el => el.dataset.projectId === id);
    if (!card || !el) return;
    autoSelectedRef.current = id;
    void handleCardClick(card, el);
  }, [props.autoSelectId, props.cards, props.loading, handleCardClick]);

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
      aria-busy={props.loading || (launching && !challenge) || undefined}
      onPointerOver={warmLayer}
      onPointerDown={warmLayer}
    >
      <div inert={launching}>
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
        canCreate={props.canCreate}
        onCreate={props.onCreate}
        onRefresh={props.onRefresh}
        onOffline={props.onOffline}
      />
      </div>
      <div ref={layerRef} className="pl-launch" data-active="false" aria-hidden={!launching}>
        <LaunchLayer logoSrc={props.logoSrc} projectName={selected?.name ?? ''} challenge={challenge}
          onSubmit={answerPassword} onCancel={cancelLaunch} />
      </div>
    </div>
  );
}

export default ProjectLobby;
