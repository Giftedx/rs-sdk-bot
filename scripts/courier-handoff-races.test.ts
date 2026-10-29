import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {receiveHandoff,sendHandoff} from './courier-handoff';

for(const mode of ['delayed-inventory','publication-race','no-transfer','wrong-amount','expired','foreign'])test(mode,async()=>{
 const root=mkdtempSync(join(tmpdir(),'handoff-race-')),file=join(root,'courier-farmer.json');
 let held=0,tick=0;const callbacks=new Set<()=>void>();
 const request={token:'new',from:'Courier',to:'Farmer',server:mode==='foreign'?'other':'practice',state:'prepared',at:Date.now()-(mode==='expired'?130000:10),expected:[{id:330,count:81}]};
 const s:any={name:'Farmer',tick:()=>tick,sdk:{getState:()=>({}),getInventory:()=>held?[{id:330,count:held}]:[]},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
 if(mode!=='publication-race')writeFileSync(file,JSON.stringify(request));
 const timer=setInterval(()=>{tick++;if(tick===2&&mode==='delayed-inventory')held=81;for(const cb of [...callbacks])cb();},2);
 try{
  await receiveHandoff(s,'Courier','practice',async()=>{
   if(mode==='publication-race')writeFileSync(file,JSON.stringify(request));
   if(mode!=='delayed-inventory'&&mode!=='no-transfer')held=mode==='wrong-amount'?80:81;
   return {success:true};
  },root);
  const expected=mode==='delayed-inventory'||mode==='publication-race';
  expect(existsSync(file+'.credit')).toBe(expected);
  if(expected){const credit=JSON.parse(readFileSync(file+'.credit','utf8'));expect(credit.token).toBe('new');expect(credit.after).toEqual([{id:330,count:81}]);}
 }finally{clearInterval(timer);rmSync(root,{recursive:true,force:true});}
},2000);

test('sender inventory can settle after the trade reply',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sender-race-'));let held=100,tick=0;
 const callbacks=new Set<()=>void>();
 const s:any={name:'Courier',tick:()=>tick,sdk:{getState:()=>({}),getInventory:()=>[{id:330,count:held}]},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
 const timer=setInterval(()=>{tick++;if(tick===2)held=19;for(const cb of [...callbacks])cb();},2);
 try{
  const amount=await sendHandoff(s,'Farmer','practice',[{id:330,count:81}],async()=>{
   const p=join(root,'courier-farmer.json'),r=JSON.parse(readFileSync(p,'utf8'));
   writeFileSync(p+'.credit',JSON.stringify({token:r.token,from:r.from,to:r.to,server:r.server,at:Date.now(),before:[],after:[{id:330,count:81}]}));
  },root);
  expect(amount).toBe(81);
  expect(JSON.parse(readFileSync(join(root,'courier-farmer.json'),'utf8')).after).toEqual([{id:330,count:19}]);
 }finally{clearInterval(timer);rmSync(root,{recursive:true,force:true});}
},2000);
