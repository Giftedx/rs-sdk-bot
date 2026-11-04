import {test,expect,spyOn} from 'bun:test';
import type {Session} from '../packages/core/src/inprocess';
import {sharkEntry,sharkAssets,sharkAssetCheck,harpoonPurchase,supplySharks,sharkOrderConfig,sharkSummary,sharkRoutePlan,guardSharkRoute,claimSharkOrder,settleSharkOrder} from './shark-supply';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('a finite order key is claimed once; duplicate and uncertain output refuse any unchanged retry',()=>{
    const dir=mkdtempSync(join(tmpdir(),'shark-order-'));
    try{
        const order={target:25,maxTicks:9000,consumer:'staging'},result={ok:true,banked:25,caught:26,cooked:25,burnt:1,failure:''};
        const path=claimSharkOrder(dir,'Mightyrod','pilot-25',order,1);
        expect(()=>claimSharkOrder(dir,'mightyrod','pilot-25',order,2)).toThrow('uncertain output (started)');
        settleSharkOrder(path,result,3);expect(JSON.parse(readFileSync(path,'utf8'))).toMatchObject({state:'completed',result:{banked:25}});
        expect(()=>claimSharkOrder(dir,'Mightyrod','pilot-25',order,4)).toThrow('already completed; duplicate refused');
        const failed=claimSharkOrder(dir,'Mightyrod','batch-100',{...order,target:100},5);settleSharkOrder(failed,{...result,ok:false,banked:7,failure:'stop'},6);
        expect(()=>claimSharkOrder(dir,'Mightyrod','batch-100',order,7)).toThrow('uncertain output (failed)');
        writeFileSync(join(dir,'mightyrod','broken.json'),'{');expect(()=>claimSharkOrder(dir,'Mightyrod','broken',order)).toThrow('uncertain output (unreadable)');
        for(const [a,k] of [['../x','k'],['Rod','../k'],['Rod','']])expect(()=>claimSharkOrder(dir,a!,k!,order)).toThrow('identity');
        const other=claimSharkOrder(dir,'Rod','pilot-25',order);writeFileSync(other,JSON.stringify({state:'started',pid:-1}));expect(()=>settleSharkOrder(other,result)).toThrow('ownership');
    }finally{rmSync(dir,{recursive:true,force:true});}
});
import {walkPath,type PathDeps,type PathTile} from '../packages/core/src/walk';
import {resultCounters} from '../packages/core/src/status';
import {sharkSpot,catchSharks,sharkFishingTrace,SHARK_IDLE_TICKS,SHARK_PROGRESS_TICKS} from './gather-fish';
import {sharkCookDelta,cookSharks} from './cook-food';

