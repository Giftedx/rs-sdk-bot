import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,unlinkSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {BASE_DIR,deliveredLedger,prepareWorkspace,publishWorkspace,workspaceRoot,isWorkspace,mergeText} from '../src/build-workspace';
import {stageDeliveryPr} from '../src/delivery-pr';

const mainTree=()=>{
 const main=join(mkdtempSync(join(tmpdir(),'ws-')),'repo');
 for(const [f,t] of [['scripts/worker.ts','v1'],['packages/core/src/shared.ts','s1'],['package.json','{}'],['vendor/rs-sdk/x.ts','vendor'],['.practice/state.json','{}']] as const){mkdirSync(join(main,f,'..'),{recursive:true});writeFileSync(join(main,f),t);}
 return main;
};
const files=['scripts/worker.ts','packages/core/src/shared.ts'];

test('a build edits its own copy; the main checkout changes only on publish',()=>{
 const main=mainTree(),{root}=prepareWorkspace(main,'cap',files);
 expect(root).toBe(workspaceRoot(main,'cap'));expect(isWorkspace(root)).toBe(true);
 expect(readFileSync(join(root,'scripts/worker.ts'),'utf8')).toBe('v1');
 expect(lstatSync(join(root,'vendor')).isSymbolicLink()).toBe(true);
 expect(readFileSync(join(root,'.practice/state.json'),'utf8')).toBe('{}');
 writeFileSync(join(root,'scripts/worker.ts'),'v2');
 expect(readFileSync(join(main,'scripts/worker.ts'),'utf8')).toBe('v1');
 expect(publishWorkspace(main,'cap',files)).toEqual({published:['scripts/worker.ts'],unchanged:['packages/core/src/shared.ts'],merged:[]});
 expect(readFileSync(join(main,'scripts/worker.ts'),'utf8')).toBe('v2');
});

test('an unpublished attempt carries its declared files into the repair build; a published one restarts from main',()=>{
 const main=mainTree();let {root}=prepareWorkspace(main,'cap',files);
 writeFileSync(join(root,'scripts/worker.ts'),'attempt1');writeFileSync(join(root,'scripts/other.ts'),'scratch');
 ({root}=prepareWorkspace(main,'cap',files));
 expect(readFileSync(join(root,'scripts/worker.ts'),'utf8')).toBe('attempt1');
 expect(existsSync(join(root,'scripts/other.ts'))).toBe(false);
 publishWorkspace(main,'cap',files);
 writeFileSync(join(main,'scripts/worker.ts'),'main2');
 ({root}=prepareWorkspace(main,'cap',files));
 expect(readFileSync(join(root,'scripts/worker.ts'),'utf8')).toBe('main2');
});

const lines=(...l:string[])=>l.join('\n')+'\n';
test('a build merges onto an earlier delivery of the same file and refuses only overlapping lines',()=>{
 const main=mainTree(),file='scripts/worker.ts',base=lines('a','b','c','d','e');
 writeFileSync(join(main,file),base);
 const first=prepareWorkspace(main,'first',[file]).root,second=prepareWorkspace(main,'second',[file]).root,third=prepareWorkspace(main,'third',[file]).root;
 writeFileSync(join(first,file),lines('A','b','c','d','e'));
 writeFileSync(join(second,file),lines('a','b','c','d','E'));
 writeFileSync(join(third,file),lines('x','b','c','d','e'));
 publishWorkspace(main,'first',[file]);
 expect(publishWorkspace(main,'second',[file])).toEqual({published:[file],unchanged:[],merged:[file]});
 expect(readFileSync(join(main,file),'utf8')).toBe(lines('A','b','c','d','E'));
 expect(()=>publishWorkspace(main,'third',[file])).toThrow('main source changed since the build started: scripts/worker.ts (main lines 1-1, build lines 1-1)');
 expect(readFileSync(join(main,file),'utf8')).toBe(lines('A','b','c','d','E'));
});

test('a hand edit of the main checkout is not an earlier delivery, so publish refuses it',()=>{
 const main=mainTree(),file='scripts/worker.ts';writeFileSync(join(main,file),lines('a','b','c'));
 const {root}=prepareWorkspace(main,'cap',[file]);writeFileSync(join(root,file),lines('a','b','C'));
 writeFileSync(join(main,file),lines('A','b','c'));
 expect(()=>publishWorkspace(main,'cap',[file])).toThrow('main source changed since the build started: scripts/worker.ts');
});

