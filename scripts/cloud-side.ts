// One command runs a cloud fleet side: the setup a fresh container needs, the side's credentials, its plan, and its
// coordinator-owned swarm, fleet agent and autopilot, then a watch of their exact owners and children.
// It is the entry of a cloud session the PC starts (scripts/cloud-launch.ts), including planning and checked bootstrap repair.
// Everything goes to .practice/cloud-side/<side>/run.log; stdout gets one RESULT line when the watch ends.
// Usage: bun scripts/cloud-side.ts [--side <side>] [--watch-minutes <n>] [--capacity <n>] [--stop-at-end] [--setup-only]
//   --side          the fleet side (default FLEET_SIDE); never `local`
//   --watch-minutes how long to watch before printing the RESULT line and exiting (default 110); the daemons keep
//                   running after it unless --stop-at-end
//   --capacity      fleetCapacity of a new side plan: the accounts the side holds work for (default 4)
//   --stop-at-end   at the end, stop the swarm so each worker logs out cleanly, then stop the daemons (a container
//                   that ends with its task, as a Codex cloud task does)
//   --setup-only    the setup and credentials only (an environment's setup script)
//   --recover <file> exact {targets:[{account,attemptId,endedAt}]} scope; coordinator only, no planning or trades
//   --inspect <file> same selected accounts, confirmed/released only; finite bank inspectors, no planner or trades
//                   Both bounded modes require explicit --watch-minutes and --stop-at-end; FLEET_ADOPT is forced 0.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, appendFileSync, writeFileSync, renameSync,readdirSync,readlinkSync,realpathSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { FLEET_WORKTREE, SIDE_NAME } from '../packages/core/src/fleet';
import { restoreCredential, vaultKey, putCredential } from '../packages/core/src/fleet-vault';
import { MAIN_ACCOUNT } from '../packages/core/src/haggisgate';
import { SWARM_STOP, swarmWroteStop } from './swarm';
import { FETCH_FLEET_DATA, worktreeProblem } from './fleet-sync';
import { withFleetDataWrite } from './fleet-owner-claim';
import {prepareBoundedRecovery,releaseForBoundedInspection,clearSwarmStops} from './cloud-recovery';
import type {RecoveryTarget} from '../packages/core/src/bounded-recovery';
import {withPlanWrite} from '../packages/core/src/plan-lock';
import {randomUUID} from 'node:crypto';
import {observeBoundedOwners,boundedProcessAlive,boundedGroupMembers,type BoundedOwnerBinding} from '../packages/core/src/bounded-owners';
import {commandLine} from '../packages/core/src/proc';
import {workspaceRoot} from '../packages/core/src/build-workspace-root';
import {isDeepStrictEqual} from 'node:util';

const root = resolve(import.meta.dir, '..');
export const DEFAULT_WATCH_MINUTES = 110;
export const DAEMONS = ['coordinator', 'fleet-agent', 'autopilot'] as const;
export type Daemon = typeof DAEMONS[number] | 'swarm';
// A daemon that dies more often than this in an hour is left down: something needs a person, not a loop.
export const MAX_RESTARTS_PER_HOUR = 6;

export type Options = { side: string; watchMinutes: number; capacity: number; stopAtEnd: boolean; setupOnly: boolean; recover?: string; inspect?: string };
export function parseOptions(argv: string[], env: Record<string, string | undefined> = process.env): Options {
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
    const side = value('--side') ?? env.FLEET_SIDE ?? '';
    if (!SIDE_NAME.test(side) || side === 'local') throw Error(`cloud-side: --side must name a cloud fleet side, not "${side}"`);
    const watchMinutes = Number(value('--watch-minutes') ?? DEFAULT_WATCH_MINUTES), capacity = Number(value('--capacity') ?? 4);
    if (!(watchMinutes > 0 && watchMinutes <= 24 * 60)) throw Error('cloud-side: --watch-minutes must be 1..1440');
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw Error('cloud-side: --capacity must be a whole number');
    const recover=value('--recover'),inspect=value('--inspect'),bounded=recover??inspect;
    if((argv.includes('--recover')||argv.includes('--inspect'))&&(!bounded||bounded.startsWith('--')||recover&&inspect||!argv.includes('--watch-minutes')||!argv.includes('--stop-at-end')||argv.includes('--setup-only')))throw Error('cloud-side: recovery/inspection requires one manifest, explicit watch and --stop-at-end');
    return { side, watchMinutes, capacity, stopAtEnd: argv.includes('--stop-at-end'), setupOnly: argv.includes('--setup-only'),...(recover?{recover}:{}),...(inspect?{inspect}:{}) };
}