const spot={id:322,index:5,name:'Fishing spot',x:2845,z:3431,distance:3,optionsWithIndex:[{text:'Net',opIndex:1},{text:'Harpoon',opIndex:3}]};
test('normal controller MAX_COOKED/CAP assignments and flat acceptance counters reach the consumer',()=>{
    expect(sharkOrderConfig([],{MAX_COOKED:'100',CAP:'12000'})).toMatchObject({target:100,maxTicks:12000});
    expect(sharkOrderConfig(['25','3000'],{MAX_COOKED:'100',CAP:'12000'})).toMatchObject({target:25,maxTicks:3000});
    expect(resultCounters('ok '+sharkSummary({banked:100,caught:102,cooked:100,burnt:2,coinsSpent:5,ticks:2500}))).toMatchObject({newBankedSharks:100,caught:102,burnt:2});
});
test('sharks require the pinned memberfish identity and Net/op3, never rarefish',()=>{
    expect(sharkSpot(spot)).toBe(true);
    expect(sharkSpot({...spot,id:324})).toBe(false);
    expect(sharkSpot({...spot,optionsWithIndex:[{text:'Cage',opIndex:1},{text:'Harpoon',opIndex:3}]})).toBe(false);
    expect(sharkSpot({...spot,optionsWithIndex:[{text:'Net',opIndex:1},{text:'Harpoon',opIndex:2}]})).toBe(false);
});
test('entry accepts dated ordinary west bank and Catherby only on ground floor',()=>{
    expect(sharkEntry({worldX:2618,worldZ:3332,level:0})).toBe('west-bank');
    expect(sharkEntry({worldX:2809,worldZ:3441,level:0})).toBe('catherby');
    for(const p of [undefined,{worldX:2618,worldZ:3332,level:1},{worldX:3092,worldZ:3243,level:0}])expect(sharkEntry(p)).toBeNull();
});
test('tool funds retain1000 and reject over200, unknown cost, empty shop',()=>{
    expect(harpoonPurchase(5,2,1200)).toBe(true);expect(harpoonPurchase(200,1,1200)).toBe(true);
    for(const [price,stock,cash] of [[201,1,5408],[5,0,1200],[5,1,1004],[NaN,1,1200],[-1,1,1200]])expect(harpoonPurchase(price!,stock!,cash!)).toBe(false);
});
test('conservation independently accounts raw, cooked, burnt, food, paid tool and unrelated kit',()=>{
    const a=sharkAssets([{id:995,count:5408},{id:329,count:312},{id:1275,count:1},{id:385,count:7}]);
    const b=sharkAssets([{id:995,count:5403},{id:329,count:308},{id:1275,count:1},{id:311,count:1},{id:385,count:32},{id:387,count:3}]);
    const r={caught:28,cooked:25,burnt:3,coinsSpent:5,toolBought:1,consumed:{329:4}};
    expect(sharkAssetCheck(a,b,r)).toBe(true);
    expect(sharkAssetCheck(a,{...b,385:7},r)).toBe(false);
    expect(sharkAssetCheck(a,{...b,1275:0},r)).toBe(false);
    expect(sharkAssetCheck(a,b,{...r,caught:27})).toBe(false);
});
test('cooking requires exact raw debit to cooked plus burnt, rejects unexplained loss',()=>{
    expect(sharkCookDelta({raw:4,cooked:3,burnt:1},{raw:0,cooked:6,burnt:2})).toEqual({raw:4,cooked:3,burnt:1});
    expect(()=>sharkCookDelta({raw:4,cooked:3,burnt:1},{raw:0,cooked:5,burnt:2})).toThrow('reconcile');
});
// A real tick-driven fake. No wall sleeps, login, bank presets or SDK success credit.
// The server copies pinned memberfish.rs2 attempt_fish_shark/fish_shark and %action_delay:
// op3 starts (stale delay), confirms at +4, rolls at 0 and otherwise ends the action without p_opnpc.
// Start and every roll replay the harpoon animation; it shows3 ticks, then3 ticks of -1 (cWx27l's longest live gap).
function fixture({tool=true,full=false,wrong=false,moving=false,burn=false,hit=(_roll:number):boolean=>true,refuse=false,animate=true}={}) {
    let tick=0,clicks:number[]=[],cookClicks=0,delay=-1,fishing=-1,pending=-1,rolls=0,kills=0,observation=0,animAt=-99;
    let items:any[]=[...(tool?[{id:311,count:1,slot:0,name:'Harpoon'}]:[]),...(full?Array.from({length:27},(_,i)=>({id:436,count:1,slot:i+1,name:'Copper ore'})):[])];
    const st:any={inGame:true,player:{worldX:2845,worldZ:3431,level:0},equipment:[],gameMessages:[],nearbyNpcs:[{...spot,id:wrong?324:322}],nearbyLocs:[{id:1,name:'Range',x:2817,z:3443}]};
    const say=(text:string)=>st.gameMessages.push({type:0,text,tick,observationId:++observation,fromSelf:false,sender:''});
    const roll=()=>{animAt=tick;if(hit(rolls++)){items.push({id:383,count:1,slot:items.length,name:'Raw shark'});say('You catch a shark!');}};
    const server=()=>{
        if(pending>=0){if(delay===tick+4){say('You start Harpooning fish.');animAt=tick;fishing=pending;}pending=-1;return;}
        if(fishing<0)return;
        if(!st.nearbyNpcs.some((n:any)=>n.index===fishing&&n.id===322)||items.length>=28){fishing=-1;return;}
        if(delay<tick)delay=tick+5;else if(delay===tick)roll();
    };
    const listeners=new Set<()=>void>();
    const loop=setInterval(()=>{tick++;server();if(animate)st.player.animId=tick-animAt<3?618:-1;for(const f of [...listeners])f();},1);
    const s={name:'test',sdk:{getState:()=>st,getInventory:()=>items,getSkill:()=>({level:99,baseLevel:99}),
        sendInteractNpc:async(index:number,op:number)=>{
            clicks.push(op);
            if(moving&&clicks.length===1){st.nearbyNpcs=[{...spot,index:6,x:2846}];return {success:true};}
            if(refuse||!st.nearbyNpcs.some((n:any)=>n.index===index&&n.id===322))return {success:true};
            const was=fishing;fishing=-1;pending=-1;
            if(delay<tick){delay=tick+5;pending=index;}
            else if(delay===tick+4){say('You start Harpooning fish.');animAt=tick;fishing=index;}
            else {if(delay===tick)roll();if(was>=0)kills++;}
            return {success:true};
        },
        sendUseItemOnLoc:async()=>{cookClicks++;const raw=items.find(i=>i.id===383);if(raw)raw.id=burn?387:385;return {success:true};}},
        tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{})} as unknown as Session;
    return {s,clicks,stop:()=>clearInterval(loop),tick:()=>tick,items:()=>items,cookClicks:()=>cookClicks,rolls:()=>rolls,kills:()=>kills,st,
        end:()=>{fishing=-1;}};
}
test('moving spot is reacquired with op3 and only raw383 counts',async()=>{
    const f=fixture({moving:true});try{expect(await catchSharks(f.s,2,()=>false,60)).toEqual({caught:2});expect(f.clicks).toEqual([3,3]);}finally{f.stop();}
});
test('a confirmed harpoon action is not re-clicked while it rolls without a catch',async()=>{
    // cWx27l: 22 live misses; the old48-tick re-click dropped the action twice. Rolls0-21 miss
    // (132 ticks, past every old watchdog), then every roll hits. One op3 must carry all three catches.
    const f=fixture({hit:r=>r>=22});
    try{expect(await catchSharks(f.s,3,()=>false)).toEqual({caught:3});expect(f.clicks).toEqual([3]);expect(f.kills()).toBe(0);}finally{f.stop();}
});
test('active fishing without a catch fails unresolved progress at the pinned-odds bound without re-clicking',async()=>{
    expect(SHARK_PROGRESS_TICKS).toBe(420);expect((215/256)**Math.floor((SHARK_PROGRESS_TICKS-12)/6)).toBeLessThan(1e-5);
    const f=fixture({hit:()=>false});
    try{
        await expect(catchSharks(f.s,1,()=>false)).rejects.toThrow('shark fishing no progress');
        expect(f.rolls()).toBeGreaterThanOrEqual(65);
        expect(f.clicks).toEqual([3]);expect(f.kills()).toBe(0);
    }finally{f.stop();}
},30000);
test('a server action that ends without a catch is re-dispatched after the animation stops',async()=>{
    let ended=false;const f=fixture({hit:()=>ended});
    try{await captureFishing(async rows=>{
        const run=catchSharks(f.s,1,()=>false);
        const {waitTicks}=await import('../packages/core/src/ticks');await waitTicks(f.s,30);
        f.end();ended=true;const at=f.tick();
        expect(await run).toEqual({caught:1});
        expect(f.clicks).toEqual([3,3]);expect(f.kills()).toBe(0);
        const end=rows.find(r=>r.event==='action-ended');
        expect(end.detail.still).toBe(SHARK_IDLE_TICKS);
        // Within one roll cycle plus the idle window, not the old48-tick timer.
        expect(end.tick-at).toBeLessThanOrEqual(6+SHARK_IDLE_TICKS);
        expect(rows.some(r=>r.event==='watchdog')).toBe(false);
    });}finally{f.stop();}
});
test('three-tick animation gaps between live rolls never end the action',async()=>{
    // The fixture shows -1 for3 of every6 ticks, cWx27l's longest live gap.
    const f=fixture({hit:r=>r>=10});
    try{await captureFishing(async rows=>{
        expect(await catchSharks(f.s,1,()=>false)).toEqual({caught:1});
        expect(rows.some(r=>r.event==='action-ended')).toBe(false);expect(f.clicks).toEqual([3]);
    });}finally{f.stop();}
});
test('a dispatch the server never starts fails as refused, not as slow fishing',async()=>{
    const f=fixture({refuse:true});
    try{await expect(catchSharks(f.s,1,()=>false)).rejects.toThrow('shark fishing dispatch refused');expect(f.clicks).toEqual([3,3,3]);expect(f.rolls()).toBe(0);}finally{f.stop();}
});
test('a spot that vanishes mid-action is reacquired from fresh identity',async()=>{
    // No hit until the move, so the first action cannot hide the reacquire.
    let moved=false;const f=fixture({hit:()=>moved});
    try{
        const run=catchSharks(f.s,1,()=>false);
        const {waitTicks}=await import('../packages/core/src/ticks');await waitTicks(f.s,20);
        f.st.nearbyNpcs=[{...spot,index:9,x:2847,z:3430}];moved=true;
        // %action_delay is a player var, so the first op3 on the new spot can land mid-cycle and be retried once.
        expect(await run).toEqual({caught:1});expect(f.clicks.length).toBeGreaterThanOrEqual(2);
        expect(f.clicks.length).toBeLessThanOrEqual(3);expect(f.clicks.every(op=>op===3)).toBe(true);
    }finally{f.stop();}
});
test('wrong NPC cannot make progress, missing tool/full pack refuse, budget propagates',async()=>{
    for(const [settings,error] of [[{wrong:true},'no progress'],[{tool:false},'harpoon'],[{full:true},'full pack']] as const){
        const f=fixture(settings);try{await expect(catchSharks(f.s,1,()=>false,3)).rejects.toThrow(error);expect(f.clicks).toHaveLength(0);}finally{f.stop();}
    }
    const f=fixture();try{await expect(catchSharks(f.s,1,()=>true)).rejects.toThrow('stop');}finally{f.stop();}
});

