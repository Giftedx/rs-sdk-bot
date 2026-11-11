import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {patchNewFiles,patchState} from './worktree-setup';

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
