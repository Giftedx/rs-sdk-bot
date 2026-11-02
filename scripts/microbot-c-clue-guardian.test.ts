import {expect,test} from 'bun:test';
import {nativeClueSteps} from './microbot-c-clues';
import {nativeGuardianClue,runGuardianClue} from './microbot-c-clue-guardian';
import {nativeTeleport} from './microbot-magic-teleport';
test('all thirty native guardian clues resolve exact instruments, NPC and casket',()=>{
 const rows=nativeClueSteps().filter(r=>r.gapType==='guardian').map(r=>nativeGuardianClue(r.id));expect(rows).toHaveLength(30);expect(new Set(rows.map(r=>r.guardian)).size).toBe(2);expect(rows.every(r=>r.tools.length===4&&r.point.level===0&&r.casket>0)).toBe(true);
});
function fixture(wrongOwner=false,guardian='trail_hard',clueId?:number){
 const r=nativeGuardianClue(clueId??nativeClueSteps().find(r=>r.gapType==='guardian'&&r.nativeParams?.includes('trail_guardian,'+guardian))!.id),tele=nativeTeleport('varrock');
 const items:any[]=[{id:r.id,count:1,slot:0},...r.tools.map((id,i)=>({id,count:1,slot:i+1})),{id:379,count:4,slot:5},...[556,558,554,563].map((id,i)=>({id,count:100,slot:i+6}))];
 const player:any={name:'Owned',lifeId:1,respawnCount:0,isDead:false,worldX:r.point.x,worldZ:r.point.z,level:r.point.level};let gameMessages:any[]=[],npcs:any[]=[],prayer=false,xp=100,digs=0,casts=0,tick=0,hp=70;
 const s:any={client:{selfSlot:7,var:{108:0}},tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getStateAge:()=>0,getInventory:()=>items,getEquipment:()=>[{id:1381,slot:3,count:1},{id:1540,slot:5,count:1}],getSkill:(name:string)=>({level:name==='Hitpoints'?hp:name==='Prayer'?60:80}),getSkillXp:()=>xp,isPrayerActive:()=>prayer,getState:()=>({player,autoRetaliateEnabled:false,nearbyPlayers:[],nearbyNpcs:npcs,gameMessages}),sendUseItem:async()=>{digs++;if(digs===1)npcs=[{id:r.npc,index:50,hp:80,targetIndex:32768+(wrongOwner?8:7)}];else{items.splice(items.findIndex(i=>i.id===r.id),1);items.push({id:r.casket,count:1,slot:0});}}},bot:{activatePrayer:async()=>{prayer=true;return{success:true};},deactivatePrayer:async()=>{prayer=false;return{success:true};}}};
 const io={cast:async()=>{casts++;expect(npcs[0].targetIndex).toBe(32775);npcs=[];xp+=10;return{ok:true};},escape:async()=>{player.worldX=tele.to.x;player.worldZ=tele.to.z;player.level=tele.to.level;return{ok:true};}};
 return{s,io,r,casts:()=>casts,setHp:(n:number)=>{hp=n;}};
}
test('guardian repeat-dig casket is final hero proof after exact owned spawn',async()=>{
 const f=fixture();expect(await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60},f.io)).toMatchObject({ok:true,owned:true,casts:1,casket:true,escaped:true,prayerRestored:true,preserved:true});expect(f.casts()).toBe(1);
});
test('foreign guardian target prevents every attack and recovers to Varrock',async()=>{
 const f=fixture(true);let polls=0;f.s.onTick=(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active&&polls++<12){cb();next();}});next();return()=>{active=false;};};
 const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60},f.io);expect(r.ok).toBe(false);expect(r.detail).toContain('ownership');expect(f.casts()).toBe(0);expect(r.escaped).toBe(true);
});

