import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runeSupplyPreserved} from '../../../../scripts/rune-supply';
import {readPracticeSave} from '../fleet-player-save';
import {airRecoveryPositions,assets,hash,logout,POSTCRAFT_XP,type RecoverySession,repoRoot,retainedProgress,type Run,same,type Save,sum,summary} from './contracts';

// PlayerLoading -> getExpByLevel(10): pinned levelExperience[8] is 9800
// raw tenths, or 980 XP. The reader truncates tenths; check both fields exactly.
export const freshRuneDefaultSkills=(s:Save)=>s.skills.length===21&&s.skills.every((s,i)=>
 i===3?s.level===10&&s.xp===980&&s.rawExperience===9800:s.level===1&&s.xp===0&&s.rawExperience===0);

export function freshRuneSupportedInterruption(first:Run){
 const a=summary(first);
 return first.code!==0&&a?.ok===false&&typeof a?.stage==='string'&&a.stage!=='entry'&&a?.stopReason==='tick-cap'&&Number.isSafeInteger(a?.ticks)&&a.ticks>=1000;
}

export function freshRuneSupplyChecks(p:{before:Save;interrupted:Save;after:Save;first:Run;resume:Run;xpRate:number;target:number;additional?:Run[]}){
 const {before,interrupted,after,first,resume,xpRate,target}=p;
 const a=summary(first),b=summary(resume),initialAir=sum(before,556),tutorial=(before.vars[281]??0)<1000;
 const grantedAir=tutorial?25:0,mining=(after.skills[14]?.xp??0)-(before.skills[14]?.xp??0),rc=(after.skills[20]?.xp??0)-(before.skills[20]?.xp??0);
 const mined=mining/(5*xpRate),used=rc/(5*xpRate),stock=sum(after,1436)-sum(before,1436);
 const runs=[first,...(p.additional??[]),resume],results=runs.map(summary);
 const total=(get:(r:any)=>number)=>results.reduce((n,r)=>n+(get(r)??0),0);
 const crafted=total(r=>r?.crafted);
 const food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 const cooked=total(r=>r?.stages?.food?.cooked),burnt=total(r=>r?.stages?.food?.burnt);
 const eaten=total(r=>(r?.travelFoodEaten??0)+(r?.stages?.quest?.eats??0)+(r?.stages?.questExit?.eats??0));
 return {
  defaultSkills:freshRuneDefaultSkills(before),
  defaultQuest:(before.vars[63]??0)===0&&(before.vars[101]??0)===0,
  noSeededEssence:sum(before,1436)===0,
  tutorial:after.vars[281]===1000,
  quest:after.vars[63]===6&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  reward:sum(after,1438)===1,
  target:(after.skills[20]?.level??0)>=target&&rc>0&&mining>0,
  minedOwnInput:Number.isSafeInteger(mined)&&mined>0&&Number.isSafeInteger(used)&&used>0&&mined===used+stock,
  newBankedRunes:crafted>0&&sum(after,556,95)===initialAir+grantedAir+crafted&&sum(after,556,93)===0,
  kit:[1277,1171,1265,1351,590,303,1925,1931,1205,841].every(id=>sum(after,id)>=1),
  food:food(after)===food(before)+(tutorial?2:0)+cooked-eaten,
  cooking:after.skills[7]!.rawExperience-before.skills[7]!.rawExperience===cooked*30*xpRate*10&&sum(after,2144)-sum(before,2144)===burnt,
  cash:sum(after,995)===sum(before,995)+(tutorial?25:0),
  preserved:runeSupplyPreserved(assets(before),assets(after)),
  stopped:freshRuneSupportedInterruption(first),
  retainedProgress:retainedProgress(before,interrupted),
  resume:resume.code===0&&b?.ok===true&&b?.preserved===true&&b?.target===target,
  life:after.skills[3]!.level>0&&runs.every(r=>! /"isDead":true|"died":true/.test(r.log)),
  logout:runs.every(logout),
 };
}

