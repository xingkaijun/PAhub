import { apiClient } from './services/api/apiClient';
import { isProjectNotFound, projectsApi } from './services/api/projectsApi';
import { createDebouncedSave } from './lib/auto-save';


import React, { Suspense, lazy, useMemo, useState, useEffect } from 'react';
import { useStore } from './store';
import { DrawingList } from './components/DrawingList';
import { CommandBar } from './components/CommandBar';

import { ErrorBoundary } from './components/ErrorBoundary';
import { UnsavedChangesIndicator } from './components/UnsavedChangesIndicator';
import { SaveStatusBar } from './components/SaveStatusBar';
import { AdminLoginDialog } from './components/AdminLoginDialog';
import { IdentityMenu, AuthNotice } from './components/IdentityMenu';
import {
  FileStack,
  Settings as SettingsIcon,
  ChevronDown,
  Layers,
  Code,
  Cloud,
  CloudOff,
  LayoutDashboard,
  TrendingUp,
  BookOpen,
  Lock,
  Unlock,
  ChevronLeft,
  ChevronRight,
  Calendar,
  ClipboardCheck,
  MessageSquare
} from 'lucide-react';
import { ProjectLobby, type RequestProjectPassword } from './components/lobby/ProjectLobby';
import { toLobbyCards } from './components/lobby/lobbyModel';

const Settings = lazy(() => import('./components/Settings').then(module => ({ default: module.Settings })));
const DailyLogReport = lazy(() => import('./components/DailyLogReport').then(module => ({ default: module.DailyLogReport })));
const ActivityReport = lazy(() => import('./components/ActivityReport').then(module => ({ default: module.ActivityReport })));
const ReviewTracker = lazy(() => import('./components/ReviewTracker').then(module => ({ default: module.ReviewTracker })));
const Manual = lazy(() => import('./components/Manual').then(module => ({ default: module.Manual })));
const Comments = lazy(() => import('./components/Comments').then(module => ({ default: module.Comments })));

