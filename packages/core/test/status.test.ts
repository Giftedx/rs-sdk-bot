import { expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStatus, noteStatusLine, resultCounters } from '../src/status';

test('a bank visit between writes keeps an identified snapshot after close', async () => {
    const name = `StatusTest${process.pid}`;
    const file = resolve(import.meta.dir, '../../../.practice/status', `${name}.json`);
    const state: any = { bank: { isOpen: false, items: [] }, inventory: [], skills: [] };
    const s: any = { name, bankObservation:()=>state.bank.isOpen&&state.bank.items.length?{generation:1,at:Date.now(),items:state.bank.items}:null, sdk: { getState: () => state }, tick: () => 1, onTick: () => () => {}, bot: { closeBank: async () => { state.bank = { isOpen:true,items:[] }; } } };
    const status = startStatus(s, 'localhost:8888');
    try {
        state.bank = { isOpen: true, items: [{ id:1779,name:'Flax',count:81 }] };
        await s.bot.closeBank();
        status.stop();
        const doc=JSON.parse(readFileSync(file,'utf8'));
        expect(doc.bank).toEqual([{id:1779,baseId:1779,name:'Flax',count:81}]);
        expect(doc.bankAt).toBeGreaterThan(0);
    } finally { status.stop(); rmSync(file,{force:true}); rmSync(file+'.tmp',{force:true}); }
});

test('status keeps bank unknown until ready, accepts a real empty update and retains it through close', async () => {
    const name=`StatusReady${process.pid}`;
    const file=resolve(import.meta.dir,'../../../.practice/status',`${name}.json`);
    const state:any={bank:{isOpen:true,items:[]},inventory:[],skills:[]};
    let observed:any=null;
    const callbacks:(()=>void)[]=[];
    const session:any={name,sdk:{getState:()=>state},tick:()=>1,bankObservation:()=>observed,
        onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};},bot:{closeBank:async()=>{observed=null;}}};
    const status=startStatus(session,'localhost:8888');
    const read=()=>JSON.parse(readFileSync(file,'utf8'));
    const flush=()=>{for(let i=0;i<5;i++)callbacks.forEach(cb=>cb());};
    try {
        expect(read().bank).toBeNull();expect(read().bankAt).toBeNull();
        observed={generation:1,at:1000,items:[{id:1779,name:'Flax',count:81}]};flush();
        expect(read().bank[0].count).toBe(81);expect(read().bankAt).toBe(1000);
        observed=null;flush();expect(read().bank[0].count).toBe(81);
        observed={generation:2,at:2000,items:[]};flush();
        expect(read().bank).toEqual([]);expect(read().bankAt).toBe(2000);
        await session.bot.closeBank();flush();status.stop();
        expect(read().bank).toEqual([]);expect(read().bankAt).toBe(2000);
    } finally {status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});

