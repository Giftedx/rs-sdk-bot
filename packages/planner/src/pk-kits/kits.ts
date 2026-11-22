// Combined PK kit catalog plus skill, switch, option, item, and shop-cost accessors.
import type { Kit } from '../pk-types';
import { BUILD_KITS } from './kits-builds';
import { LIVE_KITS } from './kits-live';
import { TRIBRID_KITS } from './kits-tribrid';
import { MAXED, SLOT, costOf, itemId, type KitSpec } from './model';

export const KITS: Readonly<Record<string, KitSpec>> = {
    ...TRIBRID_KITS,
    ...LIVE_KITS,
    ...BUILD_KITS,
};

export function kitOf(name: string): KitSpec {
    const k = KITS[name];
    if (!k) throw Error(`pk-kits: unknown kit "${name}"; known: ${Object.keys(KITS).join(', ')}`);
    return k;
}

const carried = (k: KitSpec) =>
    k.carried.map(c => (typeof c === 'string' ? { id: itemId(c), count: 1 } : { id: itemId(c[0]), count: c[1] }));

export const kitSkills = (name: string): Record<string, number> => ({ ...(kitOf(name).skills ?? MAXED) });

// The fight loop's switch weapons for a kit.
export const kitSwitches = (name: string): Kit =>
    Object.fromEntries(Object.entries(kitOf(name).switches).map(([style, names]) => [style, names!.map(itemId)]));

export const kitOptions = (name: string) => kitOf(name).options ?? {};

// What an account of the kit wears and carries at the start, in the save generator's form.
export function kitItems(name: string) {
    const k = kitOf(name);
    const equipment = Object.entries(k.worn).flatMap(([slot, item]) => (slot === 'ammo'
        ? [{ id: itemId((item as [string, number])[0]), count: (item as [string, number])[1], slot: 13 }]
        // A thrown weapon is a stack in the weapon slot (weaponCount).
        : slot === 'weaponCount' ? [] : [{ id: itemId(item as string), count: slot === 'weapon' ? k.worn.weaponCount ?? 1 : 1, slot: SLOT[slot as keyof typeof SLOT] }]));
    const inventory = [...carried(k), ...Array.from({ length: k.food }, () => ({ id: itemId(k.foodItem ?? 'shark'), count: 1 }))];
    if (inventory.length > 27) throw Error(`pk-kits: kit ${name} carries ${inventory.length} items; 27 leave the free slot that a bow switch needs`);
    return { equipment, inventory };
}

// Shop value of everything the kit wears and carries.
export function kitCost(name: string): number {
    const { equipment, inventory } = kitItems(name);
    return [...equipment, ...inventory].reduce((n, i) => n + costOf(i.id) * i.count, 0);
}
