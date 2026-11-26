// The items of a quest's preset that the quest sweep (sweep.ts, the bank step) can take only from the bank, and the
// items that it buys in a shop. The brain preflight (packages/brain/src/preflight.ts) asks for the bank items before it
// plans the quest, so the planner chains their acquisition; the sweep otherwise ends with "missing <id>:<count>".
// The steps follow the sweep's need list: needs(), the resumed-stage spent items, STURDY_OPTIONAL, prayerCovers,
// ANTIPOISONS and QUEST_FINDS, fireRunesFor, buildPack and the required worn kit; then the gather plan from the start
// tile and the shop sellers.
import { sellersByDistance } from '../../../core/src/shop-index';
import { fireRunesFor } from './fire-spells';
import { QUEST_RESUME } from './resume';
import {
    ANTIPOISONS,
    buildPack,
    catalogItem,
    COINS,
    FIRE_QUESTS,
    needs,
    prayerCovers,
    PRAYER_POTIONS,
    presetFor,
    QUEST_FINDS,
    questGatherPlan,
    shopPlan,
    STURDY,
    STURDY_OPTIONAL,
    travelDistance,
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

export type QuestSweepNeeds = {
    // No shop sells it and no gather plan covers it: the sweep ends with "missing <id>:<count>" unless the bank holds it.
    readonly bank: readonly QuestSweepItem[];
    // A shop sells it: the sweep buys it with banked coins.
    readonly shop: readonly QuestSweepItem[];
    // The preset's coins, which the sweep withdraws with the pack.
    readonly coins: number;
};

const EMPTY: QuestSweepNeeds = { bank: [], shop: [], coins: 0 };
const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Prayer', 'Magic', 'Ranged'] as const;
const memo = new Map<string, QuestSweepNeeds>();

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
        memo.set(key, EMPTY);
        return EMPTY;
    }
    let base = needs(preset, false, quest);
    const coins = base.get(COINS) ?? 0;
    base.delete(COINS);
    if (started) for (const id of spentAtEveryStage(quest)) base.delete(id);
    if (lv('Hitpoints') >= STURDY && lv('Defence') >= STURDY) for (const id of STURDY_OPTIONAL[quest] ?? []) base.delete(id);
    if (prayerCovers(quest, lv('Prayer'))) for (const id of PRAYER_POTIONS) base.delete(id);
    for (const id of [...ANTIPOISONS, ...(QUEST_FINDS[quest] ?? [])]) base.delete(id);
    if (FIRE_QUESTS.has(quest)) base = fireRunesFor(base, lv('Magic'));
    for (const i of buildPack(quest, lv)) base.set(i.id, (base.get(i.id) ?? 0) + i.count);
    for (const i of WORN_KIT[quest] ?? []) if (i.required) base.set(i.id, Math.max(1, base.get(i.id) ?? 0));

    const at = preset.position;
    const sellerAt = (id: number) => {
        const it = catalogItem(id);
        const n = it && id !== COINS ? sellersByDistance(it.debugname, at)[0] : undefined;
        return n ? travelDistance(at, n.tile) : Infinity;
    };
    const bank: QuestSweepItem[] = [];
    const shop: QuestSweepItem[] = [];
    for (const [id, count] of base) {
        // The sweep passes Ranged and Magic only with a bow or a staff kit in the bank: without one it kills by melee.
        const gather = questGatherPlan(quest, [{ id, count }], at, sellerAt, undefined, lv('Attack'), 1, undefined, 1, lv('Strength'));
        for (const m of [...gather.still, ...gather.tools]) {
            const name = catalogItem(m.id)?.name;
            const row = { id: m.id, count: m.count, for: id, forCount: count, ...(name ? { name } : {}) };
            (sellerAt(m.id) === Infinity ? bank : shop).push(row);
        }
    }
    const out = { bank, shop, coins };
    memo.set(key, out);
    return out;
}

// The coins that the sweep takes from the bank: the preset's coins and the shop plan's price (shopPlan) of the shop
// items that the account lacks. `owned` counts an item in the pack, the bank and the worn slots.
export function questSweepCoins(need: QuestSweepNeeds, owned: (id: number) => number): number {
    const lacking: Item[] = [];
    for (const s of need.shop) {
        if (s.for !== s.id && owned(s.for) >= s.forCount) continue;
        const lack = s.count - owned(s.id);
        if (lack > 0) lacking.push({ id: s.id, count: lack });
    }
    const priced = shopPlan(lacking, { x: 0, z: 0, level: 0 }, catalogItem, () => ({ npc: '', npcId: 0, tile: { x: 0, z: 0, level: 0 } }));
    return need.coins + priced.coins;
}
