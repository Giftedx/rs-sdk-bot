// The gear job of an account: what to buy for the wants that the workers' reconcile prints (scripts/gear-reconcile.ts
// GEAR_WANT, packages/planner/src/gear-sources.ts). A want whose source is the Grand Exchange becomes a kit buy
// (scripts/buy-owned-ge-item.ts through kitBuyTemplate); a want whose source is a shop becomes one trip to that shop
// (scripts/shop-buyer.ts). The other sources (npc, quest, craft, drop, clue) have no buyer here.
// A job is bounded by the coins of the account (the caller passes the room that a buy keeps) and by a gain floor.
import { gearById } from './gear-progression';
import type { CombatFocus } from './gear-progression';
import type { GearSource } from './gear-sources';
import type { Gear } from '../../knowledge/src/gear';

/** The least gain, in points of the style's main bonus, that a want needs to start a job (see bonusGain). */
export const GEAR_GAIN_FLOOR = 2;
/** A job that preempts a running training session needs this many times the floor in gain. */
export const GEAR_RUNNING_GAIN_FACTOR = 5;
/** The limit price of a market buy over the ask that the want was chosen at. */
export const GEAR_ASK_MARGIN = 1.05;
/** A shop's budget over its list price, as planToolShopUpgrade's priceBufferRatio. */
export const GEAR_SHOP_BUFFER = 1.25;
/** Coins that one tick of play earns, to compare a price with a walk (research: goldfarm, about 10.76 coins a tick). */
export const GEAR_COINS_PER_TICK = 10;
/** Ticks for one tile of a shop trip, and for a Grand Exchange order to fill (kitBuyTemplate FILL_WAIT_TICKS 200 plus the walk). */
export const GEAR_TICKS_PER_TILE = 0.6;
export const GEAR_GE_TICKS = 250;
/** The planner's ids of the two jobs. */
export const GEAR_GE_ID = 'gear-ge';
export const GEAR_SHOP_PREFIX = 'gear-shop-';
export const gearShopId = (profile: string) => `${GEAR_SHOP_PREFIX}${profile}`;
export const isGearShop = (templateId: string | undefined) => !!templateId?.startsWith(GEAR_SHOP_PREFIX);
/** The ids that the `aio` list of swarm.json names to admit each job live (Inputs.pilots): nothing starts before its id is listed. */
export const GEAR_GE_PILOT = GEAR_GE_ID;
export const GEAR_SHOP_PILOT = 'gear-shop';
/** The most coins that one point of bonus may cost. The dry run's fleet runs from 40 (iron platebody) to 4,400 (rune platelegs) coins a point; a want above this is skipped. */
export const GEAR_MAX_COINS_PER_POINT = 5_000;

/** One GEAR_WANT of the account, with the shop-buyer profile of its shop when one serves it. */
export type GearWantRow = {
    style: CombatFocus; slot: string; id: number; name: string; current: number | null; source: GearSource; profile?: string;
};

const sourceCost = (s: GearSource): number => s.kind === 'ge' ? Math.ceil(s.ask * GEAR_ASK_MARGIN) : s.kind === 'shop' ? s.cost : 0;
const mean = (...n: number[]) => n.reduce((s, x) => s + x, 0) / n.length;
/** The points of a style's main bonuses of an item: its offence (attack and strength, or ranged, or magic) and the mean of its five defences. */
function points(style: CombatFocus, g: Gear | undefined): number {
    if (!g) return 0;
    const b = g.bonuses;
    const offence = style === 'melee' ? Math.max(b.stabAttack, b.slashAttack, b.crushAttack) + b.strength
        : style === 'ranged' ? b.rangeAttack + b.rangeStrength : b.magicAttack;
    return offence + mean(b.stabDefence, b.slashDefence, b.crushDefence, b.rangeDefence, b.magicDefence);
}
/** The gain of a want in points of the style's main bonus: the wanted item over the item worn in its slot (none counts 0). */
export function bonusGain(style: CombatFocus, wanted: number, current: number | null): number {
    return points(style, gearById(wanted)) - (current === null ? 0 : points(style, gearById(current)));
}

/**
 * The combat style an account trains, from its template id; null for any other job. Only the templates of scripts/gather-combat.ts
 * count: that worker wears the choice of the reconcile at its bank (scripts/gear-reconcile.ts reconcileLoadout), so a buy is worn on its next run.
 * The workers that wear with their own code (ranged-train, alch-train, splash-train, gather-fire-combat) are the next consumers.
 */
export function trainingStyle(templateId: string | undefined): CombatFocus | null {
    if (!templateId || !/^army-(?:cow|trooper)-/.test(templateId)) return null;
    return /-ranged-/.test(templateId) ? 'ranged' : 'melee';
}

