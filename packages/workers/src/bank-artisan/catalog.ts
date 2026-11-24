// DBTable-backed artisan recipe catalogs plus stateless RS curves, routes, and batch math.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { objId } from '../../../core/src/content-facts';

export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
export const CONTENT_DIR = join(REPO_ROOT, 'vendor', 'rs-sdk', 'server', 'content');
export const KNOWLEDGE_DIR = join(REPO_ROOT, 'knowledge');

export interface DbTableRow {
    readonly name: string;
    readonly data: Readonly<Record<string, readonly (readonly string[])[]>>;
    readonly def?: string;
}

export interface DbTable {
    readonly table: string;
    readonly rows: readonly DbTableRow[];
}

interface KnowledgeItem {
    readonly id: number;
    readonly name: string;
    readonly debugname: string;
    readonly members?: boolean;
    readonly cost?: number;
    readonly stackable?: boolean;
}

let cachedDbTables: ReadonlyMap<string, DbTable> | undefined;
let cachedItems: readonly KnowledgeItem[] | undefined;
let cachedItemsById: ReadonlyMap<number, KnowledgeItem> | undefined;
let cachedItemsByDebug: ReadonlyMap<string, KnowledgeItem> | undefined;
let cachedObjPack: ReadonlyMap<string, number> | undefined;
let cachedLocPack: ReadonlyMap<string, number> | undefined;
let cachedGearList: readonly { id: number; name: string; debugname: string; requires?: { skills?: Record<string, number>; members?: boolean } }[] | undefined;

export function loadDbTables(): ReadonlyMap<string, DbTable> {
    if (cachedDbTables) return cachedDbTables;
    const raw = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, 'dbtables.json'), 'utf8')) as DbTable[];
    cachedDbTables = new Map(raw.map(t => [t.table, t]));
    return cachedDbTables;
}

export function dbTableRows(tableName: string): readonly DbTableRow[] {
    return loadDbTables().get(tableName)?.rows ?? [];
}

export function dbCell(row: DbTableRow | undefined, col: string): readonly string[] | undefined {
    return row?.data[col]?.[0];
}

export function loadKnowledgeItems(): readonly KnowledgeItem[] {
    if (cachedItems) return cachedItems;
    cachedItems = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, 'items.json'), 'utf8')) as KnowledgeItem[];
    return cachedItems;
}

export function itemById(id: number): KnowledgeItem | undefined {
    if (!cachedItemsById) cachedItemsById = new Map(loadKnowledgeItems().map(i => [i.id, i]));
    return cachedItemsById.get(id);
}

export function itemByDebugName(debugname: string): KnowledgeItem | undefined {
    if (!cachedItemsByDebug) cachedItemsByDebug = new Map(loadKnowledgeItems().map(i => [i.debugname, i]));
    return cachedItemsByDebug.get(debugname);
}

export function isItemStackable(id: number): boolean {
    return itemById(id)?.stackable === true;
}

let cachedObjIdSet: ReadonlySet<number> | undefined;

export function parsePackNameToId(text: string): Map<string, number> {
    const map = new Map<string, number>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq < lineEnd) {
            const id = Number(text.slice(pos, eq));
            if (Number.isInteger(id) && id >= 0) map.set(text.slice(eq + 1, lineEnd), id);
        }
        pos = end + 1;
    }
    return map;
}

export function objPackIdSet(): ReadonlySet<number> {
    if (cachedObjIdSet) return cachedObjIdSet;
    const text = readFileSync(join(CONTENT_DIR, 'pack/obj.pack'), 'utf8');
    const ids = new Set<number>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq < lineEnd) {
            const id = Number(text.slice(pos, eq));
            if (Number.isInteger(id) && id >= 0) ids.add(id);
        }
        pos = end + 1;
    }
    cachedObjIdSet = ids;
    return ids;
}

export function packMap(kind: 'obj' | 'loc'): ReadonlyMap<string, number> {
    const existing = kind === 'obj' ? cachedObjPack : cachedLocPack;
    if (existing) return existing;
    const map = parsePackNameToId(readFileSync(join(CONTENT_DIR, `pack/${kind}.pack`), 'utf8'));
    if (kind === 'obj') cachedObjPack = map;
    else cachedLocPack = map;
    return map;
}

