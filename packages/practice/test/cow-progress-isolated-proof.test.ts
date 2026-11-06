import {expect,test,spyOn} from 'bun:test';
import * as fs from 'node:fs';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {SWORDINHAND,cases,cowFixture,cowEntry,cowResult,cowSaveChecks,cowChildChecks,cowChildConfiguration,cowSequenceChecks,claimCowStop,retainCowStop,
 MIGHTYROD,GIANT_HITPOINTS_XP,xpForLevel,giantFixture,giantEntry,giantSaveChecks,giantChildChecks,giantChildConfiguration,giantResult} from '../src/cow-progress-isolated-proof';
import {giantTraining} from '../../../scripts/gather-combat';
import {cowProfile} from '../../../scripts/gather-combat';
import {ISOLATED,ISOLATED_ENGINE_ENV,pointBotAt} from '../src/rehearse';

test('native combat proof starts a named isolated stack and points its fixtures away from the shared server',()=>{
 const proof=readFileSync(resolve(import.meta.dir,'../src/cow-progress-isolated-proof.ts'),'utf8');
 // Evaluate the options passed at the actual launch boundary without starting services.
 const options=proof.match(/stack=await startStack\((.+)\);/)?.[1];
 expect(options).toBeDefined();
 const root=resolve(import.meta.dir,'../../..');
 const stack=Function('ISOLATED','ISOLATED_ENGINE_ENV','join','root',`return (${options});`)(ISOLATED,ISOLATED_ENGINE_ENV,join,root);
 expect(stack).toMatchObject({ports:ISOLATED,instance:'cow-progress-order',tickMs:150,xpRate:25,
  enginePreload:{module:join(root,'packages/practice/src/save-endpoint.ts'),env:{...ISOLATED_ENGINE_ENV,BUILD_LIVE_RELOAD:'false',BUILD_STARTUP:'false',NODE_INFINITE_RUN:'true'}}});
 expect(stack.ports.engine).not.toBe(8888);expect(stack.ports.gateway).not.toBe(7780);
 expect(proof).toContain('pointBotAt(bot.envPath,ISOLATED.engine,ISOLATED.gateway)');
 const dir=mkdtempSync(join(tmpdir(),'cow-isolated-'));try{
  const path=join(dir,'bot.env');writeFileSync(path,'SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\n');
  pointBotAt(path,stack.ports.engine,stack.ports.gateway);
  expect(readFileSync(path,'utf8')).toBe(`SERVER=localhost:${ISOLATED.engine}\nGATEWAY_URL=ws://localhost:${ISOLATED.gateway}\n`);
  for(const child of [cowChildConfiguration('fixture',{SERVER:'localhost:8888',GATEWAY_URL:'ws://localhost:7780'}),giantChildConfiguration('fixture',{SERVER:'localhost:8888',GATEWAY_URL:'ws://localhost:7780'})])
   expect(child.env).toMatchObject({SERVER:`localhost:${ISOLATED.engine}`,GATEWAY_URL:`ws://localhost:${ISOLATED.gateway}`});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('proof stop never adopts, deletes or overwrites a user or replacement stop',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cow-stop-'));try{
  const path=join(dir,'stop-flcow'),marker='proof stop\n';
  // A user stop already present is refused and kept byte-for-byte.
  writeFileSync(path,'user stop\n');
  expect(()=>claimCowStop(path,marker)).toThrow('stop path already exists');expect(readFileSync(path,'utf8')).toBe('user stop\n');
  unlinkSync(path);
  // The active path stays stopped. This identity is never restarted.
  const owned=claimCowStop(path,marker);
  expect(retainCowStop(owned,join(dir,'owned.txt'))).toBe(path);
  expect(existsSync(join(dir,'owned.txt'))).toBe(false);expect(readFileSync(path,'utf8')).toBe(marker);
  // Rewritten in place: retention must leave the user bytes alone.
  writeFileSync(path,'user stop\n');
  expect(retainCowStop(owned,join(dir,'rewritten.txt'))).toBe(path);
  expect(readFileSync(path,'utf8')).toBe('user stop\n');
  unlinkSync(path);
  // Replaced by a new file: retention must leave its active path alone.
  const replaced=claimCowStop(path,marker);unlinkSync(path);writeFileSync(path,'replacement\n');
  expect(retainCowStop(replaced,join(dir,'replaced.txt'))).toBe(path);
  expect(readFileSync(path,'utf8')).toBe('replacement\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test.each(['stat','read','access-failure'] as const)('retention makes no filesystem calls with %s failure or replacement armed',boundary=>{
 const dir=mkdtempSync(join(tmpdir(),'cow-stop-race-')),path=join(dir,'stop-flcow');
 const stop=claimCowStop(path,'proof marker'),realStat=fs.statSync,realRead=fs.readFileSync,realUnlink=fs.unlinkSync,realWrite=fs.writeFileSync;
 const spies:ReturnType<typeof spyOn>[]=[];let swapped=false;
 const replace=()=>{realUnlink(path);realWrite(path,'operator stop');swapped=true;};
 try{
  spies.push(spyOn(fs,'statSync').mockImplementation(((...args:any[])=>{if(boundary==='access-failure')throw Error('EACCES');const v=(realStat as any)(...args);if(boundary==='stat'&&!swapped)replace();return v;}) as any));
  spies.push(spyOn(fs,'readFileSync').mockImplementation(((...args:any[])=>{if(boundary==='access-failure')throw Error('EACCES');const v=(realRead as any)(...args);if(boundary==='read'&&!swapped)replace();return v;}) as any));
  for(const method of ['renameSync','unlinkSync','linkSync','rmSync','writeFileSync','openSync','truncateSync','ftruncateSync','copyFileSync'] as const)
   spies.push(spyOn(fs,method).mockImplementation((()=>{throw Error('stop mutation: '+method);}) as any));
  try{expect(retainCowStop(stop,join(dir,'evidence'))).toBe(path);throw Error('proof failure');}
  catch(error){expect(String(error)).toContain('proof failure');}
  finally{expect(retainCowStop(stop,join(dir,'evidence'))).toBe(path);}
  for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  expect(swapped).toBe(false);expect(realRead(path,'utf8')).toBe(stop.marker);
 }finally{for(const spy of spies.reverse())spy.mockRestore();rmSync(dir,{recursive:true,force:true});}
});

test('actual native child configuration pins the finite south/held CLI despite inherited profiles',()=>{
 for(const inherited of [{},{COW_BANK_PROFILE:'',COW_FOOD_MODE:''},{COW_BANK_PROFILE:'north',COW_FOOD_MODE:'banked',MAX_KILLS:'9',TARGET:'giant',TRAIN_SKILL:'Defence',TARGET_LEVEL:'99',DEMO_OK:'1'}]){
  const original={...inherited},child=cowChildConfiguration('fixture',inherited);
  expect(child.cmd).toEqual(['bun','scripts/gather-combat.ts','fixture','1500','cow']);
  expect(child.windowsHide).toBe(true);
  expect(child.env).toMatchObject({COW_BANK_PROFILE:'south',COW_FOOD_MODE:'held',MAX_KILLS:'5',TARGET:'cow',TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',DEMO_OK:'',RANDOM_EVENTS:'0'});
  expect(cowProfile(child.env.COW_BANK_PROFILE,child.env.COW_FOOD_MODE,Number(child.env.MAX_KILLS))).toEqual({north:false,foodBanked:false,limit:5,bank:{x:2654,z:3283}});
  expect(inherited).toEqual(original);
 }
 // Invalid worker input must still fail rather than silently selecting a route.
 expect(()=>cowProfile('','',5)).toThrow('unsupported bank/food profile');
 expect(()=>cowProfile('south','banked',5)).toThrow('unsupported bank/food profile');
 expect(()=>cowProfile('unsupported','held',5)).toThrow('unsupported bank/food profile');
});

function save(kind:'entry'|'nofood'|'nokit'='entry'):any{
 const f=cowFixture(kind);
 return {version:9,position:{...SWORDINHAND.position},vars:{134:1},
  skills:SWORDINHAND.skills.map((s,index)=>({index,level:s.level,xp:s.xp,rawExperience:s.xp*10})),
  inventories:{93:f.inventory!.map((i,slot)=>({slot,...i})),94:f.equipment!.map(i=>({slot:i.slot,id:i.id,count:i.count})),95:f.bank!.map((i,slot)=>({slot,...i}))}};
}
function finished(kills=4,eaten=1){
 const before=save(),after=structuredClone(before);
 after.position={x:2654,z:3283,level:0};
 after.skills[0]={...after.skills[0],level:20,xp:900+800*kills,rawExperience:(900+800*kills)*10};after.skills[3].rawExperience+=1000;
 for(let n=0;n<eaten;n++)after.inventories[93].splice(after.inventories[93].findIndex((i:any)=>i.id===333),1);
 for(const id of [1739,526,2132])after.inventories[95].find((i:any)=>i.id===id).count+=kills;
 const result={ok:true,targetMet:true,partial:false,stop:'target-level',trainSkill:'Attack',targetLevel:20,startLevel:9,finalLevel:20,selectedXp:800*kills,attackXp:800*kills,
  creditedKills:kills,banked:{hide:kills,bones:kills,beef:kills},eaten,foodAccounted:true,preserved:true,died:false,respawns:0,hpMin:17};
 return {before,after,result};
}
test('dated Swordinhand entry matches the work order and refusal fixtures differ only in food or kit',()=>{
 expect(cowEntry(save(),'entry')).toBe(true);
 expect(cowEntry(save('nofood'),'nofood')).toBe(true);expect(cowEntry(save('nofood'),'entry')).toBe(false);
 expect(cowEntry(save('nokit'),'nokit')).toBe(true);expect(cowEntry(save('nokit'),'entry')).toBe(false);
 const fresh=save();fresh.skills[0].level=1;expect(cowEntry(fresh,'entry')).toBe(false);
});
test('Attack20 order needs saved level, matching XP, banked drops, eaten food and preserved kit',()=>{
 const {before,after,result}=finished();expect(Object.values(cowSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(true);
 const mutations:((a:any,r:any)=>void)[]=[
  a=>{a.skills[0].level=19;},                                  // level not reached
  (_,r)=>{r.selectedXp+=800;},                                 // claimed XP not saved
  a=>{a.skills[2].rawExperience+=10;},                         // unrelated Strength XP
  a=>{a.inventories[95].find((i:any)=>i.id===1739).count--;},  // missing banked hide
  a=>{a.inventories[93].push({slot:20,id:526,count:1});},      // carried output
  a=>{a.inventories[93].splice(a.inventories[93].findIndex((i:any)=>i.id===333),1);}, // unaccounted Trout
  a=>{a.inventories[93].find((i:any)=>i.id===995).count--;},   // spent cash
  a=>{a.inventories[94].pop();},                               // lost worn shield
  a=>{a.position={x:2664,z:3344,level:0};},                    // ended at the pen
  (_,r)=>{r.foodAccounted=false;},
  (_,r)=>{r.died=true;},
 ];
 for(const mutate of mutations){const f=finished();mutate(f.after,f.result);expect(Object.values(cowSaveChecks(f.before,f.after,f.result,'entry')).every(Boolean)).toBe(false);}
});
test('stopped route must bank its credited loot below the target; a finished claim is refused',()=>{
 const {before,after,result}=finished(1,0);after.skills[0].level=12;
 Object.assign(result,{ok:false,targetMet:false,stop:'stop-file',finalLevel:12});
 expect(Object.values(cowSaveChecks(before,after,result,'stopped')).every(Boolean)).toBe(true);
 expect(Object.values(cowSaveChecks(before,after,{...result,stop:'cap'},'stopped')).every(Boolean)).toBe(false);
 expect(Object.values(cowSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(false);
});

test('finite partial CLI banks exactly one kill below Attack20 before its unstopped restart',()=>{
 const child=cowChildConfiguration('fixture',{MAX_KILLS:'9',TARGET_LEVEL:'99'},'partial');
 expect(child.env.MAX_KILLS).toBe('1');expect(child.env.TARGET_LEVEL).toBe('20');
 expect(cowChildConfiguration('fixture',{},'restarted').env.MAX_KILLS).toBe('5');
 const {before,after,result}=finished(1,0);after.skills[0].level=12;
 Object.assign(result,{targetMet:false,partial:true,stop:'max-kills',finalLevel:12});
 expect(Object.values(cowSaveChecks(before,after,result,'partial')).every(Boolean)).toBe(true);
 for(const change of [{stop:'stop-file'},{ok:false},{targetMet:true},{partial:false},{creditedKills:2},{banked:{hide:0,bones:1,beef:1}},{foodAccounted:false},{preserved:false},{died:true}])
  expect(Object.values(cowSaveChecks(before,after,{...result,...change},'partial')).every(Boolean)).toBe(false);
 expect(Object.values(cowSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(false);
 expect(Object.values(cowChildChecks(0,false,'LOGOUT logged-out\nRESULT ok mode=cow partial=true\n','partial')).every(Boolean)).toBe(true);
});

test('receipt sequence retires the active stop identity and binds restart only to the unstopped partial save',()=>{
 const stopPath=resolve(import.meta.dir,'../../../.practice/stop-flstopped');
 const receipts=cases.map(id=>({id,name:id==='restarted'?'flpartial':`fl${id}`,before:id==='restarted'?'partial-after':id+'-before',after:id+'-after',
  stopRequested:id==='stopped',stopRetained:id==='stopped'?stopPath:null,retired:id==='stopped',stopFailure:null}));
 expect(Object.values(cowSequenceChecks(receipts)).every(Boolean)).toBe(true);
 for(const mutate of [
  (r:any[])=>{r[5].name=r[3].name;},
  (r:any[])=>{r[5].before=r[3].after;},
  (r:any[])=>{r[3].stopRetained='moved-to-evidence';},
  (r:any[])=>{r[3].retired=false;},
  (r:any[])=>{r[4].stopRequested=true;},
  (r:any[])=>{r[4].stopFailure='foreign stop';},
 ]){const changed=structuredClone(receipts);mutate(changed);expect(Object.values(cowSequenceChecks(changed)).every(Boolean)).toBe(false);}
});
test('refusal cases need no worker result, no movement and no asset or skill change',()=>{
 for(const kind of ['nofood','nokit'] as const){
  const before=save(kind),after=structuredClone(before);
  expect(Object.values(cowSaveChecks(before,after,null,kind)).every(Boolean)).toBe(true);
  expect(cowSaveChecks(before,after,{ok:false},kind).refused).toBe(false);
  const moved=structuredClone(before);moved.position={x:2664,z:3344,level:0};expect(cowSaveChecks(before,moved,null,kind).bank).toBe(false);
  const ate=structuredClone(before);ate.inventories[93].splice(ate.inventories[93].findIndex((i:any)=>i.id===333),1);expect(cowSaveChecks(before,ate,null,kind).assets).toBe(false);
 }
});
test('CLI exit, RESULT line and a single confirmed logout are required per case',()=>{
 const ok='LOGOUT logged-out\nRESULT ok mode=cow ok=true\n';
 expect(Object.values(cowChildChecks(0,false,ok,'entry')).every(Boolean)).toBe(true);
 expect(cowChildChecks(0,false,'RESULT ok mode=cow ok=true\n','entry').logout).toBe(false);
 expect(cowChildChecks(0,true,ok,'restarted').exit).toBe(false);
 const stopped='START 2655 3283 0\nCOW_STOP_OWNER stop file\nCOW_RESULT {"ok":false}\nLOGOUT logged-out\nRESULT fail mode=cow ok=false stop=stop-file\n';
 expect(Object.values(cowChildChecks(1,false,stopped,'stopped')).every(Boolean)).toBe(true);
 expect(cowChildChecks(1,false,stopped.replace('COW_STOP_OWNER stop file\n',''),'stopped').stopOwner).toBe(false);
 expect(cowChildChecks(1,false,stopped.replace('START 2655 3283 0\n',''),'stopped').stopOwner).toBe(false);
 expect(cowChildChecks(1,false,'COW_STOP_OWNER stop file\n'+stopped.replace('COW_STOP_OWNER stop file\n',''),'stopped').stopOwner).toBe(false);
 expect(cowChildChecks(1,false,'LOGOUT logged-out\nRESULT fail mode=cow ok=false stop=cap\n','stopped').result).toBe(false);
 expect(Object.values(cowChildChecks(1,false,'LOGOUT logged-out\nRESULT fail Error: cow prerequisite: stage2unnoted Trout and syncedHP/skill\n','nofood')).every(Boolean)).toBe(true);
 expect(cowChildChecks(1,false,'LOGOUT logged-out\nRESULT fail Error: cow prerequisite: stage2unnoted Trout\n','nokit').result).toBe(false);
 expect(cowResult('x\nCOW_RESULT {"creditedKills":4}\n')).toEqual({creditedKills:4});expect(cowResult('RESULT ok')).toBeNull();
});

function giantSave():any{
 const f=giantFixture();
 return {version:9,position:{...MIGHTYROD.position},vars:{134:1},
  skills:MIGHTYROD.skills.map((s,index)=>({index,level:s.level,xp:s.xp,rawExperience:s.xp*10})),
  inventories:{93:f.inventory!.map((i,slot)=>({slot,...i})),94:f.equipment!.map(i=>({slot:i.slot,id:i.id,count:i.count})),95:f.bank!.map((i,slot)=>({slot,...i}))}};
}
function giantFinished(kills=1,roots=1,eaten=1){
 const before=giantSave(),after=structuredClone(before);
 after.position={x:2655,z:3283,level:0};
 after.skills[3]={...after.skills[3],level:61,xp:GIANT_HITPOINTS_XP+1200*kills,rawExperience:(GIANT_HITPOINTS_XP+1200*kills)*10};
 after.inventories[95].find((i:any)=>i.id===385).count-=eaten;
 after.inventories[95].find((i:any)=>i.id===532).count+=kills+1;
 after.inventories[95].push({id:225,count:roots,slot:5},{id:199,count:2,slot:6});
 after.inventories[93]=[{id:995,count:50,slot:0},{id:1381,count:1,slot:1}];
 after.inventories[95]=after.inventories[95].filter((i:any)=>i.id!==1331);after.inventories[94]=[{id:1331,count:1,slot:3}];
 const result={ok:true,targetMet:true,partial:false,stop:'target-level',trainSkill:'Hitpoints',targetLevel:87,style:{index:0,name:'Chop',weapon:'Adamant scimitar'},startLevel:86,finalLevel:87,
  selectedXp:1200*kills,creditedKills:kills,limpwurt:roots,banked:{bigBones:kills,limpwurt:roots},bankedHerbs:Object.fromEntries([199,201,203,205,207,209,211,213,215,217,219].map(id=>[id,id===199?1:0])),eaten,foodAccounted:true,preserved:true,died:false,respawns:0,hpMin:40};
 return {before,after,result};
}

test('isolated giant fixture stages banked melee and food away from the bank and targets Hitpoints87',()=>{
 expect(xpForLevel(2)).toBe(80);expect(xpForLevel(99)).toBe(998458);expect(GIANT_HITPOINTS_XP).toBe(xpForLevel(87)-1000);
 expect(giantEntry(giantSave())).toBe(true);
 const noWeapon=giantSave();noWeapon.inventories[95]=noWeapon.inventories[95].filter((i:any)=>i.id!==1331);expect(giantEntry(noWeapon)).toBe(false);
 const child=giantChildConfiguration('fixture',{TARGET:'cow',TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',DEMO_OK:'1'});
 expect(child.cmd).toEqual(['bun','scripts/gather-combat.ts','fixture','1500','giant']);expect(child.windowsHide).toBe(true);
 expect(child.env).toMatchObject({TARGET:'giant',TRAIN_SKILL:'Hitpoints',TARGET_LEVEL:'87',GIANT_FOOD:'5',DEMO_OK:'',RANDOM_EVENTS:'0'});
 expect(giantTraining(child.env.TRAIN_SKILL,Number(child.env.TARGET_LEVEL))).toEqual({skill:'Hitpoints',targetLevel:87});
});

test('saved giant proof requires HP level and XP, eating, banked herb deltas and retained swapped kit',()=>{
 const {before,after,result}=giantFinished();expect(Object.values(giantSaveChecks(before,after,result)).every(Boolean)).toBe(true);
 const mutations:((a:any,r:any)=>void)[]=[
  a=>{a.skills[3].xp=xpForLevel(87)-1;},(_,r)=>{r.selectedXp++;},
  a=>{a.inventories[95].find((i:any)=>i.id===532).count--;},
  a=>{a.inventories[95].find((i:any)=>i.id===199).count--;},
  a=>{a.inventories[93].push({slot:20,id:532,count:1});},
  a=>{a.inventories[95].find((i:any)=>i.id===385).count--;},
  a=>{a.inventories[93].find((i:any)=>i.id===995).count--;},
  a=>{a.inventories[94].pop();},a=>{a.position={x:2545,z:3144,level:0};},
  (_,r)=>{r.eaten=0;},(_,r)=>{r.foodAccounted=false;},(_,r)=>{r.died=true;},
 ];
 for(const mutate of mutations){const f=giantFinished();mutate(f.after,f.result);expect(Object.values(giantSaveChecks(f.before,f.after,f.result)).every(Boolean)).toBe(false);}
 expect(Object.values(giantChildChecks(0,false,'LOGOUT logged-out\nRESULT ok mode=giant ok=true\n')).every(Boolean)).toBe(true);
 expect(giantChildChecks(0,false,'RESULT ok mode=giant ok=true\n').logout).toBe(false);
 expect(giantResult('x\nGIANT_RESULT {"creditedKills":2}\n')).toEqual({creditedKills:2});
});
