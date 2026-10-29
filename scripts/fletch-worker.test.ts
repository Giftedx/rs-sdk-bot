import {expect,test} from 'bun:test';
import {runFletchingCycle} from './fletch-worker';

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
