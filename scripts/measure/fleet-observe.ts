// Read-only proof meter. Return the exact SDK state; issue no game actions.
import {BotSDK} from '../../vendor/rs-sdk/sdk/index';
import {resolve} from 'node:path';
const vendor=(path:string)=>resolve(import.meta.dir,'../../vendor/rs-sdk',path);
const original=BotSDK.prototype.getState;
const expectedSkills: {name:string;level:number;xp:number}[]|null=process.env.PROOF_EXPECT_SKILLS?JSON.parse(process.env.PROOF_EXPECT_SKILLS):null;
let pathSignature='';
let signature='',progressTick=0,stallSent=false,lastReply:unknown=null;
await import(vendor('server/webclient/src/lite/dom-shim.ts'));
const {LiteClient}=await import(vendor('server/webclient/src/lite/LiteClient.ts'));
const execute=LiteClient.prototype.executeBotAction;
LiteClient.prototype.executeBotAction=function(this:any,action:any){
 const tap=(reply:any):any=>{if(action.type==='walkTo'||action.type==='interactLoc'){lastReply={action,reply};if(reply?.success===false || stallSent)console.log('PROOF_REPLY '+JSON.stringify(lastReply));}return reply;};
 const result=execute.call(this,action);
 return result instanceof Promise?result.then(tap):tap(result);
};
let life:number|undefined, respawns=0, started=false, died=false, hpMin=Infinity, finalHp=0, unready=0;
BotSDK.prototype.getState=function(){
 const st=original.call(this), p=st?.player;
 if(st?.inGame && p){
  const stat=st.skills.find(s=>/^hitpoints$/i.test(s.name));
  if(!started){
   if(!stat || stat.level<=0 || stat.baseLevel<=0){unready++;return st;}
   if(expectedSkills){const mismatch=expectedSkills.filter((e,i)=>{const actual=st.skills[i];return !actual||actual.name!==e.name||actual.level!==e.level||actual.baseLevel!==e.level||actual.experience!==e.xp;});if(mismatch.length){console.log('PROOF_SKILL_MISMATCH '+JSON.stringify({expected:mismatch,actual:st.skills}));throw new Error('exact practice skill readiness mismatch before quest input');}console.log('PROOF_SKILLS_EXACT true');}
   started=true;life=p.lifeId;respawns=p.respawnCount??0;
   console.log('PROOF_SKILLS '+JSON.stringify(st.skills.map(s=>({name:s.name,level:s.level,baseLevel:s.baseLevel,experience:s.experience}))));
   console.log(`PROOF_READY tick=${st.tick} hp=${stat.level} base=${stat.baseLevel} unreadySamples=${unready}`);
  }
  if(p.isDead || (p.respawnCount??0)>respawns || (life!==undefined && p.lifeId!==life)) died=true;
  const hp=stat?.level;
  if(hp!==undefined){if(Number.isFinite(hpMin)&&hp<hpMin)console.log('PROOF_DAMAGE '+JSON.stringify({tick:st.tick,hp,previousMin:hpMin,pos:[p.worldX,p.worldZ,p.level],npcs:st.nearbyNpcs.filter(n=>n.distance<=8)}));hpMin=Math.min(hpMin,hp);finalHp=hp;}
  if(process.env.PROOF_TRACE_PATH==='1'){const key=`${p.worldX},${p.worldZ},${p.level}`;if(key!==pathSignature){pathSignature=key;console.log('PROOF_PATH '+JSON.stringify({tick:st.tick,pos:[p.worldX,p.worldZ,p.level],hp,nearBears:st.nearbyNpcs.filter(n=>n.id===105&&n.distance<=12).map(n=>({index:n.index,x:n.tileX??n.x,z:n.tileZ??n.z,distance:n.distance,target:n.targetIndex}))}));}}
  const now=JSON.stringify([p.worldX,p.worldZ,p.level,st.inventory.map(i=>[i.id,i.count]),st.skills.map(s=>s.experience)]);
  if(now!==signature){signature=now;progressTick=st.tick;stallSent=false;}
  if(!stallSent && st.tick-progressTick>=20){
   stallSent=true;
   console.log('PROOF_STALL '+JSON.stringify({tick:st.tick,stillTicks:st.tick-progressTick,pos:[p.worldX,p.worldZ,p.level],lastReply,dialog:st.dialog,shop:st.shop?.isOpen,locs:st.nearbyLocs.filter(l=>Math.max(Math.abs(l.x-p.worldX),Math.abs(l.z-p.worldZ))<=4),messages:st.gameMessages.filter(m=>m.type===0).slice(-4)}));
  }
 }
 return st;
};
process.on('exit',()=>console.log(`PROOF_SURVIVAL started=${started} died=${died} hpMin=${hpMin} finalHp=${finalHp}`));
