import React, { useState } from 'react';
import {useStore} from '../store';
import {KjxManual} from './KjxManual';
import {
  BookOpen, Terminal, Cloud, FileText, Settings,
  HelpCircle, ChevronRight, Info, AlertCircle, Send,
  MousePointer2, Command, Shield, Sparkles, CheckCircle, RefreshCw
} from 'lucide-react';

// Move helper components to top to avoid hoisting issues and fix children prop type errors
const Section = ({ icon, title, children }: { icon: React.ReactNode, title: string, children?: React.ReactNode }) => (
  <section className="space-y-4">
    <div className="flex items-center gap-3">
      <div className="p-2 bg-slate-50 rounded-xl text-slate-900 border border-slate-100 shadow-sm">{icon}</div>
      <h3 className="text-[12px] font-black uppercase text-slate-900 tracking-widest">{title}</h3>
    </div>
    <div className="pl-2 border-l border-slate-100">
      {children}
    </div>
  </section>
);

const CommandItem = ({ code, desc }: { code: string, desc: string }) => (
  <div className="flex items-center justify-between group">
    <code className="text-[10px] font-black text-teal-600 bg-teal-50 px-2 py-0.5 rounded-lg border border-teal-100/50">{code}</code>
    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight group-hover:text-slate-600 transition-colors">{desc}</span>
  </div>
);

const TipBadge = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-white/10 transition-colors cursor-default">
    <CheckCircle size={10} className="text-teal-400" />
    <span>{label}</span>
  </div>
);

