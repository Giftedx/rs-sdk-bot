// Hiscore snapshot board parsing, skill supply ladders, haggis-boards.json activity loading, and QP specialist table adaptation.
import { readFileSync, statSync } from 'node:fs';
import { xpForLevel } from '../curve';
import { planSkill, type Method } from '../plan';
import { BOARDS_FILE, SKILLS, type Activity, type Board, type BoardId, type Skill, type Supply } from './model';

const SNAPSHOT_NAMES: ReadonlyMap<string, BoardId> = new Map([
    ...SKILLS.map(s => [`${s[0]!.toUpperCase()}${s.slice(1)}`, s] as const),
    ['Overall', 'overall'],
    ['Quest Points', 'questpoints'],
]);

interface Snapshot { takenAt: string; boards: { board: string; rows: { name: string; level: number; ticks: number }[] }[] }

export function boardsFromSnapshot(snap: Snapshot): Board[] {
    const out: Board[] = [];
    for (const b of snap.boards) {
        const id = SNAPSHOT_NAMES.get(b.board);
        const top = b.rows[0];
        if (!id || !top) continue;
        if (id === 'questpoints') out.push({ id, label: `${b.board} (#1 ${top.name}, ${top.level} QP)`, rule: { kind: 'qp', leaderPoints: top.level, leaderTicks: top.ticks } });
        else out.push({ id, label: `${b.board} (#1 ${top.name})`, rule: { kind: 'clock', deadline: top.ticks } });
    }
    out.push({ id: 'equipment', label: 'Equipment (worn value)', rule: { kind: 'value', note: 'hiscore_outfit.value desc (hiscores.ts:620); #1 value not in the snapshot' } });
    out.push({ id: 'bank', label: 'Bank (bank value)', rule: { kind: 'value', note: 'hiscore_bank.value desc (hiscores.ts:981); #1 value not in the snapshot' } });
    out.push({ id: 'runite', label: 'Lava Maze Runite (ores)', rule: { kind: 'value', note: 'count of runite_mine rows desc, ties by last_mined asc (hiscores.ts:791-801); #1 count not in the snapshot' } });
    return out;
}

export function loadSnapshot(path: string): Board[] {
    return boardsFromSnapshot(JSON.parse(readFileSync(path, 'utf8')) as Snapshot);
}

// ---------- Supply ladders (reuse planSkill: same ticks per action, so XP per action decides) ----------

export interface Tier { id: string; level: number; xpPerAction: number; items: Supply[] }

function ladderSupplies(skill: Skill, tiers: Tier[], margin = 1, toLevel = 99): Supply[] {
    const methods: Method[] = tiers.map(t => ({ id: t.id, skill, level: t.level, xpPerHour: t.xpPerAction, source: 'estimated' }));
    const plan = planSkill({ skill, fromXp: 0, toLevel, methods });
    const out = new Map<string | number, Supply>();
    for (const seg of plan.segments) {
        const tier = tiers.find(t => t.id === seg.method)!;
        const actions = Math.ceil((seg.xp / tier.xpPerAction) * margin);
        for (const { item, itemId, count } of tier.items) {
            const key = itemId ?? item, prior = out.get(key);
            out.set(key, { item: prior?.item ?? item, ...(itemId === undefined ? {} : { itemId }), count: (prior?.count ?? 0) + actions * count });
        }
    }
    return [...out.values()];
}

const each = (item: string, count = 1, itemId?: number): Supply => ({ item, count, ...(itemId === undefined ? {} : { itemId }) });
const X = 25; // server XP rate