test('a carried repair attempt merges against the base it started from',()=>{
 const main=mainTree(),file='scripts/worker.ts';writeFileSync(join(main,file),lines('a','b','c'));
 let {root}=prepareWorkspace(main,'cap',[file]);writeFileSync(join(root,file),lines('a','b','C'));
 const other=prepareWorkspace(main,'other',[file]).root;writeFileSync(join(other,file),lines('A','b','c'));publishWorkspace(main,'other',[file]);
 ({root}=prepareWorkspace(main,'cap',[file]));
 expect(readFileSync(join(root,file),'utf8')).toBe(lines('a','b','C'));
 publishWorkspace(main,'cap',[file]);
 expect(readFileSync(join(main,file),'utf8')).toBe(lines('A','b','C'));
});

test('publish keeps the exact base for delivery when a carried repair has lost its snapshot',()=>{
 const main=mainTree(),file='scripts/worker.ts';
 let {root}=prepareWorkspace(main,'cap',[file]);
 writeFileSync(join(root,file),'carried edit');
 unlinkSync(join(root,BASE_DIR,file));
 ({root}=prepareWorkspace(main,'cap',[file]));
 expect(existsSync(join(root,BASE_DIR,file))).toBe(false);
 const out=publishWorkspace(main,'cap',[file]);
 const coordinationDir=join(main,'.practice','coordinator');
 const pr=stageDeliveryPr({workspace:root,runDir:join(coordinationDir,'runs','repair'),coordinationDir,
  taskId:'repair',capability:'cap',files:out.published,sourceSet:[file],result:{}})!;
 expect(readFileSync(join(pr.base,file),'utf8')).toBe('v1');
 expect(readFileSync(join(pr.snapshot,file),'utf8')).toBe('carried edit');
});

test('mergeText names the conflicting lines on both sides',()=>{
 expect(mergeText(lines('a','b'),lines('a','b','m'),lines('x','a','b'))).toEqual({ok:true,text:lines('x','a','b','m')});
 expect(mergeText(lines('a','b','c'),lines('a','M1','M2','c'),lines('a','B','c'))).toEqual({ok:false,conflicts:['main lines 2-3, build lines 2-2']});
});

test('publish refuses a main checkout that changed a declared file since the build started',()=>{
 const main=mainTree(),{root}=prepareWorkspace(main,'cap',files);
 writeFileSync(join(root,'packages/core/src/shared.ts'),'mine');
 writeFileSync(join(main,'packages/core/src/shared.ts'),'other capability');
 expect(()=>publishWorkspace(main,'cap',files)).toThrow('main source changed');
 expect(readFileSync(join(main,'packages/core/src/shared.ts'),'utf8')).toBe('other capability');
 expect(()=>workspaceRoot(main,'../escape')).toThrow('invalid');
});

test('a missing later build output leaves all live source and publish metadata intact',()=>{
 const main=mainTree(),{root}=prepareWorkspace(main,'cap',files);
 const worker=files[0]!,shared=files[1]!,marker=join(root,'.workspace.json');
 const originalMarker=readFileSync(marker,'utf8');
 writeFileSync(join(root,worker),'v2');
 unlinkSync(join(root,shared));

 expect(()=>publishWorkspace(main,'cap',files)).toThrow('publish: declared file missing in workspace: '+shared);
 expect(readFileSync(join(main,worker),'utf8')).toBe('v1');
 expect(readFileSync(join(main,shared),'utf8')).toBe('s1');
 expect(readFileSync(marker,'utf8')).toBe(originalMarker);
 expect(existsSync(deliveredLedger(main))).toBe(false);

 writeFileSync(join(root,shared),'s2');
 expect(publishWorkspace(main,'cap',files).published).toEqual(files);
 expect(readFileSync(join(main,worker),'utf8')).toBe('v2');
 expect(readFileSync(join(main,shared),'utf8')).toBe('s2');
});