// The full Chinese manual is a static page (public/manual/index.html, screenshots in public/manual/img/),
// so it can also be opened on its own at /manual/. English content follows the session mode;
// the original quick guide below is retained for legacy installations.
const EnglishGuide: React.FC = () => {
  return (
    <div data-testid="english-guide" className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-200 bg-white p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-12 pb-20">

        {/* Header Section */}
        <div className="border-b-2 border-slate-900 pb-8 flex justify-between items-end">
          <div>
            <h2 className="text-3xl font-[1000] text-slate-900 uppercase tracking-tighter leading-none mb-4">Operation Manual & Tips</h2>
            <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.3em]">Plan Approval Intelligence Platform User Guide</p>
          </div>
          <div className="text-right hidden md:block">
            <div className="text-[10px] font-black text-teal-600 bg-teal-50 px-3 py-1 rounded-full uppercase tracking-widest inline-block">PAhub · Self-hosted Server</div>
          </div>
        </div>

        {/* English quick guide (the Chinese manual lives at /manual/) */}
        <div className="grid grid-cols-1 gap-12 max-w-4xl">

          {/* English Version */}
          <div className="space-y-10">
            <header className="flex items-center gap-3 border-l-4 border-slate-900 pl-4">
              <span className="text-lg font-black text-slate-900 uppercase tracking-tight">English Manual</span>
            </header>

            <Section icon={<Cloud size={18} />} title="1. Server Data, Saving & Sign-in">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Server is the source of truth:</strong> All project data lives in the PAhub server database on your own network. Opening a project always loads it from the server.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Two roles:</strong> After unlocking any password-protected project, everyone can view its pages, export reports and edit PCFs online as a <strong>Reviewer</strong>. Project-wide changes (editing the drawing list, status changes, command bar, Config, Bulk Load, Team Setup, importing builder replies or JSON, Send All, voiding a shipyard export, restoring a PCF history snapshot) need an <strong>Administrator</strong>: click <strong>Reviewer</strong> in the toolbar and sign in with the server&apos;s <code>ADMIN_PASSWORD</code>. The sign-in lasts 12 hours. If the server has no <code>ADMIN_PASSWORD</code>, everyone is an administrator.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Auto-save + Save Now:</strong> As an administrator, your edits are saved automatically 3 seconds after the last change; only the fields you changed are sent. A scheduled sync also runs every few minutes (Config → Auto-Sync Interval, default 3 min; 0 turns it off). While changes are pending, an <strong>Unsaved Changes</strong> card shows the count and a <strong>Save Now</strong> button that saves immediately.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Live updates:</strong> Changes saved by others arrive in real time; only the changed drawings are re-read and a teal &quot;Updated by others&quot; note appears. Your unsaved edits are kept.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Conflict protection:</strong> If someone else saved the same field first, your save is refused for that batch, the field shows the server value and a yellow <strong>save conflict</strong> banner names it. Edits to different fields of the same drawing are both kept. Reload old browser tabs after an update so they get this protection.</li>
              </ul>
            </Section>

            <Section icon={<Shield size={18} />} title="Project Passwords & Access Hall">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li><strong>Set, change or clear:</strong> An administrator opens Config → Project Password. The input is masked; a saved password is shown only as <strong>Set</strong>, never its original value. Leaving the input untouched keeps the current password. Passwords and their hashes are not included in API responses or JSON exports.</li>
                <li><strong>Open a locked project:</strong> Its card expands into the normal full-screen loading sheet with the PG logo and project name. Enter the password directly on that sheet; the field focuses automatically. Press Enter or Unlock to submit. A wrong password shows an inline error and allows another try. Five failed attempts per source and project in 10 minutes trigger a temporary limit.</li>
                <li><strong>Cancel:</strong> Click Cancel or press Esc. The loading sheet fades out and the hall returns to its original state. A correct password continues loading, then fades into Inventory. Projects without passwords open as before.</li>
                <li><strong>Unlock session:</strong> A successful check sets a signed, HttpOnly, SameSite=Strict cookie for that project, valid for 12 hours. Refresh, sync, drawings, PCFs, reports, exports and live events use the cookie, not repeated password headers. Administrator sessions and API_TOKEN requests bypass project passwords. Changing or clearing the password invalidates old unlock cookies immediately; Secure follows HTTPS / X-Forwarded-Proto just like administrator sessions.</li>
                <li><strong>Refresh and deep links:</strong> If a protected last project or project URL has no valid unlock cookie, the hall opens the same loading-sheet password flow. Project access does not grant administrator editing permission.</li>
                <li><strong>Deployment:</strong> Set ADMIN_PASSWORD before exposing the Hub; without it everyone remains an administrator for local development. Startup backs up legacy plaintext settings before an idempotent migration to randomly salted scrypt hashes. Restrict access to that backup because it contains the old plaintext; to roll back, stop the Hub and restore the pre-migration database before running the old version.</li>
              </ul>
            </Section>

            <Section icon={<Terminal size={18} />} title="2. Intelligence Command Bar">
              <div className="bg-slate-50 p-4 rounded-2xl space-y-3">
                <p className="text-[10px] font-bold text-slate-500 uppercase mb-2 italic tracking-tight">Shortcuts for fast logging (administrator only):</p>
                <div className="space-y-2">
                  <CommandItem code="@001 Content" desc="Add an internal note to drawing with ID 001." />
                  <CommandItem code="@001 c:12/3" desc="Set comments to 12 total, 3 open (not for drawings with a PCF)." />
                  <CommandItem code="@R 001, 002" desc="Batch update status to 'Reviewing'." />
                </div>
              </div>
            </Section>

            <Section icon={<MousePointer2 size={18} />} title="3. Workflow & Tracker">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Status Logic:</strong> Pick the status (Pending / Reviewing / Waiting Reply / Approved) from the Status column (administrator). Moving from Waiting Reply back to Reviewing starts the next round (A → B …) and sets a new deadline in working days (Config: round A cycle / other rounds cycle). Overdue items are flagged automatically.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Review Tracker:</strong> Shows drawings in Reviewing. Tick each assignee when done; when all are done the drawing is Ready. Mark Ready drawings with APR to send them as Approved, then <strong>Send All</strong> updates the statuses (Approved or Waiting Reply) and downloads the shipyard PCF package. Tracker states are saved on the server.</li>
              </ul>
            </Section>

            <Section icon={<FileText size={18} />} title="4. Daily Log & Activity Reports">
              <ul className="space-y-3 text-[11px] font-medium text-slate-600 leading-relaxed">
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Data Strictness:</strong> Comment totals come from each drawing&apos;s PCF (counted automatically on every PCF save); drawings without a PCF use the Total/Open values entered by hand or with <code>c:12/3</code>. Internal notes are never counted.</li>
                <li className="flex gap-2"><ChevronRight size={12} className="shrink-0 mt-0.5 text-teal-500" /> <strong>Builder replies in the log:</strong> Every Builder reply import (Import Builder Replies or the PCF&apos;s Import Builder Reply) adds a <strong>Builder Reply</strong> row to the Server log, e.g. &ldquo;Builder replies imported: 2 replies (Round B) · status unchanged (Reviewing)&rdquo;. Importing only moves Waiting Reply to Reviewing; other statuses stay as they are. Use the <strong>Builder reply</strong> filter to see only these rows.</li>
              </ul>
            </Section>
          </div>

        </div>

        {/* Footer Pro Tips */}
        <div className="bg-slate-900 rounded-[2.5rem] p-10 text-white relative overflow-hidden">
          <div className="relative z-10 flex flex-col md:flex-row gap-12 items-center">
            <div className="shrink-0">
              <div className="w-20 h-20 bg-teal-500 rounded-3xl flex items-center justify-center shadow-xl shadow-teal-500/20">
                <Shield size={40} />
              </div>
            </div>
            <div className="flex-1 space-y-4 text-center md:text-left">
              <h3 className="text-xl font-black uppercase tracking-widest">Platform Safety & Best Practices</h3>
              <p className="text-slate-400 text-[11px] font-bold leading-relaxed uppercase tracking-widest">
                Set the auto-sync interval in <strong>Config</strong>. Project-wide changes and bulk imports need the <strong>Administrator</strong> sign-in (server <code>ADMIN_PASSWORD</code>); keep a <strong>Local Backup</strong> before large imports.
              </p>
              <div className="pt-4 flex flex-wrap gap-4 justify-center md:justify-start">
                <TipBadge label="Auto-Sync Enabled" />
                <TipBadge label="Review Logs Weekly" />
                <TipBadge label="Project Specific Config" />
                <TipBadge label="Self-hosted Server" />
              </div>
            </div>
          </div>

          {/* Abstract BG Decorations */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-teal-500/10 rounded-full -mr-32 -mt-32 blur-3xl" />
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-teal-500/10 rounded-full -ml-24 -mb-24 blur-3xl" />
        </div>
      </div>
    </div>
  );
};

