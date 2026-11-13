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
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyPlayer } from '../vendor/rs-sdk/sdk/types';
import { fightPlayer, ITEMS, nextTick, observePlayer, wildernessLevel, type FightOptions, type FightResult, type Kit } from './pk';
import { BOOST_POTIONS, EDGEVILLE_BANK, hitByPlayer, restock, TRIBRID_KIT } from './pk-hunt';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { kitOptions, kitSwitches } from './pk-kits';
import { sparOptions } from './pk-spar';

// The attack animations of a dragon dagger (content pack/seq.pack): the lunge, the hack and the special.
const DAGGER_ATTACKS = ['human_ddagger_lunge', 'human_ddagger_hack', 'puncture'];
let attackSeqs: Set<number> | undefined;
const attackAnims = () => (attackSeqs ??= new Set(readFileSync(join(resolve(import.meta.dir, '..'), 'vendor/rs-sdk/server/content/pack/seq.pack'), 'utf8').split(/\r?\n/)
    .flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m && DAGGER_ATTACKS.includes(m[2]!) ? [Number(m[1])] : []; })));
// True in the tick in which the client shows a player start an attack animation. The server plays it only for an
// attack that it let through, so on a single-way tile it names the one account that fights us.
export function startsAttack(entity: { primaryAnim?: number; primaryAnimCycle?: number; primaryAnimFrame?: number } | null | undefined, anims: ReadonlySet<number> = attackAnims()): boolean {
    return !!entity && anims.has(entity.primaryAnim ?? -1) && (entity.primaryAnimCycle ?? 0) === 0 && (entity.primaryAnimFrame ?? 0) === 0;
}
// `cleared`: every account of the gang is dead. `away`: our account lost sight of every one that lives.
// `refused` counts the attacks of our account that the game refused ("I'm already under attack."); `foodLeft` and
// `prayerLeft` are what our account had at the end, and `prayerDoses` the doses of prayer potion in its pack: the
// margin of the method. `trips` counts the meetings: one, and one more after each trip to the bank. `gangTrips` counts
// the trips of the gang to its bank. `prayerOut` is the tick of the meeting at which our account had no prayer points
// left (-1: never).
export type GangResult = { end: 'cleared' | 'died' | 'escaped' | 'away' | 'cap'; kills: number; ticks: number; taken: number; eaten: number; specs: number; refused: number; foodLeft: number; prayerLeft: number; prayerDoses: number; trips: number; gangTrips: number; prayerOut: number;
    fights: FightResult[]; gang: FightResult[] };

// The account of the gang to fight now: the one that hit us last, else the nearest in view that the game has not
// just refused. On a single-way tile the game refuses an attack on any other while one of them fights us.
export function pickAttacker<P extends { name: string; index: number; distance: number }>(nearby: readonly P[], alive: ReadonlySet<string>, lastHitBy: number | null, refused: ReadonlySet<string> = new Set()): P | null {
    const gang = nearby.filter(p => alive.has(p.name.toLowerCase())), open = gang.filter(p => !refused.has(p.name.toLowerCase()));
    return gang.find(p => p.index === lastHitBy) ?? [...(open.length ? open : gang)].sort((x, y) => x.distance - y.distance)[0] ?? null;
}
// focusRunner: the account of the gang in view with the lowest health bar at or under `fraction` that our attack can
// reach now (`open`: the single-way rule lets it through), else null. `health` reads the bar (0..1) of a player index.
export function pickRunner<P extends { name: string; index: number }>(nearby: readonly P[], alive: ReadonlySet<string>, fraction: number, health: (index: number) => number | null, open: (p: P) => boolean): P | null {
    let best: P | null = null, low = Infinity;
    for (const p of nearby) {
        const h = health(p.index);
        if (!alive.has(p.name.toLowerCase()) || h === null || h > fraction || !open(p)) continue;
        if (h < low) { low = h; best = p; }
    }
    return best;
}
// The doses in each prayer potion and super restore (scripts/pk.ts ITEMS: four doses first).
const PRAYER_DOSES = new Map([...ITEMS.prayerPotion, ...ITEMS.superRestore].map((id, i) => [id as number, 4 - (i % 4)] as const));
const attacksOf = (f: FightResult) => f.attacks.magic + f.attacks.ranged + f.attacks.melee;
// A meeting that measured something: our account attacked, one of the gang attacked, and no session ended.
export const gangValid = (r: GangResult) => r.fights.some(f => attacksOf(f) > 0) && r.gang.some(f => attacksOf(f) > 0)
    && [...r.fights, ...r.gang].every(f => f.outcome !== 'session ended' && f.outcome !== 'danger');

