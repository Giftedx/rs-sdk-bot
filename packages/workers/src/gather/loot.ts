// Finite visible-ground looter: exact ID/name lists, native static-value bounds, or their union.
import { lootCapacity, lootMatches, validLootFilters, type LootDefinition, type LootPolicy } from '../../../core/src/loot-policy';
import type { BotWorldState, GroundItem } from '../../../../vendor/rs-sdk/sdk/types';

export { lootCapacity, type LootDefinition, type LootPolicy } from '../../../core/src/loot-policy';

const stock = (s: BotWorldState) => {
    const n: Record<number, number> = {};
    for (const i of s.inventory) n[i.id] = (n[i.id] ?? 0) + i.count;
    return n;
};
const hp = (s: BotWorldState) => s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;

export function selectGroundLoot(
    s: BotWorldState,
    p: LootPolicy,
    definition: (id: number) => LootDefinition | undefined,
    left = p.maximumUnits,
) {
    return s.groundItems.flatMap(i => {
        if (s.groundItems.some(other => other.id === i.id && other.x === i.x && other.z === i.z && other.count !== i.count)) {
            return [];
        }
        const d = definition(i.id);
        if (
            !d
            || !Number.isSafeInteger(i.count)
            || i.count < 1
            || i.count > left
            || !Number.isSafeInteger(d.cost)
            || d.cost < 0
            || !Number.isSafeInteger(i.count * d.cost)
            || i.reachable === false
            || i.distance > p.radius
            || !lootCapacity(s, i, d)
            || s.nearbyPlayers.some(player => Math.max(Math.abs(player.x - i.x), Math.abs(player.z - i.z)) <= 1)
        ) {
            return [];
        }
        return lootMatches(i, p, d) ? [{ item: i, value: i.count * d.cost }] : [];
    }).sort((a, b) => b.value - a.value || a.item.distance - b.item.distance)[0];
}

export function groundLootEffect(before: BotWorldState, after: BotWorldState, item: GroundItem): boolean {
    const b = stock(before);
    const a = stock(after);
    const keys = new Set([...Object.keys(b), ...Object.keys(a)].map(Number));
    if ([...keys].every(id => (a[id] ?? 0) === (b[id] ?? 0))) return false;
    if (![...keys].every(id => (a[id] ?? 0) - (b[id] ?? 0) === (id === item.id ? item.count : 0))) {
        throw Error('ground pickup inventory delta does not reconcile');
    }
    return true;
}

export interface LootDriver {
    state: () => BotWorldState | null;
    tick: () => number;
    stop: () => boolean;
    definition: (id: number) => LootDefinition | undefined;
    pickup: (i: GroundItem) => Promise<boolean>;
    wait: (test: () => boolean, ticks: number) => Promise<boolean>;
    step: () => Promise<void>;
    clearModal?: () => Promise<void>;
}

export async function runVisibleGroundLoot(d: LootDriver, p: LootPolicy) {
    if (
        !validLootFilters(p)
        || ![p.maximumUnits, p.cap, p.idleTicks, p.radius].every(n => Number.isSafeInteger(n) && n > 0)
        || p.radius > 12
        || !Number.isSafeInteger(p.minimumValue)
        || p.minimumValue < 0
        || !Number.isSafeInteger(p.maximumValue)
        || p.maximumValue < p.minimumValue
    ) {
        throw Error('invalid finite ground-loot policy');
    }
    const initial = d.state();
    if (!initial?.player || hp(initial) < 1) throw Error('ground-loot state unknown');
    const start = d.tick();
    let units = 0;
    let pickups = 0;
    let staticValue = 0;
    let progress = start;
    const acquired: Record<number, number> = {};
    const kit = JSON.stringify(initial.equipment.map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot));
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('ground-loot session ended');
        if (d.stop()) throw Error('ground-loot stopped');
        if (d.tick() - start >= p.cap) throw Error('ground-loot cap');
        if (
            s.player.lifeId !== initial.player!.lifeId
            || s.player.level !== initial.player!.level
            || s.player.isDead
            || hp(s) !== hp(initial)
            || Math.max(Math.abs(s.player.worldX - initial.player!.worldX), Math.abs(s.player.worldZ - initial.player!.worldZ)) > p.radius
        ) {
            throw Error('ground-loot health, life or area changed');
        }
        if (JSON.stringify(s.equipment.map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot)) !== kit) {
            throw Error('ground-loot equipment changed');
        }
        return s;
    };
    while (units < p.maximumUnits) {
        let before = state();
        if (d.tick() - progress >= p.idleTicks) throw Error('ground-loot no eligible pickup progress');
        if (before.dialog?.isOpen || before.interface?.isOpen) {
            if (!d.clearModal) throw Error('ground-loot modal blocked');
            await d.clearModal();
            before = state();
        }
        const scoped = {
            ...before,
            groundItems: before.groundItems.filter(i =>
                Math.max(Math.abs(i.x - initial.player!.worldX), Math.abs(i.z - initial.player!.worldZ)) <= p.radius,
            ),
        };
        const selected = selectGroundLoot(scoped, p, d.definition, p.maximumUnits - units);
        if (!selected) {
            await d.step();
            continue;
        }
        const target = { ...selected.item };
        if (!(await d.pickup(target))) throw Error('native ground pickup refused');
        await d.wait(
            () => {
                const s = state();
                return groundLootEffect(before, s, target) || !s.groundItems.some(i => i.id === target.id && i.x === target.x && i.z === target.z);
            },
            Math.min(12, p.cap - (d.tick() - start)),
        );
        if (!groundLootEffect(before, state(), target)) {
            await d.step();
            if (!groundLootEffect(before, state(), target)) throw Error('ground disappeared without own inventory receipt');
        }
        units += target.count;
        pickups++;
        staticValue += selected.value;
        acquired[target.id] = (acquired[target.id] ?? 0) + target.count;
        progress = d.tick();
        if (units < p.maximumUnits) await d.step();
    }
    const b = stock(initial);
    const a = stock(state());
    const all = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(acquired)].map(Number));
    if (![...all].every(id => (a[id] ?? 0) - (b[id] ?? 0) === (acquired[id] ?? 0))) {
        throw Error('ground-loot final inventory audit failed');
    }
    return {
        units,
        pickups,
        acquired,
        staticValue,
        valueSource: 'native static item cost; not GE price',
        ticks: d.tick() - start,
        banked: 0,
        attribution: 'visible native pickup and owned inventory receipt; no kill-credit claim',
    };
}
