// Hosted kjx page only; the persisted PCF schema/template and existing receipt
// protocol stay unchanged. Template bindings are available after DOMContentLoaded.
export const KJX_SAVE_STATUS = `<script id="pahub-save-control">
(()=>{
 const projectId=window.PAHUB?.projectId;
 const projectKey='pahub.rejected-project:'+projectId;
 window.pahubPendingIsRejected=documentId=>{try{const rejected=Number(localStorage.getItem(projectKey)||0),resumed=Number(localStorage.getItem('pahub.resumed-save:'+documentId)||0);return !!localStorage.getItem('pahub.rejected-save:'+documentId)||rejected>0&&resumed<=rejected;}catch{return false;}};
 window.pahubRemoveRejectedPending=async documentId=>{if(!window.indexedDB)return;await new Promise((resolve,reject)=>{const request=indexedDB.open('pahub-pcf-offline',1);request.onupgradeneeded=()=>request.result.createObjectStore('documents');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('documents','readwrite');tx.objectStore('documents').delete(documentId);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};};});};
 document.addEventListener('DOMContentLoaded',()=>{
  if(window.PAHUB?.mode!=='kjx')return;
  const rejectedKey='pahub.rejected-save:'+state.documentId;
  const registryKey='pahub.pcf-project-documents:'+projectId;
  try{const documents=JSON.parse(localStorage.getItem(registryKey)||'[]');if(!documents.includes(state.documentId))localStorage.setItem(registryKey,JSON.stringify([...documents,state.documentId]));}catch{}
  const key='pahub.save-status:'+window.PAHUB.user.id+':'+state.documentId;
  let status={phase:'saved',attempts:0},retryTimer,renderTimer,outcome,busy=false;
  try{const held=JSON.parse(localStorage.getItem(key)||'null');if(held)status=held.phase==='saving'?{...held,phase:'failed',reason:'Save confirmation interrupted',failure:'network',retryAt:Date.now()+3000}:held;}catch{}
  const box=document.createElement('aside');box.id='pahub-save-status';box.setAttribute('role','status');box.style.cssText='position:fixed;bottom:8px;left:12px;max-width:85vw;z-index:10020;background:white;border:1px solid #99f6e4;border-radius:8px;padding:8px 12px;color:#115e59;font:12px sans-serif';document.body.append(box);
  const texts={login:'Sign in again to continue saving',forbidden:'No permission. Unsaved changes were rolled back',oversize:'Data is too large. Contact an administrator',conflict:'Version conflict. Review the conflict dialog',network:'Network unavailable',timeout:'Save request timed out; confirmation is unknown',server:'Server error; confirmation is unknown',invalid:'Save rejected. Review the error'};
  function draw(){
   const pending=Math.max(hubOps(hubBase,state).length,hubQueue.reduce((n,item)=>n+item.body.ops.length,0));
   box.replaceChildren();const label=document.createElement('span');label.textContent=status.phase==='saving'?'Saving…':status.phase==='failed'?'Save failed: '+status.reason:pending?'Pending sync: '+pending+' items':status.lastSuccess?'Saved · '+new Date(status.lastSuccess).toLocaleTimeString():'No pending changes';box.append(label);
   if(status.retryAt){const time=document.createElement('span');time.textContent=' · Retry in '+Math.max(0,Math.ceil((status.retryAt-Date.now())/1000))+'s ('+new Date(status.retryAt).toLocaleTimeString()+')';box.append(time);}
   if(status.phase!=='saving' && (pending||status.phase==='failed')){const button=document.createElement('button');button.textContent=status.failure==='login'?'Sign in / check session':'Retry now';button.disabled=['forbidden','oversize'].includes(status.failure);button.style.marginLeft='12px';button.onclick=()=>status.failure==='login'?void window.fetch('/api/session',{cache:'no-store'}).then(r=>{if(r.ok){status={...status,failure:'network',retryAt:Date.now()};saveStatus();void hubSave(false);}}):void hubSave(false);box.append(button);}
  }
  function saveStatus(){try{localStorage.setItem(key,JSON.stringify(status));}catch{}draw();clearTimeout(retryTimer);if(status.retryAt)retryTimer=setTimeout(()=>void hubSave(true),Math.max(0,status.retryAt-Date.now()));}
  window.pahubRejectPendingSave=async(member=false)=>{
   let documents=[state.documentId];
   if(member)try{localStorage.setItem(projectKey,String(Date.now()));documents=[...new Set([...documents,...JSON.parse(localStorage.getItem(registryKey)||'[]')])];for(const id of documents)localStorage.setItem('pahub.rejected-save:'+id,'rejected');}catch{}
   try{localStorage.setItem(rejectedKey,'rejected');}catch{}
   clearTimeout(retryTimer);Object.assign(state,structuredClone(hubBase));hubQueue=[];hubDirty.clear();hubBlocked=false;hubConflictItems=[];savedRevision=editRevision;
   await hubPersist();
   // Await explicit deletion too: navigation must not race the queued transaction.
   try{const db=await hubDB();await new Promise((resolve,reject)=>{const tx=db.transaction('documents','readwrite');for(const id of documents)tx.objectStore('documents').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}catch{hubBlocked=true;}
   status={...status,phase:'failed',failure:'forbidden',reason:texts.forbidden,retryAt:undefined};saveStatus();render();
  };
  const fetcher=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
   if(String(input)!==hubURL('ops')||init?.method!=='POST')return fetcher(input,init);
   const controller=new AbortController();let timer;
   try{
    const completed=await Promise.race([(async()=>{const response=await fetcher(input,{...init,signal:controller.signal});const text=await response.text();return{response,text};})(),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Object.assign(new Error(texts.timeout),{name:'TimeoutError'}));controller.abort();},15000);})]);
    const {response,text}=completed;let result;try{result=JSON.parse(text);}catch{result={};}
    outcome=response.ok?(result.conflicts?.length?{failure:'conflict'}:{ok:true}):{failure:response.status===401?'login':response.status===403?'forbidden':response.status===413?'oversize':response.status===409?'conflict':response.status>=500?'server':'invalid'};
    if(response.status===403)await window.pahubRejectPendingSave(result.capability==='project.member');
    return new Response(text,{status:response.status,headers:response.headers});
   }catch(error){outcome={failure:error.name==='TimeoutError'?'timeout':'network'};throw error;}finally{clearTimeout(timer);}
  };
  const nativeTouch=touch;
  touch=function(...args){nativeTouch(...args);if(status.failure==='forbidden'){try{localStorage.removeItem(rejectedKey);localStorage.setItem('pahub.resumed-save:'+state.documentId,String(Date.now()+1));}catch{}status={phase:'saved',attempts:0,lastSuccess:status.lastSuccess};saveStatus();}draw();};
  const nativeSave=hubSave;
  hubSave=async function(auto=false){
   if(writeBusy||busy)return;
   if(window.pahubPendingIsRejected(state.documentId)){await window.pahubRejectPendingSave();return;}
   if(status.phase==='failed' && (['login','forbidden','oversize'].includes(status.failure) || auto && (!status.retryAt || status.retryAt>Date.now())))return;
   if(hubBlocked)return;
   if(!dirty()&&!hubQueue.length)return;
   busy=true;const previous=status;outcome=undefined;status={...status,phase:'saving',retryAt:undefined};saveStatus();
   try{await nativeSave(auto);}finally{busy=false;}
   if(outcome?.ok){status={phase:'saved',attempts:0,lastSuccess:Date.now()};}
   else if(outcome?.failure){const failure=outcome.failure,attempts=(previous.attempts||0)+1;status={phase:'failed',attempts,lastSuccess:previous.lastSuccess,failure,reason:texts[failure],...(['network','timeout','server'].includes(failure)?{retryAt:Date.now()+Math.min(60000,3000*2**Math.min(attempts-1,5))}:{})};}
   else status=previous;
   if(outcome?.failure==='forbidden'){status.retryAt=undefined;}
   saveStatus();
  };
  try{if(window.pahubPendingIsRejected(state.documentId)){hubRecovery=Promise.resolve(hubRecovery);void window.pahubRejectPendingSave();}}catch{}
  const revoked=event=>{if(event.key===projectKey || event.key===rejectedKey)void window.pahubRejectPendingSave();};window.addEventListener('storage',revoked);
  renderTimer=setInterval(draw,1000);window.addEventListener('pagehide',()=>{clearInterval(renderTimer);clearTimeout(retryTimer);window.removeEventListener('storage',revoked);});saveStatus();
 });
})();
</script>`;
