import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { KJX_PCF_ADAPTER } from '../src/pcf-kjx-adapter.ts';

test('owner select preserves stored author after HTML serialization in all privileged/fallback states',()=>{
 const start=KJX_PCF_ADAPTER.indexOf('peopleHTML=function(comment){');
 const end=KJX_PCF_ADAPTER.indexOf('\n  };',start);
 assert.ok(start>=0&&end>start);
 const functionSource=KJX_PCF_ADAPTER.slice(start,end+5);
 const dom=new JSDOM('');
 try{
  for(const role of ['manager','admin'])for(const directoryAvailable of [true,false])for(const closed of [true,false])for(const author of ['listed','unlisted','missing','self']){
   const ctx={user:{id:'current',name:'Logged '+role}};
   const round={id:'R',initiatorId:author==='missing'?undefined:author==='self'?'current':author,initiator:author==='self'?ctx.user.name:'Stored '+author};
   const candidates=directoryAvailable?[ctx.user,{id:'listed',name:'Directory author'}]:[ctx.user];
   const original=(comment:any)=>{const root=dom.window.document.createElement('div');const input=dom.window.document.createElement('input');input.dataset.nameField='initiator';input.value=comment.round.initiator;root.append(input);return root.innerHTML;};
   const render=new Function('document','headerRound','nativePeople','privileged','candidates','directoryAvailable','ctx','ref',functionSource+';return peopleHTML;')(dom.window.document,(comment:any)=>comment.round,original,true,candidates,directoryAvailable,ctx,()=> 'C1');
   const parsed=dom.window.document.createElement('div');parsed.innerHTML=render({round,status:closed?'closed':'open'});
   const select=parsed.querySelector('select')!;
   const expectedId=author==='missing'||!directoryAvailable&&author!=='self'?'':round.initiatorId;
   const expectedName=author==='self'?ctx.user.name:directoryAvailable&&author==='listed'?'Directory author':round.initiator;
   assert.equal(select.value,expectedId,`${role}/${directoryAvailable}/${closed}/${author}`);
   assert.equal(select.selectedOptions[0].textContent,expectedName);
   assert.equal(select.querySelectorAll('option[selected]').length,1);
   assert.equal(select.disabled,closed);
   if(expectedId==='')assert.equal(select.selectedOptions[0].disabled,true);
   assert.equal(round.initiatorId,author==='missing'?undefined:author==='self'?'current':author);
  }
 }finally{dom.window.close();}
});