async function captureFishing(run:(rows:any[])=>Promise<void>) {
    const rows:any[]=[],original=console.log;
    const log=spyOn(console,'log').mockImplementation((...args:any[])=>{
        if(typeof args[0]==='string'&&args[0].startsWith('SHARK_FISH_TRACE '))rows.push(JSON.parse(args[0].slice('SHARK_FISH_TRACE '.length)));
        else original(...args);
    });
    try{await run(rows);}finally{log.mockRestore();}
}
test('two catches then unresolved progress retains raw stock, original cause and the progress boundary',async()=>{
    // The server action keeps rolling; only rolls0-1 hit until the restart.
    let lucky=false;const f=fixture({hit:r=>r<2||lucky});
    try{await captureFishing(async rows=>{
        await expect(catchSharks(f.s,3,()=>false)).rejects.toThrow('shark fishing no progress');
        const failure=rows.at(-1);
        expect(failure.event).toBe('failure');expect(failure.rawSharks).toBe(2);
        expect(failure.detail).toMatchObject({caught:2,progressTicks:SHARK_PROGRESS_TICKS,cause:'Error: shark fishing no progress'});
        expect(failure.tick-failure.detail.progress).toBeGreaterThanOrEqual(SHARK_PROGRESS_TICKS);
        expect(failure.tick-failure.detail.progress).toBeLessThanOrEqual(SHARK_PROGRESS_TICKS+12);
        expect(rows.some(r=>r.event==='complete')).toBe(false);
        expect(rows.filter(r=>r.event==='dispatch').every(r=>r.detail.option===3&&r.selected.id===322)).toBe(true);
        expect(f.items().filter(i=>i.id===383)).toHaveLength(2);
        // Restart counts only new catches; the retained two cannot meet target3.
        lucky=true;
        expect(await catchSharks(f.s,3,()=>false)).toEqual({caught:3});
        expect(f.items().filter(i=>i.id===383)).toHaveLength(5);
    });}finally{f.stop();}
},30000);
test('active-looking animation without a catch stays unknown; dispatch replies and probable rejection are separate',async()=>{
    const f=fixture({animate:false});const st=f.s.sdk.getState()!;
    Object.assign(st,{tick:10,revision:20,gameMessages:[],opFeedback:{opRejectedCount:0,lastOpRejectedTick:-1,mapFlagUnsetCount:0,lastMapFlagUnsetTick:-1}});
    st.player!.animId=618;
    (f.s.sdk as any).getStateAge=()=>900;
    (f.s.sdk as any).getSkill=()=>({level:99,baseLevel:99,experience:998458});
    (f.s.sdk as any).sendInteractNpc=async()=>{
        st.opFeedback!.opRejectedCount++;
        return {success:false,message:'dispatch refused',reason:'rejected',phase:'dispatch'};
    };
    try{await captureFishing(async rows=>{
        await expect(catchSharks(f.s,1,()=>false,12)).rejects.toThrow('no progress');
        expect(rows.find(r=>r.event==='dispatch-reply').detail).toMatchObject({success:false,reason:'rejected',phase:'dispatch'});
        const end=rows.at(-1);
        expect(end).toMatchObject({stateTick:10,revision:20,stateAgeMs:900,rawSharks:0,actionSettlement:'unknown',player:{animId:618},fishing:{xp:998458}});
        // Each unstarted dispatch is retried after its window; the counter tracks every refusal.
        expect(end.opFeedback.opRejectedCount).toBe(rows.filter(r=>r.event==='dispatch').length);
        expect(rows.some(r=>r.event==='started')).toBe(false);
        expect(end.detail.caught).toBe(0);
    });}finally{f.stop();}
});
test('trace freezes the dispatched spot, observes movement/disappearance and never consumes chat',()=>{
    const f=fixture(),rows:any[]=[];const st=f.s.sdk.getState()!;
    Object.assign(st,{gameMessages:[{type:0,text:'old',tick:1}],revision:1,tick:1});
    let sharedChatReads=0;(f.s.sdk as any).getNewChat=()=>{sharedChatReads++;return [];};
    const trace=sharkFishingTrace(f.s,row=>rows.push(row));
    try{
        trace.select(st.nearbyNpcs[0]!);trace.record('dispatch');
        st.nearbyNpcs[0]!.x++;
        st.gameMessages.push({type:0,text:'You start Harpooning fish.',tick:2,observationId:2,fromSelf:false,sender:''},
            {type:3,text:'private text',tick:2,observationId:3,fromSelf:false,sender:'other'});
        trace.record('tick');trace.record('tick');
        expect(rows[1].selected.x).toBe(2845);expect(rows[1].currentSelected.x).toBe(2846);
        expect(rows[1].messages).toEqual([{tick:2,observationId:2,text:'You start Harpooning fish.'}]);
        expect(rows[2].messages).toEqual([]);expect(sharedChatReads).toBe(0);
        st.nearbyNpcs=[];trace.record('tick');
        expect(rows.at(-1)).toMatchObject({currentSelected:null,candidates:[],actionSettlement:'unknown'});
    }finally{f.stop();}
});
test('trace failure is reported once and cannot replace the original dispatch error',async()=>{
    const f=fixture();const problem=Error('original dispatch error');
    const warn=spyOn(console,'warn').mockImplementation(()=>{});
    const log=spyOn(console,'log').mockImplementation(()=>{throw Error('broken trace sink');});
    (f.s.sdk as any).sendInteractNpc=async()=>{throw problem;};
    try{
        await expect(catchSharks(f.s,1,()=>false)).rejects.toBe(problem);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('SHARK_FISH_TRACE_ERROR');
    }finally{log.mockRestore();warn.mockRestore();f.stop();}
});
test('cancellation and full pack stop without dispatch; post-failure ticks have no trace subscription',async()=>{
    for(const full of [false,true]){
        const f=fixture({full});
        try{await captureFishing(async rows=>{
            await expect(catchSharks(f.s,1,()=>!full)).rejects.toThrow(full?'full pack':'budget/health stop');
            expect(f.clicks).toHaveLength(0);expect(rows.at(-1).event).toBe('failure');
            const length=rows.length;
            const {waitTicks}=await import('../packages/core/src/ticks');await waitTicks(f.s,2);
            expect(rows).toHaveLength(length);
        });}finally{f.stop();}
    }
});
test('a vanished spot and exhausted harpoon retain observed stock and fail unresolved progress',async()=>{
    const f=fixture();let sends=0;
    (f.s.sdk as any).sendInteractNpc=async()=>{
        sends++;f.items().push({id:383,count:1,slot:1,name:'Raw shark'});
        f.items().splice(0,1);f.s.sdk.getState()!.nearbyNpcs=[];
        return {success:true,message:'dispatched'};
    };
    try{await captureFishing(async rows=>{
        await expect(catchSharks(f.s,3,()=>false,12)).rejects.toThrow('no progress');
        expect(sends).toBe(1);expect(rows.at(-1)).toMatchObject({rawSharks:1,harpoons:0,candidates:[],actionSettlement:'unknown'});
        expect(rows.at(-1).detail.caught).toBe(1);
    });}finally{f.stop();}
});
test('session cooking counts a real burnt outcome and does not own logout',async()=>{
    const f=fixture({burn:true});try{await catchSharks(f.s,1,()=>false);expect(await cookSharks(f.s,()=>false)).toEqual({raw:1,cooked:0,burnt:1});}finally{f.stop();}
});
test('unavailable bank remains failed and cannot claim production or cleanup',async()=>{
    const f=fixture();try{
        (f.s.sdk as any).getSkill=(name:string)=>({level:name==='Hitpoints'?75:99,baseLevel:75});
        (f.s.bot as any)={openBank:async()=>({success:false})};
        const r=await supplySharks(f.s,{target:25,maxTicks:20,consumer:'staging'});
        expect(r.ok).toBe(false);expect(r.caught).toBe(0);expect(r.failure).toContain('bank');expect(r.assets).toBe(false);
    }finally{f.stop();}
});
test('full bank rejects an unobserved deposit; missing owned food stops before travel',async()=>{
    for(const fullBank of [true,false]){
        const f=fixture();let generation=0;const bank:any[]=[];
        try{
            const st=f.s.sdk.getState()!;st.player!.worldX=2618;st.player!.worldZ=3332;st.inventory=f.items();
            (f.s.sdk as any).getSkill=(name:string)=>({level:name==='Hitpoints'?43:99,baseLevel:name==='Hitpoints'?75:99});
            (f.s.sdk as any).getEquipment=()=>[];
            (f.s as any).bankObservation=()=>({generation,at:Date.now(),items:bank.map(i=>({...i}))});
            (f.s as any).bot={openBank:async()=>{generation++;return {success:true};},depositItem:async(item:any)=>{
                if(fullBank)return {success:false};const n=f.items().filter(i=>i.id===item.id).reduce((v,i)=>v+i.count,0);
                for(let i=f.items().length-1;i>=0;i--)if(f.items()[i].id===item.id)f.items().splice(i,1);
                bank.push({id:item.id,name:item.name,count:n});generation++;return {success:true};
            }};
            const r=await supplySharks(f.s,{target:25,maxTicks:500,consumer:'staging'});
            expect(r.ok).toBe(false);expect(r.caught).toBe(0);expect(r.banked).toBe(0);
            expect(r.failure).toContain(fullBank?'pack debit/bank credit unobserved':'missing owned travel food');
            expect(f.items().reduce((n,i)=>n+i.count,0)+bank.reduce((n,i)=>n+i.count,0)).toBe(1);
        }finally{f.stop();}
    }
});
// Pinned sessionWalker plan, recorded west-bank leg 2645,3385 -> 2680,3405. It ends at 2679,3405.
const ardougneLeg:PathTile[]=[[2645,3389],[2647,3391],[2658,3391],[2660,3393],[2660,3394],[2661,3394],[2662,3395],[2667,3395],[2668,3396],[2669,3396],
    [2671,3398],[2671,3399],[2674,3399],[2674,3401],[2676,3403],[2677,3403],[2679,3405]].map(([x,z])=>({x:x!,z:z!}));