const FLETCHING_TIERS: Tier[] = [
    { id: 'bronze arrows x15', level: 1, xpPerAction: 19.5 * X, items: [each('bronze arrowtips', 15), each('headless arrows', 15)] },
    { id: 'iron arrows x15', level: 15, xpPerAction: 37.5 * X, items: [each('iron arrowtips', 15), each('headless arrows', 15)] },
    { id: 'iron darts x10', level: 22, xpPerAction: 38 * X, items: [each('iron dart tips', 10), each('feathers', 10)] },
    { id: 'steel arrows x15', level: 30, xpPerAction: 75 * X, items: [each('steel arrowtips', 15), each('headless arrows', 15)] },
    { id: 'mithril arrows x15', level: 45, xpPerAction: 112.5 * X, items: [each('mithril arrowtips', 15), each('headless arrows', 15)] },
    { id: 'adamant arrows x15', level: 60, xpPerAction: 150 * X, items: [each('adamant arrowtips', 15), each('headless arrows', 15)] },
    { id: 'rune arrows x15', level: 75, xpPerAction: 187.5 * X, items: [each('rune arrowtips', 15), each('headless arrows', 15)] },
    { id: 'rune darts x10', level: 81, xpPerAction: 188 * X, items: [each('rune dart tips', 10), each('feathers', 10)] },
];
const CRAFTING_TIERS: Tier[] = [
    // gem.dbrow experience is in tenths; opal, jade, red topaz can smash (success_rate), so the CLI adds a margin
    { id: 'opal', level: 1, xpPerAction: 15 * X, items: [each('uncut opal')] },
    { id: 'jade', level: 13, xpPerAction: 20 * X, items: [each('uncut jade')] },
    { id: 'red topaz', level: 16, xpPerAction: 25 * X, items: [each('uncut red topaz')] },
    { id: 'sapphire', level: 20, xpPerAction: 50 * X, items: [each('uncut sapphire')] },
    { id: 'emerald', level: 27, xpPerAction: 67.5 * X, items: [each('uncut emerald')] },
    { id: 'ruby', level: 34, xpPerAction: 85 * X, items: [each('uncut ruby')] },
    { id: 'diamond', level: 43, xpPerAction: 107.5 * X, items: [each('uncut diamond')] },
    { id: 'dragonstone', level: 55, xpPerAction: 137.5 * X, items: [each('uncut dragonstone')] },
];
export const HERBLORE_TIERS: Tier[] = [
    // brew_potion.struct brew_potion_ingredient, brew_potion_level / brew_potion_exp (tenths)
    { id: 'attack', level: 1, xpPerAction: 25 * X, items: [each('guam potion (unf)'), each('eye of newt')] },
    { id: 'antipoison', level: 5, xpPerAction: 37.5 * X, items: [each('marrentill potion (unf)'), each('unicorn horn dust')] },
    { id: 'strength', level: 12, xpPerAction: 50 * X, items: [each('tarromin potion (unf)'), each('limpwurt root')] },
    { id: 'restore', level: 22, xpPerAction: 62.5 * X, items: [each('harralander potion (unf)'), each("red spiders' eggs")] },
    { id: 'energy', level: 26, xpPerAction: 67.5 * X, items: [each('harralander potion (unf)'), each('chocolate dust')] },
    { id: 'defence', level: 30, xpPerAction: 75 * X, items: [each('ranarr potion (unf)'), each('white berries')] },
    { id: 'agility', level: 34, xpPerAction: 80 * X, items: [each('toadflax potion (unf)'), each("toad's legs")] },
    { id: 'prayer', level: 38, xpPerAction: 87.5 * X, items: [each('ranarr potion (unf)'), each('snape grass')] },
    { id: 'super attack', level: 45, xpPerAction: 100 * X, items: [each('irit potion (unf)'), each('eye of newt')] },
    { id: 'superantipoison', level: 48, xpPerAction: 106.3 * X, items: [each('irit potion (unf)'), each('unicorn horn dust')] },
    { id: 'fishing', level: 50, xpPerAction: 112.5 * X, items: [each('avantoe potion (unf)'), each('snape grass')] },
    { id: 'super energy', level: 52, xpPerAction: 117.5 * X, items: [each('avantoe potion (unf)'), each('mort myre fungus')] },
    { id: 'super strength', level: 55, xpPerAction: 125 * X, items: [each('kwuarm potion (unf)'), each('limpwurt root')] },
    { id: 'weapon poison', level: 60, xpPerAction: 137.5 * X, items: [each('kwuarm potion (unf)'), each('dragon scale dust')] },
    { id: 'super restore', level: 63, xpPerAction: 142.5 * X, items: [each('snapdragon potion (unf)'), each("red spiders' eggs")] },
    { id: 'super defence', level: 66, xpPerAction: 150 * X, items: [each('cadantine potion (unf)'), each('white berries')] },
    { id: 'antifire', level: 69, xpPerAction: 157.5 * X, items: [each('lantadyme potion (unf)'), each('dragon scale dust')] },
    { id: 'ranging', level: 72, xpPerAction: 162.5 * X, items: [each('dwarf weed potion (unf)'), each('wine of zamorak')] },
    { id: 'magic', level: 76, xpPerAction: 172.5 * X, items: [each('lantadyme potion (unf)'), each('potato cactus')] },
    { id: 'zamorak brew', level: 78, xpPerAction: 175 * X, items: [each('torstol potion (unf)'), each('jangerberries')] },
];
export const FIREMAKING_TIERS: Tier[] = [
    { id: 'logs', level: 1, xpPerAction: 40 * X, items: [each('logs', 1, 1511)] },
    { id: 'oak', level: 15, xpPerAction: 60 * X, items: [each('oak logs')] },
    { id: 'willow', level: 30, xpPerAction: 90 * X, items: [each('willow logs')] },
    { id: 'maple', level: 45, xpPerAction: 135 * X, items: [each('maple logs')] },
    { id: 'yew', level: 60, xpPerAction: 202.5 * X, items: [each('yew logs')] },
    { id: 'magic', level: 75, xpPerAction: 303.8 * X, items: [each('magic logs')] },
];
export const SMITHING_TIERS: Tier[] = [
    { id: 'bronze dagger', level: 1, xpPerAction: 12.5 * X, items: [each('bronze bar')] },
    { id: 'bronze platebody', level: 18, xpPerAction: 62.5 * X, items: [each('bronze bar', 5)] },
    { id: 'iron platebody', level: 33, xpPerAction: 125 * X, items: [each('iron bar', 5)] },
    { id: 'steel platebody', level: 48, xpPerAction: 187.5 * X, items: [each('steel bar', 5)] },
    { id: 'mithril platebody', level: 68, xpPerAction: 250 * X, items: [each('mithril bar', 5)] },
    { id: 'adamant platebody', level: 88, xpPerAction: 312.5 * X, items: [each('adamantite bar', 5)] },
];
const MAGIC_TIERS: Tier[] = [
    // enchant XP from magic_spells.dbrow (research/xp-per-tick.md); rune costs from skill_magic/interfaces/magic.if
    { id: 'wind strike', level: 1, xpPerAction: 5.5 * X, items: [each('air rune'), each('mind rune')] },
    { id: 'enchant 1 (sapphire ring)', level: 7, xpPerAction: 17.5 * X, items: [each('cosmic rune'), each('water rune'), each('sapphire ring', 1, 1637)] },
    { id: 'enchant 2 (emerald ring)', level: 27, xpPerAction: 37 * X, items: [each('cosmic rune'), each('air rune', 3), each('emerald ring', 1, 1639)] },
    { id: 'enchant 3 (ruby ring)', level: 49, xpPerAction: 59 * X, items: [each('cosmic rune'), each('fire rune', 5), each('ruby ring', 1, 1641)] },
    { id: 'enchant 4 (diamond ring)', level: 57, xpPerAction: 67 * X, items: [each('cosmic rune'), each('earth rune', 10), each('diamond ring', 1, 1643)] },
    { id: 'enchant 5 (dragonstone amulet)', level: 68, xpPerAction: 78 * X, items: [each('cosmic rune'), each('water rune', 15), each('earth rune', 15), each('dragonstone amulet', 1, 1702)] },
];

