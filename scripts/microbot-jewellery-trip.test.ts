import {test,expect} from 'bun:test';
import{BotSDK}from'../vendor/rs-sdk/sdk/index';
import{settle}from'../packages/core/src/bot';
import {planJewelleryOrder,runJewelleryOrder,validateJewelleryOrder,jewelleryCleanup,type JewelleryOrder,type JewellerySnapshot} from './microbot-jewellery-trip';
import{componentId}from'../packages/core/src/logout';
import {jewelleryRecipes,jewelleryMenu,runJewellery} from './microbot-b-jewellery';
import {inventoryRecipes} from './microbot-production';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const options=(recipe='sapphire_ring'):JewelleryOrder=>({recipe,target:3,batch:13,cap:3000,returnTicks:120,reserve:1,members:true,stringAmulet:false,bank:{x:3269,z:3167,level:0},furnace:{x:3275,z:3186,level:0}});
const stock=()=>({2357:5,1607:2,1623:6,1755:1,1592:1,995:37});

test('finite jewellery plan cuts only the missing gems and retains each initial stock floor',()=>{
 const p=planJewelleryOrder(options(),stock(),99);expect(p.stages.map(s=>[s.family,s.recipe,s.target])).toEqual([['inventory','cut-sapphire',2],['jewellery','sapphire_ring',3]]);
 expect(p.delta).toMatchObject({2357:-3,1623:-2,1607:-1,1637:3});expect(p.product).toBe(1637);
 const ready=planJewelleryOrder(options(),{...stock(),1607:5},99);expect(ready.stages).toHaveLength(1);
});

test('source-selected silver, gem jewellery and amulet stringing reuse existing native recipes',()=>{
 const silver=jewelleryRecipes().find(r=>r.name==='unstrung_symbol')!;
 const p=planJewelleryOrder(options('unstrung_symbol'),{2355:5,[silver.tools[0]!]:1},99);expect(p.stages).toHaveLength(1);expect(p.product).toBe(silver.product);
 const amulet=jewelleryRecipes().find(r=>r.name==='unstrung_sapphire_amulet')!,o={...options('unstrung_sapphire_amulet'),stringAmulet:true};
 const ready=planJewelleryOrder(o,{...stock(),[amulet.tools[0]!]:1,1759:5},99);expect(ready.stages.map(s=>s.family)).toEqual(['inventory','jewellery','inventory']);
 const string=inventoryRecipes().find(r=>r.name==='string-sapphire-amulet')!;expect(ready.product).toBe(string.product);expect(ready.delta[1759]).toBe(-3);
});

test('missing bars, tools, wool, gem stock or base levels fail before production',()=>{
 for(const change of [{2357:3},{1755:0},{1592:0},{1623:1}])expect(()=>planJewelleryOrder(options(),{...stock(),...change},99)).toThrow();
 expect(()=>planJewelleryOrder(options(),stock(),19)).toThrow();
 expect(()=>planJewelleryOrder({...options(),stringAmulet:true},stock(),99)).toThrow();
 expect(()=>validateJewelleryOrder({...options(),cap:Infinity})).toThrow();
});

function fixture(){
 let tick=0,stopped=false;const player={lifeId:1,respawnCount:0,worldX:3269,worldZ:3167,level:0,isDead:false},client={membersAccount:1,selfSlot:1,executeBotAction:()=>{}};
 let assets:Record<number,number>={...stock()},xp=100,foreignXp=0;const calls:string[]=[];
 const s:any={name:'jewelFixture',client,ended:new Promise(()=>{}),tick:()=>tick,sdk:{config:{host:'localhost',port:19081,gatewayUrl:''},getState:()=>({player}),getStateAge:()=>0,getSkill:(name:string)=>({baseLevel:99,level:99}),getSkillXp:()=>xp},direct:async()=>({success:true})};
 const audit=async():Promise<JewellerySnapshot>=>({assets:{...assets},bank:{...assets},pack:{},gear:[],xp:{Crafting:xp,Magic:foreignXp}});
 const job=async(_s:any,j:any,stop:()=>boolean)=>{
  if(stop())throw Error('stopped');calls.push(j.recipe);tick++;
  const r=j.family==='jewellery'?jewelleryRecipes().find(r=>r.name===j.recipe)!:inventoryRecipes().find(r=>r.name===j.recipe)!;
  for(const i of r.inputs)assets[i.id]=(assets[i.id]??0)-i.units*j.target;assets[r.product]=(assets[r.product]??0)+j.target;xp+=j.target;
  return{ok:true,completed:j.target,atBank:true,banked:{[r.product]:j.target},failure:'-'};
 };
 return{s,client,player,calls,audit,job,options:options(),stop:()=>stopped,setStop:()=>{stopped=true;},drift:()=>{assets[995]!--;},foreignXp:()=>{foreignXp++;},supply:(id:number,count:number)=>{assets[id]=count;},assets:()=>({...assets})};
}