// The first message of a launched session. It keeps the model's part to starting one command, so the session's token
// use is a few small turns a day. `kind` claude: the session has background commands and wakes when one ends.
// codex: a task runs its commands in the foreground and ends with them.
export function sessionPrompt(kind: 'claude' | 'codex', side: string, watchMinutes = kind === 'codex' ? 50 : DEFAULT_WATCH_MINUTES): string {
    if (!SIDE_NAME.test(side) || side === 'local') throw Error('cloud-side: invalid side');
    const failure = [
        `On RESULT fail or a nonzero exit, diagnose the failing command from its captured output. Read the exact .practice/cloud-side/${side}/run.log and the failed setup step only when they belong to this attempt; inspect only the source and state needed to explain it.`,
        'Do not repeat a failed command unchanged. Reuse the existing setup repair and its focused check, then resume only the same cloud-side command once after that check passes.',
        'Preserve source/vendor changes and credentials. Before any SDK reset, obtain fresh evidence, classify the SDK changes and verify a recovery copy; never reset blindly or use --force.',
        'Honor owner pauses, account leases, protected clocks and host limits; no alternate bots or controllers, new accounts, protected logins, paid APIs or quota resets. Never print secrets.',
        'If unresolved, report the cause, evidence path and retained diagnostic, or state which observation is missing. Do not turn the failure into an unchanged restart loop.',
    ];
    // A Codex container can be a cached image of an older commit, and its setup script's PATH does not reach the agent:
    // the command checks out current master and puts the setup's bun (or ~/.bun) on PATH itself.
    if (kind === 'codex') return [
        `Run exactly this one command from the repository root and wait for it: git fetch -q origin master && git checkout -q --detach origin/master && export PATH="/workspace/.tools/bun/node_modules/.bin:$HOME/.bun/bin:$PATH" && bun scripts/cloud-side.ts --side ${side} --watch-minutes ${watchMinutes} --stop-at-end`,
        'On RESULT ok, reply with its last output line only. On RESULT stop, honor the stop and end the session.',
        ...failure,
    ].join('\n');
    return [
        `Fleet side ${side}: you only keep one command running. Start it now with run_in_background and a 7200000 ms timeout:`,
        `bun scripts/cloud-side.ts --side ${side} --watch-minutes ${watchMinutes}`,
        'On RESULT ok, start the same command again. On RESULT stop, honor the stop and end the session. Apply these outcome rules to reminders and stop hooks too.',
        ...failure,
    ].join('\n');
}

export function worktreeSetupResult(result: { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error },
    retain: (output: string) => void, env: Readonly<Record<string, string | undefined>> = process.env): { ok: boolean; detail: string } {
    const command = `$ bun scripts/worktree-setup.ts -> ${result.status}`;
    if (result.status === 0) { retain(command); return { ok: true, detail: '' }; }
    let output = [result.stdout ?? '', result.stderr ?? '', result.error?.message ?? ''].join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const secrets = Object.entries(env).filter(([name, value]) => /TOKEN|PASSWORD|PASSWD|SECRET|SEED|KEY|COOKIE|AUTH/i.test(name) && value)
        .map(([, value]) => value!).sort((a, b) => b.length - a.length);
    for (const secret of secrets) output = output.split(secret).join('[redacted]');
    output = output.replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/\b([A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|SEED|KEY|COOKIE|AUTHORIZATION)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]');
    const steps = [...output.matchAll(/^worktree-setup:\s*(submodule|SDK patch|root packages|SDK packages|web client packages|engine packages|hook switch):\s*(MISMATCH|FAILED)\b/gm)]
        .slice(0, 3).map(([, step, state]) => `${step}: ${state}`);
    const detail = `exit=${result.status ?? 'spawn-failed'}; ${steps.join('; ') || 'failed step unknown; inspect retained setup output'}`;
    const bounded = output.length > 8000 ? output.slice(0, 4000) + '\n[truncated]\n' + output.slice(-4000) : output;
    retain(command + '\nSETUP_FAILURE ' + detail + '\n' + bounded);
    return { ok: false, detail };
}

