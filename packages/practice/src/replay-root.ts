import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,symlinkSync,copyFileSync,lstatSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const SOURCE_COPY_SKIP=new Set(['node_modules','.git']);

export function copySourceTree(from:string,to:string){
 mkdirSync(to,{recursive:true});
 for(const entry of readdirSync(from,{withFileTypes:true})){
  if(SOURCE_COPY_SKIP.has(entry.name))continue;
  const a=join(from,entry.name),b=join(to,entry.name);
  if(entry.isDirectory())copySourceTree(a,b);else if(entry.isFile())copyFileSync(a,b);
 }
}
export function linkSourceDirectory(target:string,path:string){
 if(!existsSync(target))return;
 try{if(lstatSync(path))return;}catch{/* absent */}
 symlinkSync(target,path,process.platform==='win32'?'junction':'dir');
}

// A scratch copy of the worker source for replays. Workers write receipts, ledgers and status under .practice;
// a replay gets its own empty .practice with only the shared route caches linked. Source and data are copies,
// because module paths resolve through links to the original folder.
const REPLAY_COPY=['scripts','packages','knowledge','patches'],REPLAY_LINKS=['node_modules','vendor'];
export function prepareReplayRoot(source:string,parent=tmpdir()):string{
 const root=mkdtempSync(join(parent,'replay-root-'));
 for(const dir of REPLAY_COPY)if(existsSync(join(source,dir)))copySourceTree(join(source,dir),join(root,dir));
 for(const entry of readdirSync(source,{withFileTypes:true}))if(entry.isFile()&&!entry.name.startsWith('.workspace'))copyFileSync(join(source,entry.name),join(root,entry.name));
 for(const dir of REPLAY_LINKS)linkSourceDirectory(join(source,dir),join(root,dir));
 mkdirSync(join(root,'.practice'));linkSourceDirectory(join(source,'.practice','cache'),join(root,'.practice','cache'));
 return root;
}
// Removes the links first and deletes the copy only when no link is left, so a delete never reaches a link target.
export function removeReplayRoot(root:string){
 const links=[...REPLAY_LINKS.map(d=>join(root,d)),join(root,'.practice','cache')];
 for(const path of links)try{if(lstatSync(path).isSymbolicLink()||process.platform==='win32')unlinkSync(path);}catch{/* absent */}
 if(links.some(path=>{try{lstatSync(path);return true;}catch{return false;}}))return false;
 rmSync(root,{recursive:true,force:true});return true;
}