test('owned-stock order composes gem cutting and furnace banking with a complete ledger',async()=>{
 const f=fixture();const r=await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job:f.job});
 expect(r).toMatchObject({ok:true,made:3,product:1637,preserved:true,uncertain:false,banked:3});expect(f.calls).toEqual(['cut-sapphire','sapphire_ring']);
});

test('a failed or drifting child parks the order and cannot spend the next stage',async()=>{
 for(const mode of ['failed','drift','life','owner','sdk','direct','slot','endpoint','stop']){
  const f=fixture();const job=async(...args:Parameters<typeof f.job>)=>{const r=await f.job(...args);if(mode==='drift')f.drift();if(mode==='life')f.player.lifeId++;if(mode==='owner')f.client.executeBotAction=()=>{};if(mode==='sdk')f.s.sdk={...f.s.sdk};if(mode==='direct')f.s.direct=async()=>({success:true});if(mode==='slot')f.client.selfSlot++;if(mode==='endpoint')f.s.sdk.config.port++;if(mode==='stop')f.setStop();return{...r,ok:mode!=='failed'};};
  const r=await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job});expect(r.ok).toBe(false);expect(f.calls).toHaveLength(1);
 }
});

test('preexisting stop sends no production job and keeps the order finite',async()=>{
 const f=fixture();f.setStop();const r=await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job:f.job});expect(r.ok).toBe(false);expect(f.calls).toHaveLength(0);
});

test('all 23 native furnace recipes have a finite owned-stock plan',()=>{
 for(const recipe of jewelleryRecipes()){
  const assets:Record<number,number>={995:37};for(const input of recipe.inputs)assets[input.id]=4*input.units;for(const tool of recipe.tools)assets[tool]=1;
  const p=planJewelleryOrder(options(recipe.name),assets,99);expect(p.product).toBe(recipe.product);expect(p.stages).toHaveLength(1);expect(p.stages[0]!.target).toBe(3);
 }
});

test('three-stage amulet order banks the strung product and preserves initial cut gems and wool reserve',async()=>{
 const f=fixture(),recipe=jewelleryRecipes().find(r=>r.name==='unstrung_sapphire_amulet')!;
 f.supply(recipe.tools[0]!,1);f.supply(1759,4);
 const r=await runJewelleryOrder(f.s,{...options(recipe.name),stringAmulet:true},f.stop,{audit:f.audit,job:f.job});
 expect(r).toMatchObject({ok:true,made:3,banked:3,preserved:true});expect(f.calls).toEqual(['cut-sapphire','unstrung_sapphire_amulet','string-sapphire-amulet']);expect(f.assets()[1759]).toBe(1);expect(f.assets()[1607]).toBe(1);
});

test('fresh pre-stage stock drift and unrelated XP prevent a false pipeline pass',async()=>{
 const f=fixture();let n=0;const audit=async()=>{if(++n===2)f.drift();return f.audit();};
 expect((await runJewelleryOrder(f.s,f.options,f.stop,{audit,job:f.job})).ok).toBe(false);expect(f.calls).toHaveLength(0);
 const g=fixture(),job=async(...args:Parameters<typeof g.job>)=>{const r=await g.job(...args);g.foreignXp();return r;};
 expect((await runJewelleryOrder(g.s,g.options,g.stop,{audit:g.audit,job})).ok).toBe(false);expect(g.calls).toHaveLength(1);
});