export type GearJob =
    | { kind: 'ge'; lines: { id: number; name: string; limit: number; gain: number }[]; cost: number; gain: number; value: number }
    | { kind: 'shop'; shop: string; profile: string; items: { id: number; name: string; cost: number; gain: number }[]; cost: number; spend: number; gain: number; value: number };

export type GearJobOptions = {
    /** Coins that the account holds. */
    coins: number;
    /** Coins that a buy leaves: the kit reserve, the margin, and what the account's job keeps. */
    room: number;
    /** True when a training session is running: the job needs GEAR_RUNNING_GAIN_FACTOR times the floor. */
    running?: boolean;
    /** Job ids that are held back (a fresh unplaced mark, a retirement). */
    held?: (jobId: string) => boolean;
};

const valueOf = (gain: number, cost: number, ticks: number) => gain / (cost / GEAR_COINS_PER_TICK + ticks);

/**
 * The best gear job of the account, or null. Wants under GEAR_GAIN_FLOOR points give none; a job whose price and room pass the
 * account's coins gives none. The value of a job is its gain over its price in ticks of play plus its travel ticks.
 */
export function gearJobFor(wants: readonly GearWantRow[], o: GearJobOptions): GearJob | null {
    const rows = wants.map(w => ({ w, gain: bonusGain(w.style, w.id, w.current) }))
        .filter(r => r.gain >= GEAR_GAIN_FLOOR && r.w.slot !== 'ammo')
        .filter(r => r.w.source.kind !== 'ge' && r.w.source.kind !== 'shop' || sourceCost(r.w.source) / r.gain <= GEAR_MAX_COINS_PER_POINT);
    const jobs: GearJob[] = [];
    // The market: one chain of orders, the best value first, while the limits and the room fit the coins.
    const ge = rows.filter(r => r.w.source.kind === 'ge').map(r => {
        const s = r.w.source as Extract<GearSource, { kind: 'ge' }>;
        return { id: r.w.id, name: r.w.name, limit: Math.ceil(s.ask * GEAR_ASK_MARGIN), gain: r.gain };
    }).sort((x, y) => y.gain / y.limit - x.gain / x.limit || x.id - y.id);
    if (!o.held?.(GEAR_GE_ID)) {
        const lines: typeof ge = [];
        let cost = 0;
        for (const l of ge) if (cost + l.limit + o.room <= o.coins) { lines.push(l); cost += l.limit; }
        if (lines.length) {
            const gain = lines.reduce((n, l) => n + l.gain, 0);
            jobs.push({ kind: 'ge', lines, cost, gain, value: valueOf(gain, cost, GEAR_GE_TICKS) });
        }
    }
    // A shop: one trip for each shop and profile, the items of the shop that the coins pay for.
    const byShop = new Map<string, typeof rows>();
    for (const r of rows) if (r.w.source.kind === 'shop' && r.w.profile) byShop.set(r.w.profile, [...(byShop.get(r.w.profile) ?? []), r]);
    for (const [profile, list] of [...byShop].sort(([a], [b]) => a.localeCompare(b))) {
        if (o.held?.(gearShopId(profile))) continue;
        const items: Extract<GearJob, { kind: 'shop' }>['items'] = [];
        let cost = 0, spend = 0;
        const shop = (list[0]!.w.source as Extract<GearSource, { kind: 'shop' }>).shop;
        for (const r of list.sort((x, y) => y.gain / Math.max(1, (y.w.source as { cost: number }).cost) - x.gain / Math.max(1, (x.w.source as { cost: number }).cost) || x.w.id - y.w.id)) {
            const s = r.w.source as Extract<GearSource, { kind: 'shop' }>, buffered = Math.ceil(s.cost * GEAR_SHOP_BUFFER);
            if (spend + buffered + o.room > o.coins) continue;
            items.push({ id: r.w.id, name: r.w.name, cost: s.cost, gain: r.gain });
            cost += s.cost; spend += buffered;
        }
        if (!items.length) continue;
        const tiles = Math.min(...list.map(r => (r.w.source as { distance?: number }).distance ?? 0));
        const gain = items.reduce((n, i) => n + i.gain, 0);
        jobs.push({ kind: 'shop', shop, profile, items, cost, spend, gain, value: valueOf(gain, cost, tiles * GEAR_TICKS_PER_TILE) });
    }
    const best = jobs.sort((x, y) => y.value - x.value || (x.kind === 'ge' ? 1 : 0) - (y.kind === 'ge' ? 1 : 0))[0];
    if (!best) return null;
    return best.gain >= GEAR_GAIN_FLOOR * (o.running ? GEAR_RUNNING_GAIN_FACTOR : 1) ? best : null;
}
