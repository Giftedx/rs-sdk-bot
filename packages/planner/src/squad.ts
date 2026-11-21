// Supply demand of the gang squad (the PK army's hunting party): what its members consume, as stock targets held in
// the members' banks. The plan's `squad` block names the members and whether the squad is active; the planner turns
// each line below into a demand row (`gang squad <account>: <item>`) that free accounts' supply jobs fill and that a
// donor's spare stock moves to the member. An inactive or absent block gives no demand.
// The table holds the estimates of the gang-hunt session per squad hour of four members, [low, high]: food in shark
// units at the cost of the two live pilots (300 to 410; the bench cost is 30 to 40), arrows and runes. A line's target
// is the middle of its range, per member, for SQUAD_HOURS hours.
// The supply is the best of each kind, not the cheapest: rune arrows (the magic shortbow fires them) and sharks.

export const SQUAD_SIZE = 4, SQUAD_HOURS = 4;
export const SQUAD_HOURLY: Readonly<Record<string, readonly [low: number, high: number]>> = {
    food: [300, 410],
    arrow: [550, 760],
    'earth rune': [270, 375],
    'water rune': [270, 375],
    'nature rune': [180, 250],
    'antipoison(3)': [3, 5],
    'law rune': [16, 24],
    'air rune': [240, 360],
    'cooked karambwan': [50, 70],
    'prayer potion(3)': [8, 16],
    'super attack(3)': [4, 8],
    'super strength(3)': [4, 8],
    'super defence(3)': [4, 8],
    'ranging potion(3)': [4, 8],
    'fire rune': [240, 360],
    'blood rune': [80, 140],
    'cosmic rune': [12, 20],
};
// Each member also holds this minimum escape stock (Camelot Teleport away from a fight, matching tribrid-bis-zerk-glory-tele).
export const SQUAD_ESCAPE: Readonly<Record<string, number>> = { 'law rune': 3, 'air rune': 15 };
// Equivalent potion lines in 3-dose units (four-dose bottles count 4/3 of a three-dose bottle).
export const SQUAD_POTION_ALIASES: Readonly<Record<string, readonly [name: string, doses: number][]>> = {
    'antipoison(3)': [['antipoison(3)', 3], ['superantipoison(3)', 3], ['antipoison(4)', 4], ['superantipoison(4)', 4]],
    'prayer potion(3)': [['prayer potion(3)', 3], ['prayer potion(4)', 4]],
    'super attack(3)': [['super attack(3)', 3], ['super attack(4)', 4]],
    'super strength(3)': [['super strength(3)', 3], ['super strength(4)', 4]],
    'super defence(3)': [['super defence(3)', 3], ['super defence(4)', 4]],
    'ranging potion(3)': [['ranging potion(3)', 3], ['ranging potion(4)', 4]],
    'super energy(3)': [['super energy(3)', 3], ['super energy(4)', 4]],
    'agility potion(3)': [['agility potion(3)', 3], ['agility potion(4)', 4]],
};
// Per-member spare PK gear buffers held continuously so a single trip loss does not stall squad readiness.
export const SQUAD_SPARES: Readonly<Record<string, number>> = {
    'ring of recoil': 4,
    'climbing boot': 2,
    'dragon dagger(p)': 2,
    'magic shortbow': 2,
    'berserker helm': 2,
    'amulet of glory(4)': 2,
    'rune full helm': 2,
    'rune platebody': 2,
    'rune plateleg': 2,
    'rune kiteshield': 2,
    black_dragonhide_body: 2,
    black_dragonhide_chaps: 2,
    black_dragon_vambraces: 2,
};
// Gear aliases accepted for spare armour/jewellery slots so Wave B/C Dragon upgrades or partially charged glories
// satisfy their corresponding spare slot and are retained by donors.
export const SQUAD_GEAR_ALIASES: Readonly<Record<string, readonly string[]>> = {
    'amulet of glory(4)': ['amulet of glory(4)', 'amulet of glory(3)', 'amulet of glory(2)', 'amulet of glory(1)'],
    'rune platebody': ['rune platebody', 'dragon chainbody'],
    'rune kiteshield': ['rune kiteshield', 'dragon sq shield'],
    'rune plateleg': ['rune plateleg', 'dragon plateleg'],
};
// The arrows that count toward the arrow line, best first. A row asks for poisoned rune arrows first, then unpoisoned.
export const SQUAD_ARROWS: readonly string[] = ['rune arrow(p)', 'rune arrow', 'adamant arrow'];
// What a member holds counts by the HP an item heals (a lobster held is still food); new food is sharks. Demand is in shark units.
export const SQUAD_FOOD_HEAL: Readonly<Record<string, number>> = { shark: 20, swordfish: 14, lobster: 12 };
export const SQUAD_FOOD = Object.keys(SQUAD_FOOD_HEAL);
// Wave B/C/D BiS benchmark parameters (Wave D winner tribrid-bis-zerk-tele-karam2: 12 sharks + 2 cooked karambwans + 3 law + 15 air).
export const SQUAD_WAVE_BC = {
    benchKits: ['tribrid-bis-zerk-glory-tele', 'tribrid-bis-zerk-tele-karam2'] as const,
    winnerKit: 'tribrid-bis-zerk-tele-karam2' as const,
    optimalSquadRange: [8, 12] as const,
    hourlyPerTribrid: {
        shark: 30,
        'cooked karambwan': 5,
        'rune arrow(p)': 160,
        'earth rune': 78,
        'water rune': 78,
        'nature rune': 62,
        'law rune': 4,
        'air rune': 16,
        'prayer potion(4)': 0.5,
        'super attack(4)': 1.5,
        'super strength(4)': 1.5,
        'super defence(4)': 1.5,
        'ranging potion(4)': 1.5,
        'superantipoison(4)': 1,
    } as Readonly<Record<string, number>>,
    tripFood: { shark: 12, 'cooked karambwan': 2 } as Readonly<Record<string, number>>,
    tripEscape: { 'law rune': 3, 'air rune': 15 } as Readonly<Record<string, number>>,
    wornNames: [
        'berserker helm', 'cape of legends', 'amulet of glory(4)', 'dragon dagger(p)',
        'dragon chainbody', 'dragon sq shield', 'dragon plateleg', 'black_dragon_vambraces',
        'climbing boot', 'ring of recoil', 'rune arrow(p)',
    ] as readonly string[],
} as const;

