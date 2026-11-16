import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfigs } from '../../knowledge/src/config';
import items from '../../../knowledge/items.json';
import teleports from '../../../knowledge/teleports.json';
import { potionCareRecipe } from './native-potion';

export type ItemCount = { id: number; count: number };
export type RequirementUnit = 'doses' | 'charges';
export type ItemRequirement = ItemCount | { id: number; kind: RequirementUnit; minUnits: number; maxSlots: number };
export type RequirementMetadata = { stackable: boolean; noted: boolean; unit?: { kind: RequirementUnit; family: string; units: number } };
export type RequirementShortage = { id: number; unit: RequirementUnit | 'items'; required: number; available: number; reason: 'units' | 'slots' | 'unknown' | 'noted' | 'invalid' | 'overflow' | 'allocation'; detail?: string };
export type RequirementResolution = { ok: boolean; items: ItemCount[]; slots: number; shortages: RequirementShortage[] };
const MAX_COUNT = 2147483647;
const whole = (n: number, min = 0, max = MAX_COUNT) => Number.isSafeInteger(n) && n >= min && n <= max;

type UnitRequirement = Extract<ItemRequirement, { kind: string }>;
type UnitStock = { id: number; count: number; units: number };

// Search unit counts rather than item IDs. Native potion families have four
// unit values; native charge families have at most eight. Each request keeps
// its own minimum and slot cap. A bounded search can report unknown, never a
// false shortage. Increasing total slot budgets prove the minimum slot count.
function allocateFamily(requests: readonly UnitRequirement[], candidates: readonly UnitStock[]) {
    const values = [...new Set(candidates.map(row => row.units))].sort((a, b) => b - a);
    const counts = values.map(units => Math.min(28, candidates.filter(row => row.units === units).reduce((n, row) => n + row.count, 0)));
    const ordered = [...requests].sort((a, b) => a.maxSlots - b.maxSlots || b.minUnits - a.minUnits || a.id - b.id);
    const suffixMinimum = Array(ordered.length + 1).fill(0) as number[];
    for (let i = ordered.length - 1; i >= 0; i--) suffixMinimum[i] = suffixMinimum[i + 1]! + Math.ceil(ordered[i]!.minUnits / (values[0] ?? 1));
    const maximum = Math.min(28, counts.reduce((a, b) => a + b, 0), ordered.reduce((n, r) => n + r.maxSlots, 0));
    let steps = 0, limited = false;
    const visit = () => { if (++steps > 100000) { limited = true; return false; } return true; };
    const upper = (available: readonly number[], start: number, slots: number) => {
        let units = 0;
        for (let i = start; i < values.length && slots > 0; i++) { const n = Math.min(available[i]!, slots); units += n * values[i]!; slots -= n; }
        return slots === 0 ? units : -1;
    };
    for (let budget = suffixMinimum[0]!; budget <= maximum && !limited; budget++) {
        const failed = new Set<string>();
        const search = (index: number, available: number[], slots: number): number[] | null => {
            if (!visit()) return null;
            if (index === ordered.length) return Array(values.length).fill(0) as number[];
            if (slots < suffixMinimum[index]!) return null;
            const key = index + '/' + slots + '/' + available.join(',');
            if (failed.has(key)) return null;
            const request = ordered[index]!, cap = Math.min(request.maxSlots, slots - suffixMinimum[index + 1]!, available.reduce((a, b) => a + b, 0));
            for (let bottles = Math.ceil(request.minUnits / (values[0] ?? 1)); bottles <= cap && !limited; bottles++) {
                if (upper(available, 0, bottles) < request.minUnits) continue;
                const allocation = Array(values.length).fill(0) as number[];
                const choose = (at: number, left: number, units: number): number[] | null => {
                    if (!visit()) return null;
                    if (left === 0) {
                        if (units < request.minUnits) return null;
                        for (let i = at; i < allocation.length; i++) allocation[i] = 0;
                        const rest = search(index + 1, available.map((n, i) => n - allocation[i]!), slots - bottles);
                        return rest?.map((n, i) => n + allocation[i]!) ?? null;
                    }
                    if (at === values.length || upper(available, at, left) < request.minUnits - units) return null;
                    for (let n = Math.min(left, available[at]!); n >= 0 && !limited; n--) {
                        allocation[at] = n;
                        const found = choose(at + 1, left - n, units + n * values[at]!);
                        if (found) return found;
                    }
                    allocation[at] = 0; return null;
                };
                const found = choose(0, bottles, 0);
                if (found) return found;
            }
            failed.add(key); return null;
        };
        const found = search(0, counts, budget);
        if (found) return { counts: found, values, limited: false };
    }
    return { counts: null, values, limited };
}