test('Sara setup may take bounded damage before a fresh damage-free fight baseline',async()=>{
 const f=fixture(false,'trail_hard2');let setup=0;
 f.s.sdk.getInventory().push({id:2448,count:1,slot:15});const dig=f.s.sdk.sendUseItem;
 f.s.sdk.sendUseItem=async(slot:number)=>{const i=f.s.sdk.getInventory().find((i:any)=>i.slot===slot);if(i?.id===2448){i.id=181;f.s.sdk.getState().gameMessages.push({type:0,sender:'',fromSelf:false,tick:f.s.tick(),observationId:1,text:'You drink some of your antipoison potion.'},{type:0,sender:'',fromSelf:false,tick:f.s.tick(),observationId:2,text:'You have 3 doses of potion left.'});return{success:true};}return dig();};
 const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:100},{...f.io,setup:async()=>{setup++;f.setHp(60);}});
 expect(setup).toBe(1);expect(r).toMatchObject({ok:true,owned:true,casts:1,casket:true,escaped:true,antidote:true});
});
test('damage during the cast phase never permits a second guardian cast',async()=>{
 const f=fixture();let casts=0;
 const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:80},{...f.io,cast:async()=>{casts++;f.setHp(69);return{ok:false,failure:'damage'};}});
 expect(casts).toBe(1);expect(r.ok).toBe(false);expect(r.casket).toBe(false);expect(r.escaped).toBe(true);
});

test('an explicit ambient budget permits bounded chip damage while preserving the HP floor and default strictness',async()=>{
 for(const hp of [93,74]){const f=fixture();f.setHp(99);let casts=0;
  const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:80,ambientDamage:24},{...f.io,cast:async()=>{casts++;f.setHp(hp);return f.io.cast();}});
  expect(casts).toBe(1);expect(r.allowedFightHpLoss).toBe(24);expect(r.fightHpFloor).toBe(75);expect(r.escaped).toBe(true);
  if(hp===93){expect(r.ok).toBe(true);expect(r.fightHpLost).toBe(6);}else{expect(r.ok).toBe(false);expect(r.casket).toBe(false);}
 }
 const short=fixture();short.setHp(93);await expect(runGuardianClue(short.s,short.r.id,{spell:'wind_strike',maximumCasts:2,cap:80,ambientDamage:24},short.io)).rejects.toThrow('cannot fund');
 await expect(runGuardianClue({}as any,1,{spell:'wind_strike',maximumCasts:2,cap:80,ambientDamage:25})).rejects.toThrow('0..24');
});

import {guardianHeal} from './microbot-c-clue-guardian-travel';
function foodFixture(){
 let tick=0,hp=50;const sent:number[]=[],inventory=[{id:379,slot:0,count:2,optionsWithIndex:[{text:'Eat',opIndex:1}]}];
 const state=()=>({tick,inventory,skills:[{name:'Hitpoints',level:hp,baseLevel:99}]});
 const s:any={tick:()=>tick,sdk:{getState:state,getSkill:()=>({level:hp})},onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},direct:async()=>{sent.push(tick);inventory[0]!.count--;hp+=12;return{success:true};}};
 return{s,sent,tick:()=>tick};
}
test('guardian food debit waits native readiness before another food or action',async()=>{
 const f=foodFixture();await guardianHeal(f.s,{fatal:()=>false,stop:()=>false});
 expect(f.sent).toHaveLength(2);expect(f.sent[1]!-f.sent[0]!).toBeGreaterThanOrEqual(3);expect(f.tick()-f.sent[1]!).toBeGreaterThanOrEqual(3);
});
test('guardian stop during food settlement prevents a second debit',async()=>{
 const f=foodFixture();await expect(guardianHeal(f.s,{fatal:()=>false,stop:()=>f.tick()>=1})).rejects.toThrow('settlement stopped');expect(f.sent).toHaveLength(1);
});

import {guardianExtractionStep} from './microbot-c-clue-guardian-travel';
test('Wilderness extraction steps follow a complete legal route around blocked intermediate tiles',()=>{
 const me={worldX:3058,worldZ:3884,level:0};
 const plan=(_level:number,_from:{x:number;z:number},to:{x:number;z:number})=>to.x===2943&&to.z===3888?[{x:3052,z:3884},{x:3052,z:3850},{x:2943,z:3850},{x:2943,z:3888}]:[{x:3052,z:3866}];
 expect(guardianExtractionStep(me,plan)).toEqual({target:{x:3052,z:3866},exit:{x:2943,z:3888}});
 expect(guardianExtractionStep(me,()=>[{x:3052,z:3866}])).toBeNull();
});