const install=(path:string,state:{bytes:string;mode:number})=>{
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path,Buffer.from(state.bytes,'base64'));chmodSync(path,state.mode);
};
const editBuild=(main:string,owned=files)=>{
 const {root}=prepareWorkspace(main,'cap',owned);
 writeFileSync(join(root,files[0]!),'v2');writeFileSync(join(root,files[1]!),'s2');return root;
};

test('a refused ledger write restores exact originals and absence; retry delivers every changed file',()=>{
 const main=mainTree(),added='scripts/new.ts',owned=[...files,added];
 chmodSync(join(main,files[0]!),0o755);
 const root=editBuild(main,owned),marker=readFileSync(join(root,'.workspace.json'),'utf8');
 chmodSync(join(root,files[0]!),0o644);
 writeFileSync(join(root,added),'new');
 const ledger=deliveredLedger(main);let sourceWrites=0;
 expect(()=>publishWorkspace(main,'cap',owned,ledger,(path,state)=>{
  if(path===ledger){expect(sourceWrites).toBe(3);expect(readFileSync(join(main,added),'utf8')).toBe('new');throw Error('ledger refused');}
  install(path,state);sourceWrites++;
 })).toThrow('ledger refused');
 expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v1');
 expect(readFileSync(join(main,files[1]!),'utf8')).toBe('s1');
 if(process.platform!=='win32')expect(statSync(join(main,files[0]!)).mode&0o777).toBe(0o755);
 expect(existsSync(join(main,added))).toBe(false);
 expect(readFileSync(join(root,'.workspace.json'),'utf8')).toBe(marker);
 expect(existsSync(join(root,'.workspace-publish.json'))).toBe(false);
 const out=publishWorkspace(main,'cap',owned,ledger);
 expect(out.published).toEqual(owned);
 const coordinationDir=join(main,'.practice/coordinator');
 const pr=stageDeliveryPr({workspace:root,runDir:join(coordinationDir,'runs/retry'),coordinationDir,
  taskId:'retry',capability:'cap',files:out.published,sourceSet:owned,result:{}})!;
 expect(pr.files).toEqual(owned);
 expect(readFileSync(join(pr.base,files[0]!),'utf8')).toBe('v1');
 expect(readFileSync(join(pr.snapshot,files[0]!),'utf8')).toBe('v2');
});

test('a refused marker write restores the previous ledger bytes and mode',()=>{
 const main=mainTree(),root=editBuild(main),ledger=deliveredLedger(main);
 mkdirSync(dirname(ledger),{recursive:true});writeFileSync(ledger,'{"prior":["old"]}\n');chmodSync(ledger,0o600);
 const original=readFileSync(ledger),mode=statSync(ledger).mode&0o777;
 expect(()=>publishWorkspace(main,'cap',files,ledger,(path,state)=>{
  if(path===join(root,'.workspace.json'))throw Error('marker refused');install(path,state);
 })).toThrow('marker refused');
 expect(readFileSync(ledger)).toEqual(original);expect(statSync(ledger).mode&0o777).toBe(mode);
 expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v1');
 expect(publishWorkspace(main,'cap',files).published).toEqual(files);
});

