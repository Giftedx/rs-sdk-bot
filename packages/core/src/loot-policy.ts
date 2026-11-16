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
type Item = { id: number; name?: string; count: number };

// Ground and held quantities do not tell us whether an item stacks.
export function lootCapacity(s: { inventory: readonly { id: number; count: number }[] }, item: Pick<Item, 'id' | 'count'>, definition?: { stackable: boolean; cost?: number }): boolean {
    if (typeof definition?.stackable !== 'boolean' || s.inventory.length > 28 || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > MAX_STACK) return false;
    if (s.inventory.some(i => !Number.isSafeInteger(i.count) || i.count < 1 || i.count > MAX_STACK)) return false;
    const free = 28 - s.inventory.length;
    const held = s.inventory.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0);
    return definition.stackable ? (held > 0 || free >= 1) && held + item.count <= MAX_STACK : free >= item.count;
}

export function lootNameMatches(name: string, pattern: string): boolean {
    const escaped = pattern.split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^${escaped}$`, 'i').test(name);
}
export function lootIgnored(item: Pick<Item, 'id' | 'name'>, p: LootFilter): boolean {
    const name = item.name ?? '';
    return !!p.ignoredIds?.includes(item.id) || !!p.ignoredNames?.some(n => n.toLowerCase() === name.toLowerCase()) || !!p.ignoredNameGlobs?.some(n => lootNameMatches(name, n));
}
export function lootListed(item: Pick<Item, 'id' | 'name'>, p: LootFilter): boolean {
    const name = item.name ?? '';
    return !lootIgnored(item, p) && (p.ids.includes(item.id) || p.names.some(n => n.toLowerCase() === name.toLowerCase()) || !!p.nameGlobs?.some(n => lootNameMatches(name, n)));
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
