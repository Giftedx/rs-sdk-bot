// Gang: one of our accounts meets several accounts that all attack it, each side with scripts/pk.ts and a profile of
// scripts/pk-spar.ts. It is the meeting with the dagger gang (research/pvp-fight-loop.md, "Rivals: the dagger
// gang"): three accounts stand on one tile and all go for one target. On a single-way tile one of them fights and
// the others try again each turn, so the next one is on the target the moment the first is dead: our account fights
// them one after the other with one pack of food.
// Practice only: openBot refuses a non-local server without DEMO_OK=1, and the run kills accounts.
// Usage: bun scripts/pk-gang.ts <bot> <gang bot> <gang bot> <gang bot> [CAP ticks, default 900] [<bot> <gang bot> ...];
// SPAR_GANG is the size of a gang (default 3), and more groups fight at the same time. Environment as for the spar:
// SPAR_A and SPAR_B name the profiles (default base), SPAR_A_OPTS and SPAR_B_OPTS add fight options as JSON, and
// SPAR_KITS=<kit of our account>:<kit of the gang> names the kits (scripts/pk-kits.ts).
// Prints one `GANG <json>` line for each group. RESULT ok means that in each group our account and one of the gang
// attacked and the meeting ended: the gang dead, our account dead or away, or the cap.
import type { Session } from '../packages/core/src/inprocess';
import { fightPlayer, nextTick, type FightOptions, type FightResult } from './pk';
import { hitByPlayer, TRIBRID_KIT } from './pk-hunt';
import { kitOptions, kitSwitches } from './pk-kits';
import { sparOptions } from './pk-spar';

// `cleared`: every account of the gang is dead. `away`: our account lost sight of every one that lives.
export type GangResult = { end: 'cleared' | 'died' | 'escaped' | 'away' | 'cap'; kills: number; ticks: number; taken: number; eaten: number; specs: number; fights: FightResult[]; gang: FightResult[] };

// The account of the gang to fight now: the one that hit us last, else the nearest in view. On a single-way tile the
// game refuses an attack on any other while that one fights us.
export function pickAttacker<P extends { name: string; index: number; distance: number }>(nearby: readonly P[], alive: ReadonlySet<string>, lastHitBy: number | null): P | null {
    const gang = nearby.filter(p => alive.has(p.name.toLowerCase()));
    return gang.find(p => p.index === lastHitBy) ?? [...gang].sort((x, y) => x.distance - y.distance)[0] ?? null;
}
const attacksOf = (f: FightResult) => f.attacks.magic + f.attacks.ranged + f.attacks.melee;
// A meeting that measured something: our account attacked, one of the gang attacked, and no session ended.
export const gangValid = (r: GangResult) => r.fights.some(f => attacksOf(f) > 0) && r.gang.some(f => attacksOf(f) > 0)
    && [...r.fights, ...r.gang].every(f => f.outcome !== 'session ended' && f.outcome !== 'danger');

export async function gang(a: Session, others: readonly Session[], optionsA: FightOptions, optionsB: FightOptions, log: (line: string) => void = l => console.log(l), halt: () => boolean = () => false): Promise<GangResult> {
    // A new practice world refuses player attacks for its first 8 ticks (pvp_combat.rs2:110).
    for (let i = 0; i < 10; i++) if (!await nextTick(a)) break;
    const start = a.tick(), cap = optionsA.cap ?? 900, self = () => a.sdk.getState()?.player;
    const alive = new Set(others.map(o => o.name.toLowerCase()));
    let over = false, taken = 0, lastHp = self()?.hp ?? 0, lastHitBy: number | null = null, lastHitAt = -100, seenEvent = 0;
    // The damage our account took is the sum of its HP drops (as in the spar), and the last player to hit it is the
    // one that fights it.
    const unwatch = a.onTick(() => {
        const hp = self()?.hp;
        if (hp !== undefined) { if (hp < lastHp) taken += lastHp - hp; lastHp = hp; }
        for (const e of a.sdk.getState()?.combatEvents ?? []) { const id = e.observationId ?? e.tick; if (id > seenEvent) { seenEvent = id; if (hitByPlayer(e)) { lastHitBy = e.sourceIndex; lastHitAt = a.tick(); } } }
    });
    // Each account of the gang attacks our account until one of the two is dead. One that lost sight of it while both
    // live goes on as soon as it sees it again.
    const sum = (into: FightResult, r: FightResult) => { into.outcome = r.outcome; into.ticks += r.ticks; into.eaten += r.eaten; into.specs += r.specs; into.freezes += r.freezes;
        for (const st of ['magic', 'ranged', 'melee'] as const) into.attacks[st] += r.attacks[st]; };
    const sides = others.map(async g => {
        const total: FightResult = { outcome: 'timeout', ticks: 0, dealt: 0, taken: 0, eaten: 0, attacks: { magic: 0, ranged: 0, melee: 0 }, freezes: 0, specs: 0 };
        while (!over && !halt()) {
            const r = await fightPlayer(g, a.name, { ...optionsB, cap: Math.max(1, cap - (g.tick() - start)), stop: () => over || halt(), log: l => log(`[${g.name}] ${l}`) });
            sum(total, r);
            if (r.outcome !== 'lost' || g.tick() - start >= cap) break;
            if (!await nextTick(g)) { total.outcome = 'session ended'; break; }
        }
        if (total.outcome === 'died') alive.delete(g.name.toLowerCase());
        return total;
    });
    const fights: FightResult[] = [];
    let end: GangResult['end'] = 'cap', unseen = 0;
    while (alive.size && a.tick() - start < cap && !halt()) {
        const target = pickAttacker(a.sdk.getState()?.nearbyPlayers ?? [], alive, lastHitBy);
        if (!target) {
            // None of the living gang in view for 20 ticks: our account got away from it.
            if (++unseen > 20) { end = 'away'; break; }
            if (!await nextTick(a)) break;
            continue;
        }
        unseen = 0;
        // Another of the gang hit us in the last 8 ticks: the game now refuses our attacks on this one
        // (pvp_combat.rs2:104-112), so the fight turns to the one that hit.
        const other = () => lastHitBy !== null && lastHitBy !== target.index && a.tick() - lastHitAt <= 8
            && (a.sdk.getState()?.nearbyPlayers ?? []).some(p => p.index === lastHitBy && alive.has(p.name.toLowerCase()));
        const r = await fightPlayer(a, target.name, { ...optionsA, cap: Math.max(1, cap - (a.tick() - start)), stop: () => halt() || other(), log: l => log(`[${a.name}] ${l}`) });
        fights.push(r);
        if (r.outcome === 'kill') { alive.delete(target.name.toLowerCase()); lastHitBy = null; continue; }
        if (r.outcome === 'timeout' && other() && a.tick() - start < cap) continue;
        if (r.outcome === 'died') { end = 'died'; break; }
        if (r.outcome === 'escaped') { end = 'escaped'; break; }
        if (r.outcome !== 'lost') break;
    }
    if (!alive.size) end = 'cleared';
    over = true;
    const gangResults = await Promise.all(sides);
    unwatch();
    // A kill is a dead account of the gang: the kill message can come after the fight turned to another of them.
    const kills = others.length - alive.size;
    return { end, kills, ticks: a.tick() - start, taken, eaten: fights.reduce((n, f) => n + f.eaten, 0), specs: fights.reduce((n, f) => n + f.specs, 0), fights, gang: gangResults };
}