export type DaemonRecord = { pid: number; started: number; restarts: number[]; nonce?: string };
export function daemonCommand(name: Daemon, plan: string): string[] {
    if(name==='coordinator')return ['packages/router/src/coordinator-cli.ts','--run'];
    if (name === 'swarm') return ['scripts/swarm.ts', plan];
    if (name === 'fleet-agent') return ['scripts/fleet-agent.ts'];
    return ['scripts/autopilot.ts', plan, '--daemon'];
}
export function managedCommands(recover: boolean, plan: string, inspect=false): Record<string,string[]> {
    return recover ? {coordinator:['packages/router/src/coordinator-cli.ts','--run']} : inspect ? {swarm:daemonCommand('swarm',plan)} : Object.fromEntries(DAEMONS.map(n=>[n,daemonCommand(n,plan)]));
}
export const boundedStopSettled=(swarmAlive:boolean,coordinatorAlive:boolean)=>!swarmAlive&&!coordinatorAlive;
// Whether a dead daemon may start again now: fewer than MAX_RESTARTS_PER_HOUR starts in the last hour.
export function mayRestart(restarts: readonly number[], now: number): boolean {
    return restarts.filter(t => now - t < 60 * 60_000).length < MAX_RESTARTS_PER_HOUR;
}
// .practice/stop-swarm text an owner wrote (any text the swarm does not write itself) holds the side.
export const ownerStop = (text: string | undefined) => text !== undefined && !swarmWroteStop(text);
// Whether the end of a --stop-at-end watch writes the swarm's stop text: never over an owner's file.
export const endStopWrites = (existing: string | undefined) => !ownerStop(existing);
export function watchResult(v:{inspectionStartupError?:boolean;boundedOwnershipError?:boolean;normalOwnershipError?:string|null;ownerStopped?:boolean}){
    return v.inspectionStartupError||v.boundedOwnershipError||v.normalOwnershipError?'fail':v.ownerStopped?'stop':'ok';
}
// A new side plan: the repository's admission limits, no jobs (the planner writes one per account).
export function newPlan(capacity: number) {
    return { maxBots: 4, minFreeGB: 4, fleetCapacity: capacity, jobs: [] as unknown[] };
}

export async function prepareNormalPlan(base:string,plan:string,capacity:number,side='cloud'){
    await withPlanWrite(()=>{
        const stop=join(base,'.practice/stop-swarm');
        if(existsSync(join(base,'.practice/stop-coordinator'))||existsSync(stop)&&ownerStop(readFileSync(stop,'utf8')))throw Error('normal coordinator is owner-paused');
        const next=existsSync(plan)?JSON.parse(readFileSync(plan,'utf8')):newPlan(capacity),coordination=next.coordination??{};
        if(coordination.enabled===false)throw Error('normal coordinator is owner-paused in the selected plan');
        if(coordination.boundedRecovery||coordination.boundedInspection)throw Error('normal coordinator refuses a bounded plan');
        next.coordination={maxActive:1,maxLive:next.maxBots,plannerIntervalMs:30000,agents:[side.startsWith('claude')?'claude':'codex'],bootstrap:[],...coordination,enabled:true};
        mkdirSync(resolve(plan,'..'),{recursive:true});const temporary=plan+'.'+process.pid+'.tmp';
        writeFileSync(temporary,JSON.stringify(next,null,2)+'\n');renameSync(temporary,plan);
    },join(base,'.practice/coordinator'));
}

export async function prepareNormalStop(base:string){
    return withPlanWrite(()=>{
        const file=join(base,'.practice/stop-swarm');
        if(existsSync(file)&&ownerStop(readFileSync(file,'utf8')))return false;
        writeFileSync(file,SWARM_STOP.all);return true;
    },join(base,'.practice/coordinator'));
}

function normalSwarmProcesses(base:string){
    if(process.platform!=='linux')return [];
    const directory=realpathSync(base),found:number[]=[];
    for(const row of readdirSync('/proc').filter(n=>/^\d+$/.test(n))){
        try{const pid=Number(row),line=commandLine(pid);if(!line?.includes('scripts/swarm.ts'))continue;
            if(line.includes(join(base,'scripts/swarm.ts'))||readlinkSync('/proc/'+row+'/cwd')===directory)found.push(pid);
        }catch{/* The process may exit during the read. */}
    }return found;
}