test('foreign arrival aborts guardian casting but permits real owned-rune recovery',async()=>{
 const f=fixture(false,'trail_hard',2743),getState=f.s.sdk.getState;let peers:any[]=[],xp=100,attacks=0,teleports=0;
 f.s.ended=new Promise(()=>{});f.s.sdk.getSkillXp=()=>xp;
 f.s.sdk.getState=()=>({...getState(),nearbyPlayers:peers});f.s.bot.dismissBlockingUI=async()=>{};f.s.sdk.sendCloseModal=async()=>{};
 const dig=f.s.sdk.sendUseItem;f.s.sdk.sendUseItem=async()=>{await dig();for(const n of getState().nearbyNpcs)Object.assign(n,{reachable:true,inCombat:true,optionsWithIndex:[{text:'Attack',opIndex:2}]});};
 f.s.direct=async(a:any)=>{
  const count=(id:number)=>f.s.sdk.getInventory().find((i:any)=>i.id===id);
  if(a.type==='spellOnNpc'){attacks++;count(558).count--;xp+=6;peers=[{name:'Visitor'}];}
  if(a.type==='clickComponent'){teleports++;count(554).count--;count(563).count--;xp+=35;const to=nativeTeleport('varrock').to;Object.assign(getState().player,{worldX:to.x,worldZ:to.z,level:to.level});}
  return{success:true};
 };
 const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:80});
 expect(attacks).toBe(1);expect(teleports).toBe(1);expect(r).toMatchObject({ok:false,casket:false,escaped:true,prayerRestored:true,preserved:true});
});

import {guardianSeparationGoals} from './microbot-c-clue-guardian-travel';
test('Sara separation selects a reachable native corridor instead of blocked away/perpendicular goals',()=>{
 const dig={x:2763,z:2974},me={worldX:dig.x,worldZ:dig.z,level:0},npc={x:2764,z:2974};
 const plan=(_level:number,_from:{x:number;z:number},to:{x:number;z:number})=>to.x===2763&&to.z===2979?[to]:[{x:2763,z:2978}];
 expect(guardianSeparationGoals(dig,me,npc,plan)).toEqual([{x:2763,z:2979}]);
 expect(guardianSeparationGoals(dig,me,npc,plan,()=>false)).toEqual([]);
 expect(guardianSeparationGoals(dig,me,npc,plan,()=>true,()=>false)).toEqual([]);
 const narrow={x:2766,z:2979};expect(guardianSeparationGoals(dig,me,npc,(_level,_from,to)=>to.x===narrow.x&&to.z===narrow.z?[to]:[])).toEqual([narrow]);
 expect(guardianSeparationGoals(dig,me,npc,(_level,_from,to)=>to.z===2982?[to]:[]).every(to=>to.z===2982)).toBe(true);
});

test('Wilderness extraction retains its validated exit when an intermediate latitude has no legal endpoint',()=>{
 const exit={x:2935,z:3963},me={worldX:2954,worldZ:3928,level:0},seen:{x:number;z:number}[]=[];
 const plan=(_level:number,_from:{x:number;z:number},to:{x:number;z:number})=>{seen.push(to);return to.x===exit.x&&to.z===exit.z?[{x:2948,z:3928},exit]:[];};

 const step=guardianExtractionStep(me,plan,exit);expect(step?.exit).toEqual(exit);expect(step?.target).not.toEqual(me);expect(seen).toEqual([exit]);
});

