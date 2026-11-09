import { apiClient } from './services/api/apiClient';
import { isProjectNotFound, projectsApi } from './services/api/projectsApi';
import { createDebouncedSave } from './lib/auto-save';


import React, { Suspense, lazy, useMemo, useState, useEffect } from 'react';
import { useStore } from './store';
import { DrawingList } from './components/DrawingList';
import { CommandBar } from './components/CommandBar';
import { safeFormatDate } from './lib/date';

const PROJECT_THEMES = [
  { bg: 'bg-white', border: 'border-slate-100', hover: 'hover:border-slate-300', iconBg: 'from-slate-100 to-slate-200', iconText: 'text-slate-500' }, // Classic
  { bg: 'bg-rose-50/50', border: 'border-rose-100', hover: 'hover:border-rose-400', iconBg: 'from-rose-100 to-rose-200', iconText: 'text-rose-500' },
  { bg: 'bg-orange-50/50', border: 'border-orange-100', hover: 'hover:border-orange-400', iconBg: 'from-orange-100 to-orange-200', iconText: 'text-orange-500' },
  { bg: 'bg-amber-50/50', border: 'border-amber-100', hover: 'hover:border-amber-400', iconBg: 'from-amber-100 to-amber-200', iconText: 'text-amber-500' },
  { bg: 'bg-emerald-50/50', border: 'border-emerald-100', hover: 'hover:border-emerald-400', iconBg: 'from-emerald-100 to-emerald-200', iconText: 'text-emerald-500' },
  { bg: 'bg-teal-50/50', border: 'border-teal-100', hover: 'hover:border-teal-400', iconBg: 'from-teal-100 to-teal-200', iconText: 'text-teal-500' },
  { bg: 'bg-cyan-50/50', border: 'border-cyan-100', hover: 'hover:border-cyan-400', iconBg: 'from-cyan-100 to-cyan-200', iconText: 'text-cyan-500' },
  { bg: 'bg-blue-50/50', border: 'border-blue-100', hover: 'hover:border-blue-400', iconBg: 'from-blue-100 to-blue-200', iconText: 'text-blue-500' },
  { bg: 'bg-indigo-50/50', border: 'border-indigo-100', hover: 'hover:border-indigo-400', iconBg: 'from-indigo-100 to-indigo-200', iconText: 'text-indigo-500' },
  { bg: 'bg-violet-50/50', border: 'border-violet-100', hover: 'hover:border-violet-400', iconBg: 'from-violet-100 to-violet-200', iconText: 'text-violet-500' },
  { bg: 'bg-fuchsia-50/50', border: 'border-fuchsia-100', hover: 'hover:border-fuchsia-400', iconBg: 'from-fuchsia-100 to-fuchsia-200', iconText: 'text-fuchsia-500' },
];

