// Archives, then deletes, the scratch entries that tests and proofs left at the top of .practice. Each entry matches
// one exact name rule below; anything else stays. Default is a dry run that prints counts and moves nothing.
//   recovery-permit-*, session-recovery-*, recovery-cli-<word>-*, recovery-stop-*  scratch folders of core tests
//                                                       (6 random characters after the prefix; mkdtemp)
//   stop-<generated fixture account>                    stop files that native proofs retain for a retired identity
// A stop file stays when: its name is not a generated fixture account (fl..x.., fb<n>.., rngex..: all lower case),
// its text does not begin with a proof-generated string (PROOF_STOP_TEXT), a swarm.json or jobs.json job names the account, or fleet/owners.json names it. An entry written in
// the last GRACE_MS stays, because a run may still own it.
// --fleet-orders: the orders and receipts in .practice/fleet-data/fleet that every agent cycle reads whole. An order whose
// window ended more than FLEET_KEEP_DAYS ago, with its receipts (<id>.from.json, <id>.to.json), moves to
// fleet/archive/<YYYY-MM>/{orders,receipts}. An order that is open or ended more recently stays, and so does a receipt whose
// order is not archived. fleet-sync commits the move on the fleet-data branch: run --apply with the fleet-sync owner.
// Usage: bun tools/practice-hygiene.ts [--root DIR] [--apply --archive-dir D:/rs-sdk-bot-archive]
//        bun tools/practice-hygiene.ts --fleet-orders [--keep-days 7] [--apply]
//        bun tools/practice-hygiene.ts --phase0 [--root DIR] [--apply] [--json] [--grace-ms MS]
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolveFleetDataDir} from '../packages/core/src/practice-paths';
import {
 applyPhase0Hygiene,
 scanPhase0Hygiene,
 isProtectedStopEntry,
 PROTECTED_STOP_FLAGS,
 DEFAULT_FIXTURE_GRACE_MS,
} from '../packages/fleet/src/hygiene';
export {
 applyPhase0Hygiene,
 scanPhase0Hygiene,
 isProtectedStopEntry,
 PROTECTED_STOP_FLAGS,
};

export const GRACE_MS=3600_000;
export const DEFAULT_ARCHIVE_DIR='D:/rs-sdk-bot-archive';
const SCRATCH_DIRS=/^(recovery-permit|session-recovery|recovery-cli-[a-z]+|recovery-stop)-[A-Za-z0-9]{6}$/;
// The first words of the stop files that the native proofs write themselves (session-recovery-proof.ts, cow-progress-order-proof.ts).
// Any other text is an owner's or an agent's note and stays.
export const PROOF_STOP_TEXT=/^(native recovery proof stop |native completed stop |cow-progress-order proof stop )/;
const FIXTURE_STOP=/^stop-(fl[a-z]*x[a-z0-9]+|fb\d[a-z0-9]*|rngex[a-z0-9]+)$/;

export type Kind='scratch-dir'|'fixture-stop';
export type Entry={name:string;kind:Kind};

// The account names that a job of swarm.json or jobs.json names, lower case. A job counts when it names the account,
// enabled or not: a name in a plan is a real account, never a fixture.
export function namedAccounts(root:string):Set<string>{
 const names=new Set<string>();
 const add=(v:unknown)=>{if(typeof v==='string')names.add(v.toLowerCase());};
 const walk=(v:any,depth=0)=>{if(depth>6||!v||typeof v!=='object')return;
  if(Array.isArray(v)){for(const x of v)walk(x,depth+1);return;}
  add(v.account);if(Array.isArray(v.accounts))v.accounts.forEach(add);for(const k of Object.keys(v))walk(v[k],depth+1);};
 for(const file of [join(root,'swarm.json'),join(root,'.practice','coordinator','jobs.json'),join(root,'fleet','owners.json')])
  try{walk(JSON.parse(readFileSync(file,'utf8')));}catch{/* a missing plan names nobody */}
 return names;
}

