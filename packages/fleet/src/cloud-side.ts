// Cloud side supervisor: prepares worktree/fleet-data/credentials, ensures clean controller ownership
// (swarm + fleet-agent, zero LLM Coordinator / autopilot), handles bounded recovery/inspection modes,
// and watches until finite deadline or clean stop-at-end shutdown.
// Usage: bun packages/fleet/src/cloud-side.ts [--side <side>] [--watch-minutes <n>] [--capacity <n>] [--stop-at-end] [--setup-only]
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    appendFileSync, closeSync, existsSync, mkdirSync, openSync,
    readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { boundedGroupMembers, boundedProcessAlive, observeBoundedOwners, type BoundedOwnerBinding } from '../../core/src/bounded-owners';
import type { RecoveryTarget } from '../../core/src/bounded-recovery';
import { FLEET_WORKTREE, SIDE_NAME } from '../../core/src/fleet';
import { withFleetDataWrite } from '../../core/src/fleet-owner-claim';
import { putCredential, restoreCredential, vaultKey } from '../../core/src/fleet-vault';
import { MAIN_ACCOUNT } from '../../core/src/haggisgate';
import { withPlanWrite } from '../../core/src/plan-lock';
import { liveRoot, repoRoot } from '../../core/src/practice-paths';
import { commandLine } from '../../core/src/proc';
import { clearSwarmStops, prepareBoundedRecovery, releaseForBoundedInspection } from './cloud-recovery';
import { FETCH_FLEET_DATA, worktreeProblem } from './fleet-sync';
import { runStandaloneRecoveryPass } from './session-recovery';
import { SWARM_STOP, swarmWroteStop } from './swarm';

const root = repoRoot;
export const DEFAULT_WATCH_MINUTES = 110;
export const DAEMONS = ['swarm', 'fleet-agent'] as const;
export type Daemon = typeof DAEMONS[number];
export const MAX_RESTARTS_PER_HOUR = 6;

export type Options = {
    side: string;
    watchMinutes: number;
    capacity: number;
    stopAtEnd: boolean;
    setupOnly: boolean;
    recover?: string;
    inspect?: string;
};

export function parseOptions(argv: string[], env: Record<string, string | undefined> = process.env): Options {
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
    const side = value('--side') ?? env.FLEET_SIDE ?? '';
    if (!SIDE_NAME.test(side) || side === 'local') throw Error(`cloud-side: --side must name a cloud fleet side, not "${side}"`);
    const watchMinutes = Number(value('--watch-minutes') ?? DEFAULT_WATCH_MINUTES), capacity = Number(value('--capacity') ?? 4);
    if (!(watchMinutes > 0 && watchMinutes <= 24 * 60)) throw Error('cloud-side: --watch-minutes must be 1..1440');
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw Error('cloud-side: --capacity must be a whole number');
    const recover = value('--recover'), inspect = value('--inspect'), bounded = recover ?? inspect;
    if ((argv.includes('--recover') || argv.includes('--inspect')) && (!bounded || bounded.startsWith('--') || (recover && inspect) || !argv.includes('--watch-minutes') || !argv.includes('--stop-at-end') || argv.includes('--setup-only'))) {
        throw Error('cloud-side: recovery/inspection requires one manifest, explicit watch and --stop-at-end');
    }
    return { side, watchMinutes, capacity, stopAtEnd: argv.includes('--stop-at-end'), setupOnly: argv.includes('--setup-only'), ...(recover ? { recover } : {}), ...(inspect ? { inspect } : {}) };
}

