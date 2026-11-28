import { describe, expect, test } from 'bun:test';
import { depositObserved } from '../../core/src/deposit';
import { runItemMagic } from '../src/bank-artisan/magic';
import { itemMagicRecipe } from '../src/bank-artisan/recipes';
import { KARAMBWANJI_LAKE, supplySharks } from '../src/gather/fishing';
import { runYewsGather } from '../src/gather/woodcutting';
import * as pf from '../../../vendor/rs-sdk/sdk/pathfinding';

describe('live defect regression tests', () => {
    test('KARAMBWANJI_LAKE is a walkable shoreline tile reachable from Karamja dock', () => {
        pf.initPathfinding();
        expect(KARAMBWANJI_LAKE).toEqual({ x: 2801, z: 3009, level: 0 });
        const path = pf.findLongPath(0, 2924, 3146, KARAMBWANJI_LAKE.x, KARAMBWANJI_LAKE.z, 500);
        expect(path.length).toBeGreaterThan(0);
        expect(path.at(-1)).toMatchObject({ x: KARAMBWANJI_LAKE.x, z: KARAMBWANJI_LAKE.z });
    });

    test('supplySharks rejects unqualified skills before travelling to Catherby', async () => {
        let travelCalls = 0;
        const listeners = new Set<() => void>();
        const state: any = {
            inGame: true,
            player: { worldX: 3092, worldZ: 3242, level: 0, lifeId: 1, respawnCount: 0, isDead: false, hp: 16, maxHp: 16 },
            skills: [
                { name: 'Hitpoints', level: 16, baseLevel: 16, experience: 3000 },
                { name: 'Fishing', level: 20, baseLevel: 20, experience: 4500 },
                { name: 'Cooking', level: 30, baseLevel: 30, experience: 13500 },
            ],
            inventory: [],
            equipment: [],
            bank: { isOpen: false, items: [] },
        };
        const s: any = {
            name: 'RearEntry',
            tick: () => 1,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            sdk: {
                getState: () => state,
                getSkill: (name: string) => state.skills.find((k: any) => k.name === name),
                getInventory: () => state.inventory,
                getEquipment: () => state.equipment,
            },
            bot: {
                openBank: async () => {
                    travelCalls++;
                    return { success: false, message: 'should not open bank' };
                },
                closeInterface: async () => ({ success: true }),
            },
        };
        const res = await supplySharks(s, { target: 25, maxTicks: 1000, consumer: 'test' });
        expect(res.ok).toBe(false);
        expect(res.failure).toContain('shark order requires Fishing76 Cooking80');
        expect(res.ticks).toBe(0);
        expect(travelCalls).toBe(0);
    });

    test('runItemMagic dismisses a level-up continue dialog and retries once when effect is none', async () => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const advance = () => {
            tick++;
            for (const fn of [...listeners]) fn();
        };
        const recipe = itemMagicRecipe('low-alch', 'feather');
        let dialogOpen = true;
        let dismisses = 0;
        let casts = 0;
        const inv = [
            { id: recipe.target, name: 'Feather', count: 5, slot: 0 },
            { id: 554, name: 'Fire rune', count: 30, slot: 1 },
            { id: 561, name: 'Nature rune', count: 10, slot: 2 },
        ];
        let coins = 0;
        let magicXp = 1000;
        const state: any = {
            player: { worldX: 3185, worldZ: 3438, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
            skills: [
                { name: 'Hitpoints', level: 60, baseLevel: 60, experience: 280000 },
                { name: 'Magic', level: 54, baseLevel: 54, experience: magicXp },
                { name: 'Smithing', level: 50, baseLevel: 50, experience: 100000 },
            ],
            equipment: [],
            get inventory() {
                return coins > 0 ? [...inv, { id: 995, name: 'Coins', count: coins, slot: 3 }] : inv;
            },
            get dialog() {
                return dialogOpen ? { isOpen: true, options: [{ index: 1, text: 'Click here to continue' }] } : { isOpen: false, options: [] };
            },
            interface: { isOpen: false },
        };
        const s: any = {
            name: 'Nockitoff',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            direct: async (action: any) => {
                if (action.type === 'spellOnItem') {
                    casts++;
                    // First cast is blocked by open level-up continue dialog; second succeeds after dismiss.
                    if (!dialogOpen) {
                        inv[0]!.count -= 1;
                        inv[1]!.count -= 3;
                        inv[2]!.count -= 1;
                        coins += recipe.output;
                        magicXp += 775;
                    }
                    return { success: true };
                }
                return { success: true };
            },
            sdk: {
                getState: () => state,
                getSkill: (name: string) => state.skills.find((k: any) => k.name === name),
                getSkillXp: (name: string) => (name === 'Magic' ? magicXp : 0),
                getInventory: () => state.inventory,
            },
            bot: {
                dismissBlockingUI: async () => {
                    dismisses++;
                    dialogOpen = false;
                },
            },
        };
        let done = false;
        const run = runItemMagic(s, recipe, { count: 1, cap: 50, members: true }).finally(() => {
            done = true;
        });
        for (let i = 0; i < 60 && !done; i++) {
            await Promise.resolve();
            advance();
        }
        const res = await run;
        expect(res.ok).toBe(true);
        expect(res.casts).toBe(1);
        expect(dismisses).toBe(1);
        expect(casts).toBe(2);
    });

    test('depositObserved retries once when bank remains open with pack and bank unchanged', async () => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const advance = () => {
            tick++;
            for (const fn of [...listeners]) fn();
        };
        let calls = 0;
        let packCount = 1;
        let bankCount = 0;
        let gen = 1;
        const s: any = {
            name: 'RearEntry',
            tick: () => tick,
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            bankObservation: () => ({
                generation: gen,
                at: Date.now(),
                items: bankCount > 0 ? [{ id: 946, name: 'Knife', count: bankCount }] : [],
            }),
            sdk: {
                getState: () => ({
                    inventory: packCount > 0 ? [{ id: 946, name: 'Knife', count: packCount, slot: 0 }] : [],
                    bank: { isOpen: true, items: [] },
                }),
            },
            bot: {
                depositItem: async () => {
                    calls++;
                    if (calls === 2) {
                        packCount = 0;
                        bankCount = 1;
                        gen = 2;
                        return { success: true };
                    }
                    return { success: false, message: 'dropped first click' };
                },
            },
        };
        let done = false;
        const p = depositObserved(s, { id: 946, name: 'Knife' }).finally(() => {
            done = true;
        });
        for (let i = 0; i < 40 && !done; i++) {
            await Promise.resolve();
            advance();
        }
        expect(await p).toBe(1);
        expect(calls).toBe(2);
    });

    test('runYewsGather exits immediately on walk danger instead of looping ticks=0', async () => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const advance = () => {
            tick++;
            for (const fn of [...listeners]) fn();
        };
        const state: any = {
            inGame: true,
            player: { worldX: 3086, worldZ: 3283, level: 0, lifeId: 1, respawnCount: 0, isDead: false, combatLevel: 3, hp: 10, maxHp: 10, runEnergy: 100, runWeight: 0 },
            skills: [
                { name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1154 },
                { name: 'Woodcutting', level: 75, baseLevel: 75, experience: 1210421 },
                { name: 'Attack', level: 1, baseLevel: 1, experience: 0 },
                { name: 'Defence', level: 1, baseLevel: 1, experience: 0 },
                { name: 'Strength', level: 1, baseLevel: 1, experience: 0 },
            ],
            inventory: [{ id: 1359, name: 'Rune axe', count: 1, slot: 0 }],
            equipment: [],
            nearbyLocs: [],
            nearbyNpcs: [],
            nearbyPlayers: [],
            bank: { isOpen: false, items: [] },
            dialog: { isOpen: false, options: [] },
            interface: { isOpen: false },
            gameMessages: [],
        };
        const s: any = {
            name: 'BoneToPick',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            sdk: {
                getState: () => state,
                getSkill: (name: string) => state.skills.find((k: any) => k.name === name),
                getSkillXp: (name: string) => state.skills.find((k: any) => k.name === name)?.experience ?? 0,
                getInventory: () => state.inventory,
                getEquipment: () => state.equipment,
            },
            bot: {
                openBank: async () => ({ success: false, message: 'no bank' }),
                closeInterface: async () => ({ success: true }),
            },
            direct: async () => ({ success: true }),
        };
        const tStart = performance.now();
        let done = false;
        const run = runYewsGather(
            s,
            {
                skill: 'woodcutting',
                method: 'yews',
                args: ['3000'],
                env: { TREE: 'magic', REGION: 'seers', WOOD_GROVE: 'native-processing' },
            },
            () => false,
        ).then(
            v => ({ ok: true as const, v }),
            e => ({ ok: false as const, err: String(e) }),
        ).finally(() => {
            done = true;
        });
        for (let i = 0; i < 10 && !done; i++) {
            await Promise.resolve();
            advance();
        }
        const res = await run;
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.err).toMatch(/walk danger|no route/);
        expect(performance.now() - tStart).toBeLessThan(15_000);
    }, 20_000);
});
