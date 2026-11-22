import {ELENA_COINS,ELENA_DUST_DOWN,ELENA_DUST_ENTRY,ELENA_DUST_FUNDS,SCORPION_COMPLETE,SCORPION_MELEE_BANK,SCORPION_RANGED_BANK,SCORPION_STRENGTH,SCORPION_TRAINED,type CaseRecord,type Save} from './fixtures';
import {bankCount,carried,lines,sameAssets,scorpionAssets,scorpionPotionLedger,total} from './assets';

type BaseQuestChecks={
 child:boolean;
 saved:boolean;
 oneLogin:boolean;
 logout:boolean;
 alive:boolean;
 entryHp:boolean;
 assets:boolean;
 unrelatedXp:boolean;
};

export function checkScorpionCase(id:string,before:Save,after:Save,log:string,record:CaseRecord,checks:BaseQuestChecks,eaten:number){
 const scorpionMelee=id==='scorpion-barcrawl',scorpionRanged=id==='scorpion-ranged-barcrawl',scorpionRefused=id==='scorpion-complete-refusal';
 const entry=(scorpionMelee?before.position.x===2655&&before.position.z===3283:before.position.x===3185&&before.position.z===3436)&&before.position.level===0;
 if(scorpionRefused)return{...checks,child:!record.timedOut&&record.exit===1,entry:entry&&before.vars[76]===SCORPION_COMPLETE,
  result:/^RESULT fail quest-sweep scorpion invalid entry: Scorpion Catcher is complete$/m.test(log),
  noInput:!/^QUEST_SWEEP_(?:BANK|BANK_WALK|BANK_PASS|KIT|WITHDRAW|BUY|FARE|TRAVEL_COST|GATHER|GATHER_PLAN|MINE|SHOP_PLAN) |^MILESTONE |^SCORP_ANTIPOISON /m.test(log),
  quest:after.vars[76]===before.vars[76]&&(after.vars[101]??0)===(before.vars[101]??0),assets:sameAssets(before,after,{}),
  unrelatedXp:before.skills.every((s,i)=>s.rawExperience===after.skills[i]!.rawExperience),
 };
 // The bank pass withdraws Barcrawl's 3 Law runes and then Scorpion's 5: eight staged runes in observed steps.
 const laws=lines(log,'QUEST_SWEEP_WITHDRAW').filter(r=>r.id===563);
 const strength=after.skills[2]!.rawExperience-before.skills[2]!.rawExperience;
 const weapon=scorpionMelee?1333:861,jailer=lines(log,'SCORP_JAILER'),bank=scorpionMelee?SCORPION_MELEE_BANK:SCORPION_RANGED_BANK;
 const potion=scorpionPotionLedger(before,log),antipoison=lines(log,'QUEST_SWEEP_WITHDRAW').filter(r=>r.id===175);
 // These complete fixture inventories contain the declared supplies and worn gear only. In the melee case
 // there is no bow, ammunition, strike rune or staff in any container that could provide another combat method.
 const kitItems=new Set([...bank.map(i=>i.id),1169,552,weapon,1131,1097,1063]);
 return{...checks,child:!record.timedOut&&record.exit===0,entry:entry&&(before.vars[76]??0)===0&&(before.vars[77]??0)!==2&&(before.vars[102]??0)===0,
  kit:bank.every(i=>total(before,i.id)===i.count)
   &&Object.values(before.inventories).flatMap(rows=>rows??[]).every(i=>kitItems.has(i.id))
   &&(before.inventories[94]??[]).some(i=>i.slot===3&&i.id===weapon&&i.count===1)
   &&(after.inventories[94]??[]).some(i=>i.slot===3&&i.id===weapon&&i.count===1)
   &&(!scorpionRanged||total(before,882)===40),
  staged:laws.length>0&&laws.every(r=>r.observed&&r.after-r.before===r.count)&&laws[0].before===0
   &&laws.reduce((n,r)=>n+r.count,0)===8&&laws.at(-1).after===8,
  antipoison:potion.ok&&(scorpionMelee?potion.bought===1&&antipoison.length===0:potion.bought===0&&potion.travelCoins===0
   &&antipoison.length===1&&antipoison[0].count===1&&antipoison[0].before===0&&antipoison[0].after===1
   &&antipoison[0].bankBefore===1&&antipoison[0].bankAfter===0&&antipoison[0].observed===true),
  jailer:jailer.length===1&&jailer[0].ok===true
   &&JSON.stringify(jailer[0].methods)===JSON.stringify([scorpionMelee?'melee':'ranged'])
   &&total(before,1591)===0&&total(after,1591)===1&&/^MILESTONE jail key /m.test(log),
  combatXp:scorpionMelee?after.skills[4]!.rawExperience===before.skills[4]!.rawExperience
   &&(after.skills[0]!.rawExperience>before.skills[0]!.rawExperience||after.skills[1]!.rawExperience>before.skills[1]!.rawExperience||strength>SCORPION_STRENGTH)
   :after.skills[4]!.rawExperience>before.skills[4]!.rawExperience,
  barcrawl:after.vars[77]===2&&/^MILESTONE complete /m.test(log),
  outpost:/^MILESTONE scorpion b /m.test(log),catches:['a','b','c'].every(k=>new RegExp(`^MILESTONE scorpion ${k} `,'m').test(log)),result:/^RESULT ok qp=1(?: |$)/m.test(log),
  quest:after.vars[76]===SCORPION_COMPLETE&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Scorpion Catcher'&&q.state==='complete'),
  assets:scorpionAssets(before,after,eaten,log),
  // quest_scorpcatcher.rs2 stat_advance(strength, 66250) at 25x. A melee Jailer fight can add Strength XP.
  reward:strength>=SCORPION_STRENGTH,
  // The Jailer fight trains combat skills and Hitpoints; the teleports train Magic. Other skills keep their XP.
  unrelatedXp:before.skills.every((s,i)=>SCORPION_TRAINED.includes(i)?after.skills[i]!.rawExperience>=s.rawExperience:s.rawExperience===after.skills[i]!.rawExperience),
 };
}

