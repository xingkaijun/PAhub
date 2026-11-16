import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {useStore} from '../store';
import {storageWarningSnapshot,subscribeStorageWarning} from '../lib/local-storage';
export function SaveStatusBar(){
 const storageWarning=useSyncExternalStore(subscribeStorageWarning,storageWarningSnapshot,()=>null);
 const next=useStore(state=>state.nextAutosaveAt);
 const id=useStore(state=>state.activeProjectId);
 const status=useStore(state=>id?state.saveStatuses[id]:undefined);
 const pending=useStore(state=>state.getUnsavedChangesCount());
 const recoveryPending=useStore(state=>Boolean(id && (state.pendingSaves[id] || state.data.projects.find(project=>project.id===id)?.localOnly)));
 const save=useStore(state=>state.saveProject),refreshSession=useStore(state=>state.refreshSession);
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(!status?.retryAt)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[status?.retryAt]);
 useEffect(()=>{if(!id || !status?.retryAt)return;const timer=setTimeout(()=>{void save(id);},Math.max(0,status.retryAt-Date.now()));return()=>clearTimeout(timer);},[id,status?.retryAt,save]);
 if(!id && !storageWarning)return null;
 const saving=status?.phase==='saving',failed=(pending>0||recoveryPending)&&(status?.phase==='failed'||status?.phase==='unconfirmed');
 const time=status?.lastSuccess?new Date(status.lastSuccess).toLocaleTimeString():null;
 const message=saving?'Saving…':failed?(status?.phase==='unconfirmed'?'Awaiting confirmation: ':'Save failed: ')+status?.reason:pending?'Pending sync: '+pending+' items':time?'Saved · '+time:'No pending changes';
 return <aside role="status" data-testid="save-status-bar" className={'fixed bottom-2 left-4 z-[11000] max-w-[min(90vw,700px)] rounded-lg border px-3 py-2 text-xs shadow bg-white '+(failed?'border-rose-300 text-rose-800':'border-teal-200 text-teal-800')}>
  {storageWarning&&<strong className="text-rose-800 mr-3">{storageWarning}</strong>}<span>{message}</span>{!!next&&<span> · Next autosave: {new Date(next).toLocaleTimeString()} (15 min)</span>}{failed&&status.retryAt&&<span> · Retry in {Math.max(0,Math.ceil((status.retryAt-now)/1000))}s ({new Date(status.retryAt).toLocaleTimeString()})</span>}
  {failed&&status.failure==='login'?<button className="ml-3 underline" onClick={()=>void refreshSession()}>Sign in / check session</button>:(!saving&&(failed||pending>0))&&<button className="ml-3 underline" disabled={status?.failure==='forbidden'||status?.failure==='oversize'} onClick={()=>void save(id!,{manual:true})}>Retry now</button>}
 </aside>;
}
