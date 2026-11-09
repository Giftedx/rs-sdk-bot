import type {Session} from '../packages/core/src/inprocess';
import {interactionApproach} from '../packages/core/src/world';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {ClientProt} from '../vendor/rs-sdk/server/webclient/src/io/ClientProt';

// Shared with the orb worker: the native floor reach rule precedes OPLOC1.
export function installOrbFloorBridge(client:unknown,approach:{x:number;z:number}){
 const c=client as any;if(!c||typeof c.executeBotAction!=='function')throw Error('orb native floor executor absent');const original=c.executeBotAction;
 const bridge=function(this:unknown,a:any){if(a?.type!=='orbFloorLoc')return original.call(c,a);if(a.x!==3097||a.z!==3468||![1568,1570].includes(a.locId)||!c.isInGame()||!c.localPlayer)throw Error('orb native floor target invalid');const at=c.toSceneTile(a.x,a.z),from=c.toSceneTile(approach.x,approach.z),info=at&&c.locSceneInfo(at.x,at.z,a.locId);if(!at||!from||Math.max(Math.abs(approach.x-a.x),Math.abs(approach.z-a.z))>1||info?.shape!==22||c.localPlayer.routeX[0]!==from.x||c.localPlayer.routeZ[0]!==from.z)throw Error('orb native floor needs observed exact tile');c.writeOpcode(ClientProt.OPLOC1);c.out.p2(a.x);c.out.p2(a.z);c.out.p2(a.locId);return{success:true};};c.executeBotAction=bridge;return()=>{if(c.executeBotAction===bridge)c.executeBotAction=original;};
}
type Tile={x:number;z:number;level:number};
type Step=({kind:'walk';tol:number}&Tile)|{kind:'enter'|'exit'};
const dungeon=(p:Tile)=>p.z>=9000;
const knownDungeon=(p:Tile)=>p.x>=3070&&p.x<=3145&&p.z>=9830&&p.z<=9950;
export function edgevilleRoute(from:Tile,to:Tile,target:'druid'|'giant',tol=2):Step[]{
 if(from.level!==0||to.level!==0||![from.x,from.z,to.x,to.z,tol].every(Number.isSafeInteger)||tol<0)throw Error('combat travel needs observed native ground');
 const goal:Step={kind:'walk',...to,tol};if(dungeon(from)===dungeon(to))return[goal];
 if(dungeon(from)&&!knownDungeon(from)||dungeon(to)&&!knownDungeon(to))throw Error('combat travel unknown dungeon crossing');
 const point=(x:number,z:number,tol=1):Step=>({kind:'walk',x,z,level:0,tol});
 if(!dungeon(from))return[point(3097,3468),{kind:'enter'},...target==='druid'?[point(3131,9916),point(3131,9921)]:[],goal];
 return[...target==='druid'&&from.z>=9919?[point(3131,9921),point(3131,9916)]:[],point(3096,9867),{kind:'exit'},goal];
}

// Install before a consumer binds its executor, and retain it through bank cleanup.
export function createEdgevilleTravel(original:Session){
 const client=original.client as any,first=original.sdk.getState()?.player,approach={x:3097,z:3467},life=first?.lifeId,respawns=first?.respawnCount??0,restore=installOrbFloorBridge(client,approach),executor=client.executeBotAction;
 let ended=false,closed=false;const close=()=>{if(!closed){closed=true;restore();}};void original.ended.then(()=>{ended=true;close();});
 return{close,async walk(s:Session,target:'druid'|'giant',to:Tile,ground:(x:number,z:number,tol:number)=>Promise<boolean>,stop:()=>boolean,tol=2){
  const guard=()=>{const p=s.sdk.getState()?.player;if(closed||ended||stop()||s.client!==client||client.executeBotAction!==executor||!Number.isSafeInteger(life)||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||p.level!==0||(s.sdk.getSkill('Hitpoints')?.level??0)<=0)throw Error('combat travel original owner/life/stop');return p;};
  const near=(at:Tile,r=3)=>{const p=guard();return p.level===at.level&&Math.max(Math.abs(p.worldX-at.x),Math.abs(p.worldZ-at.z))<=r;};
  const move=async(x:number,z:number,tol:number)=>{guard();if(!await ground(x,z,tol)||!near({x,z,level:0},tol))throw Error('combat travel ground arrival missing');guard();};
  const cross=async(id:number,at:Tile,landed:()=>boolean)=>{
   guard();const loc=s.sdk.getState()?.nearbyLocs.find(l=>l.id===id&&l.x===at.x&&l.z===at.z&&l.level===0&&l.optionsWithIndex.some(o=>o.opIndex===1));if(!loc)throw Error('combat travel exact native transition absent '+id);
   const geometry={id,shape:id===1755?10:22,angle:id===1755?0:2,width:1,height:1,blockAccessFlags:0,src:id===1755?'maps/m48_154.jm2:7044':'maps/m48_54.jm2',configSrc:id===1755?'scripts/_unpack/225/all.loc:9862':'general_use/scripts/trapdoors.rs2'};
   const endpoint=await interactionApproach(s.sdk,at,geometry);if(!endpoint)throw Error('combat travel native approach absent');await move(endpoint.x,endpoint.z,0);guard();
   if(!s.sdk.getState()?.nearbyLocs.some(l=>l.id===id&&l.x===at.x&&l.z===at.z&&l.level===0))throw Error('combat travel transition changed before input');
   const pack=JSON.stringify(s.sdk.getInventory()),gear=JSON.stringify(s.sdk.getEquipment());let reply='';
   try{if(id===1755)await s.sdk.sendInteractLoc(at.x,at.z,id,1);else{Object.assign(approach,endpoint);await s.direct({type:'orbFloorLoc',x:at.x,z:at.z,locId:id,reason:'observed combat dungeon trapdoor'});}}catch(error){reply=String(error);}
   if(!await waitUntil(s,()=>{guard();return landed();},{timeoutTicks:20})||!landed())throw Error('combat travel transition outcome unknown; no repeat '+id+' '+reply);
   if(JSON.stringify(s.sdk.getInventory())!==pack||JSON.stringify(s.sdk.getEquipment())!==gear)throw Error('combat travel transition changed owned assets');
  };
  const p=guard(),steps=edgevilleRoute({x:p.worldX,z:p.worldZ,level:p.level},to,target,tol);
  for(const step of steps){guard();if(step.kind==='walk'){await move(step.x,step.z,step.tol);continue;}
   if(step.kind==='enter'){
    const at={x:3097,z:3468,level:0};if(s.sdk.getState()?.nearbyLocs.some(l=>l.id===1568&&l.x===at.x&&l.z===at.z))await cross(1568,at,()=>s.sdk.getState()?.nearbyLocs.some(l=>l.id===1570&&l.x===at.x&&l.z===at.z)===true);
    await cross(1570,at,()=>near({x:3096,z:9867,level:0}));
   }else await cross(1755,{x:3096,z:9867,level:0},()=>near({x:3096,z:3467,level:0}));
   if(!await waitUntil(s,()=>{guard();return(s.sdk.getState()?.player?.animId??-1)===-1;},{timeoutTicks:12}))throw Error('combat travel animation did not settle');await waitTicks(s,3);guard();
  }
  return near(to,tol);
 }};
}
