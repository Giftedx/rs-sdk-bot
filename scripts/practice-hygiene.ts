// Archives, then deletes, the scratch entries that tests and proofs left at the top of .practice. Each entry matches
// one exact name rule below; anything else stays. Default is a dry run that prints counts and moves nothing.
//   recovery-permit-*, session-recovery-*, recovery-cli-<word>-*, recovery-stop-*  scratch folders of core tests
//                                                       (6 random characters after the prefix; mkdtemp)
//   stop-<generated fixture account>                    stop files that native proofs retain for a retired identity
// A stop file stays when: its name is not a generated fixture account (fl..x.., fb<n>.., rngex..: all lower case),
// its text is JSON, a swarm.json or jobs.json job names the account, or fleet/owners.json names it. An entry written in
// the last GRACE_MS stays, because a run may still own it.
// Usage: bun scripts/practice-hygiene.ts [--root DIR] [--apply --archive-dir D:/rs-sdk-bot-archive]
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

export const GRACE_MS=3600_000;
export const DEFAULT_ARCHIVE_DIR='D:/rs-sdk-bot-archive';
const SCRATCH_DIRS=/^(recovery-permit|session-recovery|recovery-cli-[a-z]+|recovery-stop)-[A-Za-z0-9]{6}$/;
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
  if(text===undefined||/^\s*[{[]/.test(text))return null;
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

export function archiveThenDelete(root:string,entries:Entry[],archiveDir:string,stamp=new Date().toISOString().replace(/[:.]/g,'-')){
 if(!existsSync(resolve(archiveDir,'..')))throw Error('archive drive is missing: '+archiveDir);
 mkdirSync(archiveDir,{recursive:true});

 const prac=join(root,'.practice'),archive=join(archiveDir,`practice-hygiene-${stamp}.tar.gz`),list=join(archiveDir,`practice-hygiene-${stamp}.list`);
 writeFileSync(list,entries.map(e=>e.name).join('\n')+'\n');
 const base=`practice-hygiene-${stamp}.tar.gz`,made=spawnSync('tar',['-czf',base,'-C',prac,'-T',`practice-hygiene-${stamp}.list`],{cwd:archiveDir,encoding:'utf8',windowsHide:true,maxBuffer:1<<28});
 if(made.status!==0)throw Error('archive failed: '+(made.stderr||made.error));
 // Read the archive back: every top-level name must be a member before anything is deleted.
 const listing=spawnSync('tar',['-tzf',base],{cwd:archiveDir,encoding:'utf8',windowsHide:true,maxBuffer:1<<28});
 if(listing.status!==0)throw Error('archive read-back failed: '+listing.stderr);
 const members=new Set(listing.stdout.split(/\r?\n/).map(l=>l.replace(/\/.*$/,'')));
 const missing=entries.filter(e=>!members.has(e.name));
 if(missing.length)throw Error(`archive misses ${missing.length} entries, first ${missing[0]!.name}; nothing deleted`);
 let deleted=0;
 for(const e of entries){const path=join(prac,e.name);try{if(lstatSync(path).isSymbolicLink())continue;rmSync(path,{recursive:true,force:true});deleted++;}catch{/* kept */}}
 return {archive,deleted,bytes:statSync(archive).size};
}

if(import.meta.main){
 const args=process.argv.slice(2),arg=(k:string)=>{const i=args.indexOf(k);return i>=0?args[i+1]:undefined;};
 const root=resolve(arg('--root')??join(import.meta.dir,'..')),apply=args.includes('--apply');
 const entries=scan(root);
 console.log(JSON.stringify({root,total:entries.length,byRule:counts(entries),graceMs:GRACE_MS}));
 if(!apply)console.log(`RESULT ok practice-hygiene would archive then delete ${entries.length} entries (dry run)`);
 else{
  const r=archiveThenDelete(root,entries,arg('--archive-dir')??DEFAULT_ARCHIVE_DIR);
  console.log(`RESULT ok practice-hygiene archived ${entries.length} to ${r.archive} (${r.bytes} bytes), deleted ${r.deleted}`);
 }
}
