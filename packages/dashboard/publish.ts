// Publishes this PC's dashboard state for the hosted dashboard (the rs-fleet-command repository) and applies the
// owner's commands from it. Usage: bun packages/dashboard/publish.ts [--once] [--daemon]
// It lives in the dashboard package, a tooling root outside the worker release hash, so it never rolls the fleet.
// Env: FLEET_COMMAND_REPO  owner/name of the dashboard repository (unset: write the files only, publish nothing)
//      CYCLE_S  seconds between cycles (60)   PUBLIC_EVERY_S  least seconds between public pushes (600)
//      FLEET_COMMAND_DIR  clone folder (.practice/fleet-command)   DASH_PORT  the local dashboard's port (3100)
// Each cycle: make sure the local dashboard server (packages/dashboard/server.ts) runs, read its /api/state,
// /api/control and, once, /api/map; write <dir>/out/control.json and public.json (packages/dashboard/publish-relay.ts).
// With a repository: force-push control.json to its `data` branch (one commit, no history); copy site/ from its main
// branch plus public.json and map.bin to its `site` branch (GitHub Pages) at most every PUBLIC_EVERY_S; apply the
// commands the owner committed under commands/ on main (packages/dashboard/publish-commands.ts): the local
// console's own actions replay into the dashboard's /api/control, the fleet actions go through the stop files.
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync,cpSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {controlView,publicView,withSides,MAIN_ACCOUNT} from './publish-relay';
import {FLEET_WORKTREE,loadOwners} from '../core/src/fleet';
import {validateCommand,authorizeCommand,applyCommand,receiptPath,writeReceipt,ACTIONS,ID_RE,MAX_AGE_MS} from './publish-commands';

const root=resolve(import.meta.dir,'..','..'),prac=join(root,'.practice');
const REPO=process.env.FLEET_COMMAND_REPO??'';
const DIR=resolve(process.env.FLEET_COMMAND_DIR??join(prac,'fleet-command'));
const CYCLE_MS=Math.max(15,Number(process.env.CYCLE_S)||60)*1000,PUBLIC_MS=Math.max(60,Number(process.env.PUBLIC_EVERY_S)||600)*1000;
const DASH=`http://127.0.0.1:${Number(process.env.DASH_PORT??3100)}`;
// The local console accepts these from its own page; the hosted page sends the same envelopes.
const CONSOLE_ACTIONS=new Set(['plan','pause','resume','queue','account-pause','account-release']);

const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const writeAtomic=(f:string,data:string|Uint8Array)=>{mkdirSync(resolve(f,'..'),{recursive:true});writeFileSync(f+'.tmp',data);renameSync(f+'.tmp',f);};
function run(cmd:string[],cwd=root):{ok:boolean;out:string}{
 const p=Bun.spawnSync(cmd,{cwd,stdout:'pipe',stderr:'pipe',windowsHide:true});
 return {ok:p.exitCode===0,out:`${p.stdout.toString()}${p.exitCode===0?'':p.stderr.toString()}`.trim()};
}
const gh=(...args:string[])=>run(['gh',...args]);
const ghJson=(...args:string[])=>{const r=gh(...args);if(!r.ok)throw Error(r.out.slice(0,300));return JSON.parse(r.out);};
// The repository's pull requests, for the page's Pull requests plugin (every agent lane and its PRs are public).
const BOT_REPO='Giftedx/rs-sdk-bot';
let prs={at:0,rows:[] as any[]};
function pullRequests(now:number){
 if(now-prs.at<300_000)return prs.rows;
 try{
  const fields='number,title,headRefName,state,isDraft,updatedAt,author,url';
  const open=ghJson('pr','list','--repo',BOT_REPO,'--state','open','--limit','50','--json',fields),merged=ghJson('pr','list','--repo',BOT_REPO,'--state','merged','--limit','15','--json',fields);
  prs={at:now,rows:[...open,...merged].map((r:any)=>({number:r.number,title:String(r.title??''),branch:String(r.headRefName??''),state:String(r.state??''),draft:r.isDraft===true,updatedAt:String(r.updatedAt??''),author:String(r.author?.login??''),url:String(r.url??'')}))};
 }catch(e){console.log(`PUBLISH prs unavailable: ${String(e).slice(0,120)}`);prs.at=now;}
 return prs.rows;
}
const ownedNames=()=>{const d=join(root,'vendor','rs-sdk','bots');return existsSync(d)?readdirSync(d,{withFileTypes:true}).filter(n=>n.isDirectory()&&/^[A-Za-z0-9]{1,12}$/.test(n.name)).map(n=>n.name):[];};

