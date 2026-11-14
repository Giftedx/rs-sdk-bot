// Starts cloud fleet sessions from the PC when accounts need a running side: a Claude Code cloud session (a scheduled
// task's API trigger, or `claude --cloud`) or a Codex cloud task (`codex cloud exec`), each told only to run
// scripts/cloud-side.ts. The local watchdog calls `--once` each pass (packages/router/src/watchdog.ts); a person can run
// it by hand. .practice/stop-cloud-launch keeps it off.
// Config: .practice/cloud-launch/config.json (local only; it may name token files):
//   { "enabled": true, "maxClaude": 1, "maxCodex": 1,
//     "sides": [ { "side": "claude-cloud", "kind": "claude", "via": "routine", "routine": "trig_...", "tokenFile": ".practice/cloud-launch/claude-cloud.token" },
//                { "side": "cloud", "kind": "codex", "env": "<codex environment id or label>" } ] }
//   via "routine": POST the trigger's /fire with its bearer token (tokenFile, or tokenEnv naming a variable). The
//     scheduled task holds the prompt (`--prompt claude <side>` prints it) and pins the environment and model.
//   via "cli": `claude --cloud "<prompt>"` from this checkout (the default environment of `/remote-env`).
// A side launches when its controller lease is silent (no renewal within LIVE_MS), it owns accounts or some side's
// accounts are stranded, its last launch is older than COOLDOWN_MS, fewer than its kind's cap of sessions are live or
// starting, and it has had fewer than MAX_PER_DAY launches in 24 hours. Each launch is recorded in
// .practice/cloud-launch/state.json.
// Usage: bun scripts/cloud-launch.ts --once | --dry | --prompt <claude|codex> <side>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_DIR, SIDE_NAME } from '../packages/core/src/fleet';
import { allLeaseLastSeen, fleetGitWindow } from '../packages/core/src/fleet-lease';
import { LIVE_MS, STRANDED_MS, exempt } from '../packages/core/src/fleet-assign';
import { sessionPrompt } from './cloud-side';

const root = resolve(import.meta.dir, '..');
const dir = join(root, '.practice', 'cloud-launch');
export const COOLDOWN_MS = 40 * 60_000;
export const MAX_PER_DAY = 12;
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

// `bin`: the CLI's executable when `claude` or `codex` is not one Node can start by name (on Windows npm installs a
// .cmd shim, which needs a shell that would split the prompt; name the native .exe). `watchMinutes`: the watch of a
// launched session's command (cloud-side.ts), for a Codex task that must end within its time limit.
export type SideConfig = { side: string; kind: 'claude' | 'codex'; via?: 'routine' | 'cli'; routine?: string; tokenFile?: string; tokenEnv?: string; env?: string; bin?: string; watchMinutes?: number };
export type Config = { enabled?: boolean; maxClaude?: number; maxCodex?: number; sides: SideConfig[] };
export type Launch = { side: string; kind: string; via: string; at: number; ok: boolean; detail: string };

export function readConfig(text: string): Config {
    const c = JSON.parse(text) as Config;
    if (!Array.isArray(c?.sides)) throw Error('cloud-launch: config has no sides list');
    for (const s of c.sides) {
        if (!SIDE_NAME.test(s?.side) || s.side === 'local') throw Error(`cloud-launch: bad side ${s?.side}`);
        if (s.watchMinutes !== undefined && !(s.watchMinutes > 0 && s.watchMinutes <= 1440)) throw Error(`cloud-launch: ${s.side} watchMinutes must be 1..1440`);
        if (s.kind === 'codex') { if (!s.env) throw Error(`cloud-launch: ${s.side} needs a Codex env`); }
        else if (s.kind === 'claude') { if ((s.via ?? 'routine') === 'routine' && (!/^trig_[A-Za-z0-9]+$/.test(s.routine ?? '') || !(s.tokenFile || s.tokenEnv))) throw Error(`cloud-launch: ${s.side} needs a routine trigger id and a token file or variable`); }
        else throw Error(`cloud-launch: ${s.side} kind must be claude or codex`);
    }
    return c;
}

// Which configured sides to start now. `seen`: each side's newest lease renewal. `owned`: accounts each side owns,
// the main and specialist accounts aside. `stranded`: accounts whose side has been silent STRANDED_MS.
export function planLaunches(v: { config: Config; seen: ReadonlyMap<string, number>; owned: ReadonlyMap<string, number>; stranded: number; history: readonly Launch[]; now: number }): SideConfig[] {
    const { config, seen, now } = v;
    if (config.enabled === false) return [];
    const live = (side: string) => { const s = seen.get(side); return s !== undefined && now - s < LIVE_MS; };
    const starting = (side: string) => v.history.some(l => l.side === side && l.ok && now - l.at < COOLDOWN_MS);
    const cap = { claude: config.maxClaude ?? 1, codex: config.maxCodex ?? 1 };
    const busy = { claude: 0, codex: 0 };
    const sides = [...new Map(config.sides.map(s => [s.side, s])).values()];
    for (const s of sides) if (live(s.side) || starting(s.side)) busy[s.kind]++;
    const out: SideConfig[] = [];
    for (const s of sides) {
        if (live(s.side) || starting(s.side)) continue;
        if ((v.owned.get(s.side) ?? 0) === 0 && v.stranded === 0) continue;
        if (v.history.some(l => l.side === s.side && now - l.at < COOLDOWN_MS)) continue;
        if (v.history.filter(l => l.side === s.side && now - l.at < 24 * 60 * 60_000).length >= MAX_PER_DAY) continue;
        if (busy[s.kind] >= cap[s.kind]) continue;
        busy[s.kind]++;
        out.push(s);
    }
    return out;
}

