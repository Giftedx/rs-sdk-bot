// Isolated source workspaces for coordinator builds (research/bot-host.md "Isolated build workspaces").
// A build authors and proves its capability in a copy of the source tree. Live workers keep running from the main
// checkout, so they never load half-edited code. Only publish() writes the main checkout; the caller holds the
// build lock and a drained fleet for that step alone. Heavy shared trees are junctions: node_modules, vendor and
// .practice (coordinator state, deliveries and practice bots stay shared).
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync,copyFileSync,lstatSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const COPY_DIRS=['scripts','packages','knowledge','research','docs','patches'];
export const LINK_DIRS=['node_modules','vendor','.practice','.claude'];
const SKIP=new Set(['node_modules','.git']);

export interface WorkspaceBase{capability:string;created:number;base:Record<string,string|null>;published?:number}

export function workspaceRoot(mainRoot:string,capability:string):string{
 if(!/^[-a-z0-9]+$/.test(capability))throw Error('workspace capability id invalid');
 return join(dirname(mainRoot),basename(mainRoot)+'-build',capability);
}
export const fileHash=(file:string):string|null=>existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null;

function copyTree(from:string,to:string){
 mkdirSync(to,{recursive:true});
 for(const entry of readdirSync(from,{withFileTypes:true})){
  if(SKIP.has(entry.name))continue;
  const a=join(from,entry.name),b=join(to,entry.name);
  if(entry.isDirectory())copyTree(a,b);else if(entry.isFile())copyFileSync(a,b);
 }
}
function link(target:string,path:string){
 if(!existsSync(target))return;
 try{if(lstatSync(path))return;}catch{/* absent */}
 symlinkSync(target,path,process.platform==='win32'?'junction':'dir');
}

// Fresh copy of the main checkout's source, except the declared files of an unpublished earlier attempt: a repair
// build continues from its own last source, as it did when builds edited the main checkout. `base` records the main
// checkout's declared files, so publish() can refuse a main checkout that changed underneath the build. BASE_DIR keeps
// the bytes of that base, so publish() can merge the build onto an earlier delivery of the same file.
export const BASE_DIR='.workspace-base';
export function prepareWorkspace(mainRoot:string,capability:string,files:string[]):{root:string;base:WorkspaceBase}{
 const root=workspaceRoot(mainRoot,capability),marker=join(root,'.workspace.json');
 const previous:WorkspaceBase|null=existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):null;
 const carried=new Map<string,Buffer>();
 if(previous&&!previous.published)for(const file of files)if(existsSync(join(root,file)))carried.set(file,readFileSync(join(root,file)));
 for(const dir of COPY_DIRS)rmSync(join(root,dir),{recursive:true,force:true});
 mkdirSync(root,{recursive:true});
 for(const dir of COPY_DIRS)if(existsSync(join(mainRoot,dir)))copyTree(join(mainRoot,dir),join(root,dir));
 for(const entry of readdirSync(mainRoot,{withFileTypes:true}))if(entry.isFile())copyFileSync(join(mainRoot,entry.name),join(root,entry.name));
 for(const dir of LINK_DIRS)link(join(mainRoot,dir),join(root,dir));
 for(const [file,bytes] of carried){mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),bytes);}
 const base:WorkspaceBase={capability,created:Date.now(),base:Object.fromEntries(files.map(f=>[f,fileHash(join(mainRoot,f))]))};
 // A carried attempt keeps its original base: the main checkout must still hold what that attempt started from.
 if(previous&&!previous.published&&carried.size)for(const f of files)if(f in previous.base)base.base[f]=previous.base[f]!;
 const kept=previous&&!previous.published&&carried.size?new Set(files.filter(f=>f in previous.base)):new Set<string>();
 if(!kept.size)rmSync(join(root,BASE_DIR),{recursive:true,force:true});
 for(const f of files)if(!kept.has(f)&&existsSync(join(mainRoot,f))){const to=join(root,BASE_DIR,f);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(mainRoot,f),to);}
 writeFileSync(marker,JSON.stringify(base,null,1));
 writeFileSync(join(root,FILES_MARKER),JSON.stringify(sourceStats(root)));
 return{root,base};
}