export function resolveObjId(name: string): number {
    const fromPack = packMap('obj').get(name);
    if (fromPack !== undefined) return fromPack;
    return objId(name);
}

export interface DbCookingEntry {
    readonly rowName: string;
    readonly cooked: string;
    readonly uncooked: string;
    readonly burnt?: string;
    readonly additional?: string;
    readonly level: number;
    readonly xp: number;
    readonly noBurn: boolean;
}

export interface DbFletchArrowEntry {
    readonly rowName: string;
    readonly tipDebugName: string;
    readonly metal: string;
    readonly productDebugName: string;
    readonly count: number;
    readonly level: number;
    readonly xp: number;
}

export interface DbFletchBowEntry {
    readonly rowName: string;
    readonly logDebugName: string;
    readonly shafts: number;
    readonly shortbow?: { debugname: string; level: number; xp: number };
    readonly longbow?: { debugname: string; level: number; xp: number };
}

export interface DbGemEntry {
    readonly rowName: string;
    readonly uncutDebugName: string;
    readonly cutDebugName: string;
    readonly level: number;
    readonly xp: number;
}

export interface DbLeatherEntry {
    readonly rowName: string;
    readonly productDebugName: string;
    readonly leatherDebugName: string;
    readonly leatherCount: number;
    readonly level: number;
    readonly xp: number;
    readonly members: boolean;
}

export interface DbSmithingEntry {
    readonly rowName: string;
    readonly productDebugName: string;
    readonly count: number;
    readonly level: number;
    readonly barDebugName: string;
    readonly barCount: number;
}

export interface DbSpellEntry {
    readonly rowName: string;
    readonly name: string;
    readonly component: string;
    readonly level: number;
    readonly members: boolean;
    readonly runes: readonly { item: string; count: number }[];
    readonly worn?: string;
}

export interface ArtisanDbtablesCatalog {
    readonly cooking: readonly DbCookingEntry[];
    readonly fletchArrows: readonly DbFletchArrowEntry[];
    readonly fletchBows: readonly DbFletchBowEntry[];
    readonly gems: readonly DbGemEntry[];
    readonly leather: readonly DbLeatherEntry[];
    readonly smithing: readonly DbSmithingEntry[];
    readonly spells: readonly DbSpellEntry[];
}

let cachedCatalog: ArtisanDbtablesCatalog | undefined;

