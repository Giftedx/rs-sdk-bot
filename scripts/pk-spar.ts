// Spar: two of our own accounts fight each other in the Wilderness, each with scripts/pk.ts and its own profile. A
// profile is a named set of fight options, so a change to the fight loop is measured against an opponent that eats,
// prays, switches gear and uses its special. The score is for side A; the ladder (scripts/measure/pk-spar-ladder.ts)
// runs a challenger profile against a champion profile on several seeds.
// Practice only: openBot refuses a non-local server without DEMO_OK=1, and a spar kills one of the two accounts.
// Usage: bun scripts/pk-spar.ts <bot a> <bot b> [CAP ticks, default 900] [<bot a> <bot b> ...]; more pairs fight at
// the same time and the RESULT line counts them. Environment: SPAR_A and SPAR_B name a
// profile (default base); SPAR_A_OPTS and SPAR_B_OPTS add fight options as JSON, e.g. {"eatAt":60}; SPAR_KITS names
// the kit of each side of each pair (scripts/pk-kits.ts), e.g. tribrid:melee,tribrid:ranger; SPAR_B_PROFILES names the
// profile of side B of each pair; SPAR_SCENARIO
// names a scenario (default open). The start state of a scenario is its bench case (scripts/measure/aio-bench-cases.ts).
// Prints one `SPAR <json>` line. RESULT ok means that both sides attacked and the fight reached a kill, an escape or
// the cap.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import { defaultSpec, fightPlayer, nextTick, PRAYER, weaponStyle, type FightOptions, type FightResult, type Kit } from './pk';
import { TRIBRID_KIT } from './pk-hunt';
import { kitOptions, kitSwitches } from './pk-kits';

// `specBelow` moves the health fraction at which the kit's special fires.
export type Profile = Partial<Omit<FightOptions, 'log' | 'stop'>> & { specBelow?: number };
// The options that won the hill climb (scripts/measure/pk-spar-climb.ts writes the file).
export const CHAMPION: Profile = JSON.parse(readFileSync(resolve(import.meta.dir, 'pk-champion.json'), 'utf8'));
export const PROFILES: Readonly<Record<string, Profile>> = {
    base: {},
    champion: CHAMPION,
    freeze: { freeze: true },
    'freeze-flee': { freeze: 'flee' },
    // Keeps its special for a target at 40% health or one that has fled, and freezes a target that runs.
    hunter: { freeze: 'flee', specBelow: 0.4 },
    'hunter-low': { freeze: 'low', specBelow: 0.4 },
    // The bow burst from 60% health: bare of armour, magic shortbow specials with a dagger special between.
    // The special energy is kept for the burst: no melee special above 20% health outside it.
    burst: { bowBurst: 0.6, specBelow: 0.2 },
    flick: { prayerFlick: true },
    // Readers of the opponent, one at a time and together.
    predict: { predictPrayer: true },
    snap: { predictPrayer: true, snapPrayer: true },
    'snap-2': { predictPrayer: true, snapPrayer: true, snapLead: 2 },
    'snap-0': { predictPrayer: true, snapPrayer: true, snapLead: 0 },
    weak: { styleByArmour: true },
    mix: { mixStyles: true },
    adapt: { adapt: true },
    reader: { predictPrayer: true, styleByArmour: true, adapt: true },
    'reader-mix': { predictPrayer: true, mixStyles: true, adapt: true },
    'hunter-burst': { freeze: 'low', specBelow: 0.2, bowBurst: 0.6 },
    'no-read': { readOverheads: false },
    'no-spec': { spec: undefined },
    'spec-early': { specBelow: 0.8 },
    'spec-late': { specBelow: 0.35 },
    'spec-mid': { specBelow: 0.5 },
    'eat-40': { eatAt: 40 },
    'eat-65': { eatAt: 65 },
    'melee-first': { rotation: ['melee', 'ranged', 'magic'] },
    'ranged-melee': { rotation: ['ranged', 'melee'] },
    'magic-ranged': { rotation: ['magic', 'ranged'] },
    // The dagger gang on the kit ganker-dds (research/pvp-fight-loop.md, "Rivals: the dagger gang"): a special on each
    // attack from the first health bar while the energy lasts, whatever the target prays; a shark at 79 HP or less;
    // prayer points that drain; the protect prayer for the weapon of the opponent. `ganker-bare` is the same with no
    // protect prayer, as they hunt a target that does not hit back.
    ganker: { rotation: ['melee'], specBelow: 1, eatAt: 79, prayerFlick: false, readOverheads: false },
    'ganker-bare': { rotation: ['melee'], specBelow: 1, eatAt: 79, prayerFlick: false, readOverheads: false, overheadPrayer: false },
};
const GOD_HUNTER: Profile = { kit: { ...TRIBRID_KIT, magic: [2417] }, damageSpell: 1192, charge: true };
// Options a scenario gives a side under its profile. In `escape` side B is the runner: with its food gone at 60 HP or
// less it runs south and rubs its glory, and side A is the hunter that must kill it first.
export const SCENARIOS: Readonly<Record<string, { a?: Profile; b?: Profile }>> = {
    open: {},
    escape: { b: { escapeAt: 60 } },
    // The same chase with the sides turned: side A is the runner, so a climb tunes how our own account gets away.
    flee: { a: { escapeAt: 60 } },
    // The hunter casts Flames of Zamorak under Charge, with the Zamorak staff as its magic weapon (the start state
    // wears the Zamorak cape and has the Mage Arena done).
    'escape-god': { a: GOD_HUNTER, b: { escapeAt: 60 } },
    'escape-spell-god': { a: GOD_HUNTER, b: { escapeAt: 60, escapeSpell: 1164 } },
    // The runner has no glory: it runs to Wilderness level 20 and casts Varrock Teleport (scripts/pk.ts SPELLS).
    'escape-spell': { b: { escapeAt: 60, escapeSpell: 1164 } },
};