// The trip to the bank between two meetings at the edge of the Wilderness: walk to the bank, bank the pack, take
// `food` slots of sharks and boosts and the `items` again (scripts/pk-hunt.ts restock), wield the arrows, walk back.
// `fill: false` takes sharks up to the food slots of the pack only, not a full pack, and `rest` is the ticks that the account waits at the bank.
export function bankTrip(at: { x: number; z: number }, back: { x: number; z: number }, pack: { food: number; items: readonly { id: number; count: number }[] }, kit: Kit, halt: () => boolean = () => false,
    bank: { eaten: number } = { eaten: 0 }, more: { fill?: boolean; rest?: number } = {}) {
    // `fresh`: the pack is the full pack of the kit already (the trip before the first meeting), so nothing is banked
    // but the boosts.
    return async (a: Session, fresh = false): Promise<string | null> => {
        const deps = await sessionWalker(a);
        const go = (to: { x: number; z: number }) => walkPath(deps, [{ ...to, tol: 2 }], { maxTicks: 400, idleMs: 9000, stop: halt });
        const out = await go(at);
        if (!out.ok) return `no walk to the bank: ${out.detail ?? 'stopped'}`;
        const fault = fresh ? null : await restock(a, pack.food, pack.items, kit);
        if (fault) return fault;
        // At the bank no attack is lost to an eat or a drink: eat to within one shark of full Hitpoints, drink one dose
        // of each boost, then bank the boosts and fill the pack with sharks again.
        // A stop ends the wait at once: the rest can be 1,000 ticks.
        const pause = async (ticks: number) => { for (let i = 0; i < ticks && !halt(); i++) if (!await nextTick(a)) return; };
        const edible = (i: { optionsWithIndex: { text: string }[] }) => i.optionsWithIndex.some(o => /^eat$/i.test(o.text));
        for (let i = 0; i < 6; i++) {
            const me = a.sdk.getState()?.player, food = a.sdk.getInventory().find(edible), op = food?.optionsWithIndex.find(o => /^eat$/i.test(o.text));
            if (!me || !food || !op || me.hp > me.maxHp - 20) break;
            await a.sdk.sendUseItem(food.slot, op.opIndex); bank.eaten++; await pause(3);
        }
        const boosts = () => a.sdk.getInventory().filter(i => PREPOT.some(doses => (doses as readonly number[]).includes(i.id)));
        for (const potion of boosts()) { const op = potion.optionsWithIndex.find(o => /^drink$/i.test(o.text)); if (op) { await a.sdk.sendUseItem(potion.slot, op.opIndex); await pause(3); } }
        if (!(await a.bot.openBank()).success) return 'bank did not open for the second visit';
        for (const potion of boosts()) await a.bot.depositItem(potion, -1);
        const sharks = a.sdk.getBankItems().find(b => b.id === ITEMS.shark);
        const room = more.fill === false ? pack.food - a.sdk.getInventory().filter(edible).length : 27 - a.sdk.getInventory().length;
        if (sharks && room > 0) await a.bot.withdrawItem(sharks, Math.min(room, sharks.count), { asNote: false });
        await a.bot.closeBank();
        await pause(more.rest ?? 0);
        if (halt()) return 'no walk back: stopped';
        for (const item of a.sdk.getInventory()) { const op = /arrow/i.test(item.name) ? item.optionsWithIndex.find(o => /^wield$/i.test(o.text)) : undefined; if (op) await a.sdk.sendUseItem(item.slot, op.opIndex); }
        const home = await go(back);
        return home.ok ? null : `no walk back: ${home.detail ?? 'stopped'}`;
    };
}
// The boosts that an account drinks at the bank: the three of scripts/pk-hunt.ts and the super defence.
const PREPOT = [...BOOST_POTIONS, ITEMS.superDefence] as const;
// What a bank trip takes again, from the pack and the quiver of an account at its start: every item that is no food
// and no boost, the arrows at their count, and one slot for each shark and each boost.
export function packOf(inventory: readonly { id: number; count: number; optionsWithIndex: { text: string }[] }[], equipment: readonly { id: number; count: number; slot: number }[]): { food: number; items: { id: number; count: number }[] } {
    const boost = (id: number) => BOOST_POTIONS.some(doses => (doses as readonly number[]).includes(id)), edible = (i: { optionsWithIndex: { text: string }[] }) => i.optionsWithIndex.some(o => /^eat$/i.test(o.text));
    const items = new Map<number, number>();
    for (const i of inventory) if (!edible(i) && !boost(i.id)) items.set(i.id, (items.get(i.id) ?? 0) + i.count);
    // A potion with doses gone is asked for as a full one.
    for (const doses of [ITEMS.superDefence, ITEMS.antipoison.slice(0, 4), ITEMS.antipoison.slice(4)]) for (const id of doses.slice(1)) if (items.has(id)) { items.set(doses[0]!, (items.get(doses[0]!) ?? 0) + items.get(id)!); items.delete(id); }
    for (const e of equipment) if (e.slot === 13) items.set(e.id, e.count);
    return { food: inventory.filter(i => edible(i) || boost(i.id)).length, items: [...items].map(([id, count]) => ({ id, count })) };
}
// The trips of the gang (research/pvp-fight-loop.md, "The gang in a long fight"): an account of the gang that walked
// out of the Wilderness goes to the bank and comes back to its tile, `count` times at most. `follow`: the others stop
// their fights and go with it. `ran` is true for the account that ran out, false for one that went with it.
export type GangTrips = { count: number; resupply: (g: Session, ran: boolean) => Promise<string | null>; follow?: boolean };
// `trips`: with more than one, an account that walked out of the Wilderness goes to the bank and comes back.
// `wait`: the ticks that our account waits on its tile with none of the gang in view (default 20); `idlePrayerOff`
// (SPAR_IDLE_PRAYER_OFF=1): it turns its prayers off while it waits.
export async function gang(a: Session, others: readonly Session[], optionsA: FightOptions, optionsB: FightOptions | ((member: number) => FightOptions), log: (line: string) => void = l => console.log(l), halt: () => boolean = () => false,
    trips?: { count: number; resupply: (a: Session, fresh?: boolean) => Promise<string | null>; bank?: { eaten: number } }, more: { wait?: number; gangTrips?: GangTrips; idlePrayerOff?: boolean } = {}): Promise<GangResult> {
    // A new practice world refuses player attacks for its first 8 ticks (pvp_combat.rs2:110).
    for (let i = 0; i < 10; i++) if (!await nextTick(a)) break;
    const start = a.tick(), cap = optionsA.cap ?? 900, self = () => a.sdk.getState()?.player;
    const first = self(), spot = first ? { x: first.worldX, z: first.worldZ } : null;
    const alive = new Set(others.map(o => o.name.toLowerCase()));
    // A death gives the account a new life id, but the client counts a death only when it sees 0 Hitpoints, and the
    // server can give the Hitpoints back in the tick of the death. A dead account stands at the Lumbridge spawn, so an
    // account within 40 tiles of it is dead too: no meeting is near it.
    const life = (s: Session) => s.sdk.getState()?.player?.lifeId, lives = new Map(others.map(o => [o, life(o)] as const));
    const respawned = (s: Session) => { const p = s.sdk.getState()?.player; return !!p && Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40; };
    const reap = () => { for (const [g, first] of lives) if (respawned(g) || (first !== undefined && life(g) !== undefined && life(g) !== first)) alive.delete(g.name.toLowerCase()); };
    // Where each gang account stood at the start: it waits there while our account is outside the Wilderness.
    const homes = new Map(others.map(o => { const p = o.sdk.getState()?.player; return [o, p ? { x: p.worldX, z: p.worldZ } : null] as const; }));
    let prayerOut = -1, over = false, taken = 0, lastHp = self()?.hp ?? 0, lastHitBy: number | null = null, lastHitAt = -100, seenEvent = 0, seenMessage = 0, refusals = 0, refusedAt = -100, seenAnim = false;
    const refusedBy = new Set<string>();
    // The damage our account took is the sum of its HP drops (as in the spar). The account of the gang that fights it
    // is the last one that started an attack animation; where the client shows none, the source of the last splat.
    const unwatch = a.onTick(() => {
        const hp = self()?.hp;
        if (hp !== undefined) { if (hp < lastHp) taken += lastHp - hp; lastHp = hp; }
        if (prayerOut < 0 && a.sdk.getState()?.prayers.prayerPoints === 0) prayerOut = a.tick() - start;
        const players = (a.client as { players?: ({ primaryAnim?: number; primaryAnimCycle?: number; primaryAnimFrame?: number } | null)[] } | undefined)?.players;
        for (const p of a.sdk.getState()?.nearbyPlayers ?? []) if (alive.has(p.name.toLowerCase()) && p.distance <= 2 && startsAttack(players?.[p.index])) { lastHitBy = p.index; lastHitAt = a.tick(); seenAnim = true; }
        // The source of a splat is the player that our account faces (StateCollector): a guess, used only where no animation shows.
        for (const e of a.sdk.getState()?.combatEvents ?? []) { const id = e.observationId ?? e.tick; if (id > seenEvent) { seenEvent = id; if (hitByPlayer(e) && !seenAnim) { lastHitBy = e.sourceIndex; lastHitAt = a.tick(); } } }
        for (const msg of a.sdk.getState()?.gameMessages ?? []) { const id = msg.observationId ?? msg.tick; if (id <= seenMessage) continue; seenMessage = id;
            if (msg.tick >= start && /already under attack/i.test(msg.text)) { refusals++; refusedAt = a.tick(); } }
    });
    // Each account of the gang attacks our account until one of the two is dead. One that lost sight of it while both
    // live goes on as soon as it sees it again.
    const sum = (into: FightResult, r: FightResult) => { into.outcome = r.outcome; into.ticks += r.ticks; into.eaten += r.eaten; into.specs += r.specs; into.freezes += r.freezes;
        for (const st of ['magic', 'ranged', 'melee'] as const) into.attacks[st] += r.attacks[st]; };
    const gangTrips = more.gangTrips;
    // The tick at which an account of the gang started its walk out, and that account: the others go when it starts.
    let retreatAt = -1, retreater: Session | null = null, gangBanked = 0;
    const sides = others.map(async (g, member) => {
        const own = typeof optionsB === 'function' ? optionsB(member) : optionsB;
        const total: FightResult = { outcome: 'timeout', ticks: 0, dealt: 0, taken: 0, eaten: 0, attacks: { magic: 0, ranged: 0, melee: 0 }, freezes: 0, specs: 0 };
        let tripsLeft = gangTrips?.count ?? 0;
        while (!over && !halt()) {
            const began = g.tick();
            const called = () => !!gangTrips?.follow && retreatAt > began && retreater !== g;
            const r = await fightPlayer(g, a.name, { ...own, cap: Math.max(1, cap - (g.tick() - start)), stop: () => over || halt() || called(),
                log: l => { if (/walks out of the Wilderness/.test(l) && gangTrips && tripsLeft > 0) { retreatAt = g.tick(); retreater = g; } log(`[${g.name}] ${l}`); } });
            sum(total, r);
            reap();
            if (!alive.has(g.name.toLowerCase())) { total.outcome = 'died'; break; }
            const follows = called() && r.outcome !== 'kill';
            if (gangTrips && tripsLeft > 0 && (r.outcome === 'escaped' || follows) && !over && !halt() && g.tick() - start < cap) {
                tripsLeft--;
                log(`[${g.name}] GANG to the bank at HP ${g.sdk.getState()?.player?.hp}${follows ? ' with the others' : ''}`);
                const fault = await gangTrips.resupply(g, r.outcome === 'escaped');
                if (fault) { log(`[${g.name}] GANG no resupply: ${fault}`); break; }
                gangBanked++;
                log(`[${g.name}] GANG back at HP ${g.sdk.getState()?.player?.hp}`);
                continue;
            }
            if (r.outcome !== 'lost' || g.tick() - start >= cap) break;
            // The gang runs to a target that the world feed shows: an account that lost sight of ours goes back to it.
            // It attacks nobody outside the Wilderness: while ours is out, it goes to where it stood.
            const at = self(), home = homes.get(g);
            if (at && wildernessLevel(at.worldZ) > 0) void g.sdk.sendWalk(at.worldX, at.worldZ);
            else if (home) void g.sdk.sendWalk(home.x, home.z);
            if (!await nextTick(g)) { total.outcome = 'session ended'; break; }
        }
        if (total.outcome === 'died') alive.delete(g.name.toLowerCase());
        return total;
    });
    const fights: FightResult[] = [];
    // focusRunner: the health bar of each account in view, and the single-way rule: our attack on an account goes
    // through when it hit us last, or when no one has hit us for 8 ticks.
    const focus = optionsA.focusRunner;
    const health = (index: number) => { const seen = observePlayer(a.client, index); return seen && seen.totalHealth > 0 ? seen.health / seen.totalHealth : null; };
    const runner = () => focus === undefined ? null : pickRunner(a.sdk.getState()?.nearbyPlayers ?? [], alive, focus, health, p => p.index === lastHitBy || a.tick() - lastHitAt > 8);
    // A fight turns to a runner whose bar is lower by 5 points or more than the target's.
    const lowerRunner = (current: NearbyPlayer) => { const r = runner(); return !!r && r.index !== current.index && (health(r.index) ?? 1) < (health(current.index) ?? 1) - 0.05; };
    let end: GangResult['end'] = 'cap', unseen = 0, returns = 0, trip = 1;
    for (;;) {
    while (alive.size && a.tick() - start < cap && !halt()) {
        reap();
        if (!alive.size) break;
        const target: NearbyPlayer | null = runner() ?? pickAttacker(a.sdk.getState()?.nearbyPlayers ?? [], alive, lastHitBy, refusedBy);
        if (!target) {
            // An attack click on an account that died can walk ours toward its respawn point. Away from its tile with
            // none of the gang in view, it walks back before the ticks count.
            const here = self();
            if (here && spot && Math.max(Math.abs(here.worldX - spot.x), Math.abs(here.worldZ - spot.z)) > 3 && returns < 60) {
                if (returns++ % 4 === 0) void a.sdk.sendWalk(spot.x, spot.z);
                if (!await nextTick(a)) break;
                continue;
            }
            // None of the living gang in view for `wait` ticks: our account got away from it.
            if (++unseen > (more.wait ?? 20)) { end = 'away'; break; }
            // `idlePrayerOff`: with none of the gang in view no fight loop flicks, and an active prayer drains.
            // One input each 3 ticks: the state shows a prayer on until the server has turned it off.
            if (more.idlePrayerOff && unseen % 3 === 1) for (const [p, on] of (a.sdk.getState()?.prayers.activePrayers ?? []).entries()) if (on) void a.sdk.sendTogglePrayer(p);
            if (!await nextTick(a)) break;
            continue;
        }
        unseen = 0; returns = 0;
        // Another of the gang hit us in the last 8 ticks: the game now refuses our attacks on this one
        // (pvp_combat.rs2:104-112), so the fight turns to the one that hit.
        // A refused attack on this one says the same before the other has hit.
        const began = a.tick();
        const other = () => refusedAt > began || (lastHitBy !== null && lastHitBy !== target.index && a.tick() - lastHitAt <= 8
            && (a.sdk.getState()?.nearbyPlayers ?? []).some(p => p.index === lastHitBy && alive.has(p.name.toLowerCase())))
            || lowerRunner(target);
        if (focus !== undefined && (health(target.index) ?? 1) <= focus) log(`[${a.name}] GANG focus ${target.name} at ${Math.round((health(target.index) ?? 0) * 100)}%`);
        const r = await fightPlayer(a, target.name, { ...optionsA, cap: Math.max(1, cap - (a.tick() - start)), stop: () => halt() || other(), log: l => log(`[${a.name}] ${l}`) });
        fights.push(r);
        // An attack click on an account that died can walk ours toward its respawn point: after a kill, back to the
        // meeting tile from more than 6 tiles.
        const here = self();
        if (here && spot && r.outcome === 'kill' && Math.max(Math.abs(here.worldX - spot.x), Math.abs(here.worldZ - spot.z)) > 6) void a.sdk.sendWalk(spot.x, spot.z);
        // The next choice leaves out each account that the game refused, until one attack goes through.
        if (refusedAt > began) { refusedBy.add(target.name.toLowerCase()); if (lastHitBy === target.index) lastHitBy = null; if (refusedBy.size >= alive.size) refusedBy.clear(); } else refusedBy.clear();
        if (r.outcome === 'kill') { alive.delete(target.name.toLowerCase()); lastHitBy = null; continue; }
        if (r.outcome === 'timeout' && other() && a.tick() - start < cap) continue;
        if (r.outcome === 'died') { end = 'died'; break; }
        if (r.outcome === 'escaped') { end = 'escaped'; break; }
        if (r.outcome !== 'lost') break;
    }
    reap();
    if (!alive.size || end !== 'escaped' || !trips || trip >= trips.count || a.tick() - start >= cap || halt()) break;
    // Out of the Wilderness with the gang alive: to the bank and back for the next meeting.
    const fault = await trips.resupply(a);
    if (fault) { log(`[${a.name}] GANG no resupply: ${fault}`); break; }
    trip++; end = 'cap'; unseen = 0; lastHitBy = null; refusedBy.clear();
    }
    reap();
    if (!alive.size) end = 'cleared';
    // Our account at the Lumbridge spawn is dead, whatever its fight loop saw.
    else if (respawned(a)) end = 'died';
    over = true;
    const gangResults = await Promise.all(sides);
    unwatch();
    // A kill is a dead account of the gang: the kill message can come after the fight turned to another of them.
    const kills = others.length - alive.size;
    const state = a.sdk.getState(), foodLeft = (state?.inventory ?? []).filter(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text))).reduce((n, i) => n + i.count, 0);
    return { end, kills, ticks: a.tick() - start, taken, eaten: fights.reduce((n, f) => n + f.eaten, 0) + (trips?.bank?.eaten ?? 0), specs: fights.reduce((n, f) => n + f.specs, 0), refused: refusals, foodLeft,
        trips: trip, gangTrips: gangBanked, prayerOut, prayerLeft: state?.prayers.prayerPoints ?? 0, prayerDoses: (state?.inventory ?? []).reduce((n, i) => n + (PRAYER_DOSES.get(i.id) ?? 0) * i.count, 0), fights, gang: gangResults };
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
    // The gang side may name one kit for each account of a group: <ours>:<kit>+<kit>+<kit> (the army: one spear).
    const [kitA, kitList] = (env.SPAR_KITS ?? '').split(',')[0]!.split(':');
    const gangKits = (kitList ?? '').split('+'), kitB = gangKits[0];
    const options = (side: 0 | 1, group: number, member = 0): FightOptions => {
        const kit = side === 0 ? kitA : gangKits[member % gangKits.length] || undefined;
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
    // SPAR_TRIPS meetings at most for each account of ours, with a trip to the Edgeville bank between two of them.
    // SPAR_TRIP_FOOD is the number of slots for sharks and boosts that a trip takes (default: as the pack at the start).
    const tripCount = Math.max(1, Number(env.SPAR_TRIPS ?? 1));
    const resupplies = groups.map(([a]) => { const st = a!.sdk.getState(), p = st?.player;
        const bank = { eaten: 0 };
        // SPAR_POST=<x>,<z>: the tile that the trip walks back to (default the start tile), for an account that starts at the bank.
        const [px, pz] = (env.SPAR_POST ?? '').split(',').map(Number), back = Number.isFinite(px) && Number.isFinite(pz) && env.SPAR_POST ? { x: px!, z: pz! } : p ? { x: p.worldX, z: p.worldZ } : null;
        return (tripCount > 1 || env.SPAR_PRETRIP === '1') && st && p && back ? { count: tripCount, bank, resupply: bankTrip(EDGEVILLE_BANK, back,{ ...packOf(st.inventory, st.equipment), ...(env.SPAR_TRIP_FOOD ? { food: Number(env.SPAR_TRIP_FOOD) } : {}) },
            kitA ? kitSwitches(kitA) : TRIBRID_KIT, () => halted !== undefined, bank) } : undefined; });
    // The fight loop reads no loc and no ground item, and their scan is part of the state of every tick. An account
    // that goes to the bank needs both.
    const lean = (s: Session) => {
        (s.client as { setReachabilityEnabled?: (on: boolean) => void } | undefined)?.setReachabilityEnabled?.(false);
        const collector = (s.client as { collector?: Record<string, unknown> } | undefined)?.collector;
        if (collector && typeof collector.collectNearbyLocs === 'function') { collector.collectNearbyLocs = () => []; collector.collectGroundItems = () => []; }
    };
    // SPAR_B_TRIPS: each account of the gang that walks out of the Wilderness goes to the Edgeville bank and back at
    // most this many times; SPAR_B_FOLLOW=1 sends the others with it; SPAR_B_REST is the wait at the bank in ticks of
    // the account that ran out (the others do not wait).
    const gangTripCount = Number(env.SPAR_B_TRIPS ?? 0);
    const gangTrips = (group: Session[]): GangTrips | undefined => gangTripCount > 0 ? { count: gangTripCount, follow: env.SPAR_B_FOLLOW === '1', resupply: (() => {
        const trip = (rest: number) => new Map(group.slice(1).map(g => { const st = g.sdk.getState(), p = st?.player;
            return [g, st && p ? bankTrip(EDGEVILLE_BANK, { x: p.worldX, z: p.worldZ }, packOf(st.inventory, st.equipment), kitB ? kitSwitches(kitB) : TRIBRID_KIT, () => halted !== undefined, { eaten: 0 }, { fill: false, rest }) : null] as const; }));
        const ran = trip(Number(env.SPAR_B_REST ?? 0)), went = trip(0);
        return async (g: Session, out: boolean) => { const go = (out ? ran : went).get(g); return go ? go(g) : 'no start state'; };
    })() } : undefined;
    const gangTripsOf = groups.map(gangTrips);
    for (const s of groups.flatMap((g, i) => [...(resupplies[i] ? [] : g.slice(0, 1)), ...(gangTripsOf[i] ? [] : g.slice(1))])) lean(s);
    // SPAR_PRETRIP=1: each account of ours goes to the bank before the first meeting, as an account that comes from
    // the bank does: it drinks its boosts there and carries sharks in their slots.
    if (env.SPAR_PRETRIP === '1') {
        const faults = await Promise.all(groups.map(([a], i) => resupplies[i]?.resupply(a!, true) ?? null)); for (const fault of faults) if (fault) halted ??= `no trip before the meeting: ${fault}`;
        // With no later trip, our accounts need no loc and no ground item either.
        if (tripCount <= 1) for (const [a] of groups) lean(a!); }
    const results = await Promise.all(groups.map(([a, ...others], i) => gang(a!, others, options(0, i), (member: number) => options(1, i, member), undefined, () => halted !== undefined, tripCount > 1 ? resupplies[i] : resupplies[i] && { ...resupplies[i]!, count: 1 },
        { wait: env.SPAR_WAIT === undefined ? undefined : Number(env.SPAR_WAIT), gangTrips: gangTripsOf[i], idlePrayerOff: env.SPAR_IDLE_PRAYER_OFF === '1' })));
    for (const r of results) console.log(`GANG ${JSON.stringify({ profiles: { a: nameA, b: nameB }, kits: { a: kitA, b: kitList }, ...r })}`);
    const s = gangSummary(results), ok = results.every(gangValid) && halted === undefined;
    await finish(groups.flat(), ok, `gang groups=${s.groups} cleared=${s.cleared} died=${s.died} escaped=${s.escaped} away=${s.away} cap=${s.cap} kills=${s.kills} ticks=${s.ticks} a=${nameA} b=${nameB} `
        + `valid=${results.filter(gangValid).length} killsEach=${s.killsEach.join(',')} taken=${results.map(r => r.taken).join(',')} eaten=${results.map(r => r.eaten).join(',')} `
        + `food=${results.map(r => r.foodLeft).join(',')} prayer=${results.map(r => r.prayerLeft).join(',')} doses=${results.map(r => r.prayerDoses).join(',')} trips=${results.map(r => r.trips).join(',')} gangTrips=${results.map(r => r.gangTrips).join(',')} prayerOut=${results.map(r => r.prayerOut).join(',')} refused=${results.map(r => r.refused).join(',')}${halted ? ` halted=${halted}` : ''}`);
}