const getProjectTheme = (id: string, name: string) => {
  // Combine ID and Name for hash to handle cases where ID might be sequential or weird
  const seed = id + name;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PROJECT_THEMES[Math.abs(hash) % PROJECT_THEMES.length];
};
import { ErrorBoundary } from './components/ErrorBoundary';
import { UnsavedChangesIndicator } from './components/UnsavedChangesIndicator';
import { AdminLoginDialog } from './components/AdminLoginDialog';
import {
  FileStack,
  Settings as SettingsIcon,
  PlusCircle,
  ChevronDown,
  Layers,
  Code,
  Cloud,
  CloudOff,
  RefreshCw,
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
  const projectCards = useMemo(
    () => data.projects.map(p => ({
      id: p.id,
      name: p.name,
      conf: p.conf,
      drawingCount: p.drawings?.length || 0,
      approvedCount: p.drawings?.filter(d => d.status === 'Approved').length || 0,
      storagePath: p.storagePath,
    })),
    [data.projects]
  );

  const [showProjectSelector, setShowProjectSelector] = useState(true);
  const [remoteUpdateCount, setRemoteUpdateCount] = useState(0);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  useEffect(() => {
    if (!isEditMode && activeTab === 'settings') setActiveTab('drawings');
  }, [isEditMode, activeTab]);

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

  const handleSelectProject = async (projectId: string, passwordInput?: string) => {
    // Check for unsaved changes before switching projects
    const hasUnsaved = useStore.getState().hasUnsavedChanges();
    if (hasUnsaved && activeProjectId && projectId !== activeProjectId) {
      const confirmSwitch = window.confirm(
        'You have unsaved changes in the current project. Switching projects will discard these changes.\n\nWould you like to save the current project first?\n\nClick "OK" to save and switch, or "Cancel" to switch without saving (changes will be lost).'
      );
      
      if (confirmSwitch) {
        // Save current project first
        const saved = await saveProject(activeProjectId);
        if (!saved) {
          alert('Save failed. Please try again or choose to switch without saving.');
          return;
        }
      } else {
        // User chose to discard changes, confirm again
        const confirmDiscard = window.confirm('Are you sure you want to discard unsaved changes? This action cannot be undone.');
        if (!confirmDiscard) {
          return; // Cancel the switch
        }
      }
    }

    useStore.setState({ isLoading: true });
    try {
      if (true) {
        // Pass password if provided
        await loadProject(projectId, passwordInput);
      } else {
        // Local load (just set active)
        setActiveProject(projectId);
      }
      setShowProjectSelector(false);
      setActiveProject(projectId); // Ensure store knows active ID
    } catch (e: any) {
      if (e.message === 'PASSWORD_REQUIRED' || e.message === 'INVALID_PASSWORD') {
        useStore.setState({ isLoading: false }); // Hide spinner to show prompt
        // Simple prompt for now
        const msg = e.message === 'INVALID_PASSWORD' ? "Incorrect Password. Try again:" : "This Registry is Protected. Enter Password:";
        // Short delay to allow React render? PROMPT blocks immediately.
        // We use setTimeout to allow UI update (hide spinner) before blocking.
        setTimeout(() => {
          const pwd = prompt(msg);
          if (pwd !== null) {
            handleSelectProject(projectId, pwd);
          }
        }, 50);
        return;
      } else if (isProjectNotFound(e)) {
        // The store shows the "project does not exist" notice; stay on the selector. The local entry is kept
        // (it may hold work that never reached the server), it is just not opened.
        setShowProjectSelector(true);
      } else {
        alert("Failed to load project: " + e.message);
      }
    } finally {
      // If we are NOT recursing (i.e. error wasn't password related, or success), turn off loading.
      // If password related, we returned early.
      // But we need to make sure we don't leave spinner if we didn't return.
      // Actually `return ` above skips this finally?
      // No, `return ` inside catch executes finally.
      // We want to avoid turning off loading if we are about to recurse?
      // But the recursive call will set isLoading=true at start.
      // So turning it off here briefly is fine, or we can use a flag.
      // But wait: `setTimeout` makes it async.
      // So `finally` block runs BEFORE `setTimeout` callback.
      // So `isLoading` becomes false. Then prompt shows. Then recursive call sets true.
      // This is perfect! We want spinner to hide so user sees the app (or at least prompt).
      useStore.setState({ isLoading: false });
    }
  };

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
        // 获取配置中的项目密码（如果该项目受密码保护）
        console.log(`[Read-Only Mode] Auto-fetching latest data from server (Interval: ${intervalMinutes}m)...`);
        const projectConfPw = activeProject?.conf?.password;
        await loadProject(activeProjectId, projectConfPw).catch(e => {
          console.warn('Auto-fetch in read-only mode failed:', e.message);
        });
      }
    }, intervalMinutes * 60 * 1000);

    return () => clearInterval(interval);
  }, [activeProjectId, showProjectSelector, data.settings.autoSyncInterval, currentProject?.conf?.autoSyncInterval, currentProject?.conf?.password, isEditMode, loadProject, saveProject]);

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
      source.onerror = () => { source?.close(); source = undefined; reconnect(); };
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
      addProject(name);
      setShowProjectSelector(false);

      // 新建项目后自动同步到后端 D1
      // 使用 setTimeout 确保 store 状态已更新
      setTimeout(async () => {
        const newProject = useStore.getState().data.projects.find(p => p.name === name);
        if (newProject) {
          try {
            await saveProject(newProject.id);
            console.log(`[新建项目] "${name}" 已同步到后端`);
          } catch (e) {
            console.warn(`[新建项目] "${name}" 同步失败:`, e);
          }
        }
      }, 100);
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
          <button className="shrink-0 rounded px-2 py-1 text-rose-800 hover:bg-white/70" onClick={clearProjectNotice} aria-label="Dismiss project notice">×</button>
        </div>
      )}
      {/* New Project Selector Overlay (Static Prototype) */}
      {showProjectSelector && !isLoading && (
        <div className="fixed inset-0 z-[10000] flex flex-col bg-[radial-gradient(circle_at_top_left,_rgba(156,242,232,0.35),_transparent_24%),linear-gradient(180deg,#f4fbfa_0%,#f7fafc_42%,#eefaf7_100%)] overflow-hidden">

          {/* Top Header */}
          <div className="relative overflow-hidden bg-[rgba(15,118,110,0.88)] backdrop-blur-2xl border-b border-white/10 px-8 py-5 flex items-center justify-between shrink-0 shadow-[0_24px_48px_-12px_rgba(19,27,46,0.16)] z-10">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),transparent_35%,rgba(156,242,232,0.14)_100%)] pointer-events-none" />
            <div className="relative flex items-center gap-4">
              <div className="bg-white/95 p-1.5 rounded-2xl shadow-lg border border-white/40">
                <img
                  src="/pg-logo.jpg"
                  alt="PG SHIPMANAGEMENT PTE. LTD. Logo"
                  className="h-10 w-auto object-contain"
                />
              </div>
              <div>
                <p className="text-[9px] font-black uppercase tracking-[0.35em] text-teal-100/80 mb-1">
                  Project Access Hall
                </p>
                <h1 className="text-2xl font-[1000] text-white tracking-tight uppercase leading-none">
                  Select <span className="text-[#9CF2E8]">Project</span>
                </h1>
              </div>
            </div>

            {/* Storage Controls */}
            <div className="relative flex items-center gap-3">
              <a
                href="/manual/"
                target="_blank"
                rel="noopener"
                title="操作手册 / Guide"
                aria-label="操作手册 / Guide"
                className="inline-flex items-center justify-center p-2.5 rounded-full border border-white/15 bg-white/10 text-white/80 hover:bg-white hover:text-teal-700 transition-all active:scale-95 shadow-lg shadow-teal-950/10"
              >
                <BookOpen size={16} />
              </a>
              <button
                onClick={handleGlobalRefresh}
                className="inline-flex items-center justify-center p-2.5 rounded-full border border-white/15 bg-white/10 text-white/80 hover:bg-white hover:text-teal-700 transition-all active:scale-95 shadow-lg shadow-teal-950/10"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>

          {/* Grid Container (Scrollable Scroll Area) */}
          <div className="flex-1 overflow-y-auto px-8 py-10 w-full max-w-[1800px] mx-auto">

            {/* Grid Definition */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">

              {/* Company Logo Card (First Element) */}
              <div className="group relative flex flex-col items-center justify-center rounded-3xl border border-slate-100 bg-white shadow-lg shadow-slate-200/40 h-[260px] overflow-hidden">
                <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-br from-white to-slate-50/50">
                  <img
                    src="/pg-logo.jpg"
                    alt="PG SHIPMANAGEMENT PTE. LTD. Logo"
                    className="w-[95%] sm:w-[85%] md:w-full max-w-xs h-auto object-contain drop-shadow-md opacity-95 transition-transform duration-700 hover:scale-[1.05]"
                  />
                </div>
              </div>

              {/* Project Items (Dynamic) */}
              {projectCards.map(p => {
                const theme = getProjectTheme(p.id, p.name);
                const total = p.drawingCount;
                const approved = p.approvedCount;
                const completion = total > 0 ? Math.round((approved / total) * 100) : 0;

                return (
                  <button
                    key={p.id}
                    onClick={() => handleSelectProject(p.id)}
                    className={`group relative flex flex-col rounded-3xl border border-white shadow-lg shadow-slate-200/40 hover:shadow-2xl hover:-translate-y-1.5 transition-all duration-300 ease-out text-left h-[260px] overflow-hidden ${theme.bg}`}
                  >
                    {/* Top Color Banner */}
                    <div className={`h-2 w-full bg-gradient-to-r opacity-80 ${theme.iconBg}`} />

                    <div className="p-6 flex flex-col h-full w-full">
                      <div className="flex justify-between items-start mb-6 w-full gap-2">
                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-black shadow-inner shrink-0 ${theme.iconBg} ${theme.iconText} bg-opacity-20`}>
                          {p.name.substring(0, 2).toUpperCase()}
                        </div>
                        {total > 0 && (
                          <div className="bg-white/60 text-slate-500 text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-lg border border-slate-100 flex items-center gap-1.5 shadow-sm">
                            <div className={`w-1.5 h-1.5 rounded-full ${completion === 100 ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
                            {completion === 100 ? 'Completed' : 'Active'}
                          </div>
                        )}
                      </div>

                      <h3 className={`text-xl font-[1000] uppercase tracking-tight mb-2 transition-colors line-clamp-2 ${theme.iconText}`}>
                        {p.name}
                      </h3>

                      {total > 0 ? (
                        <div className="mt-auto w-full">
                          <div className="flex justify-between items-end mb-1.5">
                            <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Progress</span>
                            <span className={`text-sm font-[1000] ${theme.iconText}`}>{completion}%</span>
                          </div>
                          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                            <div
                              className={`h-full rounded-full transition-all duration-1000 ease-out ${theme.iconBg} bg-opacity-80`}
                              style={{ width: `${completion}%` }}
                            />
                          </div>

                          <div className="flex justify-between items-center mt-4 pt-4 border-t border-slate-900/5">
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                              Assets: {total}
                            </span>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                              {p.lastUpdated ? safeFormatDate(p.lastUpdated, 'MM/dd', 'New') : 'New'}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-auto w-full">
                          <p className="text-xs font-black text-slate-400 uppercase tracking-widest mt-4 bg-white/50 p-3 rounded-xl inline-block border border-white/50">
                            Ready to Load
                          </p>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}

              {/* Create New Project Card (Last Element) */}
              <button
                onClick={handleAddProject}
                className="group relative flex flex-col items-center justify-center gap-4 p-8 rounded-3xl border-2 border-dashed border-slate-300 hover:border-teal-400 bg-slate-50/50 hover:bg-teal-50/30 transition-all h-[260px]"
              >
                <div className="w-16 h-16 rounded-full bg-white shadow-sm border border-slate-100 group-hover:bg-teal-50 flex items-center justify-center text-slate-300 group-hover:text-teal-500 transition-colors">
                  <PlusCircle size={32} />
                </div>
                <span className="text-xs font-[1000] uppercase tracking-widest text-slate-400 group-hover:text-teal-600 text-center">Create<br />Workspace</span>
              </button>

            </div>

            {/* No Projects State Handled by New Project Card now */}

          </div>

          {/* Fixed Footer for Selector */}
          <div className="mt-auto pb-8 pt-4 w-full flex flex-col items-center justify-center gap-3 z-20 shrink-0 bg-gradient-to-t from-[#F4F7F9] to-transparent">
            <button onClick={handleOfflineMode} className="text-slate-400 hover:text-slate-600 text-[10px] font-black uppercase tracking-widest underline decoration-2 decoration-slate-200 underline-offset-4 hover:decoration-slate-400 transition-all">
              Skip / Enter Offline Mode (Local Cache)
            </button>
            {data.projects.length === 0 && (
              <span className="text-[9px] font-bold text-amber-500 bg-amber-50 px-3 py-1 rounded-full uppercase tracking-widest shadow-sm">
                Note: No projects found. Cloud sync might be required.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Full Screen Loading Overlay */}
      {isLoading && (
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
          <nav className="flex items-center gap-1 bg-black/15 backdrop-blur-sm p-1 rounded-full border border-white/10 shadow-inner shadow-black/10 min-w-0">
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
              onClick={() => isEditMode && setActiveTab('settings')}
              disabled={!isEditMode}
              className={`flex items-center gap-1.5 px-3 xl:px-5 py-2 rounded-full text-[10px] font-[1000] uppercase tracking-[0.15em] transition-all duration-300 shrink-0 ${activeTab === 'settings' ? 'bg-white text-teal-700 shadow-lg shadow-black/10' : !isEditMode ? 'text-white/35 cursor-not-allowed opacity-70' : 'text-teal-50/75 hover:text-white hover:bg-white/10'}`}
              title={!isEditMode ? "需要管理员权限 (Administrator permission required)" : "Configuration"}
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
          <button
            onClick={() => isEditMode ? void logoutAdmin() : setShowAdminLogin(true)}
            title={isEditMode ? 'Sign out of the administrator session' : '需要管理员权限 (Administrator permission required)'}
            aria-pressed={isEditMode}
            data-admin-session={isEditMode ? 'admin' : 'reviewer'}
            className={`flex items-center gap-2 px-3 xl:px-4 py-2 rounded-full border text-[10px] font-[1000] uppercase tracking-[0.15em] shadow-lg transition-all active:scale-[0.98] ${isEditMode ? 'bg-amber-100/95 text-amber-800 border-amber-200 hover:bg-amber-200' : 'bg-white/10 text-teal-50/85 border-white/15 hover:bg-white/15'}`}
          >
            {isEditMode ? <Unlock size={14} strokeWidth={2.5} className="shrink-0" /> : <Lock size={14} strokeWidth={2.5} className="shrink-0" />}
            <span className="hidden xl:inline">{isEditMode ? 'Administrator' : 'Reviewer'}</span>
          </button>
          {/* Phones have no tab bar: the manual opens as its own page */}
          <a
            href="/manual/"
            target="_blank"
            rel="noopener"
            title="操作手册 / Guide"
            aria-label="操作手册 / Guide"
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

      <AdminLoginDialog open={showAdminLogin} onClose={() => setShowAdminLogin(false)} />

      {/* Unsaved Changes Indicator */}
      <UnsavedChangesIndicator />
    </div >
  );
};

export default App;