// Exact requirements reserve their IDs before joint family allocation.
export function resolveItemRequirements(requirements: readonly ItemRequirement[], stock: readonly ItemCount[],
    metadata: (id: number) => RequirementMetadata | undefined, maxSlots = 28): RequirementResolution {
    const shortages: RequirementShortage[] = [], remaining = new Map<number, number>(), chosen = new Map<number, number>();
    const short = (r: ItemRequirement, reason: RequirementShortage['reason'], available = 0, detail?: string) => shortages.push({ id: r.id,
        unit: 'kind' in r ? r.kind : 'items', required: 'kind' in r ? r.minUnits : r.count, available, reason, ...(detail ? { detail } : {}) });
    const invalid = { id: -1, count: 0 };
    if (!Array.isArray(requirements) || requirements.length > 28 || !Array.isArray(stock) || !whole(maxSlots, 0, 28)) {
        short(invalid, 'invalid'); return { ok: false, items: [], slots: 0, shortages };
    }
    for (const row of stock) {
        if (!row || typeof row !== 'object') { short(invalid, 'invalid'); continue; }
        if (!whole(row.id) || !whole(row.count)) { short(row, 'invalid'); continue; }
        const count = (remaining.get(row.id) ?? 0) + row.count;
        if (!whole(count)) { short(row, 'overflow'); continue; }
        remaining.set(row.id, count);
    }
    const take = (id: number, count: number) => {
        remaining.set(id, (remaining.get(id) ?? 0) - count);
        chosen.set(id, (chosen.get(id) ?? 0) + count);
    };
    const definitions = new Map<number, RequirementMetadata | undefined>();
    const definition = (id: number) => {
        if (!definitions.has(id)) {
            let value: RequirementMetadata | undefined;
            try { value = metadata(id); } catch {}
            definitions.set(id, value && typeof value.stackable === 'boolean' && typeof value.noted === 'boolean'
                ? { ...value, ...(value.unit ? { unit: { ...value.unit } } : {}) } : undefined);
        }
        return definitions.get(id);
    };
    const valid = requirements.filter(r => { if (!r || typeof r !== 'object') { short(invalid, 'invalid'); return false; } return true; });
    const ordered = [...valid].sort((a, b) => Number('kind' in a) - Number('kind' in b));
    const families = new Map<string, { requests: UnitRequirement[]; kind: RequirementUnit; family: string }>();
    for (const r of ordered) {
        if (!whole(r.id) || ('kind' in r ? !['doses', 'charges'].includes(r.kind) || !whole(r.minUnits, 1) || !whole(r.maxSlots, 1, 28) : !whole(r.count, 1))) { short(r, 'invalid'); continue; }
        const native = definition(r.id);
        if (!native || typeof native.stackable !== 'boolean' || typeof native.noted !== 'boolean') { short(r, 'unknown'); continue; }
        if (native.noted) { short(r, 'noted'); continue; }
        if (!('kind' in r)) {
            const have = remaining.get(r.id) ?? 0;
            if (have < r.count) short(r, 'units', have);
            else take(r.id, r.count);
            continue;
        }
        const unit = native.unit;
        if (!unit || unit.kind !== r.kind || !unit.family || !whole(unit.units, 1)) { short(r, 'unknown'); continue; }
        const key = r.kind + ':' + unit.family;
        let group = families.get(key);
        if (!group) { group = { requests: [], kind: r.kind, family: unit.family }; families.set(key, group); }
        group.requests.push(r);
    }
    for (const group of families.values()) {
        const candidates = [...remaining].flatMap(([id, count]) => {
            if (!count) return [];
            const m = definition(id), u = m?.unit;
            return m && !m.noted && !m.stackable && u?.kind === group.kind && u.family === group.family && whole(u.units, 1)
                ? [{ id, count, units: u.units }] : [];
        }).sort((a, b) => b.units - a.units || a.id - b.id);
        let impossible = false;
        for (const r of group.requests) {
            let units = 0, slots = r.maxSlots;
            for (const row of candidates) { const n = Math.min(row.count, slots); units += n * row.units; slots -= n; }
            if (units < r.minUnits) { short(r, 'units', units); impossible = true; }
        }
        if (impossible) continue;
        const allocation = allocateFamily(group.requests, candidates);
        if (!allocation.counts) {
            for (const r of group.requests) short(r, allocation.limited ? 'unknown' : 'allocation', 0, allocation.limited ? 'native family allocation search limit' : 'no joint allocation within each request slot limit');
            continue;
        }
        for (let i = 0; i < allocation.values.length; i++) {
            let left = allocation.counts[i]!;
            for (const row of candidates.filter(row => row.units === allocation.values[i])) { const n = Math.min(left, row.count); if (n) take(row.id, n); left -= n; }
        }
    }
    const selected = [...chosen].map(([id, count]) => ({ id, count })).sort((a, b) => a.id - b.id);
    const slots = selected.reduce((n, row) => n + (definition(row.id)!.stackable ? 1 : row.count), 0);
    if (!whole(slots) || slots > maxSlots) short({ id: -1, count: slots }, 'slots', maxSlots);
    return { ok: shortages.length === 0, items: selected, slots, shortages };
}

