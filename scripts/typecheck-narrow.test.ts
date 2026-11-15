import {expect,test} from 'bun:test';
import {compilerModules,narrowConfig,tsFiles} from './typecheck-narrow';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('explicit-file workspace uses its installed compiler without Git metadata', () => {
    const root=mkdtempSync(join(tmpdir(),'narrow-no-git-'));
    try{
        const modules=join(root,'node_modules');
        mkdirSync(join(modules,'typescript','lib'),{recursive:true});
        writeFileSync(join(modules,'typescript','lib','tsc.js'),'');
        expect(compilerModules(root,()=>{throw Error('workspace has no .git');})).toBe(modules);
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('worktree without a compiler uses the main checkout compiler', () => {
    const root=mkdtempSync(join(tmpdir(),'narrow-main-'));
    try{
        const main=join(root,'main'),modules=join(main,'node_modules');
        mkdirSync(join(modules,'typescript','lib'),{recursive:true});
        writeFileSync(join(modules,'typescript','lib','tsc.js'),'');
        expect(compilerModules(join(root,'worktree'),()=>main)).toBe(modules);
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('tsFiles keeps TypeScript paths one time each and leaves out the SDK submodule', () => {
    expect(tsFiles(['scripts/b.ts','AGENTS.md','','packages\\core\\src\\a.ts','scripts/b.ts','vendor/rs-sdk/sdk/x.ts','swarm.json']))
        .toEqual(['packages/core/src/a.ts','scripts/b.ts']);
});

test('narrowConfig checks only the named files and takes the options of the root project', () => {
    const c=narrowConfig('F:/repo',['scripts/b.ts'],'F:/main/node_modules/@types');
    expect(c.extends).toBe('F:/repo/tsconfig.json');
    expect(c.include).toEqual([]);
    expect(c.files).toHaveLength(1);
    expect(c.files[0]!.endsWith('/repo/scripts/b.ts')).toBe(true);
    expect(c.compilerOptions.typeRoots).toEqual(['F:/main/node_modules/@types']);
});
