import {expect,test} from 'bun:test';
import {waitWoodChild,runFletchingCycle,runWoodProcessingCycle,runWoodProductDrop,type WoodProcessingJob} from './fletch-worker';

test('finite gathered normal logs use canonical cut and string children before a declared product-only drop',async()=>{
 const calls:any[]=[],job:WoodProcessingJob={tree:'normal',product:'shortbow',string:true,finish:'drop',maximum:2,minimumHP:99,cap:4000,reserve:1};
 const r=await runWoodProcessingCycle({stopped:()=>false,run:async(script,env,args)=>{calls.push({script,env,args});const n=calls.length;if(n===1)return{exit:0,output:'RESULT ok ticks=100 died=false banked=2 hpMin=99\nLOGOUT logged-out'};if(n===4)return{exit:0,output:'WOOD_PRODUCT_DROP '+JSON.stringify({ok:true,id:841,dropped:2,preserved:true,ticks:10})+'\nLOGOUT logged-out\nRESULT ok'};return{exit:0,output:'MICROBOT_PRODUCTION '+JSON.stringify({ok:true,recipe:n===2?'cut-bow:unstrung_shortbow':'bow-string:shortbow',attempts:2,made:2,banked:2,losses:0,ticks:20})+'\nLOGOUT logged-out\nRESULT ok'};}},job);
 expect(r.ok).toBe(true);expect(calls.map(c=>c.script)).toEqual(['scripts/gather-yews.ts','scripts/microbot-production.ts','scripts/microbot-production.ts','scripts/fletch-worker.ts']);expect(calls[1].args).toEqual(['cut-bow:unstrung_shortbow']);expect(calls[2].args).toEqual(['bow-string:shortbow']);expect(calls[2].env.RAW_RESERVE).toBe('1');expect(JSON.parse(calls[2].env.INPUT_RESERVES)).toEqual({50:0});expect(calls[1].env.INPUT_RESERVES).toBe('{}');expect(calls[3].args[0]).toBe('--drop-product');expect(r.processed).toBe(2);
});
test('finite gathered oak burn reuses existing burner; partial gather or unknown production never starts a later child',async()=>{
 const job:WoodProcessingJob={tree:'oak',product:'burn',string:false,finish:'bank',maximum:2,minimumHP:99,cap:4000,reserve:1};let calls=0;
 const good=await runWoodProcessingCycle({stopped:()=>false,run:async(script,env)=>{calls++;if(calls===1)return{exit:0,output:'RESULT ok ticks=100 died=false banked=2 hpMin=99\nLOGOUT logged-out'};expect(script).toBe('scripts/firemaking-order.ts');expect(env).toMatchObject({LOG:'oak',MAX_LOGS:'2',TOOL_BUDGET:'0'});return{exit:0,output:'FIREMAKING_ORDER_RESULT '+JSON.stringify({ok:true,logsBurnt:2,ticks:40})+'\nLOGOUT logged-out\nRESULT ok'};}},job);expect(good.ok).toBe(true);expect(calls).toBe(2);
 for(const partial of[true,false]){calls=0;const r=await runWoodProcessingCycle({stopped:()=>false,run:async()=>{calls++;return calls===1?{exit:0,output:`RESULT ok ticks=100 died=false banked=${partial?1:2} hpMin=99\nLOGOUT logged-out`}:{exit:0,output:'MICROBOT_PRODUCTION {"ok":false,"attempts":1}\nRESULT fail'};}},{...job,product:'shortbow'});expect(r.ok).toBe(false);expect(calls).toBe(partial?1:2);}
});

