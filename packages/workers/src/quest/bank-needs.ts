// The items of a quest's preset that the quest sweep (sweep.ts, the bank step) can take only from the bank, and the
// items that it buys in a shop. The brain preflight (packages/brain/src/preflight.ts) asks for the bank items before it
// plans the quest, so the planner chains their acquisition; the sweep otherwise ends with "missing <id>:<count>".
// The steps follow the sweep's need list: needs(), the resumed-stage spent items, STURDY_OPTIONAL, prayerCovers,
// ANTIPOISONS and QUEST_FINDS, fireRunesFor, buildPack and the required worn kit; then the gather plan from the start
// tile and the shop sellers.
import { NPC_SOURCES } from '../../../core/src/gather';
import { sellersByDistance } from '../../../core/src/shop-index';
import type { Tile } from '../../../core/src/world';
import { fireRunesFor } from './fire-spells';
import { QUEST_RESUME } from './resume';
import {
    ANTIPOISONS,
    BOAT_FARES,
    buildPack,
    catalogItem,
    COINS,
    eastOfPass,
    fares,
    FIRE_QUESTS,
    HECKEL_DUST,
    heckelDustNeed,
    manorFoodNeed,
    manorPoisonNeed,
    needs,
    prayerCovers,
    PRAYER_POTIONS,
    presetFor,
    QUEST_EXIT_RUNES,
    QUEST_FINDS,
    questGatherPlan,
    sellersByTravel,
    shopPlan,
    STURDY,
    STURDY_OPTIONAL,
    travelDistance,
    withExitRunes,
    WORN_KIT,
} from './sweep-plan';

type Item = { id: number; count: number };

// One item that the sweep stages. `for` is the preset item that it serves: the same id, or the preset item that a gather
// recipe makes from it (an NPC craft, a combine, a burn). An account that holds `forCount` of `for` needs none of it.
export type QuestSweepItem = {
    readonly id: number;
    readonly count: number;
    readonly for: number;
    readonly forCount: number;
    readonly name?: string;
};

// Coins that the sweep pays outside a shop for a preset item that the account lacks: the gather plan's NPC crafts
// (gather.coins, NPC_SOURCES) and Heckel's chocolate dust (HECKEL_DUST). `tiles` are the NPCs the trip visits, for the fares.
export type QuestSweepFee = { readonly for: number; readonly forCount: number; readonly coins: number; readonly tiles: readonly Tile[] };

export type QuestSweepNeeds = {
    readonly quest: string;
    // The quest's start tile (the preset position), where the sweep walks after the bank.
    readonly start: Tile;
    // No shop sells it and no gather plan covers it: the sweep ends with "missing <id>:<count>" unless the bank holds it.
    readonly bank: readonly QuestSweepItem[];
    // A shop sells it: the sweep buys it with banked coins.
    readonly shop: readonly QuestSweepItem[];
    readonly fees: readonly QuestSweepFee[];
    // The preset's coins, which the sweep withdraws with the pack.
    readonly coins: number;
};

const EMPTY = (quest: string): QuestSweepNeeds => ({ quest, start: { x: 0, z: 0, level: 0 }, bank: [], shop: [], fees: [], coins: 0 });
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Magic', 'Ranged'] as const;
const MAX_MEMO = 128;
const memo = new Map<string, QuestSweepNeeds>();
function setMemo(key: string, value: QuestSweepNeeds): void {
    if (memo.size >= MAX_MEMO) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(key, value);
}

// Preset items that the quest takes before every started stage: the sweep stages none of them for a started journal.
// An item spent only from a later stage stays a need, because the brain does not know the stage.
export function spentAtEveryStage(quest: string): number[] {
    const r = QUEST_RESUME[quest];
    if (!r?.spent) return [];
    let left: Set<number> | undefined;
    for (let stage = 1; stage < r.complete; stage++) {
        const spent = new Set(r.spent(stage));
        left = left ? new Set([...left].filter((id) => spent.has(id))) : spent;
        if (left.size === 0) break;
    }
    return [...(left ?? [])];
}

