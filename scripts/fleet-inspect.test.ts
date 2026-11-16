import {expect,test} from 'bun:test';
import {inspectFleetState} from './fleet-inspect';
import type {Session} from '../packages/core/src/inprocess';

function fixture(mode:string){
 let tick=0,opened=['stale-open','same-generation','refreshed-open'].includes(mode),generation=7,at=mode==='same-generation'?2001:1000,stopped=mode==='stop-before',opens=0,closes=0;
 const callbacks=new Set<()=>void>(),lines:string[]=[];
 const items=mode==='empty'?[]:[{id:995,name:'Coins',count:100470},{id:1623,name:'Uncut sapphire',count:4}];
 const s={name:'Fixture',tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
  sdk:{getState:()=>({player:{x:3085,z:3250,level:0},skills:[],inventory:[],nearbyNpcs:mode==='far'?[]:[{name:'Banker',x:3089,z:3245}],nearbyLocs:[],bank:{isOpen:opened,items}})},
  bankObservation:()=>opened&&mode!=='missing'?{generation,at,items}:null,
  bot:{openBank:async()=>{opens++;if(mode==='open-fail')return{success:false};opened=true;
    if(['fresh','stop','stop-close','refreshed-open','empty'].includes(mode)){generation++;at=2001;}if(mode==='old-time'){generation++;}if(mode==='stop')stopped=true;return{success:true};},
   closeBank:async()=>{closes++;opened=false;if(mode==='stop-close')stopped=true;return{success:true};}},
 } as unknown as Session;
 return{s,lines,stopped:()=>stopped,counts:()=>({opens,closes}),advance:()=>{tick++;if(mode==='delayed'&&tick===9){generation++;at=2001;}for(const cb of [...callbacks])cb();},listeners:()=>callbacks.size};
}

async function run(mode:string,requireBank=true){
 const f=fixture(mode),work=inspectFleetState(f.s,{requireBank,afterLoginAt:2000,stopped:f.stopped,log:line=>f.lines.push(line)})
  .then(value=>({value}),error=>({error:String(error)}));
 for(let i=0;i<40;i++){await Promise.resolve();f.advance();}
 return{f,result:await work};
}

for(const mode of ['fresh','delayed','refreshed-open'])test(`strict bank observation accepts a fresh generation: ${mode}`,async()=>{
 const{f,result}=await run(mode);
 expect(result).toEqual({value:{generation:8,at:2001,items:[{id:995,name:'Coins',count:100470},{id:1623,name:'Uncut sapphire',count:4}]}});
 expect(f.lines).toContain('BANK_OBSERVED {"generation":8,"at":2001,"items":2}');
 expect(f.counts().closes).toBe(mode==='refreshed-open'?2:1);expect(f.listeners()).toBe(0);
});

for(const mode of ['far','open-fail','missing','stale','stale-open','same-generation','old-time','stop','stop-before','stop-close'])test(`strict bank observation rejects an unproved inspection: ${mode}`,async()=>{
 const{f,result}=await run(mode);expect(result).toEqual({error:expect.stringContaining('bank observation')});
 expect(f.lines.some(line=>line.startsWith('BANK_OBSERVED '))).toBe(false);expect(f.listeners()).toBe(0);
 if(mode==='far')expect(f.counts().opens).toBe(0);
});

test('a freshly observed empty bank is a valid zero-item observation',async()=>{
 const{f,result}=await run('empty');expect(result).toEqual({value:{generation:8,at:2001,items:[]}});
 expect(f.lines).toContain('BANK []');expect(f.lines).toContain('BANK_OBSERVED {"generation":8,"at":2001,"items":0}');
});

test('ordinary inspection retains success when no bank is nearby',async()=>{
 const{f,result}=await run('far',false);expect(result).toEqual({value:null});expect(f.counts()).toEqual({opens:0,closes:0});expect(f.lines[0]).toStartWith('INSPECT ');
});