test('a disconnected child is retryable instead of being reported as a fletching prerequisite failure',async()=>{
    const r=await runFletchingCycle({minimumHP:16,stopped:()=>false,run:async()=>({exit:1,output:'RESULT fail session ended: logged-out'})});
    expect(r.ok).toBe(false);expect(r.stage).toBe('disconnected');
});
test('an offline login server or login throttle stays retryable at either production stage',async()=>{
 for(const stage of ['gather','shafts'])for(const detail of ['RESULT fail login: LoginError: Login server offline','RESULT fail login LoginError: Too many login attempts']){
  let calls=0;
  const r=await runFletchingCycle({minimumHP:15,stopped:()=>false,run:async()=>{calls++;return stage==='shafts'&&calls===1?gathered:{exit:1,output:detail};}});
  expect(r.ok).toBe(false);expect(r.stage).toBe('disconnected');expect(r.detail).toBe(detail);
  expect(r.logsBanked).toBe(stage==='shafts'?25:0);expect(calls).toBe(stage==='shafts'?2:1);
 }
});
const gathered={exit:0,output:'RESULT ok died=false banked=25 hpMin=15'};
const crafted={exit:0,output:'SHAFT_BANK '+JSON.stringify({ok:true,logsUsed:25,made:375,banked:375,preserved:true,died:false,damaged:false,targetMet:true,knifeStored:true,hpMin:15})+'\nRESULT ok mode=shafts'};
test('one cycle collects25 raw logs before crafting375 banked shafts with fixed bounded stage settings',async()=>{
 const calls:any[]=[];const r=await runFletchingCycle({minimumHP:15,stopped:()=>false,run:async(script,env)=>{calls.push({script,env});return calls.length===1?gathered:crafted;}});
 expect(r.ok).toBe(true);expect(r.shaftsBanked).toBe(375);expect(calls).toHaveLength(2);
 expect(calls[0].env).toMatchObject({REGION:'draynor',TREE:'normal',MAX_TRIPS:'1',BANK_AT:'25'});
 expect(calls[1].env).toMatchObject({MODE:'shafts',MAX_MAKE:'25',LOG_RESERVE:'0',BANK_KNIFE:'1'});
});
test('partial gathering or HP loss blocks before another login or any input consumption',async()=>{
 for(const line of ['RESULT ok died=false banked=10 hpMin=15','RESULT ok died=false banked=25 hpMin=14']){
  let calls=0;const r=await runFletchingCycle({minimumHP:15,stopped:()=>false,run:async()=>{calls++;return{exit:0,output:line};}});
  expect(r.ok).toBe(false);expect(r.stage).toBe('gather');expect(calls).toBe(1);
 }
});
test('a failed or unbanked craft is not a completed production cycle',async()=>{
 let calls=0;const r=await runFletchingCycle({minimumHP:15,stopped:()=>false,run:async()=>++calls===1?gathered:{exit:0,output:'SHAFT_BANK '+JSON.stringify({ok:true,logsUsed:25,made:375,banked:0,preserved:true,hpMin:15})+'\nRESULT ok'}});
 expect(r.ok).toBe(false);expect(r.stage).toBe('shafts');expect(calls).toBe(2);
});
test('stop between stages leaves the gathered stock banked and starts no craft client',async()=>{
 let stop=false,calls=0;const r=await runFletchingCycle({minimumHP:15,stopped:()=>stop,run:async()=>{calls++;stop=true;return gathered;}});
 expect(r.ok).toBe(false);expect(r.stage).toBe('stopped');expect(calls).toBe(1);
});

test('unknown conservation flags cannot be treated as a successful craft receipt',async()=>{
 let calls=0;const r=await runFletchingCycle({minimumHP:15,stopped:()=>false,run:async()=>++calls===1?gathered:{...crafted,output:crafted.output.replace('"preserved":true','"preserved":"unknown"')}});
 expect(r.ok).toBe(false);expect(r.stage).toBe('shafts');
});

