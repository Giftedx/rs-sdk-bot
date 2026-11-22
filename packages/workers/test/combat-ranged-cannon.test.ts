import { describe, expect, spyOn, test } from 'bun:test';
import {
    BLUE_DRAGON,
    CANNON_LIFE,
    CANNON_REFRESH,
    CANNON_SPOTS,
    MSB,
    bandTicks,
    campCombatRefusal,
    campDeathCredit,
    campOwnershipConflict,
    cancelImpTarget,
    cannonWalker,
    chooseImpCancelStep,
    fireDeathCredit,
    fireFightSafe,
    fireHomeEntryPoints,
    fireMaxHit,
    fireStartRoute,
    freshRangedStart,
    guardImpWalker,
    impCredit,
    impGroundCounts,
    impInsideFence,
    levelsMet,
    loadedBalls,
    makeRangedHealer,
    parseLevels,
    parsePhases,
    pickTarget,
    rangedAmmo,
    rangedCredit,
    reclaimAssetsValid,
    reclaimInputs,
    reloadDue,
    runImps,
    runRangedCamp,
    runRangedStarter,
    sealFireRoom,
    selectCampTarget,
    selectFireTarget,
    selectFireWeapon,
    selectRangedTarget,
    setupCannon,
    specialDue,
    withdrawFireOwned,
    type TargetNpc,
} from '../src/combat';
import { FIGHTER_PROFILES, resolveFighterStep } from '../../../scripts/aio-fighter';
import * as owner from '../../../packages/core/src/bot';
import { type Session } from '../../../packages/core/src/inprocess';
import { supervise } from '../../../packages/practice/src/supervise';
import { leaveRuneStarter } from '../../../scripts/rune-starter';
import { type NearbyNpc } from '../../../vendor/rs-sdk/sdk/types';
import { resolve } from 'node:path';

describe('gather-ranged', () => {
test('ammo includes quiver and pack, keeps unknown distinct and ignores other arrows',()=>{
 expect(rangedAmmo([{id:884,count:2},{id:886,count:100}],[{id:884,count:7}])).toBe(9);
 expect(rangedAmmo(undefined,[])).toBeNull();expect(rangedAmmo([],undefined)).toBeNull();
 expect(rangedAmmo([],[])).toBe(0);expect(rangedAmmo([{id:884,count:-1}],[])).toBeNull();
});
test('credit needs own XP, disappearance and new paired drops; old or missing evidence is no kill',()=>{
 expect(rangedCredit(true,300,1,1)).toBe(true);
 for(const args of [[false,300,1,1],[true,0,1,1],[true,100,1,1],[true,200,1,1],[true,600,1,1],[true,300,0,1],[true,300,1,0],[true,NaN,1,1]] as const)expect(rangedCredit(args[0],args[1],args[2],args[3])).toBe(false);
});
test('target remains the chicken family, field, plane and uncontested identity',()=>{
 const chicken:any={index:10,id:41,x:3235,z:3295,level:0,distance:2,inCombat:false,hp:3,maxHp:3};
 expect(selectRangedTarget([chicken],0)?.index).toBe(10);
 for(const patch of [{id:1},{x:3300},{inCombat:true,targetIndex:32769},{hp:1},{reachable:false}])expect(selectRangedTarget([{...chicken,...patch}],0)).toBeUndefined();
 expect(selectRangedTarget([chicken],1)).toBeUndefined();expect(selectRangedTarget([chicken],undefined)).toBeUndefined();
});


for(const foodId of [329,333])for(const effect of ['matched','debit-only','none'])test('overlapping walk heals '+foodId+' '+effect,async()=>{
 let hp=4,food=3,calls=0,consumed=0,tick=0;
 const callbacks=new Set<()=>void>(),timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
 const s={tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},sdk:{getState:()=>({}),getSkill:()=>({level:hp}),getInventory:()=>[{id:foodId,name:'Fish',count:food,slot:1}]},bot:{eatFood:async()=>{calls++;await new Promise(r=>setTimeout(r,5));if(effect!=='none')food--;if(effect==='matched')hp=10;return {success:true};}}}as unknown as Session;
 try{const heal=makeRangedHealer(s,()=>{consumed++;},foodId),results=await Promise.allSettled([heal(),heal(),heal()]);expect(calls).toBe(1);expect(consumed).toBe(effect==='matched'?1:0);expect(results.every(r=>r.status===(effect==='matched'?'fulfilled':'rejected'))).toBe(true);if(effect==='matched')expect(food).toBe(2);else for(const r of results)if(r.status==='rejected')expect(String(r.reason)).toContain('debit/health unobserved');}finally{clearInterval(timer);}
});

test('finite Ranged refusal is blocked after one login, not twenty repeats',async()=>{
 let calls=0;const r=await supervise({run:async()=>{calls++;return{exitCode:1,stdout:'RESULT fail no Ranged progress: {"ok":false,"failure":"ranged prerequisite: stage owned bow,ammo and selected unnoted food"}'};},stopped:()=>false,pause:async()=>{},maxRestarts:20});expect(r).toEqual({reason:'blocked',runs:1});expect(calls).toBe(1);
});
test('owned interruption remains stopped with its target unmet',async()=>{
 const r=await supervise({run:async()=>({exitCode:1,stdout:'RESULT fail stop file {"ok":false,"targetMet":false}'}),stopped:()=>false,pause:async()=>{},maxRestarts:20});expect(r).toEqual({reason:'stopped',runs:1});
});

test('regen credit is bounded: own3HP beats every other contributor within180ticks',()=>{expect(rangedCredit(true,400,1,1,170)).toBe(true);expect(rangedCredit(true,500,1,1,180)).toBe(true);expect(rangedCredit(true,300,1,1,181)).toBe(false);expect(rangedCredit(true,200,1,1,50)).toBe(false);});


test('actual Ranged pickup consumer reconciles lost ordinary pickup reply by held output',async()=>{const{pickupRangedLoot}=await import('../src/combat');let held=0;const s:any={sdk:{getState:()=>({}),getInventory:()=>held?[{id:526,count:held}]:[]}};const item:any={id:526,count:1};expect(await pickupRangedLoot(s,{pickup:async()=>{held++;return{success:false,telegrab:false};}},item)).toBe(1);held=0;await expect(pickupRangedLoot(s,{pickup:async()=>({success:false,telegrab:true,skipped:true})},item)).rejects.toThrow('loot unavailable');expect(held).toBe(0);});
});