export function artisanDbtablesCatalog(): ArtisanDbtablesCatalog {
    if (cachedCatalog) return cachedCatalog;

    const cooking: DbCookingEntry[] = dbTableRows('cooking_generic').flatMap(row => {
        const cooked = dbCell(row, 'cooked')?.[0];
        const uncooked = dbCell(row, 'uncooked')?.[0];
        if (!cooked || !uncooked || cooked === 'null') return [];
        const burnt = dbCell(row, 'burnt')?.[0];
        const additional = dbCell(row, 'additional')?.[0];
        const chance = dbCell(row, 'successchance');
        return [{
            rowName: row.name,
            cooked,
            uncooked,
            burnt: burnt && burnt !== 'null' ? burnt : undefined,
            additional: additional && additional !== 'null' ? additional : undefined,
            level: Number(dbCell(row, 'levelrequired')?.[0] ?? 1),
            xp: Number(dbCell(row, 'experience')?.[0] ?? 0),
            noBurn: chance?.[0] === '1' && chance?.[1] === '1',
        }];
    });

    const fletchArrows: DbFletchArrowEntry[] = dbTableRows('fletching_table').flatMap(row => {
        const tipDebugName = dbCell(row, 'item')?.[0];
        const prod = dbCell(row, 'product');
        if (!tipDebugName || !prod?.[0]) return [];
        return [{
            rowName: row.name,
            tipDebugName,
            metal: dbCell(row, 'metal')?.[0] ?? '',
            productDebugName: prod[0],
            count: Number(prod[1] ?? 15),
            level: Number(dbCell(row, 'level')?.[0] ?? 1),
            xp: Number(dbCell(row, 'experience')?.[0] ?? 0) / 10,
        }];
    });

    const fletchBows: DbFletchBowEntry[] = dbTableRows('fletch_bow_table').flatMap(row => {
        const logDebugName = dbCell(row, 'log')?.[0];
        if (!logDebugName) return [];
        const sb = dbCell(row, 'shortbow');
        const lb = dbCell(row, 'longbow');
        return [{
            rowName: row.name,
            logDebugName,
            shafts: Number(dbCell(row, 'shafts')?.[0] ?? 0),
            shortbow: sb?.[0] ? { debugname: sb[0], level: Number(sb[1] ?? 1), xp: Number(sb[2] ?? 0) / 10 } : undefined,
            longbow: lb?.[0] ? { debugname: lb[0], level: Number(lb[1] ?? 1), xp: Number(lb[2] ?? 0) / 10 } : undefined,
        }];
    });

    const gems: DbGemEntry[] = dbTableRows('gem_cutting_table').flatMap(row => {
        const uncut = dbCell(row, 'uncut_gem')?.[0];
        const cut = dbCell(row, 'cut_gem')?.[0];
        if (!uncut || !cut) return [];
        return [{
            rowName: row.name,
            uncutDebugName: uncut,
            cutDebugName: cut,
            level: Number(dbCell(row, 'level')?.[0] ?? 1),
            xp: Number(dbCell(row, 'experience')?.[0] ?? 0) / 10,
        }];
    });

    const leather: DbLeatherEntry[] = dbTableRows('craft_leather_table').flatMap(row => {
        const productDebugName = dbCell(row, 'product')?.[0];
        const leatherCol = dbCell(row, 'leather');
        if (!productDebugName || !leatherCol?.[0]) return [];
        return [{
            rowName: row.name,
            productDebugName,
            leatherDebugName: leatherCol[0],
            leatherCount: Number(leatherCol[1] ?? 1),
            level: Number(dbCell(row, 'levelrequired')?.[0] ?? 1),
            xp: Number(dbCell(row, 'productexp')?.[0] ?? 0) / 10,
            members: dbCell(row, 'members')?.[0] === 'true',
        }];
    });

    const smithing: DbSmithingEntry[] = dbTableRows('smithing').flatMap(row => {
        const productDebugName = dbCell(row, 'product')?.[0];
        const barDebugName = dbCell(row, 'bar')?.[0];
        if (!productDebugName || !barDebugName) return [];
        return [{
            rowName: row.name,
            productDebugName,
            count: Number(dbCell(row, 'product_amount')?.[0] ?? 1),
            level: Number(dbCell(row, 'levelrequired')?.[0] ?? 1),
            barDebugName,
            barCount: Number(dbCell(row, 'bar_amount')?.[0] ?? 1),
        }];
    });

    const spells: DbSpellEntry[] = dbTableRows('magic_spell_table').flatMap(row => {
        const name = dbCell(row, 'name')?.[0];
        const component = dbCell(row, 'spellcom')?.[0];
        if (!name || !component) return [];
        const runesCell = dbCell(row, 'runesrequired') ?? [];
        const runes: { item: string; count: number }[] = [];
        for (let i = 0; i < runesCell.length; i += 2) {
            const item = runesCell[i];
            const count = Number(runesCell[i + 1] ?? 0);
            if (item && item !== 'null' && count > 0) runes.push({ item, count });
        }
        const worn = dbCell(row, 'wornrequired')?.[0];
        return [{
            rowName: row.name,
            name,
            component,
            level: Number(dbCell(row, 'levelrequired')?.[0] ?? 1),
            members: dbCell(row, 'members')?.[0] === 'true',
            runes,
            worn: worn && worn !== 'null' ? worn : undefined,
        }];
    });

    cachedCatalog = { cooking, fletchArrows, fletchBows, gems, leather, smithing, spells };
    return cachedCatalog;
}

// Player.ts levelExperience formula (`2^(l/10)` tenths).
export function xpForLevel(level: number): number {
    let points = 0;
    for (let l = 1; l < level; l++) points += Math.floor(l + 300 * 2 ** (l / 10));
    return Math.floor(points / 4);
}

export function levelForXp(xp: number): number {
    let level = 1;
    while (level < 99 && xp >= xpForLevel(level + 1)) level++;
    return level;
}

export type BatchIngredient = {
    id: number;
    available: number;
    reserved: number;
    units: number;
    stackable: boolean;
};