// Size and modification time of every copied source file when the workspace was prepared. workspaceChanges compares
// against it, so the review gate knows whether a build changed any file outside its owned list.
export const FILES_MARKER='.workspace-files.json';
function sourceStats(root:string):Record<string,[number,number]>{
 const out:Record<string,[number,number]>={};
 const walk=(dir:string,rel:string)=>{
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   if(SKIP.has(entry.name))continue;
   const path=join(dir,entry.name),name=rel?rel+'/'+entry.name:entry.name;
   if(entry.isDirectory())walk(path,name);else if(entry.isFile()){const st=statSync(path);out[name]=[st.size,st.mtimeMs];}
  }
 };
 for(const dir of COPY_DIRS)if(existsSync(join(root,dir)))walk(join(root,dir),dir);
 for(const entry of readdirSync(root,{withFileTypes:true}))if(entry.isFile()&&!entry.name.startsWith('.workspace')){const st=statSync(join(root,entry.name));out[entry.name]=[st.size,st.mtimeMs];}
 return out;
}
// Source files added, removed or changed since prepareWorkspace. known:false when the workspace has no file list.
export function workspaceChanges(root:string):{known:boolean;changed:string[]}{
 const marker=join(root,FILES_MARKER);
 if(!existsSync(marker))return{known:false,changed:[]};
 const before:Record<string,[number,number]>=JSON.parse(readFileSync(marker,'utf8')),now=sourceStats(root);
 const changed=[...new Set([...Object.keys(before),...Object.keys(now)])].filter(f=>before[f]?.[0]!==now[f]?.[0]||before[f]?.[1]!==now[f]?.[1]).sort();
 return{known:true,changed};
}

// File hashes that publish() wrote into the main checkout, newest last, per file. A main file whose hash is in this
// list changed because an earlier delivery landed, not because someone edited it.
export const deliveredLedger=(mainRoot:string)=>join(mainRoot,'.practice','coordinator','delivered-files.json');
const LEDGER_KEEP=50;
function readLedger(file:string):Record<string,string[]>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return{};}}

// Three-way merge of text (git merge-file). On a conflict, `conflicts` names the line ranges in main and in the build.
export function mergeText(base:string,main:string,build:string):{ok:true;text:string}|{ok:false;conflicts:string[]}{
 const dir=mkdtempSync(join(tmpdir(),'publish-merge-'));
 try{
  const path=(name:string,text:string)=>{const f=join(dir,name);writeFileSync(f,text);return f;};
  const out=spawnSync('git',['-c','merge.conflictStyle=diff3','merge-file','-p','-L','main','-L','base','-L','build',path('main',main),path('base',base),path('build',build)],{encoding:'utf8',windowsHide:true,maxBuffer:64*2**20});
  if(out.error||out.status===null||out.status<0)throw Error('publish: git merge-file failed: '+(out.error??out.stderr));
  if(out.status===0)return{ok:true,text:out.stdout};
  // diff3 style adds a base section after main's lines; it counts on neither side.
  const conflicts:string[]=[];let mainLine=0,buildLine=0,section:'both'|'main'|'base'|'build'='both',from=[0,0];
  for(const line of out.stdout.split(/\r?\n/)){
   if(section==='both'&&line.startsWith('<<<<<<< main')){section='main';from=[mainLine+1,buildLine+1];continue;}
   if(section==='main'&&line.startsWith('||||||| base')){section='base';continue;}
   if((section==='main'||section==='base')&&line==='======='){section='build';continue;}
   if(section==='base')continue;
   if(section==='build'&&line.startsWith('>>>>>>> build')){conflicts.push(`main lines ${from[0]}-${mainLine}, build lines ${from[1]}-${buildLine}`);section='both';continue;}
   if(section!=='build')mainLine++;
   if(section!=='main')buildLine++;
  }
  return{ok:false,conflicts};
 }finally{rmSync(dir,{recursive:true,force:true});}
}