export function freshRuneCookingDiagnosticInput(name:string,retained:string){
 if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('diagnostic requires an existing practice account');
 if(existsSync(join(repoRoot,'.practice',`stop-${name}`)))throw Error('diagnostic account has a stop file; preserve the stop');
 const botDir=join(repoRoot,'vendor/rs-sdk/bots',name),save=join(repoRoot,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
 if(!existsSync(save)||!existsSync(join(botDir,'bot.env'))||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))
  throw Error('diagnostic requires retained local identity; never register or restore a save');
 if(resolve(retained)===resolve(save)||hash(retained)!==hash(save))throw Error('diagnostic current save differs from retained evidence; do not reseed');
 const before=readPracticeSave(save);
 if(before.position.level!==0||Math.max(Math.abs(before.position.x-3214),Math.abs(before.position.z-3249))>2||sum(before,2138,93)<1)
  throw Error('diagnostic requires retained raw chicken at the failed fireplace boundary');
 return {save,before};
}

export function freshRuneCookingDiagnosticChecks(before:Save,after:Save,run:Run){
 const cooked=sum(after,2140)-sum(before,2140),burnt=sum(after,2144)-sum(before,2144),debit=sum(before,2138)-sum(after,2138);
 const xp=after.skills[7]!.xp-before.skills[7]!.xp;
 const a=assets(before),b=assets(after),converted=new Set([2138,2140,2144]);
 return {child:run.code===0,logout:logout(run),oneConversion:debit===1&&cooked>=0&&burnt>=0&&cooked+burnt===debit,
  xp:cooked>0?xp>0:xp===0,questUnchanged:after.vars[63]===before.vars[63]&&after.vars[101]===before.vars[101],
  life:after.skills[3]!.level>0&&!/"isDead":true|"died":true/.test(run.log),
  otherSkills:after.skills.every((s,i)=>i===7||s.rawExperience===before.skills[i]!.rawExperience),
  preserved:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  observations:run.log.includes('STARTER_COOKING ')&&run.log.includes('"phase":"dispatch"')&&run.log.includes('"phase":"action"')&&run.log.includes('RUNE_COOK_DIAGNOSTIC_RESULT ')};
}

// Continue the ordinary retained identity. Copy evidence, never restore or seed
// the engine's save. Full-delivery registration and predicates stay separate.
export function freshRuneEssenceDiagnosticInput(name:string,retained:string){
 if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('diagnostic requires an existing practice account');
 if(existsSync(join(repoRoot,'.practice',`stop-${name}`)))throw Error('diagnostic account has a stop file; preserve the stop');
 const botDir=join(repoRoot,'vendor/rs-sdk/bots',name),save=join(repoRoot,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
 if(!existsSync(save)||!existsSync(join(botDir,'bot.env'))||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))
  throw Error('diagnostic requires retained local identity; never register or restore a save');
 if(resolve(retained)===resolve(save)||hash(retained)!==hash(save))throw Error('diagnostic current save differs from retained evidence; do not reseed');
 const before=readPracticeSave(save);
 if(before.vars[63]!==6||before.vars[101]!==1||before.vars[281]!==1000||before.position.level!==0||before.position.z>=4000
  ||before.skills[3]!.level<=0||before.skills[14]!.xp<=0||before.skills[20]!.xp!==0||before.skills[20]!.rawExperience!==0||before.skills[20]!.level!==1||sum(before,1436)<=0||sum(before,1438)!==1)
  throw Error('diagnostic requires completed Rune Mysteries and retained self-mined essence before first craft');
 return {save,before};
}

