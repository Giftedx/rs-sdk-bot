import {expect,test} from 'bun:test';
import {BUCKET,COW,gatherItems,MILK} from '../src/gather';
import type {Session} from '../src/inprocess';

function milkSession(mode:'both'|'milk only'|'bucket only'){
 let milk=1,buckets=2,tick=0,actions=0,pendingDebit=false;
 const cow={id:COW,distance:1};
 const inventory=()=>[{id:MILK,count:milk},...Array.from({length:buckets},(_,slot)=>({id:BUCKET,count:1,slot}))];
 const session={
  sdk:{getState:()=>({inventory:inventory(),player:{worldX:3253,worldZ:3269,level:0},nearbyNpcs:[cow]})},
  tick:()=>tick,
  onTick:(fn:()=>void)=>{
   const timer=setInterval(()=>{tick++;if(pendingDebit){buckets--;pendingDebit=false;}fn();},1);
   return()=>clearInterval(timer);
  },
  bot:{useItemOnNpc:async()=>{
   actions++;
   if(mode!=='bucket only')milk++;
   if(mode==='bucket only')buckets--;
   if(mode==='both')pendingDebit=true;
  }},
 } as unknown as Session;
 return {session,counts:()=>({milk,buckets,actions})};
}

test('milk gathering accepts two conversions after the corresponding bucket debits arrive',async()=>{
 const f=milkSession('both');
 expect(await gatherItems(f.session,{} as Parameters<typeof gatherItems>[1],[{id:MILK,count:2,how:'milk'}],async()=>({ok:true}))).toBeNull();
 expect(f.counts()).toEqual({milk:3,buckets:0,actions:2});
});

test('a one-sided milk conversion stops before a second interaction',async()=>{
 for(const mode of ['milk only','bucket only'] as const){
  const f=milkSession(mode);
  const result=await gatherItems(f.session,{} as Parameters<typeof gatherItems>[1],[{id:MILK,count:2,how:'milk'}],async()=>({ok:true}));
  expect(result).toContain('milk conversion unconfirmed');
  expect(f.counts().actions).toBe(1);
 }
});
