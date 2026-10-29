import {test,expect} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wrapTransparent,installSharkFishingObserver,analyzeSharkDiagnostic,op3Phase,statChance,DIAGNOSTIC_OUT,type SharkEngine} from '../src/shark-fishing-diagnostic';

// Minimal fake of the engine parts the observer wraps. RNG and stack effects are counted.
function fakeEngine(){
    const world={currentTick:100},rng={calls:0,next:[0.01,0.9]};
    class Player{username:string;vars=[0,0,0];stats=new Int32Array(21);levels=new Uint8Array(21).fill(99);target:any=null;targetOp=-1;nextTarget:any=null;x=2854;z=3424;level=0;delayed=false;writes:any[]=[];
        constructor(n:string){this.username=n;}
        processInteraction(){return 'pi';}
        executeScript(state:any){return state.run?.(this);}
        stopAction(){this.target=null;this.write(new UnsetMapFlag());}
        write(m:any){this.writes.push(m);}}
    class UnsetMapFlag{}
    class OpNpcHandler{handle(m:any,p:any){if(p.delayed){p.write(new UnsetMapFlag());return false;}p.target=spot;p.targetOp=m.op;return true;}}
    const spot={nid:5,type:322,x:2854,z:3423,level:0};
    const state=(p:any,ints:number[])=>({_activePlayer:p,_activeNpc:spot,script:{name:'[opnpc3,_memberfish]'},intStack:[...ints],isp:ints.length,
        popInt(){return this.intStack[--this.isp];},pushInt(v:number){this.intStack[this.isp++]=v;}});
    const handlers:Record<number,(s:any)=>void>={
        1:(s:any)=>{const op=s.popInt();if(op===9)throw Error('bad op');s._activePlayer.stopAction();s._activePlayer.target=spot;s._activePlayer.targetOp=op;},
        2:(s:any)=>{const high=s.popInt(),low=s.popInt(),stat=s.popInt();const chance=Math.floor(rng.next[rng.calls++ % 2]!*256);const value=statChance(low,high,s._activePlayer.levels[stat])*256;
            s.pushInt(value>chance?1:0);}};
    const engine:SharkEngine={world,handlers,opcodes:{pOpnpc:1,statRandom:2},player:Player.prototype,opNpc:OpNpcHandler.prototype,npc:()=>spot,actionDelayVarp:()=>2,fishingStat:10};
    return {engine,world,rng,Player,OpNpcHandler,state,spot,handlers};
}

test('wrapper calls the original once with the same receiver, arguments, result and exception',()=>{
    const calls:any[]=[],problem=Error('engine error'),owner={f(this:any,...a:any[]){calls.push([this,a]);if(a[0]==='throw')throw problem;return {r:a};}};
    const fails:unknown[]=[];
    const restore=wrapTransparent(owner,'f',{before(){throw Error('hook before');},after(){throw Error('hook after');}},e=>fails.push(e));
    const out=owner.f(1,2);expect(calls).toEqual([[owner,[1,2]]]);expect(out).toEqual({r:[1,2]});
    let thrown:unknown;try{owner.f('throw');}catch(e){thrown=e;}
    expect(thrown).toBe(problem);expect(calls.length).toBe(2);expect(fails.length).toBe(4);
    restore();expect(owner.f.name).toBe('f');
    expect(()=>wrapTransparent({},'missing',{},()=>{})).toThrow(/missing/);
});

test('observer is transparent: same RNG calls, stack values, player state and messages as unobserved',()=>{
    const run=(observe:boolean)=>{
        const f=fakeEngine(),rows:any[]=[];const obs=observe?installSharkFishingObserver(f.engine,'FlShark',r=>rows.push(r)):undefined;
        const p=new f.Player('flshark');p.vars[2]=105;
        const h=new f.OpNpcHandler();const accepted=h.handle({op:3,npcSlot:5},p);
        const s1=f.state(p,[7,3]);f.handlers[1]!(s1);
        const s2=f.state(p,[7,10,48,90]);f.handlers[2]!(s2);
        const s3=f.state(p,[10,48,90]);f.handlers[2]!(s3);
        p.processInteraction();p.executeScript({script:{name:'[opnpc5,_memberfish]'},run:(pl:any)=>{pl.stats[10]+=1100;pl.target=f.spot;return 'ran';}});
        return {rows,accepted,stacks:[s1.intStack.slice(0,s1.isp),s2.intStack.slice(0,s2.isp),s3.intStack.slice(0,s3.isp)],rng:f.rng.calls,xp:p.stats[10],writes:p.writes.length,target:p.target,errors:obs?.errors()};
    };
    const plain=run(false),seen=run(true);
    expect({...seen,rows:[],errors:undefined} as object).toEqual({...plain,rows:[]});
    expect(seen.errors).toBe(0);expect(seen.rng).toBe(2);expect(seen.stacks).toEqual([[7],[7,1],[0]]);
    const kinds=seen.rows.map(r=>r.kind);
    expect(kinds).toEqual(['installed','opnpc-in','unset-map-flag','stop-action','p_opnpc','stat-random','stat-random','interaction','script']);
    const roll=seen.rows.find(r=>r.kind==='stat-random');
    expect(roll).toMatchObject({args:[10,48,90],result:1,level:99,script:'[opnpc3,_memberfish]'});
    expect(roll.after.fishingXp).toBe(roll.before.fishingXp);
    const action=seen.rows.find(r=>r.kind==='script');
    expect(action.after.fishingXp).toBe(action.before.fishingXp+1100);
    expect(seen.rows.find(r=>r.kind==='p_opnpc')).toMatchObject({op:3,threw:false,before:{actionDelay:105,clock:100}});
    expect(seen.rows.find(r=>r.kind==='unset-map-flag').origin).toEqual(['p_opnpc','stop-action']);
    expect(seen.rows.find(r=>r.kind==='opnpc-in')).toMatchObject({op:3,npcSlot:5,accepted:true,before:{target:null},after:{target:{nid:5}}});
    expect(seen.rows.find(r=>r.kind==='script')).toMatchObject({script:'[opnpc5,_memberfish]',after:{target:{nid:5}}});
});

