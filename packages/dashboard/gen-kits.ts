// Writes client-assets/pk-kits.json for the Equipment tab's Inventory Setups (RuneLite's Inventory Setups plugin):
// each PvP kit of scripts/pk-kits.ts as {name, worn: {slot id: [item, count]}, carried: [[item, count]], unreachable?},
// with item display names (knowledge/items.json). Slot ids are the equipment slots that the dashboard's doll uses.
// Run: bun packages/dashboard/gen-kits.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SLOT_IDS: Record<string, number> = { hat: 0, cape: 1, amulet: 2, weapon: 3, torso: 4, shield: 5, legs: 7, hands: 9, feet: 10, ring: 12, ammo: 13 };
export type KitOut = { name: string; worn: Record<number, [string, number]>; carried: [string, number][]; unreachable?: string };

export function kitList(kits: Record<string, any>, names: Map<string, string>): KitOut[] {
    const name = (debug: string) => names.get(debug) ?? debug.replace(/_/g, ' ');
    const count = (v: string | [string, number]): [string, number] => (Array.isArray(v) ? [name(v[0]), v[1]] : [name(v), 1]);
    return Object.entries(kits).map(([kit, spec]) => {
        const worn: Record<number, [string, number]> = {};
        for (const [slot, item] of Object.entries(spec.worn ?? {})) if (slot in SLOT_IDS && item) worn[SLOT_IDS[slot]!] = count(item as any);
        // A thrown weapon is a stack in the weapon slot: worn.weaponCount (scripts/pk-kits.ts kitItems).
        if (worn[3] && spec.worn?.weaponCount > 0) worn[3] = [worn[3][0], spec.worn.weaponCount];
        const carried = new Map<string, number>();
        for (const c of spec.carried ?? []) { const [n, k] = count(c); carried.set(n, (carried.get(n) ?? 0) + k); }
        if (spec.food > 0) { const f = name(spec.foodItem ?? 'shark'); carried.set(f, (carried.get(f) ?? 0) + spec.food); }
        return { name: kit, worn, carried: [...carried], ...(typeof spec.unreachable === 'string' ? { unreachable: spec.unreachable } : {}) };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..');
    const { KITS } = await import('../../scripts/pk-kits');
    const items: { debugname?: string; name?: string }[] = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8'));
    const list = kitList(KITS as any, new Map(items.filter(i => i.debugname && i.name).map(i => [i.debugname!, i.name!])));
    writeFileSync(join(import.meta.dir, 'client-assets', 'pk-kits.json'), JSON.stringify(list));
    console.log(`pk-kits.json: ${list.length} kits`);
}
