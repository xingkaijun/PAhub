import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import {
  Database, Users, Trash2,
  Plus, UserCheck, RefreshCw, Send, Download, Shield, Info, Lock, X, Eye, EyeOff, AlertCircle,
  Clock, CalendarDays, Save, Upload, Link as LinkIcon, CheckCircle, LayoutDashboard,
  User, Calendar, ShieldCheck, Activity, HeartPulse
} from 'lucide-react';
import { format } from 'date-fns';
import { downloadProjectBackup, parseProjectBackup } from '../services/data/localProjectFile';
import { calculateDeadline, reviewCycleDays } from '../lib/deadline';
import { projectsApi } from '../services/api/projectsApi';
import { TeamRosterPicker } from './TeamRosterPicker';
import { settingsStyles } from './settingsStyles';
import type { Reviewer } from '../types';

export const Settings: React.FC = () => {
  const { data, updateSettings, updateProjectConfig, saveActiveProject, loadProject, fetchProjectList, isLoading, activeProjectId, error, clearError, restoreProject, reviewTracker } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const project = data.projects.find(p => p.id === activeProjectId);

  // Use project config if available, otherwise global defaults (as template/fallback)
  const activeSettings = project?.conf || data.settings;

  const globalSettings = data.settings;

  // Local UI inputs
  const [newReviewer, setNewReviewer] = useState('');
  const [newHoliday, setNewHoliday] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState('');
  const isAdmin = useStore(state => state.can('settings.write'));
  const kjx = useStore(state => state.session?.mode === 'kjx');
  const canSetupTeam = useStore(state => state.can('team.setup'));
  const roster = (activeSettings.reviewers || []).map(person => typeof person === 'string' ? {id:person, name:person} : person);
  const addDirectoryReviewer = (person: Reviewer) => {
    const reviewers = [...(activeSettings.reviewers || []).filter(r => r.id !== person.id), person];
    const changes = { reviewers };
    if (project) updateProjectConfig(project.id, changes); else updateSettings(changes);
  };
  const passwordRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setPasswordDraft(''); setPasswordNotice(''); setPasswordBusy(false);
    return () => passwordRequest.current?.abort();
  }, [activeProjectId, isAdmin]);

  const savePassword = async (clear = false) => {
    if (!project || !isAdmin || passwordBusy || (!clear && !passwordDraft.trim())) return;
    const projectId = project.id;
    const controller = new AbortController(); passwordRequest.current = controller;
    setPasswordBusy(true); setPasswordNotice('');
    try {
      const saved = await projectsApi.saveDelta(projectId, {
        conf: { password: clear ? '' : passwordDraft },
        confBase: { passwordVersion: project.conf.passwordVersion },
      }, controller.signal);
      controller.signal.throwIfAborted();
      if (!saved.conf) throw new Error('The server did not return the password status');
      const { passwordSet, passwordVersion } = saved.conf;
      // Only adopt credential status; other unsaved Config edits remain untouched.
      useStore.setState(state => ({ data: { ...state.data, projects: state.data.projects.map(p => p.id === projectId
        ? { ...p, passwordProtected: passwordSet, conf: { ...p.conf, passwordSet, passwordVersion } } : p) } }));
      setPasswordDraft(''); setPasswordNotice(clear ? 'Project password cleared' : 'Project password set');
    } catch (error) {
      if (!controller.signal.aborted) setPasswordNotice('Save failed: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (!controller.signal.aborted) setPasswordBusy(false);
      if (passwordRequest.current === controller) passwordRequest.current = null;
    }
  };

  const activeDisciplines = React.useMemo(() => {
    if (!project) return [];
    return Array.from(new Set([...project.drawings.map(d => d.discipline), ...Object.keys(activeSettings.disciplineDefaults || {}), ...Object.keys(project.conf.defaultAssignees || {})])).filter(Boolean).sort();
  }, [project, activeSettings.disciplineDefaults]);

  const handleExecutePush = async () => {
    const success = await saveActiveProject('');
    if (success) {
      alert("Project successfully synced to Cloud.");
    }
  };

  const addItem = (type: 'reviewers' | 'holidays', value: string, setter: (v: string) => void) => {
    // Handling Reviewers (Objects) vs Holidays (Strings)
    if (type === 'reviewers') {
      const list = (activeSettings.reviewers || []) as any[];
      // Check duplication by name or ID
      const exists = list.some(r => (typeof r === 'string' ? r === value : r.name === value));
      if (value && !exists) {
        const newReviewer = { id: value.toLowerCase().replace(/\s+/g, '_'), name: value };
        const newList = [...list, newReviewer];
        if (project) {
          updateProjectConfig(project.id, { reviewers: newList });
        } else {
          updateSettings({ reviewers: newList });
        }
        setter('');
      }
    } else {
      // Holidays (Strings)
      const list = (activeSettings[type] || []) as string[];
      if (value && !list.includes(value)) {
        if (project) {
          updateProjectConfig(project.id, { [type]: [...list, value] });
        } else {
          updateSettings({ [type]: [...list, value] });
        }
        setter('');
      }
    }
  };

  const removeItem = (type: 'reviewers' | 'holidays', value: string) => {
    if (type === 'reviewers') {
      const list = (activeSettings.reviewers || []) as any[];
      // value passed might be ID or Name. In map loop we will pass ID if object.
      const newList = list.filter(r => {
        const rId = typeof r === 'string' ? r : r.id;
        const rName = typeof r === 'string' ? r : r.name;
        // We'll compare against both just to be safe if 'value' is ambiguous
        return rId !== value && rName !== value;
      });
      if (project) updateProjectConfig(project.id, kjx ? {reviewers:newList,disciplineDefaults:Object.fromEntries(Object.entries(project.conf.disciplineDefaults).filter(([,id])=>id!==value)),defaultAssignees:Object.fromEntries(Object.entries(project.conf.defaultAssignees || {}).map(([discipline,ids])=>[discipline,ids.filter(id=>id!==value)]))} : { reviewers: newList });
      else updateSettings({ reviewers: newList });
    } else {
      const list = (activeSettings[type] || []) as string[];
      const newList = list.filter(v => v !== value);
      if (project) updateProjectConfig(project.id, { [type]: newList });
      else updateSettings({ [type]: newList });
    }
  };

  const removeRosterMember = async (person: Reviewer) => {
    if (!canSetupTeam) return;
    if (!kjx) { removeItem('reviewers', person.id); return; }
    if (!project || !window.confirm('Remove ' + person.name + ' from this project and clear their drawing assignments and defaults?')) return;
    try {
      const saved = await useStore.getState().saveProject(project.id, {manual:true});
      if (!saved) { alert('Save failed or awaits confirmation. Use Save Now before removing a member.'); return; }
      await projectsApi.deleteReviewer(project.id, person.id);
      await loadProject(project.id);
    } catch (error) { alert('Unable to remove reviewer: ' + String(error)); }
  };

  const updateDisciplineDefault = (discipline: string, reviewer: string) => {
    const next = { ...(activeSettings.disciplineDefaults || {}), [discipline]: reviewer };
    if (project) {
      updateProjectConfig(project.id, { disciplineDefaults: next });
    } else {
      updateSettings({ disciplineDefaults: next });
    }
  };

  const updatePolicy = (key: 'roundACycle' | 'otherRoundsCycle', val: number) => {
    if (project) {
      updateProjectConfig(project.id, { [key]: val });
    } else {
      updateSettings({ [key]: val });
    }
  };

  const handleLocalBackup = () => {
    if (!project) {
      alert("No active project to backup.");
      return;
    }
    downloadProjectBackup(project, reviewTracker);
  };

  const handleLocalRestore = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const payload = parseProjectBackup(content);
        restoreProject(payload.project);

        // 恢复 Review Tracker（如果导出中包含），并标记为脏数据
        if (payload.reviewTracker && Object.keys(payload.reviewTracker).length > 0) {
          const trackerDrawingIds = new Set(Object.keys(payload.reviewTracker));
          useStore.setState({
            reviewTracker: payload.reviewTracker,
            _dirtyTracker: true,
            _dirtyTrackerDrawingIds: trackerDrawingIds,
          });
        }

        const trackerInfo = payload._backupVersion && payload._backupVersion >= 2 ? ' (including Tracker)' : '';
        alert(`Project "${payload.project.name}" has been restored locally.${trackerInfo}\n\n⚠️ The data has only been restored locally. Use "Save to Cloud" to save it to the server.`);
      } catch (err) {
        alert("Restoration failed: " + (err instanceof Error ? err.message : "Malformed JSON file"));
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  // --- Platform Health Logic ---
  const healthStats = React.useMemo(() => {
    const totalReviewers = activeSettings.reviewers.length;
    const assignedDisciplines = activeDisciplines.filter(d => activeSettings.disciplineDefaults[d]);
    const assignmentCoverage = activeDisciplines.length > 0 ? (assignedDisciplines.length / activeDisciplines.length) * 100 : 0;
    const hasPassword = !!project?.conf.passwordSet;
    const hasHolidays = activeSettings.holidays.length > 0;

    return {
      roster: totalReviewers > 0,
      coverage: assignmentCoverage === 100,
      security: hasPassword,
      holidays: hasHolidays,
      score: [totalReviewers > 0, assignmentCoverage === 100, hasPassword, hasHolidays].filter(Boolean).length
    };
  }, [activeSettings, globalSettings, activeDisciplines]);

  return (
    <div data-testid="settings-page" className="settings-theme flex-1 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-200 animate-in fade-in slide-in-from-bottom-2 duration-300 p-6">
      <div className="max-w-7xl mx-auto space-y-6 pb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

          {/* Cloud Sync and Backup */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-teal-400 transition-colors">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <Database className="text-teal-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Project Settings</h2>
            </div>
            <div className="p-5 space-y-4">
              <h3 className={settingsStyles.label}>Data Management</h3>
              <div className="pt-2 space-y-3">
                <div className="text-[9px] font-black uppercase text-slate-400 ml-1">Hull: <span className="text-teal-600">{project?.name || 'Unset'}</span></div>



                {!kjx && <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={handleExecutePush}
                    disabled={isLoading || !project}
                    className="p-3 bg-[linear-gradient(135deg,#005c55_0%,#0f766e_100%)] text-white rounded-full text-[9px] font-black uppercase tracking-[0.18em] hover:brightness-105 disabled:opacity-50 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-[0_12px_24px_-16px_rgba(13,148,136,0.45)] border border-transparent"
                  >
                    <Send size={12} /> Save to Cloud
                  </button>
                  <button
                    onClick={async () => {
                      if (!activeProjectId) return;
                      const confirmed = window.confirm('⚠️ Warning: fetching from the cloud will overwrite local changes that have not been saved.\n\nContinue?');
                      if (!confirmed) return;
                      try {
                        await loadProject(activeProjectId);
                        alert('✅ Cloud fetch complete');
                      } catch (e: any) {
                        alert(`❌ Cloud fetch failed: ${e.message}`);
                      }
                    }}
                    disabled={isLoading || !project}
                    className="p-3 bg-white text-cyan-700 rounded-full text-[9px] font-black uppercase tracking-[0.18em] hover:bg-cyan-50 disabled:opacity-50 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm border border-cyan-100"
                  >
                    <Download size={12} /> Cloud Fetch
                  </button>
                </div>}

                <div className="h-px bg-slate-100 my-1" />

                {/* Visual Indicator of Config Scope */}
                {project ? (
                  <div className="p-2 bg-indigo-50 border border-indigo-100 rounded-xl text-center">
                    <div className="text-[9px] font-black uppercase text-indigo-600 tracking-widest flex items-center justify-center gap-1">
                      <ShieldCheck size={10} /> Editing: {project.name} Config
                    </div>
                  </div>
                ) : (
                  <div className="p-2 bg-slate-50 border border-slate-100 rounded-xl text-center">
                    <div className="text-[9px] font-black uppercase text-slate-400 tracking-widest">Global Default Config</div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  {(!kjx || isAdmin) && <button
                    onClick={handleLocalBackup}
                    disabled={!project}
                    className="p-3 bg-white border border-teal-100 text-teal-700 rounded-full text-[9px] font-black uppercase tracking-[0.18em] hover:bg-teal-50 transition-all active:scale-95 flex items-center justify-center gap-2 shadow-sm"
                  >
                    <Save size={12} /> Local Backup
                  </button>}
                  {!kjx && <><button
                    onClick={() => fileInputRef.current?.click()}
                    className="p-3 bg-[linear-gradient(135deg,#005c55_0%,#0f766e_100%)] text-white rounded-full text-[9px] font-black uppercase tracking-[0.18em] hover:brightness-105 transition-all active:scale-95 flex items-center justify-center gap-2 border border-transparent shadow-[0_12px_24px_-16px_rgba(13,148,136,0.45)]"
                  >
                    <Upload size={12} /> Local Restore
                  </button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleLocalRestore}
                    accept=".json"
                    className="hidden"
                  /></>}
                </div>

                <div className="h-px bg-slate-100 my-1" />

                {/* Fix Deadline Button */}
                {(!kjx || isAdmin) && <button
                  onClick={async () => {
                    if (!project) return;
                    const confirmed = window.confirm(
                      '🔧 Fix Deadline\n\n' +
                      'This recalculates the deadline of every drawing in Reviewing,\n' +
                      'based on when it last entered Reviewing.\n\n' +
                      (kjx ? 'Changes will be saved automatically.\n\n' : '⚠️ Note: after the fix, click "Save to Cloud" to save it to the server.\n\n') +
                      'Continue?'
                    );
                    if (!confirmed) return;

                    // 重新计算所有 Reviewing 图纸的 deadline
                    const conf = project.conf || data.settings;
                    let fixedCount = 0;

                    project.drawings.forEach(drawing => {
                      if (drawing.status === 'Reviewing') {
                        // 从 statusHistory 找到最后一次进入 Reviewing 的时间
                        const statusHistory = drawing.statusHistory || [];
                        const latestReviewingLog = [...statusHistory]
                          .reverse()
                          .find(log => log.content.includes('Status:') && log.content.includes('-> Reviewing'));
                        
                        if (latestReviewingLog) {
                          const startDate = new Date(latestReviewingLog.createdAt);
                          const cycleDays = reviewCycleDays(drawing.currentRound || 'A', conf);
                          const newDeadline = calculateDeadline(startDate, cycleDays, conf.holidays || []);
                          
                          // 更新 drawing
                          useStore.getState().updateDrawing(drawing.id, {
                            reviewDeadline: newDeadline.toISOString()
                          });
                          
                          fixedCount++;
                        }
                      }
                    });

                    const saved=kjx ? await useStore.getState().saveProject(project.id,{manual:true}) : false;
                    alert(kjx ? (saved ? `Updated ${fixedCount} drawing(s). Changes saved.` : `Updated ${fixedCount} drawing(s). Save failed or awaits confirmation; use Save Now to retry.`) : `✅ Fix complete.\n\nFixed the deadline of ${fixedCount} drawing(s).\n\nClick "Save to Cloud" to save it to the server.`);
                  }}
                  disabled={!project}
                  className="w-full p-3 bg-amber-500 text-white rounded-full text-[9px] font-black uppercase tracking-[0.18em] hover:bg-amber-600 disabled:opacity-50 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg"
                >
                  <RefreshCw size={12} /> Fix Deadline
                </button>}
              </div>
            </div>
            <div className="border-t border-slate-100 p-5 space-y-5">
              <h3 className={settingsStyles.label}>Project Configuration</h3>
              {/* Project Name */}
              <div className="space-y-2">
                <label htmlFor="config-report-name" className={settingsStyles.label}>Project Report Name</label>
                <input
                  type="text"
                  value={activeSettings.displayName || ''}
                  onChange={(e) => project && updateProjectConfig(project.id, { displayName: e.target.value })}
                  id="config-report-name" placeholder="CUSTOM DISPLAY TITLE"
                  disabled={!project}
                  className={settingsStyles.control}
                />
              </div>

              {/* Password: write-only local draft, never part of persisted project configuration. */}
              {!kjx && <div className="space-y-2">
                <label htmlFor="config-project-password" className={settingsStyles.label}>Project Password (Optional)</label>
                <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                  {project?.conf.passwordSet ? <Lock size={14} /> : <CheckCircle size={14} />}
                  <span>{project?.conf.passwordSet ? 'Set' : 'Not set'}</span>
                </div>
                <input
                  id="config-project-password"
                  type="password"
                  autoComplete="new-password"
                  value={passwordDraft}
                  onChange={event => setPasswordDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void savePassword(); } }}
                  placeholder={project?.conf.passwordSet ? 'Enter a new password to change it' : 'Enter a project password'}
                  disabled={!project || !isAdmin || passwordBusy}
                  className={settingsStyles.control}
                />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void savePassword()} disabled={!project || !isAdmin || passwordBusy || !passwordDraft.trim()}
                    className="rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
                    {passwordBusy ? 'Saving…' : project?.conf.passwordSet ? 'Change Password' : 'Set Password'}
                  </button>
                  <button type="button" onClick={() => void savePassword(true)} disabled={!project?.conf.passwordSet || !isAdmin || passwordBusy}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-40">Clear Password</button>
                </div>
                <p role="status" className="text-xs text-slate-600">{passwordNotice}</p>
                <p className="text-[9px] font-bold text-slate-400 leading-relaxed pl-1 max-w-md">
                  Administrators only; saved immediately. The password is never shown again and is not included in local backups. Changing or clearing it ends existing unlock sessions right away.
                </p>
              </div>}

              {/* Auto Sync - Visual Divider */}
              <div className="h-px bg-indigo-50" />

              {/* Auto Sync */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className={settingsStyles.label + ' flex items-center gap-1'}>
                    <Clock size={10} /> Auto-Sync Interval
                  </span>
                  <span className="text-[9px] font-[1000] text-teal-600 bg-teal-50 px-2 py-1 rounded-md">
                    15 min
                  </span>
                </div>
                <p className="text-xs text-slate-500">Fixed 15-minute autosave while editing; only pending changes are sent. Save Now remains available.</p>
              </div>
            </div>
          </section>

          {/* Review Team */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm relative z-20 flex flex-col hover:border-teal-400 transition-colors">
            <div className="px-5 py-4 rounded-t-[2rem] border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <Users className="text-teal-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Team Roster</h2>
            </div>
            <div className="p-5 space-y-3">
              {!kjx && <div className="flex gap-2">
                <input type="text" aria-label="New reviewer name" value={newReviewer} onChange={event => setNewReviewer(event.target.value)} placeholder="New Reviewer Name" className={settingsStyles.control} />
                <button type="button" aria-label="Add reviewer" disabled={!canSetupTeam || !newReviewer.trim()} onClick={() => addItem('reviewers', newReviewer, setNewReviewer)} className="rounded-full bg-teal-700 px-3 text-white disabled:opacity-50"><Plus size={14} /></button>
              </div>}
              <TeamRosterPicker projectId={activeProjectId || undefined} selected={roster} directory={kjx}
                disabled={!canSetupTeam} onAdd={addDirectoryReviewer} onRemove={removeRosterMember} />
            </div>
          </section>

          {/* Lead Assignees */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-indigo-400 transition-colors">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <UserCheck className="text-indigo-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Default Leads</h2>
            </div>
            <div className="p-5 overflow-x-auto">
              <table className="w-full table-fixed border-collapse text-left" aria-label="Default leads by discipline">
                <thead><tr className="border-b border-slate-200"><th scope="col" className={settingsStyles.label + ' w-2/5 pb-3 pr-3'}>Discipline</th><th scope="col" className={settingsStyles.label + ' pb-3'}>Lead</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {activeDisciplines.map(d => {
                    const stored = (activeSettings.disciplineDefaults || {})[d] || '';
                    const selected = roster.find(person => (kjx ? person.id : person.name) === stored || person.id === stored || person.name === stored);
                    return <tr key={d}>
                      <th scope="row" className="py-2 pr-3 text-[10px] font-black text-slate-600 break-words">{d}</th>
                      <td className="py-2"><select aria-label={'Select ' + d + ' lead'} disabled={!canSetupTeam}
                        value={selected ? (kjx ? selected.id : selected.name) : ''}
                        onChange={event => updateDisciplineDefault(d, event.target.value)} className={settingsStyles.control}>
                        <option value="">Unassigned</option>
                        {roster.map(person => <option key={person.id} value={kjx ? person.id : person.name}>{person.name}</option>)}
                      </select></td>
                    </tr>;
                  })}
                  {!activeDisciplines.length && <tr><td colSpan={2} className="py-8 text-center text-[10px] text-slate-500">No Disciplines</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          {/* Review Strategy Policy */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-amber-400 transition-colors">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <Clock className="text-amber-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Review Policy (WD)</h2>
            </div>
            <div className="p-6 flex-1 space-y-6">
              <div className="space-y-4">
                <div>
                  <label htmlFor="config-round-a" className={settingsStyles.label}>Round A Cycle (Working Days)</label>
                  <div className="flex items-center gap-4">
                    <input
                      id="config-round-a" type="range" min="1" max="30" step="1"
                      value={activeSettings.roundACycle}
                      onChange={(e) => updatePolicy('roundACycle', parseInt(e.target.value))}
                      className={settingsStyles.range}
                    />
                    <span className="text-lg font-[1000] text-amber-600 w-10">{activeSettings.roundACycle}</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="config-other-rounds" className={settingsStyles.label}>Subsequent Rounds Cycle</label>
                  <div className="flex items-center gap-4">
                    <input
                      id="config-other-rounds" type="range" min="1" max="21" step="1"
                      value={activeSettings.otherRoundsCycle}
                      onChange={(e) => updatePolicy('otherRoundsCycle', parseInt(e.target.value))}
                      className={settingsStyles.range}
                    />
                    <span className="text-lg font-[1000] text-amber-600 w-10">{activeSettings.otherRoundsCycle}</span>
                  </div>
                </div>
              </div>
              <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100">
                <p className="text-[9px] font-bold text-amber-700 leading-relaxed uppercase tracking-tight">
                  <Info size={12} className="inline mr-1 -mt-0.5" /> Deadlines exclude weekends and configured public holidays.
                </p>
              </div>
            </div>
          </section>

          {/* Public Holidays */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-red-400 transition-colors">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <CalendarDays className="text-red-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Public Holidays</h2>
            </div>
            <div className="p-5 flex-1 flex flex-col gap-4 min-h-0">
              <div className="flex gap-1.5 shrink-0">
                <input
                  aria-label="New public holiday" type="date" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)}
                  className={settingsStyles.control}
                />
                <button onClick={() => addItem('holidays', newHoliday, setNewHoliday)} className="p-2 bg-[linear-gradient(135deg,#005c55_0%,#0f766e_100%)] text-white rounded-full hover:brightness-105 active:scale-95 transition-all shadow-[0_10px_20px_-14px_rgba(13,148,136,0.45)]"><Plus size={16} /></button>
              </div>
              <div className="grid grid-cols-1 gap-1.5 overflow-y-auto pr-1 scrollbar-thin flex-1">
                {(activeSettings.holidays || []).sort().map(h => (
                  <div key={h} className="flex items-center justify-between p-2.5 bg-white border border-slate-100 rounded-xl group hover:border-red-400 transition-all shrink-0">
                    <span className="text-[10px] font-black text-slate-700">{format(new Date(h), 'yyyy-MM-dd')}</span>
                    <button onClick={() => removeItem('holidays', h)} className="text-slate-200 hover:text-red-500 transition-colors"><Trash2 size={12} /></button>
                  </div>
                ))}
                {(activeSettings.holidays || []).length === 0 && (
                  <div className="text-center py-10 opacity-30 text-[9px] font-black uppercase tracking-widest">No Holidays Logged</div>
                )}
              </div>
            </div>
          </section>

          {/* Platform Health Diagnostic */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-indigo-400 transition-colors">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <HeartPulse className="text-indigo-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Platform Health</h2>
            </div>
            <div className="p-6 flex-1 space-y-4">
              <div className="flex flex-col gap-3">
                <HealthItem label="Team Roster" active={healthStats.roster} subText={`${activeSettings.reviewers.length} Reviewers Loaded`} />
                <HealthItem label="Discipline Defaults" active={healthStats.coverage} subText={healthStats.coverage ? 'Full Assignment Coverage' : 'Missing Default Leads'} />
                <HealthItem label="Project Protection" active={kjx || healthStats.security} subText={kjx ? 'Team membership enforced' : (healthStats as any).security ? 'Secure Access Enabled' : 'Public Access Mode'} />
                <HealthItem label="Holiday Policy" active={healthStats.holidays} subText={healthStats.holidays ? `${activeSettings.holidays.length} Dates Configured` : 'Using Standard Calendar'} />
              </div>

              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="text-[9px] font-black uppercase text-slate-400 mb-2 tracking-widest">Config Integrity Score</div>
                <div className="flex gap-1.5">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className={`flex-1 h-2 rounded-full transition-all duration-1000 ${i <= healthStats.score ? 'bg-indigo-500 shadow-lg shadow-indigo-500/20' : 'bg-slate-100'}`} />
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Project Summary (Ship Milestones) */}
          <section className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-violet-400 transition-colors col-span-1 md:col-span-2 lg:col-span-3">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
              <Calendar className="text-violet-600" size={16} />
              <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Project Summary &amp; Ship Milestones</h2>
            </div>
            <div className="p-5 space-y-4">
              {/* Info Row: Ship Owner & Update Date */}
              <div className="flex flex-col md:flex-row gap-4">
                <div className="flex items-center gap-4 flex-1">
                  <label htmlFor="config-ship-owner" className={settingsStyles.label}>Ship Owner</label>
                  <input
                    type="text"
                    value={project?.conf?.projectSummary?.shipOwner || ''}
                    onChange={(e) => project && updateProjectConfig(project.id, {
                      projectSummary: { ...project.conf.projectSummary, ships: project.conf.projectSummary?.ships || [], shipOwner: e.target.value }
                    })}
                    id="config-ship-owner" placeholder="e.g. COSCO SHIPPING"
                    disabled={!project}
                    className={settingsStyles.control}
                  />
                </div>
                <div className="flex items-center gap-4 flex-1">
                  <label htmlFor="config-milestone-update" className={settingsStyles.label}>Milestone Update</label>
                  <input
                    type="date"
                    id="config-milestone-update" value={project?.conf?.projectSummary?.milestoneUpdateDate || ''}
                    onChange={(e) => project && updateProjectConfig(project.id, {
                      projectSummary: { ...project.conf.projectSummary, ships: project.conf.projectSummary?.ships || [], milestoneUpdateDate: e.target.value }
                    })}
                    disabled={!project}
                    className={settingsStyles.control}
                  />
                </div>
              </div>

              {/* Ships Table */}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b-2 border-slate-200">
                      <th className="px-3 py-2 text-left text-[8px] font-black text-slate-500 uppercase tracking-wider">Hull No.</th>
                      <th className="px-3 py-2 text-center text-[8px] font-black text-slate-500 uppercase tracking-wider">Steel Cutting</th>
                      <th className="px-3 py-2 text-center text-[8px] font-black text-slate-500 uppercase tracking-wider">Keel Laying</th>
                      <th className="px-3 py-2 text-center text-[8px] font-black text-slate-500 uppercase tracking-wider">Launching</th>
                      <th className="px-3 py-2 text-center text-[8px] font-black text-slate-500 uppercase tracking-wider">Delivery</th>
                      <th className="px-3 py-2 text-center text-[8px] font-black text-slate-500 uppercase tracking-wider">Contract Delivery</th>
                      <th className="px-1 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(project?.conf?.projectSummary?.ships || []).map((ship, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-3 py-1.5">
                          <input aria-label={'Ship ' + (idx + 1) + ' hull number'} type="text" value={ship.hullNumber} placeholder="H1234"
                            onChange={(e) => {
                              if (!project) return;
                              const ships = [...(project.conf.projectSummary?.ships || [])];
                              ships[idx] = { ...ships[idx], hullNumber: e.target.value };
                              updateProjectConfig(project.id, { projectSummary: { ...project.conf.projectSummary, ships } });
                            }}
                            className={settingsStyles.control}
                          />
                        </td>
                        {(['steelCutting', 'keelLaying', 'launching', 'delivery', 'contractDelivery'] as const).map(field => (
                          <td key={field} className="px-3 py-1.5">
                            <input aria-label={'Ship ' + (idx + 1) + ' ' + field} type="date" value={ship[field] || ''}
                              onChange={(e) => {
                                if (!project) return;
                                const ships = [...(project.conf.projectSummary?.ships || [])];
                                ships[idx] = { ...ships[idx], [field]: e.target.value };
                                updateProjectConfig(project.id, { projectSummary: { ...project.conf.projectSummary, ships } });
                              }}
                              className={settingsStyles.control}
                            />
                          </td>
                        ))}
                        <td className="px-1 py-1.5">
                          <button onClick={() => {
                            if (!project) return;
                            const ships = (project.conf.projectSummary?.ships || []).filter((_, i) => i !== idx);
                            updateProjectConfig(project.id, { projectSummary: { ...project.conf.projectSummary, ships } });
                          }} className="text-slate-200 hover:text-red-500 transition-colors"><Trash2 size={12} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                onClick={() => {
                  if (!project) return;
                  const ships = [...(project.conf.projectSummary?.ships || []), { hullNumber: '' }];
                  updateProjectConfig(project.id, { projectSummary: { ...project.conf.projectSummary, ships } });
                }}
                disabled={!project}
                className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-violet-700 disabled:opacity-50 transition-all active:scale-95"
              >
                <Plus size={12} /> Add Ship
              </button>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
};

const HealthItem = ({ label, active, subText }: { label: string, active: boolean, subText: string }) => (
  <div className="flex items-center gap-4 group">
    <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border transition-all ${active ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-slate-50 text-slate-300 border-slate-100'}`}>
      {active ? <CheckCircle size={16} /> : <Activity size={16} />}
    </div>
    <div className="flex flex-col">
      <span className={`text-[10px] font-black uppercase tracking-widest ${active ? 'text-slate-900' : 'text-slate-400'}`}>{label}</span>
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">{subText}</span>
    </div>
  </div>
);