test('filters to the named fixture, ignores other skills and leaves exceptions and uninstall unchanged',()=>{
    const f=fakeEngine(),rows:any[]=[];const obs=installSharkFishingObserver(f.engine,'flshark',r=>rows.push(r));
    const other=new f.Player('someone');other.processInteraction();new f.OpNpcHandler().handle({op:3,npcSlot:5},other);other.stopAction();
    const p=new f.Player('flshark');
    f.handlers[2]!(f.state(p,[7,1,2]));// a non-fishing roll: not recorded
    p.delayed=true;expect(new f.OpNpcHandler().handle({op:3,npcSlot:5},p)).toBe(false);
    const bad=f.state(p,[9]);expect(()=>f.handlers[1]!(bad)).toThrow('bad op');
    p.stopAction();
    expect(rows.map(r=>r.kind)).toEqual(['installed','unset-map-flag','opnpc-in','p_opnpc','unset-map-flag','stop-action']);
    expect(rows[1].origin).toEqual(['opnpc-in']);expect(rows[2].accepted).toBe(false);
    expect(rows[3]).toMatchObject({threw:true,error:'Error: bad op'});
    // The context stack was popped after the exception: the later map flag is attributed to stop-action only.
    expect(rows[4].origin).toEqual(['stop-action']);
    expect(f.rng.calls).toBe(1);
    obs.uninstall();const before=rows.length;p.processInteraction();f.handlers[2]!(f.state(p,[10,48,90]));
    expect(rows.length).toBe(before);
    // A broken sink is counted, never thrown into the engine.
    const g=fakeEngine();const broken=installSharkFishingObserver(g.engine,'flshark',()=>{throw Error('disk');});
    expect(new g.Player('flshark').processInteraction()).toBe('pi');expect(broken.errors()).toBeGreaterThan(0);
});

test('default off: importing without the env does not touch an engine; with it the preload binds the engine',async()=>{
    const path=join(import.meta.dir,'../src/shark-fishing-diagnostic.ts'),cwd=mkdtempSync(join(tmpdir(),'sfd-'));
    const env={...process.env};delete env[DIAGNOSTIC_OUT];delete env.SHARK_FISHING_DIAGNOSTIC_PLAYER;
    const code=`await import(${JSON.stringify(path)});console.log('loaded');`;
    const off=Bun.spawnSync(['bun','-e',code],{cwd,env,stdout:'pipe',stderr:'pipe',windowsHide:true});
    expect(off.exitCode).toBe(0);expect(off.stdout.toString()).toContain('loaded');
    const on=Bun.spawnSync(['bun','-e',code],{cwd,env:{...env,[DIAGNOSTIC_OUT]:join(cwd,'t.jsonl'),SHARK_FISHING_DIAGNOSTIC_PLAYER:'flshark'},stdout:'pipe',stderr:'pipe',windowsHide:true});
    expect(on.exitCode).not.toBe(0);// no engine in this directory: the enabled preload tries to bind one
});

test('pinned op3 phases and STAT_RANDOM chance',()=>{
    expect([-1,0,1,2,3,4,5].map(op3Phase)).toEqual(['restart','roll-no-requeue','dropped','dropped','dropped','start','dropped']);
    expect(statChance(1,1,99)).toBe(2/256);
});

function row(kind:string,clock:number,extra:any={},target:any={nid:5,type:322,x:2854,z:3423},after:any=target,delay=0){
    return {kind,at:1000+clock*150,threw:false,...extra,before:{clock,actionDelay:delay,target,fishingXp:0},after:{clock,actionDelay:delay,target:after,fishingXp:extra.result===1?1100:0}};}

