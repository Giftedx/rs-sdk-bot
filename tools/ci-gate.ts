// Runs the CI checks of .github/workflows/ci.yml on this PC and can post the result as the `local-gate` commit
// status, so a PR can merge when hosted runners are out of minutes or slow to start.
// Usage: bun tools/ci-gate.ts [--post] [--force] [--full]   (vendor/rs-sdk must carry patches/rs-sdk-working.patch, as in CI)
//   --full   run every test file, not only the files that the change since origin/master can reach
//   --part i/n  run part i of n of each test step; part 1 also runs the other checks (CI runs the parts on n runners)
//   --post   post `local-gate` success or failure on HEAD (needs gh, and no changed or untracked files)
//   --force  run while the local swarm reports running bots (tsc and the suites slow every bot client)
// The checks are the workflow's single-line `bun run` and `bun test` steps, read from ci.yml, so the two cannot drift.
// Setup steps (checkout, submodule patch, installs) are not run: this checkout needs vendor/rs-sdk and node_modules.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isPortUnbound} from './now';

export type Step={name:string;cmd:string[];env:Record<string,string>};

// Each `- run: bun ...` or `- name:` + `run: bun ...` step with a one-line command, with its `env:` block.
export function gateSteps(yml:string):Step[]{
    const raw:{name?:string;run?:string;env:Record<string,string>}[]=[];let inEnv=false;
    for(const full of yml.split(/\r?\n/)){
        const line=full.replace(/\s+#.*$/,''),item=/^\s*-\s+(\w+):\s*(.*)$/.exec(line),key=/^\s+(\w+):\s*(.*)$/.exec(line);
        if(item){raw.push({env:{}});inEnv=false;}
        const step=raw.at(-1),[k,v]=item?[item[1],item[2]]:key?[key[1],key[2]]:[null,null];
        if(!step||k===null)continue;
        if(inEnv&&!item&&/^[A-Z_][A-Z0-9_]*$/.test(k)){step.env[k]=v!.trim();continue;}
        inEnv=k==='env';
        if(k==='name')step.name=v!.trim();
        if(k==='run')step.run=v!.trim();
    }
    return raw.filter(s=>/^bun (run|test|tools\/(?:test-shards|check-no-diary)\.ts) \S/.test(s.run??'')).map(s=>({name:s.name??s.run!,cmd:testCmd(s.run!.split(/\s+/)),env:s.env}));
}
// A CI step `bun tools/test-shards.ts [--part <i/n>] [--shards n] <folder>...` is the `bun test <folder>...` that it splits: the
// gate runs every file of it, and `--part` of the gate (partSteps) splits it again.
export function testCmd(cmd:string[]):string[]{
    if(cmd[1]!=='tools/test-shards.ts')return cmd;
    const folders:string[]=[];
    for(let i=2;i<cmd.length;i++){if(/^--(part|shards|changed)$/.test(cmd[i]!)){i++;continue;}folders.push(cmd[i]!);}
    return ['bun','test',...folders];
}
// `--part i/n` of the gate: runner i of n runs part i of every test step, and only runner 1 runs the other checks.
export function partSteps<T extends {cmd:string[]}>(steps:T[],part:string|undefined):T[]{
    if(!part)return steps;
    const index=Number(/^(\d+)\/\d+$/.exec(part)?.[1]);
    return steps.flatMap(s=>s.cmd[1]==='tools/test-shards.ts'?[{...s,cmd:[...s.cmd.slice(0,2),'--part',part,...s.cmd.slice(2)]}]:index===1?[s]:[]);
}

// The local form of the workflow's test steps. One `bun test` process for every file takes about 520 s on the PC.
// test-shards.ts runs the files in up to 12 processes within CPU and memory limits. With --changed it runs only the files that the change since
// origin/master can reach. `--full` keeps the shards and runs every file. A standalone `bun test` step on a strict
// subfolder of an earlier step (such as `./packages/dashboard` after `./packages`) stays intact on `--full` so
// isolated-process checks still run on part 1 without cross-package global pollution.
export function localSteps<T extends {cmd:string[]}>(steps:T[],full:boolean):T[]{
    const out:T[]=[],seen:string[]=[];
    for(const step of steps){
        if(step.cmd[0]!=='bun'||step.cmd[1]!=='test'){out.push(step);continue;}
        const rawFolders=step.cmd.slice(2);
        const folders=rawFolders.filter(f=>!seen.some(s=>f===s||f.startsWith(s.replace(/\/$/,'')+'/')));
        seen.push(...folders);
        if(folders.length){
            out.push({...step,cmd:['bun','tools/test-shards.ts',...(full?[]:['--changed','origin/master']),...folders]});
        }else if(full&&rawFolders.length===1&&seen.some(s=>rawFolders[0]!==s&&rawFolders[0]!.startsWith(s.replace(/\/$/,'')+'/'))){
            out.push(step);
        }
    }
    return out;
}

export function statusBody(ok:boolean,results:{name:string;ok:boolean;s:number}[]){
    const failed=results.filter(r=>!r.ok).map(r=>r.name);
    const total=results.reduce((a,r)=>a+r.s,0);
    return {state:ok?'success':'failure',context:'local-gate',description:(ok?`${results.length} checks passed in ${Math.round(total)} s`:`failed: ${failed.join(', ')}`).slice(0,140)};
}

// Why this checkout cannot stand for HEAD, or null. `porcelain` is `git status --porcelain --untracked-files=normal
// --ignore-submodules=dirty`: an untracked file could be imported by committed code, so it counts. The SDK patch edits
// files inside vendor/rs-sdk, which that flag leaves out; check-pin proves the SDK commit and `patched` the patch.
export function checkoutProblem(porcelain:string,patched:boolean,post:boolean):string|null{
    if(!patched)return 'vendor/rs-sdk lacks patches/rs-sdk-working.patch (CI applies it): git -C vendor/rs-sdk apply ../../patches/rs-sdk-working.patch';
    if(post&&porcelain.trim())return '--post needs a tree with no changed or untracked files, so the status describes HEAD:\n'+porcelain.trim();
    return null;
}

const sh=(cmd:string[],env?:Record<string,string>)=>Bun.spawnSync(cmd,{stdout:'pipe',stderr:'pipe',env:{...process.env,...env},windowsHide:true});

if(import.meta.main){
    const root=join(import.meta.dir,'..'),post=process.argv.includes('--post'),force=process.argv.includes('--force');
    for(const need of ['vendor/rs-sdk/package.json','node_modules'])if(!existsSync(join(root,need))){console.error(`gate: ${need} is missing in ${root}. Init the submodule and install, or link them from the main checkout.`);process.exit(2);}
    const porcelain=sh(['git','-C',root,'status','--porcelain','--untracked-files=normal','--ignore-submodules=dirty']).stdout.toString();
    const patched=sh(['git','-C',join(root,'vendor','rs-sdk'),'apply','--check','-R',join(root,'patches','rs-sdk-working.patch')]).exitCode===0;
    const problem=checkoutProblem(porcelain,patched,post);
    if(problem){console.error('gate: '+problem);process.exit(2);}
    if(!isPortUnbound(3100))try{const s=await (await fetch('http://127.0.0.1:3100/api/state',{signal:AbortSignal.timeout(3000)})).json() as any;const active=s?.capacity?.active;
        if(active>0&&!force){console.error(`gate: ${active} bots run now; tsc and the suites slow their clients. Rerun with --force to run anyway.`);process.exit(2);}}catch{/* no local dashboard: no swarm load to read */}
    const partAt=process.argv.indexOf('--part'),part=partAt>=0?process.argv[partAt+1]:undefined;
    if(partAt>=0&&!/^\d+\/\d+$/.test(part??'')){console.error(`gate: --part needs i/n, not ${part}`);process.exit(2);}
    const steps=partSteps(localSteps(gateSteps(readFileSync(join(root,'.github','workflows','ci.yml'),'utf8')),process.argv.includes('--full')),part),results:{name:string;ok:boolean;s:number}[]=[];
    for(const step of steps){
        const t=performance.now();console.log(`gate: ${step.name}`);
        const p=Bun.spawnSync(step.cmd,{cwd:root,stdout:'inherit',stderr:'inherit',env:{...process.env,...step.env},windowsHide:true});
        results.push({name:step.cmd.join(' '),ok:p.exitCode===0,s:(performance.now()-t)/1000});
        console.log(`gate: ${p.exitCode===0?'ok':'FAIL'} ${step.cmd.join(' ')} ${results.at(-1)!.s.toFixed(0)} s`);
        if(p.exitCode!==0)break;
    }
    const ok=results.length===steps.length&&results.every(r=>r.ok),body=statusBody(ok,results);
    console.log(`gate: ${body.state} · ${body.description}`);
    if(post){
        const sha=sh(['git','-C',root,'rev-parse','HEAD']).stdout.toString().trim(),repo=sh(['gh','repo','view','--json','nameWithOwner','-q','.nameWithOwner'],{}).stdout.toString().trim();
        const r=sh(['gh','api',`repos/${repo}/statuses/${sha}`,'-f',`state=${body.state}`,'-f',`context=${body.context}`,'-f',`description=${body.description}`]);
        console.log(r.exitCode===0?`gate: posted ${body.context}=${body.state} on ${sha.slice(0,8)}`:`gate: post failed: ${r.stderr.toString().trim()}`);
        if(r.exitCode!==0)process.exit(3);
    }
    process.exit(ok?0:1);
}