// `level` gives the account's base level of a skill. `started`: the journal is started (a resumed stage).
export function questSweepNeeds(quest: string, level: (skill: string) => number, started = false): QuestSweepNeeds {
    const levels = SKILLS.map((s) => level(s));
    const key = `${quest}|${started ? 1 : 0}|${levels.join(',')}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const lv = (skill: string) => {
        const i = SKILLS.indexOf(skill as (typeof SKILLS)[number]);
        return i >= 0 ? levels[i]! : level(skill);
    };
    let preset: ReturnType<typeof presetFor>;
    try {
        preset = presetFor(quest);
    } catch {
        const empty = EMPTY(quest);
        setMemo(key, empty);
        return empty;
    }
    let base = needs(preset, false, quest);
    const food = needs(preset, true, quest);
    const coins = base.get(COINS) ?? 0;
    base.delete(COINS);
    if (started) for (const id of spentAtEveryStage(quest)) { base.delete(id); food.delete(id); }
    if (lv('Hitpoints') >= STURDY && lv('Defence') >= STURDY) for (const id of STURDY_OPTIONAL[quest] ?? []) base.delete(id);
    if (prayerCovers(quest, lv('Prayer'))) for (const id of PRAYER_POTIONS) base.delete(id);
    for (const id of [...ANTIPOISONS, ...(QUEST_FINDS[quest] ?? [])]) base.delete(id);
    if (FIRE_QUESTS.has(quest)) base = fireRunesFor(base, lv('Magic'));
    for (const i of buildPack(quest, lv)) base.set(i.id, (base.get(i.id) ?? 0) + i.count);
    if (QUEST_EXIT_RUNES[quest]) base = withExitRunes(base, food, quest, lv('Magic')).base;
    for (const i of WORN_KIT[quest] ?? []) if (i.required) base.set(i.id, Math.max(1, base.get(i.id) ?? 0));

    const at = preset.position;
    const sellerAt = (id: number) => {
        const it = catalogItem(id);
        const n = it && id !== COINS ? sellersByDistance(it.debugname, at)[0] : undefined;
        return n ? travelDistance(at, n.tile) : Infinity;
    };
    const bank: QuestSweepItem[] = [];
    const shop: QuestSweepItem[] = [];
    const fees: QuestSweepFee[] = [];
    for (const [id, count] of base) {
        const one = [{ id, count }];
        // The sweep picks the Draynor Manor fish food and poison on the way (manorFoodNeed, manorPoisonNeed) and buys the
        // chocolate dust from Heckel for HECKEL_DUST.coins (heckelDustNeed): neither goes to a shop.
        if (manorFoodNeed(quest, one) || manorPoisonNeed(quest, one)) continue;
        if (heckelDustNeed(quest, one)) {
            fees.push({ for: id, forCount: count, coins: HECKEL_DUST.coins, tiles: [HECKEL_DUST.ground] });
            continue;
        }
        // The sweep passes Ranged and Magic only with a bow or a staff kit in the bank: without one it kills by melee.
        const gather = questGatherPlan(quest, one, at, sellerAt, undefined, lv('Attack'), 1, undefined, 1, lv('Strength'));
        const tiles = gather.gathers.flatMap((g) => (g.how === 'npc' && NPC_SOURCES[g.id] ? [NPC_SOURCES[g.id]!.tile] : []));
        if (gather.coins > 0 || tiles.length > 0) fees.push({ for: id, forCount: count, coins: gather.coins, tiles });
        for (const m of [...gather.still, ...gather.tools]) {
            const name = catalogItem(m.id)?.name;
            const row = { id: m.id, count: m.count, for: id, forCount: count, ...(name ? { name } : {}) };
            (sellerAt(m.id) === Infinity ? bank : shop).push(row);
        }
    }
    const out = { quest, start: at, bank, shop, fees, coins };
    setMemo(key, out);
    return out;
}

// The coins that the sweep takes from the bank (sweep.ts, the shop.coins sum): the preset's coins, the shop plan's price
// (shopPlan) of the shop items that the account lacks, the fees of the lacking items, and the boat fares (fares,
// eastOfPass) from `from` to the sellers, the fee NPCs and the start tile. `owned` counts an item in the pack, the bank
// and the worn slots. `from` is the account's tile; without it the fares are not counted. `skills` has lowercase names.
export function questSweepCoins(
    need: QuestSweepNeeds,
    owned: (id: number) => number,
    from?: Tile,
    skills?: Readonly<Record<string, number>>,
): number {
    const lacking: Item[] = [];
    for (const s of need.shop) {
        if (s.for !== s.id && owned(s.for) >= s.forCount) continue;
        const lack = s.count - owned(s.id);
        if (lack > 0) lacking.push({ id: s.id, count: lack });
    }
    const acct = skills ? { skills: { ...skills } } : undefined;
    const at = from ?? need.start;
    const seller = (debugname: string, here: Tile) => sellersByTravel(sellersByDistance(debugname, here), here, need.start, acct)[0] ?? null;
    const priced = shopPlan(lacking, at, catalogItem, seller);
    let coins = priced.coins;
    const tiles: Tile[] = [];
    for (const f of need.fees) {
        if (owned(f.for) >= f.forCount) continue;
        coins += f.coins;
        tiles.push(...f.tiles);
    }
    if (from) {
        coins += fares(from, [...priced.buys.map((b) => b.tile), need.start, ...tiles], acct);
        if (need.quest === 'itgronigen' && acct && eastOfPass(from, acct)) coins += BOAT_FARES;
    }
    return need.coins + coins;
}