// Stageable ladders (research/supply-logistics.md, Proposed substitutions). Rune dart tips, uncut dragonstones,
// dragonstone amulets and cosmic runes have no legal source at the scale of the full ladders above.
// Arrows only: rune arrows 187.5 XP per action of 15 against rune darts 188 per action of 10, both 5 per tick.
const FLETCHING_ARROW_TIERS: Tier[] = FLETCHING_TIERS.filter(t => !t.id.includes('darts'));
// Diamonds from 43 to 99 (gem.dbrow 107.5 base XP); the GE has sellers for uncut diamonds, not dragonstones.
const CRAFTING_NO_DRAGONSTONE_TIERS: Tier[] = CRAFTING_TIERS.filter(t => t.id !== 'dragonstone');
// Enchants without dragonstone amulets: diamond rings carry Magic from 57 to the Charge level (anvil route).
const MAGIC_NO_DRAGONSTONE_TIERS: Tier[] = MAGIC_TIERS.filter(t => !t.id.includes('dragonstone'));
// Teleports (magic_spells.dbrow levelrequired / experience in tenths / runesrequired). A staff of air pays the
// air runes (research/supply-costs.md, Magic), so air runes are not listed. Below 25 only combat spells exist.
const MAGIC_TELEPORT_TIERS: Tier[] = [
    { id: 'wind strike', level: 1, xpPerAction: 5.5 * X, items: [each('mind rune')] },
    { id: 'varrock teleport', level: 25, xpPerAction: 35 * X, items: [each('law rune'), each('fire rune')] },
    { id: 'lumbridge teleport', level: 31, xpPerAction: 41 * X, items: [each('law rune'), each('earth rune')] },
    { id: 'falador teleport', level: 37, xpPerAction: 48 * X, items: [each('law rune'), each('water rune')] },
    { id: 'camelot teleport', level: 45, xpPerAction: 55.5 * X, items: [each('law rune')] },
];