describe('ranged-starter', () => {
test('accepts only a fresh ground-floor tutorial actor', () => {
    const tutorial = { worldX: 3094, worldZ: 3106, level: 0 };
    expect(freshRangedStart(tutorial, 1, 0)).toBe(true);
    expect(freshRangedStart({ worldX: 3222, worldZ: 3222, level: 0 }, 1, 0)).toBe(false);
    expect(freshRangedStart({ ...tutorial, level: 1 }, 1, 0)).toBe(false);
    expect(freshRangedStart(tutorial, 1, 1)).toBe(false);
    expect(freshRangedStart(tutorial, 2, 83)).toBe(false);
    expect(freshRangedStart(undefined, 1, 0)).toBe(false);
});

async function rangedTutorial(mode:'waiting'|'unknown'|'stop'|'delayed-grant'|'missing-grant') {
    let tick=0,grantAt=0,earningAt=0;
    const actions:string[]=[],errors:string[]=[],listeners=new Set<()=>void>();
    const grant=[1351,590,303,315,1925,1931,2309,1265,1205,1277,1171,841].map(id=>({id,count:1}))
        .concat([{id:882,count:25},{id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2}]);
    const state:any={inGame:true,modalOpen:false,modalInterface:-1,
        player:{worldX:3094,worldZ:3106,level:0,lifeId:1},inventory:[],
        dialog:{isOpen:true,isWaiting:mode==='waiting'||mode==='stop',options:[{index:1,text:mode==='unknown'?'Tell me about this place.':'Yes please.',buttonType:1}]},
        nearbyNpcs:[{index:2,name:'Man',x:3222,z:3222,distance:1}]};
    const s:any={name:'starter',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
        client:{ingame:true,ifType:()=>({colour:state.inventory.length?0xf80000:0xff0000})},
        sdk:{getState:()=>state,getDialog:()=>state.dialog,getInventory:()=>state.inventory,
            getSkill:(name:string)=>({level:name==='Hitpoints'?10:1,baseLevel:name==='Hitpoints'?10:1}),getSkillXp:()=>0,
            clickDialogByText:async()=>{actions.push('yes');state.dialog={isOpen:false,isWaiting:false,options:[]};state.player={...state.player,worldX:3222,worldZ:3222};grantAt=tick+4;return{success:true};},
            sendClickDialog:async()=>{actions.push('unexpected-continue');return{success:true};}},
        bot:{skipTutorial:async()=>{actions.push('legacy-skip');throw Error('legacy tutorial path');},
            pickpocketNpc:async()=>{earningAt=tick;actions.push('earn');throw Error('finite entry boundary');}}};
    const settle=spyOn(owner,'settle').mockResolvedValue(true),log=spyOn(console,'log').mockImplementation(()=>{}),error=spyOn(console,'error').mockImplementation(value=>{errors.push(String(value));});
    const timer=setInterval(()=>{tick++;if(grantAt&&tick===grantAt&&mode!=='missing-grant')state.inventory=grant;for(const cb of [...listeners])cb();},1);
    try {
        expect(await runRangedStarter(s,()=>mode==='stop'&&tick>=5,leaveRuneStarter)).toBe(false);
        expect(actions).not.toContain('legacy-skip');
        if(mode==='delayed-grant') {expect(actions).toEqual(['yes','earn']);expect(earningAt).toBeGreaterThanOrEqual(grantAt);}
        else {
            expect(actions).not.toContain('earn');
            expect(actions).not.toContain('unexpected-continue');
            if(mode==='unknown')expect(errors.join('\n')).toContain('unsupported tutorial choice');
            else if(mode==='stop'){expect(tick).toBeLessThanOrEqual(5);expect(errors.join('\n')).toContain('stopped during starter exit');}
            else {expect(tick).toBeGreaterThanOrEqual(100);expect(tick).toBeLessThanOrEqual(101);expect(errors.join('\n')).toContain('starter entry deadline');}
        }
        expect(settle).toHaveBeenCalledWith([s],false,'fresh Ranged starter route');
    } finally {clearInterval(timer);settle.mockRestore();log.mockRestore();error.mockRestore();}
}

for(const mode of ['waiting','unknown','stop','delayed-grant','missing-grant'] as const)
    test(`Ranged caller bounds tutorial ${mode} before any earning or training`,()=>rangedTutorial(mode));
});

