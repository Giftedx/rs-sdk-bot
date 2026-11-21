// Makes a new git worktree of this repository ready for tests, the type check and the local gate, as the CI setup
// steps do (.github/workflows/ci.yml): the SDK submodule, the SDK patch and the installs. It also carries the owner's
// hook switch (disableAllHooks) of the main checkout's local settings into the worktree.
import {copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {dirname,join,resolve} from 'node:path';
import {fleet} from './heavy-admission';

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

// The new text of the worktree's .claude/settings.local.json, or null when it needs no change. On Windows a worktree
// session does not read the main checkout's local settings file, so the owner's `disableAllHooks` stays behind and
// the user hooks run in the worktree. Only that one key is carried over; the main checkout's permissions are not.
export function hookSwitchText(mainLocal:string|null,worktreeLocal:string|null):string|null{
    let main:unknown;
    try{main=mainLocal===null?null:JSON.parse(mainLocal);}catch{return null;}
    if(!main||typeof main!=='object'||(main as Record<string,unknown>).disableAllHooks!==true)return null;
    if(worktreeLocal===null)return JSON.stringify({disableAllHooks:true},null,2)+'\n';
    let mine:unknown;
    try{mine=JSON.parse(worktreeLocal);}catch{throw Error('the .claude/settings.local.json of this worktree is not JSON');}
    if(!mine||typeof mine!=='object'||Array.isArray(mine))throw Error('the .claude/settings.local.json of this worktree is not a JSON object');
    if((mine as Record<string,unknown>).disableAllHooks===true)return null;
    return JSON.stringify({...mine as Record<string,unknown>,disableAllHooks:true},null,2)+'\n';
}

// Copies the route caches that `to` does not hold from `from`. The walk lengths are an SQLite file that other
// processes write: VACUUM INTO gives a whole copy of it. A failed copy leaves no file and is not a setup failure,
// because every cache is optional. Returns one line for each cache.
export const ROUTE_CACHES=['rsmod-pathfinding.snap','route-areas.bin','route-legs-v2.sqlite'] as const;
// `live`: a swarm runs from the main checkout. Its bots write the walk lengths, and a whole copy of that file reads
// every page of it, so the copy waits for a run with no fleet. The two other files are written once and are copied.
export function seedRouteCaches(from:string,to:string,dry=false,live=false):[string,string][]{
    return ROUTE_CACHES.map(name=>{
        if(live&&name.endsWith('.sqlite')&&!existsSync(join(to,name)))return [name,'not copied: the live fleet writes it; run the setup again when no swarm runs'];
        const source=join(from,name),target=join(to,name);
        if(existsSync(target))return [name,'present'];
        if(!existsSync(source))return [name,'not in the main checkout'];
        if(dry)return [name,'would copy from the main checkout'];
        const part=target+'.'+process.pid+'.part';
        try{
            mkdirSync(to,{recursive:true});rmSync(part,{force:true});
            if(name.endsWith('.sqlite')){
                const db=new Database(source,{readonly:true});
                try{db.query('VACUUM INTO ?').run(part);}finally{db.close();}
            }else copyFileSync(source,part);
            renameSync(part,target);
            return [name,'copied from the main checkout'];
        }catch(e){rmSync(part,{force:true});return [name,'not copied: '+String((e as Error).message).split('\n')[0]];}
    });
}

/** Runs the worktree setup CLI steps and returns the process exit code (0 ready, 1 failed, 2 bad options). */
export function runWorktreeSetup(argv:readonly string[]=process.argv.slice(2),root=resolve(import.meta.dir,'../../..')):number{
    const flags=new Set(argv),dry=flags.has('--check');
    const unknown=[...flags].filter(f=>!['--bench','--reset-vendor','--check'].includes(f));
    if(unknown.length){console.error('worktree-setup: unknown option '+unknown.join(' '));return 2;}
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
    else act('root packages',root,['bun','install','--frozen-lockfile']);
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

    // 4. The owner's hook switch (disableAllHooks) of the main checkout's .claude/settings.local.json.
    if(resolve(main)===resolve(root))step('hook switch','main checkout, nothing to copy');
    else{
        const local=(dir:string)=>join(dir,'.claude','settings.local.json');
        const read=(dir:string)=>existsSync(local(dir))?readFileSync(local(dir),'utf8'):null;
        try{
            const text=hookSwitchText(read(main),read(root));
            if(text===null)step('hook switch','present, or not set in the main checkout');
            else if(dry)step('hook switch','would set disableAllHooks in .claude/settings.local.json');
            else{mkdirSync(join(root,'.claude'),{recursive:true});writeFileSync(local(root),text);step('hook switch','done');}
        }catch(e){step('hook switch','FAILED: '+(e as Error).message);failed=true;}
    }
    // 5. With --bench, the route caches of the main checkout (.practice/cache): the pathfinder snapshot, the area labels
    // and the measured walk lengths. Without them the first route search of each trip in a new worktree measures every
    // leg again (minutes for one search). Each cache is bound to its source data and is checked on read, so a copy from
    // an older checkout is ignored, not trusted. A file that is here already is kept.
    if(flags.has('--bench')){
        if(resolve(main)===resolve(root))step('route caches','main checkout, nothing to copy');
        else for(const [name,result] of seedRouteCaches(join(main,'.practice','cache'),join(root,'.practice','cache'),dry,fleet(root)!==null))step('route cache '+name,result);
    }
    console.log('worktree-setup: '+(failed?'NOT ready':dry?'check only, nothing changed':'ready'));
    return failed?1:0;
}