// ---------- The Haggis activity table ----------

// The activity table lives in haggis-boards.json so that new measurements change the plan without a code change.
// Each tick count and rate carries `evidence` and `source`. `suppliesLadder` names a tier table above: `tiers`
// when given, else the skill's full table; `toLevel` (default 99) ends the ladder early.
const LADDERS: Record<string, Tier[]> = {
    fletching: FLETCHING_TIERS, crafting: CRAFTING_TIERS, herblore: HERBLORE_TIERS,
    firemaking: FIREMAKING_TIERS, smithing: SMITHING_TIERS, magic: MAGIC_TIERS,
    'fletching-arrows': FLETCHING_ARROW_TIERS, 'crafting-no-dragonstone': CRAFTING_NO_DRAGONSTONE_TIERS,
    'magic-teleport': MAGIC_TELEPORT_TIERS, 'magic-no-dragonstone': MAGIC_NO_DRAGONSTONE_TIERS,
};

type ActivityJson = Activity & { suppliesLadder?: { skill: Skill; tiers?: string; margin?: number; toLevel?: number } };

type CachedBoardsJson = {
    mtimeMs: number;
    size: number;
    data: { activities: ActivityJson[]; supplyResearch?: Unsourceable[]; unsourceable?: Unsourceable[] };
    expandedActivities?: Activity[];
};
const boardsJsonCache = new Map<string, CachedBoardsJson>();
const ladderSuppliesCache = new Map<string, Supply[]>();

function readBoardsJson(path: string): CachedBoardsJson {
    const st = statSync(path);
    const cached = boardsJsonCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    const entry: CachedBoardsJson = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        data: JSON.parse(readFileSync(path, 'utf8')) as CachedBoardsJson['data'],
    };
    boardsJsonCache.set(path, entry);
    return entry;
}