export function freshRuneEssenceDiagnosticChecks(before:Save,after:Save,run:Run){
 const r=summary(run),used=sum(before,1436)-sum(after,1436),newAir=sum(after,556)-sum(before,556);
 const xp=after.skills[20]!.xp-before.skills[20]!.xp,food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 const a=assets(before),b=assets(after),converted=new Set([1436,556,315,2309,2140]);
 const observations=run.log.split(/\r?\n/).filter(l=>l.startsWith('RUNE_SUPPLY_ACTION ')).map(l=>{try{return JSON.parse(l.slice(19));}catch{return null;}});
 return {child:run.code===0&&r?.ok===true&&r?.target===2,logout:logout(run),
  questUnchanged:before.vars[63]===6&&after.vars[63]===6&&after.vars[101]===before.vars[101]&&after.vars[281]===before.vars[281],
  noPreparation:!r?.stages?.training&&!r?.stages?.food&&!r?.stages?.quest&&!r?.stages?.questExit&&!/ESSENCE_START|STARTER_COOKING_RESULT|MILESTONE training/.test(run.log),
  noMining:r?.mined===0&&after.skills[14]!.rawExperience===before.skills[14]!.rawExperience,
  // Pinned runecraft.rs2 snapshots level before XP. Air multiplier is
  // floor(level/11)+1, so this first level1 craft produces exactly one per essence.
  conversion:before.skills[20]!.xp===0&&before.skills[20]!.level===1&&r?.stages?.batches===1&&used>0&&xp===used*125
   &&after.skills[20]!.rawExperience-before.skills[20]!.rawExperience===used*1250&&r?.consumed===used&&newAir===used&&r?.crafted===newAir,
  banked:sum(after,556,93)===0&&sum(after,556,95)===sum(before,556)+newAir&&r?.banked===newAir,
  otherSkills:after.skills.every((s,i)=>i===20||s.rawExperience===before.skills[i]!.rawExperience&&s.xp===before.skills[i]!.xp),
  life:after.skills[3]!.level>0&&!/"isDead":true|"died":true/.test(run.log),
  food:food(after)===food(before)-(r?.travelFoodEaten??0),
  preserved:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  observations:['craft-air','deposit-air'].every(action=>observations.some(o=>o?.action===action&&o?.phase==='end'))};
}

export function freshRuneRecoveryContentsEqual(before:Save,after:Save,session?:RecoverySession){
 // The ordinary generator writes v6/dense varps. PlayerLoading/Player.save
 // upgrade to v9/sparse varps on logout. Compare values, not serialization.
 const expected={...before.vars};
 if(session){
  // Only these three ordinary altar fixtures are supported, never arbitrary saves.
  if(!airRecoveryPositions.some(p=>same(p,before.position))||before.vars[63]!==6||before.vars[101]!==1||before.vars[281]!==1000
   ||!['refused','exit'].includes(session.mode)||!Number.isSafeInteger(session.clockBefore)||!Number.isSafeInteger(session.clockAfter)
   ||session.clockBefore<1||session.clockAfter<session.clockBefore||session.clockAfter-session.clockBefore>6000
   ||!Number.isSafeInteger(after.vars[134])||after.vars[134]!<session.clockBefore||after.vars[134]!>session.clockAfter)return false;
  // login_logout/login.rs2: defaults run only when brightness is zero.
  if((before.vars[166]??0)===0)Object.assign(expected,{166:2,168:2,169:2});
  // musicregion.dbrow 44_75 -> Serene, music.dbrow unlock 4,13.
  expected[23]=((before.vars[23]??0)|8192)>>>0;
  // An observed exit enters 46_51 -> Nightfall, unlock 3,26. No other bits.
  if(session.mode==='exit')expected[22]=((before.vars[22]??0)|67108864)>>>0;
  // pet.rs2 follower_login: object0 has no follower_id and is cleared.
  if((before.vars[275]??0)===0)expected[275]=0xffffffff;
  // anti_fire.rs2 set_antifire_logout: zero expires at positive map_clock.
  // An active timer is outside this fixture contract, rather than silently erased.
  if((before.vars[277]??0)!==0&&(before.vars[277]>>>0)!==0xffffffff)return false;
  expected[277]=0xffffffff;
  // Player constructor defaults non-int types to -1. The v6 generator ends at
  // varp308, so absent coord367 keeps that default. An explicit value must match.
  if(before.vars[367]===undefined)expected[367]=0xffffffff;
  // logout.rs2 writes map_clock. Both bounds come from the owned server's
  // read-only /tickstats before/after this CLI, retained and hashed per session.
  expected[134]=after.vars[134]!;
 }
 const vars=(v:Save['vars'])=>Object.fromEntries(Object.entries(v).map(([id,value])=>[id,value>>>0] as const).filter(([,value])=>value!==0));
 const position=session?.mode==='exit'?{x:2983,z:3288,level:0}:before.position;
 return same(position,after.position)&&same(before.skills,after.skills)&&same(before.inventories,after.inventories)&&same(vars(expected),vars(after.vars));
}

