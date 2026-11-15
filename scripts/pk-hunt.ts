// PK hunter: restocks a tribrid kit at Edgeville bank, walks into the shallow Wilderness north of Edgeville, fights the
// nearest attackable player who is not a fleet account (or anyone who attacks it) with scripts/pk.ts, loots a kill and
// banks again when food runs low or after a glory escape. A death ends the run; so do the tick cap and a stop file.
// Usage: bun scripts/pk-hunt.ts <bot> [CAP ticks, default 6000]. Environment: HUNT_FOOD sharks per trip (default 18),
// MIN_FOOD sharks that send it back to bank (default 6), ESCAPE_AT HP (default 35). For a build other than the maxed
// tribrid: PK_KIT the switch weapons as JSON {"magic":[ids],"ranged":[ids],"melee":[ids]}, PK_TRIP what a trip carries
// besides sharks as JSON [{"id":n,"count":n}], PK_SPELL the damage spell's component id (scripts/pk.ts SPELLS),
// PK_ROTATION the style order, e.g. "ranged,magic" for a pure with Strength 1, PK_TELE a teleport spell's component
// id (scripts/pk.ts SPELLS) used where no glory is carried, both to reach Edgeville and to escape. An account that starts
// more than 60 tiles from Edgeville rubs a carried glory there first, or casts PK_TELE and walks on. PK_SPOTS replaces
// the hunt spots as JSON [{"x":n,"z":n,"dwell":ticks}], visited in order (dwell 0 makes a waypoint), so a route can
// reach the deep Wilderness; PK_OBSERVE=1 only watches and logs (it still fights back when attacked). Every player seen
// is logged as `HUNT seen` when first seen and whenever its verdict changes. openBot refuses a non-local server without DEMO_OK=1.
import { existsSync } from 'node:fs';
import type { Session } from '../packages/core/src/inprocess';
import { loadOwners } from '../packages/core/src/fleet';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { attackable, bestFood, castableFreeze, defaultSpec, fightPlayer, getObjNames as objNames, ITEMS, nextTick, observePlayer, wildernessLevel, type FightOptions, type FightResult, type Kit, type Style } from './pk';
import { armourDefence } from './pk-read';
import { itemCost } from './pk-roam';

// HUNT_PROFILE=<profile of scripts/pk-spar.ts>: that profile's fight options for each fight of the hunt (the kit,
// special weapon, escape and caps stay the hunt's). auto (default): the champion for a hunter of combat 115 or more,
// as the roam (research/pvp-fight-loop.md finding 58); none: the hunt's own options.
const huntProfileCache: Record<string, Partial<FightOptions>> = {};
async function huntProfile(combat: number): Promise<Partial<FightOptions>> {
    const want = process.env.HUNT_PROFILE ?? 'auto';
    const name = want === 'auto' ? (combat >= 115 ? 'champion' : '') : want === 'none' ? '' : want;
    if (!name) return {};
    if (!huntProfileCache[name]) {
        const { PROFILES } = await import('./pk-spar');
        const { specBelow: _below, ...profile } = PROFILES[name] ?? (() => { throw new Error(`unknown HUNT_PROFILE ${name}`); })();
        huntProfileCache[name] = profile;
    }
    return huntProfileCache[name]!;
}

export const EDGEVILLE_BANK = { x: 3092, z: 3496 };
// Wilderness levels 3-7 north of Edgeville, inside single-way combat (multiway.csv: east Wilderness starts at x 3136).
export type Spot = { x: number; z: number; dwell?: number };
export const HUNT_SPOTS: readonly Spot[] = [{ x: 3094, z: 3540 }, { x: 3100, z: 3556 }, { x: 3094, z: 3562 }];
export const KIT_IDS = { mysticFireStaff: 1401, magicShortbow: 861, runeArrow: 892, dragonDaggerP: 1231, runeKiteshield: 1201 } as const;
export const TRIBRID_KIT: Kit = { magic: [KIT_IDS.mysticFireStaff], ranged: [KIT_IDS.magicShortbow], melee: [KIT_IDS.dragonDaggerP, KIT_IDS.runeKiteshield] };
// What a trip carries besides food: the switch weapons, Fire Wave runes (air, blood; the staff gives fire), two prayer
// potions and a glory for the escape.
export const TRIP: readonly { id: number; count: number }[] = [
    { id: KIT_IDS.mysticFireStaff, count: 1 }, { id: KIT_IDS.magicShortbow, count: 1 },
    { id: ITEMS.airRune, count: 300 }, { id: ITEMS.bloodRune, count: 60 }, { id: 2434, count: 2 }, { id: ITEMS.glory[0], count: 1 },
] as const;

