// Hosted kjx-only adapter: legacy/offline template bytes and version remain unchanged.
export const KJX_PCF_ADAPTER = `<script id="pahub-kjx-permissions">
(()=>{
 const context=()=>window.PAHUB;
 const nativeFetch=window.fetch.bind(window);
 const notice=message=>{let node=document.getElementById('pahub-auth-notice');if(!node){node=document.createElement('div');node.id='pahub-auth-notice';node.setAttribute('role','alert');node.style.cssText='position:fixed;top:8px;left:20%;right:20%;z-index:10000;background:#fffbeb;color:#78350f;padding:12px;border:1px solid #fcd34d;border-radius:12px';document.body.append(node);}node.textContent=message;};
 window.fetch=async(...args)=>{
  const response=await nativeFetch(...args);
  if([401,403,503].includes(response.status))try{
   const body=await response.clone().json();
   if(response.status===401&&body.login){const login=new URL(body.login);login.searchParams.set('app','pahub');login.searchParams.set('path',location.pathname+location.search);location.assign(login.toString());}
   else if(response.status===403&&body.denied)location.assign(body.denied);
   else if(response.status===403&&body.capability==='project.member'){notice('You no longer have access to this workspace. Ask to be added to Team Setup.');setTimeout(()=>location.assign('/'),1000);}
   else if(response.status===403&&body.error==='forbidden'){notice("You don't have permission to do this.");if(String(args[0]).endsWith('/ops')){Object.assign(state,structuredClone(hubBase));hubQueue=[];hubDirty.clear();hubBlocked=false;hubConflictItems=[];savedRevision=editRevision;await hubPersist();render();}}
   else if(response.status===503&&body.error==='auth_unavailable')notice('Sign-in service is temporarily unavailable. Try again in a minute.');
  }catch{}
  return response;
 };
 const hide=node=>{if(!node)return;node.hidden=true;node.setAttribute('data-kjx-denied','');node.style.setProperty('display','none','important');};
 function apply(){
  const ctx=context();if(!ctx||ctx.mode!=='kjx')return;
  const can=cap=>ctx.permissions.includes(cap),writer=can('pcf.comment.create');
  const gates={'pahub-export':'builder.export','pahub-io-export':'builder.export','pahub-import':'builder.import_reply','pahub-io-menu-btn':'builder.import_reply','save-menu-btn':'builder.export','save-as-btn':'builder.export','json-menu-btn':'builder.export','theme-btn':'pcf.settings','settings-btn':'pcf.settings','font-up':'pcf.settings','font-down':'pcf.settings','add-btn':'pcf.comment.create','fab-add':'pcf.comment.create','save-btn':'pcf.comment.create','fab-save':'pcf.comment.create','bulk-round-btn':'pcf.document.write','panel-lock':'pcf.document.write','circulate-btn':'pcf.document.write'};
  for(const [id,cap]of Object.entries(gates))if(!can(cap))hide(document.getElementById(id));
  const deny=(selector,cap)=>{if(!can(cap))document.querySelectorAll(selector).forEach(hide);};
  deny('[data-action="add-comment"],[data-action="add-round"]','pcf.comment.create');
  deny('[data-action="delete-comment"],[data-action="delete-round"],[data-action="delete-image"]','pcf.comment.edit_any');
  deny('[data-action="import-json"],#import-json-btn','pcf.replace');
  deny('#more-btn', 'pcf.comment.create');
  if(!can('pcf.comment.edit_any')){
   for(const comment of state.comments){
    const owns=comment.rounds.length&&comment.rounds.every(round=>round.initiatorId===ctx.user.id);
    const node=document.querySelector('[data-cid="'+comment.id+'"].comment');if(!node)continue;
    if(!owns){node.querySelectorAll('.page-field,.tag-toggle,.status-drag').forEach(hide);}
    for(const round of comment.rounds){
     const row=document.getElementById('round-'+round.id);if(!row)continue;
     for(const side of ['owner','reply'])if(side==='reply'||round.initiatorId!==ctx.user.id){
      const editor=row.querySelector('.editor[data-side="'+side+'"]');if(editor){editor.contentEditable='false';editor.setAttribute('aria-readonly','true');}
      row.querySelectorAll('[data-action="attach"][data-side="'+side+'"],[data-action="delete-image"][data-side="'+side+'"]').forEach(hide);
     }
     if(round.initiatorId!==ctx.user.id)row.querySelectorAll('.resize-handle').forEach(hide);
    }
   }
   document.querySelectorAll('[data-name-field="responder"],.pcf-date').forEach(node=>{node.disabled=true;});
  }
  if(!writer){
   document.querySelectorAll('[contenteditable="true"]').forEach(node=>{node.contentEditable='false';node.setAttribute('aria-readonly','true');});
   document.querySelectorAll('.page-field,.person-input,.tag-toggle,.resize-handle,.status-drag,.attach-button,.pcf-date,#format-bar,#format-tools,#font-family,#bold-btn,#italic-btn,#underline-btn').forEach(hide);
   document.querySelectorAll('[data-cfield],[data-name-field],[data-project]').forEach(node=>{if(node.tagName==='SELECT')node.disabled=true;else node.readOnly=true;});
  }
 }
 document.addEventListener('DOMContentLoaded',()=>{
  const style=document.createElement('style');style.textContent='[data-kjx-denied]{display:none!important}';document.head.append(style);
  const ctx=context();if(!ctx||ctx.mode!=='kjx')return;
  const privileged=['admin','manager'].includes(ctx.user.role);
  let candidates=[ctx.user],directoryAvailable=false;
  const nativeEditable=editable;
  editable=function(comment,quiet=false,round=null,side=null){
    if(!privileged && (ctx.user.role!=='reviewer' || round && (round.initiatorId!==ctx.user.id || side==='reply'))){if(!quiet)notice("You don't have permission to do this.");return false;}
    return nativeEditable(comment,quiet,round,side);
  };
  const nativeSave=hubSave;
  hubSave=async function(...args){await nativeSave(...args);if(!hubQueue.length&&!hubDirty.size)await hubPersist();};
  const nativeRound=makeRound;
  makeRound=function(...args){const round=nativeRound(...args);round.initiator=ctx.user.name;round.initiatorId=ctx.user.id;return round;};
  const nativeOps=hubOps;
  hubOps=function(base,local){return nativeOps(base,local).flatMap(op=>{
    if(op.type!=='round.meta'||op.field!=='initiator')return [op];
    const round=local.comments.find(c=>c.id===op.commentId)?.rounds.find(r=>r.id===op.roundId);
    if(!privileged)return [];
    return [{...op,initiatorId:round?.initiatorId}];
  }).concat(privileged?local.comments.flatMap(comment=>comment.rounds.flatMap(round=>{
    const prior=base.comments.find(c=>c.id===comment.id)?.rounds.find(r=>r.id===round.id);
    if(!prior||prior.initiatorId===round.initiatorId||prior.initiator!==round.initiator)return [];
    return [{type:'round.meta',commentId:comment.id,roundId:round.id,field:'initiator',initiatorId:round.initiatorId,value:round.initiator,baseRev:hubClock(base,'round:'+round.id+':initiator')}];
  })):[]);};
  const nativePeople=peopleHTML;
  peopleHTML=function(comment){
    const round=headerRound(comment);if(!round)return '';
    const container=document.createElement('div');container.innerHTML=nativePeople(comment);
    const input=container.querySelector('[data-name-field="initiator"]');
    if(privileged){
  const select=document.createElement('select');select.className='person-input';select.dataset.kjxInitiator=round.id;select.setAttribute('aria-label',ref(comment)+' owner');select.disabled=comment.status==='closed';
      const choices=new Map(candidates.map(person=>[person.id,person]));
      if(directoryAvailable&&round.initiatorId&&!choices.has(round.initiatorId))choices.set(round.initiatorId,{id:round.initiatorId,name:round.initiator||'Unknown user'});
      if(!round.initiatorId||!choices.has(round.initiatorId)){const old=document.createElement('option');old.value='';old.disabled=true;old.textContent=round.initiator||'Unassigned';select.append(old);}
      // Serialized through innerHTML below, so selection must be an attribute (the .value property is lost).
      const current=choices.has(round.initiatorId)?round.initiatorId:'';if(!current)select.firstElementChild?.setAttribute('selected','');
      for(const person of choices.values()){const option=document.createElement('option');option.value=person.id;option.textContent=person.name;if(person.id===current)option.setAttribute('selected','');select.append(option);}input.replaceWith(select);
    }else{input.readOnly=true;input.setAttribute('aria-readonly','true');}
    return container.innerHTML;
  };
  document.addEventListener('change',event=>{
    const select=event.target;if(!select.matches?.('[data-kjx-initiator]'))return;
    const person=candidates.find(user=>user.id===select.value);if(!person)return;
    const comment=state.comments.find(c=>c.rounds.some(r=>r.id===select.dataset.kjxInitiator));const round=comment?.rounds.find(r=>r.id===select.dataset.kjxInitiator);
    if(!comment||!round||comment.status==='closed')return;round.initiatorId=person.id;round.initiator=person.name;touch(comment);render();
  });
  // Keep the displayed verified account authoritative; nicknames do not assign ownership.
  const nickname=document.getElementById('pahub-name');if(nickname){nickname.textContent=ctx.user.name;nickname.disabled=true;}
  render();apply();new MutationObserver(apply).observe(document.body,{childList:true,subtree:true});
  if(privileged)void window.fetch(hubURL('initiators'),{headers:hubHeaders()}).then(response=>response.json()).then(result=>{
    directoryAvailable=result.ok===true;candidates=result.ok?[ctx.user,...result.users.filter(user=>user.id!==ctx.user.id)]:[ctx.user];render();
  }).catch(()=>{candidates=[ctx.user];render();});
 });
 const NativeEventSource=window.EventSource;
 window.EventSource=class extends NativeEventSource{constructor(...args){super(...args);this.addEventListener('error',()=>{void window.fetch('/api/session',{cache:'no-store'});});}};
})();
</script>`;
