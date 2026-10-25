// Read-only native Imp708 lifecycle/hero-drop observer. No game actions.
import {BotSDK} from '../../vendor/rs-sdk/sdk/index';
const get=BotSDK.prototype.getState;let signature='',lastTick=-1;
const loot=new Set([592,1470,1472,1474,1476]);
const attack=BotSDK.prototype.sendInteractNpc;
BotSDK.prototype.sendInteractNpc=function(this:BotSDK,...args:Parameters<typeof attack>){const st=this.getState(),n=st?.nearbyNpcs.find(v=>v.index===args[0]);if(st?.player&&n?.id===708)console.log('IMP_ATTACK_CALL '+JSON.stringify({tick:st.tick,pos:[st.player.worldX,st.player.worldZ,st.player.level],npcIndex:n.index,target:[n.tileX??n.x,n.tileZ??n.z],autoRetaliate:st.autoRetaliateEnabled,distance:Math.max(Math.abs((n.tileX??n.x)-st.player.worldX),Math.abs((n.tileZ??n.z)-st.player.worldZ))}));return attack.apply(this,args);};
BotSDK.prototype.getState=function(){
 const s=get.call(this);if(!s?.inGame||!s.player)return s;
 const frame={tick:s.tick,autoRetaliate:s.autoRetaliateEnabled,combat:s.player.combat,heldLoot:Object.fromEntries([...loot].map(id=>[id,s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)])),pos:[s.player.worldX,s.player.worldZ,s.player.level],hp:s.skills.find(v=>v.name==='Hitpoints')?.level,attackXp:s.skills.find(v=>v.name==='Attack')?.experience,
 imps:s.nearbyNpcs.filter(n=>n.id===708).map(n=>({id:n.id,index:n.index,x:n.x,z:n.z,tileX:n.tileX,tileZ:n.tileZ,hp:n.hp,maxHp:n.maxHp,anim:n.animId,inCombat:n.inCombat,target:n.targetIndex})),
 ground:s.groundItems.filter(i=>loot.has(i.id)).map(i=>({id:i.id,count:i.count,x:i.x,z:i.z})),
 threats:s.nearbyNpcs.filter(n=>n.id!==708&&n.distance<=12).map(n=>({id:n.id,index:n.index,name:n.name,x:n.tileX??n.x,z:n.tileZ??n.z,distance:n.distance,target:n.targetIndex,inCombat:n.inCombat})),
 players:s.nearbyPlayers.map(p=>({index:p.index,x:p.x,z:p.z,inCombat:p.inCombat,targetType:p.combatTargetType,target:p.combatTargetIndex}))};
 const key=JSON.stringify({...frame,tick:0});if(key!==signature||s.tick!==lastTick){signature=key;lastTick=s.tick;console.log('IMP_FRAME '+JSON.stringify(frame));}
 return s;
};
