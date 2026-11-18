// Supply demand of the gang squad (the PK army's hunting party): what its members consume, as stock targets held in
// the members' banks. The plan's `squad` block names the members and whether the squad is active; the planner turns
// each line below into a demand row (`gang squad <account>: <item>`) that free accounts' supply jobs fill and that a
// donor's spare stock moves to the member. An inactive or absent block gives no demand.
// The table holds the estimates of the gang-hunt session per squad hour of four members, [low, high]: food in shark
// units at the cost of the two live pilots (300 to 410; the bench cost is 30 to 40), arrows and runes. A line's target
// is the middle of its range, per member, for SQUAD_HOURS hours.

export const SQUAD_SIZE = 4, SQUAD_HOURS = 4;
export const SQUAD_HOURLY: Readonly<Record<string, readonly [low: number, high: number]>> = {
    food: [300, 410], 'iron arrow': [550, 760], 'earth rune': [270, 375], 'water rune': [270, 375], 'nature rune': [180, 250], 'antipoison(3)': [3, 5],
};
// Each member also holds this many for the escape (Teleport to Varrock, Wind Strike away from a fight).
export const SQUAD_ESCAPE: Readonly<Record<string, number>> = { 'law rune': 2, 'air rune': 10 };
// One food line by the HP an item heals: the fleet holds lobsters, and a shark heals 20. Demand is in shark units.
export const SQUAD_FOOD_HEAL: Readonly<Record<string, number>> = { shark: 20, swordfish: 14, lobster: 12 };
export const SQUAD_FOOD = Object.keys(SQUAD_FOOD_HEAL);

export type SquadBlock = { active?: unknown; members?: unknown; hours?: unknown };
// `maxCoins`: the most the rows ask in coins at the shop price; the rows that would pass it are left out, the first lines first.
export const SQUAD_MAX_COINS = 320_000;
export type SquadInput = { active: boolean; hours: number; maxCoins?: number; members: readonly { name: string; items: Readonly<Record<string, number>> }[] };
export type SquadRow = { account: string; names: string[]; short: number; target: number; consumer: string };

// The squad block of a swarm plan, or an inactive squad: the members are names of the account list, the hours a whole
// number from 1 to 24 (default SQUAD_HOURS).
export function squadBlock(plan: unknown): { active: boolean; hours: number; members: string[]; maxCoins: number } {
    const b = (plan as { squad?: SquadBlock } | null | undefined)?.squad;
    const members = Array.isArray(b?.members) ? b.members.filter((n): n is string => typeof n === 'string' && /^[A-Za-z0-9]{1,12}$/.test(n)) : [];
    const hours = typeof b?.hours === 'number' && Number.isSafeInteger(b.hours) && b.hours >= 1 && b.hours <= 24 ? b.hours : SQUAD_HOURS;
    const maxCoins = typeof (b as { maxCoins?: unknown } | undefined)?.maxCoins === 'number' && Number.isSafeInteger((b as { maxCoins: number }).maxCoins) && (b as { maxCoins: number }).maxCoins >= 0 ? (b as { maxCoins: number }).maxCoins : SQUAD_MAX_COINS;
    return { active: b?.active === true && members.length > 0, hours, members, maxCoins };
}

// The stock target of a line for one member: the middle of the hourly range, a share of a squad hour of SQUAD_SIZE
// members, for `hours` hours.
export const squadTarget = (item: string, hours: number): number => {
    const [low, high] = SQUAD_HOURLY[item] ?? [0, 0];
    return Math.ceil(((low + high) / 2) / SQUAD_SIZE * hours);
};
// What a member holds of a line, in the line's units: food as shark units by heal.
export function squadHeld(item: string, items: Readonly<Record<string, number>>): number {
    return item === 'food' ? Object.entries(SQUAD_FOOD_HEAL).reduce((n, [food, heal]) => n + (items[food] ?? 0) * heal / SQUAD_FOOD_HEAL.shark!, 0) : items[item] ?? 0;
}
// The most of each item a squad member keeps for the squad, by item name: a donor that is a member gives only what it
// holds above this. Each food item is kept up to the whole food target in its own units.
export function squadKeeps(hours: number): Record<string, number> {
    const keeps: Record<string, number> = { ...SQUAD_ESCAPE };
    for (const item of Object.keys(SQUAD_HOURLY)) {
        if (item !== 'food') { keeps[item] = squadTarget(item, hours); continue; }
        for (const food of SQUAD_FOOD) keeps[food] = Math.ceil(squadTarget('food', hours) * SQUAD_FOOD_HEAL.shark! / SQUAD_FOOD_HEAL[food]!);
    }
    return keeps;
}

// The demand rows of an active squad: each line a member holds fewer of than its target, and each escape item it lacks. Food
// is sized in lobsters (the fleet's food: 20/12 of a shark unit each), so the lobster chain sees the whole food demand. The
// rows are priced with `price` (the plan's price table; a missing price falls back to SQUAD_UNIT_COST of the supply table or
// 150 for food) and kept in line order while they fit `maxCoins`.
const FOOD_UNIT_COINS = 150;
export function squadRows(squad: SquadInput | undefined, price: (item: string) => number | undefined = () => undefined, unitCost: Readonly<Record<string, number>> = {}): SquadRow[] {
    if (!squad?.active) return [];
    const rows: SquadRow[] = [];
    let budget = squad.maxCoins ?? SQUAD_MAX_COINS;
    for (const m of squad.members) {
        const lines: [string, string[], number][] = [
            ...Object.keys(SQUAD_HOURLY).map(item => [item, item === 'food' ? SQUAD_FOOD : [item], squadTarget(item, squad.hours)] as [string, string[], number]),
            ...Object.entries(SQUAD_ESCAPE).map(([item, n]) => [item, [item], n] as [string, string[], number]),
        ];
        for (const [item, names, target] of lines) {
            const units = Math.max(0, Math.ceil(target - squadHeld(item, m.items)));
            if (units <= 0) continue;
            const short = item === 'food' ? Math.ceil(units * SQUAD_FOOD_HEAL.shark! / SQUAD_FOOD_HEAL.lobster!) : units;
            const coins = short * (price(item === 'food' ? 'lobster' : item) ?? unitCost[item] ?? (item === 'food' ? FOOD_UNIT_COINS : 0));
            if (coins > budget) continue;
            budget -= coins;
            rows.push({ account: m.name.toLowerCase(), names, short, target, consumer: `gang squad ${m.name}: ${item}` });
        }
    }
    return rows;
}