// Normal ownership includes planner work; bounded recovery's observer deliberately refuses it.
export function observeNormalOwners(base:string,plan:string,side:string,records:Record<string,DaemonRecord>,deps:{alive?:(pid:number)=>boolean;command?:(pid:number)=>string|null;groups?:(roots:readonly number[])=>number[]|null;processes?:()=>number[]}={},priorRoots:readonly number[]=[]){
    const alive=deps.alive??boundedProcessAlive,command=deps.command??commandLine,roots=new Set(priorRoots),active=new Set<number>(),observed=new Map<string,string>();
    let coordinator:{pid:number;nonce:string}|null=null,swarm:number|null=null;
    const read=(file:string)=>{if(!existsSync(file))return;const raw=readFileSync(file,'utf8');observed.set(file,raw);return JSON.parse(raw);};
    const match=(owner:any,role:'coordinator'|'swarm'|'worker'|'planner',sourceRoot=base)=>{
        if(!Number.isSafeInteger(owner?.pid)||owner.pid<1||typeof owner.nonce!=='string'||!owner.nonce)throw Error('normal owner identity unreadable');
        roots.add(owner.pid);if(!alive(owner.pid))return false;
        const line=command(owner.pid),script=join(sourceRoot,role==='swarm'?'scripts/swarm.ts':'packages/router/src/coordinator-cli.ts'),flag=role==='swarm'?'--coordinator=':role==='coordinator'?'--run':'--'+role;
        if(!line?.includes(script)||!line.includes(owner.nonce)||!line.includes(flag))throw Error('normal live owner command unknown');
        if(sourceRoot!==base&&!line.split(/[\s"']+/).includes(owner.nonce))throw Error('normal build run command changed');
        active.add(owner.pid);return true;
    };
    try{
        const directory=join(base,'.practice/coordinator'),owner=read(join(directory,'owner.json'));
        if(owner){
            if(alive(owner.pid)||owner.successor&&alive(owner.successor.pid))if(owner.plan!==resolve(plan)||owner.side!==side)throw Error('normal coordinator plan or side changed');
            if(match(owner,'coordinator'))coordinator={pid:owner.pid,nonce:owner.nonce};
            if(owner.successor&&match(owner.successor,'coordinator'))coordinator={pid:owner.successor.pid,nonce:owner.successor.nonce};
        }
        const launched=records.coordinator;
        if(launched&&alive(launched.pid)&&!active.has(launched.pid)){if(match(launched,'coordinator')&&!coordinator)coordinator={pid:launched.pid,nonce:launched.nonce!};}
        const controller=read(join(directory,'swarm-owner.json'));
        if(controller){
            if(alive(controller.pid)&&(controller.plan!==resolve(plan)||controller.side!==side))throw Error('normal swarm plan or side changed');
            if(match(controller,'swarm'))swarm=controller.pid;
        }
        const state=read(join(base,'.practice/swarm-state.json'));
        const candidates=new Set([...(deps.processes??(()=>normalSwarmProcesses(base)))(),records.swarm?.pid,state?.controllerPid].filter((p):p is number=>Number.isSafeInteger(p)));
        for(const pid of candidates)if(alive(pid)&&pid!==swarm)throw Error('normal migration waits for unowned swarm to settle');
        const queue=read(join(directory,'state.json'));
        for(const task of [...(queue?.tasks??[]).filter((r:any)=>r.status==='running'),...(queue?.planner?[queue.planner]:[])]){
            const child=read(join(directory,'runs',task.runId,'owner.json'))??{pid:task.pid,runId:task.runId};
            if(task.pid&&child.pid!==task.pid||child.runId!==task.runId)throw Error('normal child owner changed');
            let sourceRoot=base;
            if(task.spec?.kind==='build'&&alive(child.pid)){
                if(owner?.plan!==resolve(plan)||owner.side!==side)throw Error('normal build authority changed');
                const input=read(join(directory,'runs',task.runId,'input.json'));
                if(input?.runId!==task.runId||input.startedAt!==task.startedAt||!isDeepStrictEqual(input.task,task.spec))throw Error('normal build input changed');
                sourceRoot=workspaceRoot(base,task.spec.capability);
                const marker=read(join(sourceRoot,'.workspace.json'));
                if(marker?.capability!==task.spec.capability||!Number.isFinite(task.startedAt)||!Number.isFinite(marker.created)||marker.created<task.startedAt||!marker.base||Array.isArray(marker.base)||typeof marker.base!=='object')throw Error('normal build workspace identity changed');
                if(realpathSync(join(sourceRoot,'.practice'))!==realpathSync(join(base,'.practice')))throw Error('normal build state is not shared');
            }
            match({pid:child.pid,nonce:task.runId},task===queue.planner?'planner':'worker',sourceRoot);
        }
        for(const row of read(join(base,'.practice/swarm-runs.json'))??[]){if(!Number.isSafeInteger(row.pid)||row.pid<1)throw Error('normal supervisor identity unreadable');roots.add(row.pid);if(alive(row.pid))active.add(row.pid);}
        for(const name of ['fleet-agent','autopilot'])if(records[name]){const pid=records[name]!.pid;roots.add(pid);
            if(alive(pid)){if(!command(pid)?.replaceAll('\\','/').includes('scripts/'+name+'.ts'))throw Error('normal daemon command unknown');active.add(pid);}}
        const members=(deps.groups??boundedGroupMembers)([...roots]);if(members===null)throw Error('normal child groups unavailable');for(const pid of members)active.add(pid);
        if(!active.size&&['build-lock.json','../swarm-repair.json.lease'].some(file=>existsSync(join(directory,file))))throw Error('normal authority fence remains unresolved');
        for(const [file,raw]of observed)if(readFileSync(file,'utf8')!==raw)throw Error('normal owners changed during observation');
        return {known:true,settled:active.size===0,active:[...active],coordinator,swarm,roots:[...roots],reason:null};
    }catch(error){return {known:false,settled:false,active:[...active],coordinator:null,swarm:null,roots:[...roots],reason:String(error)};}
}

function alive(pid: number, script: string): boolean {
    if(!boundedProcessAlive(pid))return false;
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(script); } catch { return true; }
}

if (import.meta.main) {
    let o: Options;
    try { o = parseOptions(process.argv.slice(2)); } catch (e) { console.log(`RESULT fail ${String(e)}`); process.exit(2); }
    const dir = join(root, '.practice', 'cloud-side', o.side), logFile = join(dir, 'run.log');
    mkdirSync(dir, { recursive: true });
    const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    const bounded=!!(o.recover||o.inspect);
    const env = { ...process.env, FLEET_SIDE: o.side, DEMO_OK: '1',...(bounded?{FLEET_ADOPT:'0'}:{}) } as Record<string, string>;
    const run = (cmd: string[], cwd = root, timeoutMs = 900_000) => {
        const p = spawnSync(cmd[0]!, cmd.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
        log(`$ ${cmd.join(' ')} -> ${p.status}${p.status === 0 ? '' : ` ${(p.stdout + p.stderr).replace(/\s+/g, ' ').slice(-300)}`}`);
        return p.status === 0;
    };
    const lock = join(dir, 'lock.json');
    try {
        const held = existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')) : null;
        if (held && alive(held.pid, 'cloud-side')) { console.log(`RESULT ok cloud-side already watching side=${o.side} pid=${held.pid}`); process.exit(0); }
    } catch { /* an unreadable lock is a dead one */ }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const unlock = () => { try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock); } catch { /* gone */ } };
    process.on('exit', unlock);
    const fail = (why: string) => { log(`FAIL ${why}`); console.log(`RESULT fail cloud-side side=${o.side} ${why} (log ${logFile})`); process.exit(1); };

    // Setup: each step skips itself when done. The patched SDK submodule reads as clean to git status, so a stop hook
    // that checks for uncommitted work does not wake the session at every turn end.
    const setup = worktreeSetupResult(spawnSync('bun', ['scripts/worktree-setup.ts'], { cwd: root, env, encoding: 'utf8', timeout: 1_200_000, windowsHide: true }), log, env);
    if (!setup.ok) fail('worktree setup failed: ' + setup.detail);
    run(['git', 'config', 'submodule.vendor/rs-sdk.ignore', 'dirty']);
    for (const d of ['cloud-handoff', 'status', 'swarm-logs']) mkdirSync(join(root, '.practice', d), { recursive: true });
    // A cached container can hold a fleet-data worktree that cannot sync. Under the fleet-data write lock, so a sync
    // the fleet agent is running finishes first and any marker left is an abandoned one: a stopped rebase or merge is
    // aborted, which keeps the worktree's unpublished commits (a trade receipt among them must survive), and one that
    // is not the fleet-data branch at all (worktreeProblem: a branch made from the code) is replaced; it holds no
    // fleet data.
    run(['git', ...FETCH_FLEET_DATA]);
    const unrepaired = await withFleetDataWrite(root, () => {
        if (!existsSync(join(FLEET_WORKTREE, '.git')) || !worktreeProblem(FLEET_WORKTREE)) return null;
        run(['git', '-C', FLEET_WORKTREE, 'rebase', '--abort']);
        run(['git', '-C', FLEET_WORKTREE, 'merge', '--abort']);
        const problem = worktreeProblem(FLEET_WORKTREE);
        if (!problem?.includes('not the fleet-data branch')) return problem;
        log(`fleet worktree replaced: ${problem}`);
        run(['git', 'worktree', 'remove', '--force', FLEET_WORKTREE]);
        rmSync(FLEET_WORKTREE, { recursive: true, force: true });
        run(['git', 'worktree', 'prune']);
        run(['git', 'branch', '-D', 'fleet-data']);
        return null;
    });
    if (unrepaired) fail(`fleet worktree: ${unrepaired}`);
    if (!run(['bun', 'scripts/fleet-sync.ts', '--no-push'])) fail('fleet sync failed');
    run(['git', '-C', FLEET_WORKTREE, 'config', 'rebase.autoStash', 'true']);
    let plan = join(root, '.practice', 'cloud-handoff', 'swarm.json');
    if(bounded||o.setupOnly){if(!existsSync(plan))writeFileSync(plan,JSON.stringify(newPlan(o.capacity),null,2)+'\n');}
    else try{await prepareNormalPlan(root,plan,o.capacity,o.side);}catch(error){
        if(String(error).includes('paused')){console.log(`RESULT stop cloud-side side=${o.side} ${String(error)}`);process.exit(0);}fail('normal plan setup: '+String(error));}
    env.SWARM_PLAN = plan;

    // Credentials of every account this side owns: the vault first; an account the side made itself from FLEET_SEED
    // (no home mark) is rebuilt from the seed and sealed, so other sides can use it too.
    const owners = JSON.parse(readFileSync(join(FLEET_WORKTREE, 'fleet', 'owners.json'), 'utf8')).accounts as Record<string, { side: string; home?: string }>;
    const mine = Object.entries(owners).filter(([n, r]) => r.side === o.side && n.toLowerCase() !== MAIN_ACCOUNT).map(([n, r]) => ({ name: n, home: r.home }));
    let key: Buffer | null = null;
    try { key = vaultKey(); } catch (e) { log(`vault key invalid: ${String(e)}`); }
    const credentials: Record<string, number> = {};
    for (const a of mine) {
        let r: string;
        try { r = restoreCredential(a.name, { key }); } catch (e) { r = 'error'; log(`credential ${a.name}: ${String(e)}`); }
        if ((r === 'missing' || r === 'no-key') && !a.home && process.env.FLEET_SEED) r = run(['bun', 'scripts/fleet.ts', 'create', a.name]) ? 'seeded' : 'error';
        else if (r === 'present' && key) { try { putCredential(a.name, key); } catch { /* the sync seals it later */ } }
        credentials[r] = (credentials[r] ?? 0) + 1;
    }
    log(`credentials ${JSON.stringify(credentials)} key=${key ? 'yes' : 'no'}`);
    if (o.setupOnly) { console.log(`RESULT ok cloud-side setup side=${o.side} accounts=${mine.length} credentials=${JSON.stringify(credentials)}`); process.exit(0); }

    let recoveryTargets:RecoveryTarget[]=[];
    if(bounded){
        if(existsSync(join(root,'.practice/stop-coordinator')))fail('bounded recovery coordinator is paused');
        const globalStop=join(root,'.practice/stop-swarm');
        if(existsSync(globalStop)&&ownerStop(readFileSync(globalStop,'utf8')))fail('bounded recovery swarm is owner-paused');
        // A bounded recovery has one coordinator-owned swarm, no planner, autopilot or trade daemon.
        for(const [file,script] of [['coordinator/owner.json','coordinator-cli.ts'],['coordinator/swarm-owner.json','swarm.ts'],['swarm-state.json','swarm.ts'],['fleet-agent.lock','fleet-agent.ts'],['autopilot.lock','autopilot.ts']]){
            const path=join(root,'.practice',file!);if(!existsSync(path))continue;
            try{const owner=JSON.parse(readFileSync(path,'utf8')),pid=typeof owner==='number'?owner:owner.pid??owner.controllerPid;
                if(!Number.isSafeInteger(pid))fail('bounded recovery owner identity unreadable: '+script);
                if(alive(pid,script!))fail('bounded recovery found an existing '+script+' owner');}
            catch{fail('bounded recovery owner record unreadable: '+script);}
        }
        try{
            const targets=JSON.parse(readFileSync(resolve((o.recover??o.inspect)!),'utf8')).targets as RecoveryTarget[];
            recoveryTargets=targets;
            const next:any=o.recover?prepareBoundedRecovery(root,JSON.parse(readFileSync(plan,'utf8')),targets,mine.map(a=>a.name),o.side):await releaseForBoundedInspection(root,JSON.parse(readFileSync(plan,'utf8')),targets,mine.map(a=>a.name),o.side,()=>run(['bun','packages/router/src/coordinator-cli.ts','--release-finished',targets.map(t=>t.account).join(',')]));
            const proposal=join(dir,'recovery-proposal.json');
            if(o.recover){writeFileSync(proposal,JSON.stringify({reason:'Exact bounded authenticated recovery',capabilities:[],tasks:next.coordination.bootstrap},null,2));next.coordination.bootstrap=[];}
            plan=join(dir,o.recover?'recovery-plan.json':'inspection-plan.json');writeFileSync(plan,JSON.stringify(next,null,2));
            env.SWARM_PLAN=plan;env.FLEET_ADOPT='0';
            // Only the existing eligibility contract permits removing these controller marks.
            if(o.recover&&!run(['bun','packages/router/src/coordinator-cli.ts','--submit',proposal]))fail('bounded recovery submission failed');
        }catch(error){log('bounded recovery preflight: '+String(error));fail('bounded recovery preflight refused');}
    }

    // An owner's stop file holds the side: start nothing. One the swarm (or a previous --stop-at-end) wrote goes.
    const stopSwarm = join(root, '.practice', 'stop-swarm');
    if (existsSync(stopSwarm)) {
        const text = readFileSync(stopSwarm, 'utf8');
        if (ownerStop(text)) { console.log(`RESULT stop cloud-side side=${o.side} owner stop file: ${text.trim().slice(0, 120)}`); process.exit(0); }
        unlinkSync(stopSwarm);
    }
    if(bounded){
        for(const t of recoveryTargets){const file=join(root,'.practice','stop-'+t.account);if(existsSync(file))writeFileSync(join(dir,`stop-${t.account}-${Date.now()}.before`),readFileSync(file),{flag:'wx',mode:0o600});}
        const cleared=clearSwarmStops(root,recoveryTargets.map(t=>t.account));log('bounded recovery controller stops cleared: '+cleared.join(','));
    }

    const pidsFile = join(dir, 'daemons.json');
    const records: Record<string, DaemonRecord> = (() => { try { return JSON.parse(readFileSync(pidsFile, 'utf8')); } catch { return {}; } })();
    const commands=managedCommands(!!o.recover,plan,!!o.inspect);
    let inspectionStartupError=false;
    const binding:BoundedOwnerBinding={watchId:randomUUID(),plan,side:o.side};
    if(!o.inspect)env.CLOUD_WATCH_ID=binding.watchId;
    const launched:{pid:number;nonce:string}[]=[];
    let recoveryLaunched=false,boundedOwnershipError=false;
    const start = (name: string) => {
        const out = openSync(join(dir, `${name}.log`), 'a');
        const nonce=name==='coordinator'?randomUUID():undefined,args=nonce?[join(root,commands[name]![0]!),...commands[name]!.slice(1),nonce]:commands[name]!;
        const child = spawn(process.execPath, args, { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
        closeSync(out); child.unref();
        const prior = records[name]?.restarts ?? [];
        records[name] = { pid: child.pid!, started: Date.now(), restarts: [...prior.filter(t => Date.now() - t < 60 * 60_000), Date.now()],...(nonce?{nonce}:{}) };
        if(nonce){launched.push({pid:child.pid!,nonce});if(o.recover)recoveryLaunched=true;}
        writeFileSync(pidsFile, JSON.stringify(records));
        log(`started ${name} pid ${child.pid}`);
    };
    const normalRoots=new Set<number>();let normalOwnershipError:string|null=null;
    const normalOwners=()=>{const view=observeNormalOwners(root,plan,o.side,records,{},[...normalRoots]);normalOwnershipError=view.known?null:view.reason;for(const pid of view.roots)normalRoots.add(pid);return view;};
    const tend = () => {
        if(!o.inspect&&existsSync(join(root,'.practice/stop-coordinator')))return;
        if(o.recover&&recoveryLaunched){
            const current=observeBoundedOwners(root,binding,launched);
            if(!current.known){boundedOwnershipError=true;log('bounded coordinator ownership unknown; no duplicate start');}
            else if(current.coordinator&&boundedProcessAlive(current.coordinator))records.coordinator={...records.coordinator!,pid:current.coordinator};
            else if(!current.active.length){boundedOwnershipError=true;log('bounded coordinator exited; no automatic retry');}
            return;
        }
        if(!bounded){const view=normalOwners();
            if(!view.known){log('normal ownership held: '+view.reason);return;}
            if(view.coordinator)records.coordinator={pid:view.coordinator.pid,nonce:view.coordinator.nonce,started:records.coordinator?.started??Date.now(),restarts:records.coordinator?.restarts??[]};
        }
        for (const name of Object.keys(commands)) {
            const r = records[name];
            if (r && alive(r.pid, commands[name]![0]!)) continue;
            if (r && !mayRestart(r.restarts, Date.now())) continue;
            start(name);
        }
    };
    tend();
    if(!bounded&&normalOwnershipError)fail('normal ownership unavailable; owners preserved: '+normalOwnershipError);
    if(o.inspect){
        // Let the owning swarm observe disabled jobs, then use its existing enable-edge resume contract.
        const until=Date.now()+15000;let observed=false;
        while(Date.now()<until){
            try{const state=JSON.parse(readFileSync(join(root,'.practice/swarm-state.json'),'utf8'));
                observed=state.controllerPid===records.swarm?.pid&&Date.now()-state.at<10000&&recoveryTargets.every(t=>state.jobs.some((j:any)=>j.account===t.account&&j.state==='disabled'));}catch{/* Await this controller's first complete snapshot. */}
            if(observed)break;await Bun.sleep(200);
        }
        if(!observed){inspectionStartupError=true;log('bounded inspection controller did not observe disabled jobs');}
        else try{await withPlanWrite(()=>{const next=JSON.parse(readFileSync(plan,'utf8'));
            if(existsSync(stopSwarm)||recoveryTargets.some(t=>[t.account,t.account.toLowerCase()].some(n=>{const file=join(root,'.practice','stop-'+n);return existsSync(file)&&ownerStop(readFileSync(file,'utf8'));})))throw Error('bounded inspection owner pause appeared');
            for(const j of next.jobs)if(recoveryTargets.some(t=>t.account===j.account))j.enabled=true;
            const temporary=plan+'.enable-'+process.pid;writeFileSync(temporary,JSON.stringify(next,null,2));renameSync(temporary,plan);
        },join(root,'.practice/coordinator'));}catch{inspectionStartupError=true;log('bounded inspection enable refused; draining controller');}
    }
    const began = Date.now(), end = began + (inspectionStartupError?0:o.watchMinutes * 60_000);
    log(`watching ${o.watchMinutes} min, ${mine.length} accounts, free ${(freemem() / 2 ** 30).toFixed(1)} GB`);
    const readStop = () => { try { return readFileSync(stopSwarm, 'utf8'); } catch { return undefined; } };
    // An owner's stop file made during the watch ends it: the swarm stops its workers itself, nothing restarts it, and
    // the RESULT stop line tells the session to stop starting this command.
    let ownerStopped = false;
    while (Date.now() < end) {
        await Bun.sleep(Math.min(60_000, Math.max(0, end - Date.now())));
        if (ownerStop(readStop())||!o.inspect&&existsSync(join(root,'.practice/stop-coordinator'))) { ownerStopped = true; log('owner stop file: watch ends'); break; }
        tend();
        if(boundedOwnershipError)break;
    }
    if (o.stopAtEnd) {
        if(!bounded){const view=normalOwners();if(!view.known)fail('normal stop ownership unavailable; owners preserved: '+view.reason);
            if(view.swarm)records.swarm={pid:view.swarm,started:Date.now(),restarts:[]};}
        if(o.recover){
            // Only the coordinator's saved owner can supply this watch's swarm identity.
            try{const owner=JSON.parse(readFileSync(join(root,'.practice/coordinator/swarm-owner.json'),'utf8'));
                if(alive(owner.pid,'scripts/swarm.ts'))records.swarm={pid:owner.pid,started:owner.at,restarts:[]};}catch{/* No live task needed a swarm. */}
        }
        // The swarm's own stop text: each worker finishes its step and logs out, the swarm exits once none runs, and no
        // other side reads the file as an owner's pause. An owner's file is never replaced or removed; this run removes
        // only the file it wrote, and only while its text is unchanged. A Codex task's default 50-minute watch plus this
        // wait ends within the hour.
        const wrote = !bounded?await prepareNormalStop(root):endStopWrites(readStop());
        if (bounded&&wrote) writeFileSync(stopSwarm, SWARM_STOP.all);
        if(!bounded)for(const name of ['fleet-agent','autopilot']){const r=records[name];if(r&&alive(r.pid,commands[name]![0]!))try{process.kill(r.pid,'SIGTERM');}catch{/* The daemon exited. */}}
        const stopBy = Date.now() + 6 * 60_000;
        while (Date.now() < stopBy && !o.recover && records.swarm && alive(records.swarm.pid, 'scripts/swarm.ts')) await Bun.sleep(5_000);
        let ownersSettled=!!o.inspect;
        if(o.recover){
            while(Date.now()<stopBy){const current=observeBoundedOwners(root,binding,launched);ownersSettled=current.known&&current.settled;if(ownersSettled)break;await Bun.sleep(1000);}
        }
        if(!bounded){while(Date.now()<stopBy){const current=normalOwners();ownersSettled=current.known&&current.settled;if(ownersSettled)break;await Bun.sleep(1000);}}
        const settled=boundedStopSettled(!!records.swarm&&alive(records.swarm.pid,'scripts/swarm.ts'),!!records.coordinator&&alive(records.coordinator.pid,'coordinator-cli.ts'));
        if(!settled||!ownersSettled){log('stop incomplete; stop fence and live owners preserved');console.log(`RESULT fail cloud-side side=${o.side} ${bounded?'bounded':'normal'} stop incomplete; stop fence preserved`);process.exit(1);}
        if (wrote && readStop() === SWARM_STOP.all) try { unlinkSync(stopSwarm); } catch { /* gone */ }
        log('stopped at end');
    }
    const up = Object.keys(commands).map(n => `${n}=${records[n] && alive(records[n]!.pid, commands[n]![0]!) ? 'up' : 'down'}`).join(' ');
    const starts = Object.keys(commands).reduce((s, n) => s + (records[n]?.restarts.filter(t => t >= began).length ?? 0), 0);
    const result=watchResult({inspectionStartupError,boundedOwnershipError,normalOwnershipError,ownerStopped});
    console.log(`RESULT ${result} cloud-side side=${o.side} minutes=${o.watchMinutes} accounts=${mine.length} ${up} starts=${starts}${ownerStopped ? ' owner stop file' : ''}${o.stopAtEnd ? ' stopped' : ''}${normalOwnershipError?' normal ownership unknown; owners preserved':''}`);
    if(result==='fail')process.exitCode=1;
}