// Minimal projection of ZvRLnU/server-trace.jsonl clock340 and worker.log ticks323/324.
// STAT_RANDOM has no XP effect. fish_roll then adds raw_shark and advances 1100 *25 XP.
function retainedCatch(){
    const spot={nid:2177,type:322,x:2838,z:3431},xp=9984580,at=1793243867270;
    const snap=(clock:number,fishingXp=xp,target:any=spot)=>({clock,fishingXp,target,actionDelay:340,targetOp:7});
    const events:any[]=[{kind:'installed',player:'flsharxecz01',at:0},
        {kind:'interaction',at:at-137,threw:false,before:snap(339),after:snap(339)},
        {kind:'stat-random',at,result:1,args:[10,3,40],level:99,script:'[proc,fish_roll]',threw:false,before:snap(340,xp,null),after:snap(340,xp,null)},
        {kind:'script',at:at+1,script:'[opnpc5,_memberfish]',threw:false,before:snap(340,xp,null),after:snap(340,xp+27500)},
        {kind:'interaction',at:at+1,threw:false,before:snap(340),after:snap(340,xp+27500)},
        {kind:'interaction',at:at+164,threw:false,before:snap(341,xp+27500),after:snap(341,xp+27500)},
        {kind:'interaction',at:at+305,threw:false,before:snap(342,xp+27500),after:snap(342,xp+27500)},
        {kind:'opnpc-in',at:at-200,op:3,npc:spot,accepted:true,before:snap(338),after:snap(338)}];
    const client=(tick:number,at:number,rawSharks:number,xp:number)=>({event:'tick',at,tick,stateTick:tick,revision:tick+120,account:'flsharxecz01',player:{name:'Flsharxecz01'},rawSharks,fishing:{xp},currentSelected:{index:2177,id:322,x:2838,z:3431}});
    const trace:any[]=[{event:'begin',account:'flsharxecz01'},client(323,at+28,0,xp/10),client(324,at+187,1,(xp+27500)/10),{event:'failure',account:'flsharxecz01'}];
    return {events,trace};
}
const logTrace=(trace:any[])=>trace.map(r=>'SHARK_FISH_TRACE '+JSON.stringify(r)).join('\n');

// wXS08P projections retain each failed clock's actual engine/client timestamps,
// XP, raw count, execution parents and publication counters. No save or game replay.
function delayedCatch(clock:352|370){
    const f=retainedCatch(),a='flsharxo6d01',xp=clock===352?10067080:10094580;
    const times=clock===352?[1793245654649,1793245654949,1793245654978,1793245654993,1793245655105,1793245654970,1793245655003]
        :[1793245657356,1793245657674,1793245657689,1793245657703,1793245657802,1793245657678,1793245657714];
    const spot={nid:2175,type:322,x:2844,z:3429},raw=clock===352?3:4,tick=clock-17,revision=clock===352?458:476;
    f.events[0]={kind:'installed',player:a,executionIds:true};
    for(const e of f.events)for(const s of [e.before,e.after])if(s){s.clock+=clock-340;s.fishingXp+=xp-9984580;s.player=a;s.actionDelay=clock;if(s.target)s.target=spot;}
    const id=clock===352?649:724;
    f.events[1].at=clock===352?1793245654506:1793245657202;
    f.events[1].id=id-4;f.events[1].parent=null;
    for(const [i,ei] of [2,3,4,5,6].entries()){
        const e=f.events[ei];e.at=times[i===0?0:i===1||i===2?1:i-1];e.id=[id+2,id+1,id,id+5,id+9][i];e.parent=i===0?id+1:i===1?id:null;
    }
    if(clock===370)f.events[3].at=1793245657673;
    f.events.push({...structuredClone(f.events[6]),id:id+13,at:times[4],before:{...f.events[6].before,clock:clock+3},after:{...f.events[6].after,clock:clock+3}});
    for(const [i,t] of f.trace.entries()){
        t.account=a;if(t.event!=='tick')continue;
        t.at=times[i===1?5:6];t.tick=t.stateTick=tick+i-1;t.revision=revision+i-1;
        t.rawSharks=raw+i-1;t.fishing.xp=(xp+(i-1)*27500)/10;t.player.name='Flsharxo6d01';
        t.currentSelected={index:spot.nid,id:spot.type,x:spot.x,z:spot.z};
    }
    return f;
}

test('wXS08P clocks352 and370 bind delayed next publication after catch-up engine cycles',()=>{
    for(const clock of [352,370] as const){
        const {events,trace}=delayedCatch(clock);
        expect(trace[2].at).toBeGreaterThan(events[6].at);
        const a=analyzeSharkDiagnostic(events,logTrace(trace));
        expect(a.complete).toBe(true);expect(a.effects.rows[0]).toMatchObject({clock,clientTick:clock-16,ok:true});
    }
});

test('delayed binding fails absent, substituted, ambiguous, reordered and later unrelated effects',()=>{
    const cases:((e:any[],t:any[])=>void)[]=[
        (_e,t)=>{t.splice(2,1);},
        (_e,t)=>{t[2].rawSharks--;},
        (_e,t)=>{t[2].rawSharks=t[1].rawSharks-1;},
        (_e,t)=>{t[2].fishing.xp++;},
        (_e,t)=>{t[1].fishing.xp++;},
        (_e,t)=>{t[2].account='other';},
        (_e,t)=>{t[1].player.name='Other';},
        (_e,t)=>{t[2].currentSelected.index++;},
        (_e,t)=>{t[1].currentSelected.id++;},
        (_e,t)=>{t.splice(2,0,structuredClone(t[2]));},
        (_e,t)=>{[t[1],t[2]]=[t[2],t[1]];},
        (_e,t)=>{t[2].stateTick--;},
        (_e,t)=>{t[2].revision=t[1].revision;},
        (_e,t)=>{t[2].at=t[1].at;},// equal time is allowed, but this effect then precedes engine clock+1
        // A contradictory intermediate publication cannot be skipped to find valid XP later.
        (_e,t)=>{const c=structuredClone(t[1]);c.tick--;c.stateTick--;c.revision--;c.at--;c.rawSharks--;t.splice(1,0,c);},
        // A later engine mutation closes the epoch, even if its client output looks like this catch.
        e=>{e[6].after.fishingXp+=27500;},
        e=>{e[6].before.clock++;},
        e=>{e[6].before.player='other';},
        e=>{e[6].threw=true;},
        e=>{[e[5],e[6]]=[e[6],e[5]];},
        e=>{const c=structuredClone(e[2]);c.id+=100;c.before.clock++;c.after.clock++;e.splice(3,0,c);},
    ];
    for(const clock of [352,370] as const)for(const change of cases){
        const {events,trace}=delayedCatch(clock);change(events,trace);
        expect(analyzeSharkDiagnostic(events,logTrace(trace)).complete).toBe(false);
    }
});