export function freshRuneSavedResult(save:Save,run:Run){
 if(summary(run)?.stages?.food?.settlement==='unresolved')return false;
 const final=summary(run)?.final;
 if(!final||final.skills?.length!==save.skills.length||!Array.isArray(final.inventory)||!Array.isArray(final.equipment))return false;
 const totals=(items:{id:number;count:number}[])=>items.reduce((a,i)=>{a[i.id]=(a[i.id]??0)+i.count;return a;},{} as Record<number,number>);
 const equalItems=(a:Record<number,number>,b:Record<number,number>)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>(a[Number(id)]??0)===(b[Number(id)]??0));
 // Pinned UpdateStatEncoder sends (exp / 10) | 0. Compare that whole-XP
 // projection only here; raw saved tenths remain authoritative for effects.
 return save.skills.every((s,i)=>Math.trunc(s.rawExperience/10)===final.skills[i].experience&&s.level===final.skills[i].level)
  &&equalItems(totals(save.inventories[93]??[]),totals(final.inventory))&&equalItems(totals(save.inventories[94]??[]),totals(final.equipment));
}

export function freshRuneAirRecoveryChecks(before:Save,after:Save,run:Run,target:20|21){
 const r=summary(run),food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 const raw=(s:Save,i:number)=>s.skills[i]!.rawExperience;
 const mined=(raw(after,14)-raw(before,14))/1250,used=(raw(after,20)-raw(before,20))/1250;
 const newAir=sum(after,556)-sum(before,556),a=assets(before),b=assets(after),converted=new Set([1436,556,315,2309,2140]);
 return {child:run.code===0&&r?.ok===true&&r?.target===target,logout:logout(run),savedResult:freshRuneSavedResult(after,run),
  entry:before.vars[63]===6&&before.vars[101]===1&&before.vars[281]===1000&&sum(before,556)===51
   &&before.skills[20]!.level===20&&raw(before,20)===32500
   &&sum(before,1436)===0&&[1438,1265,1171].every(id=>sum(before,id)===1),
  quest:after.vars[63]===6&&after.vars[101]===1&&after.vars[281]===1000,
  target:after.skills[20]!.level>=target,
  inherited:target===20?r?.inheritedBanked===26&&r?.banked===26&&r?.newBanked===0&&r?.crafted===0&&r?.consumed===0&&r?.mined===0
   &&sum(before,556,93)===26&&sum(before,556,95)===25&&sum(after,556)===51
   :r?.inheritedBanked===0&&sum(before,556,93)===0&&sum(before,556,95)===51,
  banked:sum(after,556,93)===0&&sum(after,556,95)===sum(before,556)+newAir&&r?.banked===r?.inheritedBanked+r?.newBanked,
  production:target===20?newAir===0&&raw(after,20)===raw(before,20)&&raw(after,14)===raw(before,14)
   :Number.isSafeInteger(mined)&&mined>0&&Number.isSafeInteger(used)&&used>0&&mined===used+sum(after,1436)
    &&r?.mined===mined&&r?.consumed===used&&r?.crafted===newAir&&newAir>0&&r?.newBanked===newAir,
  otherSkills:after.skills.every((s,i)=>i===14||i===20||s.rawExperience===before.skills[i]!.rawExperience&&s.level===before.skills[i]!.level),
  food:food(after)===food(before)-(r?.travelFoodEaten??0),
  assets:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  life:after.skills[3]!.level>0&&!/"isDead":true|"died":true/.test(run.log),
  outside:target===21||run.log.split(/\r?\n/).some(l=>{try{const o=JSON.parse(l.slice(9));return l.startsWith('AIR_EXIT ')&&o.phase==='outside'&&o.position?.worldX===2983&&o.position?.worldZ===3288&&o.position?.level===0;}catch{return false;}}),
  noPreparation:!r?.stages?.training&&!r?.stages?.food&&!r?.stages?.quest&&!r?.stages?.questExit};
}

