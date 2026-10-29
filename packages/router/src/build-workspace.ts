// Isolated source workspaces for coordinator builds (research/bot-host.md "Build/live overlap remains unproved").
// A build authors and proves its capability in a copy of the source tree. Live workers keep running from the main
// checkout, so they never load half-edited code. Only publish() writes the main checkout; the caller holds the
// build lock and a drained fleet for that step alone. Heavy shared trees are junctions: node_modules, vendor and
// .practice (coordinator state, deliveries and practice bots stay shared).
import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync,copyFileSync,lstatSync} from 'node:fs';
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
 return{root,base};
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
