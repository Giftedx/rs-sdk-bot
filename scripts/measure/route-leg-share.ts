// Time of one route search with an empty walk-length store (cold), with the store the same account filled (warm) and
// with the store another account filled (second): how much a second account with other shut doors reuses of the
// first account's measured legs (leg-cache.ts). Each search runs in its own process on its own store, so nothing
// measured in an earlier run is in memory.
// Usage: bun scripts/measure/route-leg-share.ts [--case cold|warm|second] [--second keyed|skilled|weak] [--runs 3]
//            [--from 2618,3332] [--to 3185,3436] [--budget-ms 300000]
//   cold    each run: account `first` searches the trip on an empty store
//   warm    one search of `first` fills a store; each run: `first` searches the trip again on a copy of it
//   second  one search of `first` fills a store; each run: account `--second` searches the trip on a copy of it. One
//           more search of `--second` on an empty store gives the plan that each run must equal (`plan=equal`).
// The trip default is the slow live search of a strong account from Ardougne North to Varrock West.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Database} from 'bun:sqlite';

type Acct = {skills: Record<string, number>; varps: Record<string, number>; items: string[]; coins: number; worn?: string[]};
const first: Acct = {skills: {hitpoints: 99, attack: 60, strength: 60, defence: 60, ranged: 50, magic: 50, prayer: 43}, varps: {}, items: [], coins: 60};
// The second accounts: `keyed` has three doors near Varrock West open (knowledge/doors.json: 32 quest points at
// 3191,3363, Black Arm Gang at 3185,3388, the Edgeville dungeon key at 3115,3450); `skilled` has the levels and the
// worn items of skill doors (for example the Crafting Guild at 2933,3289) and the agility of more shortcuts; `weak`
// has 10 hitpoints, so the danger rule closes the ground of more monsters.
const seconds: Record<string, Acct> = {
    keyed: {...first, varps: {qp: 32, blackarmgang: 3}, items: ['edgevilledungeonkey']},
    skilled: {...first, skills: {...first.skills, agility: 70, crafting: 60, cooking: 40, thieving: 60, mining: 60, woodcutting: 60, fishing: 60, smithing: 60}, worn: ['brown_apron', 'chefs_hat']},
    weak: {...first, skills: {hitpoints: 10, attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1, prayer: 1}},
};
type Spec = {store: string; acct: Acct; from: string; to: string; budgetMs: number};
type Result = {ms: number; ok: boolean; cost: number | string; plan: string; measured: number; nulls: number; grid: number; hits: number};
const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : d; };
const tile = (s: string) => { const [x, z] = s.split(',').map(Number); return {x: x!, z: z!, level: 0}; };

async function child(spec: Spec) {
    const {loadPathfinding} = await import('../../packages/core/src/pathcache');
    const {createWorld, rsPathLength} = await import('../../packages/core/src/world');
    const {legCache} = await import('../../packages/core/src/leg-cache');
    await loadPathfinding();
    const legs = legCache(spec.store, 'route-leg-share');
    let measured = 0, hits = 0, nulls = 0, grid = 0;
    // A row a search writes for a leg it measured; `|h` rows only name the lengths of a leg, and `|w|` rows hold a
    // result that read the whole findLongPath grid (world/leg-key.ts).
    const counted = {...legs, set: (k: string, v: number | null) => { if (!k.endsWith('|h')) { measured++; if (v === null) nulls++; if (k.includes('|w|')) grid++; } legs.set(k, v); },
        get: (k: string) => { const v = legs.get(k); if (v !== undefined && !k.endsWith('|h')) hits++; return v; }};
    const w = createWorld({pathLength: await rsPathLength({legs: counted})});
    const t = performance.now();
    const r = w.route(tile(spec.from), tile(spec.to), spec.acct as any, {deadline: performance.now() + spec.budgetMs});
    const ms = Math.round(performance.now() - t);
    legs.save(); legs.close();
    const plan = createHash('sha1').update(JSON.stringify(r)).digest('hex').slice(0, 12);
    console.log('CHILD ' + JSON.stringify({ms, ok: r.ok, cost: r.ok ? r.cost : r.reason, plan, measured, nulls, grid, hits}));
}

function run(spec: Spec): Result {
    const p = spawnSync('bun', [import.meta.path, '--child', JSON.stringify(spec)], {cwd: resolve(import.meta.dir, '..', '..'), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20});
    const line = (p.stdout ?? '').split(/\r?\n/).find(l => l.startsWith('CHILD '));
    if (p.status !== 0 || !line) throw Error(`route-leg-share: a search process failed (exit ${p.status}): ${(p.stderr || p.stdout || '').trim().split('\n').at(-1)}`);
    return JSON.parse(line.slice(6));
}
const show = (r: Result) => `ms=${r.ms} ok=${r.ok} cost=${r.cost} plan=${r.plan} measured=${r.measured} nulls=${r.nulls} grid=${r.grid} hits=${r.hits}`;

if (import.meta.main) {
    const c = process.argv.indexOf('--child');
    if (c >= 0) { await child(JSON.parse(process.argv[c + 1]!)); process.exit(0); }
    const kind = arg('--case', 'cold'), runs = Number(arg('--runs', '3')), from = arg('--from', '2618,3332'), to = arg('--to', '3185,3436');
    const budgetMs = Number(arg('--budget-ms', '300000')), name = kind === 'second' ? arg('--second', 'keyed') : 'first';
    const acct = kind === 'second' ? seconds[name] : first;
    if (!['cold', 'warm', 'second'].includes(kind) || !acct || !(runs >= 1)) { console.error('usage: --case cold|warm|second --second keyed|skilled|weak --runs N'); process.exit(2); }
    const dir = mkdtempSync(join(tmpdir(), 'route-leg-share-')), times: number[] = [];
    let different = 0;
    try {
        let filled = '', reference = '';
        if (kind !== 'cold') {
            filled = join(dir, 'first.sqlite');
            console.log(`FILL account=first ${show(run({store: filled, acct: first, from, to, budgetMs}))}`);
        }
        if (kind === 'second') {
            const r = run({store: join(dir, 'reference.sqlite'), acct, from, to, budgetMs});
            reference = r.plan;
            console.log(`REFERENCE account=${name} empty store ${show(r)}`);
        }
        for (let i = 1; i <= runs; i++) {
            const store = join(dir, `run${i}.sqlite`);
            if (filled) { const db = new Database(filled, {readonly: true}); try { db.query('VACUUM INTO ?').run(store); } finally { db.close(); } }
            const r = run({store, acct, from, to, budgetMs});
            times.push(r.ms);
            const same = !reference || r.plan === reference;
            if (!same) different++;
            console.log(`RUN case=${kind} account=${name} run=${i} ${show(r)}${reference ? ` plan=${same ? 'equal' : 'DIFFERENT'}` : ''}`);
        }
        console.log(`RESULT route-leg-share case=${kind} account=${name} trip=${from}->${to} runs=${runs} ms=[${times.join(', ')}]${reference ? ` different=${different}` : ''}`);
    } finally { rmSync(dir, {recursive: true, force: true}); }
    process.exit(different ? 1 : 0);
}