export function productionBatch(
    ingredients: BatchIngredient[],
    freeSlots: number,
    requested: number,
    mode: 'exact' | 'best-effort',
) {
    const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
    if (!integer(freeSlots) || !integer(requested) || !['exact', 'best-effort'].includes(mode) || !ingredients.length) {
        throw Error('invalid production batch');
    }
    const seen = new Set<number>();
    let possible = requested;
    let perActionSlots = 0;
    let stackSlots = 0;
    for (const i of ingredients) {
        if (![i.id, i.available, i.reserved, i.units].every(integer) || i.units < 1 || typeof i.stackable !== 'boolean' || seen.has(i.id)) {
            throw Error('invalid or duplicate recipe ingredient');
        }
        seen.add(i.id);
        possible = Math.min(possible, Math.floor(Math.max(0, i.available - i.reserved) / i.units));
        if (i.stackable) stackSlots++;
        else perActionSlots += i.units;
        if (!integer(perActionSlots)) throw Error('recipe slots exceed safe integer range');
    }
    const inputSlots = freeSlots - stackSlots;
    possible = inputSlots < 0 ? 0 : perActionSlots ? Math.min(possible, Math.floor(inputSlots / perActionSlots)) : possible;
    const targetMet = possible === requested;
    return { possible, planned: mode === 'exact' && !targetMet ? 0 : possible, targetMet };
}

const TOLL_CORRIDOR = [
    [3290, 3404], [3308, 3404], [3308, 3370], [3308, 3330], [3265, 3330], [3255, 3330],
    [3262, 3250], [3262, 3232], [3266, 3227],
].map(([x, z]) => ({ x: x!, z: z! }));

export const SPIDER_REACH = { minX: 3233, maxX: 3255, minZ: 3222, maxZ: 3246, huntRange: 1 };
const nearCorridorBank = (p: { worldX: number; worldZ: number; level: number }, x: number, z: number) =>
    p.level === 0 && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= 5;

export function smeltEntryRoute(p: { worldX: number; worldZ: number; level: number }) {
    if (nearCorridorBank(p, 3269, 3167)) return { name: 'al-kharid-bank', fare: 0, points: [] as { x: number; z: number }[] };
    if (!nearCorridorBank(p, 3253, 3420)) throw Error('smelt entry requires Varrock East or Al Kharid bank');
    return { name: 'varrock-east-toll', fare: 10, points: TOLL_CORRIDOR.map(t => ({ ...t })) };
}

export const SMITH_BANK = { x: 3185, z: 3436 };
export const SMITH_ANVIL = { x: 3189, z: 3422 };

export function smithStageRoute(p: { worldX: number; worldZ: number; level: number }) {
    const tiles = (a: number[][]) => a.map(([x, z]) => ({ x: x!, z: z! }));
    if (nearCorridorBank(p, SMITH_BANK.x, SMITH_BANK.z)) {
        return { name: 'varrock-west-bank', fare: 0, toll: [] as { x: number; z: number }[], points: [] as { x: number; z: number }[] };
    }
    if (nearCorridorBank(p, 3253, 3420)) {
        return { name: 'varrock-east-walk', fare: 0, toll: [] as { x: number; z: number }[], points: tiles([[3254, 3428], [SMITH_BANK.x, SMITH_BANK.z]]) };
    }
    if (!nearCorridorBank(p, 3269, 3167)) throw Error('smith staging requires Al Kharid, Varrock East or Varrock West bank');
    return {
        name: 'al-kharid-toll',
        fare: 10,
        toll: tiles([[3273, 3194], [3275, 3212], [3272, 3227]]),
        points: [...TOLL_CORRIDOR.slice(0, -1).reverse().map(t => ({ ...t })), ...tiles([[3254, 3428], [SMITH_BANK.x, SMITH_BANK.z]])],
    };
}

export const HIGH_LEVEL = 55;
export const CAST_XP = { 'low-alch': 775, 'high-alch': 1625 } as const;
export const FIRE_PER = { 'low-alch': 3, 'high-alch': 5 } as const;
export const STRIKE_LEVEL = 21;

