// Quest sweep: run one generated quest (scripts/generated/quest-<quest>.ts) on an ordinary account from wherever it
// stands. The quest's practice preset names its start tile and pack. This runner takes the missing pack items from the
// nearest bank, walks to the start tile and hands its session to the quest script, which owns the quest, the RESULT
// line and the logout. A missing item ends the run before travel with `missing id:count` (acquisition work).
// Usage: bun scripts/quest-sweep.ts <account> <quest>      e.g. bun scripts/quest-sweep.ts Mightyrod blackknight
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo} from '../packages/core/src/walk';
import {PRESETS,type SaveConfig} from '../packages/practice/src/presets';
import travel from '../packages/planner/src/haggis-travel.json';

type Item={id:number;count:number};
type Tile={x:number;z:number;level:number};
const BANKS:Tile[]=Object.values((travel as unknown as {banks:Record<string,Tile>}).banks);

export function presetFor(quest:string):SaveConfig&{position:Tile}{
 const p=PRESETS['quest_'+quest];
 if(!p?.position)throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
 return{...p,position:{level:0,...p.position},...(quest==='hazeelcult'?{inventory:[{id:385,count:4}]}:{})};
}
// Preset food (lobster, shark) only feeds the quest's eat-at threshold, and teleport runes (fire, water, air, earth,
// law) only save walking (quest-lib teleport walks without a law rune): the runner takes what the bank holds of both.
export const FOOD=new Set([379,385,554,555,556,557,563]),COINS=995;
export function needs(preset:SaveConfig,food=false):Map<number,number>{
 const m=new Map<number,number>();
 for(const i of preset.inventory??[])if(FOOD.has(i.id)===food)m.set(i.id,(m.get(i.id)??0)+i.count);
 if(!food&&preset.coins)m.set(COINS,(m.get(COINS)??0)+preset.coins);
 return m;
}
const count=(rows:readonly Item[],id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0);
// What the pack still lacks, and what the bank cannot cover.
export function plan(need:ReadonlyMap<number,number>,pack:readonly Item[],bank:readonly Item[]){
 const withdraw:Item[]=[],missing:Item[]=[];
 for(const [id,n] of need){
  const lack=n-count(pack,id);if(lack<=0)continue;
  const take=Math.min(lack,count(bank,id));
  if(take>0)withdraw.push({id,count:take});
  if(take<lack)missing.push({id,count:lack-take});
 }
 return{withdraw,missing};
}
export function nearestBank(at:Tile):Tile{
 return BANKS.filter(b=>b.level===at.level).sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z)))[0]??BANKS[0]!;
}

async function main(){
 const [account,quest]=process.argv.slice(2);
 if(!account||!quest)throw Error('usage: bun scripts/quest-sweep.ts <account> <quest>');
 const script=resolve(import.meta.dir,'generated',`quest-${quest}.ts`);
 if(!existsSync(script))throw Error(`quest sweep: no script ${script}`);
 const preset=presetFor(quest),need=needs(preset),food=needs(preset,true);
 const s:Session=await openBot(account);
 const fail=(why:string)=>finish([s],false,`quest-sweep ${quest} ${why}`);
 let handed=false;
 try {
 const st=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!st()?.player,{timeoutTicks:20}))return fail('entry state unavailable');
 const here=():Tile=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:{x:0,z:0,level:-1};};
 const world=await getWorld();
 // The world walker plans from the ground floor: an account left upstairs (Hazeel Cult ends there) climbs down first.
 for(let i=0;i<3&&(st()?.player?.level??0)>0;i++){
  const down=(st()?.nearbyLocs??[]).filter((l:any)=>(l.optionsWithIndex??[]).some((o:any)=>/climb-down/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
  if(!down)return fail(`no way down from level ${st()?.player?.level}`);
  const level=st()?.player?.level??0,op=down.optionsWithIndex.find((o:any)=>/climb-down/i.test(o.text))?.opIndex??1;
  await s.direct({type:'interactLoc',x:down.x,z:down.z,locId:down.id,optionIndex:op,reason:'SDK'});
  await waitUntil(s,()=>(st()?.player?.level??level)<level,{timeoutTicks:30});
 }
 const pack=():Item[]=>(st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count}));
 if(plan(need,pack(),[]).missing.length||plan(food,pack(),[]).missing.length){
  const bank=nearestBank(here());
  const walked=await goTo(s,world,bank,accountOf(s),{legTimeoutTicks:100});
  if(!walked.ok)return fail(`bank walk failed at ${JSON.stringify(here())}`);
  const opened=await s.bot.openBank();
  if(!opened.success)return fail('bank did not open');
  await waitUntil(s,()=>(st()?.bank?.items?.length??0)>0,{timeoutTicks:10});
  const rows=():Item[]=>(st()?.bank?.items??[]).map((i:any)=>({id:i.id,count:i.count}));
  const p=plan(need,pack(),rows()),meal=plan(food,pack(),rows()).withdraw;
  p.withdraw.push(...meal);
  if(p.missing.length){await s.bot.closeBank();return fail('missing '+p.missing.map(i=>`${i.id}:${i.count}`).join(','));}
  // Free the slots the withdrawals need: bank every pack item the quest does not use.
  const slots=p.withdraw.reduce((n,i)=>n+i.count,0);
  if(28-(st()?.inventory?.length??0)<slots)for(const i of [...(st()?.inventory??[])])if(!need.has(i.id))await s.bot.depositItem(i,-1);
  for(const w of p.withdraw){
   const row=(st()?.bank?.items??[]).find((i:any)=>i.id===w.id);
   const before=count(pack(),w.id);
   if(!row)return fail(`bank row ${w.id} vanished`);
   await s.bot.withdrawItem(row,w.count);
   await waitUntil(s,()=>count(pack(),w.id)>=before+w.count,{timeoutTicks:5});
  }
  await s.bot.closeBank();
  const left=plan(need,pack(),[]).missing;
  if(left.length)return fail('withdraw short '+left.map(i=>`${i.id}:${i.count}`).join(','));
 }
 const start=preset.position;
 const there=await goTo(s,world,start,accountOf(s),{legTimeoutTicks:100});
 if(!there.ok)return fail(`start walk failed at ${JSON.stringify(here())} to ${JSON.stringify(start)}`);
 console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
 (globalThis as {QUEST_SESSION?:Session}).QUEST_SESSION=s;
 handed=true;
 await import(script);
 } catch(error) {
  if(handed)throw error;
  return fail(String(error));
 }
}

if(import.meta.main)await main();
