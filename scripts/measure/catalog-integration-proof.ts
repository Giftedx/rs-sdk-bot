// Native acceptance for finite planner output and partial ground-supply completion.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {serverFromEnv} from '../../packages/core/src/bot';
import {isLocalServer} from '../../packages/core/src/localserver';
import {readLogoutProof} from '../../packages/core/src/session-lifecycle';
import {killTree} from '../../packages/practice/src/proc';
import {plan,aioTemplates,jobFor} from '../../packages/planner/src/autopilot';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';

const root=resolve(import.meta.dir,'../..');
type Save=ReturnType<typeof readPracticeSave>;
const amount=(save:Save,id:number,container?:number)=>Object.entries(save.inventories).filter(([key])=>container===undefined||Number(key)===container)
 .flatMap(([,rows])=>rows).filter(row=>row.id===id).reduce((n,row)=>n+row.count,0);
const totals=(save:Save,skip:number[]=[])=>{
 const result:Record<number,number>={};for(const key of [93,94,95])for(const row of save.inventories[key]??[])
  if(!skip.includes(row.id))result[row.id]=(result[row.id]??0)+row.count;
 return result;
};
async function worker(name:string,script:string,args:string[],env:Record<string,string>={},expected=0){
 const child=Bun.spawn([process.execPath,resolve(root,script),name,...args],{cwd:root,env:{...process.env,...env},windowsHide:true,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 let expired=false;const timer=setTimeout(()=>{expired=true;void killTree(child.pid);},90000);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  console.log(stdout);if(stderr)console.error(stderr);
  assert.equal(expired,false,'native worker deadline');assert.equal(code,expected,'native worker exit');
  assert.match(stdout,/^LOGOUT logged-out\s*$/m,'confirmed worker logout');return stdout;
 }finally{clearTimeout(timer);}
}
async function prove(name:string,mode:string,savePath:string){
 assert.match(name,/^aiob[a-z0-9]+$/i,'bench fixture account required');
 assert.equal(basename(savePath).toLowerCase(),name.toLowerCase()+'.sav');
 const server=serverFromEnv(readFileSync(resolve(root,'vendor/rs-sdk/bots',name,'bot.env'),'utf8'));
 assert.equal(isLocalServer(server),true,'native proof is local only');
 const before=readPracticeSave(savePath);let stdout:string,expectedItem:number;
 if(mode==='producer'){
  assert.equal(amount(before,1607,95),13);assert.equal(amount(before,2357,95),13);assert.equal(amount(before,1592,95),1);
  const template=aioTemplates().find(row=>row.id==='aio-sapphire-rings');assert.ok(template);
  const assignment=plan({side:'local',accounts:[{name,side:'local',skills:{Crafting:20,Hitpoints:40},items:{sapphire:13,'gold bar':13,'ring mould':1}}],
   owners:new Map([[name.toLowerCase(),{side:'local'}]]),templates:[template],pilots:new Set([template.id]),prices:{'sapphire ring':100},
   bill:[{item:'sapphire ring',need:1,owned:0,short:1,ids:[1637],holders:[]}]}).find(row=>row.account===name);
  assert.ok(assignment?.template,'finite producer assignment');const job=jobFor(assignment,'local');
  assert.equal(job.repeat,false,'finite production does not repeat');
  stdout=await worker(name,job.script,job.args,job.env);assert.match(stdout,/^RESULT ok\b/m);expectedItem=1637;
  const saved=await waitPracticeSave(savePath,save=>amount(save,1637,95)===1);assert.equal(saved.matched,true);
  const after=readPracticeSave(savePath);
  assert.equal(amount(after,1637,95),1);assert.equal(amount(after,1607,95),12);assert.equal(amount(after,2357,95),12);
  assert.deepEqual(totals(after,[1607,2357,1637]),totals(before,[1607,2357,1637]));
  assert.deepEqual(after.inventories[93]??[],before.inventories[93]??[]);assert.deepEqual(after.inventories[94]??[],before.inventories[94]??[]);
  assert.deepEqual(after.skills[3],before.skills[3]);
 }else{
  assert.equal(mode,'gather-short');assert.equal((before.inventories[93]??[]).length,28);assert.equal(amount(before,1059,93),1);
  stdout=await worker(name,'scripts/gather-spawn.ts',['1059','2'],{TICKS:'1'},1);
  assert.match(stdout,/^RESULT fail .*banked=1 .*targetMet=false remaining=1\b/m);expectedItem=1059;
  const saved=await waitPracticeSave(savePath,save=>amount(save,1059,95)===1);assert.equal(saved.matched,true);
  const after=readPracticeSave(savePath);assert.equal(amount(after,1059,95),1);assert.equal(amount(after,1059,93),0);
  assert.deepEqual(totals(after),totals(before));assert.deepEqual(after.inventories[94]??[],before.inventories[94]??[]);
  assert.deepEqual(after.skills,before.skills);
 }
 const logout=readLogoutProof(name,server,{root:resolve(root,'.practice/session-lifecycle')});assert.equal(logout.state,'confirmed');
 console.log('CATALOG_INTEGRATION_PROOF '+JSON.stringify({mode,item:expectedItem,assets:true,logout:true}));
 console.log('RESULT ok catalog native '+mode);
}
if(import.meta.main){
 const [name,mode,save]=process.argv.slice(2);if(!name||!mode||!save)throw Error('usage: catalog-integration-proof.ts account producer|gather-short save');
 try{await prove(name,mode,resolve(root,save));}catch(error){console.error(String(error));process.exitCode=1;}
}