test('each catch must keep the same engine/client publication offset, not a later similar transition',()=>{
    const a=delayedCatch(352),b=delayedCatch(370);
    const events=[...a.events,...b.events.slice(1)],trace=[...a.trace,...b.trace];
    expect(analyzeSharkDiagnostic(events,logTrace(trace)).complete).toBe(true);
    for(const t of b.trace)if(t.event==='tick'){t.tick++;t.stateTick++;}
    const bad=analyzeSharkDiagnostic(events,logTrace([...a.trace,...b.trace]));
    expect(bad.complete).toBe(false);
    expect(bad.effects.rows.every(r=>r.errors.includes('inconsistent engine/client publication order'))).toBe(true);
});

test('real effect order: unchanged roll XP, enclosing shark action XP, then next client raw shark',()=>{
    const {events,trace}=retainedCatch();
    const a=analyzeSharkDiagnostic(events,logTrace(trace));
    expect(a.observed.catchesWithXp).toBe(true);
    expect(a.complete).toBe(true);
});

test('effect correlation rejects missing, substituted, ambiguous and incomplete observations',()=>{
    const cases:((e:any[],t:any[])=>void)[]=[
        e=>{e[3].after.fishingXp=e[3].before.fishingXp;},
        (_e,t)=>{t[2].rawSharks=0;},
        (_e,t)=>{t[2].fishing.xp+=1;},
        e=>{e[2].args=[10,4,48];}, // swordfish cannot stand in for sharks
        e=>{e[3].script='[opnpc4,_memberfish]';},
        (_e,t)=>{t[2].account='someone';},
        (_e,t)=>{t[2].currentSelected.index=2178;},
        e=>{e.splice(3,0,structuredClone(e[2]));}, // one effect cannot satisfy two rolls
        e=>{e.splice(4,0,structuredClone(e[3]));},
        e=>{e.splice(3,1);},
        e=>{e.splice(5,1);},
        (_e,t)=>{t.splice(1,1);},
        (_e,t)=>{t[2].tick+=2;t[2].stateTick+=2;},
        (_e,t)=>{t[2].at+=1000;}, // a later output is not the action's client effect
        e=>{e[2].threw=true;},
        e=>{e[2].result=0;}, // failed rolls cannot produce the successful action effects
        e=>{delete e[3].after;},
        e=>{e[3].before.player='someone';},
        (_e,t)=>{t[2].player.name='someone';},
        (_e,t)=>{t[2].revision=t[1].revision;},
        (_e,t)=>{t[2].rawSharks=2;},
        e=>{delete e[2].before;},
        e=>{delete e[3].before;},
        e=>{delete e[4].after;},
        e=>{delete e[2].threw;},
    ];
    for(const change of cases){const {events,trace}=retainedCatch();change(events,trace);expect(analyzeSharkDiagnostic(events,logTrace(trace)).complete).toBe(false);}
});

