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
// reach the deep Wilderness; HUNT_MAX_DEATHS the deaths that the hunt re-kits after (default 1; a PvP death sends the account to
// Lumbridge with 1 Hitpoints: it walks to the bank, eats up and wears its starting kit again); PK_OBSERVE=1 only watches and logs (it still fights back when attacked). Every player seen
// is logged as `HUNT seen` when first seen and whenever its verdict changes. openBot refuses a non-local server without DEMO_OK=1.
import { existsSync } from 'node:fs';
import type { Session } from '../../../core/src/inprocess';
import { isLocalServer } from '../../../core/src/localserver';
import { pvpDeathRefusal, recordPvpDeath } from '../../../core/src/pvp-deaths';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { attackable, bestFood, rewearStart, castableFreeze, defaultSpec, fightPlayer, getObjNames as objNames, isMulti, ITEMS, nextTick, observePlayer, packGain, recordKillLoot, SPELLS, wildernessLevel, type FightOptions, type FightResult, type Kit, type Style } from './fight';
import { armourDefence } from './pk-read';
import { accountServerBeforeLogin, assessWildernessThreat, connectRadar, hasVarrockTeleport, itemCost, planWildernessEscape, Radar, slashWebThrough, wildernessCombatMargin, wildernessDepth } from './wild-rules';
import { KitSwapper, protectOf, retreatOf, ThreatWatch } from './pk-threat';
import { PROFILES } from './pk-spar';
import { type ItemCount, type ItemRequirement, type RequirementResolution } from '../../../core/src/item-requirements';
import { lootCapacity } from '../../../core/src/loot-policy';
import {
    BOOST_POTIONS, BOW_TRIP, DEFAULT_MAX_DEATHS, EDGEVILLE_BANK, FOOD_LIST, FOOD_START_FLOOR,
    HUNT_PRESETS, HUNT_SPOTS, KIT_IDS, RESPAWN_TICKS, SNARE_KIT, SNARE_TRIP, TRIBRID_KIT, TRIP,
    eatUp, fleetNames, foodHeld, healOf, hitByPlayer, huntEnd, invalidTrip, kitToWear, maxDeathsOf, pickTarget,
    pickTrip, planFood, rekitAfterDeath, resolveHuntSpots, restock, shortageText, tripRequirements, verdict,
    type DeathRecord, type Spot, type TripItem, type TripPick,
} from './hunt-kits';
export * from './hunt-kits';

const huntProfileCache: Record<string, Partial<FightOptions>> = {};
async function huntProfile(combat: number): Promise<Partial<FightOptions>> {
    const want = process.env.HUNT_PROFILE ?? 'auto';
    const name = want === 'auto' ? (combat >= 115 ? 'champion' : '') : want === 'none' ? '' : want;
    if (!name) return {};
    if (!huntProfileCache[name]) {
        const { specBelow: _below, ...profile } = PROFILES[name] ?? (() => { throw new Error(`unknown HUNT_PROFILE ${name}`); })();
        huntProfileCache[name] = profile;
    }
    return huntProfileCache[name]!;
}
const walk = async (s: Session, to: { x: number; z: number }, stop: () => boolean, maxTicks = 400) =>
    walkPath(await sessionWalker(s), [{ ...to, tol: 2 }], { maxTicks, idleMs: 9000, stop });
const held = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);


export type HuntOptions = { cap: number; food: number; minFood: number; escapeAt: number; stop: () => boolean; log?: (l: string) => void;
    kit?: Kit; trip?: readonly TripItem[]; damageSpell?: number; rotation?: Style[]; teleSpell?: number;
    spots?: readonly Spot[]; observe?: boolean;
    // Deaths that the hunt re-kits after (default 1, DEFAULT_MAX_DEATHS). The death after that ends the run with its record.
    // `onDeath` is called for each death, at its tile (the death ledger of packages/core/src/pvp-deaths.ts).
    maxDeaths?: number; onDeath?: (near: { x: number; z: number } | null) => void;
    // The threat radar (scripts/pk-threat.ts, HUNT_THREAT=1): a protect prayer for the style of a threat, the armour swap of the pack, and a retreat
    // when a player outclasses us or a team comes. The hunt's own threat check stays.
    threats?: ThreatWatch };