// The counts of several meetings that ran at once.
export function gangSummary(results: readonly GangResult[]) {
    const ends = (end: GangResult['end']) => results.filter(r => r.end === end).length;
    return { groups: results.length, cleared: ends('cleared'), died: ends('died'), escaped: ends('escaped'), away: ends('away'), cap: ends('cap'),
        kills: results.reduce((n, r) => n + r.kills, 0), ticks: Math.max(0, ...results.map(r => r.ticks)), killsEach: results.map(r => r.kills) };
}

if (import.meta.main) {
    const env = process.env, size = Math.max(1, Number(env.SPAR_GANG ?? 3));
    const args = process.argv.slice(2), capArg = args.find(x => /^\d+$/.test(x)), bots = args.filter(x => x !== capArg);
    if (!bots.length || bots.length % (size + 1)) { console.log(`RESULT fail usage: bun scripts/pk-gang.ts <bot> <${size} gang bots> [CAP ticks] [<bot> <${size} gang bots> ...]`); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const cap = Number(env.SPAR_CAP ?? capArg ?? 900), nameA = env.SPAR_A ?? 'base', nameB = env.SPAR_B ?? 'base';
    const [kitA, kitB] = (env.SPAR_KITS ?? '').split(',')[0]!.split(':');
    const options = (side: 0 | 1, group: number): FightOptions => {
        const kit = side === 0 ? kitA : kitB;
        // A random style choice (mixStyles) repeats with the bench seed, as in the spar.
        const seed = env.BENCH_SEED === undefined ? {} : { mixSeed: Number(env.BENCH_SEED) * 1000 + group * 2 + side };
        return { ...sparOptions(side === 0 ? nameA : nameB, side === 0 ? env.SPAR_A_OPTS : env.SPAR_B_OPTS, kit ? kitSwitches(kit) : TRIBRID_KIT, cap, kit ? kitOptions(kit) : {}), ...seed };
    };
    // A death is an expected end here, so it must not end the run as openBot does by default; any other stop halts
    // every side and fails the run.
    let halted: string | undefined;
    const onStop = async (_s: unknown, reason: string) => { if (reason !== 'died') halted ??= reason; };
    const { tickWaits } = await import('../packages/core/src/tick-stream');
    tickWaits.active++;
    // The account of the run logs in first: the bench checks the first START line against that account's start tile.
    const first = await openBot(bots[0]!, { onStop });
    const groups: Session[][] = [];
    try {
        for (let at = 0; at < bots.length; at += size + 1) groups.push(await Promise.all(bots.slice(at, at + size + 1).map((name, i) => (at === 0 && i === 0 ? first : openBot(name, { onStop })))));
    } finally { tickWaits.active--; }
    // The fight loop reads no loc and no ground item, and their scan is part of the state of every tick.
    for (const s of groups.flat()) {
        (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
        const collector = (s.client as { collector?: Record<string, unknown> } | undefined)?.collector;
        if (collector && typeof collector.collectNearbyLocs === 'function') { collector.collectNearbyLocs = () => []; collector.collectGroundItems = () => []; }
    }
    const results = await Promise.all(groups.map(([a, ...others], i) => gang(a!, others, options(0, i), options(1, i), undefined, () => halted !== undefined)));
    for (const r of results) console.log(`GANG ${JSON.stringify({ profiles: { a: nameA, b: nameB }, kits: { a: kitA, b: kitB }, ...r })}`);
    const s = gangSummary(results), ok = results.every(gangValid) && halted === undefined;
    await finish(groups.flat(), ok, `gang groups=${s.groups} cleared=${s.cleared} died=${s.died} escaped=${s.escaped} away=${s.away} cap=${s.cap} kills=${s.kills} ticks=${s.ticks} a=${nameA} b=${nameB} `
        + `valid=${results.filter(gangValid).length} killsEach=${s.killsEach.join(',')} taken=${results.map(r => r.taken).join(',')} eaten=${results.map(r => r.eaten).join(',')}${halted ? ` halted=${halted}` : ''}`);
}