test('unsuccessful shark roll requires no XP output and needs no catch credit',()=>{
    const {events,trace}=retainedCatch();events[2].result=0;
    for(const e of events)for(const s of [e.before,e.after])if(s)s.fishingXp=9984580;
    trace[2].fishing.xp=998458;trace[2].rawSharks=0;
    const a=analyzeSharkDiagnostic(events,logTrace(trace));
    expect(a.complete).toBe(true);expect(a.rolls.successes).toBe(0);
    expect(a.effects.rows[0]).toMatchObject({ok:true,expectedXp:0,clientTick:null});
});
test('analysis separates unsuccessful rolls, dropped op3 replacement, refusals and a moved spot',()=>{
    const spot={nid:5,type:322,x:2854,z:3423},moved={nid:5,type:322,x:2855,z:3423},shop={nid:9,type:576,x:2831,z:3444};
    const events:any[]=[{kind:'installed',at:0},
        row('script',10,{script:'[opnpc3,_memberfish]'},null,spot,9),// restart, requeued
        ...[11,12,13,14,15,16,17,18,19,20].map(c=>row('interaction',c,{},spot,spot)),
        row('stat-random',15,{result:0,args:[10,48,90],level:99}),
        row('stat-random',21,{result:1,args:[10,48,90],level:99}),
        row('opnpc-in',23,{op:3,accepted:true,npc:spot},spot,spot,25),
        row('script',23,{script:'[opnpc3,_memberfish]'},null,null,25),// phase2: dropped, not requeued
        row('interaction',24,{},null,null),row('interaction',25,{},null,null),
        row('opnpc-in',26,{op:3,accepted:false,npc:spot},null,null,25),
        row('interaction',27,{},spot,spot),row('interaction',28,{},moved,moved),
        {kind:'unset-map-flag',at:1,clock:23,origin:['interaction','script','p_opnpc','stop-action']}];
    const log=['SHARK_FISH_TRACE '+JSON.stringify({event:'begin',at:0}),'SHARK_FISH_TRACE '+JSON.stringify({event:'dispatch',tick:1,at:1000+23*150+40}),
        'SHARK_FISH_TRACE '+JSON.stringify({event:'dispatch',tick:2,at:999999}),'SHARK_FISH_TRACE '+JSON.stringify({event:'failure',at:5})].join('\n');
    const a=analyzeSharkDiagnostic(events,log);
    // SRGJUn clock217: a shop Trade (opnpc3) before fishing stays in the raw trace but out of fishing summaries.
    const shopped=[events[0],row('opnpc-in',5,{op:3,accepted:false,npc:shop},null,null,9),row('script',5,{script:'[opnpc3,_shop_keeper]'},null,shop,9),
        row('interaction',6,{},null,null),...events.slice(1)];
    const s=analyzeSharkDiagnostic(shopped,log);
    for(const k of ['rolls','op3','segments','opIn','dispatches'] as const)expect(s[k]).toEqual(a[k]);
    expect(s.observed.scripts).toBe(a.observed.scripts+1);expect(s.observed.fishScripts).toBe(a.observed.fishScripts);
    // This metrics-only fixture lacks enclosing catch effects and cannot prove completeness.
    expect(a.complete).toBe(false);
    expect(a.effects.ok).toBe(false);
    expect(a.rolls).toMatchObject({count:2,successes:1,catchClocks:[21]});
    expect(a.op3.outcomes).toEqual({restart:1,dropped:1});expect(a.op3.mismatchedRequeue).toBe(0);
    expect(a.segments).toHaveLength(2);
    expect(a.segments[0]).toMatchObject({from:10,to:21,rolls:2,catches:1,maxRollGap:6,idleTicks:0});
    expect(a.segments[1]).toMatchObject({final:true,from:21,to:28,rolls:0,idleTicks:2,opInWhileActive:1,refusedOpIn:1,op3:{dropped:1},spotChanges:1,missingSpot:2});
    expect(a.unsetMapFlag).toEqual({'interaction>script>p_opnpc>stop-action':1});
    expect(a.dispatches).toMatchObject({count:2,unmatched:1});
    expect(a.dispatches.rows[0]).toMatchObject({clock:23,accepted:true,phase:2,activeBefore:true});
    // Missing observations fail completeness.
    expect(analyzeSharkDiagnostic(events.slice(1),log).complete).toBe(false);
    expect(analyzeSharkDiagnostic(events,'').complete).toBe(false);
    expect(analyzeSharkDiagnostic([...events,{kind:'observer-error',at:1}],log).complete).toBe(false);
});

test('observer ids name each enclosing call: roll -> shark script -> interaction, unrelated scripts outside',()=>{
    const f=fakeEngine(),rows:any[]=[];
    // Fake nesting: the original interaction runs the shark script, whose body runs STAT_RANDOM.
    (f.Player.prototype as any).processInteraction=function(this:any){
        this.executeScript({script:{name:'[opnpc5,_memberfish]'},run:(pl:any)=>f.handlers[2]!(f.state(pl,[10,3,40]))});return 'pi';};
    installSharkFishingObserver(f.engine,'flshark',r=>rows.push(r));
    const p=new f.Player('flshark');
    p.executeScript({script:{name:'[timer,health_regen]'}});
    expect(p.processInteraction()).toBe('pi');
    const roll=rows.find(r=>r.kind==='stat-random'),shark=rows.find(r=>r.script==='[opnpc5,_memberfish]');
    const timer=rows.find(r=>r.script==='[timer,health_regen]'),tick=rows.find(r=>r.kind==='interaction');
    expect(rows[0].executionIds).toBe(true);
    expect([timer.parent,tick.parent,shark.parent,roll.parent]).toEqual([null,null,tick.id,shark.id]);
    expect(new Set(rows.filter(r=>r.id!==undefined).map(r=>r.id)).size).toBe(4);
    expect(tick.id<shark.id&&shark.id<roll.id).toBe(true);
});