test('an interrupted process leaves durable originals and publishing recovers them before retry',()=>{
 const main=mainTree(),root=editBuild(main),runner=join(dirname(main),'interrupt.ts');
 writeFileSync(runner,`import {publishWorkspace} from ${JSON.stringify(resolve(import.meta.dir,'../src/build-workspace.ts'))};
import {writeFileSync,chmodSync} from 'node:fs';
let writes=0;
publishWorkspace(${JSON.stringify(main)},'cap',${JSON.stringify(files)},undefined,(path,state)=>{
 writeFileSync(path,Buffer.from(state.bytes,'base64'));chmodSync(path,state.mode);
 if(++writes===1)process.exit(73);
});\n`);
 const child=spawnSync(process.execPath,[runner],{encoding:'utf8',windowsHide:true,timeout:15000});
 expect(child.status).toBe(73);
 expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v2');
 expect(existsSync(join(root,'.workspace-publish.json'))).toBe(true);
 expect(()=>prepareWorkspace(main,'cap',files)).toThrow('pending recovery requires the publish source lock');
 expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v2');
 let first=true;
 const out=publishWorkspace(main,'cap',files,undefined,(path,state)=>{
  if(first){expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v1');expect(readFileSync(join(main,files[1]!),'utf8')).toBe('s1');first=false;}
  install(path,state);
 });
 expect(out.published).toEqual(files);
 expect(existsSync(join(root,'.workspace-publish.json'))).toBe(false);
});

test('rollback preserves a concurrent source edit and keeps its original bytes for recovery',()=>{
 const main=mainTree(),root=editBuild(main),journal=join(root,'.workspace-publish.json'),worker=join(main,files[0]!);
 expect(()=>publishWorkspace(main,'cap',files,undefined,(path,state)=>{
  install(path,state);writeFileSync(path,'concurrent edit');throw Error('refused');
 })).toThrow('recovery originals: '+journal);
 expect(readFileSync(worker,'utf8')).toBe('concurrent edit');
 expect(Buffer.from(JSON.parse(readFileSync(journal,'utf8')).changes[0].before.bytes,'base64').toString()).toBe('v1');
 expect(()=>publishWorkspace(main,'cap',files)).toThrow('concurrent change preserved');
 expect(readFileSync(worker,'utf8')).toBe('concurrent edit');
});

test('a concurrent edit to a future path is preserved even when it matches the staged output',()=>{
 const main=mainTree(),root=editBuild(main),second=join(main,files[1]!);
 expect(()=>publishWorkspace(main,'cap',files,undefined,(path,state)=>{
  install(path,state);writeFileSync(second,'s2');
 })).toThrow('recovery originals: '+join(root,'.workspace-publish.json'));
 expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v1');
 expect(readFileSync(second,'utf8')).toBe('s2');
 expect(JSON.parse(readFileSync(join(root,'.workspace-publish.json'),'utf8')).started).toBe(1);
});

test('a changed ledger is preserved while owned live writes roll back',()=>{
 const main=mainTree(),root=editBuild(main),ledger=deliveredLedger(main);
 mkdirSync(dirname(ledger),{recursive:true});writeFileSync(ledger,'{}');
 expect(()=>publishWorkspace(main,'cap',files,ledger,(path,state)=>{
  install(path,state);if(path===join(main,files[0]!))writeFileSync(ledger,'external metadata');
 })).toThrow('recovery originals: '+join(root,'.workspace-publish.json'));
 expect(readFileSync(ledger,'utf8')).toBe('external metadata');
 expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v1');
 expect(readFileSync(join(main,files[1]!),'utf8')).toBe('s1');
});

test('a changed or missing staged build source is refused before replacing its live original',()=>{
 for(const remove of [false,true]){
  const main=mainTree(),root=editBuild(main),second=join(root,files[1]!);
  expect(()=>publishWorkspace(main,'cap',files,undefined,(path,state)=>{
   install(path,state);if(path===join(main,files[0]!)){if(remove)unlinkSync(second);else writeFileSync(second,'different build');}
  })).toThrow('staged build source changed');
  expect(readFileSync(join(main,files[0]!),'utf8')).toBe('v1');
  expect(readFileSync(join(main,files[1]!),'utf8')).toBe('s1');
 }
});

test('recovery refuses missing originals, invalid encodings, modes or foreign paths before any writes',()=>{
 for(const corrupt of [
  (journal:any)=>{delete journal.changes[0].before.bytes;},
  (journal:any)=>{journal.changes[0].before.bytes='not base64';},
  (journal:any)=>{journal.changes[0].before.mode=0o1000;},
  (journal:any)=>{journal.changes[0].path='/outside-owned-source';},
 ]){
  const main=mainTree(),root=editBuild(main),journal=join(root,'.workspace-publish.json'),worker=join(main,files[0]!);
  expect(()=>publishWorkspace(main,'cap',files,undefined,(path,state)=>{
   install(path,state);writeFileSync(path,'concurrent edit');throw Error('refused');
  })).toThrow('recovery originals');
  const data=JSON.parse(readFileSync(journal,'utf8'));corrupt(data);const raw=JSON.stringify(data);writeFileSync(journal,raw);
  expect(()=>publishWorkspace(main,'cap',files)).toThrow('cannot recover originals at '+journal);
  expect(readFileSync(worker,'utf8')).toBe('concurrent edit');
  expect(readFileSync(journal,'utf8')).toBe(raw);
 }
});
