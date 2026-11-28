// Publishes this PC's dashboard state for the hosted dashboard (the rs-fleet-command repository) and applies the
// owner's commands from it. Usage: bun packages/dashboard/publish.ts [--once] [--daemon]
// It lives in the dashboard package, a tooling root outside the worker release hash, so it never rolls the fleet.
// Env: FLEET_COMMAND_REPO  owner/name of the dashboard repository (unset: write the files only, publish nothing)
//      CYCLE_S  seconds between cycles (60)   PUBLIC_EVERY_S  least seconds between public pushes (600)
//      FLEET_COMMAND_DIR  clone folder (.practice/fleet-command)   DASH_PORT  the local dashboard's port (3100)
// Each cycle: make sure the local dashboard server (packages/dashboard/server.ts) runs, read its /api/state,
// /api/control and, once, /api/map; write <dir>/out/control.json and public.json (packages/dashboard/publish-relay.ts).
// With a repository: force-push control.json to its `data` branch (one commit, no history); copy site/ from its main
// branch plus public.json and map.bin to its `site` branch (GitHub Pages) at most every PUBLIC_EVERY_S, when that folder
// passes verifyStaticBundle, and read the Pages build of each push PAGES_CHECK_MS later (checkPages); apply the
// commands the owner committed under commands/ on main (packages/dashboard/publish-commands.ts): the local
// console's own actions replay into the dashboard's /api/control, the fleet actions go through the stop files.
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync,cpSync,openSync,closeSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,posix,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {expandQuests} from './quest-pack';
import {controlView,publicView,stateWarm,withSides,MAIN_ACCOUNT,pushDue,withoutClocksHashValue} from './publish-relay';
import {expectedLootPrices} from './item-prices';
import {FLEET_WORKTREE,loadOwners} from '../core/src/fleet';
import {leanBunEnv} from '../core/src/lean-bun-env';
import {reloadDue,respawnDaemon} from '../core/src/live-reload';
import {validateCommand,authorizeCommand,applyCommand,receiptPath,writeReceipt,ACTIONS,ID_RE,MAX_AGE_MS} from './publish-commands';

const root=resolve(import.meta.dir,'..','..'),prac=join(root,'.practice'),startedAt=Date.now();
let expectedDropsCache: ReturnType<typeof expectedLootPrices> | undefined;
const getExpectedDrops = () => (expectedDropsCache ??= expectedLootPrices(JSON.parse(readFileSync(join(import.meta.dir,'client-assets','npc-loot.json'),'utf8'))));
const REPO=process.env.FLEET_COMMAND_REPO??'';
const DIR=resolve(process.env.FLEET_COMMAND_DIR??join(prac,'fleet-command'));
const CYCLE_MS=Math.max(15,Number(process.env.CYCLE_S)||60)*1000,PUBLIC_MS=Math.max(60,Number(process.env.PUBLIC_EVERY_S)||600)*1000;
const DASH=`http://127.0.0.1:${Number(process.env.DASH_PORT??3100)}`;
// The local console accepts these from its own page; actions in ACTIONS go through applyCommand directly.
const CONSOLE_ACTIONS=new Set(['pause','resume','account-release','set-campaign-state','set-mission-state']);

// The daemon writes each line to its log file itself: output inherited through a detached child's stdout can stop
// reaching the file when a watchdog pass started the daemon.
const LOG=join(prac,'dashboard-publish.log'),LOG_DIRECT=process.env.PUBLISH_LOG_DIRECT==='1';
const log=(line:string)=>{if(LOG_DIRECT){try{appendFileSync(LOG,line+'\n');return;}catch{/* stdout below */}}console.log(line);};
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const writeAtomic=(f:string,data:string|Uint8Array)=>{mkdirSync(resolve(f,'..'),{recursive:true});writeFileSync(f+'.tmp',data);renameSync(f+'.tmp',f);};
// A git push on a dead socket can hold for ten minutes or more, and every later publication waits behind it. A normal
// push takes about 15 s. The kill takes the whole tree: git's transport helpers hold the output pipes open.
const RUN_LIMIT_MS=120_000,CLONE_LIMIT_MS=600_000;
const killTree=(pid:number)=>{if(process.platform==='win32')Bun.spawnSync(['taskkill','/PID',String(pid),'/T','/F'],{stdout:'ignore',stderr:'ignore',windowsHide:true});else{try{process.kill(-pid,'SIGKILL');}catch{/* gone */}}};
export async function run(cmd:string[],cwd=root,limitMs=RUN_LIMIT_MS):Promise<{ok:boolean;out:string}>{
 // Off Windows the child leads its own process group, so one signal reaches its descendants.
 const p=Bun.spawn(cmd,{cwd,stdout:'pipe',stderr:'pipe',windowsHide:true,detached:process.platform!=='win32'});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<null>(done=>{timer=setTimeout(()=>{killTree(p.pid);done(null);},limitMs);});
 // The race returns at the limit even if a surviving descendant still holds the pipes.
 const result=await Promise.race([Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]),deadline]);
 clearTimeout(timer);
 if(!result)return {ok:false,out:`${cmd.slice(0,2).join(' ')} stopped after ${Math.round(limitMs/1000)} s`};
 const [stdout,stderr,code]=result;
 return {ok:code===0,out:`${stdout}${code===0?'':stderr}`.trim()};
}
const gh=(...args:string[])=>run(['gh',...args]);
const ghJson=async(...args:string[])=>{const r=await gh(...args);if(!r.ok)throw Error(r.out.slice(0,300));return JSON.parse(r.out);};
// The pull request list comes from the local server's state (server.ts refreshPrs, one gh call pair every 5 minutes).
const ownedNames=()=>{const d=join(root,'vendor','rs-sdk','bots');return existsSync(d)?readdirSync(d,{withFileTypes:true}).filter(n=>n.isDirectory()&&/^[A-Za-z0-9]{1,12}$/.test(n.name)).map(n=>n.name):[];};