function cachedLadderSupplies(skill: Skill, tierKey: string, tiers: Tier[], margin: number, toLevel: number): Supply[] {
    const key = `${skill}|${tierKey}|${margin}|${toLevel}`;
    let cached = ladderSuppliesCache.get(key);
    if (!cached) {
        cached = ladderSupplies(skill, tiers, margin, toLevel);
        ladderSuppliesCache.set(key, cached);
    }
    return cached;
}

function cloneActivity(a: Activity): Activity {
    return {
        ...a,
        ...(a.supplies ? { supplies: a.supplies.map(s => ({ ...s })) } : {}),
        ...(a.patches ? { patches: a.patches.map(p => ({ ...p })) } : {}),
        ...(a.requires ? { requires: [...a.requires] } : {}),
        ...(a.serves ? { serves: [...a.serves] } : {}),
        ...(a.xp ? { xp: { ...a.xp } } : {}),
        ...(a.minLevel ? { minLevel: { ...a.minLevel } } : {}),
    };
}

// Dated procurement leads, never quantity caps. Keep the old export for existing readers.
export interface Unsourceable { item: string; observedAvailable?: number; max?: number; reason: string; source: string }
export function haggisUnsourceable(path = BOARDS_FILE): Unsourceable[] {
    const { data } = readBoardsJson(path);
    return (data.supplyResearch ?? data.unsourceable ?? []).map(u => ({ ...u }));
}

export function haggisActivities(path = BOARDS_FILE): Activity[] {
    const entry = readBoardsJson(path);
    if (!entry.expandedActivities) {
        entry.expandedActivities = entry.data.activities.map(({ suppliesLadder, ...a }) => {
            if (!suppliesLadder) return a;
            const tierKey = suppliesLadder.tiers ?? suppliesLadder.skill;
            const tiers = LADDERS[tierKey];
            if (!tiers) throw new Error(`${a.id}: no tier table for ${tierKey}`);
            return { ...a, supplies: [...cachedLadderSupplies(suppliesLadder.skill, tierKey, tiers, suppliesLadder.margin ?? 1, suppliesLadder.toLevel ?? 99), ...(a.supplies ?? [])] };
        });
    }
    return entry.expandedActivities.map(cloneActivity);
}

const QP_SPECIALIST_OMITTED_IDS = new Set([
    'att-40', 'att-top', 'str-top', 'def-top', 'hp-top', 'prayer', 'mine', 'runecraft',
    'agility', 'agility-52', 'agility-gt', 'agility-tt', 'fish', 'fish-35', 'fish-53', 'fish-74',
    'herb', 'herb-drops', 'herb-unf', 'smith', 'smith-anvil', 'smith-trade',
    'crest', 'magic-43', 'smith-40', 'superheat', 'magic-top', 'magic-45', 'magic-anvil',
    'mage-arena', 'charge', 'superheat-75', 'superheat-99', 'superheat-stun',
    'ranged-entry', 'ranged-entry-melee', 'equip', 'bank-value', 'runite', 'wc-pray',
]);

// Max rev 289 quest gates across all 68 quests (quest-reqs.json + haggis-boards boss gates).
const QP_SPECIALIST_MAX_GATES: Partial<Record<Skill, number>> = {
    attack: 20, strength: 50, prayer: 43, magic: 59, cooking: 53, woodcutting: 50,
    fletching: 25, fishing: 53, firemaking: 30, crafting: 50, smithing: 50, mining: 52,
    herblore: 45, agility: 56, thieving: 50, ranged: 40,
};