// The command or request of one launch. Returned rather than run, so a test checks it without starting anything.
export function launchRequest(s: SideConfig, token?: string): { kind: 'http'; url: string; headers: Record<string, string>; body: string } | { kind: 'exec'; cmd: string[] } {
    if (s.kind === 'codex') return { kind: 'exec', cmd: [s.bin ?? 'codex', 'cloud', 'exec', '--env', s.env!, sessionPrompt('codex', s.side, s.watchMinutes)] };
    if ((s.via ?? 'routine') === 'cli') return { kind: 'exec', cmd: [s.bin ?? 'claude', '--cloud', sessionPrompt('claude', s.side, s.watchMinutes)] };
    if (!token) throw Error(`cloud-launch: no token for ${s.side}`);
    return { kind: 'http', url: `https://api.anthropic.com/v1/claude_code/routines/${s.routine}/fire`,
        // The API refuses a request with no anthropic-version (HTTP 400 "anthropic-version: header is required").
        headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': ROUTINE_BETA, 'content-type': 'application/json' },
        body: JSON.stringify({ text: `fleet side ${s.side}` }) };
}

function token(s: SideConfig): string | undefined {
    if (s.tokenEnv) return process.env[s.tokenEnv]?.trim() || undefined;
    if (s.tokenFile) { try { return readFileSync(resolve(root, s.tokenFile), 'utf8').trim() || undefined; } catch { return undefined; } }
    return undefined;
}

async function launch(s: SideConfig): Promise<{ ok: boolean; detail: string }> {
    const req = launchRequest(s, s.kind === 'claude' && (s.via ?? 'routine') === 'routine' ? token(s) : undefined);
    if (req.kind === 'http') {
        const r = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(30_000) });
        const text = (await r.text()).replace(/\s+/g, ' ');
        const url = text.match(/https:\/\/claude\.ai\/code\/[A-Za-z0-9_\/-]+/)?.[0];
        return { ok: r.ok, detail: r.ok ? `fired${url ? ' ' + url : ''}` : `HTTP ${r.status} ${text.slice(0, 160)}` };
    }
    const p = spawnSync(req.cmd[0]!, req.cmd.slice(1), { cwd: root, encoding: 'utf8', timeout: 180_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = `${p.stdout ?? ''} ${p.stderr ?? ''}`.replace(/\s+/g, ' ').trim();
    return { ok: p.status === 0, detail: p.status === 0 ? out.slice(-200) : `exit ${p.status ?? p.error?.message} ${out.slice(-200)}` };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args[0] === '--prompt') {
        console.log(sessionPrompt(args[1] === 'codex' ? 'codex' : 'claude', args[2] ?? ''));
        process.exit(0);
    }
    if (!args.includes('--once') && !args.includes('--dry')) { console.log('usage: bun scripts/cloud-launch.ts --once | --dry | --prompt <claude|codex> <side>'); process.exit(2); }
    try {
        if (existsSync(join(root, '.practice', 'stop-cloud-launch'))) { console.log('CLOUD_LAUNCH stopped by .practice/stop-cloud-launch'); process.exit(0); }
        const configFile = join(dir, 'config.json');
        if (!existsSync(configFile)) { console.log(`CLOUD_LAUNCH no config (${configFile})`); process.exit(0); }
        const config = readConfig(readFileSync(configFile, 'utf8'));
        const seen = allLeaseLastSeen(fleetGitWindow(root, 'cloud launch', 60_000), join(FLEET_DIR(), 'leases'));
        const owners = JSON.parse(readFileSync(join(FLEET_DIR(), 'owners.json'), 'utf8')).accounts as Record<string, { side: string }>;
        const owned = new Map<string, number>();
        let stranded = 0;
        const now = Date.now();
        for (const [name, o] of Object.entries(owners)) {
            if (exempt(name)) continue;
            owned.set(o.side, (owned.get(o.side) ?? 0) + 1);
            const s = seen.get(o.side);
            if (s === undefined || now - s >= STRANDED_MS) stranded++;
        }
        const stateFile = join(dir, 'state.json');
        const history: Launch[] = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')).launches ?? []; } catch { return []; } })();
        const due = planLaunches({ config, seen, owned, stranded, history, now });
        const liveSides = config.sides.filter(s => { const t = seen.get(s.side); return t !== undefined && now - t < LIVE_MS; }).map(s => s.side);
        console.log(`CLOUD_LAUNCH live=${liveSides.join(',') || 'none'} stranded=${stranded} due=${due.map(s => s.side).join(',') || 'none'}${args.includes('--dry') ? ' (dry)' : ''}`);
        if (args.includes('--dry')) process.exit(0);
        for (const s of due) {
            let r: { ok: boolean; detail: string };
            try { r = await launch(s); } catch (e) { r = { ok: false, detail: String(e).slice(0, 200) }; }
            history.push({ side: s.side, kind: s.kind, via: s.kind === 'codex' ? 'codex' : s.via ?? 'routine', at: Date.now(), ok: r.ok, detail: r.detail });
            console.log(`CLOUD_LAUNCH ${s.side} ${r.ok ? 'started' : 'failed'}: ${r.detail}`);
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(stateFile, JSON.stringify({ launches: history.filter(l => now - l.at < 7 * 24 * 60 * 60_000) }, null, 1) + '\n');
    } catch (e) { console.log(`CLOUD_LAUNCH fail ${String(e).replace(/\s+/g, ' ').slice(0, 240)}`); process.exit(1); }
}