// ---------- the local dashboard: the collector ----------
async function dash(path:string,init?:RequestInit,timeoutMs=30_000){return fetch(DASH+path,{...init,signal:AbortSignal.timeout(timeoutMs)});}
async function ensureDashboard(){
 try{if((await dash('/api/viewer-health',undefined,5000)).ok)return;}catch{/* start it */}
 const out=openSync(join(prac,'dashboard.out.log'),'a'),err=openSync(join(prac,'dashboard.err.log'),'a');
 const child=spawn(process.execPath,['--smol',join(root,'packages','dashboard','server.ts')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err],env:leanBunEnv(process.env)});
 closeSync(out);closeSync(err);child.unref();
 log(`PUBLISH started the local dashboard pid ${child.pid}`);
 for(let i=0;i<30;i++){await Bun.sleep(1000);try{if((await dash('/api/viewer-health',undefined,3000)).ok)return;}catch{/* not yet */}}
 throw Error('the local dashboard did not answer within 30 s');
}
let mapWritten=false;
async function collect(){
 await ensureDashboard();
 const ownersFile=[join(FLEET_WORKTREE,'fleet','owners.json'),join(root,'fleet','owners.json')].find(existsSync);
 const owners=(()=>{try{return ownersFile?loadOwners(ownersFile):new Map();}catch{return new Map();}})();
 const state={...withSides(await (await dash('/api/state')).json(),owners)};
 const meta=await (async()=>{try{const r=await dash('/api/control',undefined,10_000);return r.ok?await r.json():null;}catch{return null;}})();
 let map:Uint8Array|null=null;
 if(!mapWritten&&state?.map?.ready){try{const r=await dash('/api/map');if(r.ok)map=new Uint8Array(await r.arrayBuffer());}catch{/* next cycle */}}
 return {state,meta,map};
}

// ---------- the dashboard repository: main (code, commands), data (control.json), site (GitHub Pages) ----------
const git=(cwd:string,...args:string[])=>run(['git',...args],cwd);
async function ensureClone(){
 const main=join(DIR,'repo');
 if(!existsSync(join(main,'.git'))){mkdirSync(DIR,{recursive:true});const c=await run(['gh','repo','clone',REPO,main,'--','--branch','main'],root,CLONE_LIMIT_MS);if(!c.ok)throw Error(`clone: ${c.out}`);}
 for(const branch of ['data','site']){
  const dir=join(DIR,branch);if(existsSync(join(dir,'.git')))continue;
  const remote=(await git(main,'ls-remote','--exit-code','--heads','origin',branch)).ok;
  if(remote)await run(['git','fetch','-q','origin',branch],main,CLONE_LIMIT_MS);
  const add=await (remote?git(main,'worktree','add','-B',branch,dir,`origin/${branch}`):git(main,'worktree','add','--orphan','-b',branch,dir));
  if(!add.ok)throw Error(`worktree ${branch}: ${add.out}`);
 }
 return main;
}
// Keep the private control branch at one commit so old control snapshots leave its history.
export async function pushSingleCommit(dir:string,branch:string,message:string):Promise<string>{
 await git(dir,'add','-A');
 const hasHead=(await git(dir,'rev-parse','--verify','HEAD')).ok;
 if(hasHead&&(await git(dir,'diff','--cached','--quiet')).ok)return 'unchanged';
 const c=await (hasHead?git(dir,'commit','--amend','--date=now','-q','-m',message):git(dir,'commit','-q','-m',message));
 if(!c.ok)throw Error(`commit ${branch}: ${c.out}`);
 const p=await git(dir,'push','--force','-q','origin',`HEAD:refs/heads/${branch}`);
 if(!p.ok)throw Error(`push ${branch}: ${p.out}`);
 return 'pushed';
}
// Keep the published tree as the parent so Git can leave its assets out of the next push.
// Use the remote tip as the parent even after a manual Pages deploy or a failed local push.
export async function pushPublicCommit(dir:string):Promise<string>{
 const ref='refs/heads/site';
 const checked=async(...args:string[])=>{
  const result=await git(dir,...args);
  if(!result.ok)throw Error(`site git ${args[0]}: ${result.out}`);
  return result.out;
 };
 let parent=(await checked('ls-remote','--refs','origin',ref)).split(/\s+/)[0]!;
 let parentTree='';
 if(parent){
  const treeCheck=await git(dir,'rev-parse','--verify','-q',parent+'^{tree}');
  if(treeCheck.ok)parentTree=treeCheck.out;
  else{
   await checked('fetch','--no-tags','origin',ref);
   parent=await checked('rev-parse','--verify','FETCH_HEAD');
   parentTree=await checked('rev-parse',parent+'^{tree}');
  }
 }
 await checked('add','-A');
 const tree=await checked('write-tree');
 if(parent&&tree===parentTree){
  await checked('update-ref','HEAD',parent);
  return 'unchanged';
 }
 const parents=parent?['-p',parent]:[];
 const commit=await checked('commit-tree',tree,...parents,'-m','fleet public state');
 await checked('push','-q','origin',`${commit}:${ref}`);
 await checked('update-ref','HEAD',commit);
 return 'pushed';
}
async function pullMain(main:string){const r=await git(main,'pull','--ff-only','-q','origin','main');if(!r.ok)log(`PUBLISH pull main: ${r.out.slice(0,160)}`);}