/** Adapts the Haggis activity table for a dedicated 145-QP specialist that trains only to quest gates. */
export function qpSpecialistActivities(activities: Activity[]): Activity[] {
    const out: Activity[] = [];
    for (const raw of activities) {
        if (QP_SPECIALIST_OMITTED_IDS.has(raw.id)) continue;
        const a: Activity = { ...raw, ...(raw.patches ? { patches: raw.patches.map(p => ({ ...p })) } : {}) };
        if (a.id === 'login-wine') {
            a.xp = { cooking: xpForLevel(53) };
            a.serves = ['questpoints'];
        } else if (a.id === 'fletch') {
            delete a.ticks;
            delete a.xp;
            a.serves = ['questpoints'];
            a.train = { skill: 'fletching', toLevel: 25, xpPerTick: { floor: 500, realistic: 500, evidence: 'CODE-READ', source: 'fletch-10 arrow pack rate' } };
        } else if (a.id === 'fm-burn') {
            delete a.ticks;
            delete a.xp;
            delete a.patches;
            a.serves = ['questpoints'];
            a.at = 'lumbridge-spawn';
            a.train = { skill: 'firemaking', toLevel: 30, xpPerTick: { floor: 230, realistic: 184, evidence: 'CODE-READ', source: '1->30 normal/oak logs at 4-5t per log' } };
        } else if (a.id === 'craft') {
            delete a.ticks;
            delete a.xp;
            a.serves = ['questpoints'];
            a.train = { skill: 'crafting', toLevel: 50, xpPerTick: { floor: 700, realistic: 550, evidence: 'MEASURED', source: 'conservative 1->50 gem cutting from floor-crafting.ts' } };
        } else if (a.id === 'woodcut') {
            delete a.ticks;
            delete a.xp;
            delete a.patches;
            a.serves = ['questpoints'];
            a.train = { skill: 'woodcutting', toLevel: 50, xpPerTick: { floor: 200, realistic: 170, evidence: 'MEASURED', source: '1->85 3-tick oak rate from floor-woodcut.ts' } };
        } else if (a.id === 'thieve') {
            delete a.ticks;
            delete a.xp;
            delete a.patches;
            delete a.deadTicks;
            delete a.trickSpeedup;
            a.serves = ['questpoints'];
            a.requires = ['trade-start'];
            a.at = 'ardougne-market';
            a.train = { skill: 'thieving', toLevel: 50, xpPerTick: { floor: 160, realistic: 130, evidence: 'MEASURED', source: '1->50 Ardougne stun-relog tiers from thieving-specialist.ts' } };
        } else if (a.id === 'thieving-25') {
            a.requires = [...new Set([...(a.requires ?? []), 'thieve'])];
        } else if (a.id === 'ranged') {
            delete a.patches;
            a.serves = ['questpoints'];
            a.requires = ['tutorial'];
            a.at = 'lumbridge-spawn';
            a.train = { skill: 'ranged', toLevel: 40, xpPerTick: { floor: 274.2, realistic: 206.0, evidence: 'MEASURED', source: 'research/combat-measure.md band-40 ranged rate' } };
        } else if (a.id === 'magic' || a.id === 'magic-teleport') {
            delete a.ticks;
            delete a.xp;
            delete a.patches;
            delete a.inside;
            a.serves = ['questpoints'];
            a.train = {
                skill: 'magic',
                toLevel: 75,
                xpPerTick: a.id === 'magic'
                    ? { floor: 567, realistic: 525, evidence: 'MEASURED', source: 'floor-magic.ts enchant rate' }
                    : { floor: 290, realistic: 260, evidence: 'MEASURED', source: 'floor-teleport.ts 1->75 rate' },
            };
        } else if (a.id === 'quests-medium') {
            a.xp = { ...(a.xp ?? {}), smithing: 318125 };
        } else if (a.id === 'quests-rest') {
            a.minLevel = { ...QP_SPECIALIST_MAX_GATES, ...(a.minLevel ?? {}) };
            a.requires = [...new Set([...(a.requires ?? []), 'barcrawl', 'smith-20', 'tourist-trap-agility', 'rival-seaslug', 'quests-medium'])];
        }
        out.push(a);
    }
    return out;
}
