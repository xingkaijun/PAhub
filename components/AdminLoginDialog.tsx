import React, { useEffect, useRef, useState } from 'react';
import { Lock, ShieldCheck, X } from 'lucide-react';
import { useStore } from '../store';
import { ModalOverlay } from './ModalOverlay';

/**
 * Administrator sign-in. The password is checked by the server (POST /api/session);
 * the answer, not anything in the bundle, decides whether administrator actions unlock.
 */
export const AdminLoginDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const loginAdmin = useStore(s => s.loginAdmin);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setPassword(''); setMessage(''); setBusy(false); }
  }, [open]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true); setMessage('');
    const admin = await loginAdmin(password);
    setBusy(false);
    if (admin) onClose();
    else setMessage('Incorrect administrator password.');
  };

  return (
    <ModalOverlay onClose={onClose} labelledBy="admin-login-title" initialFocus={input} className="max-w-sm rounded-[2rem] shadow-2xl">
      <form onSubmit={submit} className="bg-white rounded-[2rem] w-full border border-slate-200 p-6 animate-in zoom-in-95">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-teal-50 rounded-xl"><Lock size={18} className="text-teal-700" /></div>
            <div>
              <h3 id="admin-login-title" className="text-sm font-black text-slate-900 uppercase tracking-widest">Administrator Sign-in</h3>
              <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-0.5">Required for project-wide changes</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-300 hover:text-slate-600 transition-all"><X size={16} /></button>
        </div>
        <label className="block text-[9px] font-black uppercase tracking-widest text-slate-500 mb-1" htmlFor="admin-password">Administrator password</label>
        <input
          ref={input}
          id="admin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => { setPassword(e.target.value); setMessage(''); }}
          className="w-full px-4 py-2.5 border border-slate-200 bg-slate-50/60 rounded-xl outline-none text-sm font-bold focus:bg-white focus:border-teal-400 focus:ring-2 focus:ring-teal-500/20 transition-all"
        />
        {message && <p role="alert" className="mt-2 text-[10px] font-bold text-red-600">{message}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:bg-slate-50 rounded-xl transition-all">Cancel</button>
          <button type="submit" disabled={busy || !password} className="px-5 py-2 bg-[linear-gradient(135deg,#005c55_0%,#0f766e_100%)] text-white text-[9px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-teal-500/20 hover:brightness-105 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
            <ShieldCheck size={13} /> {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
};
