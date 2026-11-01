import {test,expect} from 'bun:test';
import {bonesEffect,runBonesConversion,runBonesBank,type BonesIO} from './microbot-bones';

test('conversion requires every bone, product, rune debit and XP receipt',()=>{
 const before={bones:4,bananas:3,earth:4,water:4,nature:2,xp:100};
 const after={bones:0,bananas:7,earth:2,water:2,nature:1,xp:125};
 expect(bonesEffect(before,after)).toBe(true);
 for(const key of Object.keys(after) as (keyof typeof after)[])
  expect(bonesEffect(before,{...after,[key]:before[key]})).toBe(false);
 expect(bonesEffect({...before,bones:0},{...after,bananas:3})).toBe(false);
});

function fixture(mode='normal'){
 let tick=0,casts=0,banked=0,closed=0;
 let pack={bones:0,bananas:0,earth:4,water:4,nature:2,xp:100};
 const io:BonesIO={tick:()=>tick,stopped:()=>false,level:()=>15,read:()=>({...pack}),
  prepare:async maximum=>{pack.bones=Math.min(3,maximum);return true;},
  cast:async()=>{casts++;tick++;if(mode==='normal')pack={...pack,bones:0,bananas:pack.bananas+pack.bones,earth:pack.earth-2,water:pack.water-2,nature:pack.nature-1,xp:pack.xp+25};},
  wait:async()=>{tick++;},deposit:async()=>{banked+=pack.bananas;const n=pack.bananas;pack.bananas=0;return n;},close:async()=>{closed++;}};
 return {io,counts:()=>({casts,banked,closed})};
}
test('bounded consumer banks exactly the requested output and stops',async()=>{
 const f=fixture();const r=await runBonesConversion(f.io,{maximum:5,cap:40});
 expect(r).toMatchObject({ok:true,made:5,banked:5,casts:2});
 expect(f.counts()).toEqual({casts:2,banked:5,closed:1});
});
test('a command reply without a conversion fails without a second spend',async()=>{
 const f=fixture('none');const r=await runBonesConversion(f.io,{maximum:5,cap:40});
 expect(r.ok).toBe(false);expect(f.counts().casts).toBe(1);expect(f.counts().closed).toBe(1);
});
test('invalid options and missing level refuse all casts',async()=>{
 const f=fixture();await expect(runBonesConversion(f.io,{maximum:0,cap:40})).rejects.toThrow();
 f.io.level=()=>14;expect((await runBonesConversion(f.io,{maximum:5,cap:40})).ok).toBe(false);
 expect(f.counts().casts).toBe(0);
});
test('input exhaustion, cancellation and bank mismatch cannot report success',async()=>{
 const missing=fixture();missing.io.prepare=async()=>false;
 expect((await runBonesConversion(missing.io,{maximum:5,cap:40})).ok).toBe(false);
 expect(missing.counts().casts).toBe(0);
 const stopped=fixture();stopped.io.stopped=()=>true;
 expect((await runBonesConversion(stopped.io,{maximum:5,cap:40})).ok).toBe(false);
 expect(stopped.counts().casts).toBe(0);
 const bank=fixture();bank.io.deposit=async()=>0;
 expect((await runBonesConversion(bank.io,{maximum:5,cap:40})).ok).toBe(false);
 expect(bank.counts().casts).toBe(1);
 const cap=fixture();cap.io.prepare=async()=>{cap.io.tick=()=>100;return true;};
 expect((await runBonesConversion(cap.io,{maximum:5,cap:40})).ok).toBe(false);
 expect(cap.counts().casts).toBe(0);
});
test('SDK adapter withdraws finite unnoted inputs and pairs final bank receipts',async()=>{
 const ids={526:'Bones',1963:'Banana',557:'Earth rune',555:'Water rune',561:'Nature rune'};
 const pack:{id:number;name:string;count:number;slot:number}[]=[];
 const bank=new Map([[526,7],[557,4],[555,4],[561,2],[1963,9]]);
 let generation=1,xp=100,tick=0,casts=0,bankOpen=false;
 const items=()=>[...bank].map(([id,count])=>({id,name:ids[id as keyof typeof ids]!,count}));
 const add=(id:number,n:number)=>{const item=pack.find(i=>i.id===id);if(item)item.count+=n;else pack.push({id,name:ids[id as keyof typeof ids]!,count:n,slot:pack.length});};
 const s={name:'mock',tick:()=>tick,ended:new Promise(()=>{}),onTick:()=>()=>{},
  sdk:{getEquipment:()=>[],getInventory:()=>pack.filter(i=>i.count>0),getState:()=>({player:{lifeId:1,worldX:0,worldZ:0,level:0},inventory:pack.filter(i=>i.count>0),bank:{isOpen:bankOpen}}),
   getSkill:()=>({level:15}),getSkillXp:()=>xp},
  bankObservation:()=>({generation,items:items()}),
  bot:{openBank:async()=>{bankOpen=true;generation++;return{success:true}},closeBank:async()=>{bankOpen=false},
   withdrawItem:async(pattern:RegExp,n:number,o:{asNote:boolean})=>{
    expect(o.asNote).toBe(false);const entry=items().find(i=>pattern.test(i.name));
    if(!entry||entry.count<n)return {success:false};
    bank.set(entry.id,entry.count-n);add(entry.id,n);generation++;return {success:true};},
   depositItem:async(item:{id:number})=>{const p=pack.find(i=>i.id===item.id)!;bank.set(p.id,(bank.get(p.id)??0)+p.count);p.count=0;generation++;return {success:true};}},
  direct:async()=>{casts++;tick++;const bones=pack.find(i=>i.id===526)!;add(1963,bones.count);bones.count=0;
   for(const [id,n] of [[557,2],[555,2],[561,1]])pack.find(i=>i.id===id)!.count-=n!;
   xp+=25;return {success:true};}};
 const result=await runBonesBank(s as any,{maximum:5,cap:40});
 expect(result).toMatchObject({ok:true,made:5,banked:5,casts:1});
 expect(casts).toBe(1);expect(bank.get(1963)).toBe(14);expect(bank.get(526)).toBe(2);
});
test('staff receipts require exactly the substituted native rune costs',()=>{
 const before={bones:2,bananas:0,earth:0,water:2,nature:1,xp:100};
 const after={bones:0,bananas:2,earth:0,water:0,nature:0,xp:125};
 expect(bonesEffect(before,after,{earth:0,water:2,nature:1})).toBe(true);
 expect(bonesEffect(before,after)).toBe(false);
});
test('final bones deposit cannot turn an expired budget or cancellation into success',async()=>{
 const cap=fixture();cap.io.deposit=async()=>{cap.io.tick=()=>100;return 3;};
 expect((await runBonesConversion(cap.io,{maximum:3,cap:40})).ok).toBe(false);
 const stopped=fixture();stopped.io.deposit=async()=>{stopped.io.stopped=()=>true;return 3;};
 expect((await runBonesConversion(stopped.io,{maximum:3,cap:40})).ok).toBe(false);
});
