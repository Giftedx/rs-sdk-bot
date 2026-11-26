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
//   --ab <ref>  each step runs two times in turn: with the code of <ref> (`before`) and with the code of HEAD
//           (`after`), so both sides run on one machine at one time. <ref> must hold this script. Each side is a git
//           worktree in one temporary folder that links node_modules, vendor/rs-sdk and .practice/cache of this checkout.
// The trip default is the slow live search of a strong account from Ardougne North to Varrock West.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
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

const here = resolve(import.meta.dir, '..', '..');
// `root`: the checkout whose code runs the search (this one, or the --ab checkout).
function run(spec: Spec, root = here): Result {
    const p = spawnSync('bun', [join(root, 'scripts', 'measure', 'route-leg-share.ts'), '--child', JSON.stringify(spec)], {cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20});
    const line = (p.stdout ?? '').split(/\r?\n/).find(l => l.startsWith('CHILD '));
    if (p.status !== 0 || !line) throw Error(`route-leg-share: a search process failed (exit ${p.status}): ${(p.stderr || p.stdout || '').trim().split('\n').at(-1)}`);
    return JSON.parse(line.slice(6));
}
const show = (r: Result) => `ms=${r.ms} ok=${r.ok} cost=${r.cost} plan=${r.plan} measured=${r.measured} nulls=${r.nulls} grid=${r.grid} hits=${r.hits}`;
const git = (args: string[], cwd = here) => {
    const p = spawnSync('git', args, {cwd, encoding: 'utf8', windowsHide: true});
    if (p.status !== 0) throw Error(`route-leg-share: git ${args.join(' ')}: ${(p.stderr || '').trim()}`);
    return p.stdout.trim();
};
// A checkout of `ref` at `at` that uses the installs and caches of this checkout through links.
const LINKS = ['node_modules', join('vendor', 'rs-sdk'), join('.practice', 'cache')];
function checkoutOf(ref: string, at: string): string {
    let commit: string;
    try { commit = git(['rev-parse', '--verify', `${ref}^{commit}`]); } catch { git(['fetch', '--quiet', '--depth', '1', 'origin', ref]); commit = git(['rev-parse', 'FETCH_HEAD']); }
    git(['worktree', 'add', '--detach', '--quiet', at, commit]);
    mkdirSync(join(here, '.practice', 'cache'), {recursive: true});
    for (const link of LINKS) {
        // The new checkout holds at most an empty folder for the submodule here.
        rmSync(join(at, link), {recursive: true, force: true});
        mkdirSync(dirname(join(at, link)), {recursive: true});
        symlinkSync(join(here, link), join(at, link), 'junction');
    }
    if (!existsSync(join(at, 'scripts', 'measure', 'route-leg-share.ts'))) throw Error(`route-leg-share: ${ref} has no scripts/measure/route-leg-share.ts`);
    return commit;
}
// Removes the links first (unlinkSync removes a link or a Windows junction and keeps its target), so that no removal
// below can reach the folders of this checkout. Returns false when a link stays.
function unlinkAll(at: string): boolean {
    for (const link of LINKS) {
        const p = join(at, link);
        try { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); } catch { /* not made */ }
        try { if (lstatSync(p).isSymbolicLink()) return false; } catch { /* gone */ }
    }
    return true;
}

if (import.meta.main) {
    const c = process.argv.indexOf('--child');
    if (c >= 0) { await child(JSON.parse(process.argv[c + 1]!)); process.exit(0); }
    const kind = arg('--case', 'cold'), runs = Number(arg('--runs', '3')), from = arg('--from', '2618,3332'), to = arg('--to', '3185,3436');
    const budgetMs = Number(arg('--budget-ms', '300000')), name = kind === 'second' ? arg('--second', 'keyed') : 'first', ab = arg('--ab', '');
    const acct = kind === 'second' ? seconds[name] : first;
    if (!['cold', 'warm', 'second'].includes(kind) || !acct || !(runs >= 1)) { console.error('usage: --case cold|warm|second --second keyed|skilled|weak --runs N [--ab <ref>]'); process.exit(2); }
    const dir = mkdtempSync(join(tmpdir(), 'route-leg-share-')), trees = ab ? [join(dir, 'before'), join(dir, 'after')] : [];
    let different = 0;
    try {
        const sides: {side: string; root: string}[] = [{side: 'after', root: here}];
        if (ab) {
            // Both sides are new checkouts of one kind in one folder, so neither has warm files the other lacks.
            console.log(`BEFORE ${ab} = ${checkoutOf(ab, trees[0]!)}; AFTER HEAD = ${checkoutOf('HEAD', trees[1]!)}`);
            sides.splice(0, 1, {side: 'before', root: trees[0]!}, {side: 'after', root: trees[1]!});
        }
        const filled = new Map<string, string>(), reference = new Map<string, string>(), times = new Map<string, number[]>();
        for (const {side, root} of sides) {
            times.set(side, []);
            if (kind !== 'cold') {
                filled.set(side, join(dir, `${side}-first.sqlite`));
                console.log(`FILL side=${side} account=first ${show(run({store: filled.get(side)!, acct: first, from, to, budgetMs}, root))}`);
            }
            if (kind === 'second') {
                const r = run({store: join(dir, `${side}-reference.sqlite`), acct, from, to, budgetMs}, root);
                reference.set(side, r.plan);
                console.log(`REFERENCE side=${side} account=${name} empty store ${show(r)}`);
            }
        }
        // The sides take turns, so a slow minute of the machine falls on both.
        for (let i = 1; i <= runs; i++) for (const {side, root} of sides) {
            const store = join(dir, `${side}-run${i}.sqlite`), fill = filled.get(side), want = reference.get(side);
            if (fill) { const db = new Database(fill, {readonly: true}); try { db.query('VACUUM INTO ?').run(store); } finally { db.close(); } }
            const r = run({store, acct, from, to, budgetMs}, root);
            times.get(side)!.push(r.ms);
            const same = !want || r.plan === want;
            if (!same) different++;
            console.log(`RUN side=${side} case=${kind} account=${name} run=${i} ${show(r)}${want ? ` plan=${same ? 'equal' : 'DIFFERENT'}` : ''}`);
        }
        for (const {side} of sides) console.log(`RESULT route-leg-share side=${side} case=${kind} account=${name} trip=${from}->${to} runs=${runs} ms=[${times.get(side)!.join(', ')}]${reference.size ? ` different=${different}` : ''}`);
    } finally {
        const kept = trees.filter(t => existsSync(t) && !unlinkAll(t));
        if (kept.length) console.error(`route-leg-share: a link stays in ${kept.join(', ')}; the folder ${dir} is kept`);
        else {
            for (const t of trees) if (existsSync(t)) try { git(['worktree', 'remove', '--force', t]); } catch { /* the folder goes below */ }
            rmSync(dir, {recursive: true, force: true});
            if (ab) try { git(['worktree', 'prune']); } catch { /* nothing to prune */ }
        }
    }
    process.exit(different ? 1 : 0);
}