import {guardianExitCandidates} from './microbot-c-clue-guardian-travel';
import {clearGuardianMessage} from './microbot-c-clue-guardian-travel';
test('guardian extraction closes a retained casket page without racing or retrying Continue',async()=>{
 const dialog={isOpen:true,isWaiting:false,options:[{text:'Click here to continue',index:1}]};let clicks=0;
 let tick=0;const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getState:()=>({dialog}),sendCloseModal:async()=>({success:true}),clickDialogByText:async(text:RegExp)=>{expect(text.test(dialog.options[0]!.text)).toBe(true);clicks++;dialog.isWaiting=true;return{success:true};}}},policy={fatal:()=>false,stop:()=>false};
 await clearGuardianMessage(s,policy);expect(clicks).toBe(0);expect(dialog.isOpen).toBe(true);await clearGuardianMessage(s,policy);expect(clicks).toBe(0);
 dialog.isOpen=true;dialog.isWaiting=false;dialog.options.push({text:'No',index:2});await expect(clearGuardianMessage(s,policy)).rejects.toThrow('unexpected');expect(clicks).toBe(0);
});
test('legal exit selection samples walkable boundaries when same-column and lateral goals are blocked',()=>{
 const me={worldX:3159,worldZ:3959,level:0},open={x:3160,z:3679};
 const points=guardianExitCandidates(to=>to.x===open.x&&to.z===open.z);expect(points).toEqual([open]);
 const chosen=guardianExtractionStep(me,(_level,_from,to)=>[to],undefined,to=>to.x===open.x&&to.z===open.z);expect(chosen?.exit).toEqual(open);
 expect(guardianExitCandidates(()=>true).length).toBeLessThanOrEqual(140);
 expect(guardianExtractionStep(me,(_level,_from,to)=>[to],undefined,()=>true,()=>false)).toBeNull();
});