// The snare kit (scripts/pk-kits.ts tribrid-snare): bow and dagger for the fight, the runes of Entangle for a target that
// runs (5 earth, 5 water and 4 nature a cast), no staff and no wave runes. It beat the staff kit against the melee
// build, the hybrid and the ranger (research/pvp-fight-loop.md). PK_KIT=snare selects the kit and this trip.
export const SNARE_KIT: Kit = { ranged: [KIT_IDS.magicShortbow], melee: [KIT_IDS.dragonDaggerP, KIT_IDS.runeKiteshield] };
export const SNARE_TRIP: readonly { id: number; count: number }[] = [
    { id: KIT_IDS.magicShortbow, count: 1 }, { id: ITEMS.earthRune, count: 50 }, { id: ITEMS.waterRune, count: 50 }, { id: ITEMS.natureRune, count: 40 },
    { id: 2434, count: 2 }, { id: ITEMS.glory[0], count: 1 },
] as const;

// Never fight our own accounts: every fleet side's owners plus the main account.
export function fleetNames(owners = loadOwners()): Set<string> {
    return new Set([...owners.keys(), 'haggis'].map(n => n.toLowerCase()));
}

type Seen = { index: number; name: string; combatLevel: number; z: number; distance: number; inCombat?: boolean; combatTargetType?: string };
// Why a seen player is or is not a target: a fleet account, outside the Wilderness combat range, already in a player
// fight (single-way combat refuses a second attacker), or attackable.
export function verdict(me: { z: number; combatLevel: number }, p: Seen, ours: Set<string>): 'fleet' | 'out of range' | 'busy' | 'attackable' {
    if (ours.has(p.name.toLowerCase())) return 'fleet';
    if (!attackable(me, p)) return 'out of range';
    if (p.inCombat && p.combatTargetType === 'player') return 'busy';
    return 'attackable';
}
// The player to fight: whoever is hitting us first, else the nearest attackable stranger who is not fighting someone else.
// The hunt's choice (HUNT_PICK, default soft): of the attackable players, the one whose worn armour gives the least
// melee defence (read from what the client shows it wearing), then the nearest; HUNT_PICK=near takes the nearest.
export function pickTarget<P extends Seen>(me: { z: number; combatLevel: number }, players: readonly P[], ours: Set<string>, attackerIndex: number | null,
    armour?: (p: P) => number): P | undefined {
    const attacker = attackerIndex === null ? undefined : players.find(p => p.index === attackerIndex);
    if (attacker) return attacker;
    return [...players].filter(p => verdict(me, p, ours) === 'attackable').sort((a, b) => (armour ? armour(a) - armour(b) : 0) || a.distance - b.distance)[0];
}

// A hit we took from another player. The SDK also reports an NPC's damage from someone else as damage_taken, with
// targetType npc and source index -1; those are not attacks on us.
export const hitByPlayer = (e: { type: string; sourceType: string; targetType: string; sourceIndex: number }) =>
    e.type === 'damage_taken' && e.sourceType === 'other_player' && e.targetType === 'player' && e.sourceIndex >= 0;

const held = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

async function walk(s: Session, to: { x: number; z: number }, stop: () => boolean, maxTicks = 400) {
    return walkPath(await sessionWalker(s), [{ ...to, tol: 2 }], { maxTicks, idleMs: 9000, stop });
}

