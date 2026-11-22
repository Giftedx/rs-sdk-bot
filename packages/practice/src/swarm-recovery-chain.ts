import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,copyFileSync,cpSync,lstatSync,unlinkSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {prepareCoinProofRoot,removeCoinProofRoot} from './coin-courier-proof';
import {copySourceTree,linkSourceDirectory,SOURCE_COPY_SKIP} from './replay-root';
import {capabilityRevision,runtimeTrees} from '../../core/src/worker-release';
import {accountDir,readLogoutProof} from '../../core/src/session-lifecycle';
import {assertNativeFixtureRoot} from '../../core/src/session-recovery-permit';
import {acquireFleetTradeClaim,readAllFleetAccountClaims} from '../../core/src/fleet-trade-claim';
import {fleetGitWindow} from '../../core/src/fleet-lease';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {killTree} from '../../core/src/proc';
import {SWARM_STOP,clearSwarmStop} from '../../../scripts/swarm';
import {withPlanWrite} from '../../core/src/plan-lock';

// The part of vendor/rs-sdk/server/content that a runtime copy holds. The whole tree is over 10,000 files and is most
// of the copy: the engine and the workers of a recovery proof read all of it.
export type RuntimeContent=(file:string)=>boolean;
export const wholeContent:RuntimeContent=()=>true;
// The files that loadDanger reads (packages/core/src/randomevents.ts): the npc pack and the npc configs. A check of
// the danger content alone copies these, about 150 files. The paths are relative to the content folder.
export const dangerContent:RuntimeContent=file=>file==='pack/npc.pack'||file.startsWith('scripts/')&&file.endsWith('.npc');
function copyContent(from:string,to:string,keep:RuntimeContent,prefix=''){
 for(const entry of readdirSync(from,{withFileTypes:true})){
  if(SOURCE_COPY_SKIP.has(entry.name))continue;
  const path=prefix+entry.name;
  if(entry.isDirectory())copyContent(join(from,entry.name),join(to,entry.name),keep,path+'/');
  else if(entry.isFile()&&keep(path)){mkdirSync(to,{recursive:true});copyFileSync(join(from,entry.name),join(to,entry.name));}
 }
}
export function materializeSwarmRuntime(sourceRoot:string,root:string,content:RuntimeContent=wholeContent){
 const links:string[]=[];
 for(const path of ['vendor/rs-sdk/sdk','vendor/rs-sdk/server']){const p=join(root,path);if(lstatSync(p).isSymbolicLink())unlinkSync(p);mkdirSync(p,{recursive:true});}
 for(const path of runtimeTrees)copySourceTree(join(sourceRoot,path),join(root,path));
 for(const dir of ['vendor/rs-sdk/server/webclient','vendor/rs-sdk/server/engine']){
  mkdirSync(join(root,dir),{recursive:true});
  if(existsSync(join(sourceRoot,dir,'package.json')))copyFileSync(join(sourceRoot,dir,'package.json'),join(root,dir,'package.json'));
  if(existsSync(join(sourceRoot,dir,'tsconfig.json')))copyFileSync(join(sourceRoot,dir,'tsconfig.json'),join(root,dir,'tsconfig.json'));
  const link=join(root,dir,'node_modules');linkSourceDirectory(join(sourceRoot,dir,'node_modules'),link);if(existsSync(link))links.push(link);
 }
 copySourceTree(join(sourceRoot,'vendor/rs-sdk/server/engine/src'),join(root,'vendor/rs-sdk/server/engine/src'));
 if(content===wholeContent)copySourceTree(join(sourceRoot,'vendor/rs-sdk/server/content'),join(root,'vendor/rs-sdk/server/content'));
 else copyContent(join(sourceRoot,'vendor/rs-sdk/server/content'),join(root,'vendor/rs-sdk/server/content'),content);
 return links;
}

// The private bare Git authority lives under the short private root, not under the delivery case folder: a push
// writes objects/tmp_objdir-incoming-XXXXXX/NN/<38 hex> under the remote, which passes the Windows path limit of 260
// characters below a deep case folder.
const PRIVATE_AUTHORITY='.authority.git';
export function privateAuthorityPath(root:string){return join(root,PRIVATE_AUTHORITY);}