// ---------- commands: files under commands/ on main; the GitHub API names the login that committed each ----------
const COMMAND_FILE=/^[a-f0-9-]{36}\.json$/;
async function replayToConsole(body:string,nonce:string){
 const r=await dash('/api/control',{method:'POST',headers:{'content-type':'application/json',origin:DASH,'x-atlas-control':nonce},body},60_000);
 const result:any=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
 return r.ok?{status:String(result.status??'accepted'),note:result.taskId?`task ${result.taskId}`:null}:{status:'refused',note:String(result.error??`HTTP ${r.status}`).slice(0,200)};
}
async function pollCommands(now:number,nonce:string|null):Promise<number>{
 // Command files arrive with the pull of main, so the API (one rate limit shared with the signed-in page) is asked only
 // when the clone holds one. An empty commands/ folder is not in Git: most cycles ask nothing.
 const pulled=join(DIR,'repo','commands');
 if(!existsSync(pulled)||!readdirSync(pulled).some(n=>COMMAND_FILE.test(n)))return 0;
 let list:any[];
 try{list=await ghJson('api',`repos/${REPO}/contents/commands?ref=main`);}catch(e){if(!/404|Not Found/.test(String(e)))log(`PUBLISH commands list: ${String(e).slice(0,160)}`);return 0;}
 if(!Array.isArray(list))return 0;
 let applied=0;const owned=ownedNames(),owner=REPO.split('/')[0]!;
 for(const entry of list){
  if(entry?.type!=='file'||!COMMAND_FILE.test(String(entry.name)))continue;
  const path=`commands/${entry.name}`;
  let outcome:{status:string;note:string|null};
  // A read that fails is not the command's fault: the file stays for the next cycle, and its age limit ends the retries.
  let file:any,commits:any;
  try{file=await ghJson('api',`repos/${REPO}/contents/${path}?ref=main`);commits=await ghJson('api',`repos/${REPO}/commits?path=${path}&sha=main&per_page=1`);}
  catch(e){log(`PUBLISH command ${entry.name} not read: ${String(e instanceof Error?e.message:e).slice(0,160)}`);continue;}
  let accepted:{id:string;action:string;account:string|null;at:number;login:string|null}|null=null,raw:any=null;
  try{
   raw=JSON.parse(Buffer.from(String(file.content??''),'base64').toString('utf8'));
   if(typeof raw?.id!=='string'||!ID_RE.test(raw.id)||raw.id!==entry.name.slice(0,-5))throw Error('file name and command id differ');
   if(typeof raw.at!=='number')throw Error('command carries no time');
   const login:string|null=commits?.[0]?.committer?.login??commits?.[0]?.author?.login??null;
   // The commit time is GitHub's clock; the time in the file is the phone's clock, which can be wrong.
   const committedAt=Date.parse(commits?.[0]?.commit?.committer?.date??'');
   if(existsSync(receiptPath(root,raw.id)))outcome={status:'already-applied',note:null};
   else{
    const fleet=(ACTIONS as readonly string[]).includes(raw.action),console_=CONSOLE_ACTIONS.has(raw.action);
    if(!fleet&&!console_)throw Error(`unknown action ${String(raw.action).slice(0,40)}`);
    const cmd=fleet?validateCommand(raw):{id:raw.id,action:raw.action,at:raw.at,account:typeof raw.account==='string'?raw.account:undefined};
    const gate=authorizeCommand({...cmd,at:Number.isFinite(committedAt)?committedAt:cmd.at} as any,{via:'github-commit',login},{owner,now:Date.now(),owned,main:MAIN_ACCOUNT,applied:id=>existsSync(receiptPath(root,id)),maxAgeMs:MAX_AGE_MS});
    accepted={id:raw.id,action:raw.action,account:cmd.account??null,at:raw.at,login};
    if(!gate.ok)outcome={status:'refused',note:gate.reason};
    else if(fleet)outcome=await applyCommand(cmd as any,{root,now});
    else if(!nonce)outcome={status:'refused',note:'the local dashboard gave no command session'};
    else{
     // The console writes its own receipt under the same id; strip the hosted page's extra fields first.
     const {at:_at,by:_by,...envelope}=raw;
     outcome=await replayToConsole(JSON.stringify(envelope),nonce);
    }
    if(!existsSync(receiptPath(root,raw.id)))writeReceipt(root,{id:raw.id,action:raw.action,account:cmd.account??null,at:now,requestedAt:raw.at,by:login,status:outcome.status,note:outcome.note,source:'remote'});
    applied++;log(`PUBLISH command ${raw.action} ${cmd.account??''} by ${login}: ${outcome.status}${outcome.note?' ('+outcome.note+')':''}`);
   }
  }catch(e){
   outcome={status:accepted?'failed':'invalid',note:String(e instanceof Error?e.message:e).slice(0,160)};log(`PUBLISH command ${entry.name} ${outcome.status}: ${outcome.note}`);
   // A valid command that failed while it ran still gets its answer on the page. So does a refused one whose file names
   // its own id (an action this PC does not know, a bad field): the page shows why instead of waiting 30 minutes.
   const named=!accepted&&typeof raw?.id==='string'&&ID_RE.test(raw.id)&&raw.id===entry.name.slice(0,-5)?raw:null;
   const answer=accepted??(named?{id:named.id,action:String(named.action??'unknown').slice(0,40),account:typeof named.account==='string'?named.account:null,at:typeof named.at==='number'?named.at:now,login:null}:null);
   if(answer&&!existsSync(receiptPath(root,answer.id)))try{writeReceipt(root,{id:answer.id,action:answer.action,account:answer.account,at:now,requestedAt:answer.at,by:answer.login,status:outcome.status,note:outcome.note,source:'remote'});}catch{/* the log line stands */}
  }
  // Remove the command file whatever happened: the receipt in control.json is the answer.
  const del=await gh('api','-X','DELETE',`repos/${REPO}/contents/${path}`,'-f',`message=fleet command ${entry.name.slice(0,8)}: ${outcome.status}`,'-f',`sha=${file.sha??entry.sha}`,'-f','branch=main');
  if(!del.ok)log(`PUBLISH command delete ${entry.name}: ${del.out.slice(0,160)}`);
 }
 return applied;
}

