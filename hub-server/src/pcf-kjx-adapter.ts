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
   else if(response.status===403&&body.error==='forbidden')notice("You don't have permission to do this.");
   else if(response.status===503&&body.error==='auth_unavailable')notice('Sign-in service is temporarily unavailable. Try again in a minute.');
  }catch{}
  return response;
 };
 function apply(){
  const ctx=context();if(!ctx||ctx.mode!=='kjx')return;
  const can=cap=>ctx.permissions.includes(cap);
  const gates={'pahub-export':'builder.export','pahub-io-export':'builder.export','pahub-import':'builder.import_reply','json-menu-btn':'builder.export','save-menu-btn':'builder.export','theme-btn':'pcf.settings','settings-btn':'pcf.settings','add-comment-btn':'pcf.comment.create'};
  for(const [id,cap]of Object.entries(gates)){const node=document.getElementById(id);if(node&&!can(cap)){node.hidden=true;node.disabled=true;}}
 }
 document.addEventListener('DOMContentLoaded',()=>{
  const ctx=context();if(!ctx||ctx.mode!=='kjx')return;
  const privileged=['admin','manager'].includes(ctx.user.role);
  let candidates=[ctx.user],directoryAvailable=false;
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
      for(const person of choices.values()){const option=document.createElement('option');option.value=person.id;option.textContent=person.name;select.append(option);}select.value=choices.has(round.initiatorId)?round.initiatorId:'';input.replaceWith(select);
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
