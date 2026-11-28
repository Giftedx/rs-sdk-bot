export interface LootFilter {
    mode: 'list' | 'value' | 'mixed';
    ids: readonly number[];
    names: readonly string[];
    nameGlobs?: readonly string[];
    ignoredIds?: readonly number[];
    ignoredNames?: readonly string[];
    ignoredNameGlobs?: readonly string[];
    minimumValue: number;
    maximumValue: number;
}
export interface LootPolicy extends LootFilter {
    radius: number;
    maximumUnits: number;
    cap: number;
    idleTicks: number;
}
export interface LootDefinition { cost: number; stackable: boolean }
export type LootStackDefinition = (id: number) => { stackable: boolean } | undefined;
const MAX_STACK = 2147483647;
const GLOB_CACHE_CAP = 256;
const globCache = new Map<string, RegExp>();
type Item = { id: number; name?: string; count: number };

// Ground and held quantities do not tell us whether an item stacks.
export function lootCapacity(s: { inventory: readonly { id: number; count: number }[] }, item: Pick<Item, 'id' | 'count'>, definition?: { stackable: boolean; cost?: number }): boolean {
    const inv = s.inventory;
    if (typeof definition?.stackable !== 'boolean' || inv.length > 28 || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > MAX_STACK) return false;
    let held = 0;
    for (let i = 0; i < inv.length; i++) {
        const row = inv[i]!;
        if (!Number.isSafeInteger(row.count) || row.count < 1 || row.count > MAX_STACK) return false;
        if (row.id === item.id) held += row.count;
    }
    const free = 28 - inv.length;
    return definition.stackable ? (held > 0 || free >= 1) && held + item.count <= MAX_STACK : free >= item.count;
}

export function lootNameMatches(name: string, pattern: string): boolean {
    let re = globCache.get(pattern);
    if (!re) {
        let escaped = '';
        for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i]!;
            escaped += c === '*' ? '.*' : c === '?' ? '.' : /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
        }
        re = new RegExp(`^${escaped}$`, 'i');
        if (globCache.size >= GLOB_CACHE_CAP) globCache.clear();
        globCache.set(pattern, re);
    }
    return re.test(name);
}
export function lootIgnored(item: Pick<Item, 'id' | 'name'>, p: LootFilter): boolean {
    if (p.ignoredIds?.includes(item.id)) return true;
    const name = item.name ?? '';
    if (p.ignoredNames?.length) {
        const lower = name.toLowerCase();
        for (let i = 0; i < p.ignoredNames.length; i++) if (p.ignoredNames[i]!.toLowerCase() === lower) return true;
    }
    if (p.ignoredNameGlobs?.length) {
        for (let i = 0; i < p.ignoredNameGlobs.length; i++) if (lootNameMatches(name, p.ignoredNameGlobs[i]!)) return true;
    }
    return false;
}
export function lootListed(item: Pick<Item, 'id' | 'name'>, p: LootFilter): boolean {
    if (lootIgnored(item, p)) return false;
    if (p.ids.includes(item.id)) return true;
    const name = item.name ?? '';
    if (p.names.length) {
        const lower = name.toLowerCase();
        for (let i = 0; i < p.names.length; i++) if (p.names[i]!.toLowerCase() === lower) return true;
    }
    if (p.nameGlobs?.length) {
        for (let i = 0; i < p.nameGlobs.length; i++) if (lootNameMatches(name, p.nameGlobs[i]!)) return true;
    }
    return false;
}
export function validLootFilters(p: LootFilter): boolean {
    return ['list', 'value', 'mixed'].includes(p.mode) && Array.isArray(p.ids) && p.ids.every(id => Number.isSafeInteger(id) && id >= 0)
        && [p.names, p.nameGlobs ?? [], p.ignoredNames ?? [], p.ignoredNameGlobs ?? []].every(a => Array.isArray(a) && a.every(n => typeof n === 'string' && n.trim().length > 0))
        && (p.ignoredIds === undefined || Array.isArray(p.ignoredIds) && p.ignoredIds.every(id => Number.isSafeInteger(id) && id >= 0))
        && (p.mode !== 'list' || p.ids.length > 0 || p.names.length > 0 || (p.nameGlobs?.length ?? 0) > 0);
}
// potential enumerates native IDs that some legal pile can match for bank output declarations.
export function lootMatches(item: Item, p: LootFilter, definition: { cost: number } | undefined, options: { donor?: boolean; potential?: boolean } = {}): boolean {
    if (lootIgnored(item, p) || !definition || !Number.isSafeInteger(definition.cost) || definition.cost < 0) return false;
    if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > MAX_STACK || !Number.isSafeInteger(item.count * definition.cost)) return false;
    const cost = definition.cost;
    let valued: boolean;
    if (options.potential) {
        const minimumCount = cost === 0 ? 1 : Math.max(1, options.donor ? Math.floor(p.minimumValue / cost) + 1 : Math.ceil(p.minimumValue / cost));
        const maximumCount = cost === 0 ? MAX_STACK : Math.min(MAX_STACK, Math.floor(Number.MAX_SAFE_INTEGER / cost), options.donor ? MAX_STACK : Math.floor(p.maximumValue / cost));
        valued = options.donor ? cost < p.maximumValue && cost * minimumCount > p.minimumValue && minimumCount <= maximumCount
            : cost === 0 ? p.minimumValue === 0 && p.maximumValue >= 0 : minimumCount <= maximumCount;
    } else valued = options.donor ? cost * item.count > p.minimumValue && cost < p.maximumValue : cost * item.count >= p.minimumValue && cost * item.count <= p.maximumValue;
    const listed = lootListed(item, p);
    return p.mode === 'list' ? listed : p.mode === 'value' ? valued : listed || valued;
}