// One of each boost the fight loop drinks, in any dose.
export const BOOST_POTIONS = [ITEMS.superAttack, ITEMS.superStrength, ITEMS.rangingPotion] as const;
// Re-equip the melee set and any unequipped body armour, bank everything else in the pack, then withdraw the trip and food.
// The bow trip: the snare trip with no runes and three more sharks in their place. In a stand-up fight the kit with 21
// sharks and no freeze beat the snare kit 33 to 13 (research/pvp-fight-loop.md), and up to Wilderness level 30 a
// glory works at once, so no freeze holds a target there.
export const BOW_TRIP: readonly { id: number; count: number }[] = [{ id: KIT_IDS.magicShortbow, count: 1 }, { id: 2434, count: 2 }, { id: ITEMS.glory[0], count: 1 }] as const;
export type TripPick = { name: 'bow' | 'snare' | 'staff'; kit: Kit; trip: readonly { id: number; count: number }[]; moreFood: number };
// The trip a bank can fill. `shallow`: every hunt spot is at Wilderness level 30 or less; the bow trip is first there.
// Else the snare trip where the bank holds all of it, else the staff trip.
export function pickTrip(bank: readonly { id: number; count: number }[], shallow = false): TripPick {
    const holds = (want: { id: number; count: number }) => (bank.find(b => b.id === want.id)?.count ?? 0) >= want.count;
    if (shallow && BOW_TRIP.every(holds)) return { name: 'bow', kit: SNARE_KIT, trip: BOW_TRIP, moreFood: 3 };
    return SNARE_TRIP.every(holds) ? { name: 'snare', kit: SNARE_KIT, trip: SNARE_TRIP, moreFood: 0 } : { name: 'staff', kit: TRIBRID_KIT, trip: TRIP, moreFood: 0 };
}

// `choose` picks the trip from the bank once the pack is banked (the hunter with no kit named: pickTrip).
// Each potion's ids, four doses first (scripts/pk.ts ITEMS).
export const POTION_DOSES: readonly (readonly number[])[] = [ITEMS.prayerPotion, ITEMS.superRestore, ITEMS.superAttack, ITEMS.attackPotion, ITEMS.superStrength,
    ITEMS.strengthPotion, ITEMS.superDefence, ITEMS.defencePotion, ITEMS.rangingPotion, ITEMS.magicPotion, ITEMS.antipoison.slice(0, 4), ITEMS.antipoison.slice(4)];
