import{existsSync,readFileSync}from'node:fs';
import{openBot,settle}from'../packages/core/src/bot';
import type{Session}from'../packages/core/src/inprocess';
import{waitUntil}from'../packages/core/src/ticks';
import{componentId}from'../packages/core/src/logout';
import{equipmentObserved}from'../packages/core/src/container-observation';
import{watchProductionLife}from'./microbot-c-lifetime';
import{ClientProt}from'../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import nativeItems from'../knowledge/items.json';
import nativeSkills from'../knowledge/skills.json';
import nativeTools from'../knowledge/skill-tools.json';
import{inventoryRecipes}from'./microbot-production';
import{parseConfigs}from'../packages/knowledge/src/config';
import{questFoodDefinitions}from'./quest-sustain';

// BankTabSorterScript category/workflow/tier/dose/fuzzy policy adapted from
// Microbot-Hub cd648f48 (BSD-2-Clause, research/microbot-ports-LICENSE.txt).
// Native production levels and unidentified-herb IDs replace modern tables.
// Name policy is independent; native bank tabs do not exist.
export type BankSortRow={slot:number;id:number;name:string;count:number};
export type BankSortObservation={generation:number;mode:0|1;rows:BankSortRow[]};
export interface BankSortDriver{tick():number;unsafe():string;observe():BankSortObservation|null;drag(from:number,to:number,before:BankSortRow[]):Promise<boolean>;wait(predicate:()=>boolean,ticks:number):Promise<boolean>}
const order=(rows:readonly BankSortRow[])=>JSON.stringify([...rows].sort((a,b)=>a.slot-b.slot).map(i=>[i.slot,i.id,i.count]));
function validate(rows:readonly BankSortRow[]){
 if(rows.length>576||new Set(rows.map(i=>i.slot)).size!==rows.length||new Set(rows.map(i=>i.id)).size!==rows.length||rows.some(i=>!Number.isSafeInteger(i.slot)||i.slot<0||i.slot>=576||!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<1||i.count>2147483647||typeof i.name!=='string'||!i.name.trim()))throw Error('bank rows unknown or ambiguous');
}
export type BankSortPolicy='name'|'donor';
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const categories=['Currency','Teleportation','Potions','Food','Runes','Ammunition','Weapon-Melee','Weapon-Ranged','Weapon-Magic','Armour-Helmet','Armour-Cape','Armour-Amulet','Armour-Body','Armour-Legs','Armour-Shield','Armour-Gloves','Armour-Boots','Armour-Ring','Tool-Pickaxe','Tool-Axe','Tool-Fishing','Tool-Other','Skilling-Resource-Gem','Skilling-Resource-Log','Skilling-Resource-Ore','Skilling-Resource-Bar','Skilling-Resource-Herb','Skilling-Resource-Seed','Skilling-Resource-Fish','Skilling-Resource-Other','Clue-Scrolls','Quest-Items','Cosmetic/Holiday','Miscellaneous'];
const runeOrder=['air','mind','water','earth','fire','body','cosmic','chaos','nature','law','death','blood','soul'].map(n=>n+' rune');
const pieces=['helm','full helm','hood','coif','mask','cape','cloak','amulet','necklace','top','platebody','body','chestplate','hauberk','robe top','legs','platelegs','skirt','chaps','tassets','robe bottom','kiteshield','sq shield','shield','defender','book','ward','gloves','gauntlets','vambraces','bracers','boots','ring'];
type NativeSortData={category:string;level:number;stage:number};
let nativeSortData:Map<number,NativeSortData>|undefined;
function sortData(){
 if(nativeSortData)return nativeSortData;const data=new Map<number,NativeSortData>(),names=new Map(nativeItems.map(i=>[i.debugname,i.id])),byId=new Map(nativeItems.map(i=>[i.id,i]));
 const put=(id:number,category:string,level:number,stage:number)=>{if(Number.isFinite(level))data.set(id,{category,level,stage});};
 for(const r of nativeSkills)for(const output of r.outputs){const id=names.get(output);if(id===undefined||r.level===null)continue;if(r.skill==='woodcutting')put(id,'Skilling-Resource-Log',r.level,0);if(r.skill==='mining'&&/ore|coal|clay/.test(output))put(id,'Skilling-Resource-Ore',r.level,0);}
 const smelting='vendor/rs-sdk/server/content/scripts/skill_smithing/configs/smelting/smelting.struct';for(const b of parseConfigs(readFileSync(smelting,'utf8'),smelting)){const p=Object.fromEntries((b.props.param??[]).map(v=>v.split(',',2))),id=names.get(p.product??'');if(id!==undefined)put(id,'Skilling-Resource-Bar',Number(p.levelrequired),1);}
 for(const r of inventoryRecipes()){
  if(r.name.startsWith('cut-')&&r.skill==='Crafting'&&r.tools.includes(1755)){put(r.inputs[0]!.id,'Skilling-Resource-Gem',r.level,0);put(r.product,'Skilling-Resource-Gem',r.level,1);}
  if(r.name.startsWith('identify:')){put(r.inputs[0]!.id,'Skilling-Resource-Herb',r.level,0);put(r.product,'Skilling-Resource-Herb',r.level,1);}
 }
 const brewing='vendor/rs-sdk/server/content/scripts/skill_herblore/configs/brewing/brew_potion',params=(b:{props:Record<string,string[]>})=>Object.fromEntries((b.props.param??[]).map(v=>v.split(',',2)));
 const defaultLevel=Number(parseConfigs(readFileSync(brewing+'.param','utf8'),brewing+'.param').find(b=>b.name==='brew_potion_level')?.props.default?.[0]);
 const families=new Map<string,NativeSortData>(),objects=new Map<string,ReturnType<typeof parseConfigs>>();
 const blocks=(id:number)=>{const path='vendor/rs-sdk/server/content/'+byId.get(id)!.src.replace(/:\d+$/,'');if(!objects.has(path))objects.set(path,parseConfigs(readFileSync(path,'utf8'),path));return objects.get(path)!;};
 for(const b of parseConfigs(readFileSync(brewing+'.struct','utf8'),brewing+'.struct')){const p=params(b),id=names.get(p.brew_potion_mixture??'');if(id===undefined)continue;const level=Number(p.brew_potion_level??defaultLevel),stage=p.brew_potion_solvent==='vial_water'?2:4;put(id,'Potions',level,stage);const obj=blocks(id).find(o=>o.name===byId.get(id)!.debugname),family=obj&&params(obj).decant_potion_enum;if(family)families.set(family,{category:'Potions',level,stage});}
 // Dose variants share the native decant enum, never a generic display name.
 for(const file of objects.values())for(const b of file){const id=names.get(b.name),family=params(b).decant_potion_enum,value=family&&families.get(family);if(id!==undefined&&value&&!data.has(id))data.set(id,value);}
 const byName=new Map<string,NativeSortData[]>();for(const[id,value]of data){const name=byId.get(id)!.name.toLowerCase();byName.set(name,[...byName.get(name)??[],value]);}
 for(const item of nativeItems){const name=item.name.toLowerCase(),values=byName.get(name);if(values?.length&&!data.has(item.id)&&!/(?:^herb$|potion)/.test(name)&&values.every(v=>JSON.stringify(v)===JSON.stringify(values[0])))data.set(item.id,values[0]!);}
 nativeSortData=data;return data;
}
export function bankDonorKey(row:BankSortRow){
 const native=nativeItems.find(i=>i.id===row.id);if(!native)throw Error('donor policy needs native item metadata');
 const name=native.name.toLowerCase().trim(),suffix=name.match(/^(.*?)\s*\((\d+)\)$/),base=suffix?suffix[1]!:name,dose=suffix?Number(suffix[2]):-1,has=(re:RegExp)=>re.test(base),mapped=sortData().get(row.id);
 let category=mapped?.category??'Miscellaneous';
 if(!mapped){
  if(has(/coins/)||base==='platinum token')category='Currency';else if(has(/teleport tab|teleport scroll| teleport$/))category='Teleportation';else if(has(/potion/)||/dose/.test(native.debugname))category='Potions';else if(questFoodDefinitions().has(row.id)||has(/shark|monkfish|karambwan|cake|pie|stew|pizza|bread/))category='Food';else if(name.endsWith(' rune'))category='Runes';else if(has(/dart|arrow|bolts|javelin|throwing axe|knife| shot$| shell$/))category='Ammunition';
  else if(has(/pickaxe/))category='Tool-Pickaxe';else if(has(/ axe/)&&!has(/battleaxe|greataxe|throwing axe/))category='Tool-Axe';else if(has(/harpoon|fishing rod|lobster pot|fishing net|fishing bait|feather/))category='Tool-Fishing';else if(has(/tinderbox|chisel|hammer|spade|rake|seed dibber|secateurs|watering can|glassblowing pipe/))category='Tool-Other';
  else if(has(/staff|wand|trident|sceptre|crozier|book of/))category='Weapon-Magic';else if(has(/shortbow|longbow|comp bow|crossbow|c'bow|ballista|blowpipe|crystal bow|dark bow/))category='Weapon-Ranged';else if(has(/scimitar|sword|dagger|mace|warhammer|battleaxe|halberd|spear|hasta|whip|bludgeon|rapier|greataxe|maul|flail|claws/))category='Weapon-Melee';
  else if(has(/helm|coif|hood|mask|circlet|sallet/))category='Armour-Helmet';else if(has(/cape|cloak/))category='Armour-Cape';else if(has(/amulet|necklace|symbol|stole/))category='Armour-Amulet';else if(has(/platebody|chainbody|body|chestplate|hauberk|robe top|apron/))category='Armour-Body';else if(has(/platelegs|plateskirt|legs|skirt|chaps|tassets|robe bottom/))category='Armour-Legs';else if(has(/shield|defender|toktz-ket-xil|ward/)&&!has(/dwarf weed/))category='Armour-Shield';else if(has(/gloves|gauntlets|vambraces|bracers|d'hide vamb/))category='Armour-Gloves';else if(has(/boots/))category='Armour-Boots';else if(has(/ring/)&&!has(/slayer|ring of dueling/))category='Armour-Ring';
  else if(has(/ logs$/))category='Skilling-Resource-Log';else if(has(/ ore$/))category='Skilling-Resource-Ore';else if(has(/ bar$/))category='Skilling-Resource-Bar';else if(has(/ seeds?$| sapling$/))category='Skilling-Resource-Seed';else if(has(/^raw |^cooked /))category='Skilling-Resource-Fish';else if(has(/bone|ashes|hide|fleece|essence|vial|eye of newt|limpwurt root|snape grass|bird nest|bucket of/))category='Skilling-Resource-Other';else if(has(/clue scroll|reward casket/))category='Clue-Scrolls';else if(has(/key/)&&!has(/crystal key/))category='Quest-Items';else if(has(/event|holiday|cosmetic|santa hat|partyhat/))category='Cosmetic/Holiday';
 }
 const material=['bronze','iron','steel','black','mithril','adamant','rune','dragon'].find(x=>base.includes(x)),tiers:Record<string,number>={bronze:1,iron:10,steel:20,black:25,mithril:30,adamant:40,rune:50,dragon:60};
 const tool=[...nativeTools.axes.map(t=>({id:t.id,level:t.paramLevelrequire})),...nativeTools.pickaxes.map(t=>({id:t.id,level:t.miningLevel}))].find(t=>t.id===row.id),tier=category==='Tool-Axe'||category==='Tool-Pickaxe'?(tool?.level??(material?tiers[material]!: -1)):(material?tiers[material]!: -1);
 return{row,name,base,dose,category,tier,level:mapped?.level??0,stage:mapped?.stage??(category==='Skilling-Resource-Fish'?(base.startsWith('raw')?0:1):['Skilling-Resource-Ore','Skilling-Resource-Log','Skilling-Resource-Seed'].includes(category)?0:category==='Skilling-Resource-Bar'?1:category==='Potions'?4:/eye of newt|limpwurt root/.test(base)?3:99),workflow:category==='Potions'||category.startsWith('Skilling-Resource-')};
}
export function bankNameSimilarity(a:string,b:string){
 if(a===b)return 1;if(!a.length||!b.length)return 0;const distance=Math.max(0,Math.floor(Math.max(a.length,b.length)/2)-1),x=new Set<number>(),y=new Set<number>();
 for(let i=0;i<a.length;i++)for(let j=Math.max(0,i-distance);j<Math.min(b.length,i+distance+1);j++)if(!y.has(j)&&a[i]===b[j]){x.add(i);y.add(j);break;}
 const matches=x.size;if(!matches)return 0;const right=[...y].sort((a,b)=>a-b);let swaps=0;[...x].forEach((i,k)=>{if(a[i]!==b[right[k]!])swaps++;});const jaro=(matches/a.length+matches/b.length+(matches-swaps/2)/matches)/3;if(jaro<.7)return jaro;let prefix=0;while(prefix<Math.min(4,a.length,b.length)&&a[prefix]===b[prefix])prefix++;return Math.min(1,jaro+prefix*.1*(1-jaro));
}
type SortKey=ReturnType<typeof bankDonorKey>;
const baseOrder=(a:SortKey,b:SortKey)=>compare(a.base,b.base)||b.dose-a.dose||compare(a.name,b.name)||a.row.slot-b.row.slot;
function fuzzyGroup(input:SortKey[]){
 const cache=new Map<string,number>(),sim=(a:string,b:string)=>{const key=a+'\0'+b;let v=cache.get(key);if(v===undefined){v=bankNameSimilarity(a,b);cache.set(key,v);}return v;};
 const similarity=(a:SortKey,b:SortKey)=>{let word=0,matched=0;const aa=a.base.split(/\s+/),bb=b.base.split(/\s+/);if(aa.length>1&&bb.length>1)for(const x of aa.filter(w=>w.length>2)){const best=Math.max(0,...bb.filter(w=>w.length>2).map(y=>sim(x,y)));if(best>.95)matched++;word=Math.max(word,best);}if(matched>=2)word=Math.min(1,word+.15);return Math.max(sim(a.name,b.name),sim(a.base,b.base),word);};
 const clusters:{centroid:SortKey;items:SortKey[]}[]=[];
 for(const item of [...input].filter(i=>i.tier<0).sort((a,b)=>compare(a.name,b.name)||a.row.slot-b.row.slot)){let best:typeof clusters[number]|undefined,score=0;for(const c of clusters){if(c.items.length>=30||!(item.dose>=0&&item.base===c.centroid.base)&&similarity(c.centroid,item)<=.95)continue;const match=Math.max(...c.items.map(i=>similarity(i,item)));if(match>score){best=c;score=match;}}if(best)best.items.push(item);else clusters.push({centroid:item,items:[item]});}
 for(const item of input.filter(i=>i.tier>=0))clusters.push({centroid:item,items:[item]});
 // Donor merge requires capped similarity > (.95+.05), so it never merges.
 for(const c of clusters)c.items.sort(baseOrder);return clusters.sort((a,b)=>compare(a.items[0]!.base,b.items[0]!.base)||a.items[0]!.row.slot-b.items[0]!.row.slot).flatMap(c=>c.items);
}
export function sortBankRows(rows:readonly BankSortRow[],policy:BankSortPolicy='name'):BankSortRow[]{
 validate(rows);if(!['name','donor'].includes(policy))throw Error('unknown bank sort policy');let sorted:BankSortRow[];
 if(policy==='name')sorted=[...rows].sort((a,b)=>compare(a.name.toLowerCase(),b.name.toLowerCase())||a.slot-b.slot);
 else{const keys=rows.map(bankDonorKey),workflow=keys.filter(k=>k.workflow).sort((a,b)=>a.level-b.level||a.stage-b.stage||baseOrder(a,b)),out:SortKey[]=[];for(const category of categories){if(category==='Potions'){out.push(...workflow);continue;}const group=keys.filter(k=>!k.workflow&&k.category===category);if(/^(Tool|Weapon|Armour)-/.test(category)||category==='Runes')group.sort((a,b)=>{if(category==='Runes'){const ai=runeOrder.indexOf(a.name),bi=runeOrder.indexOf(b.name);if(ai!==bi)return(ai<0?999:ai)-(bi<0?999:bi);}else{if(a.tier!==b.tier)return b.tier-a.tier;if(category.startsWith('Armour-')){const ai=pieces.findIndex(p=>a.base.includes(p)),bi=pieces.findIndex(p=>b.base.includes(p));if(ai!==bi)return(ai<0?999:ai)-(bi<0?999:bi);}}return baseOrder(a,b);});else group.splice(0,group.length,...fuzzyGroup(group));out.push(...group);}sorted=out.map(k=>k.row);if(sorted.length!==rows.length)throw Error('bank policy omitted a native item');}
 return sorted.map((i,slot)=>({...i,slot}));
}
export function bankMove(rows:readonly BankSortRow[],from:number,to:number,mode:0|1){
 validate(rows);if(!Number.isSafeInteger(to)||to<0||to>=576||!rows.some(i=>i.slot===from)||from===to||![0,1].includes(mode))throw Error('invalid native bank move');
 return rows.map(i=>({...i,slot:i.slot===from?to:mode===0?(i.slot===to?from:i.slot):from>to&&i.slot>=to&&i.slot<from?i.slot+1:from<to&&i.slot>from&&i.slot<=to?i.slot-1:i.slot})).sort((a,b)=>a.slot-b.slot);
}
export async function runFlatBankSort(d:BankSortDriver,o:{cap:number;maxMoves:number;policy?:BankSortPolicy}){
 if(!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.maxMoves)||o.maxMoves<1||o.maxMoves>576)throw Error('invalid finite bank sort budget');
 const began=d.tick(),check=()=>{const reason=d.unsafe();if(reason)throw Error('bank sort '+reason);if(d.tick()-began>=o.cap)throw Error('bank sort tick budget');};
 check();const first=d.observe();if(!first||!Number.isSafeInteger(first.generation)||first.generation<1||![0,1].includes(first.mode))throw Error('bank state unobserved');
 const target=sortBankRows(first.rows,o.policy);let before=first.rows.map(i=>({...i})),moves=0;
 for(const item of target){
  check();const fresh=d.observe();if(!fresh||fresh.mode!==first.mode||order(fresh.rows)!==order(before))throw Error('bank changed before drag');
  if(before.find(i=>i.slot===item.slot)?.id===item.id)continue;
  if(moves>=o.maxMoves)throw Error('bank sort move budget');
  const source=before.find(i=>i.id===item.id);if(!source)throw Error('bank source disappeared');
  const expected=bankMove(before,source.slot,item.slot,first.mode),tick=d.tick();moves++;
  // Unknown dispatch outcomes stop, even if a later observer happens to match.
  if(!await d.drag(source.slot,item.slot,before))throw Error('bank drag refused; no retry');
  const confirmed=()=>{check();const now=d.observe();if(!now)return false;if(now.mode!==first.mode)throw Error('bank mode changed');if(now.generation<=fresh.generation||d.tick()<=tick)return false;if(order(now.rows)!==order(expected))throw Error('bank drag differs from exact receipt');return true;};
  if(!await d.wait(confirmed,Math.min(8,Math.max(1,o.cap-(d.tick()-began))))||!confirmed())throw Error('bank drag unconfirmed; no retry');
  before=expected;
 }
 check();if(order(d.observe()?.rows??[])!==order(target))throw Error('bank final order differs');
 return{policy:o.policy??'name',moves,ticks:d.tick()-began,mode:first.mode,items:target.length,order:target.map(i=>({id:i.id,count:i.count,slot:i.slot})),preserved:true};
}
export function dispatchBankDrag(client:unknown,from:number,to:number,mode:0|1,before:BankSortRow[]){
 const c=client as any,com=c?.ifType?.(componentId('bank_main:inv'));
 if(c?.mainModalId!==componentId('bank_main')||c.var?.[304]!==mode||!com?.linkObjType||!com?.linkObjNumber)throw Error('bank drag interface/mode unobserved');
 const rows:BankSortRow[]=[];for(let slot=0;slot<com.linkObjType.length;slot++){const id=Number(com.linkObjType[slot])-1,count=Number(com.linkObjNumber[slot]);if(id>=0&&count>0)rows.push({slot,id,count,name:'observed'});}
 if(order(rows)!==order(before))throw Error('bank drag fresh slots differ');bankMove(before,from,to,mode);
 if(typeof c.writeOpcode!=='function'||typeof c.out?.p2!=='function'||typeof c.out?.p1!=='function')throw Error('bank drag packet surface unavailable');
 // Client.ts INV_BUTTOND: component, source, target, mode. Do not apply the
 // client's optimistic swap; only the server's inventory publication is proof.
 c.writeOpcode(ClientProt.INV_BUTTOND);c.out.p2(componentId('bank_main:inv'));c.out.p2(from);c.out.p2(to);c.out.p1(mode);return{success:true};
}
function installBankDrag(client:unknown){const c=client as any,original=c?.executeBotAction;if(typeof original!=='function')throw Error('bank executor unavailable');const wrapper=function(a:any){return a?.type==='nativeBankDrag'?dispatchBankDrag(c,a.from,a.to,a.mode,a.before):original.call(c,a);};c.executeBotAction=wrapper;return()=>{if(c.executeBotAction===wrapper)c.executeBotAction=original;};}
export async function sortNativeBank(s:Session,o:{cap:number;maxMoves:number;policy?:BankSortPolicy},stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.maxMoves)||o.maxMoves<1||o.maxMoves>576||!['name','donor'].includes(o.policy??'name'))throw Error('invalid finite bank sort budget/policy');
 const client=s.client;if(!client||typeof client!=='object')throw Error('bank sort client unavailable');
 const initial=s.sdk.getState(),player=initial?.player;if(!player||player.lifeId===undefined||!equipmentObserved(client))throw Error('bank sort life/gear unobserved');
 const canon=(rows:readonly {id:number;count:number;slot:number}[])=>JSON.stringify([...rows].sort((a,b)=>a.slot-b.slot).map(i=>[i.slot,i.id,i.count]));
 const x=player.worldX,z=player.worldZ,plane=player.level,name=player.name?.toLowerCase();
 const stopped=()=>stop()||existsSync('.practice/stop-all')||!!name&&existsSync(`.practice/stop-${name}`);
 const pack=canon(initial.inventory),gear=canon(initial.equipment),xp=JSON.stringify(initial.skills.map(i=>i.experience)),life=watchProductionLife(s,stopped),began=s.tick();
 const unsafe=()=>{const st=s.sdk.getState();return life.reason()||(!st||s.client!==client||!equipmentObserved(client)?'state/gear unavailable':canon(st.inventory)!==pack||canon(st.equipment)!==gear||JSON.stringify(st.skills.map(i=>i.experience))!==xp?'assets or XP changed':st.player?.worldX!==x||st.player?.worldZ!==z||st.player?.level!==plane?'position changed':st.nearbyPlayers.some(p=>p.distance<=3)?'nearby peer':'');};
 if(unsafe())throw Error('bank sort '+unsafe());
 if(!initial.bank.isOpen){if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!unsafe()||!!s.bankObservation?.(),{timeoutTicks:8})||unsafe())throw Error('bank open unconfirmed');}
 const c=s.client as any,uninstall=installBankDrag(c);
 try{return await runFlatBankSort({tick:()=>s.tick(),unsafe:()=>unsafe()||(s.tick()-began>=o.cap?'tick budget':''),observe:()=>{const b=s.bankObservation?.(),mode=c.var?.[304];if(!b||!c.isBankOpen?.()||![0,1].includes(mode))return null;return{generation:b.generation,mode,rows:c.getBankItems().map((i:BankSortRow)=>({...i}))};},drag:async(from,to,before)=>!!(await s.direct({type:'nativeBankDrag',from,to,mode:c.var[304],before,reason:'SDK'})as any)?.success,wait:(p,ticks)=>waitUntil(s,p,{timeoutTicks:ticks})},o);}
 finally{uninstall();}
}
if(import.meta.main){
 const name=process.argv[2],cap=Number(process.argv[3]??200),maxMoves=Number(process.argv[4]??100),policy=process.argv[5]??'name';if(!name||!['name','donor'].includes(policy))throw Error('usage: microbot-bank-sort.ts account [cap] [maxMoves] [name|donor]');
 let stopped=false;const stop=()=>stopped||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${name}`)||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE),s=await openBot(name,{onStop:async()=>{stopped=true;}});
 try{const result=await sortNativeBank(s,{cap,maxMoves,policy:policy as BankSortPolicy},stop);console.log('BANK_SORT '+JSON.stringify(result));if(!await settle([s],true,JSON.stringify(result)))process.exitCode=1;}catch(error){await settle([s],false,String(error));process.exitCode=1;}
}