// Verified PvP weapon IDs from vendor/rs-sdk/server/content/pack/obj.pack (dragon/rune melee, magic bows, god/mystic staves).
export const PVP_WEAPON_IDS: ReadonlySet<number> = new Set([
    859,  // magic_longbow
    861,  // magic_shortbow
    1215, // dragon_dagger
    1231, // dragon_dagger_p
    1247, // rune_spear
    1249, // dragon_spear
    1261, // rune_spear_p
    1263, // dragon_spear_p
    1303, // rune_longsword
    1305, // dragon_longsword
    1319, // rune_2h_sword
    1331, // adamant_scimitar
    1333, // rune_scimitar
    1347, // rune_warhammer
    1373, // rune_battleaxe
    1377, // dragon_battleaxe
    1401, // mystic_fire_staff
    1403, // mystic_water_staff
    1405, // mystic_air_staff
    1407, // mystic_earth_staff
    1409, // ibanstaff
    1434, // dragon_mace
    2415, // saradomin_staff
    2416, // guthix_staff
    2417, // zamorak_staff
    3054, // mystic_lava_staff
    3204, // dragon_halberd
]);

const PVP_WEAPON_NAME_RE = /\b(?:dragon (?:dagger|longsword|battleaxe|mace|halberd|spear)|rune (?:scimitar|2h sword|battleaxe|warhammer|longsword|spear)|magic shortbow|mystic .* staff|iban's staff|(?:saradomin|guthix|zamorak) staff)\b/i;

export function isPvpWeapon(item: { id: number; name?: string }): boolean {
    return PVP_WEAPON_IDS.has(item.id) || (!!item.name && PVP_WEAPON_NAME_RE.test(item.name));
}

export const PVP_WEAPON_PRIORITY_BONUS = 1_000_000_000;

export interface GroundLootPile {
    id: number;
    name?: string;
    count: number;
    x: number;
    z: number;
    distance?: number;
    reachable?: boolean;
}

// Ranks ground loot piles for PvP and high-value looting: enemy PvP weapons first (highest value first), then
// highest-value drops, breaking ties by shortest distance so same-tile pickups execute immediately.
export function lootPriorityScore(
    pile: Pick<GroundLootPile, 'id' | 'name' | 'count'>,
    valueOf: (id: number, count: number) => number,
    opts: { prioritizeWeapons?: boolean } = {},
): number {
    const base = Math.max(0, valueOf(pile.id, pile.count));
    return (opts.prioritizeWeapons ?? true) && isPvpWeapon(pile) ? PVP_WEAPON_PRIORITY_BONUS + base : base;
}

export function rankGroundLoot<T extends GroundLootPile>(
    piles: readonly T[],
    valueOf: (id: number, count: number) => number,
    opts: { prioritizeWeapons?: boolean; minValue?: number; maxDistance?: number; filter?: LootFilter; definitionOf?: (id: number) => { cost: number } | undefined } = {},
): T[] {
    const scored: { pile: T; score: number; dist: number }[] = [];
    const minValue = opts.minValue ?? 0;
    const maxDistance = opts.maxDistance ?? Infinity;
    for (let i = 0; i < piles.length; i++) {
        const pile = piles[i]!;
        if (pile.reachable === false) continue;
        const dist = pile.distance ?? 0;
        if (dist > maxDistance) continue;
        if (opts.filter && !lootMatches(pile, opts.filter, opts.definitionOf?.(pile.id))) continue;
        const val = Math.max(0, valueOf(pile.id, pile.count));
        const weapon = (opts.prioritizeWeapons ?? true) && isPvpWeapon(pile);
        if (!weapon && val < minValue) continue;
        scored.push({ pile, score: weapon ? PVP_WEAPON_PRIORITY_BONUS + val : val, dist });
    }
    scored.sort((a, b) => b.score - a.score || a.dist - b.dist);
    return scored.map(s => s.pile);
}

export interface FastLootSession {
    tick(): number;
    sdk: { getState(): any };
    onTick(cb: () => void): () => void;
    direct(action: { type: string; [k: string]: unknown }): Promise<unknown>;
    ended?: Promise<{ reason: string }>;
}

// Fast multi-item loot pickup: ranks piles (PvP weapons -> highest value -> closest tile) and chains each pickup
// immediately on the tick the previous item enters inventory, with zero multi-tick sleep between consecutive items.
export function pickupLootBatch(
    s: FastLootSession,
    options: {
        valueOf: (id: number, count: number) => number;
        stackableOf: LootStackDefinition;
        minValue?: number;
        maxDistance?: number;
        maxItems?: number;
        timeoutTicks?: number;
        retryTicks?: number;
        prioritizeWeapons?: boolean;
        stop?: () => boolean;
        onPicked?: (pile: GroundLootPile, gained: number) => void;
    },
): Promise<{ picked: { id: number; count: number }[]; ticks: number }> {
    const startTick = s.tick();
    const maxItems = options.maxItems ?? 28;
    const timeoutTicks = options.timeoutTicks ?? 12;
    const retryTicks = Math.max(1, options.retryTicks ?? 2);
    const picked: { id: number; count: number }[] = [];

    const countInPack = (inv: readonly { id: number; count: number }[] | undefined, id: number): number => {
        if (!Array.isArray(inv)) return 0;
        let total = 0;
        for (let i = 0; i < inv.length; i++) if (inv[i]!.id === id) total += inv[i]!.count;
        return total;
    };

    const nextTarget = (st: any, skipped: Set<string>): GroundLootPile | null => {
        const ground: GroundLootPile[] = st?.groundItems ?? [];
        const inv: { id: number; count: number }[] = st?.inventory ?? [];
        if (!ground.length) return null;
        const ranked = rankGroundLoot(ground, options.valueOf, {
            prioritizeWeapons: options.prioritizeWeapons ?? true,
            minValue: options.minValue,
            maxDistance: options.maxDistance,
        });
        for (let i = 0; i < ranked.length; i++) {
            const p = ranked[i]!;
            const key = `${p.x}:${p.z}:${p.id}`;
            if (skipped.has(key)) continue;
            if (!lootCapacity({ inventory: inv }, p, options.stackableOf(p.id))) continue;
            return p;
        }
        return null;
    };

    return new Promise(resolve => {
        let done = false;
        let current: { pile: GroundLootPile; key: string; before: number; sentAt: number; attempts: number } | null = null;
        const skipped = new Set<string>();
        let off = () => {};
        const finish = () => {
            if (done) return;
            done = true;
            off();
            resolve({ picked, ticks: s.tick() - startTick });
        };

        const dispatch = (pile: GroundLootPile, st: any) => {
            const key = `${pile.x}:${pile.z}:${pile.id}`;
            current = { pile, key, before: countInPack(st?.inventory, pile.id), sentAt: s.tick(), attempts: 1 };
            void Promise.resolve(s.direct({ type: 'pickupItem', x: pile.x, z: pile.z, itemId: pile.id, reason: 'SDK' })).catch(() => {});
        };

        const step = () => {
            if (done) return;
            const now = s.tick();
            if (options.stop?.() || picked.length >= maxItems || now - startTick >= timeoutTicks) { finish(); return; }
            const st = s.sdk.getState();
            if (!st?.player || st.player.isDead) { finish(); return; }
            if (current) {
                const gained = countInPack(st.inventory, current.pile.id) - current.before;
                if (gained > 0) {
                    picked.push({ id: current.pile.id, count: gained });
                    options.onPicked?.(current.pile, gained);
                    current = null;
                    if (picked.length >= maxItems) { finish(); return; }
                } else {
                    const stillThere = (st.groundItems ?? []).some((g: GroundLootPile) => g.id === current!.pile.id && g.x === current!.pile.x && g.z === current!.pile.z);
                    if (!stillThere) {
                        skipped.add(current.key);
                        current = null;
                    } else if (now - current.sentAt >= retryTicks) {
                        if (current.attempts >= 3) {
                            skipped.add(current.key);
                            current = null;
                        } else {
                            current.attempts++;
                            current.sentAt = now;
                            void Promise.resolve(s.direct({ type: 'pickupItem', x: current.pile.x, z: current.pile.z, itemId: current.pile.id, reason: 'SDK' })).catch(() => {});
                            return;
                        }
                    } else {
                        return;
                    }
                }
            }
            // Immediately dispatch the next highest-priority item on the exact tick the previous item settled.
            const next = nextTarget(st, skipped);
            if (!next) { finish(); return; }
            dispatch(next, st);
        };

        off = s.onTick(step);
        void s.ended?.then(finish);
        step();
    });
}