test('stale observations and a thrown child cannot continue the order',async()=>{
 const f=fixture();f.s.sdk.getStateAge=()=>6000;expect((await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job:f.job})).ok).toBe(false);expect(f.calls).toHaveLength(0);
 const g=fixture(),job=async(...args:Parameters<typeof g.job>)=>{await g.job(...args);throw Error('unknown dispatch');};
 const r=await runJewelleryOrder(g.s,g.options,g.stop,{audit:g.audit,job});expect(r.ok).toBe(false);expect(r.uncertain).toBe(true);expect(g.calls).toHaveLength(1);
});

test('cleanup refuses replacement before logout, and guards a handoff during the logout await',async()=>{
 const f=fixture();let final=0,inputs=0;const cleanup=jewelleryCleanup(f.s,async(_s,_ok,_detail,options)=>{final++;await options?.logout?.(f.s);return true;},async()=>{inputs++;return'logged-out';});f.s.sdk={...f.s.sdk};expect(await cleanup.finish(false,'replaced')).toBe(false);expect(final).toBe(0);expect(inputs).toBe(0);
 const g=fixture();let sends=0;g.s.direct=async()=>{sends++;return{success:true};};const race=jewelleryCleanup(g.s,async(rows,_ok,_detail,options)=>{await options?.logout?.(rows[0]!);final++;return true;},async session=>{g.s.sdk={...g.s.sdk};expect(()=>session.direct({type:'clickComponent',componentId:1,reason:'logout test'})).toThrow('replaced');return'logged-out';});const previous=process.exitCode;try{expect(await race.finish(true,'done')).toBe(false);expect(sends).toBe(0);expect(final).toBe(0);}finally{process.exitCode=previous??0;}
});

test('confirmed logout allows original close but cannot authorize a replacement player slot',async()=>{
 for(const replace of [false,true]){
  const f=fixture();let closed=0;f.s.close=async()=>{closed++;};f.s.ended=Promise.resolve({reason:'logged-out'});
  const cleanup=jewelleryCleanup(f.s,async sessions=>{await sessions[0]!.close();return true;});
  await Promise.resolve();
  if(replace)(f.s.client as any).selfSlot=2;
  expect(await cleanup.finish(true,'terminal')).toBe(!replace);expect(closed).toBe(replace?0:1);
 }
});

test('actual CLI rejects an unsupported finish before opening an account',()=>{
 const folder=mkdtempSync(join(tmpdir(),'jewellery-preflight-')),path=join(folder,'order.json');
 try{
  writeFileSync(path,JSON.stringify({...options(),stringAmulet:true}));
  const r=spawnSync(process.execPath,[join(import.meta.dir,'microbot-jewellery-trip.ts'),'__jewellery_preflight__',path],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,DEMO_OK:''}});
  expect(r.status).toBe(1);expect(r.stderr).toContain('native amulet stringing unavailable');expect(r.stdout).not.toContain('JEWELLERY_ORDER ');
 }finally{unlinkSync(path);rmdirSync(folder);}
});


test('cleanup confirms guarded logout before finalizing the ORIGINAL session and actual Core close',async()=>{
 const f=fixture();let end!:(v:{reason:string})=>void,inputs=0,closed=0,reported=false;f.s.ended=new Promise(r=>{end=r;});f.s.close=async()=>{closed++;};f.s.direct=async()=>{inputs++;throw Error('second logout input');};const cleanup=jewelleryCleanup(f.s,async(sessions,_ok,_detail,options)=>{expect(sessions[0]).toBe(f.s);expect(typeof options?.logout).toBe('function');return settle(sessions,true,'canonical jewellery test',{...options,onReported:()=>{reported=true;},log:()=>{}});},async view=>{expect(reported).toBe(true);expect(view).not.toBe(f.s);end({reason:'logged-out'});await Promise.resolve();return'logged-out';});expect(await cleanup.finish(true,'done')).toBe(true);expect(closed).toBe(1);expect(inputs).toBe(0);
});

