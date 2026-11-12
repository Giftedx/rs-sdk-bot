import {expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {patchNewFiles,patchState,restorePinned} from './worktree-setup';

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
