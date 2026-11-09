import {resolve} from 'node:path';
import {test,expect} from 'bun:test';
import {edgevilleRoute,createEdgevilleTravel} from './microbot-edgeville-travel';

test('generic combat uses native transitions rather than a surface-to-dungeon walk',()=>{
 for(const target of ['druid','giant'] as const){
  const site=target==='druid'?{x:3115,z:9928,level:0}:{x:3117,z:9850,level:0},bank={x:3092,z:3496,level:0};
  const out=edgevilleRoute(bank,site,target),back=edgevilleRoute(site,bank,target);
  expect(out.filter(l=>l.kind==='enter')).toHaveLength(1);expect(back.filter(l=>l.kind==='exit')).toHaveLength(1);
  expect(out.at(-1)).toMatchObject({kind:'walk',...site});expect(back.at(-1)).toMatchObject({kind:'walk',...bank});
  expect(out.filter(l=>l.kind==='walk').every(l=>l.z<9000||out.indexOf(l)>out.findIndex(l=>l.kind==='enter'))).toBe(true);
  expect(back.filter(l=>l.kind==='walk').every(l=>l.z>=9000||back.indexOf(l)>back.findIndex(l=>l.kind==='exit'))).toBe(true);
  const gate=out.flatMap(l=>l.kind==='walk'&&l.x===3131?[l.z]:[]);expect(gate).toEqual(target==='druid'?[9916,9921]:[]);
 }
});
test('same-region travel keeps explicit custom routes, while unknown dungeon crossings reject before input',()=>{
 expect(edgevilleRoute({x:3183,z:3432,level:0},{x:3185,z:3436,level:0},'druid')).toEqual([{kind:'walk',x:3185,z:3436,level:0,tol:2}]);
 for(const from of [{x:2800,z:9800,level:0},{x:3092,z:3496,level:1}])expect(()=>edgevilleRoute(from,{x:3092,z:3496,level:0},'druid')).toThrow();
});
test('journey rejects stops, replaced executors and blocked ground before any transition',async()=>{
 for(const mode of ['stop','owner','ground','life','respawn']){let inputs=0;const player={worldX:3092,worldZ:3496,level:0,lifeId:1,respawnCount:0},client:any={executeBotAction:()=>{}},s:any={client,ended:new Promise(()=>{}),sdk:{getState:()=>({player}),getSkill:()=>({level:99})}},travel=createEdgevilleTravel(s);
 if(mode==='owner')client.executeBotAction=()=>{};if(mode==='life')player.lifeId++;if(mode==='respawn')player.respawnCount++;
 await expect(travel.walk(s,'giant',{x:3117,z:9850,level:0},async()=>{inputs++;return false;},()=>mode==='stop')).rejects.toThrow();
 expect(inputs).toBe(mode==='ground'?1:0);const foreign=client.executeBotAction;travel.close();if(mode==='owner')expect(client.executeBotAction).toBe(foreign);
 }
});

function crossingCase(mode:string){
 const code=`
 import{mock}from'bun:test';import{resolve}from'node:path';
 const mode=${JSON.stringify(mode)},player={worldX:3092,worldZ:3496,level:0,lifeId:1,respawnCount:0,animId:-1},inventory=[{id:995,count:37,slot:0}],inputs=[],walks=[],waits=[];let tick=0,opened=false,stopped=false,words=[];
 const locs=()=>[{id:opened?1570:1568,x:3097,z:3468,level:0,optionsWithIndex:[{opIndex:1,text:opened?'Climb-down':'Open'}]},{id:1755,x:3096,z:9867,level:0,optionsWithIndex:[{opIndex:1,text:'Climb-up'}]}];
 const client={executeBotAction:()=>({success:true}),isInGame:()=>true,localPlayer:{routeX:[player.worldX],routeZ:[player.worldZ]},toSceneTile:(x,z)=>({x,z}),locSceneInfo:()=>({shape:22}),writeOpcode:()=>{words=[];},out:{p2:n=>{words.push(n);if(words.length===3){const id=words[2];inputs.push(id);if(id===1568)opened=true;else if(mode!=='unknown'){player.worldX=3096;player.worldZ=9867;if(mode==='debit')inventory[0].count--;}if(mode==='stop')stopped=true;}}}};
 const at=(x,z)=>{player.worldX=x;player.worldZ=z;client.localPlayer.routeX[0]=x;client.localPlayer.routeZ[0]=z;};
 const sdk={getState:()=>({player,nearbyLocs:locs()}),getInventory:()=>inventory,getEquipment:()=>[],getSkill:()=>({level:99}),getStateAge:()=>0,sendInteractLoc:async(x,z,id)=>{inputs.push(id);if(id!==1755||player.worldX!==3097||player.worldZ!==9867)throw Error('wrong ladder approach');at(3096,3467);return{success:true};}};
 const s={client,sdk,ended:new Promise(()=>{}),tick:()=>tick,direct:async(a)=>{const r=client.executeBotAction(a);if(mode==='lost')throw Error('lost reply');return r;}};
 const realWorld=await import('./packages/core/src/world'),realTicks=await import('./packages/core/src/ticks');
 mock.module(resolve('packages/core/src/world'),()=>({...realWorld,interactionApproach:async(_sdk,at,q)=>{if(q.shape!==(q.id===1755?10:22)||q.angle!==(q.id===1755?0:2)||q.width!==1||q.height!==1)throw Error('wrong native geometry');return{x:at.x+1,z:at.z,level:0};}}));
 mock.module(resolve('packages/core/src/ticks'),()=>({...realTicks,waitUntil:async(_s,p,o)=>{for(let n=0;n<o.timeoutTicks;n++){tick++;if(p())return true;}return false;},waitTicks:async(_s,n)=>{tick+=n;waits.push(n);}}));
 const {createEdgevilleTravel}=await import('./scripts/microbot-edgeville-travel'),{combatPotionSession}=await import('./scripts/microbot-combat-potions');
 const original=client.executeBotAction,travel=createEdgevilleTravel(s),view=combatPotionSession(s,()=>stopped,500),ground=async(x,z)=>{if((player.worldZ>=9000)!==(z>=9000))throw Error('ordinary walk crossed dungeon boundary');walks.push([x,z]);at(x,z);return true;};let failure='';
 try{await travel.walk(view,'giant',{x:3117,z:9850,level:0},ground,()=>stopped);await travel.walk(view,'giant',{x:3092,z:3496,level:0},ground,()=>stopped);}catch(e){failure=String(e);}finally{travel.close();}
 console.log(JSON.stringify({failure,inputs,walks,waits,position:[player.worldX,player.worldZ],restored:client.executeBotAction===original}));
 `;
 const child=Bun.spawnSync([process.execPath,'--smol','-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:15000});
 if(child.exitCode!==0)throw Error(child.stderr.toString());return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
}
test('actual travel coordinator crosses both ways through its original potion-bound executor, including lost replies',()=>{
 for(const mode of ['normal','lost']){const r=crossingCase(mode);expect(r.failure).toBe('');expect(r.inputs).toEqual([1568,1570,1755]);expect(r.position).toEqual([3092,3496]);expect(r.waits).toEqual([3,3]);expect(r.restored).toBe(true);}
});
test('unknown, stopped or asset-changing transition never sends the following dungeon input',()=>{
 for(const mode of ['unknown','stop','debit']){const r=crossingCase(mode);expect(r.failure).not.toBe('');expect(r.inputs).toEqual(mode==='stop'?[1568]:[1568,1570]);expect(r.restored).toBe(true);expect(r.inputs).not.toContain(1755);}
});