const LazyTabFallback: React.FC = () => (
  <div className="flex-1 flex items-center justify-center bg-white/60">
    <div className="text-center">
      <div className="mx-auto mb-3 h-10 w-10 rounded-full border-2 border-teal-200 border-t-teal-600 animate-spin" />
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">Loading Module</p>
    </div>
  </div>
);

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'drawings' | 'activity' | 'dailylog' | 'settings' | 'manual' | 'tracker' | 'comments'>('drawings');
  const data = useStore(state => state.data);
  const activeProjectId = useStore(state => state.activeProjectId);
  const setActiveProject = useStore(state => state.setActiveProject);
  const addProject = useStore(state => state.addProject);
  const isLoading = useStore(state => state.isLoading);
  const fetchProjectList = useStore(state => state.fetchProjectList);
  const loadProject = useStore(state => state.loadProject);
  const saveProject = useStore(state => state.saveProject);
  const fetchGlobalSettings = useStore(state => state.fetchGlobalSettings);
  const isEditMode = useStore(state => state.isEditMode);
  const session = useStore(state => state.session);
  const canConfigure = useStore(state => state.session?.mode==='kjx' ? state.can('project.settings') : state.can('settings.write'));
  const refreshSession = useStore(state => state.refreshSession);
  const logoutAdmin = useStore(state => state.logoutAdmin);
  const hasUnsavedChanges = useStore(state => state.hasUnsavedChanges());
  const getUnsavedChangesCount = useStore(state => state.getUnsavedChangesCount());
  const saveConflict = useStore(state => state.saveConflict);
  const clearSaveConflict = useStore(state => state.clearSaveConflict);
  const projectNotice = useStore(state => state.projectNotice);
  const clearProjectNotice = useStore(state => state.clearProjectNotice);
  const currentProject = useMemo(
    () => data.projects.find(p => p.id === activeProjectId),
    [data.projects, activeProjectId]
  );

  const [showProjectSelector, setShowProjectSelector] = useState(true);
  // Project Access Hall: stays mounted while its opening motion plays over the workspace.
  const [lobbyLaunching, setLobbyLaunching] = useState(false);
  const [resumeProjectId, setResumeProjectId] = useState<string>();
  const [startupReady, setStartupReady] = useState(false);
  const lobbyCards = useMemo(
    () => toLobbyCards((session?.mode==='kjx' && !startupReady ? [] : data.projects).map(p => ({
      id: p.id,
      name: p.name,
      drawingCount: p.drawings?.length || 0,
      approvedCount: p.drawings?.filter(d => d.status === 'Approved').length || 0,
      lastUpdated: p.lastUpdated,
      locked: session?.mode !== 'kjx' && !!(p.passwordProtected || p.conf?.passwordSet),
    }))),
    [data.projects,session?.mode,startupReady]
  );
  const lobbyVisible = showProjectSelector || lobbyLaunching;
  const [remoteUpdateCount, setRemoteUpdateCount] = useState(0);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  useEffect(() => {
    if (!canConfigure && activeTab === 'settings') setActiveTab('drawings');
  }, [canConfigure, activeTab]);

  // 1. Startup Logic: Server First - FETCH LIST ONLY
  useEffect(() => {
    const initApp = async () => {
      // If we have an active project persisted, we might want to clear it or let user re-select?
      // Requirement: "Before loading project do not enter main page". So we force selection.
      // We don't wipe store, but we require selection.

      useStore.setState({ isLoading: true });
      try {
        // The server, not a build-time password, decides who is an administrator.
        await refreshSession();
        // Try to fetch Server List
        await fetchGlobalSettings();
        await fetchProjectList();
        const state = useStore.getState();
        const query = new URLSearchParams(window.location.search);
        const requested = query.get('project') || query.get('projectId');
        const last = state.data.projects.find(p => p.id === (requested || state.activeProjectId));
        // A protected deep link / last project must never reveal its persisted payload before server authorization.
        if (last && (requested || last.passwordProtected || last.conf?.passwordSet)) setResumeProjectId(last.id);
        setStartupReady(true);
        console.log("Server list fetched. Ready for selection.");
      } catch (err) {
        console.error("Server connection failed", err);
        // Do not auto-offline. Let user choose in Selector (which will show emptiness + Offline button)
      } finally {
        useStore.setState({ isLoading: false });
      }
    };

    initApp();
  }, []);

  /** The lobby owns the challenge UI; the server owns password verification and unlock cookies. */
  const handleSelectProject = async (projectId: string, opts: {
    requestPassword: RequestProjectPassword; signal: AbortSignal;
  }): Promise<boolean> => {
    // Check for unsaved changes before switching projects
    const hasUnsaved = useStore.getState().hasUnsavedChanges();
    if(hasUnsaved && activeProjectId && projectId!==activeProjectId){
      if(useStore.getState().session?.mode==='kjx'){
        const saved=await saveProject(activeProjectId,{manual:true});
        if(!saved || useStore.getState().hasUnsavedChanges()){alert('Switch blocked: current workspace has unsaved changes. Retry saving before switching.');return false;}
      }else{
        const confirmSwitch=window.confirm('You have unsaved changes in the current project. Switching projects will discard these changes.\n\nWould you like to save the current project first?\n\nClick "OK" to save and switch, or "Cancel" to switch without saving (changes will be lost).');
        if(confirmSwitch){const saved=await saveProject(activeProjectId);if(!saved){alert('Save failed. Please try again or choose to switch without saving.');return false;}}
        else if(!window.confirm('Are you sure you want to discard unsaved changes? This action cannot be undone.'))return false;
      }
    }

    for (;;) {
      useStore.setState({ isLoading: true });
      try {
        opts.signal.throwIfAborted();
        await loadProject(projectId, undefined, opts.signal);
        opts.signal.throwIfAborted();
        setShowProjectSelector(false);
        setActiveProject(projectId);
        setResumeProjectId(undefined);
        return true;
      } catch (e: any) {
        if (opts.signal.aborted || e.name === 'AbortError') return false;
        if (e.message === 'PASSWORD_REQUIRED') {
          useStore.setState({ isLoading: false });
          let error: string | undefined;
          for (;;) {
            const password = await opts.requestPassword(error);
            if (password === null || opts.signal.aborted) { setResumeProjectId(undefined); return false; }
            try {
              await projectsApi.unlockProject(projectId, password, opts.signal);
              break;
            } catch (unlockError: any) {
              if (opts.signal.aborted) return false;
              error = unlockError.message === 'INVALID_PASSWORD' ? 'Incorrect password. Please try again.' : unlockError.status === 429
                ? 'Too many attempts. Please try again in 10 minutes.' : 'Unlock failed. Please try again.';
            }
          }
          continue;
        }
        if (isProjectNotFound(e)) {
          // The store shows the "project does not exist" notice; stay on the selector. The local entry is kept
          // (it may hold work that never reached the server), it is just not opened.
          setShowProjectSelector(true);
        } else {
          alert('Failed to load project: ' + e.message);
        }
        return false;
      } finally {
        useStore.setState({ isLoading: false });
      }
    }
  };

  useEffect(() => {
    const locked = (event: Event) => {
      const id = (event as CustomEvent<{ projectId: string }>).detail?.projectId;
      if (!id || lobbyVisible || id !== activeProjectId) return;
      setResumeProjectId(id);
      setShowProjectSelector(true);
    };
    window.addEventListener('pahub:project-locked', locked);
    return () => window.removeEventListener('pahub:project-locked', locked);
  }, [activeProjectId, lobbyVisible]);

  useEffect(()=>{
    const denied=()=>{setShowProjectSelector(true);setResumeProjectId(undefined);void useStore.getState().fetchProjectList();};
    window.addEventListener('pahub:project-access-denied',denied);
    return()=>window.removeEventListener('pahub:project-access-denied',denied);
  },[]);
  const handleOfflineMode = () => {
    setShowProjectSelector(false);
  };

  // ... (handleProjectSwitch remains same)

  // Save three seconds after the last local edit; the minute timer below remains a retry fallback.
  useEffect(() => {
    if (!activeProjectId || showProjectSelector || !isEditMode) return;
    const projectId = activeProjectId;
    const debounced = createDebouncedSave(() => {
      const state = useStore.getState();
      if (state.activeProjectId === projectId && state.isEditMode && state.hasUnsavedChanges() && !state.isLoading) void state.saveProject(projectId);
    });
    if (useStore.getState().hasUnsavedChanges()) debounced.changed();
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.activeProjectId !== projectId || !state.isEditMode) return;
      if (state._dirtyDrawingFields !== previous._dirtyDrawingFields || state._deletedDrawingIds !== previous._deletedDrawingIds ||
          state._dirtyConf && state.data !== previous.data || state._dirtyTracker && state.reviewTracker !== previous.reviewTracker || previous.isLoading && !state.isLoading && state.hasUnsavedChanges()) debounced.changed();
    });
    return () => { unsubscribe(); debounced.cancel(); };
  }, [activeProjectId, showProjectSelector, isEditMode]);

  // 3. Auto-Save Logic (Configurable Interval)
  useEffect(() => {
    if (!activeProjectId || showProjectSelector) return;

    const activeProject = data.projects.find(p => p.id === activeProjectId);
    const configInterval = activeProject?.conf?.autoSyncInterval;
    const globalInterval = data.settings.autoSyncInterval;
    const intervalMinutes = configInterval ?? globalInterval ?? 3;

    void useStore.getState().refreshPcfPresence(activeProjectId);
    if (intervalMinutes <= 0) return; // Disable auto-sync if set to 0
    const interval = setInterval(async () => {
      void useStore.getState().refreshPcfPresence(activeProjectId);
      // 只有拥有编辑权限 (isEditMode) 时，才将本地数据推送到服务端覆写
      if (isEditMode) {
        console.log(`[Edit Mode] Auto-saving current project to server (Interval: ${intervalMinutes}m)...`);
        await saveProject(activeProjectId);
      } else {
        // 全局只读模式下，不仅禁止推送（避免覆盖），同时从服务端静默拉取最新数据
        // 如果本地有任何待保存状态（drawing / conf / tracker），跳过拉取以避免覆盖
        const state = useStore.getState();
        const hasPending = state._dirtyDrawingIds.size > 0 || state._deletedDrawingIds.size > 0 || state._dirtyConf || state._dirtyTracker;
        if (hasPending) {
          console.log(`[Read-Only Mode] Skipping auto-fetch: local unsaved changes pending.`);
          return;
        }
        console.log(`[Read-Only Mode] Auto-fetching latest data from server (Interval: ${intervalMinutes}m)...`);
        await loadProject(activeProjectId).catch(e => {
          console.warn('Auto-fetch in read-only mode failed:', e.message);
        });
      }
    }, intervalMinutes * 60 * 1000);

    return () => clearInterval(interval);
  }, [activeProjectId, showProjectSelector, data.settings.autoSyncInterval, currentProject?.conf?.autoSyncInterval, currentProject?.conf?.passwordSet, isEditMode, loadProject, saveProject]);

  useEffect(() => {
    // One stream per open project, kept across tab switches (switching tabs used to drop and reopen it, refetching everything).
    if (import.meta.env.MODE !== 'hub' || !activeProjectId || showProjectSelector) return;
    const projectId = activeProjectId;
    const url = projectsApi.eventsUrl(projectId);
    let closed = false, retryDelay = 1000, retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined, mergeTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined, source: EventSource | undefined;
    const changedIds = new Set<string>();
    const refreshPresence = () => { if (!document.hidden) void useStore.getState().refreshPcfPresence(projectId); };
    const enablePoll = () => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(refreshPresence, document.hidden ? 60000 : 15000);
    };
    const stopPoll = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = undefined; };
    // Conditional (ETag) read: when nothing changed the server answers 304 and nothing is merged.
    const fullRefresh = () => {
      void useStore.getState().refreshProjectPreservingDirty(projectId).catch(() => {});
      refreshPresence();
    };
    // A whole-project save announces every drawing; past this many ids one conditional full read is cheaper.
    const MAX_BY_ID = 200;
    const event = (name: string, data: any) => {
      if (closed) return;
      if (name === 'presence' && data?.drawings) {
        if (useStore.getState().activeProjectId === projectId) useStore.setState({ pcfPresence: data.drawings });
      } else if (name === 'drawing-changed' && typeof data?.drawingId === 'string') {
        changedIds.add(data.drawingId);
        if (!mergeTimer) mergeTimer = setTimeout(async () => {
          mergeTimer = undefined;
          const ids = [...changedIds]; changedIds.clear();
          const store = useStore.getState();
          // Only the drawings that changed; fall back to a full (conditional) read if that fails or the batch is huge.
          const merged = ids.length > MAX_BY_ID
            ? await store.refreshProjectPreservingDirty(projectId).catch(() => 0)
            : await store.refreshDrawingsPreservingDirty(projectId, ids).catch(() => store.refreshProjectPreservingDirty(projectId).catch(() => 0));
          if (!closed && ids.length > 0 && merged >= 0) setRemoteUpdateCount(ids.length);
        }, 100);
      }
    };
    const reconnect = () => {
      if (closed || retryTimer) return;
      enablePoll();
      retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, retryDelay);
      retryDelay = Math.min(30000, retryDelay * 2);
    };
    const connectFetch = async () => {
      controller = new AbortController();
      try {
        const response = await projectsApi.openEvents(projectId, controller.signal);
        if (!response.ok || !response.body) throw Error('Project event stream unavailable');
        retryDelay = 1000; stopPoll(); fullRefresh();
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!closed) {
          const part = await reader.read(); if (part.done) break;
          buffer += decoder.decode(part.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const type = frame.match(/^event: (.+)$/m)?.[1]; const payload = frame.match(/^data: (.+)$/m)?.[1];
            if (type && payload) { try { event(type, JSON.parse(payload)); } catch {} }
          }
        }
        if (!closed) throw Error('Project event stream ended');
      } catch { if (!closed) reconnect(); }
    };
    function connect() {
      if (closed) return;
      if (apiClient.hasToken()) { void connectFetch(); return; }
      source = new EventSource(url);
      source.addEventListener('presence', e => { try { event('presence', JSON.parse((e as MessageEvent).data)); } catch {} });
      source.addEventListener('drawing-changed', e => { try { event('drawing-changed', JSON.parse((e as MessageEvent).data)); } catch {} });
      source.onopen = () => { retryDelay = 1000; stopPoll(); fullRefresh(); };
      source.onerror = () => { source?.close(); source = undefined; if (useStore.getState().session?.mode === 'kjx') {void useStore.getState().refreshSession();void useStore.getState().fetchProjectList();} reconnect(); };
    }
    const onVisibility = () => {
      if (document.hidden) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = setInterval(refreshPresence, 60000); }
      } else { fullRefresh(); if (pollTimer) { clearInterval(pollTimer); pollTimer = setInterval(refreshPresence, 15000); } }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // The project was just loaded; the first open of the stream does the (conditional) catch-up read.
    refreshPresence(); connect();
    return () => {
      closed = true; source?.close(); controller?.abort(); stopPoll();
      if (retryTimer) clearTimeout(retryTimer); if (mergeTimer) clearTimeout(mergeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeProjectId, showProjectSelector]);


  const handleGlobalRefresh = async () => {
    useStore.setState({ isLoading: true });
    try {
      await fetchProjectList();
    } catch (e) {
      console.error(e);
    } finally {
      useStore.setState({ isLoading: false });
    }
  };

  const handleAddProject = async () => {
    const name = prompt('Enter Hull Number or Project Name (e.g. PG-VLEC-H2684):');
    if (name) {
      const beforeIds = new Set(useStore.getState().data.projects.map(project => project.id));
      addProject(name);
      const newProject = useStore.getState().data.projects.find(project => !beforeIds.has(project.id));
      if (!newProject) return;
      const saved = await saveProject(newProject.id,{manual:true});
      if (!saved) { alert('Workspace was not saved. Reload and try again.'); return; }
      await loadProject(newProject.id);
      setActiveProject(newProject.id);
      setShowProjectSelector(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-[radial-gradient(circle_at_top,_rgba(156,242,232,0.22),_transparent_28%),linear-gradient(180deg,#f4fbfa_0%,#f7fafc_34%,#eefaf7_100%)] text-slate-900 selection:bg-teal-100 selection:text-teal-900 font-sans overflow-hidden">

      <style>{`
        @media print {
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>

      {projectNotice && (
        <div role="alert" data-testid="project-not-found" className="fixed left-1/2 top-4 z-[10001] flex w-[min(92vw,640px)] -translate-x-1/2 items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-900 shadow-lg">
          <span>{projectNotice.message}</span>
          {projectNotice.requiresReload && <button className="shrink-0 rounded border border-rose-300 px-2 py-1" onClick={() => { if (!window.confirm('Discard unsaved changes and reload this workspace?')) return; useStore.setState({ _dirtyDrawingIds: new Set(), _dirtyDrawingFields: {}, _dirtyDrawingBase: {}, _deletedDrawingIds: new Set(), _dirtyConf: false, _dirtyConfKeys: new Set(), _dirtyConfBase: {}, _dirtyTracker: false, _dirtyTrackerDrawingIds: new Set(), reviewTracker: {} }); window.location.reload(); }}>Reload workspace</button>}
          <button className="shrink-0 rounded px-2 py-1 text-rose-800 hover:bg-white/70" onClick={clearProjectNotice} aria-label="Dismiss project notice">×</button>
        </div>
      )}
      {/* Project Access Hall (project selector) */}
      {lobbyVisible && (
        <ProjectLobby
          cards={lobbyCards}
          loading={isLoading}
          open={showProjectSelector}
          logoSrc="/pg-logo.jpg"
          manualHref="/manual/"
          showNoProjectsNote={data.projects.length === 0}
          autoSelectId={startupReady ? resumeProjectId : undefined}
          onSelect={(id, _motionSettled, requestPassword, signal) => handleSelectProject(id, { requestPassword, signal })}
          canCreate={session?.mode !== 'kjx' || Boolean(session.permissions?.includes('project.create'))}
          onCreate={handleAddProject}
          onRefresh={handleGlobalRefresh}
          onOffline={handleOfflineMode}
          onLaunchStart={() => setLobbyLaunching(true)}
          onLaunchEnd={() => setLobbyLaunching(false)}
        />
      )}
      {/* Full Screen Loading Overlay */}
      {isLoading && !lobbyVisible && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/20 backdrop-blur-md animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl border-2 border-teal-200 shadow-2xl p-8 max-w-md mx-4">
            <div className="flex flex-col items-center gap-4">
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 border-4 border-teal-100 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-teal-600 rounded-full border-t-transparent animate-spin"></div>
                <Cloud className="absolute inset-0 m-auto text-teal-600 animate-pulse" size={28} />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-[1000] text-slate-900 uppercase tracking-wider mb-2">Syncing Data</h3>
                <p className="text-sm font-bold text-slate-500 uppercase tracking-widest">Synchronizing with Server...</p>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-teal-500 to-teal-600 rounded-full animate-pulse w-full"></div>
              </div>
              <p className="text-xs text-slate-400 text-center mt-2">Uploading/Downloading latest project data</p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Header */}
      <header className="relative overflow-hidden bg-[rgba(15,118,110,0.88)] backdrop-blur-2xl border-b border-white/10 px-6 py-4 flex items-center justify-between z-[60] no-print shrink-0 shadow-[0_24px_48px_-12px_rgba(19,27,46,0.16)]">
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.16),transparent_36%,rgba(156,242,232,0.14)_100%)] pointer-events-none" />

        <div className="relative flex items-center min-w-0 z-[1]">
          {/* Logo Section */}
          <div className="flex items-center gap-4 group cursor-pointer shrink-0" onClick={() => setActiveTab('drawings')}>
            <div className="relative">
              <div className="bg-white/95 p-1.5 rounded-2xl shadow-lg border border-white/40 transition-transform group-hover:scale-105 active:scale-95 overflow-hidden">
                <img
                  src="/pg-logo.jpg"
                  alt="PG SHIPMANAGEMENT PTE. LTD. Logo"
                  className="h-8 w-auto object-contain"
                />
              </div>
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="text-lg font-[1000] text-white tracking-tighter leading-none uppercase whitespace-nowrap">
                PLAN APPROVAL <span className="text-[#9CF2E8]">PLATFORM</span>
              </h1>
              <span className="text-[8px] font-black text-teal-100/75 uppercase tracking-[0.35em] mt-1">Technical Intelligence System</span>
            </div>
          </div>
        </div>

        <div className="hidden md:flex flex-1 min-w-0 items-center justify-center px-4 z-[1]">
          {/* Main Navigation Tabs */}
          <nav className="flex items-center gap-1 bg-black/15 backdrop-blur-sm p-1 rounded-full border border-white/10 shadow-inner shadow-black/10 min-w-0 max-w-full overflow-x-auto">
            <button
              onClick={() => setActiveTab('drawings')}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'drawings' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
            >
              <FileStack size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'drawings' ? 'text-teal-600' : 'text-teal-50/75'}`} />
              <span className="hidden xl:inline">Inventory</span>
            </button>
            <button
              onClick={() => setActiveTab('activity')}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'activity' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
              title="Activity Report"
            >
              <TrendingUp size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'activity' ? 'text-teal-600' : 'text-teal-50/75'}`} />
              <span className="hidden xl:inline">Activity</span>
            </button>
            <button
              onClick={() => setActiveTab('dailylog')}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'dailylog' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
              title="Daily Change Log"
            >
              <Calendar size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'dailylog' ? 'text-teal-600' : 'text-teal-50/75'}`} />
              <span className="hidden xl:inline">Log</span>
            </button>
            <button
              onClick={() => setActiveTab('tracker')}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'tracker' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
            >
              <ClipboardCheck size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'tracker' ? 'text-teal-600' : 'text-teal-50/75'}`} />
              <span className="hidden xl:inline">Tracker</span>
            </button>
            <button
              onClick={() => setActiveTab('comments')}
              aria-label="Comments"
              aria-current={activeTab === 'comments' ? 'page' : undefined}
              title="Comments register"
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'comments' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
            >
              <MessageSquare size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'comments' ? 'text-teal-600' : 'text-teal-50/75'}`} />
              <span className="hidden xl:inline">Comments</span>
            </button>
            <button
              onClick={() => canConfigure && setActiveTab('settings')}
              disabled={!canConfigure}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'settings' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : !isEditMode ? 'text-white/35 cursor-not-allowed opacity-70' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
              title={!isEditMode ? "Administrator permission required" : "Configuration"}
            >
              {!isEditMode ? <Lock size={14} className="text-white/40 shrink-0" /> : <SettingsIcon size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'settings' ? 'text-teal-600' : 'text-teal-50/75'}`} />}
              <span className="hidden xl:inline">Config</span>
            </button>
            <button
              onClick={() => setActiveTab('manual')}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'manual' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
            >
              <BookOpen size={14} strokeWidth={2.5} className={`shrink-0 ${activeTab === 'manual' ? 'text-teal-600' : 'text-teal-50/75'}`} />
              <span className="hidden xl:inline">Guide</span>
            </button>
          </nav>
        </div>

        <div className="relative flex items-center gap-3 shrink-0 z-[1]">
          <IdentityMenu />
          {session?.mode !== 'kjx' && <button
            onClick={() => isEditMode ? void logoutAdmin() : setShowAdminLogin(true)}
            title={isEditMode ? 'Sign out of the administrator session' : 'Administrator permission required'}
            aria-pressed={isEditMode}
            data-admin-session={isEditMode ? 'admin' : 'reviewer'}
            className={`flex items-center gap-2 px-3 xl:px-4 py-2 rounded-full border text-[10px] font-[1000] uppercase tracking-[0.15em] shadow-lg transition-all active:scale-[0.98] ${isEditMode ? 'bg-amber-100/95 text-amber-800 border-amber-200 hover:bg-amber-200' : 'bg-white/10 text-teal-50/85 border-white/15 hover:bg-white/15'}`}
          >
            {isEditMode ? <Unlock size={14} strokeWidth={2.5} className="shrink-0" /> : <Lock size={14} strokeWidth={2.5} className="shrink-0" />}
            <span className="hidden xl:inline">{isEditMode ? 'Administrator' : 'Reviewer'}</span>
          </button>}
          {/* Phones have no tab bar: the manual opens as its own page */}
          <a
            href="/manual/"
            target="_blank"
            rel="noopener"
            title="Guide"
            aria-label="Guide"
            data-testid="mobile-manual-link"
            className="md:hidden inline-flex items-center justify-center p-2 rounded-full border border-white/15 bg-white/10 text-white/85 hover:bg-white hover:text-teal-700 transition-all shrink-0"
          >
            <BookOpen size={14} strokeWidth={2.5} />
          </a>
          <div className="relative">
            <button
              onClick={() => setShowProjectSelector(true)}
              className="flex items-center gap-2 px-3 xl:px-5 py-2 rounded-full border border-white/15 bg-white/10 hover:bg-white/15 text-white shadow-lg shadow-teal-950/10 transition-all active:scale-[0.98] text-[10px] font-[1000] uppercase tracking-[0.15em]"
            >
              {/* Unsaved changes badge */}
              {hasUnsavedChanges && (
                <div className="absolute -top-1 -right-1 z-10">
                  <div className="relative">
                    <div className="w-5 h-5 bg-gradient-to-br from-teal-400 to-teal-600 rounded-full flex items-center justify-center text-[9px] font-black text-white shadow-lg border-2 border-white">
                      {getUnsavedChangesCount}
                    </div>
                    <div className="absolute inset-0 w-5 h-5 bg-teal-400 rounded-full animate-ping opacity-75" />
                  </div>
                </div>
              )}
              <Layers size={14} strokeWidth={2.5} className="text-teal-50/75 shrink-0" />
              <span className="hidden xl:inline truncate max-w-[160px]">{currentProject?.name || 'Select Ship'}</span>
              <span className="xl:hidden truncate max-w-[80px]">{currentProject?.name || 'Select'}</span>
              <ChevronDown size={14} className="text-teal-100/70 shrink-0" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col overflow-auto px-6 py-4">
        <div className={'max-w-[1800px] mx-auto w-full flex-1 flex flex-col gap-4' + (activeTab === 'comments' || activeTab === 'manual' ? ' min-h-0' : '')}>
          {remoteUpdateCount > 0 && ['drawings', 'tracker'].includes(activeTab) && (
            <div className="flex items-center justify-between rounded-xl border border-teal-100 bg-teal-50/80 px-4 py-2 text-xs font-semibold text-teal-800">
              <span>Updated by others · {remoteUpdateCount} drawings</span>
              <button className="rounded px-2 py-1 text-teal-700 hover:bg-white/70" onClick={() => setRemoteUpdateCount(0)} aria-label="Dismiss update notice">×</button>
            </div>
          )}
          {saveConflict && (
            <div role="alert" data-testid="save-conflict" className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900">
              <span>{saveConflict.message}</span>
              <button className="shrink-0 rounded px-2 py-1 text-amber-800 hover:bg-white/70" onClick={clearSaveConflict} aria-label="Dismiss save conflict">×</button>
            </div>
          )}
          {activeTab === 'drawings' && <CommandBar />}

          <div className={`flex-1 rounded-[2rem] border border-white/70 shadow-[0_24px_80px_-28px_rgba(15,118,110,0.28)] overflow-hidden flex flex-col ${activeTab === 'drawings' || activeTab === 'comments' ? 'inventory-theme' : ''} ${activeTab === 'comments' ? 'comments-surface' : 'bg-white/92 backdrop-blur-xl'}`}>
            {activeTab === 'drawings' && <DrawingList />}
            {activeTab === 'comments' && (
              <Suspense fallback={<LazyTabFallback />}>
                <ErrorBoundary>
                  <Comments key={activeProjectId || 'no-project'} projectId={activeProjectId} />
                </ErrorBoundary>
              </Suspense>
            )}
            {activeTab === 'activity' && (
              <Suspense fallback={<LazyTabFallback />}>
                <ErrorBoundary>
                  <ActivityReport />
                </ErrorBoundary>
              </Suspense>
            )}
            {activeTab === 'settings' && (
              <Suspense fallback={<LazyTabFallback />}>
                <Settings />
              </Suspense>
            )}
            {activeTab === 'dailylog' && (
              <Suspense fallback={<LazyTabFallback />}>
                <DailyLogReport />
              </Suspense>
            )}
            {activeTab === 'tracker' && (
              <Suspense fallback={<LazyTabFallback />}>
                <ReviewTracker />
              </Suspense>
            )}
            {activeTab === 'manual' && (
              <Suspense fallback={<LazyTabFallback />}>
                <Manual />
              </Suspense>
            )}
          </div>
        </div>
      </main >

      {/* Footer */}
      < footer className="bg-white/40 backdrop-blur-md border-t border-slate-200/50 px-8 py-3 text-[8px] font-[1000] uppercase tracking-[0.3em] text-slate-400 flex flex-col md:flex-row justify-between no-print items-center shrink-0" >
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <span className="text-slate-300 font-bold tracking-normal">© 2025</span>
            <span className="text-slate-900 tracking-[0.4em]">PG SHIPMANAGEMENT</span>
          </div>
          <div className="hidden md:flex items-center gap-2">
            <Layers size={12} className="text-teal-500/30" />
            <span>Entities Logged: {currentProject?.drawings?.length || 0}</span>
          </div>
          <div className="text-slate-400 font-bold tracking-widest uppercase opacity-80 flex items-center gap-2">
            <div className="w-1 h-1 bg-teal-500 rounded-full" />
            Developped by Kevin @ Newbuilding
          </div>
        </div>

        <div className="flex items-center gap-8 mt-2 md:mt-0">

          <div className="flex items-center gap-1.5 text-slate-300 group">
            <Code size={12} className="group-hover:text-teal-500 transition-colors" />
            <span className="tracking-widest">PA-V3.1-LTD</span>
          </div>
        </div>
      </footer >

      <AuthNotice />
      {session?.mode !== 'kjx' && <AdminLoginDialog open={showAdminLogin} onClose={() => setShowAdminLogin(false)} />}

      {/* Unsaved Changes Indicator */}
      <UnsavedChangesIndicator />
      <SaveStatusBar />
    </div >
  );
};

export default App;