test('actual SDK reconnect cannot send through a replaced owner and foreign CLI cleanup emits no logout',async()=>{
 const f=fixture();let wires=0,logouts=0;const read=f.s.sdk.getState;const sdk:any=new BotSDK({botUsername:'jewelFixture',actionTimeout:20});Object.assign(sdk,{getState:read,getStateAge:()=>0,getSkill:()=>({baseLevel:99,level:99})});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();f.client.executeBotAction=()=>{};sdk.connectionState='connected';};f.s.sdk=sdk;const cleanup=jewelleryCleanup(f.s,async()=>{throw Error('foreign finalizer');},async()=>{logouts++;return'logged-out';});const r=await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job:async(s,j)=>{const sent=await s.sdk.sendUseItem(0,1);return{ok:sent.success,completed:0,atBank:true,banked:{}};}});expect(r.ok).toBe(false);expect(wires).toBe(0);expect(await cleanup.finish(false,'foreign')).toBe(false);expect(logouts).toBe(0);
});


test('stop during actual furnace open sends zero Make and permits known owned bank/close cleanup',async()=>{
 const f=fixture();f.supply(1607,5);let make=0,closed=0,banked=0;const r=jewelleryRecipes().find(r=>r.name==='sapphire_ring')!,items=r.inputs.map((i,slot)=>({id:i.id,count:3,slot}));items.push({id:r.tools[0]!,count:1,slot:2});const state={player:f.player,skills:[{name:'Hitpoints',level:99,experience:100},{name:'Crafting',level:99,experience:100}],inventory:items,equipment:[]};f.s.sdk.getState=()=>state;f.s.sdk.getInventory=()=>items;f.s.sdk.sendCloseModal=async()=>{closed++;return{success:true};};f.s.sdk.sendClickComponentWithOption=async()=>{make++;return{success:true};};f.s.sdk.sendInteractLoc=async()=>{banked++;return{success:true};};
 const result=await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job:async(s,j)=>{try{await runJewellery({state:()=>state as any,tick:()=>s.tick(),stop:f.stop,open:async()=>{f.setStop();return true;},close:async()=>{await s.sdk.sendCloseModal();},choose:async menu=>(await s.sdk.sendClickComponentWithOption(componentId(menu.component),menu.option!,menu.slot)).success,wait:async()=>false,step:async()=>{}},r,{maximum:j.target,cap:100,members:true});}catch{}finally{await s.sdk.sendInteractLoc(3269,3167,2213,1);}return{ok:false,atBank:true,completed:0,banked:{}};}});expect(result.ok).toBe(false);expect(make).toBe(0);expect(closed).toBe(2);expect(banked).toBe(1);
});


test('ordinary stop during real SDK reconnect blocks the final native Make wire while ownership remains valid',async()=>{
 const f=fixture();f.supply(1607,5);let wires=0;const read=f.s.sdk.getState,sdk:any=new BotSDK({botUsername:'jewelFixture',actionTimeout:20});Object.assign(sdk,{getState:read,getStateAge:()=>0,getSkill:()=>({baseLevel:99,level:99})});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();f.setStop();sdk.connectionState='connected';};f.s.sdk=sdk;const recipe=jewelleryRecipes().find(r=>r.name==='sapphire_ring')!,menu=jewelleryMenu(recipe,{},true);const result=await runJewelleryOrder(f.s,f.options,f.stop,{audit:f.audit,job:async(s)=>{const reply=await s.sdk.sendClickComponentWithOption(componentId(menu.component),menu.option!,menu.slot);return{ok:reply.success,completed:0,atBank:true,banked:{}};}});expect(result.ok).toBe(false);expect(wires).toBe(0);expect(f.client.executeBotAction).toBe(f.s.client.executeBotAction);
});


test('cleanup cannot finalize a close-function replacement made during confirmed logout',async()=>{
 const f=fixture();let final=0;const previous=process.exitCode;try{const cleanup=jewelleryCleanup(f.s,async(rows,_ok,_detail,options)=>{await options?.logout?.(rows[0]!);final++;return true;},async()=>{f.s.close=async()=>{};return'logged-out';});expect(await cleanup.finish(true,'handoff')).toBe(false);expect(final).toBe(0);}finally{process.exitCode=previous??0;}
});
