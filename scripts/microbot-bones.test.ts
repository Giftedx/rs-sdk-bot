import {test,expect} from 'bun:test';
import {bonesEffect,runBonesConversion,type BonesIO} from './microbot-bones';

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