// Projection of SRGJUn/server-trace.jsonl clock1017 (rows 4034-4043): timers and changestat share the clock;
// the unsuccessful roll is enclosed by [opnpc5,_memberfish], which its interaction encloses.
function retainedShared(ids:boolean){
    const spot={nid:2175,type:322,x:2838,z:3431,level:0},xp=10507080,at=1793244537393,a='flsharxl6x01';
    const snap=(clock:number,target:any=spot,fishingXp=xp)=>({player:a,clock,fishingXp,target,actionDelay:1017,targetOp:7});
    const r=(kind:string,id:number,parent:number|null,t:number,extra:any,before:any,after:any=before)=>({kind,...(ids?{id,parent}:{}),at:t,threw:false,...extra,before,after:structuredClone(after)});
    const events:any[]=[{kind:'installed',player:a,...(ids?{executionIds:true}:{}),at:0},
        r('opnpc-in',1,null,at-9000,{op:3,accepted:true,npc:spot},snap(977)),
        r('interaction',2,null,at-150,{},snap(1016)),
        r('script',3,null,at,{script:'[timer,stat_regen]'},snap(1017)),
        r('script',4,null,at,{script:'[timer,stat_boost_restore]'},snap(1017)),
        r('script',5,null,at,{script:'[timer,health_regen]'},snap(1017)),
        r('script',6,null,at+1,{script:'[changestat,_]'},snap(1017)),
        r('stat-random',9,8,at+1,{args:[10,3,40],level:99,script:'[proc,fish_roll]',result:0},snap(1017,null)),
        {kind:'unset-map-flag',at:at+1,clock:1017,...(ids?{parent:11}:{}),origin:['interaction','script','p_opnpc','stop-action']},
        r('stop-action',11,10,at+2,{context:['interaction','script','p_opnpc','stop-action']},snap(1017,null)),
        r('p_opnpc',10,8,at+2,{op:5,script:'[label,fish_shark]',npc:spot},snap(1017,null),snap(1017)),
        r('script',8,7,at+2,{script:'[opnpc5,_memberfish]'},snap(1017,null),snap(1017)),
        r('interaction',7,null,at+2,{},snap(1017)),
        r('interaction',12,null,at+150,{},snap(1018))];
    const trace:any[]=[{event:'begin',account:a},{event:'complete',account:a}];
    return {events,trace};
}
const idx=(e:any[],kind:string,script?:string)=>e.findIndex(x=>x.kind===kind&&(script===undefined||x.script===script));

test('SRGJUn clock1017: an unsuccessful shark roll sharing its clock with health_regen and changestat is attributed',()=>{
    for(const ids of [true,false]){
        const {events,trace}=retainedShared(ids);const a=analyzeSharkDiagnostic(events,logTrace(trace));
        expect(a.effects.rows).toEqual([{clock:1017,result:0,script:'[opnpc5,_memberfish]',xpBefore:10507080,xpAfter:10507080,expectedXp:0,clientTick:null,ok:true,errors:[]}]);
        expect(a.complete).toBe(true);
        // An unrelated script with changed XP in the same clock neither invalidates nor supplies the effect.
        const changed=retainedShared(ids);changed.events[idx(changed.events,'script','[changestat,_]')].after.fishingXp+=27500;
        expect(analyzeSharkDiagnostic(changed.events,logTrace(changed.trace)).complete).toBe(true);
        const supplied=retainedShared(ids);supplied.events[idx(supplied.events,'stat-random')].result=1;
        supplied.events[idx(supplied.events,'script','[changestat,_]')].after.fishingXp+=27500;
        expect(analyzeSharkDiagnostic(supplied.events,logTrace(supplied.trace)).complete).toBe(false);
    }
});

test('shark attribution rejects ambiguous, reordered, missing, mismatched and duplicate enclosing rows',()=>{
    const shark=(e:any[])=>idx(e,'script','[opnpc5,_memberfish]'),roll=(e:any[])=>idx(e,'stat-random'),tick=(e:any[])=>e.findIndex(x=>x.kind==='interaction'&&x.before.clock===1017);
    const both:((e:any[])=>void)[]=[
        e=>{e.splice(shark(e)+1,0,structuredClone(e[shark(e)]));},// two plausible shark executions
        e=>{const [s]=e.splice(shark(e),1);e.splice(roll(e),0,s);},// enclosing script reordered before its roll
        e=>{e.splice(shark(e),1);},
        e=>{e.splice(tick(e),1);},
        e=>{const [t]=e.splice(tick(e),1);e.splice(shark(e),0,t);},
        e=>{e[shark(e)].before.player='someone';},
        e=>{e[shark(e)].script='[opnpc5,_shop_keeper]';},
        e=>{e[shark(e)].script='[opnpc4,_memberfish]';},
        e=>{e[shark(e)].threw=true;},
        e=>{e[shark(e)].after.fishingXp+=27500;},// a failed roll with XP is contradictory
        e=>{e[tick(e)].after.fishingXp+=27500;},
        e=>{e.splice(roll(e)+1,0,structuredClone(e[roll(e)]));},// one execution cannot attribute two rolls
        e=>{e[roll(e)].args=[10,4,48];},
    ];
    const byId:((e:any[])=>void)[]=[
        e=>{e[roll(e)].parent=6;},// a same-clock changestat cannot enclose the roll
        e=>{delete e[roll(e)].parent;},
        e=>{e[shark(e)].parent=3;},
        e=>{e[shark(e)].parent=null;},
        e=>{e[tick(e)].parent=3;},
        e=>{e[idx(e,'script','[changestat,_]')].id=8;},// duplicate id: ambiguous
        e=>{const c=structuredClone(e[roll(e)]);c.id=99;c.before.clock=c.after.clock=1018;e.splice(roll(e)+1,0,c);},// duplicate effect attribution
        e=>{e[shark(e)].id=20;e[roll(e)].parent=20;e[idx(e,'p_opnpc')].parent=20;},// enclosing call cannot start after its roll
    ];
    const runs:[boolean,((e:any[])=>void)[]][]=[[true,[...both,...byId]],[false,both]];
    for(const [ids,cases] of runs)for(const change of cases){
        const {events,trace}=retainedShared(ids);change(events);
        expect(analyzeSharkDiagnostic(events,logTrace(trace)).complete).toBe(false);
    }
});