export function squadBurnBudget(tribrids = 10, hours = SQUAD_HOURS, opts: { comboFood?: boolean } = {}): Record<string, number> {
    const comboFood = opts.comboFood ?? true, out: Record<string, number> = {};
    for (const [item, perHr] of Object.entries(SQUAD_WAVE_BC.hourlyPerTribrid)) {
        if (item === 'cooked karambwan' && !comboFood) continue;
        const base = Math.ceil(perHr * tribrids * hours);
        const floor = ((SQUAD_WAVE_BC.tripEscape[item] ?? 0) + (SQUAD_WAVE_BC.tripFood[item] ?? 0)) * tribrids;
        out[item] = Math.max(base, floor);
    }
    return out;
}

// The names that a row of a line asks for: sharks for food, the best arrows for the arrow line, potions in preferred order, else the item itself.
export const squadLineNames = (item: string): string[] => {
    if (item === 'food') return ['shark'];
    if (item === 'arrow') return [...SQUAD_ARROWS];
    const potion = SQUAD_POTION_ALIASES[item];
    if (potion) return potion.map(([name]) => name);
    const alias = SQUAD_GEAR_ALIASES[item];
    if (alias) return [...alias];
    return [item];
};

export type SquadBlock = { active?: unknown; members?: unknown; hours?: unknown };
// `maxCoins`: the most the rows ask in coins at the shop price in ONE PASS (a budget of outstanding demand, not a total: as stock
// arrives and hunts use it up, the shortage and its budget come back). The rows that would pass it are left out, the first lines first.
// An item with no price counts 0 and is never cut. Each supply run is capped on its own by MAX_SPEND.
// `all`: every member of the block this side owns, whether it is restocked now or held; it drives the hold-out and the donor
// reserve, while `members` (observed, not held) drives the restock rows.
export const SQUAD_MAX_COINS = 2_000_000;
export type SquadInput = { active: boolean; hours: number; maxCoins?: number; all?: readonly string[]; members: readonly { name: string; items: Readonly<Record<string, number>> }[] };
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
// What a member holds of a line, in the line's units: food as shark units by heal, potions in 3-dose units.
export function squadHeld(item: string, items: Readonly<Record<string, number>>): number {
    if (item === 'arrow') return SQUAD_ARROWS.reduce((n, arrow) => n + (items[arrow] ?? 0), 0);
    if (item === 'food') return Object.entries(SQUAD_FOOD_HEAL).reduce((n, [food, heal]) => n + (items[food] ?? 0) * heal / SQUAD_FOOD_HEAL.shark!, 0);
    const potion = SQUAD_POTION_ALIASES[item];
    if (potion) return potion.reduce((n, [name, doses]) => n + (items[name] ?? 0) * doses / 3, 0);
    const alias = SQUAD_GEAR_ALIASES[item];
    if (alias) return alias.reduce((n, name) => n + (items[name] ?? 0), 0);
    return items[item] ?? 0;
}
// The most of each item a squad member keeps for the squad, by item name: a donor that is a member gives only what it
// holds above this. Each food item is kept up to the whole food target in its own units.
export function squadKeeps(hours: number): Record<string, number> {
    const keeps: Record<string, number> = { ...SQUAD_ESCAPE, ...SQUAD_SPARES, 'cape of legend': 2 };
    for (const [primary, names] of Object.entries(SQUAD_GEAR_ALIASES)) {
        const cap = SQUAD_SPARES[primary] ?? 2;
        for (const name of names) keeps[name] = Math.max(keeps[name] ?? 0, cap);
    }
    for (const item of Object.keys(SQUAD_HOURLY)) {
        const target = Math.max(squadTarget(item, hours), SQUAD_ESCAPE[item] ?? 0);
        if (item === 'arrow') { for (const arrow of SQUAD_ARROWS) keeps[arrow] = target; continue; }
        if (item === 'food') {
            for (const food of SQUAD_FOOD) keeps[food] = Math.ceil(target * SQUAD_FOOD_HEAL.shark! / SQUAD_FOOD_HEAL[food]!);
            continue;
        }
        const potion = SQUAD_POTION_ALIASES[item];
        if (potion) {
            for (const [name, doses] of potion) keeps[name] = Math.max(keeps[name] ?? 0, Math.ceil(target * 3 / doses));
            continue;
        }
        keeps[item] = Math.max(keeps[item] ?? 0, target);
    }
    return keeps;
}