export function freshRunePostCraftChecks(before:Save,after:Save,run:Run){
 const r=summary(run),events=run.log.split(/\r?\n/).flatMap(line=>{
  const prefix=line.startsWith('AIR_EXIT ')?'AIR_EXIT':line.startsWith('RUNE_SUPPLY_ACTION ')?'RUNE_SUPPLY_ACTION':null;
  if(!prefix)return [];try{return [{prefix,...JSON.parse(line.slice(prefix.length+1))}];}catch{return [];}
 });
 const craft=events.findIndex(e=>e.prefix==='RUNE_SUPPLY_ACTION'&&e.action==='craft-air'&&e.phase==='end');
 const selected=events.findIndex((e,i)=>i>craft&&e.prefix==='AIR_EXIT'&&e.phase==='selected');
 const exit=events.filter(e=>e.prefix==='AIR_EXIT'),outside=exit.find(e=>e.phase==='outside');
 const a=assets(before),b=assets(after),converted=new Set([1436,556,315,2309,2140]);
 const food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 return {child:run.code===0&&r?.ok===true&&r?.target===20,logout:logout(run),savedResult:freshRuneSavedResult(after,run),
  entry:same(before.position,airRecoveryPositions[0])&&before.vars[63]===6&&before.vars[101]===1&&before.vars[281]===1000
   &&before.skills[20]!.level===19&&before.skills[20]!.rawExperience===POSTCRAFT_XP*10&&sum(before,1436,93)===1&&sum(before,1436)===1
   &&sum(before,556,93)===26&&sum(before,556,95)===25&&[1438,1265,1171].every(id=>sum(before,id)===1),
  quest:after.vars[63]===6&&after.vars[101]===1&&after.vars[281]===1000,
  production:r?.consumed===1&&r?.crafted===2&&r?.mined===0&&r?.stages?.resumedCraft?.ok===true
   &&r?.stages?.resumedCraft?.consumed===1&&r?.stages?.resumedCraft?.runes===2&&r?.stages?.resumedCraft?.xp===125
   &&sum(after,1436)===0&&sum(after,556)-sum(before,556)===2
   &&after.skills[20]!.rawExperience-before.skills[20]!.rawExperience===1250&&after.skills[20]!.level===20,
  banked:r?.inheritedBanked===26&&r?.newBanked===2&&r?.banked===28&&sum(after,556,93)===0&&sum(after,556,95)===53,
  craftThenExit:craft>=0&&selected>craft&&events[selected].tick-events[craft].tick>=0&&events[selected].tick-events[craft].tick<=1
   &&events[craft].essence===0&&events[craft].air===28&&events[craft].runecraftXp===POSTCRAFT_XP+125,
  // The worker (scripts/generated/rcair.ts) records the walk reply on 'approach-dispatched' and records 'approached' with the position alone.
  approach:exit.some(e=>e.phase==='path'&&e.reply?.path?.success===true&&e.reply?.path?.reachedDestination===true)
   &&exit.some(e=>e.phase==='approach-dispatched'&&e.reply?.success===true)
   &&exit.some(e=>e.phase==='approached'&&e.position?.level===0
    &&Math.abs(e.position.worldX-2841)+Math.abs(e.position.worldZ-4828)===1),
  dispatch:exit.some(e=>e.phase==='dispatch'&&e.portal?.id===2465&&e.portal?.x===2841&&e.portal?.z===4828)
   &&exit.some(e=>e.phase==='action'&&e.reply?.success===true),
  outside:outside?.position?.worldX===2983&&outside?.position?.worldZ===3288&&outside?.position?.level===0,
  otherSkills:after.skills.every((sk,i)=>i===20||sk.rawExperience===before.skills[i]!.rawExperience&&sk.level===before.skills[i]!.level),
  food:food(after)===food(before)-(r?.travelFoodEaten??0),
  assets:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  life:after.skills[3]!.level===before.skills[3]!.level&&!/"isDead":true|"died":true/.test(run.log),
  noPreparation:!r?.stages?.training&&!r?.stages?.food&&!r?.stages?.quest&&!r?.stages?.questExit};
}