let lastSitePush=0,lastPublic:{stable:string;at:number}|null=null,lastControl:{stable:string;at:number}|null=null,coldSince=0;
let pagesWatch:PagesWatch|null=null;
export type BundleAudit={ok:boolean;checkedFiles:number;checkedAssets:number;missing:string[];leaks:string[]};
const STATIC_TEXT_EXT=/\.(html|css|js)$/i;
const ASSET_PREFIX_PLACEHOLDERS=new Set(['rl-','skill-','spell-','prayer-']);
const IMPORT_PAGE_FILES=['index.html','xp-tracker.js','client-shell.js','client-shell.css','client-viewer.css','map-shell.js','map-shell.css','operations.js','operations.css','items.json','RUNELITE-LICENSE.txt'];

export function verifyStaticBundle(
 dir:string,
 secretAccount=MAIN_ACCOUNT,
 options:{allowDevFiles?:boolean;verifyImportContract?:boolean;allowWebpImages?:boolean}={}
):BundleAudit{
 const missing:string[]=[],leaks:string[]=[],assets=new Set<string>();
 const secretRe=secretAccount?new RegExp(`\\b${secretAccount.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i'):null;
 const existCache=new Map<string,boolean>();
 const hasFile=(rel:string)=>{
  let ok=existCache.get(rel);
  if(ok===undefined){ok=existsSync(join(dir,rel));existCache.set(rel,ok);}
  return ok;
 };
 let checkedFiles=0;
 // A link that starts with / names a file from the site root (the local server serves the page there). Any other link
 // is relative to `base`: the folder of an HTML or CSS file, or for a script the folder of the page that loads it.
 const checkFile=(rel:string,source:string,base='')=>{
  const link=rel.split(/[?#]/)[0]!;
  if(!link||link.startsWith('http://')||link.startsWith('https://'))return;
  const clean=link.startsWith('/')?link.replace(/^\/+/,''):posix.normalize(base?`${base}/${link}`:link);
  if(clean.startsWith('../')){missing.push(`${source} -> ${link} (outside the site)`);return;}
  const tail=clean.split('/').pop()||'';
  if(ASSET_PREFIX_PLACEHOLDERS.has(tail)||clean.endsWith('item-sources.json.'))return;
  const webpClean=options.allowWebpImages&&/\.png$/i.test(clean)?clean.replace(/\.png$/i,'.webp'):null;
  const hasPng=hasFile(clean),hasWebp=webpClean!=null&&hasFile(webpClean);
  if(!hasPng&&!hasWebp)missing.push(`${source} -> ${clean}`);
  assets.add(webpClean&&!hasPng&&hasWebp?webpClean:clean);
 };
 const walk=(sub:string)=>{
  const full=join(dir,sub);
  if(!existsSync(full))return;
  for(const ent of readdirSync(full,{withFileTypes:true})){
   const rel=sub?`${sub}/${ent.name}`:ent.name;
   if(ent.isDirectory()){if(ent.name!=='.git'&&ent.name!=='map-squares'&&ent.name!=='tools')walk(rel);continue;}
   const skipDevJson=options.allowDevFiles===true&&rel==='haggis-plan.json';
   if((rel==='public.json'||rel.endsWith('.json'))&&rel!=='client-assets/npcs.json'&&!skipDevJson){
    if(secretRe){
     const raw=readFileSync(join(dir,rel),'utf8');
     if(secretRe.test(raw))leaks.push(rel);
    }
   }
   if(!STATIC_TEXT_EXT.test(ent.name))continue;
   checkedFiles++;
   const text=readFileSync(join(dir,rel),'utf8');
   if(secretRe&&secretRe.test(text))leaks.push(rel);
   let base=sub;
   if(/\.js$/i.test(ent.name))while(base&&!hasFile(`${base}/index.html`))base=posix.dirname(base)==='.'?'':posix.dirname(base);
   for(const m of text.matchAll(/['"(](\/?)client-assets\/([a-zA-Z0-9_.-]+)/g)){
    const tail=m[2]!;
    if(!ASSET_PREFIX_PLACEHOLDERS.has(tail)&&!tail.endsWith('.'))checkFile(`${m[1]}client-assets/${tail}`,rel,base);
   }
   const linkRe=options.allowWebpImages||options.verifyImportContract
    ?/(?:href|src)=["'](\/?[a-zA-Z0-9_.-]+\.(?:css|js|png|webp|json))(?:\?[^"']*)?["']/g
    :/(?:href|src)=["'](\/[a-zA-Z0-9_.-]+\.(?:css|js|png|json))(?:\?[^"']*)?["']/g;
   for(const m of text.matchAll(linkRe))checkFile(m[1]!,rel,base);
   const urlRe=options.allowWebpImages||options.verifyImportContract
    ?/url\(["']?(\/?[a-zA-Z0-9_.-]+\.(?:png|webp|ttf|css))(?:\?[^"']*)?["']?\)/g
    :/url\(["']?(\/[a-zA-Z0-9_.-]+\.(?:png|ttf|css))(?:\?[^"']*)?["']?\)/g;
   for(const m of text.matchAll(urlRe))checkFile(m[1]!,rel,base);
  }
 };
 walk('');
 if(options.verifyImportContract){
  for(const req of IMPORT_PAGE_FILES)if(!existsSync(join(dir,req)))missing.push(`import-contract -> ${req}`);
  const hasItemsSprite=existsSync(join(dir,'items.png'))||(options.allowWebpImages&&existsSync(join(dir,'items.webp')));
  if(!hasItemsSprite)missing.push('import-contract -> items.png');
  if(!existsSync(join(dir,'client-assets')))missing.push('import-contract -> client-assets');
  // A hosted site (it holds shim.js) reads its data through shim.js, with config.js before it (import-page.ts puts both
  // first). A page without either tag shows no data, so the folder does not go out. The source page has no shim.
  if(existsSync(join(dir,'shim.js'))){
   const page=existsSync(join(dir,'index.html'))?readFileSync(join(dir,'index.html'),'utf8'):'';
   for(const f of ['config.js','shim.js'])if(!page.includes('<script src="'+f))missing.push(`import-contract -> index.html loads ${f}`);
  }
 }
 if(existsSync(join(dir,'client-shell.js'))){
  const shell=readFileSync(join(dir,'client-shell.js'),'utf8');
  if(options.verifyImportContract){
   // The import (rs-fleet-command scripts/import-page.ts connectViewerControls) needs the source handler once, and
   // turns it into gameKeys, which it binds to the page and to the 3D viewer frame. A site folder holds that result.
   const count=(s:string)=>shell.split(s).length-1;
   if(count("  window.addEventListener('keydown',e=>{")===0&&count('  const gameKeys=e=>{')>0){
    const bound=count('  const gameKeys=e=>{')===1&&count("  window.addEventListener('keydown',gameKeys,true);")===1
     &&count("gameFrame.contentWindow.addEventListener('keydown',gameKeys,true);")===1&&(shell.match(/\n  window\.atlasClient=/g)||[]).length===1;
    if(!bound)missing.push('contract:connectViewerControls-imported');
   }else{
    if(count("  window.addEventListener('keydown',e=>{")!==1)missing.push('contract:connectViewerControls-keydown-start');
    if((shell.match(/  \},true\);\r?\n  window\.atlasClient=/g)||[]).length!==1)missing.push('contract:connectViewerControls-keydown-end');
   }
  }
  if(existsSync(join(dir,'client-assets/spellbook.json'))){
   const sb=JSON.parse(readFileSync(join(dir,'client-assets/spellbook.json'),'utf8'));
   const utilMatch=shell.match(/const util=\[([\s\S]*?)\]\.map\(/);
   const util:string[]=utilMatch?(Function(`return [${utilMatch[1]}]`)() as any[]).map((x:any)=>String(x[0])):[];
   const slug=(n:string)=>n.toLowerCase().replace(/\blvl-(\d+)\b/g,'level-$1').replace(/\bjewelry\b/g,'jewellery').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
   const spriteOnly=new Set(['charge-air-orb','fire-wave','vulnerability','enfeeble','stun']);
   for(const sp of [...(sb.combat||[]).map((x:any)=>x[0]),...util,...(sb.spells||[]).map((x:any)=>x[0])]){
    const s=slug(sp);
    if(spriteOnly.has(s)){checkFile('client-assets/magicon.png','spell:'+sp);checkFile('client-assets/magicoff.png','spell:'+sp);}
    else if(s==='entangle'){checkFile('client-assets/magicon2.png','spell:'+sp);checkFile('client-assets/magicoff2.png','spell:'+sp);}
    else checkFile(`client-assets/spell-${s}.png`,'spell:'+sp);
   }
  }
 }
 return {ok:missing.length===0&&leaks.length===0,checkedFiles,checkedAssets:assets.size,missing:[...new Set(missing)],leaks:[...new Set(leaks)]};
}

// The hash of the page files in a site folder (null when it holds none): it changes when, and only when, the page does.
const PAGE_HASH_FILES=['index.html','shim.js','config.js','client-shell.js','client-shell.css','client-viewer.css','map-shell.js','map-shell.css','operations.js','operations.css','xp-tracker.js','runelite-chrome.css'];
let deployedPage:string|null|undefined;
export function pageHash(dir:string):string|null{
 const h=createHash('sha1');let any=false;
 for(const f of PAGE_HASH_FILES){try{h.update(f+'\0');h.update(readFileSync(join(dir,f)));any=true;}catch{/* not in this site */}}
 return any?h.digest('hex').slice(0,16):null;
}

// The 3D viewer reads api/our-names beside the page for the gold nameplates of our accounts. export-viewer.ts writes that
// file at a viewer import only, so each site push writes it again from the local server's /api/our-names (every live
// account on this PC and every account another side publishes): an account made after the import still gets its
// nameplate. Null keeps the imported file: no list, an empty one, or a list that is not names.
export function ourNamesFile(names:unknown,main:string):string|null{
 if(!Array.isArray(names))return null;
 const keep=[...new Set(names.filter((n):n is string=>typeof n==='string'&&/^[A-Za-z0-9 _-]{1,12}$/.test(n)&&n.toLowerCase()!==main.toLowerCase()))].sort();
 return keep.length?JSON.stringify(keep):null;
}

// The site folder goes out only when its page links resolve, the import contract holds and no file names the main
// account. A refused folder stays unpushed: the live page keeps the last good push.
export async function pushAuditedSite(site:string,push:(dir:string)=>Promise<string>=pushPublicCommit):Promise<{result:string;audit:BundleAudit}>{
 let audit:BundleAudit;
 try{audit=verifyStaticBundle(site,MAIN_ACCOUNT,{verifyImportContract:true,allowWebpImages:true});}
 catch(e){audit={ok:false,checkedFiles:0,checkedAssets:0,missing:[`audit error: ${String(e instanceof Error?e.message:e).slice(0,120)}`],leaks:[]};}
 if(!audit.ok)return {result:`audit-failed (${[...audit.missing,...audit.leaks.map(f=>`leak ${f}`)].slice(0,3).join(', ')})`,audit};
 return {result:await push(site),audit};
}

// GitHub Pages deploys the site branch with a build that takes 20 to 50 s, and a build can fail or hang at `building`
// (the live page then stays one push behind). One read of the latest build, PAGES_CHECK_MS after a push, tells. A push
// made before that read joins it and leaves its deadline, so pushes more often than PAGES_CHECK_MS cannot put the read
// off. An errored, hung or missing build gets one rebuild request and one more read. The publisher and the signed-in
// page share one API rate limit, so a push whose page builds costs at most one call.
export const PAGES_CHECK_MS=180_000;
export type PagesWatch={pushes:{commit:string;at:number}[];dueAt:number;rebuilt:boolean};
export function watchPush(watch:PagesWatch|null,commit:string,now:number):PagesWatch{
 return watch?{...watch,pushes:[...watch.pushes,{commit,at:now}]}:{pushes:[{commit,at:now}],dueAt:now+PAGES_CHECK_MS,rebuilt:false};
}
type Api=(...args:string[])=>Promise<{ok:boolean;out:string}>;
export async function checkPages(watch:PagesWatch|null,now:number,api:Api,repo:string):Promise<{watch:PagesWatch|null;note:string}>{
 if(!watch||now<watch.dueAt)return {watch,note:''};
 const read=await api('api',`repos/${repo}/pages/builds/latest`);
 let build:{status?:string;commit?:string;error?:{message?:string|null}|null}|null=null;
 if(read.ok)try{build=JSON.parse(read.out);}catch{/* reported below */}
 if(!build)return {watch:null,note:` pages=unread (${read.out.slice(0,120)})`};
 // A push younger than PAGES_CHECK_MS may still be waiting for its build. The page is sound when the build is of one
 // of these pushes, every later push is young, and a running build belongs to a young push.
 const young=(p:{at:number}|undefined)=>!p||now-p.at<PAGES_CHECK_MS;
 const i=watch.pushes.findIndex(p=>p.commit===build!.commit),later=watch.pushes[i+1];
 const state=build.status==='errored'?'errored'
  :build.status==='built'?(i>=0&&young(later)?'built':'behind')
  :i>=0&&young(watch.pushes[i])?'building':'stuck';
 if(state==='built'||state==='building')return {watch:null,note:` pages=${state}${watch.rebuilt?' after rebuild':''}`};
 const reason=build.error?.message?` (${String(build.error.message).slice(0,120)})`:'';
 if(watch.rebuilt)return {watch:null,note:` pages=${state}${reason} rebuild=spent`};
 const rebuild=await api('api','-X','POST',`repos/${repo}/pages/builds`);
 if(!rebuild.ok)return {watch:null,note:` pages=${state}${reason} rebuild=refused (${rebuild.out.slice(0,120)})`};
 return {watch:{...watch,dueAt:now+PAGES_CHECK_MS,rebuilt:true},note:` pages=${state}${reason} rebuild=requested`};
}

// True when the hosted page's index.html holds the expandQuests function of the packed quest state (quest-pack.ts).
export function hostedPageExpandsQuests(main:string):boolean{
 try{return readFileSync(join(main,'site','index.html'),'utf8').includes('function expandQuests(');}catch{return false;}
}

async function cycle(){
 const now=Date.now();
 let {state,meta,map}=await collect();
 let note=`bots=${state.bots?.length??0} tasks=${state.coordination?.tasks?.length??0}`;
 if(map){writeAtomic(join(DIR,'out','map.bin'),map);mapWritten=true;note+=' map=written';}
 if(REPO){
  const main=await ensureClone();await pullMain(main);
  const applied=await pollCommands(now,meta?.nonce??null);
  if(applied){({state,meta}=await collect());note+=` commands=${applied}`;}
 }
 // The hosted page lives in the dashboard repository (main/site), deployed apart from this publisher. Packed quests go out
 // only when that page can expand them; otherwise the data keeps the old quest shape, so an old page never shows empty quests.
 if(!(REPO&&hostedPageExpandsQuests(join(DIR,'repo'))))state=expandQuests(state),delete state.questList;
 // A hosted tab reloads when pageVersion changes. The local server's value is the mtime of this PC's page files, which
 // change at every checkout update; the hosted tab runs the page deployed on the site branch, so that page's hash goes out.
 if(REPO){deployedPage??=pageHash(join(DIR,'site'));state={...state,pageVersion:deployedPage};}
 // The public view refuses a state that still names the main account. The owner's control view must still go out.
 const controlObj=controlView(state,meta),control=JSON.stringify(controlObj);
 let pubObj:any=null,pub:string|null=null,pubError:unknown=null;
 try{pubObj=publicView(state,MAIN_ACCOUNT,getExpectedDrops());pub=JSON.stringify(pubObj);}catch(e){pubError=e;}
 writeAtomic(join(DIR,'out','control.json'),control);if(pub!==null)writeAtomic(join(DIR,'out','public.json'),pub);
 if(REPO){
  const main=join(DIR,'repo');
  const controlStable=withoutClocksHashValue(controlObj);
  if(pushDue(control,lastControl,now,controlStable)){writeAtomic(join(DIR,'data','control.json'),control);note+=` data=${await pushSingleCommit(join(DIR,'data'),'data','fleet control state')}`;lastControl={stable:controlStable,at:now};}else note+=' data=unchanged';
  const pages=await checkPages(pagesWatch,now,gh,REPO);pagesWatch=pages.watch;note+=pages.note;
  // A server that has just started has no market prices or board tops yet; that thin file would stay live for a
  // whole push period, so the push waits for a warm state, at most three periods from the first cold cycle.
  const warm=stateWarm(state);if(warm)coldSince=0;else if(!coldSince)coldSince=now;
  const pubStable=pubObj!==null?withoutClocksHashValue(pubObj):undefined;
  if(pub!==null&&pushDue(pub,lastPublic,now,pubStable)&&now-lastSitePush>=PUBLIC_MS&&(warm||now-coldSince>=3*PUBLIC_MS)){
   const site=join(DIR,'site');
   for(const n of readdirSync(site))if(n!=='.git')rmSync(join(site,n),{recursive:true,force:true});
   if(existsSync(join(main,'site')))cpSync(join(main,'site'),site,{recursive:true});
   // The file goes out with the page it deploys beside, so a tab that loads the new page does not reload again.
   const page=pageHash(site);if(page!==pubObj.pageVersion){pubObj.pageVersion=page;pub=JSON.stringify(pubObj);}
   writeFileSync(join(site,'public.json'),pub);writeFileSync(join(site,'.nojekyll'),'');
   if(existsSync(join(DIR,'out','map.bin')))cpSync(join(DIR,'out','map.bin'),join(site,'map.bin'));
   const names=ourNamesFile(await dash('/api/our-names',undefined,10_000).then(r=>r.ok?r.json():null).catch(()=>null),MAIN_ACCOUNT);
   if(names){mkdirSync(join(site,'api'),{recursive:true});writeFileSync(join(site,'api','our-names'),names);}
   // A refused folder waits a whole push period too: the next try copies main's site/ again.
   const {result}=await pushAuditedSite(site);note+=` site=${result}`;lastSitePush=now;
   if(result==='pushed'||result==='unchanged'){lastPublic={stable:withoutClocksHashValue(pubObj),at:now};deployedPage=page;}
   if(result==='pushed'){const head=await git(site,'rev-parse','HEAD');if(head.ok)pagesWatch=watchPush(pagesWatch,head.out,now);}
  }
 }
 if(pub===null)throw pubError;
 log(`PUBLISH ok ${new Date(now).toISOString()} ${note} control=${Math.round(control.length/1024)}K public=${Math.round(pub.length/1024)}K`);
}

if(import.meta.main){
 const lock=join(prac,'dashboard-publish.lock');
 if(process.argv.includes('--daemon')){
  const out=openSync(join(prac,'dashboard-publish.log'),'a');
  const child=spawn(process.execPath,['--smol',join(root,'packages','dashboard','publish.ts')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,out],env:leanBunEnv({...process.env,PUBLISH_LOG_DIRECT:'1'})});
  closeSync(out);child.unref();console.log(`PUBLISH started pid ${child.pid} (log .practice/dashboard-publish.log)`);process.exit(0);
 }
 if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));if(pid>0&&pid!==process.pid&&alive(pid)){log(`PUBLISH already running pid ${pid}`);process.exit(0);}}
 mkdirSync(prac,{recursive:true});writeFileSync(lock,String(process.pid));
 const release=()=>{try{if(readFileSync(lock,'utf8')===String(process.pid))rmSync(lock);}catch{/* gone */}};
 process.on('exit',release);process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
 const once=process.argv.includes('--once');
 for(;;){
  if(!once&&reloadDue(root,'dashboard-publish',startedAt)){
   release();
   // respawnDaemon passes process.env on, so a successor of a foreground run writes its own lines too.
   process.env.PUBLISH_LOG_DIRECT='1';
   const pid=respawnDaemon(root,[join(root,'packages/dashboard/publish.ts'),...process.argv.slice(2)],join(prac,'dashboard-publish.log'));
   log(`PUBLISH reload after a live update: successor pid ${pid}`);
   process.exit(0);
  }
  try{await cycle();}catch(e){log(`PUBLISH fail ${String(e).slice(0,300)}`);if(once)process.exit(1);}
  if(once)break;
  Bun.gc(false);
  await Bun.sleep(CYCLE_MS);
 }
}