export function sparOptions(name: string, extraJson: string | undefined, kit: Kit, cap: number, scenario: Profile = {}): FightOptions {
    const profile = PROFILES[name];
    if (!profile) throw Error(`pk-spar: unknown profile "${name}"; known: ${Object.keys(PROFILES).join(', ')}`);
    const extra = extraJson ? JSON.parse(extraJson) as Profile : {};
    const { specBelow, ...options } = { ...scenario, ...profile, ...extra };
    const used = options.kit ?? kit;
    const merged: FightOptions = { spec: defaultSpec(used), cap, ...options, kit: used };
    if (specBelow !== undefined && merged.spec) merged.spec = { ...merged.spec, below: specBelow };
    return merged;
}

// `opening` is the ticks until the first damage on either side; `startGap` is the tiles between the two at the start.
export type SparResult = { winner: 'a' | 'b' | 'draw'; end: 'kill' | 'escape' | 'cap'; score: number; ticks: number; opening?: number | null; startGap?: number; a: FightResult; b: FightResult };
// The score of side A. A kill is 200 plus the damage margin, a death -200 plus the margin; the margin stays inside
// +-99, so a kill always scores above a draw and a draw above a death. An escape scores 100 for the side that got
// away and -100 for the other: between a draw and a kill. A draw scores the margin alone: a fight that reached the
// cap, or one that killed both. A side that lost sight of the other while it lived let it get away.
// The margin is the damage each side took: in a mirror spar `dealt` read 102 where the other side took 274.
export function sparScore(a: FightResult, b: FightResult): SparResult {
    const ticks = Math.max(a.ticks, b.ticks);
    const aWon = a.outcome === 'kill' || b.outcome === 'died', bWon = b.outcome === 'kill' || a.outcome === 'died';
    const margin = Math.max(-99, Math.min(99, b.taken - a.taken));
    if (aWon !== bWon) return { winner: aWon ? 'a' : 'b', end: 'kill', score: (aWon ? 200 : -200) + margin, ticks, a, b };
    const aFled = !aWon && (a.outcome === 'escaped' || b.outcome === 'lost'), bFled = !bWon && (b.outcome === 'escaped' || a.outcome === 'lost');
    if (aFled !== bFled) return { winner: aFled ? 'a' : 'b', end: 'escape', score: aFled ? 100 : -100, ticks, a, b };
    return { winner: 'draw', end: aWon ? 'kill' : 'cap', score: margin, ticks, a, b };
}
// A spar that measured something: both sides attacked, the fight ended in a kill, an escape or at the cap, and the two
// stood within sight of each other at the start (two escape-spell spars began with the sides 261 and 270 tiles apart).
export const sparValid = (r: SparResult) => [r.a, r.b].every(f => f.attacks.magic + f.attacks.ranged + f.attacks.melee > 0 && f.outcome !== 'session ended' && f.outcome !== 'danger')
    && (r.end !== 'cap' || (r.a.outcome === 'timeout' && r.b.outcome === 'timeout')) && (r.startGap === undefined || r.startGap <= 15);