import {installGuardianSaraBridge,requestGuardianSaraAP} from './microbot-c-clue-guardian-travel';
import {guardianStopRequested} from './microbot-c-clue-guardian';
import {ClientProt} from '../vendor/rs-sdk/server/webclient/src/io/ClientProt';
function saraPacketFixture(distance=5){
 let tick=0,health=99,pending=false,held=false,stopped=false,xp=0;const wire:number[][]=[],direct:string[]=[],inventory=[{id:565,count:35,slot:0},{id:554,count:246,slot:1}],player={worldX:2830,worldZ:2908,level:0,lifeId:1,respawnCount:0,isDead:false,combat:{targetType:'none',targetIndex:-1}},npc:any={id:1264,index:50,x:2832+distance,z:2908,size:1,targetIndex:32775,hp:120,animId:-1,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 const native={type:{id:1264},routeX:[32+distance],routeZ:[28]},client:any={selfSlot:7,minusedlevel:0,mapBuildBaseX:2800,mapBuildBaseZ:2880,localPlayer:{routeX:[32],routeZ:[28]},npc:{50:native},isInGame:()=>true,writeOpcode:(op:number)=>{wire.push([op]);if(op===ClientProt.OPNPC2)pending=true;if(op===ClientProt.MOVE_GAMECLICK)held=true;},out:{p1:(v:number)=>wire.at(-1)!.push(v),p2:(v:number)=>wire.at(-1)!.push(v)},executeBotAction:()=>({success:true})};const original=client.executeBotAction;
 const step=()=>{tick++;if(pending&&tick===1){player.combat.targetType='npc';player.combat.targetIndex=50;client.localPlayer.routeX[0]+=2;native.routeX[0]--;npc.x=2800+native.routeX[0];}if(pending&&tick===2){if(held){npc.animId=811;player.combat.targetType='none';player.combat.targetIndex=-1;}else{health-=8;xp+=32;}}};
 const s:any={client,name:'Owned',tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){step();cb();next();}});next();return()=>{active=false;};},sdk:{getState:()=>({player,nearbyNpcs:[npc],nearbyPlayers:[]}),getStateAge:()=>0,getInventory:()=>inventory,getSkill:()=>({level:health}),getSkillXp:()=>xp,isPrayerActive:()=>true,sendInteractNpc:async()=>{throw Error('SDK auto-route must not be used');}},direct:async(a:any)=>{direct.push(a.type);return client.executeBotAction(a);}};
 return{s,client,native,npc,player,wire,direct,inventory,original,step,tick:()=>tick,xp:()=>xp,hp:()=>health,setStop:()=>{stopped=true;},policy:{fatal:()=>false,stop:()=>stopped}};
}
test('Sara AP emits bound OPNPC2 without client route, then a real stationary packet after one native cycle',async()=>{const f=saraPacketFixture(),before=JSON.stringify(f.inventory);expect(await requestGuardianSaraAP(f.s,50,1264,f.policy,()=>true)).toBe(true);expect(f.direct).toEqual(['guardianSaraAttack','guardianSaraHold']);expect(f.wire).toEqual([[ClientProt.OPNPC2,50],[ClientProt.MOVE_GAMECLICK,5,0,2834,2908]]);expect(f.npc.animId).toBe(811);expect(f.hp()).toBe(99);expect(f.xp()).toBe(0);expect(JSON.stringify(f.inventory)).toBe(before);expect(f.client.executeBotAction).toBe(f.original);});
test('Sara packet checks received native head separation, not interpolated displayed position',async()=>{for(const distance of[3,4,6]){const f=saraPacketFixture(distance);await expect(requestGuardianSaraAP(f.s,50,1264,f.policy,()=>true)).rejects.toThrow('five native tiles');expect(f.wire).toEqual([]);expect(f.client.executeBotAction).toBe(f.original);}});
test('Sara private owner, observed identity, LOS, prayer, peer and original life cannot authorize an AP packet',async()=>{for(const mode of['owner','id','sight','prayer','peer','stop','dead']){const f=saraPacketFixture();if(mode==='owner')f.npc.targetIndex=32776;if(mode==='id')f.native.type.id=1265;if(mode==='prayer')f.s.sdk.isPrayerActive=()=>false;if(mode==='peer'){const get=f.s.sdk.getState;f.s.sdk.getState=()=>({...get(),nearbyPlayers:[{name:'Visitor'}]});}if(mode==='stop')f.setStop();if(mode==='dead')f.player.isDead=true;await expect(requestGuardianSaraAP(f.s,50,1264,f.policy,()=>mode!=='sight')).rejects.toThrow();expect(f.wire).toEqual([]);expect(f.client.executeBotAction).toBe(f.original);}});
test('Sara hold cannot happen in same publication or after a skipped native cycle, and executor restoration keeps another owner',()=>{const f=saraPacketFixture(),restore=installGuardianSaraBridge(f.s,50,1264,f.policy,()=>true);f.client.executeBotAction({type:'guardianSaraAttack',index:50,npcId:1264});expect(()=>f.client.executeBotAction({type:'guardianSaraHold',index:50,npcId:1264})).toThrow('fresh native cycle');f.step();f.step();expect(()=>f.client.executeBotAction({type:'guardianSaraHold',index:50,npcId:1264})).toThrow();expect(f.wire).toEqual([[ClientProt.OPNPC2,50]]);const other=()=>({success:true});f.client.executeBotAction=other;restore();expect(f.client.executeBotAction).toBe(other);});
test('Sara unknown packet response never repeats attack or pays a spell before pose',async()=>{const f=saraPacketFixture(),send=f.s.direct;f.s.direct=async(a:any)=>{await send(a);throw Error('lost native AP reply');};await expect(requestGuardianSaraAP(f.s,50,1264,f.policy,()=>true)).rejects.toThrow('lost native');expect(f.direct).toEqual(['guardianSaraAttack']);expect(f.wire).toEqual([[ClientProt.OPNPC2,50]]);expect(f.client.executeBotAction).toBe(f.original);});
test('Sara cached mage pose does not confirm an unprocessed hold or a continuing player melee target',async()=>{const f=saraPacketFixture();f.npc.animId=811;expect(await requestGuardianSaraAP(f.s,50,1264,f.policy,()=>true)).toBe(true);expect(f.tick()).toBe(2);const g=saraPacketFixture(),get=g.s.sdk.getState;g.s.sdk.getState=()=>({...get(),player:{...g.player,combat:{targetType:'npc',targetIndex:50}}});expect(await requestGuardianSaraAP(g.s,50,1264,g.policy,()=>true)).toBe(false);expect(g.tick()).toBeLessThanOrEqual(13);expect(g.direct).toEqual(['guardianSaraAttack','guardianSaraHold']);expect(g.client.executeBotAction).toBe(g.original);});
test('guardian global, account and role stops enter the actual existing consumer before dig/cast without shared files',async()=>{for(const path of['.practice/stop-all','.practice/stop-Owned','owned-guardian.stop']){const f=fixture();const stop=()=>guardianStopRequested('Owned',()=>false,p=>p===path,'owned-guardian.stop');const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60,stop},f.io);expect(r).toMatchObject({ok:false,cancelled:true,casts:0});expect(f.casts()).toBe(0);}expect(guardianStopRequested('Owned',()=>false,()=>false,undefined)).toBe(false);});
test('Sara initial stop preserves antidote and sends no item or prayer input before preparation',async()=>{for(const path of['.practice/stop-all','.practice/stop-Owned','guardian-role.stop']){const f=fixture(false,'trail_hard2');f.s.sdk.getInventory().push({id:2448,count:1,slot:15});const before=JSON.stringify(f.s.sdk.getInventory());let items=0,prayers=0;f.s.sdk.sendUseItem=async()=>{items++;return{success:true};};f.s.bot.activatePrayer=async()=>{prayers++;return{success:true};};const stop=()=>guardianStopRequested('Owned',()=>false,p=>p===path,'guardian-role.stop');const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60,stop},f.io);expect(r).toMatchObject({ok:false,cancelled:true,antidote:false,casts:0,prayerRestored:true});expect(items).toBe(0);expect(prayers).toBe(0);expect(JSON.stringify(f.s.sdk.getInventory())).toBe(before);}});
test('Sara stop during paid antidote wait cannot activate prayer or dig',async()=>{const f=fixture(false,'trail_hard2');f.s.sdk.getInventory().push({id:2448,count:1,slot:15});let items=0,prayers=0;f.s.sdk.sendUseItem=async(slot:number)=>{items++;const row=f.s.sdk.getInventory().find((i:any)=>i.slot===slot);expect(row.id).toBe(2448);row.id=181;f.s.sdk.getState().gameMessages.push({type:0,sender:'',fromSelf:false,tick:f.s.tick(),observationId:1,text:'You drink some of your antipoison potion.'},{type:0,sender:'',fromSelf:false,tick:f.s.tick(),observationId:2,text:'You have 3 doses of potion left.'});return{success:true};};f.s.bot.activatePrayer=async()=>{prayers++;return{success:true};};const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60,stop:()=>f.s.tick()>=1},f.io);expect(r).toMatchObject({ok:false,cancelled:true,antidote:true,casts:0,prayerRestored:true});expect(r.detail).toContain('antidote settlement');expect(items).toBe(1);expect(prayers).toBe(0);expect(f.s.sdk.getInventory().find((i:any)=>i.slot===15).id).toBe(181);});