// ---------- the local dashboard: the collector ----------
async function dash(path:string,init?:RequestInit,timeoutMs=30_000){return fetch(DASH+path,{...init,signal:AbortSignal.timeout(timeoutMs)});}
async function ensureDashboard(){
 try{if((await dash('/api/viewer-health',undefined,5000)).ok)return;}catch{/* start it */}
 const out=openSync(join(prac,'dashboard.out.log'),'a'),err=openSync(join(prac,'dashboard.err.log'),'a');
 const child=spawn(process.execPath,[join(root,'packages','dashboard','server.ts')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err],env:process.env});
 closeSync(out);closeSync(err);child.unref();
 console.log(`PUBLISH started the local dashboard pid ${child.pid}`);
 for(let i=0;i<30;i++){await Bun.sleep(1000);try{if((await dash('/api/viewer-health',undefined,3000)).ok)return;}catch{/* not yet */}}
 throw Error('the local dashboard did not answer within 30 s');
}
let mapWritten=false;
async function collect(){
 await ensureDashboard();
 const ownersFile=[join(FLEET_WORKTREE,'fleet','owners.json'),join(root,'fleet','owners.json')].find(existsSync);
 const owners=(()=>{try{return ownersFile?loadOwners(ownersFile):new Map();}catch{return new Map();}})();
 const state={...withSides(await (await dash('/api/state')).json(),owners),prs:pullRequests(Date.now())};
 const meta=await (async()=>{try{const r=await dash('/api/control',undefined,10_000);return r.ok?await r.json():null;}catch{return null;}})();
 let map:Uint8Array|null=null;
 if(!mapWritten&&state?.map?.ready){try{const r=await dash('/api/map');if(r.ok)map=new Uint8Array(await r.arrayBuffer());}catch{/* next cycle */}}
 return {state,meta,map};
}

// ---------- the dashboard repository: main (code, commands), data (control.json), site (GitHub Pages) ----------
const git=(cwd:string,...args:string[])=>run(['git',...args],cwd);
function ensureClone(){
 const main=join(DIR,'repo');
 if(!existsSync(join(main,'.git'))){mkdirSync(DIR,{recursive:true});const c=gh('repo','clone',REPO,main,'--','--branch','main');if(!c.ok)throw Error(`clone: ${c.out}`);}
 for(const branch of ['data','site']){
  const dir=join(DIR,branch);if(existsSync(join(dir,'.git')))continue;
  const remote=git(main,'ls-remote','--exit-code','--heads','origin',branch).ok;
  if(remote)git(main,'fetch','-q','origin',branch);
  const add=remote?git(main,'worktree','add','-B',branch,dir,`origin/${branch}`):git(main,'worktree','add','--orphan','-b',branch,dir);
  if(!add.ok)throw Error(`worktree ${branch}: ${add.out}`);
 }
 return main;
}
// One commit per branch: the previous publication is amended away, so the repository never grows with history.
function pushSingleCommit(dir:string,branch:string,message:string):string{
 git(dir,'add','-A');
 const hasHead=git(dir,'rev-parse','--verify','HEAD').ok;
 if(hasHead&&git(dir,'diff','--cached','--quiet').ok)return 'unchanged';
 const c=hasHead?git(dir,'commit','--amend','-q','-m',message):git(dir,'commit','-q','-m',message);
 if(!c.ok)throw Error(`commit ${branch}: ${c.out}`);
 const p=git(dir,'push','--force','-q','origin',`HEAD:refs/heads/${branch}`);
 if(!p.ok)throw Error(`push ${branch}: ${p.out}`);
 return 'pushed';
}
function pullMain(main:string){const r=git(main,'pull','--ff-only','-q','origin','main');if(!r.ok)console.log(`PUBLISH pull main: ${r.out.slice(0,160)}`);}

