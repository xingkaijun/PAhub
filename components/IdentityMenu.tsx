import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';

// The header uses overflow-hidden for its backdrop, so the Account menu is rendered in a portal with
// fixed positioning anchored to the button; otherwise the header clips it.
export function IdentityMenu() {
  const session = useStore(state => state.session);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  if (session?.mode !== 'kjx' || !session.user || !session.auth) return null;
  const style = 'rounded-full border border-white/20 px-3 py-2 text-xs text-teal-50 hover:bg-white/15';
  const itemStyle = 'block w-full rounded-lg px-3 py-2 text-left text-xs text-teal-50 hover:bg-white/15';
  return <div className="flex items-center gap-2 text-xs text-white">
    <span>{session.user.name} <span className="rounded-full bg-white/15 px-2 py-1">{session.user.role}</span></span>
    <button ref={buttonRef} type="button" className={style} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {open ? '▴' : '▾'} Account
    </button>
    {open && pos && createPortal(
      <div ref={menuRef} role="menu" style={{ position: 'fixed', top: pos.top, right: pos.right }}
        className="z-[200] flex min-w-44 flex-col gap-1 rounded-xl border border-teal-200/40 bg-teal-800 p-2 shadow-2xl">
        <a role="menuitem" className={itemStyle} href={session.auth.passwordUrl + '?rd=' + encodeURIComponent(window.location.href)}>Change password</a>
        <a role="menuitem" className={itemStyle} href={session.auth.myAppsUrl}>My apps</a>
        <form method="post" action={session.auth.logoutUrl}>
          <input type="hidden" name="app" value="pahub" /><input type="hidden" name="path" value="/" />
          <button role="menuitem" className={itemStyle} type="submit">Sign out</button>
        </form>
      </div>,
      document.body,
    )}
  </div>;
}
export function AuthNotice() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    const listener = (event: Event) => setMessage(String((event as CustomEvent).detail || ''));
    window.addEventListener('pahub:auth-notice', listener);
    return () => window.removeEventListener('pahub:auth-notice', listener);
  }, []);
  return message ? <div role="alert" className="fixed left-1/2 top-3 z-[100] -translate-x-1/2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-lg">{message} <button onClick={() => setMessage('')} aria-label="Dismiss">×</button></div> : null;
}
