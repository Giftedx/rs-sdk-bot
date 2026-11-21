// Writes client-assets/pk-kits.json for the Equipment tab's Inventory Setups (RuneLite's Inventory Setups plugin):
// each PvP kit of packages/planner/src/pk-kits.ts as {name, worn: {slot id: [name, count, item id]}, carried: [[name, count, item id]], unreachable?}.
// A missing item id stays null. Names and IDs come from knowledge/items.json; worn keys are equipment slots.
// Run: bun packages/dashboard/gen-kits.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SLOT_IDS: Record<string, number> = { hat: 0, cape: 1, amulet: 2, weapon: 3, torso: 4, shield: 5, legs: 7, hands: 9, feet: 10, ring: 12, ammo: 13 };
export type KitItem = [name: string, count: number, id: number | null];
export type KitOut = { name: string; worn: Record<number, KitItem>; carried: KitItem[]; unreachable?: string };

export function kitList(kits: Record<string, any>, names: Map<string, string>, ids: Map<string, number>): KitOut[] {
    const name = (debug: string) => names.get(debug) ?? debug.replace(/_/g, ' ');
    const count = (v: string | [string, number]): KitItem => {
        const debug = Array.isArray(v) ? v[0] : v, id = ids.get(debug);
        return [name(debug), Array.isArray(v) ? v[1] : 1, Number.isSafeInteger(id) && id! >= 0 ? id! : null];
    };
    return Object.entries(kits).map(([kit, spec]) => {
        const worn: Record<number, KitItem> = {};
        for (const [slot, item] of Object.entries(spec.worn ?? {})) if (slot in SLOT_IDS && item) worn[SLOT_IDS[slot]!] = count(item as any);
        // A thrown weapon is a stack in the weapon slot: worn.weaponCount (packages/planner/src/pk-kits.ts kitItems).
        if (worn[3] && spec.worn?.weaponCount > 0) worn[3][1] = spec.worn.weaponCount;
        const carried = new Map<string, KitItem>();
        const add = (v: string | [string, number]) => {
            const item = count(v), key = item[2] === null ? 'debug:' + (Array.isArray(v) ? v[0] : v) : 'id:' + item[2];
            const have = carried.get(key); if (have) have[1] += item[1]; else carried.set(key, item);
        };
        for (const c of spec.carried ?? []) add(c);
        if (spec.food > 0) add([spec.foodItem ?? 'shark', spec.food]);
        return { name: kit, worn, carried: [...carried.values()], ...(typeof spec.unreachable === 'string' ? { unreachable: spec.unreachable } : {}) };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const { KITS } = await import('../planner/src/pk-kits');
    const items: { id: number; debugname?: string; name?: string }[] = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8'));
    const list = kitList(KITS as any, new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!])), new Map(items.filter(i => i.debugname).map(i => [i.debugname!, i.id])));
    writeFileSync(join(import.meta.dir, 'client-assets', 'pk-kits.json'), JSON.stringify(list));
    console.log(`pk-kits.json: ${list.length} kits`);
}