export function sessionPrompt(kind: 'claude' | 'codex', side: string, watchMinutes = kind === 'codex' ? 50 : DEFAULT_WATCH_MINUTES): string {
    if (!SIDE_NAME.test(side) || side === 'local') throw Error('cloud-side: invalid side');
    const failure = [
        `On RESULT fail or a nonzero exit, diagnose the failing command from its captured output. Read the exact .practice/cloud-side/${side}/run.log and the failed setup step only when they belong to this attempt; inspect only the source and state needed to explain it.`,
        'Do not repeat a failed command unchanged. Reuse the existing setup repair and its focused check, then resume only the same cloud-side command once after that check passes.',
        'Preserve source/vendor changes and credentials. Before any SDK reset, obtain fresh evidence, classify the SDK changes and verify a recovery copy; never reset blindly or use --force.',
        'Honor owner pauses, account leases, protected clocks and host limits; no alternate bots or controllers, new accounts, protected logins, paid APIs or quota resets. Never print secrets.',
        'If unresolved, report the cause, evidence path and retained diagnostic, or state which observation is missing. Do not turn the failure into an unchanged restart loop.',
    ];
    if (kind === 'codex') {
        return [
            `Run exactly this one command from the repository root and wait for it: git fetch -q origin master && git checkout -q --detach origin/master && export PATH="/workspace/.tools/bun/node_modules/.bin:$HOME/.bun/bin:$PATH" && bun scripts/cloud-side.ts --side ${side} --watch-minutes ${watchMinutes} --stop-at-end`,
            'On RESULT ok, reply with its last output line only. On RESULT stop, honor the stop and end the session.',
            ...failure,
        ].join('\n');
    }
    return [
        `Fleet side ${side}: you only keep one command running. Start it now with run_in_background and a 7200000 ms timeout:`,
        `bun scripts/cloud-side.ts --side ${side} --watch-minutes ${watchMinutes}`,
        'On RESULT ok, start the same command again. On RESULT stop, honor the stop and end the session. Apply these outcome rules to reminders and stop hooks too.',
        ...failure,
    ].join('\n');
}

export function worktreeSetupResult(
    result: { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error },
    retain: (output: string) => void,
    env: Readonly<Record<string, string | undefined>> = process.env,
): { ok: boolean; detail: string } {
    const command = `$ bun tools/worktree-setup.ts -> ${result.status}`;
    if (result.status === 0) { retain(command); return { ok: true, detail: '' }; }
    let output = [result.stdout ?? '', result.stderr ?? '', result.error?.message ?? ''].join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const secrets: string[] = [];
    for (const name in env) {
        if (!Object.hasOwn(env, name)) continue;
        const value = env[name];
        if (value && /TOKEN|PASSWORD|PASSWD|SECRET|SEED|KEY|COOKIE|AUTH/i.test(name)) secrets.push(value);
    }
    secrets.sort((a, b) => b.length - a.length);
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
    if (name === 'swarm') return ['scripts/swarm.ts', plan];
    return ['scripts/fleet-agent.ts'];
}

export function managedCommands(recover: boolean, plan: string, inspect = false): Record<string, string[]> {
    if (recover || inspect) return { swarm: daemonCommand('swarm', plan) };
    const out: Record<string, string[]> = {};
    for (const n of DAEMONS) out[n] = daemonCommand(n, plan);
    return out;
}

export const boundedStopSettled = (swarmAlive: boolean, extraAlive = false) => !swarmAlive && !extraAlive;

export function mayRestart(restarts: readonly number[], now: number): boolean {
    const cutoff = now - 60 * 60_000;
    let recent = 0;
    for (let i = 0; i < restarts.length; i++) {
        if (restarts[i]! > cutoff) {
            recent++;
            if (recent >= MAX_RESTARTS_PER_HOUR) return false;
        }
    }
    return true;
}

export const ownerStop = (text: string | undefined) => text !== undefined && !swarmWroteStop(text);
export const endStopWrites = (existing: string | undefined) => !ownerStop(existing);

export function watchResult(v: { inspectionStartupError?: boolean; boundedOwnershipError?: boolean; normalOwnershipError?: string | null; ownerStopped?: boolean }) {
    return v.inspectionStartupError || v.boundedOwnershipError || v.normalOwnershipError ? 'fail' : v.ownerStopped ? 'stop' : 'ok';
}

export function newPlan(capacity: number) {
    return { maxBots: 4, minFreeGB: 4, fleetCapacity: capacity, jobs: [] as unknown[] };
}

export async function prepareNormalPlan(base: string, plan: string, capacity: number, _side = 'cloud') {
    await withPlanWrite(() => {
        const stop = join(base, '.practice/stop-swarm');
        if (existsSync(join(base, '.practice/stop-coordinator')) || (existsSync(stop) && ownerStop(readFileSync(stop, 'utf8')))) {
            throw Error('normal swarm controller is owner-paused');
        }
        const next = existsSync(plan) ? JSON.parse(readFileSync(plan, 'utf8')) : newPlan(capacity);
        if (next.boundedRecovery || next.boundedInspection) throw Error('normal swarm controller refuses a bounded plan');
        mkdirSync(resolve(plan, '..'), { recursive: true });
        const temporary = plan + '.' + process.pid + '.tmp';
        writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n');
        renameSync(temporary, plan);
    }, join(base, '.practice/live'));
}