const content = resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content');
const byId = new Map(items.map(item => [item.id, item])), byName = new Map(items.map(item => [item.debugname, item]));
let pack: Map<number, string> | undefined;
const blocks = new Map<string, ReturnType<typeof parseConfigs>>(), nativeCache = new Map<number, RequirementMetadata | undefined>();
const chargeUnits = new Map<number, NonNullable<RequirementMetadata['unit']>>();
for (const teleport of teleports.teleports) {
    for (const row of teleport.charges) {
        if (row.id !== null && whole(row.charges, 1)) chargeUnits.set(row.id, { kind: 'charges', family: teleport.id, units: row.charges });
    }
}

// The adapter reads pinned native identity. The resolver itself reads only its
// arguments, so another planner can use it without a session.
export function nativeRequirementMetadata(id: number): RequirementMetadata | undefined {
    if (nativeCache.has(id)) return nativeCache.get(id);
    if (!whole(id)) return undefined;
    pack ??= new Map(readFileSync(content + '/pack/obj.pack', 'utf8').split(/\r?\n/).flatMap(line => {
        const m = line.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : [];
    }));
    const packed = pack.get(id), noted = packed?.startsWith('cert_') ?? false;
    const item = noted ? byName.get(packed!.slice(5)) : byId.get(id);
    if (!item || packed !== (noted ? 'cert_' + item.debugname : item.debugname)) { nativeCache.set(id, undefined); return undefined; }
    const file = content + '/' + item.src.replace(/:\d+$/, '');
    if (!blocks.has(file)) blocks.set(file, parseConfigs(readFileSync(file, 'utf8'), file));
    const block = blocks.get(file)!.find(b => b.name === item.debugname);
    if (!block) { nativeCache.set(id, undefined); return undefined; }
    let unit: RequirementMetadata['unit'];
    if (!noted) {
        try { const r = potionCareRecipe(id); unit = { kind: 'doses', family: r.family!, units: r.doses }; } catch {}
        unit ??= chargeUnits.get(id);
    }
    const result: RequirementMetadata = Object.freeze({ noted, stackable: noted || block.props.stackable?.[0] === 'yes', ...(unit ? { unit: Object.freeze({ ...unit }) } : {}) });
    nativeCache.set(id, result); return result;
}