test('successful shark roll keeps downstream XP and raw-shark checks when timers share its clock',()=>{
    const timer=(name:string,s:any,dxp=0)=>({kind:'script',at:0,script:name,threw:false,before:{...s},after:{...s,fishingXp:s.fishingXp+dxp}});
    const {events,trace}=retainedCatch(),snap=events[2].before;
    // Timers and changestat run before the interaction phase; even a changed-XP timer stays outside the chain.
    events.splice(2,0,timer('[timer,health_regen]',snap,27500),timer('[changestat,_]',snap));
    expect(analyzeSharkDiagnostic(events,logTrace(trace)).complete).toBe(true);
    // Legacy post-order: an unrelated execution between the roll and its enclosing script is ambiguous.
    const between=retainedCatch();between.events.splice(3,0,timer('[changestat,_]',snap));
    expect(analyzeSharkDiagnostic(between.events,logTrace(between.trace)).complete).toBe(false);
});

// GU1maC/fishing-diagnostic (flsharx6et01) projections. Exact retained rows: the previous interaction, roll,
// enclosing shark script and interaction, the next two interactions, client rows p/c, the later distinct client
// publications that share one Date.now() millisecond, and the next catch's XP mutation that ends the epoch.
// Filler rows between those anchors keep one interaction per clock and one client publication per tick.
const GU1MAC={
    334:{spot:{nid:2177,type:322,x:2846,z:3429},xp:9984580,raw:0,ids:[570,576,575,574,579,583],
        at:[1793246515253,1793246515388,1793246515389,1793246515389,1793246515551,1793246515687],
        client:[[317,438,1793246515414],[318,439,1793246515571]],pair:[404,526,1793246528773],end:[429,1793246529651]},
    771:{spot:{nid:2177,type:322,x:2853,z:3423},xp:10259580,raw:10,ids:[2382,2388,2387,2386,2391,2395],
        at:[1793246580801,1793246580941,1793246580942,1793246580943,1793246581101,1793246581244],
        client:[[754,876,1793246580966],[755,877,1793246581126]],pair:[823,945,1793246591475],end:[861,1793246594435]},
    1357:{spot:{nid:2178,type:322,x:2853,z:3423},xp:10589580,raw:22,ids:[4817,4823,4822,4821,4826,4830],
        at:[1793246668695,1793246668851,1793246669140,1793246669140,1793246669171,1793246669185],
        client:[[1340,1464,1793246669162],[1341,1465,1793246669185]],pair:[1368,1492,1793246673258],end:[1387,1793246673354]},
} as const;
function gu1macCatch(clock:keyof typeof GU1MAC){
    const g=GU1MAC[clock],a='flsharx6et01',gain=27500,[endClock,endAt]=g.end,[pairTick,pairRev,pairAt]=g.pair;
    const snap=(c:number,fishingXp:number,target:any)=>({player:a,clock:c,fishingXp,target,actionDelay:clock,targetOp:7});
    const r=(kind:string,id:number,parent:number|null,at:number,c:number,xp:number,xpAfter=xp,extra:any={},target:any=g.spot,after:any=g.spot)=>
        ({kind,id,parent,at,threw:false,...extra,before:snap(c,xp,target),after:snap(c,xpAfter,after)});
    const [prev,roll,script,tick,next,next2]=g.ids,lerp=(from:number,to:number,f:number)=>Math.floor(from+(to-from)*f);
    const events:any[]=[{kind:'installed',player:a,executionIds:true,at:g.at[0]-50000},
        r('opnpc-in',prev-200,null,g.at[0]-40000,clock-200,g.xp,g.xp,{op:3,accepted:true,npc:g.spot},null),
        r('interaction',prev,null,g.at[0],clock-1,g.xp),
        r('stat-random',roll,script,g.at[1],clock,g.xp,g.xp,{result:1,args:[10,3,40],level:99,script:'[proc,fish_roll]'},null,null),
        r('script',script,tick,g.at[2],clock,g.xp,g.xp+gain,{script:'[opnpc5,_memberfish]'},null),
        r('interaction',tick,null,g.at[3],clock,g.xp,g.xp+gain),
        r('interaction',next,null,g.at[4],clock+1,g.xp+gain),
        r('interaction',next2,null,g.at[5],clock+2,g.xp+gain)];
    for(let c=clock+3;c<endClock;c++)events.push(r('interaction',next2+(c-clock)*4,null,lerp(g.at[5],endAt,(c-clock-2)/(endClock-clock-2)),c,g.xp+gain));
    events.push(r('interaction',next2+(endClock-clock)*4,null,endAt,endClock,g.xp+gain,g.xp+2*gain));// next catch: epoch ends
    const client=(tick:number,revision:number,at:number,raw:number,xp:number)=>({event:'tick',at,tick,stateTick:tick,revision,account:a,
        player:{name:'Flsharx6et01'},rawSharks:raw,fishing:{xp:Math.floor(xp/10)},currentSelected:{index:g.spot.nid,id:322,x:g.spot.x,z:g.spot.z}});
    const [[pt,pr,pa],[ct,cr,ca]]=g.client,trace:any[]=[{event:'begin',account:a},client(pt,pr,pa,g.raw,g.xp),client(ct,cr,ca,g.raw+1,g.xp+gain)];
    for(let t=ct+1;t<pairTick;t++)trace.push(client(t,pairRev-(pairTick-t),lerp(ca,pairAt,(t-ct)/(pairTick-ct)),g.raw+1,g.xp+gain));
    trace.push(client(pairTick,pairRev,pairAt,g.raw+1,g.xp+gain),client(pairTick+1,pairRev+1,pairAt,g.raw+1,g.xp+gain));
    for(let t=pairTick+2;t<endClock-16;t++)trace.push(client(t,pairRev+t-pairTick,lerp(pairAt,endAt-1,(t-pairTick-1)/(endClock-16-pairTick)),g.raw+1,g.xp+gain));
    trace.push({event:'complete',account:a});
    return {events,trace,at:(tick:number)=>trace.findIndex(t=>t.tick===tick),ev:(id:number)=>events.findIndex(e=>e.id===id)};
}
const CLOCKS=[334,771,1357] as const;

