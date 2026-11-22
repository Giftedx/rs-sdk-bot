import {DORIC_ORES,FLUFFS_ENTRY,FLUFFS_FENCE_OUT,IMP_BEADS,MINING_GEM_BYPRODUCTS,PICKAXES,type CaseRecord,type Save} from './fixtures';
import {ballAssets,bankCount,carried,elenaAssets,huntAssets,lines,sameAssets,total} from './assets';
import {checkElenaCase,checkScorpionCase} from './checks-special';

export function questSweepChecks(id:string,before:Save,after:Save,log:string,record:CaseRecord){
 const scorpionMelee=id==='scorpion-barcrawl',scorpionRanged=id==='scorpion-ranged-barcrawl',scorpion=scorpionMelee||scorpionRanged,scorpionRefused=id==='scorpion-complete-refusal';
 const blackknight=id==='blackknight-finish',elena=id==='elena-heckel-dust',ball=id==='ball-worn-kit',ballMissing=id==='ball-missing-gloves';
 const doric=id==='doric-self-supply',imp=id==='imp-surplus-beads',fluffs=id==='fluffs-yard-exit';
 const rj=id==='rj-pirate-letter'||id==='rj-pirate-started';
 const hunt=id==='hunt-crowded',success=id==='bank-stage',fishing=id==='fishing-stage',clock=id==='clock-stage',ernest=id==='ernest-fortress',vampire=id==='vampire-started',totem=id==='totem-started-cakes',ghost=id==='retained-ghost'||id==='banked-ghost',banked=id==='banked-ghost',boats=lines(log,'QUEST_SWEEP_BOAT');
 const eaten=Number(log.match(/^RESULT ok .*\beats=(\d+)\b/m)?.[1]??-1);
 const bites1=total(before,1891)-total(after,1891),bites2=total(before,1893)+bites1-total(after,1893),bites3=total(before,1895)+bites2-total(after,1895);
 const checks={
  child:!record.timedOut&&record.exit===(blackknight||elena||ball||rj||success||fishing||clock||ernest||vampire||totem||hunt||ghost||doric?0:1),
  saved:record.saveMatched,
  oneLogin:(log.match(/^START /gm)??[]).length===1,
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(?:logout|session close)/m.test(log),
  alive:after.skills[3]!.level>0&&!/\bdied=true\b|^RESULT fail .*died/m.test(log),
  entryHp:before.skills[3]!.level===(scorpion||scorpionRefused?69:ball||ballMissing?77:elena&&before.position.level===1?99:imp||elena||rj||clock||totem||hunt?40:ernest||vampire?75:ghost?26:fishing?47:10),
  assets:blackknight?sameAssets(before,after,{995:2500}):elena?elenaAssets(before,after):ball?ballAssets(before,after,{1985:-1,2409:1,2411:1,379:-eaten}):hunt?huntAssets(before,after,eaten):sameAssets(before,after,rj?{753:-1}:totem?{995:-90,373:5,1891:-bites1,1893:bites1-bites2,1895:bites2-bites3}:clock?{995:440,1929:-1,1925:1,379:-eaten}:ernest?{995:300,273:-1,275:1,379:-eaten}:vampire?{1917:-1,379:-eaten}:ghost?{553:-1}:fishing?{995:-5,313:-2,1550:-1,27:1}:success?{1759:-20,995:0}:doric?{995:179,1265:1}:{},doric?MINING_GEM_BYPRODUCTS:[]),
  // The Count fight trains Attack (accurate style), Hitpoints, and Strength or Defence on another style.
  unrelatedXp:before.skills.every((s,i)=>(elena||doric)&&i===14||elena&&before.position.level===1&&i===6||success&&i===12||fishing&&i===10||totem&&i===17||ghost&&i===5||(ball||vampire||hunt)&&i<=3||s.rawExperience===after.skills[i]!.rawExperience),
 };
 if(scorpion||scorpionRefused)return checkScorpionCase(id,before,after,log,record,checks,eaten);
 if(imp)return{...checks,
  child:!record.timedOut&&record.exit===0,
  entry:before.position.x===3104&&before.position.z===3163&&before.position.level===2&&(before.vars[160]??0)===0
   &&before.skills.every((s,i)=>s.level===(i===3?40:1))&&IMP_BEADS.every(id=>carried(before,id)>=1&&bankCount(before,id)>=1)
   &&IMP_BEADS.some(id=>carried(before,id)>=2),
  assets:sameAssets(before,after,{1470:-1,1472:-1,1474:-1,1476:-1,1478:1}),
  beads:IMP_BEADS.every(id=>carried(after,id)===carried(before,id)-1&&bankCount(after,id)===bankCount(before,id)),
  unrelatedXp:before.skills.every((s,i)=>i===6||s.rawExperience===after.skills[i]!.rawExperience),
  result:/^RESULT ok qp=1(?: |$)/m.test(log),
  quest:after.vars[160]===2&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Imp Catcher'&&q.state==='complete'),
  reward:carried(after,1478)===carried(before,1478)+1&&bankCount(after,1478)===bankCount(before,1478)
   &&after.skills[6]!.rawExperience-before.skills[6]!.rawExperience===875*10*25,
  location:after.position.level===2&&Math.max(Math.abs(after.position.x-3103),Math.abs(after.position.z-3163))<=4,
 };
 if(fluffs){const exits=lines(log,'QUEST_FLUFFS_YARD_EXIT');return{...checks,
  child:!record.timedOut&&record.exit===0,
  entry:before.position.x===FLUFFS_ENTRY.x&&before.position.z===FLUFFS_ENTRY.z&&before.position.level===FLUFFS_ENTRY.level
   &&before.vars[180]===5&&before.skills[6]!.level===1&&[1927,1552,1554].every(id=>total(before,id)===0),
  resumed:lines(log,'QUEST_SWEEP_FLUFFS_RESUME').length===1&&!/^MILESTONE (?:[1-4]|kitten)(?:\s|$)/m.test(log),
  yardExit:exits.length===1&&exits[0].fence?.id===2618&&exits[0].fence?.x===3305&&exits[0].fence?.z===3493
   &&exits[0].at?.x===FLUFFS_FENCE_OUT.x&&exits[0].at?.z===FLUFFS_FENCE_OUT.z&&exits[0].at?.level===FLUFFS_FENCE_OUT.level,
  budget:eaten===0&&boats.length===0&&!/^QUEST_SWEEP_(?:BANK|WITHDRAW|BUY|FARE) /m.test(log),
  result:/^RESULT ok qp=1(?: |$)/m.test(log),
  quest:after.vars[180]===6&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Gertrude's Cat"&&q.state==='complete'),
  assets:sameAssets(before,after,{1897:1,2003:1}),
  // quest_fluffs.rs2:316 stat_advance(cooking, 15250) at 25x.
  reward:after.skills[7]!.rawExperience-before.skills[7]!.rawExperience===15250*25,
  unrelatedXp:before.skills.every((s,i)=>i===7||s.rawExperience===after.skills[i]!.rawExperience),
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-3151),Math.abs(after.position.z-3410))<=6,
 };}
 if(blackknight)return{...checks,
  entry:before.position.x===3016&&before.position.z===3512&&before.position.level===0&&before.vars[130]===3&&before.skills[6]!.level===1,
  result:/^RESULT ok quest-sweep blackknight quest complete qp=3$/m.test(log),
  quest:after.vars[130]===4&&(after.vars[101]??0)===(before.vars[101]??0)+3,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Black Knight's Fortress"&&q.state==='complete'),
  reward:total(after,995)===total(before,995)+2500,
  skipped:!/^QUEST_SWEEP_(?:BANK|WITHDRAW|BUY|FARE) |^MILESTONE /m.test(log),
  location:after.position.level===2&&Math.max(Math.abs(after.position.x-2960),Math.abs(after.position.z-3336))<=4,
 };
 if(elena)return checkElenaCase(before,after,log,checks,eaten,boats);
 if(ball||ballMissing)return{...checks,
  entry:before.position.x===2947&&before.position.z===3368&&before.position.level===0&&(before.vars[226]??0)===0
   &&!(before.inventories[94]??[]).some(i=>i.id===1059)&&total(before,1059)===(ball?1:0)
   &&(before.inventories[94]??[]).some(i=>i.id===1381)&&total(before,1331)===(ball?1:0),
  result:ball?/^RESULT ok(?: |$)/m.test(log):/^RESULT fail quest-sweep ball missing 995:\d+ to buy 1059 \(required worn kit unavailable\)$/m.test(log),
  worn:ball?[1059,1331].every(id=>lines(log,'QUEST_SWEEP_WORN').some(r=>r.id===id&&r.observed))
   &&(after.inventories[94]??[]).some(i=>i.id===1059&&i.slot===9)&&(after.inventories[94]??[]).some(i=>i.id===1331&&i.slot===3)
   &&(after.inventories[94]??[]).some(i=>i.id===589&&i.slot===2):!/^MILESTONE quest-sweep |^QUEST_SWEEP_WORN /m.test(log),
  staged:!ball||[1059,1331].every(id=>lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===id&&r.count===1&&r.observed)),
  quest:ball?after.vars[226]===7&&(after.vars[101]??0)===(before.vars[101]??0)+4
   :(after.vars[226]??0)===(before.vars[226]??0)&&(after.vars[101]??0)===(before.vars[101]??0),
  questList:!ball||lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Witch's House"&&q.state==='complete'),
  reward:!ball||after.skills[3]!.rawExperience-before.skills[3]!.rawExperience>=1581250,
  budget:!ball||Number.isSafeInteger(eaten)&&eaten>=0&&eaten<=4&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-(ball?2928:2947)),Math.abs(after.position.z-(ball?3456:3368)))<=6,
 };
 if(rj){const started=id==='rj-pirate-started',stage=started?30:0;return{...checks,
  entry:before.position.x===(started?3210:2999)&&before.position.z===(started?3423:3383)&&before.position.level===0
   &&before.skills[6]!.level===1&&before.skills[0]!.level===55&&(before.vars[144]??0)===stage
   &&total(before,433)===1&&total(before,753)===1&&total(before,755)===0&&total(before,756)===0&&total(before,563)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  opening:lines(log,'RJ_STAGE')[0]?.stage===stage&&(!started||!/^MILESTONE (?:20|30)(?:\s|$)/m.test(log)),
  budget:eaten===0&&boats.length===0&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
  quest:after.vars[144]===100&&(after.vars[101]??0)===(before.vars[101]??0)+5,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Romeo & Juliet'&&q.state==='complete'),
  pirateMessage:total(after,433)===1,
  questItems:[753,755,756].every(id=>total(after,id)===0),
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-3211),Math.abs(after.position.z-3425))<=6,
 };}
 if(hunt)return{...checks,
  entry:before.position.x===2907&&before.position.z===3147&&before.position.level===0&&before.skills[6]!.level===1&&before.skills[0]!.level===55
   &&(before.vars[71]??0)===0&&(before.inventories[93]??[]).length===28&&total(before,1963)===7&&total(before,952)===1&&total(before,563)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  capacity:lines(log,'QUEST_SWEEP_BANK_PASS').some(r=>r.slots>=12&&r.free>=r.slots)
   &&lines(log,'QUEST_SWEEP_CAPACITY').some(r=>r.required>=1&&r.free>=r.required),
  bananas:lines(log,'QUEST_SWEEP_DEPOSIT').some(r=>r.id===1963&&r.count===7&&r.success)
   &&!lines(log,'QUEST_SWEEP_BUY').some(r=>r.item===1963)
   &&['job','karamja','rum','bananas','shipped','sarim','rum back'].reduce((at,step)=>{
    const next=log.indexOf(`MILESTONE ${step} `,at);return at<0||next<0?-1:next+1;
   },0)>0,
  bought:lines(log,'QUEST_SWEEP_BUY').some(r=>r.item===1005&&r.npc==='Thessalia'&&r.count===1&&r.before===0&&r.after===1&&r.coinsBefore-r.coins===2),
  budget:Number.isSafeInteger(eaten)&&eaten>=0&&eaten<=24&&boats.length===0&&!/^QUEST_SWEEP_FARE /m.test(log),
  quest:after.vars[71]===4&&(after.vars[101]??0)===(before.vars[101]??0)+2,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Pirate's Treasure"&&q.state==='complete'),
  reward:total(after,1635)===total(before,1635)+1&&total(after,1605)===total(before,1605)+1,
  questItems:[431,432].every(id=>total(after,id)===0)&&total(after,433)===1
   &&total(after,1963)===7&&(after.inventories[93]??[]).every(i=>i.id!==1963)
   &&(after.inventories[95]??[]).filter(i=>i.id===1963).reduce((n,i)=>n+i.count,0)===7,
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-2999),Math.abs(after.position.z-3383))<=6,
 };
 if(totem){const fares=lines(log,'TOTEM_BOAT');return{...checks,
  entry:before.position.x===2571&&before.position.z===3250&&before.position.level===0&&before.skills[6]!.level===1&&before.skills[17]!.level===99&&before.vars[200]===1&&total(before,563)===0&&total(before,995)===184304
   &&total(before,1891)===15&&total(before,1893)===1&&total(before,1895)===2,
  result:/^RESULT ok(?: |$)/m.test(log),
  opening:lines(log,'TOTEM_STAGE')[0]?.stage===1&&!/^MILESTONE 1(?:\s|$)/m.test(log)&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
  food:[bites1,bites2,bites3].every(n=>Number.isSafeInteger(n)&&n>=0)&&bites1<=8&&bites2<=bites1+1&&bites3<=bites2+2&&bites1+bites2+bites3===eaten,
  staged:[[1891,8],[1893,1],[1895,2]].every(([id,count])=>lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===id&&r.count===count&&r.observed)),
  budget:fares.length===2&&fares[0].id==='npc:customs_officer:ardougne@2772,3231'&&fares[1].id==='npc:captain_barnaby:brimhaven@2679,3275'&&fares.every(r=>r.coins===30&&r.before-r.after===30)&&/^TOTEM_TELEPORT_REFUSED Magic 1 < 51$/m.test(log),
  quest:after.vars[200]===5&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Tribal Totem'&&q.state==='complete'),
  reward:after.skills[17]!.rawExperience===before.skills[17]!.rawExperience+443750&&total(after,373)===total(before,373)+5,
  questItems:total(after,1857)===0&&total(after,1858)===0,
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-2791),Math.abs(after.position.z-3182))<=6,
 };}
 // Mightyrod's live entry: Vampire Slayer started (%vampire 1), Magic 1 with law runes, so both Varrock trips walk.
 if(vampire){const attack=after.skills[0]!.rawExperience-before.skills[0]!.rawExperience;return{...checks,
  entry:before.position.x===3097&&before.position.z===3267&&before.position.level===0&&before.skills[6]!.level===1&&before.vars[178]===1
   &&[1917,2347,1550].every(id=>total(before,id)===1)&&total(before,563)>=1&&total(before,1549)===0&&(before.inventories[94]??[]).some(i=>i.id===2402),
  result:/^RESULT ok(?: |$)/m.test(log),
  opening:(log.match(/^MILESTONE 1(?:\s|$)/gm)??[]).length===0&&/^MILESTONE stake /m.test(log)&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log)&&boats.length===0,
  budget:eaten>=0&&eaten<=6&&total(before,563)===total(after,563),
  quest:after.vars[178]===3&&(after.vars[101]??0)===(before.vars[101]??0)+3,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Vampire Slayer'&&q.state==='complete'),
  // quest_vampire.rs2 grants 48,250 raw tenths, or 1,206,250 at 25x.
  // Count's combat_xp_multiplier=100: combat.rs2 accurate hits grant (damage*10)*4*100/1000*25 = damage*100 raw tenths.
  reward:attack>=1206250&&(attack-1206250)%100===0,
  stake:total(after,1549)===0,
  location:after.position.level===0&&after.position.z>9000&&Math.max(Math.abs(after.position.x-3078),Math.abs(after.position.z-9774))<=6,
 };}
 if(clock)return{...checks,
  entry:before.position.x===3239&&before.position.z===3275&&before.position.level===0&&before.skills[6]!.level===1&&total(before,563)===0&&(before.vars[10]??0)===0&&(before.inventories[93]??[]).some(i=>i.id===1929&&i.count===1),
  result:/^RESULT ok(?: |$)/m.test(log),
  budget:eaten>=0&&eaten<=4&&boats.length===2&&boats[0].id==='npc:captain_tobias:karamja-musa-point@3028,3216'&&boats[1].id==='npc:customs_officer:ardougne@2772,3231'&&boats.every(r=>r.coins===30)&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
  quest:((after.vars[10]??0)&15)===8&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Clock Tower'&&q.state==='complete'),
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-2569),Math.abs(after.position.z-3249))<=6,
 };
 // Mightyrod's failed entry: the fortress box room on level 1, whose only exit is the secret wall. The bank holds no
 // fish food, so it comes from its only spawn upstairs in Draynor Manor.
 if(ernest){const fort=lines(log,'QUEST_SWEEP_FORTRESS'),manor=lines(log,'QUEST_SWEEP_MANOR');return{...checks,
  entry:before.position.x===3029&&before.position.z===3505&&before.position.level===1&&before.skills[3]!.level===75&&before.skills[6]!.level===1&&(before.vars[32]??0)===0&&total(before,272)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  exit:['secret wall','hall ladder','front'].every(step=>fort.some(r=>r.step===step&&r.ok))&&fort.every(r=>r.ok)&&!/^QUEST_SWEEP_BANK_WALK .*"level":1\b/m.test(log)
   &&manor.every(r=>r.ok)&&manor.some(r=>r.step==='pickup'&&r.before===0&&r.after===1&&/^310[7-9],335[5-7],1$/.test(r.at))&&manor.some(r=>r.step==='back door'),
  budget:eaten>=0&&eaten<=4&&boats.length===0&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
  quest:after.vars[32]===3&&(after.vars[101]??0)===(before.vars[101]??0)+4,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Ernest the Chicken'&&q.state==='complete'),
  location:after.position.level===2&&Math.max(Math.abs(after.position.x-3110),Math.abs(after.position.z-3367))<=6,
 };}
 if(ghost)return{...checks,
  entry:before.position.x===(banked?3094:3113)&&before.position.z===(banked?3491:9555)&&before.position.level===0&&before.vars[107]===4&&total(before,553)===1&&(before.inventories[94]??[]).some(i=>i.id===552)&&before.skills[6]!.level===1&&total(before,563)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  retained:lines(log,'QUEST_SWEEP_RETAINED_SKULL').length===1&&lines(log,'GHOST_RETAINED_SKULL').length===1&&!/^MILESTONE [1-4](?:\s|$)/m.test(log),
  bankedSkull:!banked||(before.inventories[95]??[]).some(i=>i.id===553&&i.count===1)&&lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===553&&r.count===1&&r.before===0&&r.after===1&&r.bankBefore===1&&r.bankAfter===0&&r.observed),
  quest:after.vars[107]===5&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='The Restless Ghost'&&q.state==='complete'),
  reward:after.skills[5]!.rawExperience===before.skills[5]!.rawExperience+281250,
  skull:total(after,553)===0,
  amulet:(after.inventories[94]??[]).some(i=>i.id===552),
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-3249),Math.abs(after.position.z-3192))<=6,
 };
 if(fishing)return{...checks,
  entry:before.position.x===2615&&before.position.z===3332&&before.position.level===0&&before.skills[10]!.level===20&&before.skills[6]!.level===1&&(before.vars[11]??0)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  approach:lines(log,'QUEST_SWEEP_DWARF').some(r=>r.observed&&r.at.level===0&&Math.max(Math.abs(r.at.x-2820),Math.abs(r.at.z-3487))<=3),
  withdrawn:[[952,1],[307,1],[313,2],[1550,1],[556,5]].every(([id,count])=>lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===id&&r.count===count&&r.before===0&&r.after===count&&r.bankBefore===count&&r.bankAfter===0&&r.observed)),
  budget:boats.length===0&&total(before,995)-total(after,995)===5&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
  // fishingcompo_complete=5 also admits the mountain tunnel in quest_fishingcompo.rs2.
  quest:after.vars[11]===5&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Fishing Contest'&&q.state==='complete'),
  tools:[952,307,556].every(id=>total(after,id)===total(before,id))&&total(after,952)===1&&total(after,307)===1,
  reward:after.skills[10]!.xp===before.skills[10]!.xp+60925,
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-2820),Math.abs(after.position.z-3487))<=6,
 };
 if(success)return{...checks,
  entry:before.position.x===2459&&before.position.z===3385&&before.position.level===0&&total(before,1759)===20&&(before.vars[179]??0)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  gate:lines(log,'QUEST_SWEEP_GATE').some(r=>r.ok&&r.at.x===2461&&r.at.z===3382&&r.at.level===0),
  withdrawn:lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===1759&&r.count===20&&r.before===0&&r.after===20&&r.bankBefore===20&&r.bankAfter===0&&r.observed),
  boats:boats.length===2&&boats[0].id==='npc:captain_barnaby:brimhaven@2679,3275'&&boats[1].id==='npc:customs_officer:port-sarim@2953,3147'&&boats.every(r=>r.coins===30),
  // sheep_complete debits the last of 20 wool, gives 60 coins and one QP. Two boat fares cost 60 coins.
  quest:after.vars[179]===22&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Sheep Shearer'&&q.state==='complete'),
  wool:total(after,1759)===total(before,1759)-20,
  reward:after.skills[12]!.xp===before.skills[12]!.xp+3750,
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-3189),Math.abs(after.position.z-3273))<=6,
 };
 const doricEntry=before.position.x===2965&&before.position.z===3380&&before.position.level===0&&before.skills[14]!.level===1&&(before.vars[31]??0)===0
  &&[...PICKAXES,...DORIC_ORES.map(o=>o.id)].every(id=>total(before,id)===0&&!(before.inventories[94]??[]).some(i=>i.id===id))&&total(before,995)===(doric?362:0);
 if(doric){const plan=lines(log,'QUEST_SWEEP_SHOP_PLAN'),gathered=lines(log,'QUEST_SWEEP_GATHER'),buys=lines(log,'QUEST_SWEEP_BUY');return{...checks,
  entry:doricEntry,
  result:/^RESULT ok qp=1(?: |$)/m.test(log),
  // The installed route buys one bronze pickaxe for exactly one coin.
  bought:buys.length===1&&buys[0].item===1265&&buys[0].count===1&&buys[0].before===0&&buys[0].after===1
   &&plan.length===1&&plan[0].buys?.length===1&&plan[0].buys[0].id===1265&&plan[0].coins===103&&buys[0].coinsBefore-buys[0].coins===1,
  gathered:gathered.length===3&&DORIC_ORES.every(o=>gathered.filter(r=>r.item===o.id).length===1&&gathered.some(r=>r.item===o.id&&r.how==='mine'&&r.count===o.count&&r.held===o.count&&r.target===o.count)),
  used:/^MILESTONE quest-sweep doric staged at /m.test(log)&&/You hand the Clay, Copper and Iron to Doric\./.test(log)&&DORIC_ORES.every(o=>total(after,o.id)===0),
  budget:eaten===0&&boats.length===0&&!/^QUEST_SWEEP_FARE /m.test(log),
  quest:after.vars[31]===100&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Doric's Quest"&&q.state==='complete'),
  reward:after.skills[14]!.rawExperience-before.skills[14]!.rawExperience===367500,
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-2951),Math.abs(after.position.z-3450))<=6,
 };}
 if(id!=='doric-no-cash')throw Error(`unknown quest-sweep proof case ${id}`);
 return{...checks,
  entry:doricEntry,
  result:/^RESULT fail quest-sweep doric missing 995:103 to buy 1265\s*$/m.test(log),
  noQuestTravel:!/^MILESTONE |^QUEST_SWEEP_(?:BUY|FARE|GATHER|MINE|WITHDRAW|SHOP_PLAN) /m.test(log)&&boats.length===0,
  questUnchanged:(after.vars[31]??0)===(before.vars[31]??0)&&(after.vars[101]??0)===(before.vars[101]??0),
  atBank:after.position.level===0&&Math.max(Math.abs(after.position.x-2947),Math.abs(after.position.z-3368))<=3,
 };
}
