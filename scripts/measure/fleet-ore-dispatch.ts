// Native dispatch timestamps; optional synthetic HP publication reaches BOTH SDK HP readers.
import {resolve} from 'node:path';
import {BotSDK} from '../../vendor/rs-sdk/sdk/index';
const vendor=(p:string)=>resolve(import.meta.dir,'../../vendor/rs-sdk',p);
await import(vendor('server/webclient/src/lite/dom-shim.ts'));
const {LiteClient}=await import(vendor('server/webclient/src/lite/LiteClient.ts'));
const execute=LiteClient.prototype.executeBotAction,rockIds=new Set([2090,2091,2092,2093,2094,2095,2108,2109]);
let mineCalls=0,acceptedMine=0,afterDrop=0,armed=false,injected=false,overlay=false,nativeHp:number|undefined,dropTick:number|undefined,latestTick=-1;
const mineEvents:{tick:number;locId:number;afterSyntheticDrop:boolean}[]=[];
LiteClient.prototype.executeBotAction=function(this:any,a:any){
 const mine=a.type==='interactLoc'&&rockIds.has(a.locId);if(mine){mineCalls++;if(injected)afterDrop++;mineEvents.push({tick:latestTick,locId:a.locId,afterSyntheticDrop:injected});}
 const tap=(r:any)=>{if(mine&&r?.success){acceptedMine++;if(process.env.FORCE_ORE_DAMAGE==='1'&&!injected)armed=true;}return r;};
 const r=execute.call(this,a);return r instanceof Promise?r.then(tap):tap(r);
};
const getState=BotSDK.prototype.getState,getSkill=BotSDK.prototype.getSkill;
function fault(s:ReturnType<typeof getState>){
 if(!s)return false;latestTick=s.tick;if(!armed)return false;
 const stat=s.skills.find(v=>v.name==='Hitpoints');
 if(!injected){injected=true;overlay=true;nativeHp=stat?.level;dropTick=s.tick;console.log('CONTROLLED_HP_PUBLICATION '+JSON.stringify({synthetic:true,nativeHp,reportedHp:8,tick:dropTick,trigger:'after first accepted native Mine; both getState/getSkill; no NPC attribution'}));}
 if(overlay&&!s.inventory.some(i=>i.id===2309)){overlay=false;console.log('CONTROLLED_HP_PUBLICATION_END '+JSON.stringify({tick:s.tick,nativeHp:stat?.level,reason:'actual owned Bread debit observed'}));}
 return overlay;
}
BotSDK.prototype.getState=function(){const s=getState.call(this);if(!fault(s)||!s)return s;return {...s,skills:s.skills.map(v=>v.name==='Hitpoints'?{...v,level:8}:v),player:s.player?{...s.player,hp:8}:s.player};};
BotSDK.prototype.getSkill=function(name:string){const actual=getSkill.call(this,name);if(name.toLowerCase()!=='hitpoints')return actual;const active=fault(getState.call(this));return active&&actual?{...actual,level:8}:actual;};
process.on('exit',()=>console.log('ORE_DISPATCH_PROOF '+JSON.stringify({mineCalls,acceptedMine,mineCallsAfterDrop:afterDrop,mineEvents,synthetic:process.env.FORCE_ORE_DAMAGE==='1',injected,nativeHp,dropTick})));