// ---------- commands: files under commands/ on main; the GitHub API names the login that committed each ----------
async function replayToConsole(body:string,nonce:string){
 const r=await dash('/api/control',{method:'POST',headers:{'content-type':'application/json',origin:DASH,'x-atlas-control':nonce},body},60_000);
 const result:any=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
 return r.ok?{status:String(result.status??'accepted'),note:result.taskId?`task ${result.taskId}`:null}:{status:'refused',note:String(result.error??`HTTP ${r.status}`).slice(0,200)};
}
async function pollCommands(now:number,nonce:string|null):Promise<number>{
 let list:any[];
 try{list=ghJson('api',`repos/${REPO}/contents/commands?ref=main`);}catch(e){if(!/404|Not Found/.test(String(e)))console.log(`PUBLISH commands list: ${String(e).slice(0,160)}`);return 0;}
 if(!Array.isArray(list))return 0;
 let applied=0;const owned=ownedNames(),owner=REPO.split('/')[0]!;
 for(const entry of list){
  if(entry?.type!=='file'||!/^[a-f0-9-]{36}\.json$/.test(String(entry.name)))continue;
  const path=`commands/${entry.name}`;
  let outcome:{status:string;note:string|null};
  try{
   const file=ghJson('api',`repos/${REPO}/contents/${path}?ref=main`);
   const text=Buffer.from(String(file.content??''),'base64').toString('utf8'),raw=JSON.parse(text);
   if(typeof raw?.id!=='string'||!ID_RE.test(raw.id)||raw.id!==entry.name.slice(0,-5))throw Error('file name and command id differ');
   if(typeof raw.at!=='number')throw Error('command carries no time');
   const commits=ghJson('api',`repos/${REPO}/commits?path=${path}&sha=main&per_page=1`);
   const login:string|null=commits?.[0]?.committer?.login??commits?.[0]?.author?.login??null;
   if(existsSync(receiptPath(root,raw.id)))outcome={status:'already-applied',note:null};
   else{
    const fleet=(ACTIONS as readonly string[]).includes(raw.action),console_=CONSOLE_ACTIONS.has(raw.action);
    if(!fleet&&!console_)throw Error(`unknown action ${String(raw.action).slice(0,40)}`);
    const cmd=fleet?validateCommand(raw):{id:raw.id,action:raw.action,at:raw.at,account:typeof raw.account==='string'?raw.account:undefined};
    const gate=authorizeCommand(cmd as any,{via:'github-commit',login},{owner,now,owned,main:MAIN_ACCOUNT,applied:id=>existsSync(receiptPath(root,id)),maxAgeMs:MAX_AGE_MS});
    if(!gate.ok)outcome={status:'refused',note:gate.reason};
    else if(fleet)outcome=await applyCommand(cmd as any,{root,now});
    else if(!nonce)outcome={status:'refused',note:'the local dashboard gave no command session'};
    else{
     // The console writes its own receipt under the same id; strip the hosted page's extra fields first.
     const {at:_at,by:_by,...envelope}=raw;
     outcome=await replayToConsole(JSON.stringify(envelope),nonce);
    }
    if(!existsSync(receiptPath(root,raw.id)))writeReceipt(root,{id:raw.id,action:raw.action,account:cmd.account??null,at:now,requestedAt:raw.at,by:login,status:outcome.status,note:outcome.note,source:'remote'});
    applied++;console.log(`PUBLISH command ${raw.action} ${cmd.account??''} by ${login}: ${outcome.status}${outcome.note?' ('+outcome.note+')':''}`);
   }
  }catch(e){outcome={status:'invalid',note:String(e instanceof Error?e.message:e).slice(0,160)};console.log(`PUBLISH command ${entry.name} invalid: ${outcome.note}`);}
  // Remove the command file whatever happened: the receipt in control.json is the answer.
  const del=gh('api','-X','DELETE',`repos/${REPO}/contents/${path}`,'-f',`message=fleet command ${entry.name.slice(0,8)}: ${outcome.status}`,'-f',`sha=${entry.sha}`,'-f','branch=main');
  if(!del.ok)console.log(`PUBLISH command delete ${entry.name}: ${del.out.slice(0,160)}`);
 }
 return applied;
}

