// Finite owned bank kit; adapted QoL loadEquipment/loadInventory behavior.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {componentId} from '../packages/core/src/logout';
import {withdrawFireOwned} from './gather-fire-giants';

type Count={id:number;count:number};type Worn=Count&{slot:number};
export type OwnedKit={bank:{x:number;z:number;level:number};pack:Count[];wear:Worn[];cap:number;maximumMoves:number};
const content='vendor/rs-sdk/server/content/';
const whole=(n:unknown,min=0,max=2147483647)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
const canonical=(a:readonly Count[])=>Object.entries(a.reduce((m,i)=>(m[i.id]=(m[i.id]??0)+i.count,m),{}as Record<number,number>)).map(([id,count])=>({id:Number(id),count})).sort((a,b)=>a.id-b.id);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const wornView=(a:readonly Worn[])=>a.map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((a,b)=>a.slot-b.slot);
const itemCache=new Map<number,ReturnType<typeof readNativeKitItem>>();
export function nativeKitItem(id:number){
 const cached=itemCache.get(id);if(cached)return cached;const item=readNativeKitItem(id);itemCache.set(id,item);return item;
}
function readNativeKitItem(id:number){
 const items=JSON.parse(readFileSync('knowledge/items.json','utf8'))as {id:number;name:string;debugname:string;src:string;members:boolean}[];
 const packed=readFileSync(content+'pack/obj.pack','utf8').split(/\r?\n/).find(l=>l.startsWith(id+'='))?.split('=')[1],noted=!!packed?.startsWith('cert_');
 const item=items.find(i=>noted?i.debugname===packed!.slice(5):i.id===id);
 if(!item||!whole(id))throw Error('unknown native kit item '+id);
 const block=readFileSync(content+item.src.replace(/:\d+$/,''),'utf8').split('['+item.debugname+']')[1]?.split('\n[')[0];if(!block)throw Error('native item definition absent '+id);
 const fields=(key:string)=>block.match(new RegExp('^'+key+'=([^\\r\\n]+)','m'))?.[1];
 const slots:Record<string,number>={hat:0,back:1,front:2,righthand:3,torso:4,lefthand:5,arms:6,legs:7,head:8,hands:9,feet:10,jaw:11,ring:12,quiver:13};
 const slot=fields('wearpos'),extra=[fields('wearpos2'),fields('wearpos3')].filter((x):x is string=>!!x);
 const styles=readFileSync(content+'scripts/skill_combat/scripts/player/player_attackstyles.rs2','utf8'),category=fields('category'),tab=[...styles.matchAll(/case ([\w, ]+) : ~weapon_category_tab_attack\((combat_\w+):preview/g)].find(m=>m[1]!.split(/,\s*/).includes(category??''))?.[2]??'combat_unarmed';
 const styleIndices=[...styles.matchAll(new RegExp('\\[if_button,'+tab+':[^\\]]+\\] ~set_attackstyle\\((\\d+)\\);','g'))].map(m=>Number(m[1]));
 return{...item,id,baseId:item.id,stackable:noted||fields('stackable')==='yes',slot:noted||slot===undefined?undefined:slots[slot],occupies:[slot,...extra].filter((x):x is string=>!!x).map(x=>slots[x]),noted,styleIndices,styleTab:componentId(tab)};
}
export function validateOwnedKit(value:unknown):OwnedKit{
 const j=value as OwnedKit;if(!j||typeof j!=='object'||!j.bank||![j.bank.x,j.bank.z,j.bank.level].every(n=>whole(n))||j.bank.x>16383||j.bank.z>16383||j.bank.level>3||!Array.isArray(j.pack)||!Array.isArray(j.wear)||j.pack.length>28||j.wear.length>14||!whole(j.cap,120,2000)||!whole(j.maximumMoves,64,256))throw Error('invalid finite owned kit');
 if(new Set(j.pack.map(i=>i.id)).size!==j.pack.length||new Set(j.wear.map(i=>i.slot)).size!==j.wear.length)throw Error('duplicate kit item or worn slot');
 for(const row of [...j.pack,...j.wear])if(!row||!whole(row.id)||!whole(row.count,1))throw Error('invalid kit quantity');
 const occupied=new Set<number>();for(const row of j.wear){const item=nativeKitItem(row.id);if(!whole(row.slot,0,13)||item.slot!==row.slot||item.noted||!item.stackable&&row.count!==1)throw Error('native worn slot/count mismatch '+row.id);for(const slot of item.occupies){if(slot===undefined||occupied.has(slot))throw Error('conflicting native worn slots/two-handed shield');occupied.add(slot);}}
 for(const row of j.pack)nativeKitItem(row.id);
 return j;
}
export function loadoutStopRequested(actor:string,stop:()=>boolean=()=>false,exists:(p:string)=>boolean=existsSync){return stop()||exists('.practice/stop-all')||exists(`.practice/stop-${actor}`)||!!process.env.STOP_FILE&&exists(process.env.STOP_FILE);}
export async function runOwnedLoadout(s:Session,value:unknown,requestStop:()=>boolean=()=>false){
 const j=validateOwnedKit(value),start=s.tick(),state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),gear=()=>s.sdk.getEquipment(),first=state()?.player;
 const life=first?.lifeId,respawns=first?.respawnCount??0,hp=s.sdk.getSkill('Hitpoints')?.level??0,client=s.client as any,executor=client.executeBotAction;
 const xpView=()=>state()?.skills.map(i=>({name:i.name,experience:i.experience,baseLevel:i.baseLevel})),xp=JSON.stringify(xpView()),controls=()=>({retaliate:state()?.autoRetaliateEnabled,prayers:state()?.prayers?.activePrayers,style:state()?.combatStyle?.currentStyle}),initialControls=JSON.parse(JSON.stringify(controls())),initialWear=wornView(gear());
 let ended=false,moves=0,uncertain=false,baseline:Count[]|undefined,bankGeneration=-1,changed=false,failure='',recovered=false,noOp=false,initialNote:boolean|undefined,bankModeRestored=false;
 void s.ended?.then(()=>{ended=true;});
 const held=(id:number)=>inv().filter(i=>i.id===id).reduce((a,i)=>a+i.count,0),stored=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((a,i)=>a+i.count,0);
 const here=()=>{const p=state()?.player;return!!p&&p.level===j.bank.level&&Math.max(Math.abs(p.worldX-j.bank.x),Math.abs(p.worldZ-j.bank.z))<=3;};
 const fatal=()=>ended||!first||!state()?.player||state()!.player!.isDead||state()!.player!.lifeId!==life||(state()!.player!.respawnCount??0)!==respawns||!here()||(s.sdk.getSkill('Hitpoints')?.level??0)!==hp||hp<1||s.sdk.getStateAge()>5000||client.executeBotAction!==executor||!equipmentObserved(client)||JSON.stringify(xpView())!==xp;
 const guard=(cleanup=false)=>{if(fatal()||s.tick()-start>=j.cap||moves>=j.maximumMoves||!cleanup&&(loadoutStopRequested(s.name??'',requestStop)||s.tick()-start>=j.cap-40||moves>=j.maximumMoves-32))throw Error('owned loadout life/state/stop/budget');};
 const assets=()=>{const bank=s.bankObservation?.();if(!state()?.bank.isOpen||!bank)throw Error('owned loadout fresh bank observation absent');return canonical([...inv(),...gear(),...bank.items].map(i=>({id:client.objType(i.id)?.certtemplate>=0?client.objType(i.id).certlink:i.id,count:i.count})));};
 const conserved=()=>!!baseline&&same(assets(),baseline);
 const close=async(cleanup=false)=>{guard(cleanup);bankGeneration=Math.max(bankGeneration,s.bankObservation?.()?.generation??-1);await s.sdk.sendCloseModal();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('owned loadout bank close unobserved');guard(cleanup);};
 const open=async(cleanup=false)=>{guard(cleanup);if(state()?.bank.isOpen)await close(cleanup);const result=await s.bot.openBank();if(!await waitUntil(s,()=>{if(fatal())throw Error('owned loadout lost original session');return !!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>bankGeneration;},{timeoutTicks:12})||!state()?.bank.isOpen||!s.bankObservation?.())throw Error('owned loadout fresh bank generation unavailable '+result.success);bankGeneration=s.bankObservation!()!.generation;guard(cleanup);};
 const move=async(action:()=>Promise<unknown>,effect:()=>boolean,cleanup=false)=>{guard(cleanup);moves++;uncertain=true;changed=true;const at=s.tick();let error:unknown;try{await action();}catch(e){error=e;}const remaining=10-(s.tick()-at);if(!effect()&&remaining>0)await waitUntil(s,()=>{if(fatal())throw Error('owned loadout original life/input owner lost');return effect();},{timeoutTicks:remaining});if(!effect())throw Error('owned loadout asset action unknown; no retry '+String(error??''));uncertain=false;};
 const deposit=async(cleanup=false)=>{for(const id of new Set(inv().map(i=>i.id))){guard(cleanup);const row=inv().find(i=>i.id===id)!;await move(()=>depositObserved(s,row),()=>held(id)===0&&conserved(),cleanup);}};
 const withdraw=async(id:number,n:number,cleanup=false)=>{guard(cleanup);const item=nativeKitItem(id),base=item.baseId,before=held(id),old=stored(base),generation=s.bankObservation!()!.generation;await move(async()=>{if(!item.noted)return withdrawFireOwned(s,id,n);const row=state()?.bank.items.find(i=>i.id===base);if(!row||stored(base)!==row.count||row.count<n)throw Error('owned noted bank stock unknown');await s.bot.withdrawItem(row,n,{asNote:true});},()=>held(id)===before+n&&stored(base)===old-n&&(s.bankObservation?.()?.generation??-1)>generation&&conserved(),cleanup);};
 const removeAll=async(cleanup=false)=>{if(state()?.bank.isOpen)await close(cleanup);for(const row of [...gear()]){const before=held(row.id),old=canonical([...inv(),...gear()]);await move(()=>s.bot.unequipItem(row),()=>!gear().some(i=>i.slot===row.slot)&&held(row.id)===before+row.count&&same(canonical([...inv(),...gear()]),old),cleanup);}await open(cleanup);await deposit(cleanup);};
 const equip=async(row:Worn,cleanup=false)=>{await withdraw(row.id,row.count,cleanup);await close(cleanup);const item=inv().find(i=>i.id===row.id)!,before=held(row.id),old=canonical([...inv(),...gear()]);await move(()=>s.bot.equipItem(item),()=>gear().some(i=>i.slot===row.slot&&i.id===row.id&&i.count===row.count)&&held(row.id)===before-row.count&&same(canonical([...inv(),...gear()]),old),cleanup);await open(cleanup);if(!conserved())throw Error('owned loadout equip bank conservation failed');};
 const restoreStyle=async(cleanup=false)=>{guard(cleanup);const expected=initialControls.style,style=()=>state()?.combatStyle,weapon=gear().find(i=>i.slot===3),tab=weapon?nativeKitItem(weapon.id).styleTab:componentId('combat_unarmed'),ready=()=>{const observed=style();return observed?.known===true&&observed.tabInterfaceId===tab&&observed.styles.some(i=>i.index===expected);};if(!await waitUntil(s,()=>fatal()||ready(),{timeoutTicks:8})||fatal()||!ready())throw Error('owned loadout target native combat style unavailable');if(style()?.currentStyle===expected)return;await close(cleanup);await s.sdk.sendSetCombatStyle(expected);if(!await waitUntil(s,()=>fatal()||ready()&&style()?.currentStyle===expected,{timeoutTicks:8})||fatal()||!ready()||style()?.currentStyle!==expected)throw Error('owned loadout original combat style restore unconfirmed');await open(cleanup);};
 try{
  guard();if(!first||!Number.isSafeInteger(life)||!equipmentObserved(client)||state()?.combatStyle?.known!==true||initialControls.retaliate===undefined)throw Error('owned loadout initial controls/gear unknown');await open();baseline=assets();initialNote=state()?.bank.noteMode;if(typeof initialNote!=='boolean')throw Error('owned loadout bank note control unknown');
  for(const row of [...j.pack,...j.wear]){const item=nativeKitItem(row.id),native=client.objType(row.id);if(item.noted&&(!native||!Number.isSafeInteger(native.certtemplate)||native.certtemplate<0||native.certlink!==item.baseId))throw Error('native noted identity mismatch');}
  const need=canonical([...j.pack,...j.wear].map(i=>({id:nativeKitItem(i.id).baseId,count:i.count})));if(need.some(i=>(baseline!.find(x=>x.id===i.id)?.count??0)<i.count))throw Error('owned loadout stock missing before withdrawals');
  const slots=j.pack.reduce((n,i)=>{const t=client.objType(i.id);if(typeof t?.stackable!=='boolean')throw Error('native stackability unknown');return n+(t.stackable?1:i.count);},0);if(slots>28)throw Error('owned loadout exact pack exceeds28 slots');
  if([...j.pack,...j.wear].some(i=>nativeKitItem(i.id).members&&client.membersAccount!==1))throw Error('owned loadout member item requires observed member account');
  const targetWeapon=j.wear.find(i=>i.slot===3),targetStyles=targetWeapon?nativeKitItem(targetWeapon.id).styleIndices:[0,1,2];if(!targetStyles.includes(initialControls.style))throw Error('owned loadout original style incompatible with target native weapon table');
  noOp=same(canonical(inv()),canonical(j.pack))&&same(wornView(gear()),wornView(j.wear));if(!noOp){await deposit();await removeAll();
  for(const row of j.wear)await equip(row);await restoreStyle();
  for(const row of j.pack)await withdraw(row.id,row.count);}
  guard();if(!same(canonical(inv()),canonical(j.pack))||!same(wornView(gear()),wornView(j.wear))||!conserved()||!same(controls(),initialControls))throw Error('owned loadout exact final kit/assets/controls unconfirmed');
 }catch(error){failure=String(error);if(changed&&!uncertain&&!fatal()){try{await open(true);await deposit(true);await removeAll(true);if(initialControls.style>2){const originalWeapon=initialWear.find(i=>i.slot===3);if(!originalWeapon)throw Error('original weapon needed for control recovery');await equip(originalWeapon,true);}await restoreStyle(true);recovered=conserved()&&inv().length===0;}catch(e){failure+='; recovery '+String(e);}}}
 try{if(initialNote!==undefined&&!fatal()&&state()?.bank.isOpen){if(state()!.bank.noteMode!==initialNote){guard(true);await s.sdk.sendClickComponent(initialNote?5386:5387);if(!await waitUntil(s,()=>fatal()||state()?.bank.noteMode===initialNote,{timeoutTicks:8})||fatal())throw Error('owned loadout original bank note mode unconfirmed');}bankModeRestored=state()!.bank.noteMode===initialNote;}}catch(e){failure||=String(e);}
 let balanced=false;try{if(state()?.bank.isOpen&&s.bankObservation?.()&&baseline)balanced=conserved();}catch{}
 const exactPack=same(canonical(inv()),canonical(j.pack)),exactWear=same(wornView(gear()),wornView(j.wear)),controlsPreserved=same(controls(),initialControls);
 try{if(!fatal()&&state()?.bank.isOpen)await close(true);}catch(e){failure||=String(e);}
 return{ok:!failure&&!uncertain&&balanced&&exactPack&&exactWear&&controlsPreserved&&bankModeRestored,failure,exactPack,exactWear,balanced,controlsPreserved,bankModeRestored,noOp,recovered,recoveryDeferred:uncertain,moves,ticks:s.tick()-start,scope:'one declared owned exact bank kit, including native notes; no travel or acquisition'};
}
if(import.meta.main){const [actor,file]=process.argv.slice(2);if(!actor||!file)throw Error('Usage: bun scripts/microbot-owned-loadout.ts <actor> <owned-kit.json>');const input=readFileSync(file);if(input.length>32768)throw Error('owned kit file too large');const job=validateOwnedKit(JSON.parse(input.toString('utf8')));let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(actor);let ok=false;try{const result=await runOwnedLoadout(s,job,()=>stopped);console.log('OWNED_LOADOUT_RESULT '+JSON.stringify(result));ok=result.ok;}finally{ok=await settle([s],ok,'finite owned bank loadout');}process.exitCode=ok?0:1;}