export async function spar(a: Session, b: Session, optionsA: FightOptions, optionsB: FightOptions, log: (line: string) => void = l => console.log(l), halt: () => boolean = () => false): Promise<SparResult> {
    const self = (s: Session) => s.sdk.getState()?.player;
    // A new practice world refuses player attacks for its first 8 ticks ("I'm already under attack.", pvp_combat.rs2:110).
    for (let i = 0; i < 10; i++) if (!await nextTick(a)) break;
    const pa = self(a), pb = self(b), start = a.tick(), hp0 = [pa?.hp, pb?.hp];
    const startGap = pa && pb ? Math.max(Math.abs(pa.worldX - pb.worldX), Math.abs(pa.worldZ - pb.worldZ)) : undefined;
    let opening: number | null = null;
    // SPAR_TRACE=1 prints one line for each tick: where each side stands, its HP, its run energy, the style of its weapon
    // and its overhead prayer.
    const shows = (s: Session) => { const st = s.sdk.getState(), on = st?.prayers.activePrayers ?? [];
        return `w=${weaponStyle(st?.equipment.find(e => e.slot === 3)?.id)} p=${on[PRAYER.melee] ? 'melee' : on[PRAYER.missiles] ? 'ranged' : on[PRAYER.magic] ? 'magic' : 'none'}`; };
    const told = [0, 0];
    const trace = process.env.SPAR_TRACE === '1' ? a.onTick(() => { const x = self(a), y = self(b);
        [a, b].forEach((s, i) => { for (const m of s.sdk.getState()?.gameMessages ?? []) { const id = m.observationId ?? m.tick; if (id > told[i]! && m.tick >= start) { told[i] = id; log(`MSG ${s.name} ${m.text}`); } } });
        log(`TRACE ${a.name} ${a.tick() - start} a=${x?.worldX},${x?.worldZ} hp=${x?.hp} run=${x?.runEnergy} ${shows(a)} b=${y?.worldX},${y?.worldZ} hp=${y?.hp} run=${y?.runEnergy} ${shows(b)}`); }) : undefined;
    // The damage a side took is the sum of its HP drops from tick to tick. The fight loop's own count reads hit splats
    // from the client, and it sees about half of them.
    const lost = [0, 0], lastHp = [hp0[0] ?? 0, hp0[1] ?? 0];
    const unwatch = a.onTick(() => { [a, b].forEach((s, i) => { const hp = self(s)?.hp; if (hp === undefined) return; if (hp < lastHp[i]!) lost[i]! += lastHp[i]! - hp; lastHp[i] = hp; });
        if (opening === null && [a, b].some((s, i) => (self(s)?.hp ?? Infinity) < (hp0[i] ?? 0))) opening = a.tick() - start; });
    // The first side to end stops the other: a fight has one end.
    let over = false;
    const side = (s: Session, target: string, o: FightOptions) => fightPlayer(s, target, { ...o, stop: () => over || halt(), log: l => log(`[${s.name}] ${l}`) })
        .finally(() => { over = true; });
    const [ra, rb] = await Promise.all([side(a, b.name, optionsA), side(b, a.name, optionsB)]);
    ra.prayerLeft = a.sdk.getState()?.prayers.prayerPoints; rb.prayerLeft = b.sdk.getState()?.prayers.prayerPoints;
    unwatch(); trace?.();
    ra.taken = lost[0]!; rb.taken = lost[1]!;
    return { ...sparScore(ra, rb), opening, ...(startGap === undefined ? {} : { startGap }) };
}