test('GU1maC clocks334, 771 and1357 bind their client effect when later distinct publications share one millisecond',()=>{
    for(const clock of CLOCKS){
        const {events,trace,at}=gu1macCatch(clock),[pairTick,pairRev,pairAt]=GU1MAC[clock].pair;
        expect([trace[at(pairTick)].at,trace[at(pairTick+1)].at]).toEqual([pairAt,pairAt]);
        expect(trace[at(pairTick+1)].revision).toBe(pairRev+1);
        const a=analyzeSharkDiagnostic(events,logTrace(trace));
        expect(a.effects.rows).toEqual([{clock,result:1,script:'[opnpc5,_memberfish]',xpBefore:GU1MAC[clock].xp,xpAfter:GU1MAC[clock].xp+27500,
            expectedXp:27500,clientTick:clock-16,ok:true,errors:[]}]);
        expect(a.complete).toBe(true);
        // Equal time at the effect boundary itself: tick, stateTick and revision still order p before c.
        const edge=gu1macCatch(clock);edge.trace[1].at=edge.trace[2].at;
        expect(analyzeSharkDiagnostic(edge.events,logTrace(edge.trace)).complete).toBe(true);
    }
});

test('GU1maC equal-millisecond publications still reject duplicate, reversed, missing, substituted, contradictory and reused effects',()=>{
    type G=ReturnType<typeof gu1macCatch>;type C=keyof typeof GU1MAC;
    const pair=(g:G,clock:C)=>g.at(GU1MAC[clock].pair[0]);
    const cases:[string,(g:G,clock:C)=>void][]=[
        ['duplicate tick',(g,c)=>{const t=g.trace[pair(g,c)+1];t.tick--;t.stateTick--;}],
        ['duplicate revision',(g,c)=>{g.trace[pair(g,c)+1].revision--;}],
        ['duplicate publication row',(g,c)=>{g.trace.splice(pair(g,c)+1,0,structuredClone(g.trace[pair(g,c)]));}],
        ['reversed rows',(g,c)=>{const i=pair(g,c);[g.trace[i],g.trace[i+1]]=[g.trace[i+1],g.trace[i]];}],
        ['regressed revision',(g,c)=>{g.trace[pair(g,c)+1].revision=g.trace[pair(g,c)].revision-1;}],
        ['time went back',(g,c)=>{g.trace[pair(g,c)+1].at--;}],
        ['missing publication',(g,c)=>{g.trace.splice(pair(g,c)+1,1);}],
        ['stateTick differs',(g,c)=>{g.trace[pair(g,c)].stateTick++;}],
        ['wrong account',(g,c)=>{g.trace[pair(g,c)].account='other';}],
        ['wrong player',(g,c)=>{g.trace[pair(g,c)+1].player.name='Other';}],
        ['wrong target',g=>{g.trace[2].currentSelected.index++;}],
        ['absent effect',g=>{for(const t of g.trace.slice(2))if(t.event==='tick')t.rawSharks--;}],
        ['contradictory XP',g=>{g.trace[2].fishing.xp++;}],
        ['contradictory fish',g=>{g.trace[2].rawSharks++;}],
        ['effect reversed at the boundary',g=>{g.trace[2].at=g.trace[1].at-1;}],
        ['later unrelated catch inside the epoch',(g,c)=>{for(const t of g.trace.slice(pair(g,c)+1))if(t.event==='tick')t.rawSharks++;}],
        ['duplicate attribution',(g,c)=>{const i=g.ev(GU1MAC[c].ids[1]),d=structuredClone(g.events[i]);d.id+=100000;g.events.splice(i+1,0,d);}],
        ['wrong engine account',(g,c)=>{g.events[g.ev(GU1MAC[c].ids[2])].after.player='other';}],
        ['contradictory engine XP',(g,c)=>{g.events[g.ev(GU1MAC[c].ids[3])].after.fishingXp++;}],
    ];
    for(const clock of CLOCKS)for(const [name,change] of cases){
        const g=gu1macCatch(clock);change(g,clock);
        expect([clock,name,analyzeSharkDiagnostic(g.events,logTrace(g.trace)).complete]).toEqual([clock,name,false]);
    }
});