test('new composition requires confirmed child logout and honors stop before another login',async()=>{
 const j:WoodProcessingJob={tree:'normal',product:'shortbow',string:false,finish:'bank',maximum:2,minimumHP:99,cap:4000,reserve:0};
 for(const stopAfter of[false,true]){let stop=false,calls=0;const r=await runWoodProcessingCycle({stopped:()=>stop,run:async()=>{calls++;stop=stopAfter;return{exit:0,output:'RESULT ok ticks=10 died=false banked=2 hpMin=99'+(stopAfter?'\nLOGOUT logged-out':'')};}},j);expect(r.ok).toBe(false);expect(calls).toBe(1);}
});
test('actual product-drop consumer uses dedicated slots and preserves all other stock; unknown drop is never repeated',async()=>{
 for(const outcome of['ok','unknown','foreign','newlife']){
  let tick=0,generation=0,drops=0;const listeners=new Set<()=>void>(),player={lifeId:1,respawnCount:0,isDead:false,level:0},equipment=[{id:1265,count:1,slot:3}],inventory:any[]=[{id:995,count:37,slot:0,name:'Coins'}],bank:any[]=[{id:841,count:3,slot:0,name:'Shortbow'},{id:2357,count:1,slot:1,name:'Gold bar'}];
  const state:any={tick:0,player,inventory,equipment,skills:[{name:'Hitpoints',experience:13034431}],bank:{isOpen:false,items:bank,noteMode:false},interface:{isOpen:false},dialog:{isOpen:false,options:[]},chatMessages:[]};
  const client:any={executeBotAction:()=>{},objType:()=>({certtemplate:-1,stackable:false})};
  const sdk:any={getState:()=>state,getInventory:()=>inventory,getEquipment:()=>equipment,getSkill:()=>({level:99}),getStateAge:()=>0,getNearbyLocs:()=>[],findNearbyNpc:()=>({index:1,distance:1,optionsWithIndex:[{text:'Bank',opIndex:3}]}),
   sendCloseModal:async()=>{state.bank.isOpen=false;state.interface.isOpen=false;},sendInteractNpc:async()=>{state.bank.isOpen=true;state.interface.isOpen=true;generation++;},waitForCondition:async(p:any)=>{if(!p(state))throw Error('test unconfirmed');return state;},
   sendBankWithdraw:async(_slot:number,n:number)=>{bank[0].count-=n;for(let i=0;i<n;i++)inventory.push({id:841,count:1,slot:i+1,name:'Shortbow'});generation++;},
   sendDropItem:async(slot:number)=>{drops++;if(outcome!=='unknown')inventory.splice(inventory.findIndex(i=>i.slot===slot),1);if(outcome==='foreign')client.executeBotAction=()=>{};if(outcome==='newlife')player.lifeId++;}
  };
  const session:any={name:'woodtest',client,sdk,tick:()=>tick,ended:new Promise(()=>{}),onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},bankObservation:()=>({generation,items:bank})};
  const timer=setInterval(()=>{tick++;state.tick=tick;for(const f of [...listeners])f();},2);
  try{const r=await runWoodProductDrop(session,841,2,80);expect(r.ok).toBe(outcome==='ok');expect(drops).toBe(outcome==='ok'?2:1);expect(inventory.find(i=>i.id===995)?.count).toBe(37);expect(bank[1].count).toBe(1);if(outcome==='ok'){expect(r.preserved).toBe(true);expect(bank[0].count).toBe(1);}else expect(r.uncertain).toBe(true);}finally{clearInterval(timer);}
 }
});

test('parent stop terminates its running child and awaits termination before another stage',async()=>{
 const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore',windowsHide:true});let stop=false,kills=0,finished=false;
 const timer=setTimeout(()=>{stop=true;},30);
 try{const code=await waitWoodChild(child,{stop:()=>stop,timeoutMs:2000,kill:async(pid)=>{expect(pid).toBe(child.pid);kills++;child.kill();await child.exited;finished=true;}});expect(code).toBe(1);expect(kills).toBe(1);expect(finished).toBe(true);expect(child.exitCode!==null||child.signalCode!==null).toBe(true);}finally{clearTimeout(timer);if(child.exitCode===null){child.kill();await child.exited;}}
});
