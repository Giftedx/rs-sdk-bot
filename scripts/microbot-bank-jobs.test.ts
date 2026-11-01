import{test,expect}from'bun:test';
import{fittingBankBatch,validateBankJob,runBankProfile,type BankJob}from'./microbot-bank-jobs';
test('bank refill sizes use native occupied slots rather than aggregate item counts',()=>{
 const stackable=(id:number)=>[995,554,561].includes(id);
 expect(fittingBankBatch({2357:1,1607:1},[1592],30,28,stackable)).toBe(13);
 expect(fittingBankBatch({1739:1,995:20},[],30,28,stackable)).toBe(27);
 expect(fittingBankBatch({440:1,453:8,554:4,561:1},[],3,28,stackable)).toBe(2);
 expect(fittingBankBatch({1783:1,1781:1},[],20,27,stackable)).toBe(13);
 expect(fittingBankBatch({2357:1,1607:1},[1592],1,2,stackable)).toBe(0);
 expect(fittingBankBatch({1889:1},[],28,28,stackable,{1891:1,1887:1})).toBe(14);
 expect(fittingBankBatch({2357:1,1607:1},[1592],1000000000,28,stackable)).toBe(13);
});
test('bank route cannot spend its reserved return budget as production time',()=>{
 const job:BankJob={family:'tanning',recipe:'soft',target:3,batch:1,cap:200,returnTicks:50,members:true};
 expect(()=>validateBankJob(job)).not.toThrow();
 for(const change of [{cap:50},{target:0},{batch:-1},{returnTicks:0},{reserve:-1},{bank:{x:1.5,z:2,level:0}},{family:'eval'}])expect(()=>validateBankJob({...job,...change}as BankJob)).toThrow();
});

test('external bank profiles reject invented native items and invalid counts before session access',async()=>{
 const j={family:'merchant',recipe:'1205',target:2,batch:1,cap:200,returnTicks:50,members:true},p={inputs:{1205:1},outputs:[995],tools:[],bank:{x:3269,z:3167,level:0},site:{x:3314,z:3180,level:0},run:async()=>1};
 await expect(runBankProfile(null as any,j,{...p,inputs:{999999:1}})).rejects.toThrow('native item unknown');
 await expect(runBankProfile(null as any,j,{...p,inputs:{1205:-1}})).rejects.toThrow('count invalid');
 await expect(runBankProfile(null as any,j,{...p,capacityOutputs:{995:-1}})).rejects.toThrow('count invalid');
 await expect(runBankProfile(null as any,j,{...p,site:{x:1,z:2,level:4}})).rejects.toThrow('tile invalid');
});

test('a teleport followed by exhausted return budget cannot retain a stale bank flag',async()=>{
 let tick=0,bankOpen=true,player={name:'Owned',lifeId:1,level:0,worldX:3185,worldZ:3436};const s:any={name:'Owned',tick:()=>tick,ended:new Promise(()=>{}),client:{objType:()=>({stackable:true})},bankObservation:()=>({generation:1,items:[]}),onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getState:()=>({player,bank:{isOpen:bankOpen,items:[]},interface:{isOpen:false},dialog:{isOpen:false}}),getInventory:()=>[],getSkill:()=>({level:99}),sendCloseModal:async()=>{}},bot:{closeBank:async()=>{bankOpen=false;}}};
 const bank={x:3185,z:3436,level:0},result=await runBankProfile(s,{family:'magic-teleport',recipe:'varrock',target:1,batch:1,cap:100,returnTicks:50,members:true},{bank,site:bank,inputs:{},tools:[],outputs:[],run:async()=>{player={...player,worldX:3213,worldZ:3424};tick=101;return 1;}});
 expect(result.completed).toBe(1);expect(result.ok).toBe(false);expect(result.atBank).toBe(false);expect(result.failure).toContain('stopped before travel');
});

test('a replaced life at the same bank cannot authorize cleanup on the new life',async()=>{
 let tick=0,open=true;const player={name:'Owned',lifeId:1,level:0,worldX:3185,worldZ:3436},s:any={name:'Owned',tick:()=>tick,ended:new Promise(()=>{}),client:{objType:()=>({stackable:true})},bankObservation:()=>({generation:1,items:[]}),onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getState:()=>({player,bank:{isOpen:open,items:[]},interface:{isOpen:false},dialog:{isOpen:false}}),getInventory:()=>[],getSkill:()=>({level:99}),sendCloseModal:async()=>{}},bot:{closeBank:async()=>{open=false;}}};
 const bank={x:3185,z:3436,level:0},result=await runBankProfile(s,{family:'magic-teleport',recipe:'varrock',target:1,batch:1,cap:100,returnTicks:50,members:true},{bank,site:bank,inputs:{},tools:[],outputs:[],run:async()=>{player.lifeId=2;return 1;}});
 expect(result.ok).toBe(false);expect(result.atBank).toBe(false);
});