export async function prepareNormalStop(base: string) {
    return withPlanWrite(() => {
        const file = join(base, '.practice/stop-swarm');
        if (existsSync(file) && ownerStop(readFileSync(file, 'utf8'))) return false;
        writeFileSync(file, SWARM_STOP.all);
        return true;
    }, join(base, '.practice/live'));
}

function isAsciiDigits(s: string): boolean {
    if (s.length === 0) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

function normalSwarmProcesses(base: string) {
    if (process.platform !== 'linux') return [];
    const directory = realpathSync(base), found: number[] = [];
    for (const row of readdirSync('/proc')) {
        if (!isAsciiDigits(row)) continue;
        try {
            const pid = Number(row), line = commandLine(pid);
            if (!line?.includes('scripts/swarm.ts')) continue;
            if (line.includes(join(base, 'scripts/swarm.ts')) || readlinkSync('/proc/' + row + '/cwd') === directory) found.push(pid);
        } catch { /* exited during scan */ }
    }
    return found;
}

export function observeNormalOwners(
    base: string,
    plan: string,
    side: string,
    records: Record<string, DaemonRecord>,
    deps: {
        alive?: (pid: number) => boolean;
        command?: (pid: number) => string | null;
        groups?: (roots: readonly number[]) => number[] | null;
        processes?: () => number[];
    } = {},
    priorRoots: readonly number[] = [],
) {
    const alive = deps.alive ?? boundedProcessAlive, command = deps.command ?? commandLine;
    const roots = new Set(priorRoots), active = new Set<number>(), observed = new Map<string, string>();
    let swarm: { pid: number; nonce: string } | null = null;
    const read = (file: string) => { if (!existsSync(file)) return; const raw = readFileSync(file, 'utf8'); observed.set(file, raw); return JSON.parse(raw); };
    const match = (owner: any) => {
        if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.nonce !== 'string' || !owner.nonce) throw Error('normal owner identity unreadable');
        roots.add(owner.pid);
        if (!alive(owner.pid)) return false;
        const line = command(owner.pid), script = join(base, 'scripts/swarm.ts');
        if (!line?.includes(script) || !line.includes(owner.nonce)) throw Error('normal live owner command unknown');
        active.add(owner.pid);
        return true;
    };
    try {
        const liveDir = liveRoot(base);
        const ownedSwarmPids = new Set<number>();
        const controller = read(join(liveDir, 'swarm-owner.json'));
        if (controller) {
            if (alive(controller.pid) && (controller.plan !== resolve(plan) || controller.side !== side)) throw Error('normal swarm plan or side changed');
            if (match(controller)) { swarm = { pid: controller.pid, nonce: controller.nonce }; ownedSwarmPids.add(controller.pid); }
            if (controller.successor && match(controller.successor)) { swarm = { pid: controller.successor.pid, nonce: controller.successor.nonce }; ownedSwarmPids.add(controller.successor.pid); }
        }
        const launched = records.swarm;
        if (launched?.nonce && alive(launched.pid) && !active.has(launched.pid)) {
            if (match(launched)) { ownedSwarmPids.add(launched.pid); if (!swarm) swarm = { pid: launched.pid, nonce: launched.nonce }; }
        }
        const state = read(join(base, '.practice/swarm-state.json'));
        const candidates = new Set<number>();
        const procs = (deps.processes ?? (() => normalSwarmProcesses(base)))();
        for (let i = 0; i < procs.length; i++) if (Number.isSafeInteger(procs[i])) candidates.add(procs[i]!);
        if (Number.isSafeInteger(records.swarm?.pid)) candidates.add(records.swarm!.pid);
        if (Number.isSafeInteger(state?.controllerPid)) candidates.add(state.controllerPid);
        for (const pid of candidates) if (alive(pid) && !ownedSwarmPids.has(pid)) throw Error('normal migration waits for unowned swarm to settle');
        for (const row of read(join(base, '.practice/swarm-runs.json')) ?? []) {
            if (!Number.isSafeInteger(row.pid) || row.pid < 1) throw Error('normal supervisor identity unreadable');
            roots.add(row.pid);
            if (alive(row.pid)) active.add(row.pid);
        }
        const agentRecord = records['fleet-agent'];
        if (agentRecord) {
            const pid = agentRecord.pid;
            roots.add(pid);
            if (alive(pid)) {
                if (!command(pid)?.replaceAll('\\', '/').includes('scripts/fleet-agent.ts')) throw Error('normal daemon command unknown');
                active.add(pid);
            }
        }
        const members = (deps.groups ?? boundedGroupMembers)([...roots]);
        if (members === null) throw Error('normal child groups unavailable');
        for (const pid of members) active.add(pid);
        if (!active.size && ['build-lock.json', '../swarm-repair.json.lease'].some(file => existsSync(join(liveDir, file)))) {
            throw Error('normal authority fence remains unresolved');
        }
        for (const [file, raw] of observed) if (readFileSync(file, 'utf8') !== raw) throw Error('normal owners changed during observation');
        return { known: true, settled: active.size === 0, active: [...active], coordinator: null, swarm: swarm?.pid ?? null, roots: [...roots], reason: null };
    } catch (error) {
        return { known: false, settled: false, active: [...active], coordinator: null, swarm: null, roots: [...roots], reason: String(error) };
    }
}