// The result of several spars that ran at once, from the A sides: kills, deaths, the B sides that got away, and draws.
export function batchSummary(results: readonly SparResult[]) {
    const count = (f: (r: SparResult) => boolean) => results.filter(f).length;
    const mean = results.length ? Number((results.reduce((n, r) => n + r.score, 0) / results.length).toFixed(1)) : 0;
    return { fights: results.length, kills: count(r => r.winner === 'a' && r.end === 'kill'), deaths: count(r => r.winner === 'b' && r.end === 'kill'),
        escapes: count(r => r.winner === 'b' && r.end === 'escape'), fled: count(r => r.winner === 'a' && r.end === 'escape'), draws: count(r => r.winner === 'draw'),
        mean, ticks: Math.max(0, ...results.map(r => r.ticks)), scores: results.map(r => r.score), nets: results.map(netRate) };
}
// Net damage of side A for each 100 ticks of a spar: what side B took less what side A took. It moves with every hit,
// so it separates two profiles in fewer fights than a count of kills.
export const netRate = (r: SparResult) => Number((((r.b.taken - r.a.taken) * 100) / Math.max(1, r.ticks)).toFixed(1));
// A spar seen from the other side: for a pair that fought with the two profiles on swapped sides.
export function flipped(r: SparResult): SparResult {
    return { ...r, winner: r.winner === 'a' ? 'b' : r.winner === 'b' ? 'a' : 'draw', score: r.score === 0 ? 0 : -r.score, a: r.b, b: r.a };
}

