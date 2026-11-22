import {expect,test} from 'bun:test';
import {resolve} from 'node:path';

type Scenario={mode:'fanout'|'fanin';transferFail?:string;settleFail?:string;interrupt?:'disconnect'|'stop';ownershipLost?:boolean;
 finalBankRefused?:boolean;shortWithdraw?:boolean;shortTradeCredit?:boolean;shortBankCredit?:boolean};

// Run the real multi-account owners in children so mocked session boundaries never
// replace the game modules used by another test file in the same Bun process.
function completionCase(config:Scenario){
 const code=`
 import {mock} from 'bun:test';import {join,resolve} from 'node:path';
 const config=${JSON.stringify(config)},sessions=new Map(),opened=[],settled=[],transfers=[],logs=[];
 let released=0;
 const realFs=await import('node:fs'),readFile=realFs.readFileSync;
 const envFiles=new Set(['Treasury','First','Second','Receiver'].map(name=>join(process.cwd(),'vendor/rs-sdk/bots',name,'bot.env')));
 mock.module('node:fs',()=>({...realFs,readFileSync:(path,...args)=>envFiles.has(String(path))?'SERVER=127.0.0.1:21800\\n':readFile(path,...args)}));
 const add=(inventory,id,n)=>{let item=inventory.find(i=>i.id===id);if(item)item.count+=n;else inventory.push({id,count:n,name:id===314?'Feather':'Coins',slot:inventory.length});};
 const held=(inventory,id)=>inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const persistent=config.mode==='fanout'?'Treasury':'Receiver';
 const interrupt=async()=>{if(!config.interrupt)return;const owner=sessions.get(persistent);await owner.options[config.interrupt==='stop'?'onStop':'onSessionEnd']();};
 const openBot=async(name,options)=>{
  opened.push(name);
  const inventory=name==='Receiver'?[{id:314,count:2,name:'Feather',slot:0},{id:1265,count:1,name:'Bronze pickaxe',slot:1}]:[];
  const bank=new Map(name==='Receiver'?[[314,3],[995,7]]:[[314,name==='First'?10:20],[995,11]]);
  let generation=0,bankOpen=false,opens=0;
  const player={worldX:3183,worldZ:3440,level:0},rows=()=>[...bank].filter(([,count])=>count>0).map(([id,count])=>({id,count,name:id===314?'Feather':'Coins'}));
  const s={name,options,inventory,bank,tick:()=>0,player,
   bankObservation:()=>bankOpen?{generation,items:rows()}:null,
   sdk:{getInventory:()=>inventory,getState:()=>({player,bank:{isOpen:bankOpen,items:rows()}})},
   bot:{walkTo:async(x,z)=>{player.worldX=x;player.worldZ=z;return{success:true};},
    openBank:async()=>{opens++;if(name==='Receiver'&&opens===2&&config.finalBankRefused)return{success:false};bankOpen=true;generation++;return{success:true};},
    closeBank:async()=>{bankOpen=false;return{success:true};},
    withdrawItem:async(pattern,n)=>{
     if(!(pattern instanceof RegExp)||!pattern.test('Feather')||pattern.test('Feathers'))throw Error('fixture withdrawal requires exact Feather RegExp');
     const id=314,taken=name==='Second'&&config.shortWithdraw?n-1:n;
     bank.set(id,bank.get(id)-taken);add(inventory,id,taken);generation++;return{success:true};},
    serveTrades:async()=>({success:true}),trade:async()=>({success:true})},
   deposit:async(item)=>{const n=held(inventory,item.id);for(let i=inventory.length-1;i>=0;i--)if(inventory[i].id===item.id)inventory.splice(i,1);
    bank.set(item.id,(bank.get(item.id)??0)+n-(config.shortBankCredit&&item.id===314?1:0));generation++;return n;}};
  sessions.set(name,s);return s;
 };
 const settle=async(list,ok,detail)=>{
  for(const s of list){settled.push({name:s.name,ok,detail});await s.options.onSessionEnd();}
  return ok&&!list.some(s=>s.name===config.settleFail);
 };
 const parseCoins=([donor,receiver,amount])=>({donor,receiver,amount:Number(amount)});
 const moveCoins=async(c,_sessions,_journal,_server,check)=>{
  check();if(c.receiver===config.transferFail)throw Error('fixture transfer refused '+c.receiver);
  transfers.push({from:c.donor,to:c.receiver,count:c.amount});
  if(c.receiver==='First')await interrupt();
 };
 const createHandoff=()=>({
  sendHandoff:async(donor,to,_server,want,perform)=>{
   if(donor.name===config.transferFail)throw Error('fixture transfer refused '+donor.name);
   await perform();const receiver=sessions.get(to);
   for(const item of want){
    const existing=donor.inventory.find(i=>i.id===item.id);existing.count-=item.count;
    for(let i=donor.inventory.length-1;i>=0;i--)if(donor.inventory[i].count===0)donor.inventory.splice(i,1);
    add(receiver.inventory,item.id,item.count-(config.shortTradeCredit&&donor.name==='Second'?1:0));
    transfers.push({from:donor.name,to,count:item.count});
   }
   if(donor.name==='First')await interrupt();
  },
  receiveHandoff:async(_receiver,_from,_server,perform)=>perform(),
 });
 const realBot=await import('./packages/core/src/bot');
 const realWalk=await import('./packages/core/src/walk');
 const realTicks=await import('./packages/core/src/ticks');
 const realCargo=await import('./packages/core/src/cargo');
 const realAdmission=await import('./packages/workers/src/logistics/admission');
 const realHandoff=await import('./packages/workers/src/logistics/handoff');
 const realLocation=await import('./packages/workers/src/logistics/location');
 const modules={
  './packages/core/src/bot':{...realBot,openBot,settle,serverFromEnv:()=> '127.0.0.1:21800',assertServerAllowed:()=>{},getWorld:async()=>({}),accountOf:()=>({})},
  './packages/core/src/walk':{...realWalk,goTo:async()=>({ok:true})},
  './packages/core/src/ticks':{...realTicks,waitUntil:async(_s,predicate)=>predicate()},
  './packages/core/src/deposit':{depositObserved:async(s,item)=>s.deposit(item)},
  './packages/core/src/cargo':{...realCargo,exactItem:name=>new RegExp('^'+name+'$','i')},
  './packages/workers/src/logistics/handoff':{...realHandoff,createHandoff},
  './packages/workers/src/logistics/admission':{...realAdmission,acquireAccountLeases:()=>()=>{released++;},checkTransferAccounts:(_root,names)=>{
   if(config.ownershipLost&&transfers.length>0&&names.includes('Second'))throw Error('fixture ownership changed before Second');
  },transferOrderKey:value=>value},
  './packages/workers/src/logistics/location':{...realLocation,meetingTiles:()=>[{x:3183,z:3440,level:0},{x:3182,z:3440,level:0}]},
 };
 for(const [path,module]of Object.entries(modules))mock.module(resolve(path),()=>module);
 console.log=(...args)=>logs.push(args.join(' '));
 let result;
 if(config.mode==='fanout'){
  const {coinFanoutMain}=await import('./packages/workers/src/logistics/trade');result=await coinFanoutMain(['Treasury','First','Second','50'],process.env,{moveCoins});
 }else{
  const {itemFaninMain}=await import('./packages/workers/src/logistics/trade');result=await itemFaninMain(['Receiver','First','Second','Feather']);
 }
 process.stdout.write(JSON.stringify({result,exitCode:process.exitCode,opened,settled,transfers,released,logs,
  receiver:sessions.has('Receiver')?{bank:Object.fromEntries(sessions.get('Receiver').bank),inventory:sessions.get('Receiver').inventory}:null}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),stdout:'pipe',stderr:'pipe',windowsHide:true,timeout:10000,
  env:{...process.env,COIN_ORDER:'completion-fixture',ITEM_ORDER:'completion-fixture',COORDINATOR_RUN_ID:''}});
 const output=child.stdout.toString();
 if(!output)throw Error(child.stderr.toString()||'completion fixture wrote no result');
 let result:any;
 try{result=JSON.parse(output);}catch{throw Error(output+'\n'+child.stderr.toString());}
 expect(child.exitCode).toBe(result.exitCode);
 expect(result.released).toBe(1);
 return result;
}

test('coin fan-out completes every receiver despite the expected logout callback between pairs',()=>{
 const r=completionCase({mode:'fanout'});
 expect(r.result.ok).toBe(true);expect(r.exitCode).toBe(0);
 expect(r.opened).toEqual(['Treasury','First','Second']);
 expect(r.transfers).toEqual([{from:'Treasury',to:'First',count:50},{from:'Treasury',to:'Second',count:50}]);
 expect(r.settled.map((s:{name:string})=>s.name)).toEqual(['First','Second','Treasury']);
 expect(r.logs).toContain('FANOUT_SUMMARY {"ok":true,"completed":2,"requested":2,"cancelled":false}');
});

test('coin fan-out reports partial delivery or an unconfirmed participant settlement as failure',()=>{
 for(const config of [{transferFail:'Second'},{settleFail:'First'},{settleFail:'Treasury'}]){
  const r=completionCase({mode:'fanout',...config});
  expect(r.result.ok).toBe(false);expect(r.exitCode).toBe(1);
  expect(r.transfers[0]).toEqual({from:'Treasury',to:'First',count:50});
 }
});

test('a disconnected or stopped owner cannot leave a partially finished fan-out successful',()=>{
 for(const interrupt of ['disconnect','stop'] as const){
  const r=completionCase({mode:'fanout',interrupt});
  expect(r.result.ok).toBe(false);expect(r.exitCode).toBe(1);
  expect(r.opened).toEqual(['Treasury','First']);
  expect(r.transfers.length).toBe(1);
 }
});

test('fan-out rechecks changed ownership before opening another receiver session',()=>{
 const r=completionCase({mode:'fanout',ownershipLost:true});
 expect(r.result.ok).toBe(false);expect(r.exitCode).toBe(1);
 expect(r.opened).toEqual(['Treasury','First']);
 expect(r.result.results[1].detail).toContain('ownership changed before Second');
 expect(r.transfers).toEqual([{from:'Treasury',to:'First',count:50}]);
});

test('item fan-in closes each donor and banks both exact credits with original receiver stock retained',()=>{
 const r=completionCase({mode:'fanin'});
 expect(r.result).toMatchObject({ok:true,banked:true});expect(r.exitCode).toBe(0);
 expect(r.opened).toEqual(['Receiver','First','Second']);
 expect(r.transfers).toEqual([{from:'First',to:'Receiver',count:10},{from:'Second',to:'Receiver',count:20}]);
 expect(r.receiver.bank).toEqual({314:35,995:7});
 expect(r.receiver.inventory).toEqual([{id:1265,count:1,name:'Bronze pickaxe',slot:1}]);
 expect(r.settled.map((s:{name:string})=>s.name)).toEqual(['First','Second','Receiver']);
});

test('item fan-in requires every donor and every participant settlement to finish',()=>{
 for(const config of [{transferFail:'Second'},{settleFail:'First'},{settleFail:'Receiver'}]){
  const r=completionCase({mode:'fanin',...config});
  expect(r.result.ok).toBe(false);expect(r.exitCode).toBe(1);
  expect(r.transfers[0]).toEqual({from:'First',to:'Receiver',count:10});
 }
});

test('fan-in rejects a refused final bank and non-exact withdrawal, trade or bank credits',()=>{
 for(const config of [{finalBankRefused:true},{shortWithdraw:true},{shortTradeCredit:true},{shortBankCredit:true}]){
  const r=completionCase({mode:'fanin',...config});
  expect(r.result.ok).toBe(false);expect(r.exitCode).toBe(1);
  if(config.shortWithdraw)expect(r.transfers).toEqual([{from:'First',to:'Receiver',count:10}]);
  if(config.finalBankRefused)expect(r.result.banked).toBe(false);
 }
});

test('a disconnected or stopped receiver cancels fan-in without reporting held stock as delivered',()=>{
 for(const interrupt of ['disconnect','stop'] as const){
  const r=completionCase({mode:'fanin',interrupt});
  expect(r.result.ok).toBe(false);expect(r.exitCode).toBe(1);expect(r.result.banked).toBe(false);
  expect(r.opened).toEqual(['Receiver','First']);
 }
});
