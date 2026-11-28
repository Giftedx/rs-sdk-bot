// Dagger & smite-drain mode of the squad (SQUAD_DAGGER=1; squad.ts hold): target choice, prayer-drain tracking,
// kill timing, and enemy weapon pickup rules that make skulled enemies drop their weapons and gear.
// Server rules (vendor/rs-sdk/server/content/scripts):
// - death.rs2 pvp_death_lose_items: in the tick of the kill message an unskulled death keeps the 3 dearest items, a skulled
//   death (%pk_skull > 0) keeps none, and Protect Item (%prayer8) keeps 1 more.
// - pk_skull.rs2 deserves_pk_skull: an attacker takes a skull unless its target attacked it first.
// - prayer.rs2 prayer_drain: at 0 prayer points every prayer goes off, Protect Item too. Protect Item has no head icon, so
//   an overhead that stays off while the account fights is the visible sign of 0 points.
//   SQUAD_DAGGER=1  SQUAD_DAGGER_OFF_READS=<reads> (default 6)  SQUAD_DAGGER_HOLD=<fraction>,<ticks> or off (default 0.7,300)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './types';
import { ENEMY_WEAPON_IDS, ENEMY_WEAPON_LIST, HIGH_VALUE_ARMOUR_AND_GEAR_LIST } from './zero-risk';

export const DAGGER_IDS: ReadonlySet<number> = new Set([1215, 1231]);
export { ENEMY_WEAPON_IDS, ENEMY_WEAPON_LIST, HIGH_VALUE_ARMOUR_AND_GEAR_LIST };

// `offReads`: the reads (one each tick) of an overhead that is off while the target is in combat, before the squad
// takes it for an account with 0 prayer points. `holdBelow` and `holdTicks`: the hold (0 is no hold).
export type DaggerOptions = { offReads: number; holdBelow: number; holdTicks: number };
// From the bench (research/gang-clones.md, "Dagger mode"): a bench clone with prayer points showed no overhead for at most
// 5 ticks in a row in combat, and the hold at 0.7 for 300 ticks took all 24 clones of 8 seeds to 0 points before their death.
export const DAGGER_DEFAULTS: DaggerOptions = { offReads: 6, holdBelow: 0.7, holdTicks: 300 };

/** SQUAD_DAGGER=1 turns dagger mode on (undefined: off); the options come from SQUAD_DAGGER_OFF_READS and SQUAD_DAGGER_HOLD. */
export function daggerOptionsOf(get: (name: string, fallback: string) => string): DaggerOptions | undefined {
    const on = get('SQUAD_DAGGER', '0');
    if (on !== '0' && on !== '1') throw new Error(`SQUAD_DAGGER must be 0 or 1, got ${on}`);
    if (on === '0') return undefined;
    const out: DaggerOptions = { ...DAGGER_DEFAULTS };
    const reads = get('SQUAD_DAGGER_OFF_READS', '');
    if (reads) {
        const n = Number(reads);
        if (!Number.isSafeInteger(n) || n < 1) throw new Error(`SQUAD_DAGGER_OFF_READS must be a whole number of 1 or more, got ${reads}`);
        out.offReads = n;
    }
    const hold = get('SQUAD_DAGGER_HOLD', '');
    if (hold === 'off') { out.holdBelow = 0; out.holdTicks = 0; }
    else if (hold) {
        const [below, ticks, ...rest] = hold.split(',').map(Number);
        if (rest.length || below === undefined || ticks === undefined || !Number.isFinite(below) || below <= 0 || below >= 1 || !Number.isSafeInteger(ticks) || ticks < 1) {
            throw new Error(`SQUAD_DAGGER_HOLD must be off or <fraction in (0, 1)>,<ticks of 1 or more>, got ${hold}`);
        }
        out.holdBelow = below; out.holdTicks = ticks;
    }
    return out;
}

let gearPrayerTable: Map<number, number> | undefined;
function prayerBonusById(): Map<number, number> {
    if (gearPrayerTable) return gearPrayerTable;
    const map = new Map<number, number>();
    try {
        const rows = JSON.parse(readFileSync(join(REPO_ROOT, 'knowledge', 'gear.json'), 'utf8')) as { id: number; bonuses?: { prayer?: number } }[];
        for (let i = 0; i < rows.length; i++) {
            const p = rows[i]!.bonuses?.prayer;
            if (typeof p === 'number' && p !== 0) map.set(rows[i]!.id, p);
        }
    } catch { /* fallback to empty map */ }
    gearPrayerTable = map;
    return map;
}