if (import.meta.main) {
    const bootMs = Math.round(performance.now());
    const [botA, botB, capArg, ...more] = process.argv.slice(2), env = process.env;
    if (!botA || !botB || more.length % 2) { console.log('RESULT fail usage: bun scripts/pk-spar.ts <bot a> <bot b> [CAP ticks] [<bot a> <bot b> ...]'); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const cap = Number(env.SPAR_CAP ?? capArg ?? 900), nameA = env.SPAR_A ?? 'base', nameB = env.SPAR_B ?? 'base', scenarioName = env.SPAR_SCENARIO ?? 'open';
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) { console.log(`RESULT fail pk-spar: unknown scenario "${scenarioName}"; known: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2); }
    // The kit of a side belongs to its account (the bench case staged it); the profile of a side can swap.
    const kits = env.SPAR_KITS?.split(',').map(pair => pair.split(':'));
    const options = (profile: 'a' | 'b', pair: number, side: 0 | 1): FightOptions => {
        const kit = kits?.[pair % kits.length]?.[side];
        const base = { ...(kit ? kitOptions(kit) : {}), ...(side === 0 ? scenario.a : scenario.b) };
        // SPAR_B_PROFILES gives side B of each pair its own profile: a league of opponents that each play their own way.
        const league = env.SPAR_B_PROFILES?.split(',');
        const name = profile === 'a' ? nameA : league?.[pair % league.length] ?? nameB;
        // A random style choice (mixStyles) repeats with the bench seed: the seed, the pair and the side make its seed.
        const seed = env.BENCH_SEED === undefined ? {} : { mixSeed: Number(env.BENCH_SEED) * 1000 + pair * 2 + side };
        return { ...sparOptions(name, profile === 'a' ? env.SPAR_A_OPTS : env.SPAR_B_OPTS, kit ? kitSwitches(kit) : TRIBRID_KIT, cap, base), ...seed };
    };
    // A death is the expected end of a spar, so it must not end the run as openBot does by default. Any other stop
    // (a stop file, a stalled tick stream) halts every side and fails the run.
    let halted: string | undefined;
    const onStop = async (_s: unknown, reason: string) => { if (reason !== 'died') halted ??= reason; };
    // More pairs after the cap fight at the same time in the same world: each pair is one more sample for the cost of
    // the same game ticks. A player does not block a tile, and a fight loop names its one target, so pairs share a spot.
    const t0 = Date.now();
    const names: [string, string][] = [[botA, botB]];
    for (let i = 0; i < more.length; i += 2) names.push([more[i]!, more[i + 1]!]);
    // SPAR_PROCS=n: the pairs of a batch run in n worker processes on the one engine. The clients of one process share
    // one thread, and with 16 of them each tick waits about 50 ms for the last one. A child takes its share of the
    // pairs and their place in the batch (SPAR_PAIR_OFFSET), so kits, swapped sides and seeds stay as in one process.
    const procs = Math.min(names.length, Math.max(1, Number(env.SPAR_PROCS ?? 1)));
    if (procs > 1 && env.SPAR_CHILD !== '1') {
        const size = Math.ceil(names.length / procs), children: { out: Promise<string>; exited: Promise<number> }[] = [];
        for (let at = 0; at < names.length; at += size) {
            const child = Bun.spawn(['bun', import.meta.path, ...names.slice(at, at + size).flat().flatMap((n, i) => (i === 2 ? [String(cap), n] : [n]))],
                { env: { ...env, SPAR_CHILD: '1', SPAR_PAIR_OFFSET: String(at), SPAR_CAP: String(cap) }, stdout: 'pipe', stderr: 'inherit', windowsHide: true });
            children.push({ out: new Response(child.stdout).text(), exited: child.exited });
        }
        const outs = await Promise.all(children.map(c => c.out)), codes = await Promise.all(children.map(c => c.exited));
        const results: SparResult[] = [];
        for (const out of outs) for (const line of out.split(/\r?\n/)) {
            if (line.startsWith('SPAR {')) results.push(JSON.parse(line.slice(5)) as SparResult);
            // One RESULT line for the batch: the parent writes it.
            if (line && !line.startsWith('RESULT ')) console.log(line);
        }
        const s = batchSummary(results), ok = results.length === names.length && results.every(sparValid) && codes.every(code => code === 0);
        console.log(`SPAR_TIMING procs=${procs} wallMs=${Date.now() - t0} pairs=${results.length} ticks=${s.ticks}`);
        console.log(`RESULT ${ok ? 'ok' : 'fail'} spar-batch fights=${s.fights} kills=${s.kills} deaths=${s.deaths} escapes=${s.escapes} fled=${s.fled} draws=${s.draws} mean=${s.mean} ticks=${s.ticks} a=${nameA} b=${nameB} `
            + `valid=${results.filter(sparValid).length} nets=${s.nets.join(',')} scores=${s.scores.join(',')}`);
        process.exit(ok ? 0 : 1);
    }
    const offset = Number(env.SPAR_PAIR_OFFSET ?? 0);
    // Every account logs in at the same time, and the wait for the logins counts as a tick wait: an account that is
    // in has no waiter until the fights start, and a lockstep world then holds each tick for the busy limit (2 s).
    const { tickWaits } = await import('../packages/core/src/tick-stream');
    tickWaits.active++;
    // The account of the run logs in first: the bench checks the first START line against that account's start tile.
    const tFirst0 = Date.now();
    const first = env.SPAR_LOGIN === 'b' ? null as unknown as Session : await openBot(botA, { onStop });
    const firstMs = Date.now() - tFirst0;
    const pairs: [Session, Session][] = await Promise.all(names.map(async ([x, y], i): Promise<[Session, Session]> => {
        // SPAR_LOGIN=b logs side B in before side A (after the first account, which the bench needs first): the engine
        // gives the earlier login the lower player index, and it acts on that player first in each tick.
        const order = env.SPAR_LOGIN === 'b';
        const b0 = order ? await openBot(y, { onStop }) : null;
        const a = i === 0 && first ? first : await openBot(x, { onStop });
        const b = b0 ?? await openBot(y, { onStop });
        // The fight loop sends its actions by index and reads no `reachable` flag; the flood fill behind that flag
        // was 9% of a 16-account run.
        for (const s of [a, b]) (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
        // The fight loop reads no loc and no ground item, and their scan is part of the state of every tick.
        // SPAR_FULL_STATE=1 keeps them.
        if (env.SPAR_FULL_STATE !== '1') for (const s of [a, b]) {
            const collector = (s.client as { collector?: Record<string, unknown> } | undefined)?.collector;
            if (collector && typeof collector.collectNearbyLocs === 'function') { collector.collectNearbyLocs = () => []; collector.collectGroundItems = () => []; }
        }
        return [a, b];
    })).finally(() => { tickWaits.active--; });
    const t1 = Date.now();
    // SPAR_SWAP=1: every second pair fights with the two profiles on swapped sides, and its result is turned back, so
    // side A in the results is always the profile SPAR_A and the side of the map has no part in the comparison.
    const swap = env.SPAR_SWAP === '1';
    // The place of a pair in the batch has a part of its own: with the same profile on both sides, side B won 11 of 16
    // even pairs and side A won 12 of 16 odd pairs. So the swap goes by two pairs at a time (pairs 2, 3, 6, 7, ...):
    // each profile then has side A of an even pair as often as side A of an odd pair.
    const results = await Promise.all(pairs.map(async ([a, b], j) => { const i = j + offset; return (swap && (i >> 1) % 2
        ? flipped(await spar(a, b, options('b', i, 0), options('a', i, 1), undefined, () => halted !== undefined))
        : spar(a, b, options('a', i, 0), options('b', i, 1), undefined, () => halted !== undefined)); }));
    // Where the wall time of the run went: the logins, then the fights.
    console.log(`SPAR_TIMING bootMs=${bootMs} firstLoginMs=${firstMs} loginMs=${t1 - t0} fightMs=${Date.now() - t1} pairs=${pairs.length} ticks=${Math.max(...results.map(r => r.ticks))}`);
    for (const r of results) console.log(`SPAR ${JSON.stringify({ scenario: scenarioName, profiles: { a: nameA, b: nameB }, ...r })}`);
    const ok = results.every(sparValid) && halted === undefined, sessions = pairs.flat(), r = results[0]!;
    if (results.length > 1) {
        const s = batchSummary(results);
        await finish(sessions, ok, `spar-batch fights=${s.fights} kills=${s.kills} deaths=${s.deaths} escapes=${s.escapes} fled=${s.fled} draws=${s.draws} mean=${s.mean} ticks=${s.ticks} a=${nameA} b=${nameB} `
            + `valid=${results.filter(sparValid).length} nets=${s.nets.join(',')} scores=${s.scores.join(',')}${halted ? ` halted=${halted}` : ''}`);
    }
    await finish(sessions, ok, `spar winner=${r.winner} score=${r.score} ticks=${r.ticks} end=${r.end} opening=${r.opening} gap=${r.startGap} a=${nameA} b=${nameB} `
        + `aOutcome=${r.a.outcome} bOutcome=${r.b.outcome} aTaken=${r.a.taken} bTaken=${r.b.taken} aEaten=${r.a.eaten} bEaten=${r.b.eaten} aSpecs=${r.a.specs} bSpecs=${r.b.specs}${halted ? ` halted=${halted}` : ''}`);
}
