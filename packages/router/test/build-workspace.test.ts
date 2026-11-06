import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