/** Sums exact rev-289 Prayer bonus across observed worn item IDs (e.g. monk robes +11, glory +3). */
export function inferGearPrayerBonus(wornIds: readonly number[] | undefined, table = prayerBonusById()): number {
    if (!wornIds?.length) return 0;
    let total = 0;
    for (let i = 0; i < wornIds.length; i++) {
        const id = wornIds[i]!;
        if (id >= 0) total += table.get(id) ?? 0;
    }
    return total;
}

// One read of a target account: its skull, whether it shows an overhead protect prayer, whether it is in combat,
// its health fraction (null when no health bar shows), and optional worn IDs / base prayer for drain estimation.
export type DaggerRead = {
    skulled: boolean;
    overhead: boolean;
    inCombat: boolean;
    hp: number | null;
    wornIds?: readonly number[];
    basePrayer?: number;
};

type Life = {
    readTick: number;
    skulled: boolean;
    overhead: boolean;
    offReads: number;
    offCounted: boolean;
    seenAt: number;
    attackedAt: number;
    holdSince: number;
    overheadOnTicks: number;
    estPrayerPoints: number;
    drainCounter: number;
    prayerBonus: number;
    overheadDroppedAt: number;
};

// Typical combat drain effects when a skulled enemy runs overhead (12) + Protect Item (2) + Steel Skin / melee boost (12) = 26.
const COMBAT_OVERHEAD_DRAIN_EFFECTS = 26;
const IDLE_OVERHEAD_DRAIN_EFFECTS = 14;

