// Spar: two of our own accounts fight each other in the Wilderness, each with scripts/pk.ts and its own profile. A
// profile is a named set of fight options, so a change to the fight loop is measured against an opponent that eats,
// prays, switches gear and uses its special. The score is for side A; the ladder (scripts/measure/pk-spar-ladder.ts)
// runs a challenger profile against a champion profile on several seeds.
// Practice only: openBot refuses a non-local server without DEMO_OK=1, and a spar kills one of the two accounts.
// Usage: bun scripts/pk-spar.ts <bot a> <bot b> [CAP ticks, default 900] [<bot a> <bot b> ...]; more pairs fight at
// the same time and the RESULT line counts them. Environment: SPAR_A and SPAR_B name a
// profile (default base); SPAR_A_OPTS and SPAR_B_OPTS add fight options as JSON, e.g. {"eatAt":60}; SPAR_SCENARIO
// names a scenario (default open). The start state of a scenario is its bench case (scripts/measure/aio-bench-cases.ts).
// Prints one `SPAR <json>` line. RESULT ok means that both sides attacked and the fight reached a kill, an escape or
// the cap.
import type { Session } from '../packages/core/src/inprocess';
import { defaultSpec, fightPlayer, nextTick, type FightOptions, type FightResult, type Kit } from './pk';
import { TRIBRID_KIT } from './pk-hunt';

