import React,{useEffect,useState} from 'react';
import {useStore} from '../store';
export function SaveStatusBar(){
 const kjx=useStore(state=>state.session?.mode==='kjx');
 const id=useStore(state=>state.activeProjectId);
 const status=useStore(state=>id?state.saveStatuses[id]:undefined);
 const pending=useStore(state=>state.getUnsavedChangesCount());
 const save=useStore(state=>state.saveProject),refreshSession=useStore(state=>state.refreshSession);
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(!status?.retryAt)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[status?.retryAt]);
 useEffect(()=>{if(!kjx || !id || !status?.retryAt)return;const timer=setTimeout(()=>{void save(id);},Math.max(0,status.retryAt-Date.now()));return()=>clearTimeout(timer);},[id,status?.retryAt,save,kjx]);
 if(!id || !kjx)return null;
 const saving=status?.phase==='saving',failed=status?.phase==='failed';
 const time=status?.lastSuccess?new Date(status.lastSuccess).toLocaleTimeString():null;
 const message=saving?'Saving…':failed?'Save failed: '+status.reason:pending?'Pending sync: '+pending+' items':time?'Saved · '+time:'No pending changes';
 return <aside role="status" data-testid="save-status-bar" className={'fixed bottom-2 left-4 z-[11000] max-w-[min(90vw,700px)] rounded-lg border px-3 py-2 text-xs shadow bg-white '+(failed?'border-rose-300 text-rose-800':'border-teal-200 text-teal-800')}>
  <span>{message}</span>{failed&&status.retryAt&&<span> · Retry in {Math.max(0,Math.ceil((status.retryAt-now)/1000))}s ({new Date(status.retryAt).toLocaleTimeString()})</span>}
  {failed&&status.failure==='login'?<button className="ml-3 underline" onClick={()=>void refreshSession()}>Sign in / check session</button>:(!saving&&(failed||pending>0))&&<button className="ml-3 underline" disabled={status?.failure==='forbidden'||status?.failure==='oversize'} onClick={()=>void save(id,{manual:true})}>Retry now</button>}
 </aside>;
}
