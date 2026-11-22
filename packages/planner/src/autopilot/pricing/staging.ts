// Squad shop spend caps/unit costs and mainland specialist staging bills/demand computation.
import { SQUAD_POTION_ALIASES } from '../../squad';
import { norm, type Acct, type GoalNeed, type Inputs, type SpecialistStageLine } from '../world';

export const SQUAD_RUN_MAX: Readonly<Record<string, number>> = {
    'rune arrow': 400, 'water rune': 1500, 'earth rune': 1500, 'air rune': 1500, 'fire rune': 1500,
    'nature rune': 1000, 'law rune': 200, 'blood rune': 200, 'death rune': 500, 'chaos rune': 1000, 'mind rune': 1000,
    'antipoison(3)': 12, 'cooked karambwan': 50, 'raw karambwan': 108, 'climbing boot': 10, 'dragon dagger': 2,
    'cape of legend': 2, 'shield right half': 1, 'dragon battleaxe': 2, 'dragon mace': 2,
    'berserker helm': 2, 'rune platebody': 2, 'rune plateleg': 4, 'black full helm': 2, 'black platebody': 2, 'black plateleg': 2,
    'uncut sapphire': 28, 'uncut emerald': 28, 'eye of newt': 100, 'vial of water': 100,
    'waterskin(4)': 8, 'bronze bar': 20, 'chocolate bar': 28, cake: 28, 'priest gown': 4, 'leather glove': 4,
    'fishing bait': 500, papyrus: 20, 'ball of wool': 20, charcoal: 20,
};
// The shop cost of one unit (knowledge/items.json), the fallback of a run's spend cap: the rows are priced from the plan's
// price table (`prices`, from priceTable) when it holds the item.
export const SQUAD_UNIT_COST: Readonly<Record<string, number>> = {
    'rune arrow': 400, 'rune arrow(p)': 420, 'rune arrowtips': 200, shark: 300, 'cooked karambwan': 320, 'raw karambwan': 240, 'karambwan vessel': 5,
    'water rune': 4, 'earth rune': 4, 'air rune': 4, 'fire rune': 4, 'nature rune': 20, 'law rune': 40,
    'cosmic rune': 50, 'blood rune': 550, 'death rune': 180, 'chaos rune': 90, 'mind rune': 4,
    'antipoison(3)': 288, 'prayer potion(3)': 500, 'prayer potion(4)': 667,
    'super attack(3)': 400, 'super attack(4)': 533, 'super strength(3)': 500, 'super strength(4)': 667,
    'super defence(3)': 600, 'super defence(4)': 800, 'ranging potion(3)': 650, 'ranging potion(4)': 867,
    'super restore(3)': 240, 'super restore(4)': 320, 'magic potion(3)': 250, 'magic potion(4)': 333,
    'zamorak potion(3)': 25, 'zamorak potion(4)': 33, 'restore potion(3)': 80, 'restore potion(4)': 107,
    'superantipoison(3)': 400, 'superantipoison(4)': 533,
    'super energy(3)': 230, 'super energy(4)': 300, 'agility potion(3)': 150, 'agility potion(4)': 200,
    'ring of recoil': 300, 'emerald ring': 1275, 'ring of dueling(8)': 1275,
    'dragonstone': 10_000, 'uncut dragonstone': 10_000, 'dragonstone ring': 17_625, 'dragon necklace': 18_375,
    'unstrung dragonstone amulet': 17_625, 'strung dragonstone amulet': 17_625, 'amulet of glory': 17_625, 'amulet of glory(4)': 25_000, 'ring of wealth': 17_625,
    'climbing boot': 12, 'cape of legend': 675, 'dragon dagger': 30_000, 'dragon dagger(p)': 32_000,
    'dragon battleaxe': 200_000, 'dragon mace': 50_000, 'shield right half': 750_000, 'crystal key': 500, keyhalf1: 250, keyhalf2: 250,
    'dragon chainbody': 250_000, 'dragon sq shield': 1_250_000, 'dragon plateleg': 270_000,
    'magic shortbow': 1600, 'berserker helm': 78_000, 'rune full helm': 35_200, 'rune platebody': 84_500, 'rune plateleg': 64_000, 'rune kiteshield': 54_400,
    'black full helm': 1056, 'black platebody': 3840, 'black plateleg': 1920,
    black_dragonhide_body: 13_480, black_dragonhide_chaps: 6_500, black_dragon_vambraces: 4_200,
    'uncut sapphire': 25, 'uncut emerald': 500, emerald: 500, 'eye of newt': 3, 'vial of water': 2,
    'waterskin(4)': 30, 'bronze bar': 16, nail: 3, plank: 1, 'swamp toad': 2, "toad's leg": 2,
    'chocolate bar': 10, 'chocolate dust': 2, cake: 50, 'chocolate cake': 70,
    'priest gown': 5, 'leather glove': 6, 'fishing bait': 3, papyrus: 10, 'ball of wool': 2, charcoal: 45,
};