test('route accepts an empty plan at the target and a plan that ends beside the target',()=>{
    expect(sharkRoutePlan(0,{x:2809,z:3441},{x:2809,z:3441,tol:2},[])).toEqual([]);
    expect(sharkRoutePlan(0,{x:2645,z:3385},{x:2680,z:3405,tol:2},ardougneLeg)).toBe(ardougneLeg);
});
test('route refuses a short plan, an empty plan away from the target, a corridor exit and another level',()=>{
    expect(()=>sharkRoutePlan(0,{x:2645,z:3385},{x:2680,z:3405,tol:2},ardougneLeg.slice(0,-1))).toThrow('unsafe/incomplete shark route');
    expect(()=>sharkRoutePlan(0,{x:2618,z:3332},{x:2618,z:3355,tol:2},[])).toThrow('unsafe/incomplete shark route');
    expect(()=>sharkRoutePlan(0,{x:2850,z:3440},{x:2860,z:3440,tol:2},[{x:2870,z:3440},{x:2860,z:3440}])).toThrow('unsafe/incomplete shark route');
    expect(()=>sharkRoutePlan(1,{x:2809,z:3441},{x:2809,z:3441,tol:2},[])).toThrow('unsafe/incomplete shark route');
});
function fakeWalker(at:PathTile,plan:PathDeps['plan']) {
    let tick=0;const pos={...at,level:0},listeners=new Set<()=>void>(),loop=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const deps:PathDeps={tick:()=>tick,pos:()=>({...pos}),onTick:f=>{listeners.add(f);return()=>listeners.delete(f);},
        walk:(x,z)=>{pos.x=x;pos.z=z;},interactLoc:()=>{},locs:()=>[],plan};
    return {deps,pos,stop:()=>clearInterval(loop)};
}
test('guarded walkPath finishes on an empty plan at the bank and on the pinned leg that ends beside its point',async()=>{
    const bank=fakeWalker({x:2809,z:3441},()=>[]);
    try{expect((await walkPath(guardSharkRoute(bank.deps,()=>false),[{x:2809,z:3441,tol:2}])).ok).toBe(true);}finally{bank.stop();}
    const leg=fakeWalker({x:2645,z:3385},()=>ardougneLeg);
    try{expect((await walkPath(guardSharkRoute(leg.deps,()=>false),[{x:2680,z:3405,tol:2}],{maxTicks:60})).ok).toBe(true);expect(Math.max(Math.abs(leg.pos.x-2680),Math.abs(leg.pos.z-3405))).toBeLessThanOrEqual(2);}finally{leg.stop();}
});
// West-bank entry with an owned harpoon and food. The first route leg throws. Recovery banks the carried kit or lists it.
async function routeThrow(recoveryPlan:PathTile[]) {
    const f=fixture({tool:false});let generation=0;
    const bank:any[]=[{id:311,name:'Harpoon',count:1},{id:329,name:'Salmon',count:10},{id:995,name:'Coins',count:5000}];
    try{
        const st=f.s.sdk.getState()!;st.player!.worldX=2618;st.player!.worldZ=3332;st.inventory=f.items();
        (f.s.sdk as any).getSkill=(name:string)=>({level:name==='Hitpoints'?75:99,baseLevel:name==='Hitpoints'?75:99});
        (f.s.sdk as any).getEquipment=()=>[];
        (f.s as any).bankObservation=()=>({generation,at:Date.now(),items:bank.map(i=>({...i}))});
        (f.s as any).bot={openBank:async()=>{generation++;return {success:true};},closeInterface:async()=>{},
            withdrawItem:async(name:RegExp,n:number)=>{const b=bank.find(i=>name.test(i.name))!;b.count-=n;f.items().push({id:b.id,count:n,slot:f.items().length,name:b.name});generation++;return {success:true};},
            depositItem:async(item:any)=>{const n=f.items().filter(i=>i.id===item.id).reduce((v,i)=>v+i.count,0);
                for(let i=f.items().length-1;i>=0;i--)if(f.items()[i].id===item.id)f.items().splice(i,1);
                bank.push({id:item.id,name:item.name,count:n});generation++;return {success:true};}};
        const plans:PathTile[]=[];
        const r=await supplySharks(f.s,{target:25,maxTicks:500,consumer:'staging',walker:async()=>fakeWalker({x:2618,z:3332},(_l,_from,to)=>{
            plans.push(to);return plans.length===1?[{x:2618,z:3345}]:recoveryPlan;}).deps});
        return {r,plans,pack:f.items().map(i=>i.id)};
    }finally{f.stop();}
}
test('a route throw keeps its error, banks the carried kit at the west bank and reconciles assets',async()=>{
    const {r,plans,pack}=await routeThrow([]);
    expect(r.ok).toBe(false);expect(r.failure).toContain('unsafe/incomplete shark route');
    expect(plans.at(-1)).toMatchObject({x:2619,z:3332,tol:8});
    expect(r).toMatchObject({recovery:'banked',atBank:true,assets:true,unbanked:{},caught:0,banked:0});expect(pack).toEqual([]);
});
test('a failed recovery stays failed, never claims the bank and lists the unbanked kit',async()=>{
    const {r,pack}=await routeThrow([{x:2590,z:3332}]);
    expect(r.ok).toBe(false);expect(r.failure).toContain('unsafe/incomplete shark route');expect(r.recovery).toContain('unsafe/incomplete shark route');
    expect(r.atBank).toBe(false);expect(r.unbanked).toEqual({311:1,329:2});expect(pack.sort()).toEqual([311,329]);
});