export async function restock(s: Session, food: number, trip: readonly { id: number; count: number }[] = TRIP, kit: Kit = TRIBRID_KIT,
    choose?: (bank: readonly { id: number; count: number }[]) => { trip: readonly { id: number; count: number }[]; moreFood: number }): Promise<string | null> {
    const equip = typeof s.sdk.getEquipment === 'function' ? () => s.sdk.getEquipment() : () => s.sdk.getState()?.equipment ?? [];
    let switched = false;
    for (const item of [...s.sdk.getInventory()]) {
        if (!(kit.melee ?? []).includes(item.id) && !/(platebody|chainbody)/i.test(item.name)) continue;
        if (equip().some(e => e.id === item.id)) continue;
        const op = item.optionsWithIndex?.find(x => /^(Wield|Wear)$/i.test(x.text));
        if (op) { await s.sdk.sendUseItem(item.slot, op.opIndex); switched = true; }
    }
    if (switched && typeof s.onTick === 'function') await nextTick(s);
    if (!(await s.bot.openBank()).success) return 'bank did not open';
    for (const item of [...s.sdk.getInventory()]) await s.bot.depositItem(item, -1);
    if (choose) { const pick = choose(s.sdk.getBankItems()); trip = pick.trip; food += pick.moreFood; }
    const stock = () => s.bankObservation?.()?.items ?? [];
    // Boost potions where the bank holds them, each for one shark: a tribrid with a super attack, a super strength and a
    // ranging potion won 11 of 16 spars against the same kit with three more sharks (research/pvp-fight-loop.md). The
    // fight loop drinks them. A bank with none is no fault: the trip goes on with food alone.
    let boosts = 0;
    for (const doses of BOOST_POTIONS) {
        if (boosts >= food - 1) break;
        const row = s.sdk.getBankItems().find(b => (doses as readonly number[]).includes(b.id) && b.count > 0);
        if (row) { await s.bot.withdrawItem(row, 1, { asNote: false }); boosts++; }
    }
    food -= boosts;
    for (const want of [...trip, { id: ITEMS.shark, count: food }]) {
        // Held already: worn, or in the pack (a two-handed bow that the melee wield above takes off can come to the pack
        // after the deposit).
        const wornCount = equip().filter(e => e.id === want.id).reduce((n, e) => n + e.count, 0) + (want.id === ITEMS.shark ? 0 : held(s, want.id));
        const need = want.count - wornCount;
        if (need <= 0) continue;
        // A potion is taken in any of its doses, the fullest first: a bank holds what earlier trips left (POTION_DOSES).
        const kin = POTION_DOSES.find(g => g.includes(want.id)) ?? [want.id];
        const rows = kin.flatMap(id => s.sdk.getBankItems().filter(b => b.id === id && b.count > 0));
        if (rows.reduce((n, r) => n + r.count, 0) < need) { await s.bot.closeBank(); return `bank lacks ${need} of item ${want.id} (has ${kin.reduce((n, id) => n + (stock().find(b => b.id === id)?.count ?? 0), 0)}; worn ${equip().map(e => e.id).join(',')}; pack ${s.sdk.getInventory().map(i => i.id).join(',')})`; }
        let left = need;
        for (const row of rows) { if (left <= 0) break; const take = Math.min(left, row.count); await s.bot.withdrawItem(row, take, { asNote: false }); left -= take; }
    }
    await s.bot.closeBank();
    return held(s, ITEMS.shark) >= food ? null : 'food withdrawal short';
}

export type HuntOptions = { cap: number; food: number; minFood: number; escapeAt: number; stop: () => boolean; log?: (l: string) => void;
    kit?: Kit; trip?: readonly { id: number; count: number }[]; damageSpell?: number; rotation?: Style[]; teleSpell?: number;
    spots?: readonly Spot[]; observe?: boolean };