// Copies the declared files into the main checkout. A main file that differs from the build's base is a conflict,
// except when an earlier delivery wrote it (deliveredLedger): then the build's change merges onto it, and only
// overlapping edits refuse the publish. A stale build never overwrites newer source.
export function publishWorkspace(mainRoot:string,capability:string,files:string[],ledgerFile=deliveredLedger(mainRoot)):{published:string[];unchanged:string[];merged:string[]}{
 const root=workspaceRoot(mainRoot,capability),marker=join(root,'.workspace.json');
 if(!existsSync(marker))throw Error('publish: workspace missing');
 const meta:WorkspaceBase=JSON.parse(readFileSync(marker,'utf8')),ledger=readLedger(ledgerFile);
 const conflicts:string[]=[],mergedText=new Map<string,string>();
 for(const f of files){
  const mainFile=join(mainRoot,f),now=fileHash(mainFile),built=fileHash(join(root,f));
  if(built===null)throw Error('publish: declared file missing in workspace: '+f);
  if(now===built)continue;
  const snapshot=join(root,BASE_DIR,f);
  if(now===meta.base[f]){
   // A carried attempt can keep the base hash without the file. Preserve the exact bytes before replacing main.
   if(now!==null&&fileHash(snapshot)!==now){
    mkdirSync(dirname(snapshot),{recursive:true});copyFileSync(mainFile,snapshot);
    if(fileHash(snapshot)!==now)throw Error('publish: base copy verification failed: '+f);
   }
   continue;
  }
  const baseText=meta.base[f]===null?'':existsSync(snapshot)&&fileHash(snapshot)===meta.base[f]?readFileSync(snapshot,'utf8'):null;
  if(now===null||baseText===null||!ledger[f]?.includes(now)){conflicts.push(f);continue;}
  const merge=mergeText(baseText,readFileSync(mainFile,'utf8'),readFileSync(join(root,f),'utf8'));
  if(merge.ok)mergedText.set(f,merge.text);else conflicts.push(f+' ('+merge.conflicts.join('; ')+')');
 }
 if(conflicts.length)throw Error('publish: main source changed since the build started: '+conflicts.join(', '));
 const published:string[]=[],unchanged:string[]=[],merged:string[]=[];
 for(const f of files){
  const from=join(root,f),to=join(mainRoot,f),text=mergedText.get(f);
  if(text!==undefined){writeFileSync(to,text);merged.push(f);}
  else{
   if(fileHash(from)===fileHash(to)){unchanged.push(f);continue;}
   mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);
   if(fileHash(to)!==fileHash(from))throw Error('publish: copy verification failed: '+f);
  }
  published.push(f);
  const hash=fileHash(to)!;ledger[f]=[...(ledger[f]??[]).filter(h=>h!==hash),hash].slice(-LEDGER_KEEP);
 }
 mkdirSync(dirname(ledgerFile),{recursive:true});writeFileSync(ledgerFile,JSON.stringify(ledger,null,1));
 writeFileSync(marker,JSON.stringify({...meta,published:Date.now()},null,1));
 return{published,unchanged,merged};
}

export const isWorkspace=(root:string):boolean=>{try{return statSync(join(root,'.workspace.json')).isFile();}catch{return false;}};

// A scratch copy of the worker source for replays (coordinator-worker.ts replayRun). Workers write receipts, ledgers
// and status under .practice; in a build workspace .practice is the live one, so a replay gets its own empty
// .practice with only the shared route caches linked. Source and data are copies, because module paths resolve
// through links to the original folder.
const REPLAY_COPY=['scripts','packages','knowledge','patches'],REPLAY_LINKS=['node_modules','vendor'];
export function prepareReplayRoot(source:string,parent=tmpdir()):string{
 const root=mkdtempSync(join(parent,'replay-root-'));
 for(const dir of REPLAY_COPY)if(existsSync(join(source,dir)))copyTree(join(source,dir),join(root,dir));
 for(const entry of readdirSync(source,{withFileTypes:true}))if(entry.isFile()&&!entry.name.startsWith('.workspace'))copyFileSync(join(source,entry.name),join(root,entry.name));
 for(const dir of REPLAY_LINKS)link(join(source,dir),join(root,dir));
 mkdirSync(join(root,'.practice'));link(join(source,'.practice','cache'),join(root,'.practice','cache'));
 return root;
}
// Removes the links first and deletes the copy only when no link is left, so a delete never reaches a link target.
export function removeReplayRoot(root:string){
 const links=[...REPLAY_LINKS.map(d=>join(root,d)),join(root,'.practice','cache')];
 for(const path of links)try{if(lstatSync(path).isSymbolicLink()||process.platform==='win32')unlinkSync(path);}catch{/* absent */}
 if(links.some(path=>{try{lstatSync(path);return true;}catch{return false;}}))return false;
 rmSync(root,{recursive:true,force:true});return true;
}
