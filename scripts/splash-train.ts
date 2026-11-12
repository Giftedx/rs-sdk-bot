// Magic for the PK army with no fire rune, nature rune or feather: a curse cast over the fence of the Ardougne cow field.
// bun scripts/splash-train.ts <account> <TARGET_LEVEL> [CAP ticks=6000]
// Env: SPLASH_SITE=ardougne (default: the cows, with the bank) or coop (Lumbridge chickens, from the pack, no bank).
//
// Server facts (vendor/rs-sdk/server/content/scripts):
// - A stat-lowering spell on a monster takes its runes and gives its experience on every cast, hit or miss
//   (skill_combat/scripts/player/player_magic.rs2 pvm_spell_cast), and does no damage. A cast that hits lowers the
//   stat, and a cast on a monster whose stat is under its base is refused with no rune taken ("Your foe's defence has
//   already been weakened.", pvm_debuff_allowed) until the stat grows back.
// - Curse (Magic 19): 1 body, 2 water, 3 earth runes, 29 experience (725 at this server's 25 times). Weaken (11) and
//   Confuse (3): 1 body, 3 water, 2 earth, 21 and 13 (525 and 325). Wind Strike (1): 1 mind, 1 air, 5.5 (137).
//   skill_combat/configs/magic/magic_combat_spells.dbrow.
// - This server's level curve is flat (packages/planner/src/curve.ts): Magic 66, the level the Magic Guild's door in
//   Yanille asks, is 100,775 experience, so 135 curses from Magic 21 and 144 casts from Magic 1.
// - The field north of the Ardougne north bank holds ten cows behind a fence (maps/m41_52.jm2). From the tile south of
//   the fence a cast reaches the cows and no cow reaches the caster: a cow fights only a player beside it.
// Practice, from 2664,3339: 40 curses in 608 ticks alone; two accounts at once from Magic 1 and 21 made 138 and 135
// casts in 4,043 and 4,011 ticks; every curse 725 experience, no hitpoint lost (research/combat-measure.md, Magic by a
// curse over the fence). The run goes round the cows it can see and waits when all of them are weakened.
// The run banks its pack at the Ardougne north bank, takes the runes its casts need, casts from the fence tile, and
// banks what is left. It changes nothing the account wears.
import { existsSync } from 'node:fs';
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { componentId } from '../packages/core/src/logout';
import { xpForLevel } from '../packages/planner/src/curve';
import { initPathfinding } from '../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { COW_NORTH_BANK, atNorthBank } from './cow-stage';
import { walkTargetPersist } from './walk-to';

