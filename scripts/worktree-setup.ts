// Makes a new git worktree of this repository ready for tests, the type check and the local gate, as the CI setup
// steps do (.github/workflows/ci.yml): the SDK submodule, the SDK patch and the installs.
// Usage: bun scripts/worktree-setup.ts [--bench] [--reset-vendor] [--check]
//   --bench         also install the engine packages, which a practice bench needs
//   --reset-vendor  when vendor/rs-sdk has the patch of a different commit, restore its tracked files and apply the
//                   patch of this commit. Without the flag the script reports the mismatch and changes nothing there.
//   --check         print what each step would do and change nothing
// Each step is skipped when its result is there already, so the script is safe to run again.
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export type PatchState='applied'|'clean'|'other';
// The files that a patch creates. A restore of the tracked files leaves them in place, and the next apply stops on them.
export function patchNewFiles(patch:string):string[]{
    const out:string[]=[],lines=patch.split(/\r?\n/);
    for(let i=0;i<lines.length-1;i++)if(lines[i]==='--- /dev/null'&&lines[i+1]!.startsWith('+++ b/'))out.push(lines[i+1]!.slice(6).trim());
    return out;
}
// What to do with the SDK patch. `reverseOk`: the patch comes off cleanly, so it is on. `forwardOk`: it goes on cleanly.
export function patchState(reverseOk:boolean,forwardOk:boolean):PatchState{return reverseOk?'applied':forwardOk?'clean':'other';}
// Restores, from the pinned commit, each file of the SDK that the commit holds and that differs here. It reads the
// commit, not the index: a patch that is staged there would come back from the index. A file that the commit does not
// hold is not touched, so a local file that is staged in the SDK keeps its content.
export function restorePinned(vendor:string,run:(cwd:string,cmd:string[])=>{exitCode:number|null;stdout:{toString():string}}):boolean{
    const differs=run(vendor,['git','diff','--name-only','-z','--diff-filter=MDT','HEAD']);
    if(differs.exitCode!==0)return false;
    const files=differs.stdout.toString().split('\0').filter(Boolean);
    for(let at=0;at<files.length;at+=100)if(run(vendor,['git','restore','--source=HEAD','--worktree','--',...files.slice(at,at+100)]).exitCode!==0)return false;
    return true;
}

if(import.meta.main){
    const root=join(import.meta.dir,'..'),flags=new Set(process.argv.slice(2)),dry=flags.has('--check');
    const unknown=[...flags].filter(f=>!['--bench','--reset-vendor','--check'].includes(f));
    if(unknown.length){console.error('worktree-setup: unknown option '+unknown.join(' '));process.exit(2);}
    const run=(cwd:string,cmd:string[])=>Bun.spawnSync(cmd,{cwd,stdout:'pipe',stderr:'pipe',windowsHide:true});
    const ok=(cwd:string,cmd:string[])=>run(cwd,cmd).exitCode===0;
    let failed=false;
    const step=(name:string,state:string)=>console.log(`worktree-setup: ${name}: ${state}`);
    const act=(name:string,cwd:string,cmd:string[])=>{
        if(dry){step(name,'would run '+cmd.join(' '));return true;}
        const r=run(cwd,cmd);
        if(r.exitCode===0){step(name,'done');return true;}
        step(name,'FAILED: '+cmd.join(' ')+'\n'+r.stderr.toString().trim().split('\n').slice(-6).join('\n'));failed=true;return false;
    };
    const vendor=join(root,'vendor','rs-sdk'),patch=join(root,'patches','rs-sdk-working.patch');
    const main=dirname(resolve(root,run(root,['git','rev-parse','--git-common-dir']).stdout.toString().trim()));

    // 1. The SDK submodule. The main checkout's copy is a local source of the objects, when it is a full clone.
    if(existsSync(join(vendor,'package.json')))step('submodule','present');
    else{
        const reference=join(main,'vendor','rs-sdk');
        const withReference=resolve(main)!==resolve(root)&&existsSync(join(reference,'package.json'))&&!dry&&ok(root,['git','submodule','update','--init','--reference',reference,'vendor/rs-sdk']);
        if(withReference)step('submodule','done, from the main checkout');
        else act('submodule',root,['git','submodule','update','--init','--depth','1','vendor/rs-sdk']);
    }

    // 2. The SDK patch of this commit. The gate refuses to start without it.
    if(existsSync(join(vendor,'package.json'))){
        const state=patchState(ok(vendor,['git','apply','--check','-R',patch]),ok(vendor,['git','apply','--check',patch]));
        if(state==='applied')step('SDK patch','present');
        else if(state==='clean')act('SDK patch',vendor,['git','apply',patch]);
        else if(!flags.has('--reset-vendor')){step('SDK patch','MISMATCH: vendor/rs-sdk has edits that are not the patch of this commit. Run again with --reset-vendor to restore its tracked files and apply this patch.');failed=true;}
        else if(dry)step('SDK patch','would restore the tracked files of vendor/rs-sdk and apply the patch');
        else{
            const restored=restorePinned(vendor,run);
            for(const file of patchNewFiles(readFileSync(patch,'utf8')))rmSync(join(vendor,file),{force:true});
            if(restored)act('SDK patch',vendor,['git','apply',patch]);else{step('SDK patch','FAILED: the restore of the changed files of vendor/rs-sdk from its pinned commit');failed=true;}
        }
    }else if(dry)step('SDK patch','would check after the submodule step');

    // 3. The installs. The root packages go in this worktree itself: a worktree under the main checkout can resolve the
    // packages of the main checkout, but the gate needs node_modules in the checkout that it tests (scripts/ci-gate.ts).
    if(existsSync(join(root,'node_modules','typescript')))step('root packages','present');
    else act('root packages',root,['bun','install','--no-save']);
    const installs:[string,string,string[]][]=[
        ['SDK packages',vendor,['bun','install','--frozen-lockfile','--production']],
        ['web client packages',join(vendor,'server','webclient'),['bun','install','--frozen-lockfile']],
        ...(flags.has('--bench')?[['engine packages',join(vendor,'server','engine'),['bun','install','--frozen-lockfile']] as [string,string,string[]]]:[]),
    ];
    for(const [name,cwd,cmd] of installs){
        if(existsSync(join(cwd,'node_modules')))step(name,'present');
        else if(!existsSync(cwd))step(name,dry?'would install after the submodule step':'FAILED: '+cwd+' is missing');
        else act(name,cwd,cmd);
    }
    console.log('worktree-setup: '+(failed?'NOT ready':dry?'check only, nothing changed':'ready'));
    process.exit(failed?1:0);
}
