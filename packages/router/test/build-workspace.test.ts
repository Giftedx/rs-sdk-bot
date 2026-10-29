import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareWorkspace,publishWorkspace,workspaceRoot,isWorkspace} from '../src/build-workspace';

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
 expect(publishWorkspace(main,'cap',files)).toEqual({published:['scripts/worker.ts'],unchanged:['packages/core/src/shared.ts']});
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

test('publish refuses a main checkout that changed a declared file since the build started',()=>{
 const main=mainTree(),{root}=prepareWorkspace(main,'cap',files);
 writeFileSync(join(root,'packages/core/src/shared.ts'),'mine');
 writeFileSync(join(main,'packages/core/src/shared.ts'),'other capability');
 expect(()=>publishWorkspace(main,'cap',files)).toThrow('main source changed');
 expect(readFileSync(join(main,'packages/core/src/shared.ts'),'utf8')).toBe('other capability');
 expect(()=>workspaceRoot(main,'../escape')).toThrow('invalid');
});