export function alchCasts(xp: number, target: number): { low: number; high: number } {
    const goal = xpForLevel(target);
    const gate = xpForLevel(HIGH_LEVEL);
    if (target <= STRIKE_LEVEL) return { low: 0, high: 0 };
    const low = xp < gate ? Math.ceil((Math.min(goal, gate) - xp) / CAST_XP['low-alch']) : 0;
    const high = target > HIGH_LEVEL ? Math.ceil((goal - Math.max(xp, Math.min(goal, gate))) / CAST_XP['high-alch']) : 0;
    return { low: Math.max(0, low), high: Math.max(0, high) };
}

const ELEMENTAL_STAVES: readonly { id: number; runeId: number; magic: number; attack: number; members: boolean; score: number }[] = [
    { id: 1381, runeId: 556, magic: 1, attack: 1, members: false, score: 1 }, // Staff of air
    { id: 1383, runeId: 555, magic: 1, attack: 1, members: false, score: 1 }, // Staff of water
    { id: 1385, runeId: 557, magic: 1, attack: 1, members: false, score: 1 }, // Staff of earth
    { id: 1387, runeId: 554, magic: 1, attack: 1, members: false, score: 1 }, // Staff of fire
    { id: 1397, runeId: 556, magic: 30, attack: 30, members: true, score: 2 }, // Air battlestaff
    { id: 1395, runeId: 555, magic: 30, attack: 30, members: true, score: 2 }, // Water battlestaff
    { id: 1399, runeId: 557, magic: 30, attack: 30, members: true, score: 2 }, // Earth battlestaff
    { id: 1393, runeId: 554, magic: 30, attack: 30, members: true, score: 2 }, // Fire battlestaff
    { id: 1405, runeId: 556, magic: 40, attack: 40, members: true, score: 3 }, // Mystic air staff
    { id: 1403, runeId: 555, magic: 40, attack: 40, members: true, score: 3 }, // Mystic water staff
    { id: 1407, runeId: 557, magic: 40, attack: 40, members: true, score: 3 }, // Mystic earth staff
    { id: 1401, runeId: 554, magic: 40, attack: 40, members: true, score: 3 }, // Mystic fire staff
    { id: 3053, runeId: 557, magic: 30, attack: 30, members: true, score: 4 }, // Lava battlestaff (earth + fire)
    { id: 3054, runeId: 557, magic: 40, attack: 40, members: true, score: 5 }, // Mystic lava staff
];

export function bestElementalStaffForRunes(
    stock: readonly { id: number; count: number }[],
    levels: Readonly<Record<string, number>> = {},
    options: { runeIds?: readonly number[]; members?: boolean } = {},
): { current: { item: { id: number } } | null } {
    const owned = new Set(stock.filter(s => s.count > 0).map(s => s.id));
    const runeSet = new Set(options.runeIds ?? []);
    const magic = levels.Magic ?? levels.magic ?? 1;
    const attack = levels.Attack ?? levels.attack ?? 1;
    const members = options.members ?? false;
    const extraFire = (id: number) => id === 3053 || id === 3054;
    const matches = ELEMENTAL_STAVES
        .filter(st => (members || !st.members) && magic >= st.magic && attack >= st.attack && owned.has(st.id))
        .filter(st => !runeSet.size || runeSet.has(st.runeId) || (extraFire(st.id) && runeSet.has(554)))
        .sort((a, b) => b.score - a.score || a.id - b.id);
    const best = matches[0];
    return { current: best ? { item: { id: best.id } } : null };
}

export function readSkillLevels(
    source?: { getSkill?: (name: string) => { level: number; baseLevel?: number } | null | undefined },
): Record<string, number> {
    const names = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic'];
    const out: Record<string, number> = {};
    for (const name of names) {
        const sk = source?.getSkill?.(name);
        const val = sk?.baseLevel ?? sk?.level;
        out[name] = typeof val === 'number' && Number.isSafeInteger(val) && val >= 1 ? val : name === 'Hitpoints' ? 10 : 1;
    }
    return out;
}

export function gearFileExists(): boolean {
    return existsSync(join(KNOWLEDGE_DIR, 'gear.json'));
}

export function loadGearCatalog() {
    if (!cachedGearList) {
        cachedGearList = JSON.parse(readFileSync(join(KNOWLEDGE_DIR, 'gear.json'), 'utf8'));
    }
    return cachedGearList!;
}