type Item = { id: number; count: number };
export const BODY = 559, WATER = 555, EARTH = 557, MIND = 558, AIR = 556;
// Best spell first. `runes` are a cast's cost.
export const SPLASH_SPELLS = [
    { level: 19, component: 'magic:curse', xp: 725, runes: { [BODY]: 1, [WATER]: 2, [EARTH]: 3 } },
    { level: 11, component: 'magic:weaken', xp: 525, runes: { [BODY]: 1, [WATER]: 3, [EARTH]: 2 } },
    { level: 3, component: 'magic:confuse', xp: 325, runes: { [BODY]: 1, [WATER]: 3, [EARTH]: 2 } },
    { level: 1, component: 'magic:wind_strike', xp: 137, runes: { [MIND]: 1, [AIR]: 1 } },
] as const;
export const SPLASH_RUNES = [BODY, WATER, EARTH, MIND, AIR] as const;
// The tile south of the field's fence, the cows (a cow is 2 tiles wide), and a spell's reach.
export const SPLASH_TILE = { x: 2664, z: 3339 }, COWS = [81, 397] as const, COW_SIZE = 2, CAST_RANGE = 9;
// SPLASH_SITE=coop is the record route's opening (rune.fast, "Wind Strike at the coop"): a fresh account casts Wind
// Strike from its starter pack at the Lumbridge chickens, with no bank. The tile south of the coop
// (pathfinder and line of sight: 115 of the 139 walkable coop tiles in reach) is open to the chickens, and a struck
// chicken hits back, so the run stops only at the hitpoint floor, not at the first hit.
export interface SplashSite { tile: { x: number; z: number }; target: (n: { id: number; name: string }) => boolean; size: number; bank: boolean; hpFloor?: number }
export const SPLASH_SITES: Readonly<Record<string, SplashSite>> = {
    ardougne: { tile: SPLASH_TILE, target: n => (COWS as readonly number[]).includes(n.id), size: COW_SIZE, bank: true },
    coop: { tile: { x: 3229, z: 3292 }, target: n => /^chicken$/i.test(n.name), size: 1, bank: false, hpFloor: 5 },
};
export function splashSite(name = 'ardougne'): SplashSite {
    const site = SPLASH_SITES[name];
    if (!site) throw Error(`SPLASH_SITE must be ${Object.keys(SPLASH_SITES).join(' or ')}, not ${name}`);
    return site;
}
// Ticks a cow is left alone after a cast on it or a refusal, and after a cast that did nothing. A monster regrows one
// level of a lowered stat every 100 ticks (engine NpcType.regenrate), so a hit cow takes a cast again 0 to 100 ticks
// later, and the ten cows give the field about one cast in ten ticks, shared by its casters.
// CAST_GAP: the spell's delay, waited out before the next cast. CAST_WAIT: how long a sent cast may take to show; one
// the server cannot make from the tile (the cow walked out of sight) shows nothing.
export const WEAK_TICKS = 25, MISS_TICKS = 10, CAST_GAP = 5, CAST_WAIT = 4;
const count = (items: readonly Item[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

// The spell a level casts.
export const splashSpell = (level: number) => SPLASH_SPELLS.find(s => level >= s.level) ?? SPLASH_SPELLS[SPLASH_SPELLS.length - 1]!;
// The best spell of the level that the pack has the runes for; the level's best spell when the pack pays for none.
export const packSpell = (level: number, pack: readonly Item[]) => SPLASH_SPELLS.find(s => level >= s.level
    && Object.entries(s.runes).every(([id, each]) => count(pack, Number(id)) >= each)) ?? splashSpell(level);
// Casts from this experience to the target level, spell by spell as the levels unlock them, and the runes they cost.
export function splashPlan(xp: number, target: number): { casts: number; runes: Record<number, number> } {
    const runes: Record<number, number> = Object.fromEntries(SPLASH_RUNES.map(id => [id, 0])), goal = xpForLevel(target);
    let casts = 0, at = xp;
    for (const spell of [...SPLASH_SPELLS].reverse()) {
        if (at < xpForLevel(spell.level)) continue;
        const better = SPLASH_SPELLS[SPLASH_SPELLS.indexOf(spell) - 1], until = Math.min(goal, better ? xpForLevel(better.level) : goal);
        const n = Math.max(0, Math.ceil((until - at) / spell.xp));
        casts += n; at += n * spell.xp;
        for (const [id, each] of Object.entries(spell.runes)) runes[Number(id)]! += n * each;
    }
    return { casts, runes };
}
// Whether a cast from `from` reaches a cow whose south-west tile is `sw`: in range and in sight of its whole footprint.
export function castReaches(from: { x: number; z: number }, sw: { x: number; z: number }, range: number = CAST_RANGE, size: number = COW_SIZE): boolean {
    initPathfinding();
    return Math.max(Math.abs(sw.x - from.x), Math.abs(sw.z - from.z)) <= range && rsmod.hasLineOfSight(0, from.x, from.z, sw.x, sw.z, 1, 1, size, size, 0);
}

// The stop of a run that made no cast for QUIET_TICKS: every cow in reach rests, is fought by another player or is dead.
export const QUIET_TICKS = 300, QUIET_STOP = `no cast in ${QUIET_TICKS} ticks`;
// A stop that ends a batch and not the band, when the run gained a level before it.
export const splashBatchDone = (stop: string, gained: number) => gained > 0 && (stop === 'supplies' || stop === 'cap' || stop === QUIET_STOP);

export async function runSplash(s: Session, o: { target: number; cap: number; stop?: () => boolean; site?: SplashSite }) {
    const site = o.site ?? SPLASH_SITES.ardougne!, TILE = site.tile;
    const st = () => s.sdk.getState(), inv = () => s.sdk.getInventory();
    const level = () => s.sdk.getSkill('Magic')?.baseLevel ?? 0, xp = () => s.sdk.getSkillXp('Magic') ?? 0, hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!await waitUntil(s, () => !!st()?.player && s.sdk.getSkillXp('Magic') !== null, { timeoutTicks: 15 })) throw Error('splash: position unknown');
    const start = s.tick(), level0 = level(), xp0 = xp(), hp0 = hp();
    let ended = false; void s.ended.then(() => { ended = true; });
    let casts = 0, refused = 0, missed = 0, waited = 0, stop = '', hpMin = hp0, quietNote = '';
    // Out of runes, at the tick cap or with no cow to cast on, after a gained level, is a finished batch: the band
    // takes the account again.
    const result = () => ({ ok: level() >= o.target || splashBatchDone(stop, level() - level0), level: level(), gained: level() - level0, xp: xp() - xp0, casts, refused, missed, waited, stop, quiet: quietNote, hpMin, ticks: s.tick() - start });
    if (level() >= o.target) return result();
    const walker = await sessionWalker(s);
    const toBank = async () => {
        if (!site.bank) return;
        if (atNorthBank(st()?.player)) return;
        const there = await walkTargetPersist(s, { ...COW_NORTH_BANK, level: 0 });
        if (!there.ok || !atNorthBank(st()?.player)) throw Error(`splash: walk to the Ardougne north bank failed: ${there.reason ?? ''} ${there.detail ?? ''}`);
    };
    const observe = s.bankObservation?.bind(s);
    if (!observe) throw Error('splash: fresh bank observation unavailable');
    const openBank = async () => {
        const generation = observe()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!st()?.bank?.isOpen && (observe()?.generation ?? 0) > generation, { timeoutTicks: 20 })) throw Error('splash: bank did not open');
    };
    // A cast sent while the bank's inventory panel shows is dropped: wait for the side tabs.
    const closeBank = async () => { await s.bot.closeBank(); if (!await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 10 })) throw Error('splash: bank did not close'); await waitTicks(s, 2); };
    const depositAll = async (keep: ReadonlySet<number>) => {
        for (const id of new Set(inv().map(i => i.id))) {
            const row = inv().find(i => i.id === id);
            if (keep.has(id) || !row) continue;
            if (!(await s.bot.depositItem(row, count(inv(), id))).success || !await waitUntil(s, () => count(inv(), id) === 0, { timeoutTicks: 10 })) throw Error(`splash: deposit ${id} failed`);
        }
    };
    const runeIds = new Set<number>(SPLASH_RUNES);
    // A site with no bank casts the best spell that the pack pays for: the starter pack has runes for 2 Confuse casts
    // and 15 Wind Strikes.
    const spellNow = () => site.bank ? splashSpell(level()) : packSpell(level(), inv());
    const affordable = () => Object.entries(spellNow().runes).every(([id, each]) => count(inv(), Number(id)) >= each);
    const runesHeld = () => SPLASH_RUNES.reduce((n, id) => n + count(inv(), id), 0);
    const onTile = () => { const p = st()?.player; return !!p && p.worldX === TILE.x && p.worldZ === TILE.z; };
    const reach = (n: { tileX?: number; tileZ?: number; x: number; z: number }) => castReaches(TILE, { x: n.tileX ?? n.x, z: n.tileZ ?? n.z }, CAST_RANGE, site.size);
    const refusals = () => Math.max(-1, ...(st()?.gameMessages ?? []).filter(m => /already been (weakened|lowered)/i.test(m.text)).map(m => m.tick));
    // Stage: bank the pack, take the runes the casts need. A site with no bank casts from the pack as it is.
    const plan = splashPlan(xp(), o.target);
    if (site.bank) {
        await toBank();
        await openBank();
        await depositAll(runeIds);
        for (const id of runeIds) {
            const want = Math.min(Math.max(0, plan.runes[id]! - count(inv(), id)), count(observe()?.items ?? [], id)), before = count(inv(), id);
            if (want < 1) continue;
            const row = (st()?.bank?.items ?? []).find(i => i.id === id);
            if (!row || !(await s.bot.withdrawItem(row, want, { asNote: false })).success || !await waitUntil(s, () => count(inv(), id) >= before + want, { timeoutTicks: 10 })) throw Error(`splash: withdraw ${want}x${id} failed`);
        }
        await closeBank();
    }
    // A first job after the account claim starts on Tutorial Island (claim-account.ts logs out at once): skip it as
    // scripts/arrive-draynor.ts does. Live (Balls): the skip put the account at Lumbridge 3222,3222 by tick 14, with
    // the starter kit in the pack.
    const island = () => { const p = st()?.player; return !!p && p.worldX < 3160 && p.worldZ < 3130; };
    if (!site.bank && island()) {
        await waitUntil(s, () => (st()?.nearbyNpcs?.length ?? 0) > 0, { timeoutTicks: 30 });
        const r = await s.bot.skipTutorial();
        if (!r.success || !await waitUntil(s, () => !island(), { timeoutTicks: 30 })) throw Error(`splash: tutorial skip failed: ${r.message ?? 'still on the island'}`);
        await waitTicks(s, 3);
        await s.direct({ type: 'closeModal', reason: 'SDK' });
    }
    if (!affordable()) { stop = 'supplies'; return result(); }
    // A site with no bank starts away from its tile (the Lumbridge spawn for the coop): the route planner walks there.
    const p0 = st()?.player;
    if (!site.bank && p0 && Math.max(Math.abs(p0.worldX - TILE.x), Math.abs(p0.worldZ - TILE.z)) > 10) {
        const there = await walkTargetPersist(s, { ...TILE, level: 0 });
        if (!there.ok) throw Error(`splash: walk to ${TILE.x},${TILE.z} failed: ${there.reason ?? ''} ${there.detail ?? ''}`);
    }
    try {
        const rest = new Map<number, number>();
        let quiet = s.tick();
        while (level() < o.target) {
            if (ended) { stop = 'session ended'; break; }
            if (o.stop?.()) { stop = 'stopped'; break; }
            if (s.tick() - start >= o.cap) { stop = 'cap'; break; }
            hpMin = Math.min(hpMin, hp());
            if (site.hpFloor === undefined ? hp() < hp0 : hp() <= site.hpFloor) { stop = `lost hitpoints at the fence (${hp()} of ${hp0})`; break; }
            if (!affordable()) { stop = 'supplies'; break; }
            if (s.tick() - quiet > QUIET_TICKS) {
                // What the field looked like: cows seen, cows a cast reaches, players near, and the last thing the server said.
                const cows = (st()?.nearbyNpcs ?? []).filter(n => site.target(n) && n.hp !== 0);
                const said = (st()?.gameMessages ?? []).slice(-1)[0]?.text ?? '';
                quietNote = `cows=${cows.length} reach=${cows.filter(reach).length} players=${(st()?.nearbyPlayers ?? []).length} said=${JSON.stringify(said.slice(0, 60))}`;
                stop = QUIET_STOP; break;
            }
            // A cast the server cannot make from here walks the account along the fence: back to the tile first.
            if (!onTile() && (!(await walkPath(walker, [{ ...TILE, tol: 0 }], { maxTicks: 200, stop: () => ended })).ok || !onTile())) throw Error(`splash: fence tile ${TILE.x},${TILE.z} not reached`);
            const cow = (st()?.nearbyNpcs ?? []).filter(n => site.target(n) && n.hp !== 0 && (rest.get(n.index) ?? 0) <= s.tick() && reach(n))
                .sort((a, b) => a.distance - b.distance)[0];
            if (!cow) { waited++; await waitTicks(s, 1); continue; }
            const before = xp(), runes = runesHeld(), said = refusals();
            await s.direct({ type: 'spellOnNpc', npcIndex: cow.index, spellComponent: componentId(spellNow().component), reason: 'SDK' });
            await waitUntil(s, () => xp() > before || runesHeld() < runes || refusals() > said || ended, { timeoutTicks: CAST_WAIT });
            if (xp() > before || runesHeld() < runes) { casts++; quiet = s.tick(); rest.set(cow.index, s.tick() + WEAK_TICKS); await waitTicks(s, CAST_GAP); }
            else if (refusals() > said) { refused++; rest.set(cow.index, s.tick() + WEAK_TICKS); }
            else { missed++; rest.set(cow.index, s.tick() + MISS_TICKS); }
        }
    } finally {
        // Back to the bank with what is left, so the next job starts from a clean pack.
        if (!ended && site.bank) try { await toBank(); await openBank(); await depositAll(new Set()); await closeBank(); }
        catch (e) { stop = stop ? `${stop}; cleanup ${String(e)}` : `cleanup ${String(e)}`; }
    }
    return result();
}

if (import.meta.main) {
    let s: Session | undefined, stopped = false;
    try {
        const [account, target, cap] = process.argv.slice(2);
        if (!account || !Number.isSafeInteger(Number(target)) || Number(target) < 2 || Number(target) > 99) throw Error('usage: splash-train.ts <account> <TARGET_LEVEL> [CAP ticks]');
        s = await openBot(account, { onStop: async () => { stopped = true; } });
        const stop = () => stopped || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all');
        const r = await runSplash(s, { target: Number(target), cap: Number(cap ?? 6000), stop, site: splashSite(process.env.SPLASH_SITE || undefined) });
        console.log('SPLASH_RESULT ' + JSON.stringify(r));
        await finish([s], r.ok, `mode=splash level=${r.level} gained=${r.gained} xp=${r.xp} casts=${r.casts} refused=${r.refused} missed=${r.missed} waited=${r.waited} hpMin=${r.hpMin} ticks=${r.ticks}${r.stop ? ` stop=${r.stop}` : ''}${r.quiet ? ` ${r.quiet}` : ''}`);
    } catch (e) { await finish(s ? [s] : [], false, String(e)); }
}
