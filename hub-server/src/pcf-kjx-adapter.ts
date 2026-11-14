// Hosted-only adapter; no template/schema upgrade and no participant-ID writes (T3).
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
 document.addEventListener('DOMContentLoaded',()=>{apply();new MutationObserver(apply).observe(document.body,{childList:true,subtree:true});});
 const NativeEventSource=window.EventSource;
 window.EventSource=class extends NativeEventSource{constructor(...args){super(...args);this.addEventListener('error',()=>{void window.fetch('/api/session',{cache:'no-store'});});}};
})();
</script>`;