export function classify(name:string,isFile:boolean,text:string|undefined,mtimeMs:number,now:number,named:ReadonlySet<string>):Kind|null{
 if(now-mtimeMs<GRACE_MS)return null;
 if(!isFile&&SCRATCH_DIRS.test(name))return 'scratch-dir';
 if(isFile&&FIXTURE_STOP.test(name)){
  if(text===undefined||!PROOF_STOP_TEXT.test(text))return null;
  if(named.has(name.slice('stop-'.length).toLowerCase()))return null;
  return 'fixture-stop';
 }
 return null;
}

export function scan(root:string,now=Date.now()):Entry[]{
 const prac=join(root,'.practice'),named=namedAccounts(root),out:Entry[]=[];
 for(const name of readdirSync(prac)){
  if(!/^(recovery-|session-recovery-|stop-)/.test(name))continue;
  const path=join(prac,name);
  try{
   const info=lstatSync(path);if(info.isSymbolicLink())continue;
   const isFile=info.isFile();
   const kind=classify(name,isFile,isFile&&info.size<4096?readFileSync(path,'utf8'):undefined,info.mtimeMs,now,named);
   if(kind)out.push({name,kind});
  }catch{/* an entry that cannot be read stays */}
 }
 return out;
}

export function counts(entries:Entry[]){
 const by:Record<string,number>={};
 for(const e of entries){const k=e.kind==='fixture-stop'?'stop-fixture':e.name.replace(/-[A-Za-z0-9]{6}$/,'-*');by[k]=(by[k]??0)+1;}
 return by;
}

export function archiveThenDelete(root:string,entries:Entry[],archiveDir:string,stamp=new Date().toISOString().replace(/[:.]/g,'-'),run:typeof spawnSync=spawnSync,exists:(path:string)=>boolean=existsSync){
 // The parent of the archive folder must exist and be a folder; only the archive folder itself is made, never its parents.
 // A Windows drive path on Linux is a relative path whose parent does not exist, so it stops here on both systems.
 const parent=dirname(resolve(archiveDir));
 if(!exists(parent))throw Error('archive parent is missing: '+archiveDir);
 if(!statSync(parent).isDirectory())throw Error('archive parent is not a directory: '+archiveDir);
 try{mkdirSync(archiveDir);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}

 const prac=join(root,'.practice'),archive=join(archiveDir,`practice-hygiene-${stamp}.tar.gz`),list=join(archiveDir,`practice-hygiene-${stamp}.list`);
 writeFileSync(list,entries.map(e=>e.name).join('\n')+'\n');
 const base=`practice-hygiene-${stamp}.tar.gz`,made=run('tar',['-czf',base,'-C',prac,'-T',`practice-hygiene-${stamp}.list`],{cwd:archiveDir,encoding:'utf8',windowsHide:true,maxBuffer:1<<28});
 if(made.status!==0)throw Error('archive failed: '+(made.stderr||made.error));
 // Read the archive back: every top-level name must be a member before anything is deleted.
 const listing=run('tar',['-tzf',base],{cwd:archiveDir,encoding:'utf8',windowsHide:true,maxBuffer:1<<28});
 if(listing.status!==0)throw Error('archive read-back failed: '+listing.stderr);
 const members=new Set(listing.stdout.split(/\r?\n/).map(l=>l.replace(/\/.*$/,'')));
 const missing=entries.filter(e=>!members.has(e.name));
 if(missing.length)throw Error(`archive misses ${missing.length} entries, first ${missing[0]!.name}; nothing deleted`);
 let deleted=0;
 for(const e of entries){const path=join(prac,e.name);try{if(lstatSync(path).isSymbolicLink())continue;rmSync(path,{recursive:true,force:true});deleted++;}catch{/* kept */}}
 return {archive,deleted,bytes:statSync(archive).size};
}