test('restart keeps only prior observed bank data and timestamp; a ready empty update replaces it', () => {
    const name=`StatusPrior${process.pid}`;
    const folder=resolve(import.meta.dir,'../../../.practice/status');mkdirSync(folder,{recursive:true});
    const file=resolve(folder,`${name}.json`),at=Date.now()-60_000;
    const bank=[{id:1780,baseId:1779,name:'Flax',count:81}];
    writeFileSync(file,JSON.stringify({name:name.toLowerCase(),server:'localhost:8888',at:at+1,bank,bankAt:at,
        phase:'prior-phase-only',result:'fail prior-result-only',ledger:{xp:999},started:1}));
    let observed:any=null;const callbacks:(()=>void)[]=[];
    const session:any={name,sdk:{getState:()=>({inventory:[],skills:[]})},tick:()=>1,bankObservation:()=>observed,
        onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
    const status=startStatus(session,'localhost:8888',()=>({idle:0}));
    const read=()=>JSON.parse(readFileSync(file,'utf8'));
    try {
        expect(read().bank).toEqual(bank);expect(read().bankAt).toBe(at);
        expect(read().result).not.toBe('fail prior-result-only');expect(read().phase).not.toBe('prior-phase-only');
        expect(read().ledger).toEqual({idle:0});expect(read().started).toBeGreaterThan(at);
        const currentAt=Date.now();observed={generation:1,at:currentAt,items:[]};
        for(let i=0;i<5;i++)callbacks.forEach(cb=>cb());
        expect(read().bank).toEqual([]);expect(read().bankAt).toBe(currentAt);
    } finally {status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});

test.each(['json','name','server','future-bank','future-status','bad-id','bad-count','bad-name'])('prior bank rejects corrupt or foreign evidence: %s', kind => {
    const name=`BadPrior${process.pid}${kind.replace(/-/g,'')}`;
    const folder=resolve(import.meta.dir,'../../../.practice/status');mkdirSync(folder,{recursive:true});
    const file=resolve(folder,`${name}.json`),at=Date.now()-60_000;
    const prior:any={name,server:'localhost:8888',at:at+1,bankAt:at,bank:[{id:1779,baseId:1779,name:'Flax',count:81}]};
    if(kind==='name')prior.name='Foreign';if(kind==='server')prior.server='rs-sdk-demo.fly.dev';
    if(kind==='future-bank')prior.bankAt=Date.now()+60_000;if(kind==='future-status')prior.at=Date.now()+60_000;
    if(kind==='bad-id')prior.bank[0].id=-1;if(kind==='bad-count')prior.bank[0].count=-1;
    if(kind==='bad-name')prior.bank[0].name='';
    writeFileSync(file,kind==='json'?'{':JSON.stringify(prior));
    const session:any={name,sdk:{getState:()=>({})},tick:()=>1,onTick:()=>()=>{}};
    const status=startStatus(session,'localhost:8888');
    try {const result=JSON.parse(readFileSync(file,'utf8'));expect(result.bank).toBeNull();expect(result.bankAt).toBeNull();}
    finally {status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});

test('equipment retains worn slots and conserves inventory-to-worn assets without leaking item metadata',()=>{
    const name=`StatusEquip${process.pid}`,file=resolve(import.meta.dir,'../../../.practice/status',`${name}.json`);
    const gear=[{id:1277,name:'Bronze sword',count:1,slot:0},{id:1171,name:'Wooden shield',count:1,slot:1}];
    const state:any={inventory:gear.map(i=>({...i})),equipment:[],skills:[],password:'STATUS_TEST_PRIVATE'};
    const callbacks:(()=>void)[]=[];
    const session:any={name,sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
    const status=startStatus(session,'localhost:8888');
    const read=()=>JSON.parse(readFileSync(file,'utf8'));
    const flush=()=>{for(let i=0;i<5;i++)callbacks.forEach(cb=>cb());};
    const totals=(doc:any)=>[1277,1171].map(id=>[id,[...doc.inventory,...doc.equipment].filter((i:any)=>i.id===id).reduce((n:number,i:any)=>n+i.count,0)]);
    try{
        const before=read();expect(before.equipment).toEqual([]);
        state.inventory=[];state.equipment=gear.map((i,n)=>({...i,slot:n===0?3:5,password:'STATUS_TEST_PRIVATE',optionsWithIndex:[{text:'Remove',opIndex:1}]}));flush();
        const after=read();
        expect(after.equipment).toEqual([{slot:3,id:1277,baseId:1277,name:'Bronze sword',count:1},{slot:5,id:1171,baseId:1171,name:'Wooden shield',count:1}]);
        expect(totals(after)).toEqual(totals(before));expect(after.inventory).toEqual([]);
        expect(JSON.stringify(after)).not.toContain('STATUS_TEST_PRIVATE');expect(JSON.stringify(after)).not.toContain('optionsWithIndex');expect(JSON.stringify(after)).not.toContain('password');
    }finally{status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});
test('missing or malformed equipment is unknown, while an explicit empty SDK array remains empty',()=>{
    const name=`StatusEquipUnknown${process.pid}`,file=resolve(import.meta.dir,'../../../.practice/status',`${name}.json`);
    const state:any={inventory:[],skills:[]},callbacks:(()=>void)[]=[];
    const session:any={name,sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
    const status=startStatus(session,'localhost:8888');
    const read=()=>JSON.parse(readFileSync(file,'utf8'));
    const flush=()=>{for(let i=0;i<5;i++)callbacks.forEach(cb=>cb());};
    try{
        expect(read().equipment).toBeNull();
        for(const raw of [null,{},[{id:1277,name:'Bronze sword',count:1}], [{slot:3,id:1277,name:'Bronze sword',count:0}]]){state.equipment=raw;flush();expect(read().equipment).toBeNull();}
        state.equipment=[];flush();expect(read().equipment).toEqual([]);
        delete state.equipment;flush();expect(read().equipment).toBeNull();
    }finally{status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});

test('long cow RESULT retains late efficiency counters and isolates two hosted actors from global logs',()=>{
    const a=`StatusLongA${process.pid}`,b=`StatusLongB${process.pid}`,folder=resolve(import.meta.dir,'../../../.practice/status');
    const long='RESULT ok mode=cow ok=true creditedKills=9 banked={"hide":9,"bones":9,"beef":9} trainSkill=Defence targetLevel=null startLevel=76 finalLevel=76 selectedXp=7200 attackXp=0 damageXp=7200 eaten=0 bankTrips=3 hpMin=70 died=false lifeId=1 respawns=0 ticks=417 preserved=true targetMet=true partial=false stop=max-kills failure=- diagnostics=[] bankProfile=north foodMode=banked healthCutoff=false walkTicks=173 walkedTiles=334 detourTiles=211 doorInteractions=2 houseInteractions=0 maxPackSlots=27 bankDistances=[45] walkLegs=[{"detail":"walkTicks=999 houseInteractions=999 maxPackSlots=999"}]';
    expect(long.indexOf('walkTicks=173')).toBeGreaterThan(300);
    noteStatusLine(a,long);noteStatusLine(b,'MILESTONE waiting for own work');
    const session=(name:string):any=>({name,sdk:{getState:()=>({inventory:[],equipment:[],skills:[]})},tick:()=>1,onTick:()=>()=>{}});
    const sa=startStatus(session(a),'localhost:8888'),sb=startStatus(session(b),'localhost:8888');
    const read=(name:string)=>JSON.parse(readFileSync(resolve(folder,`${name}.json`),'utf8'));
    try{
        console.log('RESULT ok globalOnly=888 walkTicks=999');sa.stop();sb.stop();
        const first=read(a),second=read(b);
        expect(first.result).toBe(long.slice(7,300));expect(first.result.length).toBeLessThanOrEqual(300);
        expect(first.counters.walkTicks).toBe(173);expect(first.counters.houseInteractions).toBe(0);expect(first.counters.maxPackSlots).toBe(27);
        expect(first.counters.globalOnly).toBeUndefined();expect(second.result).toBe('');expect(second.counters).toEqual({});
        noteStatusLine(b,'RESULT ok ticks=10 walkTicks=17 maxPackSlots=3');sb.stop();sa.stop();
        expect(read(b).counters).toEqual({ticks:10,walkTicks:17,maxPackSlots:3});expect(read(a).counters.walkTicks).toBe(173);
    }finally{sa.stop();sb.stop();for(const name of [a,b]){rmSync(resolve(folder,`${name}.json`),{force:true});rmSync(resolve(folder,`${name}.json.tmp`),{force:true});}}
});

test('short standalone result stays unchanged with finite scalar counter shape',()=>{
    const name=`StatusShort${process.pid}`,file=resolve(import.meta.dir,'../../../.practice/status',`${name}.json`);
    const session:any={name,sdk:{getState:()=>({})},tick:()=>1,onTick:()=>()=>{}};
    const status=startStatus(session,'localhost:8888');
    try{console.log('RESULT ok ticks=4 eaten=0');status.stop();const doc=JSON.parse(readFileSync(file,'utf8'));expect(doc.result).toBe('ok ticks=4 eaten=0');expect(doc.counters).toEqual({ticks:4,eaten:0});}
    finally{status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});

test('counter parser ignores nested/quoted diagnostics, malformed/nonfinite numbers and duplicate overwrites',()=>{
    expect(resultCounters('ok walkTicks=173 nested={"text":"walkTicks=999 maxPackSlots=99"} list=[{"text":"houseInteractions=7"}] memo="maxPackSlots=88" houseInteractions=0 maxPackSlots=27 walkTicks=999 bad=NaN huge=1e999 malformed=1.2.3 neg=-1.5 small=1e2'))
        .toEqual({walkTicks:173,houseInteractions:0,maxPackSlots:27,neg:-1.5,small:100});
});

test('counter parsing is capped at16KiB of UTF8 and drops a truncated numeric token',()=>{
    expect(resultCounters('ok first=1 '+'é '.repeat(6000)+'beyond=2')).toEqual({first:1});
    const prefix='ok ticks=1 ',tail='tail=';
    const text=prefix+' '.repeat(16*1024-prefix.length-tail.length-2)+tail+'123456 trailing=2';
    expect(resultCounters(text)).toEqual({ticks:1});
});
