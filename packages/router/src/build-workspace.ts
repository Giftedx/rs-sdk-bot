// Isolated source workspaces for coordinator builds (research/bot-host.md "Isolated build workspaces").
// A build authors and proves its capability in a copy of the source tree. Live workers keep running from the main
// checkout, so they never load half-edited code. Only publish() writes the main checkout; the caller holds the
// build lock and a drained fleet for that step alone. Heavy shared trees are junctions: node_modules, vendor and
// .practice (coordinator state, deliveries and practice bots stay shared).
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync,copyFileSync,lstatSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

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
// checkout's declared files, so publish() can refuse a main checkout that changed underneath the build.
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

// Copies the declared files into the main checkout. Refuses when the main checkout no longer matches the base the
// build started from (another capability changed a shared file), so a stale build never overwrites newer source.
export function publishWorkspace(mainRoot:string,capability:string,files:string[]):{published:string[];unchanged:string[]}{
 const root=workspaceRoot(mainRoot,capability),marker=join(root,'.workspace.json');
 if(!existsSync(marker))throw Error('publish: workspace missing');
 const meta:WorkspaceBase=JSON.parse(readFileSync(marker,'utf8'));
 const conflicts=files.filter(f=>{const now=fileHash(join(mainRoot,f));return now!==meta.base[f]&&now!==fileHash(join(root,f));});
 if(conflicts.length)throw Error('publish: main source changed since the build started: '+conflicts.join(', '));
 const published:string[]=[],unchanged:string[]=[];
 for(const f of files){
  const from=join(root,f),to=join(mainRoot,f);
  if(!existsSync(from))throw Error('publish: declared file missing in workspace: '+f);
  if(fileHash(from)===fileHash(to)){unchanged.push(f);continue;}
  mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);
  if(fileHash(to)!==fileHash(from))throw Error('publish: copy verification failed: '+f);
  published.push(f);
 }
 writeFileSync(marker,JSON.stringify({...meta,published:Date.now()},null,1));
 return{published,unchanged};
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
