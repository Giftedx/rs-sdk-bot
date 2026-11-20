// Multi-candidate A/B sweep runner for scripts/pk-squad.ts via GitHub Actions (scripts/hosted-bench.ts).
// Dispatches each candidate in parallel (automatically encoding JSON/complex env values with --set-b64), collects
// artifacts from .practice/hosted-bench/<runId>/, and prints a ranked markdown comparison table.
//
// Usage:
//   bun scripts/measure/pk-squad-sweep.ts --pattern '^extra:clone-squad-4-chainbind-x1$' --seeds 1,2,3,4 \
//     --candidate 'baseline' \
//     --candidate 'combo:{"SQUAD_OPTS":{"comboFood":true,"cureNow":true}}' \
//     --candidate 'entangle:SPEAR_LOCK=1 SQUAD_OPTS={"freeze":true,"freezeMagicCap":99}'
//   bun scripts/measure/pk-squad-sweep.ts --candidates sweep.json --pattern '...' [--seeds 1,2,3,4] [--profile] [--dry]
//   bun scripts/measure/pk-squad-sweep.ts --from-runs 'baseline=44831365850,combo=44831999999'
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkArgs } from '../hosted-bench';
import { readRichRows, returnTicks, richRow, type RichRow, type RichRun } from './pk-gang-climb';

export type SweepCandidate = {
    name: string;
    env: Record<string, string>;
};

export type SweepRow = {
    candidate: string;
    runId: string;
    row: RichRow;
};

const SAFE_SET_VAL = /^[\w.,:+@\/-]*$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Normalizes candidate env map entries (objects/booleans/numbers stringify cleanly) and validates key names. */
export function normalizeEnvMap(raw: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!ENV_KEY.test(k)) throw new Error(`invalid env key ${k}`);
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
}

/** Parses one --candidate spec (`name`, `name:KEY=VAL ...`, or `name:{...json...}`). */
export function parseCandidateSpec(spec: string): SweepCandidate {
    const colon = spec.indexOf(':');
    const name = (colon < 0 ? spec : spec.slice(0, colon)).trim();
    if (!name) throw new Error(`candidate needs a name, got ${spec}`);
    const rest = colon < 0 ? '' : spec.slice(colon + 1).trim();
    if (!rest) return { name, env: {} };
    if (rest.startsWith('{')) {
        const parsed = JSON.parse(rest) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`candidate ${name} JSON must be an object`);
        }
        return { name, env: normalizeEnvMap(parsed as Record<string, unknown>) };
    }
    const env: Record<string, string> = {};
    // Split on whitespace only before the next KEY= token so JSON values without internal spaces (or quoted strings) stay intact.
    for (const token of rest.split(/\s+(?=[A-Z][A-Z0-9_]*=)/).filter(Boolean)) {
        const eq = token.indexOf('=');
        if (eq < 1) throw new Error(`candidate ${name} token must be KEY=VALUE, got ${token}`);
        const key = token.slice(0, eq);
        if (!ENV_KEY.test(key)) throw new Error(`candidate ${name} has invalid env key ${key}`);
        env[key] = token.slice(eq + 1);
    }
    return { name, env };
}

/** Parses a JSON candidates file ([{ name, env }, ...]). */
export function parseCandidatesFile(text: string): SweepCandidate[] {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data) || !data.length) throw new Error('candidates JSON must be a non-empty array');
    return data.map((entry, idx) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`candidate[${idx}] must be an object`);
        const obj = entry as { name?: unknown; env?: unknown };
        if (typeof obj.name !== 'string' || !obj.name.trim()) throw new Error(`candidate[${idx}] missing name`);
        const env = obj.env === undefined ? {} : normalizeEnvMap(obj.env as Record<string, unknown>);
        return { name: obj.name.trim(), env };
    });
}