function alive(pid: number, script: string): boolean {
    if (!boundedProcessAlive(pid)) return false;
    const cmd = commandLine(pid);
    return cmd === null || cmd.replaceAll('\\', '/').includes(script);
}

export async function runCloudSideCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    let o: Options;
    try { o = parseOptions([...argv]); } catch (e) { console.log(`RESULT fail ${String(e)}`); process.exit(2); }
    const dir = join(root, '.practice', 'cloud-side', o.side), logFile = join(dir, 'run.log');
    mkdirSync(dir, { recursive: true });
    const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    const bounded = !!(o.recover || o.inspect);
    const env = { ...process.env, FLEET_SIDE: o.side, DEMO_OK: '1', ...(bounded ? { FLEET_ADOPT: '0' } : {}) } as Record<string, string>;
    const run = (cmd: string[], cwd = root, timeoutMs = 900_000) => {
        const p = spawnSync(cmd[0]!, cmd.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
        log(`$ ${cmd.join(' ')} -> ${p.status}${p.status === 0 ? '' : ` ${(p.stdout + p.stderr).replace(/\s+/g, ' ').slice(-300)}`}`);
        return p.status === 0;
    };
    const lock = join(dir, 'lock.json');
    try {
        const held = existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')) : null;
        if (held && alive(held.pid, 'cloud-side')) { console.log(`RESULT ok cloud-side already watching side=${o.side} pid=${held.pid}`); process.exit(0); }
    } catch { /* dead lock */ }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const unlock = () => { try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock); } catch { /* gone */ } };
    process.on('exit', unlock);
    const fail = (why: string) => { log(`FAIL ${why}`); console.log(`RESULT fail cloud-side side=${o.side} ${why} (log ${logFile})`); process.exit(1); };

    const setup = worktreeSetupResult(spawnSync('bun', ['tools/worktree-setup.ts'], { cwd: root, env, encoding: 'utf8', timeout: 1_200_000, windowsHide: true }), log, env);
    if (!setup.ok) fail('worktree setup failed: ' + setup.detail);
    run(['git', 'config', 'submodule.vendor/rs-sdk.ignore', 'dirty']);
    for (const d of ['cloud-handoff', 'status', 'swarm-logs']) mkdirSync(join(root, '.practice', d), { recursive: true });

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
    if (bounded || o.setupOnly) {
        if (!existsSync(plan)) writeFileSync(plan, JSON.stringify(newPlan(o.capacity), null, 2) + '\n');
    } else {
        try { await prepareNormalPlan(root, plan, o.capacity, o.side); }
        catch (error) {
            if (String(error).includes('paused')) { console.log(`RESULT stop cloud-side side=${o.side} ${String(error)}`); process.exit(0); }
            fail('normal plan setup: ' + String(error));
        }
    }
    env.SWARM_PLAN = plan;

    const owners = JSON.parse(readFileSync(join(FLEET_WORKTREE, 'fleet', 'owners.json'), 'utf8')).accounts as Record<string, { side: string; home?: string }>;
    const mine = Object.entries(owners).filter(([n, r]) => r.side === o.side && n.toLowerCase() !== MAIN_ACCOUNT).map(([n, r]) => ({ name: n, home: r.home }));
    let key: Buffer | null = null;
    try { key = vaultKey(); } catch (e) { log(`vault key invalid: ${String(e)}`); }
    const credentials: Record<string, number> = {};
    for (const a of mine) {
        let r: string;
        try { r = restoreCredential(a.name, { key }); } catch (e) { r = 'error'; log(`credential ${a.name}: ${String(e)}`); }
        if ((r === 'missing' || r === 'no-key') && !a.home && process.env.FLEET_SEED) r = run(['bun', 'scripts/fleet.ts', 'create', a.name]) ? 'seeded' : 'error';
        else if (r === 'present' && key) { try { putCredential(a.name, key); } catch { /* seal later */ } }
        credentials[r] = (credentials[r] ?? 0) + 1;
    }
    log(`credentials ${JSON.stringify(credentials)} key=${key ? 'yes' : 'no'}`);
    if (o.setupOnly) { console.log(`RESULT ok cloud-side setup side=${o.side} accounts=${mine.length} credentials=${JSON.stringify(credentials)}`); process.exit(0); }

    let recoveryTargets: RecoveryTarget[] = [];
    if (bounded) {
        if (existsSync(join(root, '.practice/stop-coordinator'))) fail('bounded recovery controller is paused');
        const globalStop = join(root, '.practice/stop-swarm');
        if (existsSync(globalStop) && ownerStop(readFileSync(globalStop, 'utf8'))) fail('bounded recovery swarm is owner-paused');
        for (const [file, script] of [['live/swarm-owner.json', 'swarm.ts'], ['swarm-state.json', 'swarm.ts'], ['fleet-agent.lock', 'fleet-agent.ts']]) {
            const path = join(root, '.practice', file!);
            if (!existsSync(path)) continue;
            try {
                const owner = JSON.parse(readFileSync(path, 'utf8')), pid = typeof owner === 'number' ? owner : owner.pid ?? owner.controllerPid;
                if (!Number.isSafeInteger(pid)) fail('bounded recovery owner identity unreadable: ' + script);
                if (alive(pid, script!)) fail('bounded recovery found an existing ' + script + ' owner');
            } catch { fail('bounded recovery owner record unreadable: ' + script); }
        }
        try {
            const targets = JSON.parse(readFileSync(resolve((o.recover ?? o.inspect)!), 'utf8')).targets as RecoveryTarget[];
            recoveryTargets = targets;
            const next: any = o.recover
                ? prepareBoundedRecovery(root, JSON.parse(readFileSync(plan, 'utf8')), targets, mine.map(a => a.name), o.side)
                : await releaseForBoundedInspection(root, JSON.parse(readFileSync(plan, 'utf8')), targets, mine.map(a => a.name), o.side);
            plan = join(dir, o.recover ? 'recovery-plan.json' : 'inspection-plan.json');
            writeFileSync(plan, JSON.stringify(next, null, 2));
            env.SWARM_PLAN = plan; env.FLEET_ADOPT = '0';
        } catch (error) { log('bounded recovery preflight: ' + String(error)); fail('bounded recovery preflight refused'); }
    }

    const stopSwarm = join(root, '.practice', 'stop-swarm');
    if (existsSync(stopSwarm)) {
        const text = readFileSync(stopSwarm, 'utf8');
        if (ownerStop(text)) { console.log(`RESULT stop cloud-side side=${o.side} owner stop file: ${text.trim().slice(0, 120)}`); process.exit(0); }
        unlinkSync(stopSwarm);
    }
    if (bounded) {
        for (const t of recoveryTargets) {
            const file = join(root, '.practice', 'stop-' + t.account);
            if (existsSync(file)) writeFileSync(join(dir, `stop-${t.account}-${Date.now()}.before`), readFileSync(file), { flag: 'wx', mode: 0o600 });
        }
        const cleared = clearSwarmStops(root, recoveryTargets.map(t => t.account));
        log('bounded recovery controller stops cleared: ' + cleared.join(','));
        if (o.recover) {
            await runStandaloneRecoveryPass({ root, dry: false, log: line => log(`recovery: ${line}`) });
        }
    }

    const pidsFile = join(dir, 'daemons.json');
    const records: Record<string, DaemonRecord> = (() => { try { return JSON.parse(readFileSync(pidsFile, 'utf8')); } catch { return {}; } })();
    const commands = managedCommands(!!o.recover, plan, !!o.inspect);
    let inspectionStartupError = false;
    const binding: BoundedOwnerBinding = { watchId: randomUUID(), plan, side: o.side };
    if (!o.inspect) env.CLOUD_WATCH_ID = binding.watchId;
    const launched: { pid: number; nonce: string }[] = [];
    let recoveryLaunched = false, boundedOwnershipError = false;

    const start = (name: string) => {
        const out = openSync(join(dir, `${name}.log`), 'a');
        const nonce = name === 'swarm' ? randomUUID() : undefined;
        const args = nonce ? [...commands[name]!, `--nonce=${nonce}`, ...(!o.inspect ? [`--watch-id=${binding.watchId}`] : [])] : commands[name]!;
        const child = spawn(process.execPath, args, { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
        closeSync(out);
        if (!child.pid) throw Error(`cloud-side failed to spawn ${name}`);
        child.unref();
        const prior = records[name]?.restarts ?? [];
        records[name] = { pid: child.pid, started: Date.now(), restarts: [...prior.filter(t => Date.now() - t < 60 * 60_000), Date.now()], ...(nonce ? { nonce } : {}) };
        if (nonce) { launched.push({ pid: child.pid, nonce }); if (o.recover) recoveryLaunched = true; }
        writeFileSync(pidsFile, JSON.stringify(records));
        log(`started ${name} pid ${child.pid}`);
    };

    const normalRoots = new Set<number>();
    let normalOwnershipError: string | null = null;
    const normalOwners = () => {
        const view = observeNormalOwners(root, plan, o.side, records, {}, [...normalRoots]);
        normalOwnershipError = view.known ? null : view.reason;
        for (const pid of view.roots) normalRoots.add(pid);
        return view;
    };

    const tend = () => {
        if (o.recover && recoveryLaunched) {
            const current = observeBoundedOwners(root, binding, launched);
            if (!current.known) { boundedOwnershipError = true; log('bounded swarm ownership unknown; no duplicate start'); }
            else if (current.coordinator && boundedProcessAlive(current.coordinator)) records.swarm = { ...records.swarm!, pid: current.coordinator };
            else if (!current.active.length) { boundedOwnershipError = true; log('bounded swarm exited; no automatic retry'); }
            return;
        }
        if (!bounded) {
            const view = normalOwners();
            if (!view.known) { log('normal ownership held: ' + view.reason); return; }
            if (view.swarm) records.swarm = { pid: view.swarm, nonce: records.swarm?.nonce, started: records.swarm?.started ?? Date.now(), restarts: records.swarm?.restarts ?? [] };
        }
        for (const name of Object.keys(commands)) {
            const r = records[name];
            if (r && alive(r.pid, commands[name]![0]!)) continue;
            if (r && !mayRestart(r.restarts, Date.now())) continue;
            start(name);
        }
    };

    tend();
    if (!bounded && normalOwnershipError) fail('normal ownership unavailable; owners preserved: ' + normalOwnershipError);
    if (o.inspect) {
        const until = Date.now() + 15_000;
        let observed = false;
        while (Date.now() < until) {
            try {
                const state = JSON.parse(readFileSync(join(root, '.practice/swarm-state.json'), 'utf8'));
                observed = state.controllerPid === records.swarm?.pid && Date.now() - state.at < 10_000
                    && recoveryTargets.every(t => state.jobs.some((j: any) => j.account === t.account && j.state === 'disabled'));
            } catch { /* wait */ }
            if (observed) break;
            await Bun.sleep(200);
        }
        if (!observed) {
            inspectionStartupError = true; log('bounded inspection controller did not observe disabled jobs');
        } else {
            try {
                await withPlanWrite(() => {
                    const next = JSON.parse(readFileSync(plan, 'utf8'));
                    if (existsSync(stopSwarm) || recoveryTargets.some(t => [t.account, t.account.toLowerCase()].some(n => {
                        const file = join(root, '.practice', 'stop-' + n);
                        return existsSync(file) && ownerStop(readFileSync(file, 'utf8'));
                    }))) throw Error('bounded inspection owner pause appeared');
                    for (const j of next.jobs) if (recoveryTargets.some(t => t.account === j.account)) j.enabled = true;
                    const temporary = plan + '.enable-' + process.pid;
                    writeFileSync(temporary, JSON.stringify(next, null, 2));
                    renameSync(temporary, plan);
                }, join(root, '.practice/live'));
            } catch {
                inspectionStartupError = true; log('bounded inspection enable refused; draining controller');
            }
        }
    }

    const began = Date.now(), end = began + (inspectionStartupError ? 0 : o.watchMinutes * 60_000);
    log(`watching ${o.watchMinutes} min, ${mine.length} accounts, free ${(freemem() / 2 ** 30).toFixed(1)} GB`);
    const readStop = () => { try { return readFileSync(stopSwarm, 'utf8'); } catch { return undefined; } };
    let ownerStopped = false;
    while (Date.now() < end) {
        await Bun.sleep(Math.min(60_000, Math.max(0, end - Date.now())));
        if (ownerStop(readStop()) || (!o.inspect && existsSync(join(root, '.practice/stop-coordinator')))) {
            ownerStopped = true; log('owner stop file: watch ends'); break;
        }
        tend();
        if (boundedOwnershipError) break;
    }

    if (o.stopAtEnd) {
        if (!bounded) {
            const view = normalOwners();
            if (!view.known) fail('normal stop ownership unavailable; owners preserved: ' + view.reason);
            if (view.swarm) records.swarm = { ...records.swarm, pid: view.swarm, started: records.swarm?.started ?? Date.now(), restarts: records.swarm?.restarts ?? [] };
        }
        if (o.recover) {
            try {
                const owner = JSON.parse(readFileSync(join(liveRoot(root), 'swarm-owner.json'), 'utf8'));
                if (alive(owner.pid, 'scripts/swarm.ts')) records.swarm = { ...records.swarm, pid: owner.pid, started: owner.at ?? records.swarm?.started ?? Date.now(), restarts: records.swarm?.restarts ?? [] };
            } catch { /* no swarm ran */ }
        }
        const wrote = !bounded ? await prepareNormalStop(root) : endStopWrites(readStop());
        if (bounded && wrote) writeFileSync(stopSwarm, SWARM_STOP.all);
        if (!bounded) {
            const r = records['fleet-agent'];
            if (r && alive(r.pid, commands['fleet-agent']![0]!)) try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ }
        }
        const stopBy = Date.now() + 6 * 60_000;
        while (Date.now() < stopBy && !o.recover && records.swarm && alive(records.swarm.pid, 'scripts/swarm.ts')) await Bun.sleep(5_000);
        let ownersSettled = !!o.inspect;
        if (o.recover) {
            while (Date.now() < stopBy) {
                const current = observeBoundedOwners(root, binding, launched);
                ownersSettled = current.known && current.settled;
                if (ownersSettled) break;
                await Bun.sleep(1000);
            }
        }
        if (!bounded) {
            while (Date.now() < stopBy) {
                const current = normalOwners();
                ownersSettled = current.known && current.settled;
                if (ownersSettled) break;
                await Bun.sleep(1000);
            }
        }
        const settled = boundedStopSettled(!!records.swarm && alive(records.swarm.pid, 'scripts/swarm.ts'));
        if (!settled || !ownersSettled) {
            log('stop incomplete; stop fence and live owners preserved');
            console.log(`RESULT fail cloud-side side=${o.side} ${bounded ? 'bounded' : 'normal'} stop incomplete; stop fence preserved`);
            process.exit(1);
        }
        if (wrote && readStop() === SWARM_STOP.all) try { unlinkSync(stopSwarm); } catch { /* gone */ }
        log('stopped at end');
    }

    const up = Object.keys(commands).map(n => `${n}=${records[n] && alive(records[n]!.pid, commands[n]![0]!) ? 'up' : 'down'}`).join(' ');
    const starts = Object.keys(commands).reduce((s, n) => s + (records[n]?.restarts.filter(t => t >= began).length ?? 0), 0);
    const result = watchResult({ inspectionStartupError, boundedOwnershipError, normalOwnershipError, ownerStopped });
    console.log(`RESULT ${result} cloud-side side=${o.side} minutes=${o.watchMinutes} accounts=${mine.length} ${up} starts=${starts}${ownerStopped ? ' owner stop file' : ''}${o.stopAtEnd ? ' stopped' : ''}${normalOwnershipError ? ' normal ownership unknown; owners preserved' : ''}`);
    if (result === 'fail') process.exitCode = 1;
}

if (import.meta.main) {
    await runCloudSideCli(process.argv.slice(2));
}