let lastSitePush=0,lastPublic='',lastControl='';
async function cycle(){
 const now=Date.now();
 let {state,meta,map}=await collect();
 let note=`bots=${state.bots?.length??0} tasks=${state.coordination?.tasks?.length??0}`;
 if(map){writeAtomic(join(DIR,'out','map.bin'),map);mapWritten=true;note+=' map=written';}
 if(REPO){
  const main=ensureClone();pullMain(main);
  const applied=await pollCommands(now,meta?.nonce??null);
  if(applied){({state,meta}=await collect());note+=` commands=${applied}`;}
 }
 const control=JSON.stringify(controlView(state,meta)),pub=JSON.stringify(publicView(state));
 writeAtomic(join(DIR,'out','control.json'),control);writeAtomic(join(DIR,'out','public.json'),pub);
 if(REPO){
  const main=join(DIR,'repo');
  if(control!==lastControl){writeAtomic(join(DIR,'data','control.json'),control);note+=` data=${pushSingleCommit(join(DIR,'data'),'data','fleet control state')}`;lastControl=control;}
  if(pub!==lastPublic&&now-lastSitePush>=PUBLIC_MS){
   const site=join(DIR,'site');
   for(const n of readdirSync(site))if(n!=='.git')rmSync(join(site,n),{recursive:true,force:true});
   if(existsSync(join(main,'site')))cpSync(join(main,'site'),site,{recursive:true});
   writeFileSync(join(site,'public.json'),pub);writeFileSync(join(site,'.nojekyll'),'');
   if(existsSync(join(DIR,'out','map.bin')))cpSync(join(DIR,'out','map.bin'),join(site,'map.bin'));
   note+=` site=${pushSingleCommit(site,'site','fleet public state')}`;lastSitePush=now;lastPublic=pub;
  }
 }
 console.log(`PUBLISH ok ${new Date(now).toISOString()} ${note} control=${Math.round(control.length/1024)}K public=${Math.round(pub.length/1024)}K`);
}

if(import.meta.main){
 const lock=join(prac,'dashboard-publish.lock');
 if(process.argv.includes('--daemon')){
  const out=openSync(join(prac,'dashboard-publish.log'),'a');
  const child=spawn(process.execPath,[join(root,'packages','dashboard','publish.ts')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,out],env:process.env});
  closeSync(out);child.unref();console.log(`PUBLISH started pid ${child.pid} (log .practice/dashboard-publish.log)`);process.exit(0);
 }
 if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));if(pid!==process.pid&&alive(pid)){console.log(`PUBLISH already running pid ${pid}`);process.exit(0);}}
 mkdirSync(prac,{recursive:true});writeFileSync(lock,String(process.pid));
 const release=()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))rmSync(lock);}catch{/* gone */}};
 process.on('exit',release);process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
 const once=process.argv.includes('--once');
 for(;;){
  try{await cycle();}catch(e){console.log(`PUBLISH fail ${String(e).slice(0,300)}`);if(once)process.exit(1);}
  if(once)break;
  await Bun.sleep(CYCLE_MS);
 }
}