export async function hunt(s: Session, o: HuntOptions) {
    const log = o.log ?? ((l: string) => console.log(l)), start = s.tick(), ours = fleetNames(), swapper = new KitSwapper();
    const tally = { kills: 0, deaths: 0, rekits: 0, retreatsFailed: 0, escapes: 0, fights: 0, looted: 0, trips: 0 };
    if (o.trip !== undefined) { const invalid = invalidTrip(o.trip); if (invalid.length) return { ...tally, end: 'invalid trip requirements ' + JSON.stringify(invalid) }; }
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
    let spot = 0, needsRestock = false;
    // A death: the account respawns at Lumbridge with 1 Hitpoints and what it kept. `afterDeath` re-kits it from the bank and
    // the next pass restocks the trip, or it returns the end of the run with the record of the death (rekitAfterDeath).
    const wornAtStart = (typeof s.sdk.getEquipment === 'function' ? s.sdk.getEquipment() : s.sdk.getState()?.equipment ?? []).map(e => ({ id: e.id, count: e.count ?? 1 }));
    let life = s.sdk.getState()?.player?.lifeId, lastTile: { x: number; z: number } | null = null;
    const died = () => { const p = s.sdk.getState()?.player; return !!p && life !== undefined && p.lifeId !== undefined && p.lifeId !== life; };
    const afterDeath = async (near: { x: number; z: number } | null | undefined): Promise<{ end: string; death: DeathRecord } | null> => {
        tally.deaths++;
        try { o.onDeath?.(near ?? lastTile); } catch (error) { log(`HUNT death ledger write failed: ${String(error)}`); }
        const record = await rekitAfterDeath(s, { lifeBefore: life, diedNear: near ?? lastTile, wornAtStart, stop: over, log, recordOnly: tally.deaths > (o.maxDeaths ?? DEFAULT_MAX_DEATHS) });
        life = record.lifeAfter ?? life;
        if (record.rekit !== 'ok') return { end: record.rekit === 'death limit' ? 'died' : 'died: ' + record.rekit, death: record };
        tally.rekits++; needsRestock = true;
        return null;
    };
    // The end of the run when nothing else ends it: a death on the way (a bank walk, a retreat, the last tick) is recovered or ends the run
    // as died, never as a plain failure, a stop or the cap. `openBot` no longer ends a death (continueAfterDeath), so each end checks it.
    const ending = async (end: string): Promise<{ end: string; death?: DeathRecord }> => {
        if (died()) { const d = await afterDeath(lastTile); if (d) return d; }
        return { end };
    };
    const far = () => { const p = s.sdk.getState()?.player; return !p || Math.max(Math.abs(p.worldX - EDGEVILLE_BANK.x), Math.abs(p.worldZ - EDGEVILLE_BANK.z)) > 60; };
    const exitWilderness = async (why: string): Promise<'out' | 'died' | 'failed'> => {
        const position = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ}` : ''; };
        for (let step = 0; step < 30 && !over(); step++) {
            const p = s.sdk.getState()?.player;
            if (!p) break;
            if (p.isDead || p.hp <= 0) return 'died';
            const wild = wildernessDepth(p.worldX, p.worldZ);
            if (wild === 0 && !far()) return 'out';
            const magicLv = s.sdk.getState()?.skills?.find(k => k.name === 'Magic')?.level ?? 1;
            const glory = s.sdk.getInventory().find(i => (ITEMS.glory as readonly number[]).includes(i.id));
            const teleSpell = o.teleSpell ?? (hasVarrockTeleport(magicLv, s.sdk.getInventory(), s.sdk.getEquipment()) ? SPELLS.varrockTeleport : undefined);
            const plan = wild === 0
                ? (glory ? { kind: 'glory' as const } : teleSpell !== undefined ? { kind: 'teleport' as const } : { kind: 'out' as const })
                : planWildernessEscape({ x: p.worldX, z: p.worldZ }, { glory: !!glory, teleport: teleSpell !== undefined });
            if (plan.kind === 'glory' && glory) {
                const op = glory.optionsWithIndex.find(x => /^Rub$/i.test(x.text));
                if (op) await s.sdk.sendUseItem(glory.slot, op.opIndex);
                for (let t = 0; t < 20 && far() && !over(); t++) {
                    await nextTick(s);
                    if (s.sdk.getState()?.dialog?.isOpen) await s.sdk.clickDialogByText(/^Edgeville/i);
                }
                if (!far()) return 'out';
                return 'failed';
            }
            if (plan.kind === 'teleport' && teleSpell !== undefined) {
                const from = position();
                await s.sdk.sendClickComponent(teleSpell);
                for (let t = 0; t < 12 && position() === from && !over(); t++) await nextTick(s);
                if (position() !== from) {
                    const walked = await walk(s, EDGEVILLE_BANK, over, 600);
                    return walked.ok ? 'out' : 'failed';
                }
                return 'failed';
            }
            if ((plan.kind === 'lever' || plan.kind === 'ladder') && plan.loc) {
                const findLoc = (loc: { id: number; x: number; z: number }) => s.sdk.getState()?.nearbyLocs.find(l => l.id === loc.id && Math.max(Math.abs(l.x - loc.x), Math.abs(l.z - loc.z)) <= 2)
                    ?? s.sdk.getState()?.nearbyLocs.find(l => l.id === loc.id);
                log(`HUNT ${why} via ${plan.detail}`);
                if (plan.web) await slashWebThrough(s, plan.web, over);
                await walk(s, { x: plan.loc.x, z: plan.loc.z }, over, 120);
                const exitLoc = findLoc(plan.loc);
                if (exitLoc && typeof s.bot?.interactLoc === 'function') {
                    await s.bot.interactLoc(exitLoc, plan.loc.option).catch(() => {});
                    await nextTick(s);
                    continue;
                }
            }
            if (wild > 0) {
                log(`HUNT ${why} walking south from level ${wild}`);
                await walk(s, { x: p.worldX, z: Math.max(3518, p.worldZ - 24) }, over, 80);
                continue;
            }
            return 'failed';
        }
        return far() ? 'failed' : 'out';
    };
    if (far()) {
        const res = await exitWilderness('retreat to Edgeville');
        if (res === 'died') { const d = await afterDeath(null); if (d) return { ...tally, ...d }; }
        else if (res === 'failed') {
            const p = s.sdk.getState()?.player;
            const magicLv = s.sdk.getState()?.skills?.find(k => k.name === 'Magic')?.level ?? 1;
            const hasTele = o.teleSpell !== undefined || hasVarrockTeleport(magicLv, s.sdk.getInventory(), s.sdk.getEquipment());
            if (p && wildernessDepth(p.worldX, p.worldZ) === 0 && !hasTele && !s.sdk.getInventory().some(i => (ITEMS.glory as readonly number[]).includes(i.id))) {
                return { ...tally, ...await ending('far from Edgeville with no glory or PK_TELE') };
            }
            return { ...tally, ...await ending(hasTele ? 'travel teleport did not move the account' : 'glory to Edgeville failed') };
        }
    }
    while (!over()) {
        if (died()) { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; }
        if (needsRestock || foodHeld(s) < o.minFood) {
            const back = await walk(s, EDGEVILLE_BANK, over, 600);
            // A death on the walk to the bank is recovered (the next pass restocks) or ends the run as died, whether or not the walk failed.
            if (died()) { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; continue; }
            if (!back.ok) return { ...tally, end: 'bank walk failed ' + JSON.stringify(back) };
            const missing = await restock(s, o.food, o.trip, kit, auto ? (bank, worn) => { const pick = pickTrip(bank, shallow, worn); kit = pick.kit; log(`HUNT trip ${pick.name}`); return pick; } : undefined);
            if (missing) return { ...tally, ...await ending(missing) };
            needsRestock = false;
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
            if (died()) { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; break; }
            lastTile = { x: me.worldX, z: me.worldZ };
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
            const self = { z: me.worldZ, combatLevel: me.combatLevel }, multi = isMulti(me.worldX, me.worldZ);
            for (const p of state.nearbyPlayers) {
                const v = verdict(self, p, ours, multi);
                if (sighted.get(p.name) === v) continue;
                sighted.set(p.name, v);
                log(`HUNT seen ${p.name} combat ${p.combatLevel} at ${p.x},${p.z} wild ${wildernessLevel(p.z)} ${v}${p.inCombat ? ` fighting ${p.combatTargetType}` : ''}`);
            }
            // HUNT_MIN_FOOD=<n>: no new fight of our own choosing with fewer than n pieces of food (an attacker is still
            // fought): a hunter that has spent its food on one kill does not take on the next target.
            const foodLeft = state.inventory.filter(i => i.optionsWithIndex?.some(op => /^eat$/i.test(op.text))).reduce((n, i) => n + i.count, 0);
            const magicLevel = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
            const hasGlory = state.inventory.some(i => (ITEMS.glory as readonly number[]).includes(i.id)) || s.sdk.getEquipment().some(i => (ITEMS.glory as readonly number[]).includes(i.id));
            const hasTele = o.teleSpell !== undefined || hasVarrockTeleport(magicLevel, state.inventory, s.sdk.getEquipment());
            const threat = attackerIndex === null ? assessWildernessThreat(
                { x: me.worldX, z: me.worldZ, combat: me.combatLevel, foodCount: foodLeft, glory: hasGlory, teleport: hasTele },
                state.nearbyPlayers.map(p => ({ ...p, wornWeapon: observePlayer(s.client, p.index)?.worn[3] })),
                ours,
            ) : null;
            // The threat radar: the armour swap first (it uses the tick), then a retreat that it decides when the hunt's own check has none.
            const radar = o.threats?.act ? o.threats.step(s.tick()) : null;
            if (radar && await swapper.step(s, radar.actions, s.tick(), () => nextTick(s), log)) continue;
            const radarReason = attackerIndex === null && radar ? retreatOf(radar.actions) : null;
            const retreatReason = threat?.retreatReason ?? radarReason;
            if (retreatReason) {
                if (!threat?.retreatReason && radarReason) o.threats!.acted(s.tick());
                const margin = wildernessCombatMargin({ z: me.worldZ, combat: me.combatLevel }, me.combatLevel);
                const escapePlan = threat?.escapePlan ?? planWildernessEscape({ x: me.worldX, z: me.worldZ }, { glory: hasGlory, teleport: hasTele });
                log(`HUNT threat retreat (${retreatReason}, bracket=${margin.minCombat}-${margin.maxCombat}): ${escapePlan.detail}`);
                needsRestock = true;
                if (wildernessLevel(me.worldZ) > 30 || threat?.multiPile) {
                    // The result of the retreat: a death is handled, and a retreat that did not leave the Wilderness is counted
                    // and logged. The restock walk that follows goes on south either way.
                    const out = await exitWilderness(retreatReason);
                    if (out === 'died') { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; }
                    else if (out === 'failed' && !died()) { tally.retreatsFailed++; log(`HUNT threat retreat did not leave the Wilderness (${retreatReason})`); }
                }
                break;
            }
            if (attackerIndex === null && (o.observe || me.hp < me.maxHp - 20 || foodLeft < Number(process.env.HUNT_MIN_FOOD ?? 0))) continue;
            const target = pickTarget(self, state.nearbyPlayers, ours, attackerIndex, process.env.HUNT_PICK !== 'near'
                ? p => { const o = observePlayer(s.client, p.index); return o ? armourDefence(o.worn.map(id => objNames().get(id) ?? '')).melee : 0; } : undefined, multi);
            if (!target) continue;
            log(`HUNT engage ${target.name} (combat ${target.combatLevel}) at ${target.x},${target.z}`);
            tally.fights++;
            const r: FightResult = await fightPlayer(s, target.name, {
                ...(o.threats?.act ? { threatPrayer: () => protectOf(o.threats!.step(s.tick()).actions, s.name) } : {}),
                // The freeze goes out when the target runs: cast whenever the target was free, it lost a stand-up spar (2 wins,
                // 4 losses), and a hunter with it killed no more runners (research/pvp-fight-loop.md).
                // The overhead changes one tick before the target's next attack: 42 kills to 6 in mirror spars against 24 to 24.
                kit: ownKit(kit), spec: defaultSpec(ownKit(kit)), freeze: castableFreeze(magicLevel, state.inventory) !== null ? 'flee' : false, exitOnDanger: true, predictPrayer: true, snapPrayer: true, counterRead: true, adaptStyles: true,
                escapeAt: o.escapeAt, escapeSpell: o.teleSpell, cap: 900, damageSpell: o.damageSpell, escapeOutnumbered: 2, allies: [...ours], stop: over, log,
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
            // The armour that a freeze stripped goes back on (pk.ts rewearStart): not after a death or a dropped session.
            if (r.outcome !== 'died' && r.outcome !== 'session ended') await rewearStart(s, wornAtStart.map(w => w.id), log);
            if (r.outcome === 'kill') {
                tally.kills++; const pack = s.sdk.getInventory().map(i => ({ id: i.id, count: i.count }));
                const n = await loot(s, r.targetAt ?? target, over); tally.looted += n;
                recordKillLoot(r, packGain(pack, s.sdk.getInventory()));
                log(`HUNT looted ${n} piles at ${JSON.stringify(r.targetAt ?? target)}`);
            }
            // A danger exit (no food, two attackers) leaves the fight but not the place: the escape (glory, teleport or a
            // run, the fight loop's own) goes at once, or each hit starts a new fight that stops at the danger check
            // again and the hunter stands until it dies (extra:hunt-pick).
            // So does a fight that the hunt's tick cap or stop ended (timeout): the hunt ends, and an account left
            // standing beside its attacker dies there. This escape has its own 200-tick cap and stops only out of the
            // Wilderness.
            const curP = s.sdk.getState()?.player;
            if (r.outcome === 'danger' || (r.outcome === 'timeout' && curP && wildernessDepth(curP.worldX, curP.worldZ) > 0)) {
                const e = await fightPlayer(s, target.name, { kit: ownKit(kit), exitOnDanger: false, escapeSpell: o.teleSpell, cap: 200, log,
                    predictPrayer: true, snapPrayer: true, flee: true });
                log(`HUNT escape after danger: ${e.outcome}`);
                if (e.outcome === 'escaped') { tally.escapes++; needsRestock = true; }
                else if (e.outcome === 'died') { const d = await afterDeath(r.targetAt ?? lastTile); if (d) return { ...tally, ...d }; }
                else {
                    const postP = s.sdk.getState()?.player;
                    if (postP && wildernessDepth(postP.worldX, postP.worldZ) > 0) {
                        const outRes = await exitWilderness('post-fight retreat');
                        if (outRes === 'died') { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; }
                        if (outRes === 'out') { tally.escapes++; needsRestock = true; }
                    }
                }
            }
            if (r.outcome === 'died') { const d = await afterDeath(r.targetAt ?? lastTile); if (d) return { ...tally, ...d }; break; }
            if (r.outcome === 'session ended') return { ...tally, end: 'session ended' };
            if (r.outcome === 'escaped') { tally.escapes++; needsRestock = true; }
            break;
        }
    }
    return { ...tally, ...await ending(ended ? 'session ended' : o.stop() ? 'stopped' : 'cap') };
}

// Pick up what the loser dropped near where it stood, most valuable stacks first, bones aside; eat food to free a slot for valuable drops.
export async function loot(s: Session, at: { x: number; z: number }, stop: () => boolean): Promise<number> {
    let taken = 0;
    // The drop lands after the death animation: wait up to 10 ticks for the first pile.
    const near = (g: { x: number; z: number; name: string }) => Math.max(Math.abs(g.x - at.x), Math.abs(g.z - at.z)) <= 3 && !/bones$/i.test(g.name);
    for (let wait = 0; wait < 10 && !stop() && !(s.sdk.getState()?.groundItems ?? []).some(near); wait++) await nextTick(s);
    for (let tries = 0; tries < 28 && !stop(); tries++) {
        const pile = (s.sdk.getState()?.groundItems ?? []).filter(near)
            .sort((a, b) => (itemCost(b.id) * b.count - itemCost(a.id) * a.count) || (a.distance - b.distance))[0];
        if (!pile) break;
        const native = (s.client as { objType?: (id: number) => { stackable: boolean } | undefined } | undefined)?.objType?.(pile.id);
        if (!lootCapacity({ inventory: s.sdk.getInventory() }, pile, native)) {
            if (typeof native?.stackable !== 'boolean') break;
            const meal = bestFood(s.sdk.getInventory());
            if (!meal || itemCost(pile.id) * pile.count < 1000) break;
            const afterMeal = s.sdk.getInventory().map(item => item.slot === meal.slot ? { ...item, count: item.count - 1 } : item).filter(item => item.count > 0);
            if (!lootCapacity({ inventory: afterMeal }, pile, native)) break;
            const before = held(s, meal.id);
            await s.bot.eatFood(meal);
            if (held(s, meal.id) !== before - 1 || !lootCapacity({ inventory: s.sdk.getInventory() }, pile, native)) break;
        }
        const before = held(s, pile.id), r = await s.bot.pickupItem(pile);
        if (!r.success || held(s, pile.id) !== before + pile.count) break;
        taken++;
    }
    return taken;
}

export async function runPkHuntCli(
    argv: readonly string[],
    env: Record<string, string | undefined> = process.env,
    existingSession?: Session,
): Promise<number> {
    const [bot, capArg] = argv;
    if (!bot) { console.log('usage: bun scripts/pk-hunt.ts <bot> [CAP ticks]'); return 2; }
    const { openBot, finish } = await import('../../../core/src/bot');
    let server = '';
    try { server = existingSession?.lifecycle?.server ?? accountServerBeforeLogin(bot); } catch (e) { console.log(`RESULT fail no server for ${bot}: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`); return 2; }
    const ledgerRefusal = pvpDeathRefusal({ accounts: [bot], server });
    if (ledgerRefusal) { console.log(`RESULT fail died ${ledgerRefusal}`); return 1; }
    const stop = () => existsSync(`.practice/stop-${bot}`) || existsSync('.practice/stop-pk-hunt');
    const s = existingSession ?? (await openBot(bot, { continueAfterDeath: true }));
    const threatRadar = env.HUNT_THREAT === '1' ? new Radar() : undefined;
    const closeRadar = threatRadar && !isLocalServer(server) ? connectRadar(server, threatRadar) : undefined;
    const threats = threatRadar ? new ThreatWatch({ sessions: () => [s], server, friends: fleetNames(), radar: threatRadar, log: l => console.log(l), act: env.HUNT_THREAT_ACT !== '0' }) : undefined;
    const r = await hunt(s, { threats, cap: Number(capArg ?? 6000), food: Number(env.HUNT_FOOD ?? 18), minFood: Number(env.MIN_FOOD ?? 6), escapeAt: Number(env.ESCAPE_AT ?? 35), stop,
        kit: env.PK_KIT === 'snare' ? SNARE_KIT : env.PK_KIT ? JSON.parse(env.PK_KIT) as Kit : undefined, trip: env.PK_TRIP ? JSON.parse(env.PK_TRIP) : env.PK_KIT === 'snare' ? SNARE_TRIP : undefined, damageSpell: env.PK_SPELL ? Number(env.PK_SPELL) : undefined,
        rotation: env.PK_ROTATION ? env.PK_ROTATION.split(',') as Style[] : undefined, teleSpell: env.PK_TELE ? Number(env.PK_TELE) : undefined,
        spots: resolveHuntSpots(env), observe: env.PK_OBSERVE === '1', maxDeaths: maxDeathsOf(env.HUNT_MAX_DEATHS),
        onDeath: near => { recordPvpDeath({ account: bot, server, at: Date.now(), script: 'scripts/aio-pvp.ts', near }); } });
    closeRadar?.();
    console.log('HUNT ' + JSON.stringify(r));
    if (existingSession) {
        if (r.end === 'session ended') return 1;
        return huntEnd(r).ok ? 0 : 1;
    }
    if (r.end === 'session ended') { await finish([s], false, 'session ended: disconnected'); return 1; }
    const end = huntEnd(r);
    await finish([s], end.ok, end.detail);
    return end.ok ? 0 : 1;
}