/** Builds `--args` string for hosted-bench.ts using `--set` for plain tokens and `--set-b64` for JSON/complex values. */
export function encodeHostedArgs(env: Record<string, string>, extraFlags: readonly string[] = []): string {
    const tokens: string[] = [...extraFlags];
    for (const [k, v] of Object.entries(env)) {
        if (!ENV_KEY.test(k)) throw new Error(`invalid env key ${k}`);
        if (SAFE_SET_VAL.test(v)) tokens.push('--set', `${k}=${v}`);
        else tokens.push('--set-b64', `${k}=${Buffer.from(v, 'utf8').toString('base64')}`);
    }
    const joined = tokens.join(' ');
    checkArgs(joined);
    return joined;
}

/** Aggregates all condition rows in a hosted-bench directory into one summary RichRow for a candidate. */
export function summarizeCandidateDir(candidate: string, dir: string, gangSize = 3): RichRow {
    const rows = readRichRows(dir, gangSize);
    const runs: RichRun[] = rows.flatMap(r => r.runs as RichRun[]);
    const condition = rows.length === 1 ? rows[0]!.condition : `${rows.length} cases`;
    return richRow(candidate, condition, runs, returnTicks(), gangSize);
}

/** Ranks candidates with 0-death hard invariant first, then kills, kills/hr, HP/kill, safety margin, and supplies/kill. */
export function rankSweepRows(rows: readonly SweepRow[]): SweepRow[] {
    const numAsc = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
    const numDesc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity);
    return [...rows].sort((a, b) => {
        const ra = a.row, rb = b.row;
        const deadA = ra.deaths > 0 ? 1 : 0, deadB = rb.deaths > 0 ? 1 : 0;
        if (deadA !== deadB) return deadA - deadB;
        if (ra.deaths !== rb.deaths) return ra.deaths - rb.deaths;
        if (ra.kills !== rb.kills) return rb.kills - ra.kills;
        const kh = numDesc(ra.killsAnHour, rb.killsAnHour);
        if (kh !== 0) return kh;
        const hp = numAsc(ra.hpAKill, rb.hpAKill);
        if (hp !== 0) return hp;
        const mh = numDesc(ra.minHp, rb.minHp);
        if (mh !== 0) return mh;
        const sup = numAsc(ra.suppliesPerKill, rb.suppliesPerKill);
        if (sup !== 0) return sup;
        const tk = numAsc(ra.ticksPerKill, rb.ticksPerKill);
        if (tk !== 0) return tk;
        return a.candidate.localeCompare(b.candidate);
    });
}

/** Formats ranked sweep rows as a markdown table matching the squad sweep metrics contract. */
export function formatSweepTable(rows: readonly SweepRow[]): string {
    const ranked = rankSweepRows(rows);
    const lines = [
        '| Rank | Candidate | Kills | Deaths | HP/kill | Ticks/kill | Kills/hr | Freeze% | MinHP | Supplies/kill | Run |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const [i, item] of ranked.entries()) {
        const r = item.row;
        lines.push(
            `| ${i + 1} | \`${item.candidate}\` | ${r.kills} of ${r.gang} | ${r.deaths} | ${r.hpAKill ?? '-'} | ${r.ticksPerKill ?? '-'} | ${r.killsAnHour ?? '-'} | ${r.freezePct === null ? '-' : `${r.freezePct}%`} | ${r.minHp ?? '-'} | ${r.suppliesPerKill ?? '-'} | ${item.runId} |`,
        );
    }
    return lines.join('\n');
}