// The squad's shared record of each target account, by lower-case name. Each member's view feeds it each tick (`read`,
// `attacked`); a kill message ends the life (`died`). A name that no member saw for `forgetTicks` starts a new life.
export function createDaggerWatch(options: DaggerOptions, forgetTicks = 100) {
    const book = new Map<string, Life>();
    const life = (name: string, tick: number, basePrayer = 99): Life => {
        const key = name.toLowerCase();
        let e = book.get(key);
        if (!e || tick - e.seenAt > forgetTicks) {
            e = {
                readTick: -1,
                skulled: false,
                overhead: true,
                offReads: 0,
                offCounted: false,
                seenAt: tick,
                attackedAt: -1,
                holdSince: -1,
                overheadOnTicks: 0,
                estPrayerPoints: basePrayer,
                drainCounter: 0,
                prayerBonus: 0,
                overheadDroppedAt: -1,
            };
            book.set(key, e);
        }
        e.seenAt = Math.max(e.seenAt, tick);
        return e;
    };
    const drainedLife = (e: Life | undefined) => !!e && e.skulled && !e.overhead && e.offReads >= options.offReads;
    // Rule a: no first strike on an account that is unskulled and has not attacked one of ours (unread: no strike).
    const firstStrikeBlocked = (name: string): boolean => {
        const e = book.get(name.toLowerCase());
        return !e || (!e.skulled && e.attackedAt < 0);
    };
    // The hold: a skulled account with its overhead on, at or below `holdBelow` once, is not attacked for `holdTicks`
    // ticks from that read or until its overhead goes off.
    const held = (name: string, tick: number): boolean => {
        const e = book.get(name.toLowerCase());
        return !!e && options.holdBelow > 0 && e.holdSince >= 0 && e.skulled && e.overhead && tick - e.holdSince < options.holdTicks;
    };
    const lowPrayer = (name: string, threshold = 12): boolean => {
        const e = book.get(name.toLowerCase());
        return !!e && e.skulled && e.estPrayerPoints <= threshold;
    };
    const smiteReady = (name: string): boolean => drainedLife(book.get(name.toLowerCase()));
    const holdSpecForDrain = (name: string, tick: number): boolean => {
        const e = book.get(name.toLowerCase());
        if (!e || !e.skulled) return false;
        if (drainedLife(e)) return false;
        if (lowPrayer(name, 10)) return false;
        return e.overhead && (e.holdSince >= 0 ? tick - e.holdSince < options.holdTicks : e.estPrayerPoints > 15);
    };
    return {
        options,
        // Two members that read the same tick count it once. A shown overhead in any read of the tick wins.
        read(name: string, tick: number, r: DaggerRead): void {
            const e = life(name, tick, r.basePrayer ?? 99);
            if (r.wornIds?.length) e.prayerBonus = inferGearPrayerBonus(r.wornIds);
            if (e.readTick === tick) {
                e.skulled ||= r.skulled;
                if (r.overhead && !e.overhead) {
                    e.overhead = true;
                    e.offReads = 0;
                    e.offCounted = false;
                    e.overheadDroppedAt = -1;
                } else if (!r.overhead && !e.overhead && r.inCombat && !e.offCounted) {
                    e.offReads++;
                    e.offCounted = true;
                }
            } else {
                const prevOverhead = e.overhead;
                const dt = e.readTick >= 0 ? Math.max(1, Math.min(10, tick - e.readTick)) : 1;
                e.readTick = tick;
                e.skulled = r.skulled;
                e.overhead = r.overhead;
                e.offCounted = false;
                if (r.overhead) {
                    e.offReads = 0;
                    e.overheadDroppedAt = -1;
                    e.overheadOnTicks += dt;
                    // Estimate rev-289 prayer drain while overhead is active (resistance = 60 + 2 * prayerBonus).
                    const resistance = Math.max(60, 60 + 2 * e.prayerBonus);
                    const effects = r.inCombat ? COMBAT_OVERHEAD_DRAIN_EFFECTS : IDLE_OVERHEAD_DRAIN_EFFECTS;
                    e.drainCounter += effects * dt;
                    if (e.drainCounter >= resistance) {
                        const lost = Math.floor(e.drainCounter / resistance);
                        e.drainCounter -= lost * resistance;
                        e.estPrayerPoints = Math.max(0, e.estPrayerPoints - lost);
                    }
                } else {
                    if (prevOverhead && r.inCombat) e.overheadDroppedAt = tick;
                    if (r.inCombat) {
                        e.offReads++;
                        e.offCounted = true;
                    }
                }
            }
            if (options.holdBelow > 0 && e.holdSince < 0 && e.skulled && e.overhead && r.hp !== null && r.hp <= options.holdBelow) {
                e.holdSince = tick;
            }
        },
        // The account attacked one of ours (its combat target is a member, or a member took its hit).
        attacked(name: string, tick: number): void { life(name, tick).attackedAt = tick; },
        died(name: string): void { book.delete(name.toLowerCase()); },
        firstStrikeBlocked,
        // Rule b: skulled, with the overhead off for `offReads` reads in combat.
        drained: (name: string): boolean => drainedLife(book.get(name.toLowerCase())),
        smiteReady,
        lowPrayer,
        holdSpecForDrain,
        held,
        // The names to leave out of the target choice at `tick`: blocked first strikes and holds.
        skipped(names: Iterable<string>, tick: number): string[] {
            const out: string[] = [];
            for (const n of names) if (firstStrikeBlocked(n) || held(n, tick)) out.push(n.toLowerCase());
            return out;
        },
        snapshot(name: string): Readonly<Life> | undefined { return book.get(name.toLowerCase()); },
    };
}
export type DaggerWatch = ReturnType<typeof createDaggerWatch>;

// The ticks from the first prayer on to 0 points (prayer.rs2 prayer_drain): the timer fires each 5 ticks, the counter
// gains `effects` x 5 (the sum of prayers.enum prayer_drain_effects of the prayers on), and a point goes for each
// 60 + 2 x `prayerBonus` of the counter. The gang kit (monk robes: prayer bonus 6 + 5) in a fight with Protect Item, Steel
// Skin and an overhead (2 + 12 + 12) drains 99 points in 315 ticks.
export function drainTicks(points: number, effects: number, prayerBonus: number): number {
    const resistance = Math.max(60, 60 + 2 * prayerBonus);
    if (effects <= 0 || points <= 0) return effects <= 0 ? Infinity : 0;
    let counter = 0, ticks = 0;
    while (points > 0) {
        ticks += 5;
        counter += effects * 5;
        if (counter >= resistance) { const lost = Math.floor(counter / resistance); counter -= lost * resistance; points -= lost; }
    }
    return ticks;
}

// The pickup of a kill in dagger mode. `skip` is the reason of the normal rules (squad.ts pickupSkip). An escape and a pickup
// that is off stay skipped; over single-way ground or interlopers the pickup takes enemy weapons only.
export function daggerPickup(skip: string | null): 'all' | 'daggers' | 'skip' {
    if (skip === null) return 'all';
    if (skip === 'off' || skip === 'escape') return 'skip';
    return 'daggers';
}