export function checkElenaCase(before:Save,after:Save,log:string,checks:BaseQuestChecks,eaten:number,boats:any[]){
 const dust=lines(log,'QUEST_SWEEP_HECKEL'),approaches=lines(log,'QUEST_SWEEP_HECKEL_APPROACH'),buys=lines(log,'QUEST_SWEEP_BUY');
 const exact=(p:any,to:{x:number;z:number;level:number})=>p?.x===to.x&&p?.z===to.z&&p?.level===to.level;
 const near=(p:any,to:{x:number;z:number;level:number},tol:number)=>p?.level===to.level&&Number.isSafeInteger(p.x)&&Number.isSafeInteger(p.z)
  &&Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))<=tol;
 const approach=approaches[0],south={x:2461,z:3382,level:0},upstairs=exact(before.position,ELENA_DUST_ENTRY);
 const downs=lines(log,'QUEST_SWEEP_DOWN'),exits=lines(log,'QUEST_SWEEP_TREE_EXIT'),gates=lines(log,'QUEST_SWEEP_GATE');
 const treeExit=exits.length===1&&exits[0].ok===true&&exact(exits[0].at,{x:2466,z:3491,level:0});
 const common={...checks,
  bought:dust.length===1&&dust[0].item===1975&&dust[0].before===0&&dust[0].after===1&&dust[0].coinsBefore-dust[0].coins===2&&dust[0].observed===true,
  result:/^RESULT ok(?: |$)/m.test(log),
  quest:after.vars[165]===29&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Plague City'&&q.state==='complete'),
  reward:after.skills[14]!.rawExperience-before.skills[14]!.rawExperience===606250,
 };
 const entryInputs=[1925,1975].every(id=>total(before,id)===0)&&[2126,952,954,1927,231].every(id=>carried(before,id)===1)
  &&(before.vars[165]??0)===0&&before.skills[6]!.level===(upstairs?99:1);
 const approached=approaches.length===1&&exact(approach.to,south)&&exact(approach.at,south)&&approach.observed===true;
 if(upstairs){
  const banks=lines(log,'QUEST_SWEEP_BANK'),done=lines(log,'QUEST_SWEEP_BANK_DONE'),withdraw=lines(log,'QUEST_SWEEP_WITHDRAW');
  const bankWalk=lines(log,'QUEST_SWEEP_BANK_WALK').find(r=>r.outcome?.ok===true);
  const spells=lines(log,'QUEST_SWEEP_SPELL'),spell=spells[0];
  const gate=lines(log,'AGILITY_ENTRY_GATE'),ground={x:2493,z:3488,level:0};
  const arrival=lines(log,'QUEST_SWEEP_CORRIDOR').find(r=>r.to?.x===ground.x&&r.to?.z===ground.z&&r.ok===true);
  const staged=lines(log,'MILESTONE quest-sweep elena staged at');
  const phase=(prefix:string,row:any)=>row?log.indexOf(prefix+' '+JSON.stringify(row)):-1;
  const order=[phase('QUEST_SWEEP_DOWN',downs[0]),phase('QUEST_SWEEP_BANK',banks[0]),phase('QUEST_SWEEP_BANK_DONE',done[0]),
   phase('QUEST_SWEEP_HECKEL_APPROACH',approach),phase('AGILITY_ENTRY_GATE',gate[0]),phase('QUEST_SWEEP_CORRIDOR',arrival),
   phase('QUEST_SWEEP_HECKEL',dust[0]),phase('QUEST_SWEEP_TREE_EXIT',exits[0]),phase('QUEST_SWEEP_GATE',gates[0]),
   phase('MILESTONE quest-sweep elena staged at',staged[0])];
  return{...common,
   entry:entryInputs&&/^START 2529 3162 1$/m.test(log)&&carried(before,1929)===0&&bankCount(before,1929)===4
    &&ELENA_DUST_FUNDS.every(i=>carried(before,i.id)===i.count)&&bankCount(before,995)===1680
    &&[0,1,2,3,4,5,6].every(i=>before.skills[i]!.level===99),
   descent:downs.length===1&&exact(downs[0].from,ELENA_DUST_ENTRY)&&exact(downs[0].to,ELENA_DUST_DOWN)
    &&near(banks[0]?.from,ELENA_DUST_DOWN,2)&&bankWalk?.at?.level===0,
   approach:approached&&done.length===1&&done[0].at?.level===0&&exact(approach.from,done[0].at),
   gate:gate.length===1&&gate[0].at==='2461,3385,0',
   ground:!!arrival&&near(arrival.at,ground,2)&&Number.isSafeInteger(arrival.try)&&arrival.try>=1&&arrival.try<=3,
   route:order.every((n,i)=>n>=0&&(i===0||n>order[i-1]!)),
   treeExit,
   staged:withdraw.length===1&&withdraw[0].id===1929&&withdraw[0].count===4&&withdraw[0].before===0&&withdraw[0].after===4
    &&withdraw[0].bankBefore===4&&withdraw[0].bankAfter===0&&withdraw[0].observed===true&&bankCount(after,995)===bankCount(before,995)
    &&done[0]?.buys?.length===0&&done[0]?.gathers?.length===0
    &&gates.length===1&&gates[0].ok===true&&exact(gates[0].at,south)&&staged.length===1&&near(staged[0],{x:2569,z:3333,level:0},3),
   // Falador's one cast costs 1 Law, 3 Air and 1 Water rune and 480 raw XP before the proof's 25x multiplier.
   travel:spells.length===1&&spell.planned===true&&spell.spell==='Falador teleport'&&!!banks[0]&&!!bankWalk
    &&exact(spell.from,banks[0].from)&&exact(spell.to,banks[0].to)&&exact(bankWalk.to,banks[0].to)
    &&phase('QUEST_SWEEP_BANK',banks[0])<phase('QUEST_SWEEP_SPELL',spell)
    &&phase('QUEST_SWEEP_SPELL',spell)<phase('QUEST_SWEEP_BANK_WALK',bankWalk)
    &&after.skills[6]!.rawExperience-before.skills[6]!.rawExperience===480*25,
   budget:eaten===0&&boats.length===0&&buys.length===0&&!/^QUEST_SWEEP_(?:FARE|GATHER|USE) /m.test(log)
    &&dust.length===1&&dust[0].coinsBefore===82904&&dust[0].coins===82902,
  };
 }
 // Normal acquisition may finish its bucket shopping on either floor. Its descent belongs to that seller leg,
 // not to START. Gathering water after Heckel also proves arrival outside the tree before quest handover.
 const water=lines(log,'QUEST_SWEEP_USE').filter(r=>r.item===1929);
 const gathered=water.length===4&&water.every((r,i)=>r.held===i+1&&r.target===4&&near(r.at,{x:2639,z:3369,level:0},1));
 return{...common,
  entry:entryInputs&&exact(before.position,{x:2615,z:3332,level:0})&&total(before,1929)===0&&total(before,995)===ELENA_COINS,
  descent:approach?.from?.level===0?downs.length===0:downs.some(r=>exact(r.from,ELENA_DUST_ENTRY)&&exact(r.to,ELENA_DUST_DOWN)),
  approach:approaches.length===1&&(approach.from?.level===0||exact(approach.from,ELENA_DUST_ENTRY))&&exact(approach.to,south)
   &&near(approach.at,south,1)&&approach.observed===true,
  treeExit:exits.length?treeExit:gathered,
  staged:/^MILESTONE quest-sweep elena staged at /m.test(log)&&(gathered||gates.some(r=>r.ok)),
  budget:boats.length===0&&!/^QUEST_SWEEP_FARE /m.test(log)&&buys.length>0&&buys.every(r=>r.item===1925
   &&Number.isSafeInteger(r.after-r.before)&&r.after>=r.before&&r.coinsBefore-r.coins===2*(r.after-r.before))
   &&buys.reduce((n,r)=>n+r.after-r.before,0)===4&&buys.at(-1).after>buys.at(-1).before
   &&(approach?.from?.level!==1||buys.at(-1).npc==='Bolkoy'),
 };
}