describe('microbot-a-ranged-camp', () => {
test('camp selects fresh full-health unclaimed target in native range only',()=>{
 const n:any={id:55,index:1,x:2897,z:9798,distance:5,hp:105,maxHp:105,inCombat:false,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 expect(selectCampTarget([n],BLUE_DRAGON)?.index).toBe(1);expect(selectCampTarget([{...n,hp:null,maxHp:null}],BLUE_DRAGON)?.index).toBe(1);expect(selectCampTarget([{...n,inCombat:true,targetIndex:32769}],BLUE_DRAGON,1)?.index).toBe(1);for(const change of [{hp:100},{inCombat:true},{reachable:false},{x:2950},{id:941}])expect(selectCampTarget([{...n,...change}],BLUE_DRAGON)).toBeUndefined();
});
test('camp credit needs own witnessed death and one of each exact native drop',()=>{
 const o={witness:true,foreign:false,xp:420,loot:[1,1]};expect(campDeathCredit(o,BLUE_DRAGON)).toBe(true);for(const change of [{witness:false},{foreign:true},{xp:0},{xp:419},{loot:[1,0]},{loot:[2,1]}])expect(campDeathCredit({...o,...change},BLUE_DRAGON)).toBe(false);
});
test('camp cap must be finite before session access',async()=>{await expect(runRangedCamp({} as any,BLUE_DRAGON,{cap:Infinity})).rejects.toThrow('invalid');});

test('a dead native target clearing its claim is not a foreign live attacker',()=>{
 expect(campOwnershipConflict({hp:0,inCombat:true,targetIndex:-1},1)).toBe(false);
 expect(campOwnershipConflict({hp:1,inCombat:true,targetIndex:-1},1)).toBe(true);
 expect(campOwnershipConflict({hp:null,inCombat:true,targetIndex:32770},1)).toBe(true);
 expect(campOwnershipConflict({hp:1,inCombat:true,targetIndex:32769},1)).toBe(false);
});

test('single-combat retry accepts only a fresh native refusal, never old text or player chat',()=>{
 const m:any={type:0,sender:'',fromSelf:false,text:"I'm already under attack!",tick:12,observationId:7};
 expect(campCombatRefusal([m],6,11)).toBe(true);expect(campCombatRefusal([m],7,11)).toBe(false);
 expect(campCombatRefusal([{...m,type:2,sender:'Player'}],6,11)).toBe(false);
 expect(campCombatRefusal([{...m,fromSelf:true}],6,11)).toBe(false);
});
});

describe('cannon-fight', () => {
const npc = (index: number, x: number, z: number, more: Partial<TargetNpc> = {}): TargetNpc => ({
  index, name: 'Poison spider', x, z, hp: 64, distance: 0, targetIndex: -1, reachable: true, optionsWithIndex: [{text: 'Attack', opIndex: 2}], ...more,
});

test('a rejected cannon setup dispatch reports the refusal instead of waiting for a server message', async () => {
  let tick = 0;
  const listeners = new Set<() => void>();
  const names = ['Cannon base', 'Cannon stand', 'Cannon barrels', 'Cannon furnace', 'Cannonball'];
  const inventory = [6, 8, 10, 12, 2].map((id, slot) => ({id, slot, count: 1, name: names[slot], optionsWithIndex: [{text: 'Set-up', opIndex: 1}]}));
  const session = {
    tick: () => tick,
    sdk: {getState: () => ({player: {worldX: 3287, worldZ: 3810}, nearbyLocs: [], gameMessages: []}), getInventory: () => inventory},
    onTick: (listener: () => void) => {listeners.add(listener); return () => listeners.delete(listener);},
    direct: async () => ({success: false, reason: 'client_rejected', message: 'Failed to use inventory item'}),
  } as unknown as Session;
  const outcome = setupCannon(session).then(() => null, error => error as Error);
  for (let i = 0; i < 20; i++) {
    tick++;
    for (const listener of [...listeners]) listener();
    await Promise.resolve();
  }
  expect((await outcome)?.message).toContain('cannon set-up dispatch rejected: Failed to use inventory item (slot=0 option=1)');
});

test('load message gives the loaded count', () => {
  expect(loadedBalls('You load the cannon with 30 cannonballs.')).toBe(30);
  expect(loadedBalls('You load the cannon with 1 cannonballs.')).toBe(1);
  expect(loadedBalls('The cannon is already full of ammo.')).toBe(0);
});

test('top-up is due on empty or after the interval', () => {
  expect(reloadDue({now: 119, lastLoad: 100, interval: 20, empty: false})).toBe(false);
  expect(reloadDue({now: 120, lastLoad: 100, interval: 20, empty: false})).toBe(true);
  expect(reloadDue({now: 101, lastLoad: 100, interval: 20, empty: true})).toBe(true);
});

test('target: in reach and near the cannon, attackers first, then low hitpoints', () => {
  const base = {target: /^poison spider$/i, centre: {x: 100, z: 100}, me: {x: 100, z: 98}, near: 10, reach: 7, skip: () => false};
  const far = npc(1, 100, 90), out = npc(2, 115, 100), low = npc(3, 104, 98, {hp: 10, distance: 4}), adjacent = npc(4, 101, 97, {distance: 1});
  expect(pickTarget([far, out], base)).toBeUndefined();
  expect(pickTarget([far, out, low], base)?.index).toBe(3);
  expect(pickTarget([low, adjacent], base)?.index).toBe(4);
  expect(pickTarget([low, adjacent], {...base, skip: i => i === 4})?.index).toBe(3);
  expect(pickTarget([npc(5, 101, 98, {name: 'Black demon'}), npc(6, 101, 98, {hp: 0}), npc(7, 101, 98, {reachable: false})], base)).toBeUndefined();
});

test('phases and stop levels parse, and a phase ends when all its levels are met', () => {
  expect(parseLevels('Ranged=99,defence=99, Hitpoints=99')).toEqual({Ranged: 99, Defence: 99, Hitpoints: 99});
  expect(() => parseLevels('Ranged=100')).toThrow();
  expect(parsePhases('1333:3:Defence=99;861:1')).toEqual([{weapon: 1333, style: 3, until: {Defence: 99}}, {weapon: 861, style: 1}]);
  expect(parsePhases('::Defence=99;')).toEqual([{until: {Defence: 99}}]);
  expect(() => parsePhases('x:1')).toThrow();
  const lv = (k: string) => ({Defence: 99, Ranged: 80} as Record<string, number>)[k] ?? 1;
  expect(levelsMet(lv, {Defence: 99})).toBe(true);
  expect(levelsMet(lv, {Defence: 99, Ranged: 99})).toBe(false);
  expect(levelsMet(lv, undefined)).toBe(false);
});

test('special only with the magic shortbow, the bar off, 350 energy and a fight on', () => {
  const base = {special: true, weapon: MSB, energy: 350, enabled: 0, fighting: true};
  expect(specialDue(base)).toBe(true);
  expect(specialDue({...base, energy: 349})).toBe(false);
  expect(specialDue({...base, enabled: 1})).toBe(false);
  expect(specialDue({...base, weapon: 1333})).toBe(false);
  expect(specialDue({...base, fighting: false})).toBe(false);
  expect(specialDue({...base, special: false})).toBe(false);
  expect(CANNON_REFRESH).toBeLessThan(CANNON_LIFE);
});

test('band ticks from first-seen level ticks', () => {
  expect(bandTicks(new Map([[55, 0], [60, 40], [70, 200]]), [55, 60, 70, 80])).toEqual({'55-60': 40, '60-70': 160});
});

test('spots are multiway rows with a target pattern, and the fighter routes to the worker', () => {
  for (const spot of Object.values(CANNON_SPOTS)) {
    expect(() => new RegExp(spot.target)).not.toThrow();
    expect(spot.near).toBeGreaterThan(0);
  }
  expect(FIGHTER_PROFILES.some(p => p.target === 'cannon')).toBe(true);
  const step = resolveFighterStep('cannon', ['SPOT=battlefield']);
  expect(step.script).toBe('scripts/aio-fighter.ts'); expect(step.args).toEqual(['cannon']);
  expect(step.env.SPOT).toBe('battlefield');
});

test('the spider spot walks out of the spiders\' map square before logout', () => {
  const c = CANNON_SPOTS.spiders!.clear!;
  // Map square 51_59 is z 3776-3839; the spiders wander 10 tiles from their spawns.
  expect(c.z).toBeLessThan(3776 - 10);
  expect(CANNON_SPOTS.battlefield!.clear).toBeUndefined();
});

test.each([undefined, {worldX: 3287, worldZ: 3810, level: 1}])('a known ground clear route rejects an unknown or different start plane', async player => {
  const calls: unknown[] = [];
  const session = {sdk: {getState: () => ({player})}, bot: {walkTo: async (...args: unknown[]) => {calls.push(args); return {success: true};}}} as unknown as Session;
  await expect(cannonWalker(session, CANNON_SPOTS.spiders!)(CANNON_SPOTS.spiders!.clear!)).rejects.toThrow('ground walk requires a known start on the same plane');
  expect(calls).toEqual([]);
});

test('an injected cannon walker still owns its clear route and failure result', async () => {
  const destination = CANNON_SPOTS.spiders!.clear!, calls: unknown[] = [];
  const walked = await cannonWalker({} as Session, CANNON_SPOTS.spiders!, async to => {calls.push(to); return false;})(destination);
  expect(walked).toBe(false);
  expect(calls).toEqual([destination]);
});
});

describe('gather-fire-combat', () => {
test('a disconnected Fire room start uses the guarded exit before bank preparation',()=>{
 expect(fireStartRoute({worldX:2564,worldZ:9883,level:0})).toBe('dungeon');
 expect(fireStartRoute({worldX:2575,worldZ:9862,level:0})).toBe('dungeon');
 expect(fireStartRoute({worldX:2619,worldZ:3332,level:0})).toBe('bank');
 expect(fireStartRoute({worldX:2511,worldZ:3463,level:0})).toBe('surface');
 expect(()=>fireStartRoute({worldX:3200,worldZ:9883,level:0})).toThrow('known Waterfall');
 expect(()=>fireStartRoute({worldX:2564,worldZ:9883,level:1})).toThrow('known Waterfall');
});
test('actual Fire110 maximum is11; mandatory retreat bounds are strict',()=>{expect(fireMaxHit).toBe(11);expect(fireFightSafe(31,8,249)).toBe(true);expect(fireFightSafe(30,8,249)).toBe(false);expect(fireFightSafe(71,7,1)).toBe(false);expect(fireFightSafe(71,16,250)).toBe(false);});
test('no partial XP, disappearance-only or unrelated excess bones counts as full Fire kill',()=>{expect(fireDeathCredit(11100,true,1)).toBe(true);expect(fireDeathCredit(11000,true,1)).toBe(false);expect(fireDeathCredit(11100,false,1)).toBe(false);expect(fireDeathCredit(11100,true,0)).toBe(false);expect(fireDeathCredit(11100,true,2)).toBe(false);});
test('Fire room closes the observed open door and requires the real closed door update',async()=>{
 const state={player:{worldX:2564,worldZ:9883,level:0},nearbyLocs:[{id:1517,x:2563,z:9882,optionsWithIndex:[{text:'Close',opIndex:1}]}],nearbyNpcs:[]};
 const calls:unknown[]=[];
 const s={sdk:{getState:()=>state,sendInteractLoc:async(...args:unknown[])=>{calls.push(args);state.nearbyLocs=[{id:1516,x:2564,z:9881,optionsWithIndex:[{text:'Open',opIndex:1}]}];return{success:true};}}} as unknown as Session;
 await sealFireRoom(s,()=>false);expect(calls).toEqual([[2563,9882,1517,1]]);
});
test('Fire room rejects a spider at the entry instead of waiting for impossible giant credit',async()=>{
 const state={player:{worldX:2564,worldZ:9883,level:0},nearbyLocs:[{id:1516,x:2564,z:9881}],nearbyNpcs:[{id:58,tileX:2564,tileZ:9883}]};
 const s={sdk:{getState:()=>state}} as unknown as Session;
 await expect(sealFireRoom(s,()=>false)).rejects.toThrow('spider at Fire entry');
 state.nearbyNpcs=[{id:58,tileX:2568,tileZ:9884}];
 await sealFireRoom(s,()=>false);
 state.nearbyNpcs=[{id:58,tileX:2564,tileZ:9881}];
 await sealFireRoom(s,()=>false); // South of the observed closed room door.
});
test('Fire target is the giant attacking this client, ahead of an idle giant; another player is excluded',()=>{
 const idle={id:110,index:1,x:2566,z:9888,tileX:2565,tileZ:9887,size:2,distance:1,inCombat:false,reachable:true,hp:null,maxHp:null,targetIndex:-1} as NearbyNpc;
 const other={...idle,index:2,inCombat:true,targetIndex:32770};
 const own={...idle,index:3,inCombat:true,targetIndex:32769,distance:2};
 expect(selectFireTarget([idle,other,own],1)?.index).toBe(3);
 expect(selectFireTarget([other],1)).toBeUndefined();
 expect(selectFireTarget([idle],1)?.index).toBe(1);
 expect(selectFireTarget([idle],-1)).toBeUndefined();
 expect(selectFireTarget([{...own,hp:40,maxHp:111}],1)).toBeUndefined();
 const spider={id:58,tileX:2564,tileZ:9888} as NearbyNpc;
 expect(selectFireTarget([idle,spider],1)).toBeUndefined();
 expect(selectFireTarget([idle,{...spider,tileX:2568,tileZ:9884}],1)?.index).toBe(1);
 const atDoor={...idle,z:9883,tileZ:9882};
 expect(selectFireTarget([atDoor,{...spider,tileX:2564,tileZ:9881}],1)?.index).toBe(1);
});

test('actual south-bank checkpoint reaches observed bank preparation without held recovery food',()=>{
 expect(fireStartRoute({worldX:2655,worldZ:3283,level:0})).toBe('bank');
 expect(fireStartRoute({worldX:2655,worldZ:3289,level:0})).toBe('surface');
 expect(()=>fireStartRoute({worldX:2655,worldZ:3283,level:1})).toThrow('known Waterfall');
});
test('owned scimitar is selected ahead of the Bronze fallback and existing sword choices',()=>{
 expect(selectFireWeapon(new Map([[1277,1],[1287,1],[1331,1]]))).toBe(1331);
});

test('Fire weapon readiness requires actual Attack and unreserved owned quantity',()=>{
 const stock=new Map([[1277,1],[1287,1],[1331,1]]);
 expect(selectFireWeapon(stock,1)).toBe(1277);
 expect(selectFireWeapon(stock,null)).toBe(0);
 expect(selectFireWeapon(stock,30,new Map([[1331,1]]))).toBe(1287);
});
test('a noted scimitar cannot be equipped and unknown weapons do not qualify',()=>{
 expect(selectFireWeapon(new Map([[1332,2],[1277,1]]))).toBe(1277);
 // The weapon list is the item data: a rune scimitar is worn from Attack 40, not before, and an id that is no
 // weapon never qualifies.
 expect(selectFireWeapon(new Map([[1333,1],[1331,0]]))).toBe(1333);
 expect(selectFireWeapon(new Map([[1333,1]]),30)).toBe(0);
 expect(selectFireWeapon(new Map([[99999,1],[1331,0]]))).toBe(0);
 // A two-handed sword never serves: the pilot wears a shield.
 expect(selectFireWeapon(new Map([[1319,1]]))).toBe(0);
 expect(selectFireWeapon(new Map([[1319,1],[1277,1]]))).toBe(1277);
 expect(selectFireWeapon(new Map())).toBe(0);
});
test('prior sword ordering still applies when no normal scimitar is owned',()=>{
 expect(selectFireWeapon(new Map([[1287,1],[1301,1],[1277,1]]))).toBe(1287);
 expect(selectFireWeapon(new Map([[1301,1],[1277,1]]))).toBe(1301);
});
});

describe('gather-fire-giants', () => {
test('actual South entry uses ONLY the proven North-bank two-leg route; North stays home',()=>{
 expect(fireHomeEntryPoints({x:2655,z:3283,level:0})).toEqual([{x:2644,z:3293,tol:0},{x:2619,z:3332,tol:0}]);
 expect(fireHomeEntryPoints({x:2619,z:3332,level:0})).toEqual([]);
 expect(()=>fireHomeEntryPoints({x:2657,z:3382,level:0})).toThrow('actual Ardy South or North bank');
 expect(()=>fireHomeEntryPoints({x:2655,z:3283,level:1})).toThrow('known surface bank');
});
test('reclaim requires owned pebble, all sixteen Salmon and no already owned amulet',()=>{
 expect(reclaimInputs([{id:294,count:1},{id:329,count:16}])).toBe(true);
 expect(reclaimInputs([{id:329,count:16}])).toBe(false);
 expect(reclaimInputs([{id:294,count:1},{id:329,count:15}])).toBe(false);
 expect(reclaimInputs([{id:294,count:1},{id:329,count:16},{id:295,count:1}])).toBe(false);
});
test('owned withdrawal passes actual item294 at bank slot5, never numeric item-id294 as slot',async()=>{
 const inventory:{id:number;count:number}[]=[],bankItem={id:294,name:"Glarial's pebble",count:1,slot:5},calls:unknown[]=[];
 const session={tick:()=>1,sdk:{getInventory:()=>inventory,getState:()=>({bank:{items:[bankItem]}})},bankObservation:()=>({generation:1,at:1,items:[{id:294,name:bankItem.name,count:1}]}),bot:{withdrawItem:async(target:unknown,amount:number)=>{calls.push(target);if(typeof target!=='object'||target===null||!('slot'in target)||target.slot!==5)return{success:false};inventory.push({id:294,count:amount});return{success:true};}}} as unknown as Session;
 await withdrawFireOwned(session,294,1);
 expect(calls).toEqual([bankItem]);expect(calls[0]).not.toBe(294);expect(inventory).toEqual([{id:294,count:1}]);
});
test('unknown or inconsistent fresh bank count blocks withdrawal before dispatch',async()=>{
 let calls=0;const session={sdk:{getInventory:()=>[],getState:()=>({bank:{items:[{id:294,slot:5,name:'Pebble',count:1}]}})},bankObservation:()=>({generation:1,at:1,items:[{id:294,name:'Pebble',count:2}]}),bot:{withdrawItem:async()=>{calls++;return{success:true};}}} as unknown as Session;
 await expect(withdrawFireOwned(session,294,1)).rejects.toThrow('OWN bank item/count unknown');expect(calls).toBe(0);
});
test('only one new amulet and actual Salmon consumption may change total owned assets',()=>{
 const before=new Map([[294,1],[329,378],[1277,1],[1171,1],[1601,2],[995,178]]),after=new Map(before);after.set(295,1);after.set(329,376);
 expect(reclaimAssetsValid(before,after,2)).toBe(true);
 after.set(1601,1);expect(reclaimAssetsValid(before,after,2)).toBe(false);
 after.set(1601,2);after.set(295,2);expect(reclaimAssetsValid(before,after,2)).toBe(false);
 after.set(295,1);expect(reclaimAssetsValid(before,after,1)).toBe(false);
 expect(reclaimAssetsValid(before,after,-1)).toBe(false);
});
});

describe('gather-imps', () => {
test('actual lite movement returns success with no packet for current tile, but adjacent movement emits MOVE_GAMECLICK',async()=>{
    const root=resolve(import.meta.dir,'../../../vendor/rs-sdk/server/webclient/src');
    await import(resolve(root,'lite/dom-shim.ts'));
    const {findPathToTile}=await import(resolve(root,'lite/movement.ts'));
    const {default:CollisionMap}=await import(resolve(root,'dash3d/CollisionMap.ts'));
    const writes:[string,number][]=[];
    const client={ensureCollision(){},collision:[new CollisionMap()],minusedlevel:0,localPlayer:{routeX:[50],routeZ:[50]},mapBuildBaseX:2589,mapBuildBaseZ:3178,
        out:{p1Enc(n:number){writes.push(['opcode',n]);},p1(n:number){writes.push(['p1',n]);},p2(n:number){writes.push(['p2',n]);}}};
    expect(findPathToTile(client,50,50,false)).toBe(true);expect(writes).toEqual([]);
    expect(findPathToTile(client,51,50,false)).toBe(true);
    expect(writes).toEqual([['opcode',234],['p1',5],['p1',0],['p2',2640],['p2',3228]]);
});
test('adjacent cancellation selection rejects blocked, detour and outside-fence candidates without trial input',()=>{
    expect(chooseImpCancelStep({plan:()=>[]},{x:2639,z:3228})).toBeNull();
    expect(chooseImpCancelStep({plan:(_l,_f,to)=>[{x:2637,z:3234},to]},{x:2639,z:3228})).toBeNull();
    expect(chooseImpCancelStep({plan:(_l,_f,to)=>[to]},{x:2627,z:3228})).toBeNull();
});
test('adjacent cancellation requires observed step and fresh targetNONE, while recent-hit inCombat may remain true',async()=>{
    for(const mode of ['arrived','no-move','stale-target'] as const){
        let tick=0,x=2639,z=3228,target=true,pending:{x:number;z:number}|undefined,calls=0;
        const listeners=new Set<()=>void>(),timer=setInterval(()=>{tick++;if(pending&&mode!=='no-move'){x=pending.x;z=pending.z;pending=undefined;if(mode!=='stale-target')target=false;}for(const cb of listeners)cb();},1);
        const session={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
            sdk:{getSkill:()=>({level:13}),getState:()=>({autoRetaliateEnabled:false,player:{worldX:x,worldZ:z,level:0,combat:{inCombat:true,targetType:target?'npc':'none',targetIndex:target?3529:-1}}})},
            direct:async(a:any)=>{calls++;expect(a.running).toBe(false);expect(a.x!==x||a.z!==z).toBe(true);expect(impInsideFence({x:a.x,z:a.z})).toBe(true);pending={x:a.x,z:a.z};return{success:true};}
        } as unknown as Session;
        try{const promise=cancelImpTarget(session,{plan:(_l,_f,to)=>[to]});if(mode==='arrived')expect(await promise).toMatchObject({movementObserved:true,targetNoneObserved:true,recentHitInCombat:true});else await expect(promise).rejects.toThrow('adjacent cancellation unobserved');expect(calls).toBe(1);}finally{clearInterval(timer);}
    }
});

test('imp teleport/disappearance, dispatch and XP alone never prove a kill',()=>{
    expect(impCredit(true,100,0)).toBe(false);
    expect(impCredit(false,100,1)).toBe(false);
    expect(impCredit(true,0,1)).toBe(false);
    expect(impCredit(true,100,1)).toBe(true);
    const counts=impGroundCounts([{id:592,x:2633,z:3243,count:1},{id:592,x:2633,z:3243,count:2}]);
    expect(counts.get('592:2633:3243')).toBe(3);
});
test('imp guard rejects incomplete paths and fence escapes before dispatch',()=>{
    expect(impInsideFence({x:2633,z:3243,level:0})).toBe(true);
    expect(impInsideFence({x:2610,z:3268,level:0})).toBe(false);
    let calls=0;
    const base:any={pos:()=>({x:2633,z:3243,level:0}),plan:()=>[{x:2610,z:3268}],walk:()=>{calls++;},interactLoc:()=>{calls++;}};
    const g=guardImpWalker(base,()=>null);
    g.deps.walk(2639,3230);expect(calls).toBe(0);expect(g.reason()).toContain('imp route');
});
test('imp guard rejects an adjacent blocked goal and a full hunt path that briefly leaves the fence',()=>{
    for(const path of [[{x:2638,z:3230}],[{x:2646,z:3243},{x:2639,z:3230}]]){
        let calls=0;const g=guardImpWalker({pos:()=>({x:2633,z:3243,level:0}),plan:()=>path,walk:()=>{calls++;},interactLoc:()=>{},locs:()=>[],onTick:()=>()=>{}},()=>null,true);
        g.deps.walk(2639,3230);expect(calls).toBe(0);expect(g.reason()).toContain('imp route incomplete');
    }
});
function fixture(mode:'kill'|'teleport'|'escape'|'no-loot'|'pickup-loss'|'delayed-food'|'old-ash'|'other-player'|'unwitnessed-ash'|'retarget'|'retarget-no-cancel'|'unsafe-actor'|'deferred-first'|'reengage'|'reengage-stall'='kill'){
    let tick=0,generation=0,open=false,x=2655,z=3283,hp=14,xp=900,index=7,attacks=0,eats=0,healAt=Infinity,dropAt=Infinity,dropX=2633,dropZ=3243;
    const listeners=new Set<()=>void>();
    const inv:any[]=[{id:995,count:140,name:'Coins',slot:0},{id:333,count:6,name:'Trout',slot:1},{id:315,count:1,name:'Shrimps',slot:2},{id:2309,count:1,name:'Bread',slot:3},{id:1277,count:1,name:'Bronze sword',slot:4},{id:1171,count:1,name:'Wooden shield',slot:5}];
    const equipment:any[]=[{id:1277,count:1,name:'Bronze sword',slot:3},{id:1171,count:1,name:'Wooden shield',slot:5}];
    const bank:any[]=[{id:995,count:25,name:'Coins',slot:0},{id:592,count:3,name:'Ashes',slot:1}];let ground:any[]=mode==='old-ash'?[{id:592,name:'Ashes',x:2633,z:3243,count:3,distance:0}]:[];
    const makeNpc=()=>({id:708,index:index++,name:'Imp',tileX:2633,tileZ:3243,x:2633,z:3243,hp:8,maxHp:8,inCombat:false,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]});
    let npc:any=makeNpc();const other=mode.startsWith('retarget')||mode==='deferred-first'?makeNpc():null;let fighting=false,recentHit=false,cancels=0,outsideHuntClicks=0,pendingStep:{x:number;z:number}|undefined;
    if(mode==='deferred-first'){npc.hp=null;npc.maxHp=null;}
    const state=()=>({player:{worldX:x,worldZ:z,level:0,lifeId:1,respawnCount:0,combat:{inCombat:fighting||recentHit,targetType:fighting?'npc':'none',targetIndex:fighting?npc?.index??-1:-1}},autoRetaliateEnabled:false,inventory:inv,equipment,bank:{isOpen:open,items:bank},nearbyNpcs:[...(npc?[npc]:[]),...(other?[other]:[])],nearbyPlayers:mode==='other-player'?[{index:99,x:2634,z:3243}]:[],groundItems:ground,combatStyle:{known:true,currentStyle:0,weaponName:'Bronze sword',styles:[{index:0,trainsSkills:['Attack']}]}});
    const add=(items:any[],id:number,n:number)=>{const item=items.find(i=>i.id===id);if(item)item.count+=n;else items.push({id,name:String(id),count:n,slot:items.length});};
    const drop=()=>{if(mode!=='no-loot'&&mode!=='old-ash')ground=[{id:592,name:'Ashes',x:dropX,z:dropZ,count:2,distance:0},{id:1470,name:'Red bead',x:dropX,z:dropZ,count:1,distance:0}];npc=null;};
    const timer=setInterval(()=>{tick++;if(pendingStep){x=pendingStep.x;z=pendingStep.z;pendingStep=undefined;fighting=false;}if(tick>=dropAt){drop();dropAt=Infinity;}if(tick>=healAt){hp=14;healAt=Infinity;}for(const cb of listeners)cb();},1);
    const session={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
        bankObservation:()=>open?{generation,at:tick,items:bank}:null,direct:async(a:any)=>{if(a.type==='walkTo'&&(a.x!==x||a.z!==z)&&mode!=='retarget-no-cancel')pendingStep={x:a.x,z:a.z};cancels++;return{success:true};},
        sdk:{getState:state,getInventory:()=>inv,getEquipment:()=>equipment,getSkillXp:()=>xp,getSkill:(name:string)=>({level:name==='Hitpoints'?hp:9,baseLevel:name==='Hitpoints'?14:9}),sendSetCombatStyle:async()=>({success:true}),
            sendInteractNpc:async(actualIndex:number,op:number)=>{expect(op).toBe(2);if((mode.startsWith('retarget')||mode.startsWith('reengage'))&&attacks>0){expect(fighting).toBe(false);expect(cancels).toBeGreaterThan(0);}attacks++;if(mode!=='reengage-stall'||attacks===1)xp+=200;fighting=true;recentHit=true;
                if(mode.startsWith('reengage')){expect(actualIndex).toBe(npc.index);if(attacks===1||mode==='reengage-stall'){npc.hp=1;npc.inCombat=false;npc.tileX=2634;npc.x=2634;fighting=false;return{success:true};}dropX=npc.tileX;dropZ=npc.tileZ;}
                if(mode.startsWith('retarget')&&attacks===1){expect(actualIndex).toBe(npc.index);npc.tileX=2627;npc.x=2627;return{success:true};}
                if(mode.startsWith('retarget')||mode==='deferred-first'){expect(actualIndex).toBe(other!.index);npc=other;}
                else expect(actualIndex).toBe(npc.index);
                if(mode==='unsafe-actor'){x=2627;return{success:true};}
                if(mode==='teleport'){npc=null;return{success:true};}
                if(mode==='escape'){npc.tileX=2610;npc.x=2610;return{success:true};}
                if(mode==='delayed-food')hp=8;
                if(mode==='unwitnessed-ash')drop();else{npc.hp=0;npc.animId=172;dropAt=tick+2;}
                return{success:true};},
            sendPickup:async(px:number,pz:number,id:number)=>{const item=ground.find(i=>i.id===id&&i.x===px&&i.z===pz);if(!item)return{success:false};ground=ground.filter(i=>i!==item);if(mode!=='pickup-loss')add(inv,id,item.count);if(!ground.length)npc=makeNpc();return{success:true};}},
        bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},equipItem:async()=>{throw new Error('already worn kit must not re-equip');},eatFood:async()=>{inv.find(i=>i.id===333).count--;eats++;healAt=tick+2;return{success:true};},depositItem:async(item:any)=>{add(bank,item.id,item.count);inv.splice(inv.indexOf(item),1);generation++;return{success:true};}}
    } as unknown as Session;
    return{session,planner:{plan:(_level:number,_from:any,to:any)=>[to]},walk:async(points:any[])=>{const end=points.at(-1);if(points.length===1&&!impInsideFence(end))outsideHuntClicks++;x=end.x;z=end.z;return true;},pos:()=>[x,z],stop:()=>clearInterval(timer),attacks:()=>attacks,eats:()=>eats,cancels:()=>cancels,outsideHuntClicks:()=>outsideHuntClicks,bank,inv};
}
test('same visible1HP target disengages, then guarded re-engagement yields witnessed death and anchored ashes',async()=>{
    const f=fixture('reengage');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:30,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:1,attacks:2,reengagements:1,attackXp:400,creditedAttackXp:400,abandonedAttackXp:0,preserved:true,banked:{592:2,1470:1}});expect(r.credits[0].anchor).toEqual([2634,3243]);expect(r.abandoned).toHaveLength(0);expect(f.outsideHuntClicks()).toBe(0);}finally{f.stop();}
});
test('re-engagement clicks without new damage never reset the damage deadline or create a kill',async()=>{
    const f=fixture('reengage-stall');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:20,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.creditedAttackXp).toBe(0);expect(r.abandonedAttackXp).toBe(200);expect(r.ticks).toBeLessThan(50);expect(f.attacks()).toBeLessThanOrEqual(5);}finally{f.stop();}
});
test('target-only teleport cancels then selects a different safe imp; abandoned XP is never a kill',async()=>{
    const f=fixture('retarget');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:10,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:1,attacks:2,attackXp:400,creditedAttackXp:200,abandonedAttackXp:200,banked:{592:2,1470:1},preserved:true});expect(r.abandoned).toHaveLength(1);expect(r.abandoned[0].cancellationObserved).toBe(true);expect(f.cancels()).toBeGreaterThan(0);expect(f.outsideHuntClicks()).toBe(0);}finally{f.stop();}
});
test('target-only escape cannot retarget while cancellation remains unobserved',async()=>{
    const f=fixture('retarget-no-cancel');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.failure).toContain('cancellation unobserved');expect(f.attacks()).toBe(1);expect(r.abandonedAttackXp).toBe(200);expect(f.pos()).toEqual([2655,3283]);expect(r.preserved).toBe(true);}finally{f.stop();}
});
test('actor near the edge still aborts the whole job and never retargets',async()=>{
    const f=fixture('unsafe-actor');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(f.attacks()).toBe(1);expect(r.creditedKills).toBe(0);expect(r.failure).toContain('player');}finally{f.stop();}
});
test('known prior partial NPC can be explicitly excluded without attacking it or treating unknown health as proof',async()=>{
    const f=fixture('deferred-first');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:10,deferredNpcIndices:[7],walk:f.walk,cancelPlanner:f.planner});expect(r.initialDeferredNpcIndices).toEqual([7]);expect(r.ok).toBe(true);expect(r.attacks).toBe(1);expect(r.creditedKills).toBe(1);expect(r.credits[0].npcIndex).toBe(8);}finally{f.stop();}
});
test('initial deferred list is bounded and validated before session use',async()=>{
    for(const indices of [[-1],[1.5],Array.from({length:9},(_,i)=>i)])await expect(runImps({} as Session,{cap:100,maximum:1,deferredNpcIndices:indices})).rejects.toThrow('invalid initial deferred');
});
test('two bounded imp kills bank actual double-ash and optional bead counts, XP and all duplicate kit/cash',async()=>{
    const f=fixture();try{const r=await runImps(f.session,{cap:200,maximum:2,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:2,attacks:2,attackXp:400,loot:{592:4,1470:2},banked:{592:4,1470:2},eaten:0,preserved:true,targetMet:true,hpMin:14});expect(f.bank.find(i=>i.id===592).count).toBe(7);}finally{f.stop();}
});
for(const mode of ['teleport','no-loot','old-ash','unwitnessed-ash'] as const)test(`imp ${mode} with own XP stops without invented kill or loot`,async()=>{
    const f=fixture(mode);try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:5,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.banked[592]).toBe(0);expect(r.preserved).toBe(true);expect(f.attacks()).toBe(1);}finally{f.stop();}
});
test('imp refuses a competing player before attack and keeps all assets',async()=>{
    const f=fixture('other-player');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.failure).toContain('another player');expect(f.attacks()).toBe(0);expect(r.preserved).toBe(true);}finally{f.stop();}
});
test('imp teleport outside fence is deferred without chasing; no other eligible target ends bounded search',async()=>{
    const f=fixture('escape');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:5,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.failure).toContain('no eligible target');expect(r.creditedKills).toBe(0);expect(f.attacks()).toBe(1);expect(r.preserved).toBe(true);expect(r.abandoned).toHaveLength(1);expect(r.abandoned[0]).toMatchObject({partialDamageXp:200,cancellationObserved:true});}finally{f.stop();}
});
test('imp pickup disappearance without actual inventory gain cannot claim output',async()=>{
    const f=fixture('pickup-loss');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.banked[592]).toBe(0);expect(r.failure).toContain('pickup unobserved');}finally{f.stop();}
});
test('imp food waits for the actual delayed heal and counts one debit before carrying on',async()=>{
    const f=fixture('delayed-food');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:1,eaten:1,hpMin:8,preserved:true});expect(f.eats()).toBe(1);expect(f.inv.find(i=>i.id===333).count).toBe(5);}finally{f.stop();}
});
});