// Route shortages and the missing kits of eligible army bands are the consumers. Army purchase budgets retain
// their recipient, so wealth that account cannot spend or receive cannot hide its funding gap.
const specPot = (k: string): readonly string[] => SQUAD_POTION_ALIASES[k]?.map(([n]) => norm(n)) ?? [norm(k)];
const NON_WILDY_ANTIPOISON = specPot('antipoison(3)');
export const SPECIALIST_STAGE_BILLS: Readonly<Record<string, readonly SpecialistStageLine[]>> = {
    hitpoints: [
        { names: ['air rune'], count: 2500 }, { names: ['mind rune'], count: 140 }, { names: ['chaos rune'], count: 220 },
        { names: ['death rune'], count: 220 }, { names: ['law rune'], count: 60 }, { names: ['water rune'], count: 35 },
        { names: ['coin'], count: 5000 }, { names: ['staff of fire'], count: 1 }, { names: ['leather glove'], count: 1 },
        { names: ['cheese'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 }, { names: ['dragon bone'], count: 11 },
        { names: ['log'], count: 6 }, { names: ['prayer potion(4)'], count: 18 }, { names: ['shark'], count: 20 },
        { names: ['gold bar'], count: 1 }, { names: ['ball of wool'], count: 1 }, { names: NON_WILDY_ANTIPOISON, count: 3 },
    ],
    'thieving-live': [
        { names: ['chocolate cake'], count: 27 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    attack: [
        { names: ['staff of fire'], count: 1 }, { names: ['mind rune'], count: 50 }, { names: ['air rune'], count: 1300 },
        { names: ['law rune'], count: 30 }, { names: ['chaos rune'], count: 240 }, { names: ['coin'], count: 200 },
        { names: ['dragon bone'], count: 11 }, { names: ['log'], count: 6 }, { names: ['prayer potion(4)'], count: 3 },
        { names: ['lobster'], count: 2 },
    ],
    strength: [
        { names: ['air rune'], count: 6 }, { names: ['earth rune'], count: 6 }, { names: ['water rune'], count: 6 },
        { names: ['rune scimitar'], count: 1 }, { names: ['amulet of strength'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
        { names: ['rope'], count: 1 }, { names: ['prayer potion(4)'], count: 2 }, { names: ['shark'], count: 1 },
        { names: ['super energy(4)'], count: 1 }, { names: ['super attack(4)'], count: 1 }, { names: ['super strength(4)'], count: 5 },
        { names: ['dragon bone'], count: 11 },
    ],
    defence: [
        { names: ['air rune'], count: 6 }, { names: ['earth rune'], count: 6 }, { names: ['water rune'], count: 6 },
        { names: ['rune scimitar'], count: 1 }, { names: ['amulet of strength'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
        { names: ['rope'], count: 1 }, { names: ['prayer potion(4)'], count: 2 }, { names: ['shark'], count: 1 },
        { names: ['super energy(4)'], count: 1 }, { names: ['super attack(4)'], count: 1 }, { names: ['super strength(4)'], count: 5 },
        { names: ['dragon bone'], count: 11 },
    ],
    'ranged-live': [
        { names: ['dragon bone'], count: 11 }, { names: ['cannon base'], count: 1 }, { names: ['cannon stand'], count: 1 },
        { names: ['cannon barrel'], count: 1 }, { names: ['cannon furnace'], count: 1 }, { names: ['cannonball'], count: 1500 },
        { names: ['ring of dueling(8)'], count: 1 }, { names: ['shortbow'], count: 1 }, { names: ['iron arrow'], count: 300 },
        { names: ['leather body'], count: 1 }, { names: ['prayer potion(4)'], count: 8 }, { names: ['lobster'], count: 5 },
        { names: ['magic shortbow'], count: 1 }, { names: ['rune arrow'], count: 1000 },
        { names: ['black_dragonhide_chaps', 'black_dragonhide_chap'], count: 1 },
        { names: ['black_dragon_vambraces', 'black_dragon_vambrace'], count: 1 },
        { names: NON_WILDY_ANTIPOISON, count: 8 },
    ],
    'fletching-live': [
        { names: ['bronze arrowtip'], count: 60 }, { names: ['iron arrowtip'], count: 90 }, { names: ['steel arrowtip'], count: 135 },
        { names: ['mithril arrowtip'], count: 225 }, { names: ['adamant arrowtip'], count: 495 }, { names: ['rune arrowtip'], count: 2595 },
        { names: ['headless arrow'], count: 3600 },
    ],
    fishing: [
        { names: ['small fishing net'], count: 1 }, { names: ['fishing rod'], count: 1 }, { names: ['fly fishing rod'], count: 1 },
        { names: ['fishing bait'], count: 60 }, { names: ['feather'], count: 1500 }, { names: ['knife'], count: 1 },
        { names: ['log'], count: 5 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'mining-live': [
        { names: ['clay'], count: 6 }, { names: ['copper ore'], count: 4 }, { names: ['iron ore'], count: 2 },
        { names: ['knife'], count: 1 }, { names: ['rune pickaxe'], count: 1 }, { names: ['log'], count: 2 },
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    prayer: [{ names: ['dragon bone'], count: 555 }],
    smithing: [
        { names: ['hammer'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 }, { names: ['bronze bar'], count: 9 },
        { names: ['iron bar'], count: 42 }, { names: ['steel bar'], count: 100 }, { names: ['mithril bar'], count: 275 },
        { names: ['adamantite bar'], count: 375 },
    ],
    runecraft: [
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['air talisman'], count: 1 },
        { names: ['body talisman'], count: 1 }, { names: ['rune essence'], count: 5355 },
    ],
    crafting: [
        { names: ['chisel'], count: 1 }, { names: ['uncut opal'], count: 18 }, { names: ['uncut sapphire'], count: 3 },
        { names: ['uncut emerald'], count: 6 }, { names: ['uncut ruby'], count: 3 }, { names: ['uncut diamond'], count: 9 },
        { names: ['uncut dragonstone'], count: 277 },
    ],
    herblore: [
        { names: ['games necklace(8)'], count: 1 }, { names: ['raw beef'], count: 1 }, { names: ['raw rat meat'], count: 1 },
        { names: ['raw bear meat'], count: 1 }, { names: ['raw chicken'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
        { names: ['harralander potion (unf)'], count: 10 }, { names: ['chocolate dust'], count: 10 }, { names: ['irit potion (unf)'], count: 10 },
        { names: ['eye of newt'], count: 10 }, { names: ['kwuarm potion (unf)'], count: 30 }, { names: ['limpwurt root'], count: 10 },
        { names: ['dragon scale dust'], count: 50 }, { names: ['lantadyme potion (unf)'], count: 30 }, { names: ['torstol potion (unf)'], count: 170 },
        { names: ['jangerberrie'], count: 170 },
    ],
    magic: [
        { names: ['staff of fire'], count: 1 }, { names: ['mind rune'], count: 25 }, { names: ['cosmic rune'], count: 150 },
        { names: ['water rune'], count: 20 }, { names: ['air rune'], count: 1500 }, { names: ['earth rune'], count: 400 },
        { names: ['sapphire ring'], count: 12 }, { names: ['emerald ring'], count: 27 }, { names: ['shark'], count: 3 },
        { names: ['ruby ring'], count: 72 }, { names: ['diamond ring'], count: 36 }, { names: ['law rune'], count: 12 },
        { names: ['blood rune'], count: 850 }, { names: ['knife'], count: 1 }, { names: ['dragon bone'], count: 8 },
        { names: ['prayer potion(4)'], count: 2 }, { names: ['amulet of magic'], count: 1 }, { names: ['super energy(4)'], count: 1 },
    ],
    'cooking-live': [
        { names: ['raw lobster'], count: 1000 }, { names: ['raw karambwan'], count: 1000 }, { names: ['raw shark'], count: 1000 },
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    'woodcutting-live': [
        { names: ['bronze axe'], count: 1 }, { names: ['steel axe'], count: 1 }, { names: ['mithril axe'], count: 1 },
        { names: ['adamant axe'], count: 1 }, { names: ['rune axe'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'firemaking-live': [
        { names: ['tinderbox'], count: 1 }, { names: ['log'], count: 100 }, { names: ['oak log'], count: 200 },
        { names: ['willow log'], count: 500 }, { names: ['maple log'], count: 800 }, { names: ['yew log'], count: 800 },
        { names: ['magic log'], count: 500 },
    ],
    'agility-live': [
        { names: ['summer pie'], count: 20 }, { names: ['super energy(4)'], count: 20 }, { names: ['shark'], count: 50 },
        { names: ['ring of dueling(8)'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'haggis-mainland': [
        { names: ['uncut dragonstone'], count: 277 }, { names: ['gold bar'], count: 277 }, { names: ['ball of wool'], count: 277 },
        { names: ['chisel'], count: 1 }, { names: ['ring mould'], count: 1 }, { names: ['necklace mould'], count: 1 },
        { names: ['amulet mould'], count: 1 }, { names: ['amulet of glory(4)'], count: 2 }, { names: ['ring of dueling(8)'], count: 4 },
        { names: ['games necklace(8)'], count: 2 }, { names: ['prayer potion(4)'], count: 25 }, { names: ['super restore(4)'], count: 10 },
        { names: ['super energy(4)'], count: 20 }, { names: NON_WILDY_ANTIPOISON, count: 10 },
    ],
};

export function specialistStagingNeeds(inp: Inputs, mine: readonly Acct[]): GoalNeed[] {
    const requested = [...new Set((inp.specialists ?? []).map(s => s.toLowerCase()))].filter(k => k in SPECIALIST_STAGE_BILLS);
    if (!requested.length) return [];
    const squadMembers = new Set((inp.squad?.active ? inp.squad.all ?? inp.squad.members.map(m => m.name) : []).map(n => n.toLowerCase()));
    const byHolder = new Map<string, Record<string, number>>();
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (inp.army?.has(lower) || squadMembers.has(lower)) continue;
        byHolder.set(lower, a.items);
    }
    for (const s of inp.stock ?? []) {
        const lower = s.name.toLowerCase();
        if (inp.army?.has(lower) || squadMembers.has(lower)) continue;
        const prev = byHolder.get(lower) ?? {};
        const merged: Record<string, number> = { ...prev };
        for (const [item, n] of Object.entries(s.items)) merged[item] = Math.max(merged[item] ?? 0, n);
        byHolder.set(lower, merged);
    }
    const freePool = new Map<string, number>();
    for (const items of byHolder.values()) for (const [item, n] of Object.entries(items)) freePool.set(item, (freePool.get(item) ?? 0) + n);
    // Reserve direct route need so specialist staging only consumes uncommitted free stock.
    for (const r of inp.bill) if (r.need > 0) for (const k of [r.item, ...(r.aliases ?? [])].map(norm)) {
        const held = freePool.get(k) ?? 0;
        if (held > 0) { freePool.set(k, Math.max(0, held - r.need)); break; }
    }
    const out: GoalNeed[] = [];
    for (const key of requested) for (const line of SPECIALIST_STAGE_BILLS[key]!) {
        let left = line.count;
        for (const name of line.names) {
            const avail = freePool.get(name) ?? 0;
            const take = Math.min(left, avail);
            if (take > 0) { freePool.set(name, avail - take); left -= take; }
        }
        if (left > 0) out.push({ names: [...line.names], short: left, consumer: `specialist ${key}: ${line.names[0]}` });
    }
    return out;
}