async function runHostedCandidate(
    root: string,
    candidate: SweepCandidate,
    pattern: string,
    seeds: string,
    extraFlags: readonly string[],
    ref: string,
    workflowRef: string,
): Promise<{ candidate: string; runId: string; ok: boolean }> {
    const hostedArgs = encodeHostedArgs(candidate.env, extraFlags);
    const cmd = ['bun', 'scripts/hosted-bench.ts', pattern, '--seeds', seeds, '--ref', ref, '--workflow-ref', workflowRef];
    if (hostedArgs) cmd.push('--args', hostedArgs);
    const proc = Bun.spawn(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const combined = out + '\n' + err;
    const m = /hosted-bench: run (\d+)/.exec(combined);
    if (!m) throw new Error(`candidate ${candidate.name} failed to start or locate run id (exit ${code}): ${combined.trim().slice(-400)}`);
    return { candidate: candidate.name, runId: m[1]!, ok: code === 0 };
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..', '..');
    const argv = process.argv.slice(2);
    const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
    const values = (flag: string) => { const out: string[] = []; for (;;) { const i = argv.indexOf(flag); if (i < 0) break; const v = argv.splice(i, 2)[1]; if (v !== undefined) out.push(v); } return out; };
    const has = (flag: string) => { const i = argv.indexOf(flag); if (i < 0) return false; argv.splice(i, 1); return true; };

    const fromRuns = value('--from-runs');
    const gangSize = Number(value('--gang-size') ?? 3);
    if (!(gangSize > 0)) throw new Error(`--gang-size must be positive, got ${gangSize}`);

    if (fromRuns) {
        const sweepRows: SweepRow[] = fromRuns.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
            const eq = entry.indexOf('=');
            if (eq < 1) throw new Error(`--from-runs expects name=runIdOrPath, got ${entry}`);
            const candidate = entry.slice(0, eq).trim(), target = entry.slice(eq + 1).trim();
            const dir = existsSync(target) ? resolve(target) : join(root, '.practice', 'hosted-bench', target);
            if (!existsSync(dir)) throw new Error(`run directory not found: ${dir}`);
            return { candidate, runId: target, row: summarizeCandidateDir(candidate, dir, gangSize) };
        });
        console.log(formatSweepTable(sweepRows));
        process.exit(0);
    }

    const pattern = value('--pattern') ?? '';
    const seeds = value('--seeds') ?? '1,2,3,4';
    const candidatesFile = value('--candidates');
    const candidateSpecs = values('--candidate');
    const dry = has('--dry');
    const profile = has('--profile');
    const noKeep = has('--no-keep');
    const branch = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'pipe', windowsHide: true }).stdout.toString().trim();
    const ref = value('--ref') ?? branch;
    const workflowRef = value('--workflow-ref') ?? 'master';

    const candidates: SweepCandidate[] = [
        ...(candidatesFile ? parseCandidatesFile(readFileSync(resolve(root, candidatesFile), 'utf8')) : []),
        ...candidateSpecs.map(parseCandidateSpec),
    ];
    if (!pattern || !candidates.length || argv.length) {
        console.error("usage: bun scripts/measure/pk-squad-sweep.ts --pattern '<regex>' [--seeds 1,2,3,4] (--candidate '<name>:<env>' | --candidates <file.json>) [--ref <branch>] [--workflow-ref <branch>] [--profile] [--no-keep] [--gang-size 3] [--dry] | --from-runs 'a=123,b=456'");
        process.exit(2);
    }

    const extraFlags = [...(profile ? ['--profile'] : []), ...(noKeep ? ['--no-keep'] : [])];
    if (dry) {
        for (const c of candidates) {
            const args = encodeHostedArgs(c.env, extraFlags);
            console.log(`${c.name}\tpattern=${pattern}\tseeds=${seeds}\targs=${args || '(none)'}\tenv=${JSON.stringify(c.env)}`);
        }
        process.exit(0);
    }

    const dispatched = await Promise.all(candidates.map(c => runHostedCandidate(root, c, pattern, seeds, extraFlags, ref, workflowRef)));
    const sweepRows: SweepRow[] = dispatched.map(d => ({
        candidate: d.candidate,
        runId: d.runId,
        row: summarizeCandidateDir(d.candidate, join(root, '.practice', 'hosted-bench', d.runId), gangSize),
    }));
    console.log(formatSweepTable(sweepRows));
    const best = rankSweepRows(sweepRows)[0];
    if (best) console.log(`\nwinner: ${best.candidate} (deaths=${best.row.deaths}, kills=${best.row.kills}/${best.row.gang}, hp/kill=${best.row.hpAKill ?? '-'}, kills/hr=${best.row.killsAnHour ?? '-'})`);
}