// `specBelow` moves the health fraction at which the kit's special fires.
export type Profile = Partial<Omit<FightOptions, 'log' | 'stop'>> & { specBelow?: number };
export const PROFILES: Readonly<Record<string, Profile>> = {
    base: {},
    freeze: { freeze: true },
    'freeze-flee': { freeze: 'flee' },
    // Keeps its special for a target at 40% health or one that has fled, and freezes a target that runs.
    hunter: { freeze: 'flee', specBelow: 0.4 },
    'hunter-low': { freeze: 'low', specBelow: 0.4 },
    'no-read': { readOverheads: false },
    'no-spec': { spec: undefined },
    'spec-early': { specBelow: 0.8 },
    'spec-late': { specBelow: 0.35 },
    'eat-40': { eatAt: 40 },
    'eat-65': { eatAt: 65 },
    'melee-first': { rotation: ['melee', 'ranged', 'magic'] },
    'ranged-melee': { rotation: ['ranged', 'melee'] },
    'magic-ranged': { rotation: ['magic', 'ranged'] },
};
const GOD_HUNTER: Profile = { kit: { ...TRIBRID_KIT, magic: [2417] }, damageSpell: 1192, charge: true };
// Options a scenario gives a side under its profile. In `escape` side B is the runner: with its food gone at 60 HP or
// less it runs south and rubs its glory, and side A is the hunter that must kill it first.
export const SCENARIOS: Readonly<Record<string, { a?: Profile; b?: Profile }>> = {
    open: {},
    escape: { b: { escapeAt: 60 } },
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
// A spar that measured something: both sides attacked, and the fight ended in a kill, an escape or at the cap.
export const sparValid = (r: SparResult) => [r.a, r.b].every(f => f.attacks.magic + f.attacks.ranged + f.attacks.melee > 0 && f.outcome !== 'session ended' && f.outcome !== 'danger')
    && (r.end !== 'cap' || (r.a.outcome === 'timeout' && r.b.outcome === 'timeout'));

export async function spar(a: Session, b: Session, optionsA: FightOptions, optionsB: FightOptions, log: (line: string) => void = l => console.log(l), halt: () => boolean = () => false): Promise<SparResult> {
    const self = (s: Session) => s.sdk.getState()?.player;
    // A new practice world refuses player attacks for its first 8 ticks ("I'm already under attack.", pvp_combat.rs2:110).
    for (let i = 0; i < 10; i++) if (!await nextTick(a)) break;
    const pa = self(a), pb = self(b), start = a.tick(), hp0 = [pa?.hp, pb?.hp];
    const startGap = pa && pb ? Math.max(Math.abs(pa.worldX - pb.worldX), Math.abs(pa.worldZ - pb.worldZ)) : undefined;
    let opening: number | null = null;
    // SPAR_TRACE=1 prints one line for each tick: where each side stands, its HP and its run energy.
    const told = [0, 0];
    const trace = process.env.SPAR_TRACE === '1' ? a.onTick(() => { const x = self(a), y = self(b);
        [a, b].forEach((s, i) => { for (const m of s.sdk.getState()?.gameMessages ?? []) { const id = m.observationId ?? m.tick; if (id > told[i]! && m.tick >= start) { told[i] = id; log(`MSG ${s.name} ${m.text}`); } } });
        log(`TRACE ${a.tick() - start} a=${x?.worldX},${x?.worldZ} hp=${x?.hp} run=${x?.runEnergy} b=${y?.worldX},${y?.worldZ} hp=${y?.hp} run=${y?.runEnergy}`); }) : undefined;
    const unwatch = a.onTick(() => { if (opening === null && [a, b].some((s, i) => (self(s)?.hp ?? Infinity) < (hp0[i] ?? 0))) opening = a.tick() - start; });
    // The first side to end stops the other: a fight has one end.
    let over = false;
    const side = (s: Session, target: string, o: FightOptions) => fightPlayer(s, target, { ...o, stop: () => over || halt(), log: l => log(`[${s.name}] ${l}`) })
        .finally(() => { over = true; });
    const [ra, rb] = await Promise.all([side(a, b.name, optionsA), side(b, a.name, optionsB)]);
    unwatch(); trace?.();
    return { ...sparScore(ra, rb), opening, ...(startGap === undefined ? {} : { startGap }) };
}

// The result of several spars that ran at once, from the A sides: kills, deaths, the B sides that got away, and draws.
export function batchSummary(results: readonly SparResult[]) {
    const count = (f: (r: SparResult) => boolean) => results.filter(f).length;
    const mean = results.length ? Number((results.reduce((n, r) => n + r.score, 0) / results.length).toFixed(1)) : 0;
    return { fights: results.length, kills: count(r => r.winner === 'a' && r.end === 'kill'), deaths: count(r => r.winner === 'b' && r.end === 'kill'),
        escapes: count(r => r.winner === 'b' && r.end === 'escape'), fled: count(r => r.winner === 'a' && r.end === 'escape'), draws: count(r => r.winner === 'draw'),
        mean, ticks: Math.max(0, ...results.map(r => r.ticks)), scores: results.map(r => r.score) };
}

if (import.meta.main) {
    const [botA, botB, capArg, ...more] = process.argv.slice(2), env = process.env;
    if (!botA || !botB || more.length % 2) { console.log('RESULT fail usage: bun scripts/pk-spar.ts <bot a> <bot b> [CAP ticks] [<bot a> <bot b> ...]'); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const cap = Number(capArg ?? 900), nameA = env.SPAR_A ?? 'base', nameB = env.SPAR_B ?? 'base', scenarioName = env.SPAR_SCENARIO ?? 'open';
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) { console.log(`RESULT fail pk-spar: unknown scenario "${scenarioName}"; known: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2); }
    const optionsA = sparOptions(nameA, env.SPAR_A_OPTS, TRIBRID_KIT, cap, scenario.a), optionsB = sparOptions(nameB, env.SPAR_B_OPTS, TRIBRID_KIT, cap, scenario.b);
    // A death is the expected end of a spar, so it must not end the run as openBot does by default. Any other stop
    // (a stop file, a stalled tick stream) halts every side and fails the run.
    let halted: string | undefined;
    const onStop = async (_s: unknown, reason: string) => { if (reason !== 'died') halted ??= reason; };
    // More pairs after the cap fight at the same time in the same world: each pair is one more sample for the cost of
    // the same game ticks. A player does not block a tile, and a fight loop names its one target, so pairs share a spot.
    const t0 = Date.now();
    const names: [string, string][] = [[botA, botB]];
    for (let i = 0; i < more.length; i += 2) names.push([more[i]!, more[i + 1]!]);
    // Every account logs in at the same time, and the wait for the logins counts as a tick wait: an account that is
    // in has no waiter until the fights start, and a lockstep world then holds each tick for the busy limit (2 s).
    const { tickWaits } = await import('../packages/core/src/tick-stream');
    tickWaits.active++;
    // The account of the run logs in first: the bench checks the first START line against that account's start tile.
    const first = await openBot(botA, { onStop });
    const pairs: [Session, Session][] = await Promise.all(names.map(async ([x, y], i): Promise<[Session, Session]> => {
        const [a, b] = await Promise.all([i === 0 ? first : openBot(x, { onStop }), openBot(y, { onStop })]);
        // The fight loop sends its actions by index and reads no `reachable` flag; the flood fill behind that flag
        // was 9% of a 16-account run.
        for (const s of [a, b]) (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
        return [a, b];
    })).finally(() => { tickWaits.active--; });
    const t1 = Date.now();
    const results = await Promise.all(pairs.map(([a, b]) => spar(a, b, optionsA, optionsB, undefined, () => halted !== undefined)));
    // Where the wall time of the run went: the logins, then the fights.
    console.log(`SPAR_TIMING loginMs=${t1 - t0} fightMs=${Date.now() - t1} pairs=${pairs.length} ticks=${Math.max(...results.map(r => r.ticks))}`);
    for (const r of results) console.log(`SPAR ${JSON.stringify({ scenario: scenarioName, profiles: { a: nameA, b: nameB }, ...r })}`);
    const ok = results.every(sparValid) && halted === undefined, sessions = pairs.flat(), r = results[0]!;
    if (results.length > 1) {
        const s = batchSummary(results);
        await finish(sessions, ok, `spar-batch fights=${s.fights} kills=${s.kills} deaths=${s.deaths} escapes=${s.escapes} fled=${s.fled} draws=${s.draws} mean=${s.mean} ticks=${s.ticks} a=${nameA} b=${nameB} `
            + `valid=${results.filter(sparValid).length} scores=${s.scores.join(',')}${halted ? ` halted=${halted}` : ''}`);
    }
    await finish(sessions, ok, `spar winner=${r.winner} score=${r.score} ticks=${r.ticks} end=${r.end} opening=${r.opening} gap=${r.startGap} a=${nameA} b=${nameB} `
        + `aOutcome=${r.a.outcome} bOutcome=${r.b.outcome} aTaken=${r.a.taken} bTaken=${r.b.taken} aEaten=${r.a.eaten} bEaten=${r.b.eaten} aSpecs=${r.a.specs} bSpecs=${r.b.specs}${halted ? ` halted=${halted}` : ''}`);
}
