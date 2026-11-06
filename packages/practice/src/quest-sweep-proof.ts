// Harness only: real quest-sweep CLI, then saved quest flags, asset deltas and confirmed logout.
import {openSync,writeFileSync,rmSync,closeSync,mkdirSync,readFileSync,copyFileSync,existsSync,statSync,statfsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startStack,type StackOptions} from './stack';
import {canBind} from './ports';
import {rsSdkRoot} from './paths';
import {applyPreset} from './presets';
import {createBot} from './bots';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {PRACTICE_STARTUP_GB,FREE_FLOOR_GB} from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
type CaseRecord={id:string;exit:number;timedOut:boolean;saveMatched:boolean;seconds:number};
const root=resolve(import.meta.dir,'../../..');
export function questSweepProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
 if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
  ||new Set(values).size!==4||!/^quest-sweep-[a-z0-9]{20}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
  WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof questSweepProofEndpoints>;
export function selectQuestSweepProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
  if(Object.values(ports).every(bind))return questSweepProofEndpoints(ports,'quest-sweep-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}
export function questSweepProofAccountEnv(text:string,p:ProofEndpoints){
 const servers=text.match(/^SERVER=.*$/gm)??[],gateways=text.match(/^GATEWAY_URL=.*$/gm)??[];
 if(servers.length!==1||!/^SERVER=localhost(?::8888)?\r?$/.test(servers[0]!)
  ||gateways.length>1||gateways.some(line=>!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/.test(line)))throw Error('new practice account required');
 const local=text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`);
 return gateways.length?local.replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`):`${local.trimEnd()}\nGATEWAY_URL=${p.gateway}\n`;
}
export async function startQuestSweepProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:150,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
export function questSweepChildConfiguration(name:string,quest:string,p:ProofEndpoints,inherited:NodeJS.ProcessEnv=process.env){
 return{cmd:['bun','scripts/quest-sweep.ts',name,quest],cwd:root,windowsHide:true,
  env:{...inherited,...p.env,GATEWAY_URL:p.gateway,QUEST_SWEEP_OBSERVE_BANK:'',RANDOM_EVENTS:'0'}};
}
const lines=(log:string,prefix:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(prefix+' ')).map(l=>JSON.parse(l.slice(prefix.length+1)));
const total=(s:Save,id:number)=>[93,95].reduce((n,t)=>n+(s.inventories[t]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
// The server writes an empty worn row (94) on first logout; an empty row and an absent row hold the same items.
export const equipment=(s:Pick<Save,'inventories'>)=>JSON.stringify(Object.entries(s.inventories)
 .filter(([k,rows])=>!['93','95'].includes(k)&&(rows??[]).length).sort(([a],[b])=>Number(a)-Number(b))
 .map(([k,rows])=>[k,[...rows!].sort((a,b)=>a.slot-b.slot).map(i=>[i.slot,i.id,i.count])]));
const sameAssets=(a:Save,b:Save,cost:Record<number,number>)=>{
 const ids=new Set([...Object.keys(cost).map(Number),...[a,b].flatMap(s=>[93,95].flatMap(t=>(s.inventories[t]??[]).map(i=>i.id)))]);
 return [...ids].every(id=>total(b,id)===total(a,id)+(cost[id]??0))&&equipment(a)===equipment(b);
};
function ballAssets(before:Save,after:Save,cost:Record<number,number>){
 const normalize=(s:Save)=>{
  const copy=structuredClone(s);
  copy.inventories[93]=[...(copy.inventories[93]??[]),...(copy.inventories[94]??[])];
  copy.inventories[94]=[];return copy;
 };
 return sameAssets(normalize(before),normalize(after),cost);
}

function huntAssets(before:Save,after:Save,eaten:number){
 // The bought apron moves from the pack to the body slot. Compare its total with the other assets.
 const normalized=structuredClone(after),worn=normalized.inventories[94]??[];
 const apron=worn.filter(i=>i.id===1005);
 normalized.inventories[94]=worn.filter(i=>i.id!==1005);
 normalized.inventories[93]=[...(normalized.inventories[93]??[]),...apron];
 // Three 30-coin crossings (bank and quest return trip), 30 rum, 6 bananas, 2 apron;
 // Luthas pays 30 and the treasure gives 450.
 // Hunt uses quest-lib's lobster policy. Cakes and swordfish remain protected assets.
 return sameAssets(before,normalized,{995:352,1963:-7,1005:1,433:1,1635:1,1605:1,379:-eaten});
}

function elenaAssets(before:Save,after:Save){
 // The new gas mask occupies the head slot; all other worn and stored assets must match.
 const normalized=structuredClone(after),worn=normalized.inventories[94]??[];
 const mask=worn.filter(i=>i.id===1506);
 normalized.inventories[94]=worn.filter(i=>i.id!==1506);
 normalized.inventories[93]=[...(normalized.inventories[93]??[]),...mask];
 return mask.length===1&&mask[0]!.slot===0&&sameAssets(before,normalized,{995:-2,2126:-1,1929:-4,1925:4,954:-1,1927:-1,231:-1,1505:1,1506:1});
}

export function questSweepChecks(id:string,before:Save,after:Save,log:string,record:CaseRecord){
 const blackknight=id==='blackknight-finish',elena=id==='elena-heckel-dust',ball=id==='ball-worn-kit',ballMissing=id==='ball-missing-gloves';
 const rj=id==='rj-pirate-letter'||id==='rj-pirate-started';
 const hunt=id==='hunt-crowded',success=id==='bank-stage',fishing=id==='fishing-stage',clock=id==='clock-stage',ernest=id==='ernest-fortress',vampire=id==='vampire-started',totem=id==='totem-started-cakes',ghost=id==='retained-ghost'||id==='banked-ghost',banked=id==='banked-ghost',boats=lines(log,'QUEST_SWEEP_BOAT');
 const eaten=Number(log.match(/^RESULT ok .*\beats=(\d+)\b/m)?.[1]??-1);
 const bites1=total(before,1891)-total(after,1891),bites2=total(before,1893)+bites1-total(after,1893),bites3=total(before,1895)+bites2-total(after,1895);
 const checks={
  child:!record.timedOut&&record.exit===(blackknight||elena||ball||rj||success||fishing||clock||ernest||vampire||totem||hunt||ghost?0:1),
  saved:record.saveMatched,
  oneLogin:(log.match(/^START /gm)??[]).length===1,
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(?:logout|session close)/m.test(log),
  alive:after.skills[3]!.level>0&&!/\bdied=true\b|^RESULT fail .*died/m.test(log),
  entryHp:before.skills[3]!.level===(ball||ballMissing?77:elena||rj||clock||totem||hunt?40:ernest||vampire?75:ghost?26:fishing?47:10),
  assets:blackknight?sameAssets(before,after,{995:2500}):elena?elenaAssets(before,after):ball?ballAssets(before,after,{1985:-1,2409:1,2411:1,379:-eaten}):hunt?huntAssets(before,after,eaten):sameAssets(before,after,rj?{753:-1}:totem?{995:-90,373:5,1891:-bites1,1893:bites1-bites2,1895:bites2-bites3}:clock?{995:440,1929:-1,1925:1,379:-eaten}:ernest?{995:300,273:-1,275:1,379:-eaten}:vampire?{1917:-1,379:-eaten}:ghost?{553:-1}:fishing?{995:-5,313:-2,1550:-1,27:1}:success?{1759:-20,995:0}:{}),
  // The Count fight trains Attack (accurate style), Hitpoints, and Strength or Defence on another style.
  unrelatedXp:before.skills.every((s,i)=>elena&&i===14||success&&i===12||fishing&&i===10||totem&&i===17||ghost&&i===5||(ball||vampire||hunt)&&i<=3||s.rawExperience===after.skills[i]!.rawExperience),
 };
 if(blackknight)return{...checks,
  entry:before.position.x===3016&&before.position.z===3512&&before.position.level===0&&before.vars[130]===3&&before.skills[6]!.level===1,
  result:/^RESULT ok quest-sweep blackknight quest complete qp=3$/m.test(log),
  quest:after.vars[130]===4&&(after.vars[101]??0)===(before.vars[101]??0)+3,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Black Knight's Fortress"&&q.state==='complete'),
  reward:total(after,995)===total(before,995)+2500,
  skipped:!/^QUEST_SWEEP_(?:BANK|WITHDRAW|BUY|FARE) |^MILESTONE /m.test(log),
  location:after.position.level===2&&Math.max(Math.abs(after.position.x-2960),Math.abs(after.position.z-3336))<=3,
 };
 if(elena)return{...checks,
  entry:before.position.x===2615&&before.position.z===3332&&before.position.level===0&&total(before,1975)===0&&(before.vars[165]??0)===0&&before.skills[6]!.level===1,
  bought:lines(log,'QUEST_SWEEP_HECKEL').some(r=>r.item===1975&&r.before===0&&r.after===1&&r.coinsBefore-r.coins===2&&r.observed),
  treeExit:lines(log,'QUEST_SWEEP_TREE_EXIT').some(r=>r.ok&&r.at?.x===2466&&r.at?.z===3491&&r.at?.level===0),
  staged:/^MILESTONE quest-sweep elena staged at /m.test(log)&&lines(log,'QUEST_SWEEP_GATE').some(r=>r.ok),
  result:/^RESULT ok(?: |$)/m.test(log),
  quest:after.vars[165]===29&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Plague City'&&q.state==='complete'),
  reward:after.skills[14]!.rawExperience-before.skills[14]!.rawExperience===606250,
  budget:boats.length===0&&!/^QUEST_SWEEP_(?:BUY|FARE) /m.test(log),
 };
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
  capacity:lines(log,'QUEST_SWEEP_CAPACITY').some(r=>r.required>=4&&r.free>=r.required),
  bananas:lines(log,'QUEST_SWEEP_BUY').some(r=>r.item===1963&&r.npc==='Wydin'&&r.count===3&&r.before===7&&r.after===10&&r.coinsBefore-r.coins===6),
  bought:lines(log,'QUEST_SWEEP_BUY').some(r=>r.item===1005&&r.npc==='Thessalia'&&r.count===1&&r.before===0&&r.after===1&&r.coinsBefore-r.coins===2),
  budget:Number.isSafeInteger(eaten)&&eaten>=0&&eaten<=total(before,379)&&!/^QUEST_SWEEP_FARE /m.test(log),
  quest:after.vars[71]===4&&(after.vars[101]??0)===(before.vars[101]??0)+2,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==="Pirate's Treasure"&&q.state==='complete'),
  reward:total(after,1635)===total(before,1635)+1&&total(after,1605)===total(before,1605)+1,
  questItems:[431,432,1963].every(id=>total(after,id)===0)&&total(after,433)===1,
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
 return{...checks,
  result:/^RESULT fail quest-sweep doric missing 434:6,436:4,440:2\s*$/m.test(log),
  noQuestTravel:!/^MILESTONE quest-sweep /m.test(log)&&boats.length===0,
  questUnchanged:(after.vars[31]??0)===(before.vars[31]??0)&&(after.vars[101]??0)===(before.vars[101]??0),
  atBank:after.position.level===0&&Math.max(Math.abs(after.position.x-2947),Math.abs(after.position.z-3368))<=3,
 };
}

function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8')) as {source:string;cases:CaseRecord[];endpoints:ProofEndpoints};
 const endpoints=questSweepProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 if(meta.endpoints.server!==endpoints.server||meta.endpoints.gateway!==endpoints.gateway)throw Error('retained practice endpoints mismatch');
 const results=['ball-worn-kit','ball-missing-gloves','bank-stage','missing','retained-ghost','banked-ghost','fishing-stage','clock-stage','ernest-fortress','vampire-started','totem-started-cakes','hunt-crowded','rj-pirate-letter','rj-pirate-started','elena-heckel-dust','blackknight-finish'].map(id=>{
  const record=meta.cases.find(c=>c.id===id);
  if(!record)throw Error(`missing retained case ${id}`);
  const checks=questSweepChecks(id,readPracticeSave(join(dir,id+'-before.sav')),readPracticeSave(join(dir,id+'-after.sav')),readFileSync(join(dir,id+'.log'),'utf8'),record);
  return{...record,ok:Object.values(checks).every(Boolean),checks};
 });
 const source=meta.source===workerSourceRevision();
 const report={ok:source&&results.every(r=>r.ok),source,results,scope:'Native practice at150ms/25xXP: Black Knight Fortress from3016,3512,0 at stage3/HP10/Magic1: real blackknight CLI, threeQP,2500coins, exact retained assets and logout.  Plague City from2615,3332,0 atHP40/Magic1 without chocolate dust: real elena CLI, bought one1975 from Heckel Funch, two-coin debit, staged quest, oneQP,60625Mining XP, exact assets and logout. Each Elena child is bounded to300000ms. Witch House ordinary HP77 entry with unworn banked gloves1059, banked adamant scimitar1331 and worn staff1381: real ball CLI, observed worn kit, completion, fourQP, at least158125 Hitpoints XP including combat, retained staff/amulet and exact assets, logout. No-gloves/no-coins entry refuses before quest handover and logs out.  existing HP10 Gnome Sheep Shearer/two boat fares, missing-item refusal, and HP26/Magic1 Ghost completion from held-cellar and banked-surface skull entries with no law rune. Fishing Contest from the western bank entry at Fishing20/Magic1/HP47 with five-coin cost and retained tools. Clock Tower from3239,3275,0 at Magic1/HP40 with an owned water bucket, two30coin fares, up to four lobsters, oneQP and500coin reward. Ernest the Chicken from the Black Knights\' Fortress level-1 box room3029,3505,1 at HP75/Magic1: secret wall, hall ladder and front exit observed before bank selection, fish food picked up at its Draynor Manor level-1 spawn with no banked food, fourQP and300coin reward. Vampire Slayer from the started-quest entry3097,3267,0 at HP75/Magic1 with law runes, worn Silverlight and owned beer, hammer and garlic: Morgan skipped, both Varrock trips walked, beer debited, stake used, threeQP and120625 Attack XP. Tribal Totem from started stage1 at2571,3250,0, Thieving99/HP40/Magic1 without law runes: owned cakes, three30coin fares, oneQP,44375 Thieving XP and five swordfish. Pirate\'s Treasure from the crowded Karamja entry2907,3147,0 with seven bananas, HP40/Attack55/Magic1, CAP6000: capacity staging, three remaining bananas, owned spade, bought apron, twoQP and treasure rewards. Romeo & Juliet from2999,3383,0 unstarted and3210,3423,0 at stage30, HP40/Attack55/Magic1 with Pirate message433 and cadava berries753: real CLI rj with CAP6000 and timeout5400000, one berry consumed, fiveQP, retained433 and all other assets. Exact quest rewards/assets and logout. No live or unattended claim.'};
 writeFileSync(join(dir,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(dir:string){
 if(!process.env.DELIVERY_DIR||!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('native turn required: run through delivery');
 // Reserve space for saves and logs before the stack can consume the remaining disk.
 // This is a storage reserve, not a measured size of a practice run.
 const disk=statfsSync(root),freeBytes=disk.bavail*disk.bsize;
 if(freeBytes<512*2**20)throw Error(`practice storage deferred: freeBytes=${freeBytes} requiredBytes=${512*2**20}; preserve failed evidence`);
 // Host memory waits occur before gameplay. Delivery holds the native turn through the saved consumer.
 const deadline=Date.now()+180000;
 while(freemem()/2**30<PRACTICE_STARTUP_GB){
  console.log(`QUEST_SWEEP_MEMORY freeGiB=${(freemem()/2**30).toFixed(2)} startupGiB=${PRACTICE_STARTUP_GB} floorGiB=${FREE_FLOOR_GB}`);
  if(Date.now()>=deadline)throw Error('practice startup headroom deadline');
  await Bun.sleep(1000);
 }
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory:dir,task:'quest-sweep'}));closeSync(fd);
 mkdirSync(dir,{recursive:true});
 const cases:CaseRecord[]=[],source=workerSourceRevision();
 let endpoints:ProofEndpoints|undefined;
 const retain=()=>writeFileSync(join(dir,'native.json'),JSON.stringify({source,tickMs:150,xpRate:25,endpoints,cases},null,2));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  endpoints=selectQuestSweepProofEndpoints();
  stack=await startQuestSweepProofStack(endpoints);
  for(const c of [{id:'ball-worn-kit',quest:'ball',bank:[{id:995,count:183752},{id:1059,count:1},{id:1331,count:1}]},{id:'ball-missing-gloves',quest:'ball',bank:[]},...['rj-pirate-letter','rj-pirate-started'].map(id=>({id,quest:'rj',bank:[{id:995,count:183752},{id:1891,count:7},{id:373,count:5}]})),{id:'hunt-crowded',quest:'hunt',bank:[{id:995,count:183752},{id:1891,count:7}]},{id:'totem-started-cakes',quest:'totem',bank:[{id:995,count:183752},{id:1891,count:15},{id:1893,count:1},{id:1895,count:2}]},{id:'clock-stage',quest:'cog',bank:[{id:995,count:183752},{id:1436,count:243}]},{id:'ernest-fortress',quest:'haunted',bank:[{id:273,count:1},{id:952,count:1},{id:379,count:4}]},{id:'vampire-started',quest:'vampire',bank:[{id:379,count:6}]},{id:'fishing-stage',quest:'fishingcompo',bank:[{id:952,count:1},{id:307,count:1},{id:313,count:2},{id:1550,count:1},{id:556,count:5}]},{id:'bank-stage',quest:'sheep',bank:[{id:1759,count:20}]},{id:'missing',quest:'doric',bank:[]},...['retained-ghost','banked-ghost'].map(id=>({id,quest:'priest',bank:[{id:995,count:1127309},{id:1436,count:243},{id:1446,count:1},...(id==='banked-ghost'?[{id:553,count:1}]:[])]})),{id:'elena-heckel-dust',quest:'elena',bank:[{id:995,count:106}]},{id:'blackknight-finish',quest:'blackknight',bank:[]}]){
   const before=join(dir,c.id+'-before.sav');
   if(existsSync(before))throw Error(`preserve before snapshot: ${before}`);
   const name=runBotName('qsw',cases.length);
   if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('fresh quest-sweep practice account required');
   const {envPath}=await createBot(name);
   writeFileSync(envPath,questSweepProofAccountEnv(readFileSync(envPath,'utf8'),endpoints));
   const blackknight=c.quest==='blackknight',elena=c.quest==='elena',ball=c.quest==='ball',ballMissing=c.id==='ball-missing-gloves',rj=c.quest==='rj',hunt=c.quest==='hunt',ghost=c.quest==='priest',banked=c.id==='banked-ghost',fishing=c.quest==='fishingcompo',clock=c.quest==='cog',ernest=c.quest==='haunted',vampire=c.quest==='vampire',totem=c.quest==='totem',long=ball||rj||fishing||clock||ernest||vampire||totem||hunt;
   const save=await applyPreset(name,totem?{position:{x:2571,z:3250,level:0},skills:{Thieving:99,Hitpoints:40,Magic:1},varps:{200:1,10:8,101:1},bank:c.bank,inventory:[{id:995,count:552}]}:blackknight?{position:{x:3016,z:3512,level:0},skills:{Hitpoints:10,Magic:1},varps:{130:3,101:12,144:100,226:7,178:3},bank:c.bank,inventory:[{id:995,count:490},{id:433,count:1}]}:elena?{position:{x:2615,z:3332,level:0},skills:{Hitpoints:40,Magic:1},bank:c.bank,inventory:[2126,1929,1929,1929,1929,952,954,1927,231].map(id=>({id,count:1}))}:ball?{position:{x:2947,z:3368,level:0},skills:{Attack:94,Strength:83,Defence:76,Hitpoints:77,Magic:1},equipment:[{id:589,count:1,slot:2},{id:1381,count:1,slot:3}],bank:c.bank,inventory:[{id:1985,count:1},...Array.from({length:4},()=>({id:379,count:1}))]}:rj?{position:c.id==='rj-pirate-started'?{x:3210,z:3423,level:0}:{x:2999,z:3383,level:0},skills:{Attack:55,Hitpoints:40,Magic:1},varps:{144:c.id==='rj-pirate-started'?30:0},equipment:[{id:1005,count:1,slot:4}],bank:c.bank,inventory:[{id:995,count:754},{id:433,count:1},{id:753,count:1},{id:555,count:2},{id:556,count:6},{id:952,count:1},{id:1635,count:1},{id:1605,count:1},...Array.from({length:8},()=>({id:1891,count:1})),{id:1893,count:1},{id:1895,count:1},{id:1895,count:1}]}:hunt?{position:{x:2907,z:3147,level:0},skills:{Attack:55,Hitpoints:40,Magic:1,Thieving:99,Cooking:30,Fishing:20,Crafting:51},varps:{200:5,10:8,101:2},bank:c.bank,inventory:[{id:995,count:402},{id:1925,count:1},{id:555,count:2},...Array.from({length:8},()=>({id:1891,count:1})),{id:1893,count:1},...Array.from({length:2},()=>({id:1895,count:1})),...Array.from({length:5},()=>({id:373,count:1})),{id:952,count:1},{id:556,count:6},...Array.from({length:7},()=>({id:1963,count:1}))]}:vampire?{position:{x:3097,z:3267,level:0},skills:{Attack:94,Strength:83,Defence:76,Hitpoints:75,Magic:1},varps:{178:1},equipment:[[1139,0],[552,2],[2402,3],[1101,4],[1171,5]].map(([id,slot])=>({id:id!,count:1,slot:slot!})),bank:c.bank,inventory:[{id:1917,count:1},{id:2347,count:1},{id:1550,count:1},{id:563,count:2}]}:ernest?{position:{x:3029,z:3505,level:1},skills:{Attack:94,Strength:83,Defence:76,Hitpoints:75,Magic:1},varps:{130:2},equipment:[[1139,0],[552,2],[2402,3],[1101,4],[1171,5]].map(([id,slot])=>({id:id!,count:1,slot:slot!})),bank:c.bank,inventory:[{id:995,count:490}]}:clock?{position:{x:3239,z:3275,level:0},skills:{Magic:1,Hitpoints:40,Attack:55},bank:c.bank,inventory:[{id:995,count:112},{id:1929,count:1},{id:1351,count:1},...Array.from({length:4},()=>({id:379,count:1}))]}:fishing?{position:{x:2615,z:3332,level:0},skills:{Fishing:20,Magic:1,Hitpoints:47,Attack:62,Defence:10,Strength:12},bank:c.bank,inventory:[{id:995,count:7350},{id:1351,count:1}]}:ghost?{position:banked?{x:3094,z:3491,level:0}:{x:3113,z:9555,level:0},skills:{Hitpoints:26,Attack:37,Magic:1,Prayer:1},varps:{107:4},equipment:[{id:552,count:1,slot:2}],bank:c.bank,inventory:[...(!banked?[{id:553,count:1}]:[]),{id:556,count:3},{id:557,count:1}]}:{position:c.id==='bank-stage'?{x:2459,z:3385,level:0}:{x:2965,z:3380,level:0},skills:{Hitpoints:10},bank:c.bank,inventory:[{id:995,count:362},{id:1351,count:1}]});
   copyFileSync(save,before);
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice free memory below floor');
   const stamp=statSync(save).mtimeMs,t=Date.now();
   const record:CaseRecord={id:c.id,exit:-1,timedOut:false,saveMatched:false,seconds:0};cases.push(record);retain();
   const p=Bun.spawn({...questSweepChildConfiguration(name,c.quest,endpoints,long||elena?{...process.env,CAP:'6000'}:process.env),windowsHide:true,stdout:'pipe',stderr:'pipe'});
   let termination:Promise<void>|undefined;
   // CAP 6000 ticks at 150 ms is 900 s: the Vampire child must reach its own tick-cap failure before this kill.
   const kill=setTimeout(()=>{record.timedOut=true;termination=killTree(p.pid);},elena?300000:ball||rj||hunt?5400000:vampire||totem?1200000:long?900000:300000);
   try{
    const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
    record.exit=await p.exited;clearTimeout(kill);await termination;
    writeFileSync(join(dir,c.id+'.log'),out+'\n--stderr--\n'+err);
    const saved=await waitPracticeSave(save,s=>statSync(save).mtimeMs>stamp&&(c.id==='missing'||ballMissing||(blackknight?s.vars[130]===4:elena?s.vars[165]===29:ball?s.vars[226]===7:rj?s.vars[144]===100:hunt?s.vars[71]===4:totem?s.vars[200]===5:clock?((s.vars[10]??0)&15)===8:ernest?s.vars[32]===3:vampire?s.vars[178]===3:ghost?s.vars[107]===5:fishing?s.vars[11]===5:s.vars[179]===22)),{timeoutMs:6000});
    record.saveMatched=saved.matched;
   }finally{
    clearTimeout(kill);copyFileSync(save,join(dir,c.id+'-after.sav'));record.seconds=Math.round((Date.now()-t)/1000);retain();
   }
  }
  return verify(dir);
 }finally{try{await stack?.stop();}finally{rmSync(lock,{force:true});retain();}}
}

if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through delivery');
  const dir=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv.includes('--verify')?verify(dir):await run(dir)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
