import {expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hookSwitchText,patchNewFiles,patchState,restorePinned} from './worktree-setup';

test('hookSwitchText carries only disableAllHooks from the main checkout and keeps the keys of the worktree',()=>{
    const main=JSON.stringify({disableAllHooks:true,permissions:{allow:['Bash(bun *)']},enabledPlugins:{x:true}});
    // No local file in the worktree: a file with the switch alone, no permissions or plugins of the main checkout.
    expect(JSON.parse(hookSwitchText(main,null)!)).toEqual({disableAllHooks:true});
    // A local file with other keys: the keys stay, the switch is added.
    expect(JSON.parse(hookSwitchText(main,JSON.stringify({permissions:{allow:['Read']}}))!)).toEqual({permissions:{allow:['Read']},disableAllHooks:true});
    // Nothing to do: the switch is there, the main checkout has no switch, no file, or a file that is not JSON.
    expect(hookSwitchText(main,JSON.stringify({disableAllHooks:true}))).toBeNull();
    expect(hookSwitchText(JSON.stringify({disableAllHooks:false}),null)).toBeNull();
    expect(hookSwitchText(JSON.stringify({permissions:{}}),null)).toBeNull();
    expect(hookSwitchText(null,null)).toBeNull();
    expect(hookSwitchText('{not json',null)).toBeNull();
    // A worktree file that is not a JSON object is reported, never overwritten.
    expect(()=>hookSwitchText(main,'{not json')).toThrow('not JSON');
    expect(()=>hookSwitchText(main,'[1]')).toThrow('not a JSON object');
});

test('a restore takes the changed files from the pinned commit and touches no file that the commit does not hold',()=>{
    const dir=mkdtempSync(join(tmpdir(),'worktree-setup-'));
    try{
        const run=(cwd:string,cmd:string[])=>Bun.spawnSync(cmd,{cwd,stdout:'pipe',stderr:'pipe',windowsHide:true});
        const git=(...args:string[])=>{const r=run(dir,['git','-c','user.name=t','-c','user.email=t@t','-c','commit.gpgsign=false','-c','core.autocrlf=false',...args]);if(r.exitCode!==0)throw Error(args.join(' ')+': '+r.stderr.toString());return r.stdout.toString().trim();};
        const file=(name:string)=>readFileSync(join(dir,name),'utf8');
        git('init','--quiet','--initial-branch=master');git('config','core.autocrlf','false');
        for(const name of ['a.txt','b.txt','gone.txt','same.txt'])writeFileSync(join(dir,name),name+' pinned\n');
        git('add','.');git('commit','--quiet','-m','pinned');
        // An old patch that is staged, an edit that is not staged, and a file of the commit that is gone.
        writeFileSync(join(dir,'a.txt'),'old patch\n');git('add','--','a.txt');
        writeFileSync(join(dir,'b.txt'),'edit\n');rmSync(join(dir,'gone.txt'));
        // A local file that is staged and then edited, and a file that git does not track.
        writeFileSync(join(dir,'mine.txt'),'staged\n');git('add','--','mine.txt');writeFileSync(join(dir,'mine.txt'),'staged, then edited\n');
        writeFileSync(join(dir,'data.sqlite'),'data');
        const index=git('ls-files','--stage');
        expect(restorePinned(dir,run)).toBe(true);
        expect([file('a.txt'),file('b.txt'),file('gone.txt'),file('same.txt')]).toEqual(['a.txt pinned\n','b.txt pinned\n','gone.txt pinned\n','same.txt pinned\n']);
        expect(file('mine.txt')).toBe('staged, then edited\n');expect(file('data.sqlite')).toBe('data');
        expect(git('ls-files','--stage')).toBe(index);
        // Nothing differs from the commit: nothing to restore.
        rmSync(join(dir,'mine.txt'));git('reset','--quiet');
        expect(restorePinned(dir,run)).toBe(true);
        expect(existsSync(join(dir,'mine.txt'))).toBe(false);
        // Not a git folder: the result says that the restore did not run.
        const plain=mkdtempSync(join(tmpdir(),'worktree-setup-plain-'));
        try{expect(restorePinned(plain,(cwd,cmd)=>run(cwd,['git','-c','safe.directory=*',...cmd.slice(1)]))).toBe(false);}finally{rmSync(plain,{recursive:true,force:true});}
    }finally{rmSync(dir,{recursive:true,force:true});}
},60_000);