test('the order owns a two-catch stall: raw stock banks, cooked credit stays zero, cause is retained',async()=>{
    // A started action whose rolls miss after two catches (the resume boundary).
    const f=fixture({tool:false,hit:r=>r<2});let generation=0;
    const bank:any[]=[{id:311,name:'Harpoon',count:1},{id:329,name:'Salmon',count:10},
        {id:995,name:'Coins',count:5408},{id:385,name:'Shark',count:5}];
    const st=f.s.sdk.getState()!;
    st.player!.worldX=2809;st.player!.worldZ=3441;st.inventory=f.items();
    (f.s.sdk as any).getSkill=(name:string)=>({level:name==='Hitpoints'?75:99,baseLevel:name==='Hitpoints'?75:99});
    (f.s.sdk as any).getEquipment=()=>[];
    (f.s as any).bankObservation=()=>({generation,at:Date.now(),items:bank.map(i=>({...i}))});
    (f.s as any).bot={openBank:async()=>{generation++;return {success:true};},closeInterface:async()=>{},
        withdrawItem:async(name:RegExp,n:number)=>{
            const b=bank.find(i=>name.test(i.name))!;b.count-=n;
            f.items().push({id:b.id,count:n,slot:f.items().length,name:b.name});generation++;return {success:true};
        },
        depositItem:async(item:any)=>{
            const n=f.items().filter(i=>i.id===item.id).reduce((v,i)=>v+i.count,0);
            for(let i=f.items().length-1;i>=0;i--)if(f.items()[i].id===item.id)f.items().splice(i,1);
            bank.push({id:item.id,name:item.name,count:n});generation++;return {success:true};
        }};
    const walker=async():Promise<PathDeps>=>({tick:f.s.tick,onTick:f.s.onTick,
        pos:()=>({x:st.player!.worldX,z:st.player!.worldZ,level:0}),
        walk:(x,z)=>{st.player!.worldX=x;st.player!.worldZ=z;},interactLoc:()=>{},locs:()=>[],
        plan:(_level,_from,to)=>[{x:to.x,z:to.z}]});
    try{await captureFishing(async()=>{
        const r=await supplySharks(f.s,{target:3,maxTicks:1000,consumer:'staging',walker});
        expect(r).toMatchObject({ok:false,target:3,caught:2,cooked:0,burnt:0,banked:0,assets:true,
            recovery:'banked',atBank:true,unbanked:{},failure:'Error: shark fishing no progress'});
        expect(bank.filter(i=>i.id===383).reduce((n,i)=>n+i.count,0)).toBe(2);
        expect(bank.filter(i=>i.id===385).reduce((n,i)=>n+i.count,0)).toBe(5);
        expect(f.items()).toEqual([]);
        expect(sharkSummary(r)).toContain('newBankedSharks=0 caught=2 cooked=0');
    });}finally{f.stop();}
},30000);