export async function hunt(s: Session, o: HuntOptions) {
    const log = o.log ?? ((l: string) => console.log(l)), start = s.tick(), ours = fleetNames();
    const tally = { kills: 0, deaths: 0, escapes: 0, fights: 0, looted: 0, trips: 0 };
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const over = () => ended || o.stop() || s.tick() - start >= o.cap;
    // With no kit and no trip named, each restock takes the snare trip where the bank holds it: it won more spars than
    // the staff trip (research/pvp-fight-loop.md, finding 25).
    const auto = !o.kit && !o.trip, sighted = new Map<string, string>();
    let kit = o.kit ?? TRIBRID_KIT;
    // The shield the hunter wears at the start takes the rune kiteshield's place in the melee list: a fixed list put
    // no other shield back on after a two-handed bow turn (a dragon square shield came off for good).
    const startShield = s.sdk.getEquipment().find(e => e.slot === 5)?.id;
    const ownKit = (k: Kit): Kit => (startShield === undefined || startShield === KIT_IDS.runeKiteshield ? k
        : { ...k, melee: (k.melee ?? []).map(id => (id === KIT_IDS.runeKiteshield ? startShield : id)) });
    const shallow = (o.spots ?? HUNT_SPOTS).every(sp => wildernessLevel(sp.z) <= 30);
    let spot = 0;
    const far = () => { const p = s.sdk.getState()?.player; return !p || Math.max(Math.abs(p.worldX - EDGEVILLE_BANK.x), Math.abs(p.worldZ - EDGEVILLE_BANK.z)) > 60; };
    if (far()) {
        const glory = s.sdk.getInventory().find(i => (ITEMS.glory as readonly number[]).includes(i.id));
        const position = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ}` : ''; };
        if (glory) {
            const op = glory.optionsWithIndex.find(x => /^Rub$/i.test(x.text));
            if (op) await s.sdk.sendUseItem(glory.slot, op.opIndex);
            for (let t = 0; t < 20 && far() && !over(); t++) {
                await nextTick(s);
                if (s.sdk.getState()?.dialog?.isOpen) await s.sdk.clickDialogByText(/^Edgeville/i);
            }
            if (far()) return { ...tally, end: 'glory to Edgeville failed' };
        } else if (o.teleSpell !== undefined) {
            const from = position();
            await s.sdk.sendClickComponent(o.teleSpell);
            for (let t = 0; t < 12 && position() === from && !over(); t++) await nextTick(s);
            if (position() === from) return { ...tally, end: 'travel teleport did not move the account' };
            const walked = await walk(s, EDGEVILLE_BANK, over, 600);
            if (!walked.ok) return { ...tally, end: 'walk from the teleport to Edgeville failed ' + JSON.stringify(walked) };
        } else return { ...tally, end: 'far from Edgeville with no glory or PK_TELE' };
    }
    while (!over()) {
        if (held(s, ITEMS.shark) < o.minFood) {
            const back = await walk(s, EDGEVILLE_BANK, over, 600);
            if (!back.ok) return { ...tally, end: 'bank walk failed ' + JSON.stringify(back) };
            const missing = await restock(s, o.food, o.trip, kit, auto ? bank => { const pick = pickTrip(bank, shallow); kit = pick.kit; log(`HUNT trip ${pick.name}`); return pick; } : undefined);
            if (missing) return { ...tally, end: missing };
            tally.trips++;
        }
        const spots = o.spots ?? HUNT_SPOTS, here = spots[spot % spots.length]!;
        const out = await walk(s, here, over);
        spot++;
        if (!out.ok && !over()) { log(`HUNT walk to spot failed ${JSON.stringify(out)}`); continue; }
        // Wait at the spot for a target or an attacker.
        let attackerIndex: number | null = null, seen = 0, foodReady = 0;
        const waitUntil = s.tick() + (here.dwell ?? 60);
        while (!over() && s.tick() < waitUntil) {
            await nextTick(s);
            const state = s.sdk.getState(), me = state?.player;
            if (!state || !me) continue;
            let maxSeen = seen;
            for (const e of state.combatEvents) {
                const id = e.observationId ?? e.tick;
                if (id <= seen) continue;
                if (id > maxSeen) maxSeen = id;
                if (hitByPlayer(e)) attackerIndex = e.sourceIndex;
            }
            seen = maxSeen;
            // Heal between fights: eat while 20 or more under full, and start a fight only near full unless attacked.
            const meal = bestFood(state.inventory);
            if (me.hp <= me.maxHp - 20 && meal && s.tick() >= foodReady) {
                const op = meal.optionsWithIndex.find(x => /^Eat$/i.test(x.text));
                if (op) { void s.sdk.sendUseItem(meal.slot, op.opIndex); foodReady = s.tick() + 3; }
            }
            const self = { z: me.worldZ, combatLevel: me.combatLevel };
            for (const p of state.nearbyPlayers) {
                const v = verdict(self, p, ours);
                if (sighted.get(p.name) === v) continue;
                sighted.set(p.name, v);
                log(`HUNT seen ${p.name} combat ${p.combatLevel} at ${p.x},${p.z} wild ${wildernessLevel(p.z)} ${v}${p.inCombat ? ` fighting ${p.combatTargetType}` : ''}`);
            }
            // HUNT_MIN_FOOD=<n>: no new fight of our own choosing with fewer than n pieces of food (an attacker is still
            // fought): a hunter that has spent its food on one kill does not take on the next target.
            const foodLeft = state.inventory.filter(i => i.optionsWithIndex?.some(op => /^eat$/i.test(op.text))).reduce((n, i) => n + i.count, 0);
            if (attackerIndex === null && (o.observe || me.hp < me.maxHp - 20 || foodLeft < Number(process.env.HUNT_MIN_FOOD ?? 0))) continue;
            const target = pickTarget(self, state.nearbyPlayers, ours, attackerIndex, process.env.HUNT_PICK !== 'near'
                ? p => { const o = observePlayer(s.client, p.index); return o ? armourDefence(o.worn.map(id => objNames().get(id) ?? '')).melee : 0; } : undefined);
            if (!target) continue;
            log(`HUNT engage ${target.name} (combat ${target.combatLevel}) at ${target.x},${target.z}`);
            tally.fights++;
            const magicLevel = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
            const r: FightResult = await fightPlayer(s, target.name, {
                // The freeze goes out when the target runs: cast whenever the target was free, it lost a stand-up spar (2 wins,
                // 4 losses), and a hunter with it killed no more runners (research/pvp-fight-loop.md).
                // The overhead changes one tick before the target's next attack: 42 kills to 6 in mirror spars against 24 to 24.
                kit: ownKit(kit), spec: defaultSpec(ownKit(kit)), freeze: castableFreeze(magicLevel, state.inventory) !== null ? 'flee' : false, exitOnDanger: true, predictPrayer: true, snapPrayer: true, counterRead: true, adaptStyles: true,
                escapeAt: o.escapeAt, escapeSpell: o.teleSpell, cap: 900, damageSpell: o.damageSpell, stop: over, log,
                // A stand-up fight with bow and dagger only: a spell takes 5 ticks, the bow 3 and the dagger 4. Magic stays
                // for the freeze. Random styles: an overhead that predicts cannot follow them.
                rotation: o.rotation ?? (kit.ranged?.length && kit.melee?.length ? ['ranged', 'melee'] : undefined), mixStyles: true,
                ...(await huntProfile(me.combatLevel)),
                // HUNT_RACE_WINDOW: the ticks of the danger check's damage race (default the fight loop's 30).
                ...(process.env.HUNT_RACE_WINDOW ? { raceWindow: Number(process.env.HUNT_RACE_WINDOW) } : {}),
                // HUNT_EXIT=0: no danger exit; the fight goes on to its own escape rules (escapeAt and the crowd escape).
                ...(process.env.HUNT_EXIT === '0' ? { exitOnDanger: false } : {}),
                // HUNT_RACE=0: the danger exit keeps its food, crowd and prayer rules and leaves the damage race out.
                ...(process.env.HUNT_RACE === '0' ? { raceExit: false } : {}),
                // HUNT_PRESS=<fraction>: the no-food exit waits while the target's health bar is at that or lower.
                ...(process.env.HUNT_PRESS ? { pressLow: Number(process.env.HUNT_PRESS) } : {}),
                // HUNT_NOFOOD=<multiple>: the no-food exit at that many times the opponent's max hit (default 1.5).
                ...(process.env.HUNT_NOFOOD ? { noFoodAt: Number(process.env.HUNT_NOFOOD) } : {}),
            });
            log(`HUNT fight ${r.outcome} ${JSON.stringify(r)}`);
            if (r.outcome === 'kill') {
                tally.kills++; const n = await loot(s, r.targetAt ?? target, over); tally.looted += n;
                log(`HUNT looted ${n} piles at ${JSON.stringify(r.targetAt ?? target)}`);
            }
            // A danger exit (no food, two attackers) leaves the fight but not the place: the escape (glory, teleport or a
            // run, the fight loop's own) goes at once, or each hit starts a new fight that stops at the danger check
            // again and the hunter stands until it dies (extra:hunt-pick).
            // So does a fight that the hunt's tick cap or stop ended (timeout): the hunt ends, and an account left
            // standing beside its attacker dies there. This escape has its own 200-tick cap and stops only out of the
            // Wilderness.
            if (r.outcome === 'danger' || (r.outcome === 'timeout' && wildernessLevel(s.sdk.getState()?.player?.worldZ ?? 0) > 0)) {
                const e = await fightPlayer(s, target.name, { kit: ownKit(kit), exitOnDanger: false, escapeSpell: o.teleSpell, cap: 200, log,
                    predictPrayer: true, snapPrayer: true, flee: true });
                log(`HUNT escape after danger: ${e.outcome}`);
                if (e.outcome === 'escaped') tally.escapes++;
                if (e.outcome === 'died') { tally.deaths++; return { ...tally, end: 'died' }; }
            }
            if (r.outcome === 'died') { tally.deaths++; return { ...tally, end: 'died' }; }
            if (r.outcome === 'session ended') return { ...tally, end: 'session ended' };
            if (r.outcome === 'escaped') { tally.escapes++; }
            break;
        }
    }
    return { ...tally, end: ended ? 'session ended' : o.stop() ? 'stopped' : 'cap' };
}

// Pick up what the loser dropped near where it stood, most valuable stacks first, bones aside; eat food to free a slot for valuable drops.
async function loot(s: Session, at: { x: number; z: number }, stop: () => boolean): Promise<number> {
    let taken = 0;
    // The drop lands after the death animation: wait up to 10 ticks for the first pile.
    const near = (g: { x: number; z: number; name: string }) => Math.max(Math.abs(g.x - at.x), Math.abs(g.z - at.z)) <= 3 && !/bones$/i.test(g.name);
    for (let wait = 0; wait < 10 && !stop() && !(s.sdk.getState()?.groundItems ?? []).some(near); wait++) await nextTick(s);
    for (let tries = 0; tries < 28 && !stop(); tries++) {
        const pile = (s.sdk.getState()?.groundItems ?? []).filter(near)
            .sort((a, b) => (itemCost(b.id) * b.count - itemCost(a.id) * a.count) || (a.distance - b.distance))[0];
        if (!pile) break;
        const stacks = s.sdk.getInventory().some(i => i.id === pile.id && i.count > 1);
        if (s.sdk.getInventory().length >= 28 && !stacks) {
            const meal = bestFood(s.sdk.getInventory());
            if (!meal || itemCost(pile.id) * pile.count < 1000) break;
            await s.bot.eatFood(meal);
        }
        const r = await s.bot.pickupItem(pile);
        if (!r.success) break;
        taken++;
    }
    return taken;
}

if (import.meta.main) {
    const [bot, capArg] = process.argv.slice(2);
    if (!bot) { console.log('usage: bun scripts/pk-hunt.ts <bot> [CAP ticks]'); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const stop = () => existsSync(`.practice/stop-${bot}`) || existsSync('.practice/stop-pk-hunt');
    const s = await openBot(bot);
    const env = process.env;
    const r = await hunt(s, { cap: Number(capArg ?? 6000), food: Number(env.HUNT_FOOD ?? 18), minFood: Number(env.MIN_FOOD ?? 6), escapeAt: Number(env.ESCAPE_AT ?? 35), stop,
        kit: env.PK_KIT === 'snare' ? SNARE_KIT : env.PK_KIT ? JSON.parse(env.PK_KIT) as Kit : undefined, trip: env.PK_TRIP ? JSON.parse(env.PK_TRIP) : env.PK_KIT === 'snare' ? SNARE_TRIP : undefined, damageSpell: env.PK_SPELL ? Number(env.PK_SPELL) : undefined,
        rotation: env.PK_ROTATION ? env.PK_ROTATION.split(',') as Style[] : undefined, teleSpell: env.PK_TELE ? Number(env.PK_TELE) : undefined,
        spots: env.PK_SPOTS ? JSON.parse(env.PK_SPOTS) as Spot[] : undefined, observe: env.PK_OBSERVE === '1' });
    console.log('HUNT ' + JSON.stringify(r));
    // A dropped session reports the swarm's drain wording (planner DRAIN_RESULT), not a hunt outcome.
    if (r.end === 'session ended') await finish([s], false, 'session ended: disconnected');
    await finish([s], r.end !== 'died' && !/failed|lacks|short|did not open/.test(r.end), `hunt ${r.end} kills ${r.kills}`);
}