import {guardianAntidote} from './microbot-c-clue-guardian';
function antidoteFixture(){let tick=0,calls=0;const state:any={player:{lifeId:1,respawnCount:0,isDead:false},gameMessages:[]},inventory:any[]=[{id:2448,count:1,slot:4},{id:995,count:15,slot:5}],controls={start:8,credit:9,complete:10,unrelated:false,chat:false,reply:'success',stale:false};
 const step=()=>{tick++;if(tick===controls.start)state.gameMessages.push({type:controls.chat?2:0,sender:controls.chat?'OtherPlayer':'',fromSelf:false,tick,observationId:10,text:'You drink some of your antipoison potion.'});if(tick===controls.credit){inventory[0].id=181;if(controls.unrelated)inventory[1].count++;}if(tick===controls.complete)state.gameMessages.push({type:0,sender:'',fromSelf:false,tick,observationId:11,text:'You have 3 doses of potion left.'});};
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){step();cb();next();}});next();return()=>{active=false;};},sdk:{getState:()=>state,getStateAge:()=>0,getSkill:()=>({level:99}),getInventory:()=>inventory,sendUseItem:async()=>{calls++;if(controls.reply==='throw')throw Error('lost response');return{success:controls.reply==='success',message:'unknown dispatch'};}}};return{s,state,inventory,controls,tick:()=>tick,calls:()=>calls};
}
test('antidote native start at admission tick8 authorizes only conversion9/completion10 settlement once',async()=>{const f=antidoteFixture();expect(await guardianAntidote(f.s,()=>false)).toMatchObject({confirmed:true,unknown:false,attempted:true,paid:true});expect(f.tick()).toBe(10);expect(f.calls()).toBe(1);expect(f.inventory).toEqual([{id:181,count:1,slot:4},{id:995,count:15,slot:5}]);});
test('antidote no native start at tick8 has no settlement extension or repeat and remains unknown',async()=>{const f=antidoteFixture();Object.assign(f.controls,{start:9,credit:9});expect(await guardianAntidote(f.s,()=>false)).toMatchObject({confirmed:false,unknown:true,attempted:true,paid:false});expect(f.tick()).toBe(8);expect(f.calls()).toBe(1);});
test('antidote paired native conversion is acceptance even when start text arrives separately',async()=>{const f=antidoteFixture();Object.assign(f.controls,{start:99,credit:8,complete:9});expect((await guardianAntidote(f.s,()=>false)).confirmed).toBe(true);expect(f.tick()).toBe(9);expect(f.calls()).toBe(1);});
test('antidote stale or player-chat text and UI text cannot authorize a settlement tail',async()=>{for(const kind of['stale','chat','ui']){const f=antidoteFixture();f.controls.credit=99;f.controls.complete=99;if(kind==='stale'){f.controls.start=99;f.state.gameMessages=[{type:0,sender:'',fromSelf:false,tick:0,observationId:1,text:'You drink some of your antipoison potion.'}];}if(kind==='chat')f.controls.chat=true;if(kind==='ui'){f.controls.start=99;f.state.dialog={text:'You drink some of your antipoison potion.'};}expect((await guardianAntidote(f.s,()=>false)).confirmed).toBe(false);expect(f.tick()).toBe(8);expect(f.calls()).toBe(1);}});
test('antidote settlement rejects unrelated pack change despite correct dose and completion',async()=>{const f=antidoteFixture();f.controls.unrelated=true;const r=await guardianAntidote(f.s,()=>false);expect(r).toMatchObject({confirmed:false,unknown:true,paid:true});expect(r.detail).toContain('wrong pack conversion');expect(f.calls()).toBe(1);expect(f.tick()).toBe(9);});
test('antidote lost or false dispatch replies reconcile only the exact fresh effect and never repeat',async()=>{for(const reply of['throw','false']){const f=antidoteFixture();f.controls.reply=reply;expect(await guardianAntidote(f.s,()=>false)).toMatchObject({confirmed:true,unknown:false,paid:true});expect(f.calls()).toBe(1);}});
test('actual Sara consumer stops during witnessed antidote tail without a prayer or dig input',async()=>{const f=fixture(false,'trail_hard2'),clock=antidoteFixture();f.s.sdk.getInventory().push({id:2448,count:1,slot:15});f.s.tick=clock.s.tick;f.s.onTick=clock.s.onTick;const originalState=f.s.sdk.getState;f.s.sdk.getState=()=>({...originalState(),gameMessages:clock.state.gameMessages});let calls=0,prayers=0;f.s.sdk.sendUseItem=async()=>{calls++;return{success:true};};f.s.bot.activatePrayer=async()=>{prayers++;return{success:true};};clock.inventory[0]=f.s.sdk.getInventory().find((i:any)=>i.id===2448);const r=await runGuardianClue(f.s,f.r.id,{spell:'wind_strike',maximumCasts:2,cap:60,stop:()=>clock.tick()>=9},f.io);expect(r).toMatchObject({ok:false,cancelled:true,antidote:false,antidoteUnknown:true,casts:0,preserved:false});expect(prayers).toBe(0);expect(calls).toBe(1);expect(clock.tick()).toBe(9);});