// The demand rows of an active squad: each line a member holds fewer of than its target, and each escape/spare item it lacks. Food
// is sized in sharks, potions in 3-dose units, and the arrow line in rune arrows (squadLineNames). The rows are priced with `price`
// (the plan's price table; a missing price falls back to SQUAD_UNIT_COST of the supply table or 300 for a shark) and kept in line
// order while they fit `maxCoins`.
const FOOD_UNIT_COINS = 300;
export function squadRows(squad: SquadInput | undefined, price: (item: string) => number | undefined = () => undefined, unitCost: Readonly<Record<string, number>> = {}): SquadRow[] {
    if (!squad?.active) return [];
    const rows: SquadRow[] = [];
    let budget = squad.maxCoins ?? SQUAD_MAX_COINS;
    for (const m of squad.members) {
        const lines: [string, string[], number][] = [
            ...Object.keys(SQUAD_HOURLY).map(item => [item, squadLineNames(item), Math.max(squadTarget(item, squad.hours), SQUAD_ESCAPE[item] ?? 0)] as [string, string[], number]),
            ...Object.entries(SQUAD_ESCAPE).filter(([item]) => !(item in SQUAD_HOURLY)).map(([item, n]) => [item, squadLineNames(item), n] as [string, string[], number]),
            ...Object.entries(SQUAD_SPARES).filter(([item]) => !(item in SQUAD_HOURLY)).map(([item, n]) => [item, squadLineNames(item), n] as [string, string[], number]),
        ];
        for (const [item, names, target] of lines) {
            const units = Math.max(0, Math.ceil(target - squadHeld(item, m.items)));
            if (units <= 0) continue;
            const short = units, first = names[0]!;
            const coins = short * (price(first) ?? unitCost[first] ?? (item === 'food' ? FOOD_UNIT_COINS : 0));
            if (coins > budget) continue;
            budget -= coins;
            rows.push({ account: m.name.toLowerCase(), names, short, target, consumer: `gang squad ${m.name}: ${item}` });
        }
    }
    return rows;
}