type GuideLanguage = 'zh' | 'en';
const tabClass = (active: boolean) =>
  'px-3 py-1.5 rounded-full text-[11px] font-black tracking-wide transition-colors ' +
  (active ? 'bg-teal-600 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-teal-700');

export const Manual: React.FC = () => {
  const [language, setLanguage] = useState<GuideLanguage>('zh');
  const kjx=useStore(state=>state.session?.mode==='kjx');
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white">
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen size={16} className="shrink-0 text-teal-600" />
          <span className="text-[12px] font-black text-slate-800 truncate">{language === 'zh' ? 'PAhub 操作手册' : 'Operation Manual & Tips'} · {kjx ? 'kjx' : 'legacy'}</span>
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Guide language" className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100/70 p-0.5">
            <button type="button" role="tab" aria-selected={language === 'zh'} className={tabClass(language === 'zh')} onClick={() => setLanguage('zh')}>中文手册</button>
            <button type="button" role="tab" aria-selected={language === 'en'} className={tabClass(language === 'en')} onClick={() => setLanguage('en')}>English</button>
          </div>
          <a href="/manual/" target="_blank" rel="noopener" className="px-3 py-1.5 rounded-full border border-teal-200 bg-white text-[11px] font-black text-teal-700 hover:bg-teal-600 hover:text-white transition-colors whitespace-nowrap">
            {language === 'zh' ? '新标签页打开' : 'Open in new tab'}
          </a>
        </div>
      </div>
      {kjx && <p className="shrink-0 px-4 py-2 text-xs text-teal-800 bg-teal-50">{language==='zh' ? '保存状态显示待同步项、保存中、上次成功时间或持续失败原因；临时错误退避重试，登录／权限／数据过大需处理。未同步修改保存失败时会阻止切换项目。' : 'Save status shows pending, saving, saved time or a persistent failure. Temporary failures retry with backoff; sign-in, permission and oversized-data errors require attention. A workspace switch is blocked until pending changes are saved.'}</p>}
      {language === 'zh'
        ? <iframe data-testid="manual-frame" title="PAhub 中文操作手册" src="/manual/" className="flex-1 w-full min-h-[480px] border-0 bg-white" />
        : kjx ? <KjxManual /> : <EnglishGuide />}
    </div>
  );
};
