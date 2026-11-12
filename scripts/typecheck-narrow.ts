// Type-checks the named files and the files that they import, not the whole project.
// Usage: bun scripts/typecheck-narrow.ts [--heap MB] [file ...]
//   No file: the .ts files that differ from the merge base with origin/master, and the untracked .ts files.
//   --heap  the node heap limit in MB (default 2560). The limit is less when the memory above the floor is less
//           (scripts/heavy-admission.ts), and 768 MB at least.
// The whole-project check stays `bun run typecheck`. Run it one time before a push.
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {floorGB,freeGB,heapThatFits,sizedNote} from './heavy-admission';

const slash=(p:string)=>p.replace(/\\/g,'/');

// The TypeScript files in a list of git paths. The SDK submodule has its own project, so its files are left out.
export function tsFiles(lines:string[]):string[]{
    return [...new Set(lines.map(l=>slash(l.trim())).filter(l=>/\.tsx?$/.test(l)&&!l.startsWith('vendor/')))].sort();
}

// A project file that takes the compiler options of the root project and checks only `files`. The paths are absolute,
// because `.practice` can be a link to the folder of a different checkout.
export function narrowConfig(root:string,files:string[],typeRoot:string){
    return {extends:slash(join(root,'tsconfig.json')),compilerOptions:{typeRoots:[slash(typeRoot)]},include:[] as string[],files:files.map(f=>slash(resolve(root,f)))};
}

if(import.meta.main){
    const root=join(import.meta.dir,'..'),argv=process.argv.slice(2),h=argv.indexOf('--heap');
    const heap=h>=0?Number(argv.splice(h,2)[1]):2560;
    if(!Number.isInteger(heap)||heap<256){console.error('typecheck-narrow: --heap needs a number of MB, 256 or more');process.exit(2);}
    // A git command that fails must stop the check. An empty file list from a failed command reads as "nothing to check".
    const git=(...a:string[])=>{
        const r=Bun.spawnSync(['git','-C',root,...a],{stdout:'pipe',stderr:'pipe',windowsHide:true});
        if(r.exitCode!==0){console.error(`typecheck-narrow: git ${a.join(' ')} failed: ${r.stderr.toString().trim()}\nFetch origin/master (git fetch origin master), or name the files to check.`);process.exit(2);}
        return r.stdout.toString();
    };
    const base=argv.length?'':git('merge-base','origin/master','HEAD').trim();
    const listed=argv.length?argv:[...git('diff','--name-only','--diff-filter=d',base).split('\n'),...git('ls-files','--others','--exclude-standard').split('\n')];
    const files=tsFiles(listed).filter(f=>existsSync(resolve(root,f)));
    if(!files.length){console.log('typecheck-narrow: no changed .ts file, nothing to check');process.exit(0);}
    // A worktree with no install uses the compiler of the main checkout.
    const main=dirname(resolve(root,git('rev-parse','--git-common-dir').trim()));
    const modules=[root,main].map(r=>join(r,'node_modules')).find(m=>existsSync(join(m,'typescript','lib','tsc.js')));
    if(!modules){console.error(`typecheck-narrow: node_modules/typescript is missing in ${root} and in ${main}. Run bun install.`);process.exit(2);}
    const dir=join(root,'.practice','typecheck-narrow'),config=join(dir,'tsconfig.json');
    mkdirSync(dir,{recursive:true});
    writeFileSync(config,JSON.stringify(narrowConfig(root,files,join(modules,'@types')),null,1));
    // The heap is a limit, not a use: a small check takes far less. The limit is the memory above the floor when that
    // is less than the heap that was asked for (scripts/heavy-admission.ts). A check that needs more than the limit
    // fails with a heap error.
    const free=freeGB(),floor=floorGB(root),limit=heapThatFits(heap,free,floor);
    if(limit<heap)console.log(sizedNote('typecheck-narrow',`a ${limit} MB heap`,`${heap} MB`,free,floor));
    const start=Date.now();
    const run=Bun.spawnSync(['node',`--max-old-space-size=${limit}`,join(modules,'typescript','lib','tsc.js'),'-p',config,'--pretty','false'],{stdout:'inherit',stderr:'inherit',windowsHide:true});
    console.log(`typecheck-narrow: ${files.length} files named, exit ${run.exitCode}, ${Math.round((Date.now()-start)/1000)} s`);
    process.exit(run.exitCode??1);
}