// An actual Swarm CLI with byte-identical source, loopback profiles and a private bare Git authority.
// Recovery itself stays in the outer guarded dispatcher; no live controller root/server is redirected.
export async function proveSwarmRecoveryContinuation(input:{sourceRoot:string;directory:string;account:string;server:string;profile:string;save:string;observerDelivery:string}){
 const {sourceRoot,directory,account,server,profile,save}=input,root=prepareCoinProofRoot(sourceRoot,tmpdir());
 const children:ReturnType<typeof Bun.spawn>[]=[],hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const put=(p:string,value:unknown)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),JSON.stringify(value,null,2));};
 let passed=false;const privateLinks:string[]=[];
 const git=(args:string[])=>{const r=Bun.spawnSync(['git',...args],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});if(r.exitCode!==0)throw Error('private swarm Git operation failed');return r.stdout.toString().trim();};
 const wait=async(check:()=>boolean,reason:string,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;if(children.some(p=>p.exitCode!==null&&p.exitCode!==0))throw Error('private swarm child exited; retain phase logs');if(/^(gave-up|blocked|died|exit)\b/.test(json('.practice/swarm-deaths.json')?.[account]?.reason??''))throw Error('private swarm worker ended unsuccessfully; retain worker log');await Bun.sleep(100);}throw Error('private swarm '+reason);};
 const json=(p:string)=>{try{return JSON.parse(readFileSync(join(root,p),'utf8'));}catch{return null;}};
 try{
  if(!/^flrcvx[a-z0-9]+$/.test(account))throw Error('private swarm actor is not a generated recovery fixture');
  const report=JSON.parse(readFileSync(join(input.observerDelivery,'report.json'),'utf8'));
  if(report.id!=='owned-bank-observation'||report.ok!==true||report.stage!=='delivered'||report.runtimeRevision!==capabilityRevision(['scripts/aio-logistics.ts'],sourceRoot))throw Error('private swarm needs current completed observer qualification before the outer native lock');
  const verification=Bun.spawnSync([process.execPath,join(sourceRoot,'scripts/measure/catalog-integration-proof.ts'),'--verify','observer'],{cwd:sourceRoot,env:{...process.env,DELIVERY_DIR:input.observerDelivery},stdout:'pipe',stderr:'pipe',windowsHide:true});
  writeFileSync(join(directory,'observer-verifier.log'),verification.stdout);writeFileSync(join(directory,'observer-verifier.err'),verification.stderr);
  if(verification.exitCode!==0)throw Error('private swarm observer saved-proof verification failed');
  copyFileSync(join(input.observerDelivery,'report.json'),join(directory,'observer-delivery.json'));
  // Materialize only runtime code. Never copy any existing account profile or bot.env.
  privateLinks.push(...materializeSwarmRuntime(sourceRoot,root));
  if(existsSync(join(root,'.practice/cache'))&&lstatSync(join(root,'.practice/cache')).isSymbolicLink())unlinkSync(join(root,'.practice/cache'));
  assertNativeFixtureRoot(root,server);
  const profileLink=join(root,'vendor/rs-sdk/bots',account);symlinkSync(dirname(profile),profileLink,process.platform==='win32'?'junction':'dir');privateLinks.push(profileLink);
  if(existsSync(join(root,'.git')))unlinkSync(join(root,'.git'));
  git(['init','-q','-b','master']);git(['config','user.name','Native controller proof']);git(['config','user.email','native@example.invalid']);
  git(['commit','--allow-empty','-qm','Private native controller authority']);
  const remote=privateAuthorityPath(root);git(['init','--bare','-q',remote]);git(['-C',remote,'config','core.longpaths','true']);git(['remote','add','origin',remote]);
  mkdirSync(join(root,'.git/info'),{recursive:true});writeFileSync(join(root,'.git/info/exclude'),'/'+PRIVATE_AUTHORITY+'/\n',{flag:'a'});writeFileSync(join(directory,'private-authority.txt'),remote+'\n');
  const reserved=Array.from({length:12},(_,i)=>'fxreserve'+i),owned=[account,...reserved];
  put('fleet/owners.json',{accounts:Object.fromEntries(owned.map(n=>[n,{side:'cloud',server}]))});
  const claim=acquireFleetTradeClaim(root,{account,server,side:'cloud',orderId:'native-observer-precondition',role:'from'});claim.release();
  for(const name of reserved.slice(0,7))acquireFleetTradeClaim(root,{account:name,server,side:'cloud',orderId:'native-reserved-'+name,role:'from'});
  const claimsBefore=readAllFleetAccountClaims(fleetGitWindow(root));
  const stableClaims=()=>JSON.stringify([...readAllFleetAccountClaims(fleetGitWindow(root))])===JSON.stringify([...claimsBefore]);
  const flags={LOOT_WATCH:'0',RANDOM_EVENTS:'0',TICK_RECORD:'1'},job={account,script:'scripts/session-check.ts',enabled:true,repeat:false,maxRestarts:0,standingRetry:false,env:flags};
  const reservations=reserved.map(account=>({account,enabled:false,repeat:false,role:'reserved'}));
  const planPath=join(root,'.practice/selected-swarm.json'),plan={maxBots:4,minFreeGB:4,fleetCapacity:4,jobs:[job,...reservations]};put('.practice/selected-swarm.json',plan);
  const env={...process.env,FLEET_SIDE:'cloud',FLEET_DIR:join(root,'fleet'),SWARM_PLAN:planPath,FLEET_ADOPT:'0',CLOUD_WATCH_ID:'',WORKER_RELEASE:'',WORKER_ENTRY:'',COORDINATOR_RUN_ID:'',DEMO_OK:'1'};
  const launch=(label:string)=>{const p=Bun.spawn([process.execPath,join(root,'scripts/swarm.ts'),planPath],{cwd:root,env,stdout:Bun.file(join(directory,label+'.log')),stderr:Bun.file(join(directory,label+'.err')),detached:true,windowsHide:true});children.push(p);return p;};
  const shutdown=async(p:ReturnType<typeof Bun.spawn>)=>{writeFileSync(join(root,'.practice/stop-swarm'),SWARM_STOP.all);await wait(()=>p.exitCode!==null,'shutdown did not settle',45000);if(await p.exited!==0)throw Error('private swarm shutdown failed');if(readFileSync(join(root,'.practice/stop-swarm'),'utf8')===SWARM_STOP.all)unlinkSync(join(root,'.practice/stop-swarm'));};
  const before=readPracticeSave(save);copyFileSync(save,join(directory,'swarm-before.sav'));const first=launch('session-check-swarm');
  await wait(()=>/^done after 1 runs$/.test(json('.practice/swarm-deaths.json')?.[account]?.reason??''),'session check did not produce actual done end');
  const completed=readFileSync(join(root,'.practice/swarm-deaths.json'),'utf8');writeFileSync(join(directory,'completed-end.json'),completed);
  const completedProof=readLogoutProof(account,server,{root:join(root,'.practice/session-lifecycle')});
  if(completedProof.state!=='confirmed')throw Error('actual swarm session check did not confirm logout');
  await shutdown(first);
  const checkedSave=await waitPracticeSave(save,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
  copyFileSync(save,join(directory,'swarm-session-check.sav'));
  const readPlan=(stage:string)=>{const raw=readFileSync(planPath),actual=JSON.parse(raw.toString());writeFileSync(join(directory,stage+'-plan.json'),raw);return {unchanged:JSON.stringify(actual.jobs.slice(1))===JSON.stringify(reservations),sha256:createHash('sha256').update(raw).digest('hex')};};
  const recoveryPlan=readPlan('session-check');
  const checks:any={actualSessionCheckDone:true,sessionCheckLogout:true,actualSessionCheckSwarmShutdown:true,sessionCheckFreshSave:checkedSave.matched,releasedClaimStable:stableClaims(),reservationsPreserved:recoveryPlan.unchanged};
  clearSwarmStop(join(root,'.practice','stop-'+account));
  const inspect={...job,script:'scripts/aio-logistics.ts',args:['inspect'],enabled:false,env:{...flags,REQUIRE_BANK:'1'}};
  const next={...plan,jobs:[inspect,...reservations],coordination:{boundedInspection:[account]}};put('.practice/selected-swarm.json',next);
  const second=launch('inspection-swarm');
  await wait(()=>{const s=json('.practice/swarm-state.json');return s?.controllerPid===second.pid&&s.jobs.some((j:any)=>j.account===account&&j.state==='disabled');},'disabled inspector not observed');
  await withPlanWrite(()=>{inspect.enabled=true;put('.practice/selected-swarm.json',next);},join(root,'.practice/coordinator'));
  checks.completedEndRetainedOnEnable=readFileSync(join(root,'.practice/swarm-deaths.json'),'utf8')===completed;
  await wait(()=>json('.practice/status/'+account+'.json')?.result?.includes('bankObserved=1'),'new finite inspector did not observe bank',120000);
  await wait(()=>/^done after 1 runs$/.test(json('.practice/swarm-deaths.json')?.[account]?.reason??'')&&readFileSync(join(root,'.practice/swarm-deaths.json'),'utf8')!==completed,'inspector end not owned by swarm');
  await shutdown(second);
  const inspectionPlan=readPlan('inspection');checks.inspectionReservationsPreserved=inspectionPlan.unchanged;
  const log=readFileSync(join(root,'.practice/swarm-logs',account+'.log'),'utf8'),status=json('.practice/status/'+account+'.json'),proof=readLogoutProof(account,server,{root:join(root,'.practice/session-lifecycle')});
  const observation=JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('BANK_OBSERVED ')).at(-1)?.slice(14)??'null');
  const bank=JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('BANK ')).at(-1)?.slice(5)??'null');
  const publication=await waitPracticeSave(save,s=>(s.vars[134]??0)>(checkedSave.save.vars[134]??0),{timeoutMs:15000});
  const after=readPracticeSave(save),totals=(s:any)=>JSON.stringify(s.inventories);
  const items=(rows:any[])=>JSON.stringify(rows.filter(r=>r.count>0&&(r.baseId??r.id)>=0).map(r=>[r.baseId??r.id,r.count]).sort((a,b)=>a[0]-b[0]));
  Object.assign(checks,{actualNewMission:status.workEntry==='scripts/aio-logistics.ts',sourcePinned:status.workRevision===capabilityRevision(['scripts/aio-logistics.ts'],sourceRoot),freshBank:Array.isArray(bank)&&observation?.generation>0&&observation.at>=status.started,
   exactBank:Array.isArray(bank)&&items(bank)===items(before.inventories[95]??[]),inspectorFreshSave:publication.matched,
   inspectorLogout:proof.state==='confirmed'&&proof.attemptId!==completedProof.attemptId&&observation?.at<=proof.loggedOutAt,assets:totals(before)===totals(after),skills:JSON.stringify(before.skills)===JSON.stringify(after.skills),hp:before.skills[3]!.level===after.skills[3]!.level,position:JSON.stringify(before.position)===JSON.stringify(after.position),otherClaimsPreserved:stableClaims()});
  writeFileSync(join(directory,'swarm-worker.log'),log);writeFileSync(join(directory,'inspector-status.json'),JSON.stringify(status));writeFileSync(join(directory,'inspector-proof.json'),JSON.stringify(proof));
  cpSync(accountDir(account,server,join(root,'.practice/session-lifecycle')),join(directory,'swarm-lifecycle'),{recursive:true});
  copyFileSync(save,join(directory,'swarm-after.sav'));
  writeFileSync(join(directory,'swarm-chain-checks.json'),JSON.stringify({checks,evidenceScope:'native Swarm components; no cloud-side/coordinator full E2E/live',source:hash(join(sourceRoot,'scripts/swarm.ts')),privateSource:hash(join(root,'scripts/swarm.ts')),plans:{recovery:recoveryPlan.sha256,inspection:inspectionPlan.sha256},authority:'private bare Git and loopback world; local sessions do not acquire shared gameplay claims'},null,2));
  if(!Object.values(checks).every(v=>v===true))throw Error('actual swarm continuation checks failed');
  passed=true;return checks as Record<string,boolean>;
 }finally{
  for(const child of children)if(child.exitCode===null){writeFileSync(join(root,'.practice/stop-swarm'),SWARM_STOP.all);const timer=setTimeout(()=>void killTree(child.pid),15000);await child.exited;clearTimeout(timer);}
  for(const link of privateLinks)if(existsSync(link)&&lstatSync(link).isSymbolicLink())unlinkSync(link);
  if(passed)removeCoinProofRoot(root);else writeFileSync(join(directory,'retained-swarm-root.json'),JSON.stringify({root}));
 }
}