test('patchNewFiles lists only the files that a patch creates',()=>{
    const patch=['diff --git a/a.ts b/a.ts','--- a/a.ts','+++ b/a.ts','@@ -1 +1 @@','-x','+y',
        'diff --git a/new/b.ts b/new/b.ts','new file mode 100644','--- /dev/null','+++ b/new/b.ts','@@ -0,0 +1 @@','+z'].join('\n');
    expect(patchNewFiles(patch)).toEqual(['new/b.ts']);
    expect(patchNewFiles(patch.replace(/\n/g,'\r\n'))).toEqual(['new/b.ts']);
});

test('the checked-in SDK patch creates the files that a vendor restore must remove',()=>{
    const files=patchNewFiles(readFileSync(join(import.meta.dir,'..','patches','rs-sdk-working.patch'),'utf8'));
    expect(files).toContain('server/engine/src/simseed.ts');
    for(const f of files)expect(f.startsWith('/')||f.includes('..')).toBe(false);
});

test('patchState names the patch as applied, clean to apply, or a different edit',()=>{
    expect(patchState(true,false)).toBe('applied');
    expect(patchState(false,true)).toBe('clean');
    expect(patchState(false,false)).toBe('other');
});

import {Database} from 'bun:sqlite';
import {mkdirSync} from 'node:fs';
import {ROUTE_CACHES,seedRouteCaches} from './worktree-setup';
test('seedRouteCaches copies the caches a worktree lacks, keeps the ones it holds and takes a whole copy of the walk lengths',()=>{
    const dir=mkdtempSync(join(tmpdir(),'seed-')),from=join(dir,'main'),to=join(dir,'tree');
    try{
        mkdirSync(from);
        writeFileSync(join(from,'rsmod-pathfinding.snap'),'snapshot');
        const db=new Database(join(from,'route-legs-v2.sqlite'));
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE legs (source TEXT, key TEXT, value INTEGER, PRIMARY KEY (source, key)) WITHOUT ROWID; INSERT INTO legs VALUES ('s','a>b',12)");
        // The source stays open with a write in its WAL file: the copy must still hold the row.
        expect(seedRouteCaches(from,to,true).map(r=>r[1])).toEqual(['would copy from the main checkout','not in the main checkout','would copy from the main checkout']);
        expect(existsSync(to)).toBe(false);
        expect(seedRouteCaches(from,to)).toEqual([['rsmod-pathfinding.snap','copied from the main checkout'],['route-areas.bin','not in the main checkout'],['route-legs-v2.sqlite','copied from the main checkout']]);
        db.close();
        const copy=new Database(join(to,'route-legs-v2.sqlite'),{readonly:true});
        expect(copy.query('SELECT value FROM legs WHERE key = ?').get('a>b')).toEqual({value:12});
        copy.close();
        writeFileSync(join(to,'rsmod-pathfinding.snap'),'mine');
        expect(seedRouteCaches(from,to).map(r=>r[1])).toEqual(['present','not in the main checkout','present']);
        expect(readFileSync(join(to,'rsmod-pathfinding.snap'),'utf8')).toBe('mine');
        expect(ROUTE_CACHES).toHaveLength(3);
    }finally{rmSync(dir,{recursive:true,force:true});}
});

test('seedRouteCaches does not read the walk lengths of a main checkout whose fleet runs, and still copies the files written once',()=>{
    const dir=mkdtempSync(join(tmpdir(),'seed-live-')),from=join(dir,'main'),to=join(dir,'tree');
    try{
        mkdirSync(from);
        writeFileSync(join(from,'rsmod-pathfinding.snap'),'snapshot');
        writeFileSync(join(from,'route-legs-v2.sqlite'),'not opened');
        expect(seedRouteCaches(from,to,false,true)).toEqual([['rsmod-pathfinding.snap','copied from the main checkout'],['route-areas.bin','not in the main checkout'],
            ['route-legs-v2.sqlite','not copied: the live fleet writes it; run the setup again when no swarm runs']]);
        expect(existsSync(join(to,'route-legs-v2.sqlite'))).toBe(false);
        // A worktree that holds the file keeps it, with or without a fleet.
        writeFileSync(join(to,'route-legs-v2.sqlite'),'mine');
        expect(seedRouteCaches(from,to,false,true).map(r=>r[1])).toEqual(['present','not in the main checkout','present']);
    }finally{rmSync(dir,{recursive:true,force:true});}
});
