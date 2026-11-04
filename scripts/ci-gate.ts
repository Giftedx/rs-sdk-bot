// Runs the CI checks of .github/workflows/ci.yml on this PC and can post the result as the `local-gate` commit
// status, so a PR can merge when hosted runners are out of minutes or slow to start.
// Usage: bun scripts/ci-gate.ts [--post] [--force]
//   --post   post `local-gate` success or failure on HEAD (needs gh and a clean tree, so the status names HEAD)
//   --force  run while the local swarm reports running bots (tsc and the suites slow every bot client)
// The checks are the workflow's single-line `bun run` and `bun test` steps, read from ci.yml, so the two cannot drift.
// Setup steps (checkout, submodule patch, installs) are not run: this checkout needs vendor/rs-sdk and node_modules.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

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
    return raw.filter(s=>/^bun (run|test) \S/.test(s.run??'')).map(s=>({name:s.name??s.run!,cmd:s.run!.split(/\s+/),env:s.env}));
}

export function statusBody(ok:boolean,results:{name:string;ok:boolean;s:number}[]){
    const failed=results.filter(r=>!r.ok).map(r=>r.name);
    const total=results.reduce((a,r)=>a+r.s,0);
    return {state:ok?'success':'failure',context:'local-gate',description:(ok?`${results.length} checks passed in ${Math.round(total)} s`:`failed: ${failed.join(', ')}`).slice(0,140)};
}

const sh=(cmd:string[],env?:Record<string,string>)=>Bun.spawnSync(cmd,{stdout:'pipe',stderr:'pipe',env:{...process.env,...env},windowsHide:true});

if(import.meta.main){
    const root=join(import.meta.dir,'..'),post=process.argv.includes('--post'),force=process.argv.includes('--force');
    for(const need of ['vendor/rs-sdk/package.json','node_modules'])if(!existsSync(join(root,need))){console.error(`gate: ${need} is missing in ${root}. Init the submodule and install, or link them from the main checkout.`);process.exit(2);}
    const dirty=sh(['git','-C',root,'status','--porcelain','--untracked-files=no']).stdout.toString().trim();
    if(post&&dirty){console.error('gate: --post needs a clean tree, so the status describes HEAD:\n'+dirty);process.exit(2);}
    try{const s=await (await fetch('http://127.0.0.1:3100/api/state',{signal:AbortSignal.timeout(3000)})).json() as any;const active=s?.capacity?.active;
        if(active>0&&!force){console.error(`gate: ${active} bots run now; tsc and the suites slow their clients. Rerun with --force to run anyway.`);process.exit(2);}}catch{/* no local dashboard: no swarm load to read */}
    const steps=gateSteps(readFileSync(join(root,'.github','workflows','ci.yml'),'utf8')),results:{name:string;ok:boolean;s:number}[]=[];
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
