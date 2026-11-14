import React, { useEffect, useState } from 'react';
import { useStore } from '../store';

export function IdentityMenu() {
  const session = useStore(state => state.session);
  if (session?.mode !== 'kjx' || !session.user || !session.auth) return null;
  const style = 'rounded-full border border-white/20 px-3 py-2 text-xs text-teal-50 hover:bg-white/15';
  return <div className="flex items-center gap-2 text-xs text-white">
    <span>{session.user.name} <span className="rounded-full bg-white/15 px-2 py-1">{session.user.role}</span></span>
    <details className="relative"><summary className={style}>Account</summary>
      <div className="absolute right-0 top-full z-50 flex min-w-44 flex-col gap-2 rounded-xl border border-teal-200 bg-teal-800 p-3 shadow-lg">
        <a className={style} href={session.auth.passwordUrl + '?rd=' + encodeURIComponent(window.location.href)}>Change password</a>
        <a className={style} href={session.auth.myAppsUrl}>My apps</a>
        <form method="post" action={session.auth.logoutUrl}>
          <input type="hidden" name="app" value="pahub" /><input type="hidden" name="path" value="/" />
          <button className={style} type="submit">Sign out</button>
        </form>
      </div>
    </details>
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