export const FLEET_KEEP_DAYS=7;
export type FleetMove={id:string;month:string;files:{dir:'orders'|'receipts';name:string}[]};
export function scanFleetOrders(fleetDir:string,now=Date.now(),keepDays=FLEET_KEEP_DAYS):{moves:FleetMove[];kept:number;orphanReceipts:number;receiptsMoved:number}{
 const list=(d:string)=>existsSync(join(fleetDir,d))?readdirSync(join(fleetDir,d)).filter(f=>f.endsWith('.json')):[];
 const receipts=list('receipts'),moves:FleetMove[]=[];let kept=0;
 const claimed=new Set<string>();
 for(const name of list('orders')){
  let order:any;try{order=JSON.parse(readFileSync(join(fleetDir,'orders',name),'utf8'));}catch{kept++;continue;}
  const id=typeof order?.id==='string'?order.id:null,end=Number(order?.end);
  if(!id||name!==id+'.json'||!Number.isFinite(end)||now-end<keepDays*86_400_000){kept++;continue;}
  const month=new Date(end).toISOString().slice(0,7),files:FleetMove['files']=[{dir:'orders',name}];
  for(const r of receipts)if(r===id+'.json'||r.startsWith(id+'.')){files.push({dir:'receipts',name:r});claimed.add(r);}
  moves.push({id,month,files});
 }
 return {moves,kept,orphanReceipts:receipts.filter(r=>!claimed.has(r)).length,receiptsMoved:claimed.size};
}
export function applyFleetMoves(fleetDir:string,moves:FleetMove[]){
 let moved=0;
 for(const m of moves)for(const f of m.files){
  const to=join(fleetDir,'archive',m.month,f.dir);mkdirSync(to,{recursive:true});
  if(existsSync(join(to,f.name)))continue;
  renameSync(join(fleetDir,f.dir,f.name),join(to,f.name));moved++;
 }
 return moved;
}

export const fleetOrdersDir=(root:string)=>join(resolveFleetDataDir(root),'fleet');

if(import.meta.main){
 const args=process.argv.slice(2),arg=(k:string)=>{const i=args.indexOf(k);return i>=0?args[i+1]:undefined;};
 const root=resolve(arg('--root')??join(import.meta.dir,'..')),apply=args.includes('--apply');
 if(args.includes('--phase0')){
  const graceRaw=arg('--grace-ms'),fixtureGraceMs=graceRaw!==undefined&&Number.isFinite(Number(graceRaw))?Number(graceRaw):DEFAULT_FIXTURE_GRACE_MS;
  const r=applyPhase0Hygiene(root,{dry:!apply,fixtureGraceMs});
  if(args.includes('--json'))console.log(JSON.stringify(r,null,2));
  else{
   console.log(JSON.stringify({root:r.root,dry:r.dry,totalFindings:r.findings.length,counts:r.counts,applied:r.applied,preserved:r.preserved.length,errors:r.errors.length}));
   console.log(`RESULT ${r.errors.length?'fail':'ok'} practice-hygiene phase0 ${r.dry?'would clear':'cleared'} ${r.dry?r.findings.length:r.applied} items (preserved ${r.preserved.length})`);
  }
  if(r.errors.length>0)process.exit(1);
  process.exit(0);
 }
 if(args.includes('--fleet-orders')){
  const fleetDir=fleetOrdersDir(root),r=scanFleetOrders(fleetDir,Date.now(),Number(arg('--keep-days')??FLEET_KEEP_DAYS));
  const months:Record<string,number>={};for(const m of r.moves)months[m.month]=(months[m.month]??0)+1;
  console.log(JSON.stringify({fleetDir,ordersToArchive:r.moves.length,receiptsToArchive:r.receiptsMoved,ordersKept:r.kept,receiptsWithoutArchivedOrder:r.orphanReceipts,byMonth:months}));
  if(!apply)console.log(`RESULT ok practice-hygiene fleet-orders would move ${r.moves.length} orders (dry run)`);
  else console.log(`RESULT ok practice-hygiene fleet-orders moved ${applyFleetMoves(fleetDir,r.moves)} files`);
  process.exit(0);
 }
 const entries=scan(root);
 console.log(JSON.stringify({root,total:entries.length,byRule:counts(entries),graceMs:GRACE_MS}));
 if(!apply)console.log(`RESULT ok practice-hygiene would archive then delete ${entries.length} entries (dry run)`);
 else{
  const r=archiveThenDelete(root,entries,arg('--archive-dir')??DEFAULT_ARCHIVE_DIR);
  console.log(`RESULT ok practice-hygiene archived ${entries.length} to ${r.archive} (${r.bytes} bytes), deleted ${r.deleted}`);
 }
}
