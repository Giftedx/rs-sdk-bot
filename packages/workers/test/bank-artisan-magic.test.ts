// Migrated unit tests for magic items, teleports, magic-trip, orbs, orb-trip, bones, and earth production.
import { describe, expect, spyOn, test } from 'bun:test';
import * as coreBot from '../../core/src/bot';
import { setEquipmentObserved } from '../../core/src/container-observation';
import { waitTicks } from '../../core/src/ticks';
import * as walking from '../../core/src/walk';
import { objId } from '../../practice/src/floor-bands';
import { installSpellLocBridge, spellOnNativeLoc } from '../../../scripts/microbot-c-spell-loc';
import { installOrbFloorBridge } from '../../../scripts/microbot-edgeville-travel';
import { runNpcMagic } from '../src/combat';
import {
    ORB_ENERGY,
    bonesEffect,
    chargeInventory,
    classifyOrbPeer,
    collectHuntLoot,
    depositEarthInventory,
    drinkOrbEnergy,
    drinkOrbSupplyPotion,
    earthProductionBatch as productionBatch,
    elementalRuneCost,
    equipOrbStaff,
    huntFight,
    itemMagicRecipe,
    itemSpellCosts,
    itemSpellEffect,
    magicBankProfile,
    magicStopRequested,
    nativeTeleport,
    orbGloryList,
    orbHome,
    orbInputOwner,
    orbInteractions,
    orbOptions,
    orbOwnedActions,
    orbEffect,
    orbPackEffect,
    orbPeerEquipment,
    orbPlanEndsAt,
    orbPlayerDetection,
    orbRecipes,
    orbSites,
    orbStopRequested,
    orbTripBudget,
    ownedOrbStaff,
    productionConserved,
    returnMagicTrip,
    returnOrbGlory,
    runBonesBank,
    runBonesConversion,
    runEarthProduction,
    runItemMagic,
    runOrbTrips,
    runTeleportMagic,
    spellDelay,
    stageOwnedEquipment,
    talismanTarget,
    teleportReceipt,
    validateMagicBankJob,
    validateOrbOptions,
    type BonesIO,
    type MagicBankJob,
} from '../src/bank-artisan';

const ORB_GLORY = orbGloryList();

describe('magic:items', () => {
    test('native recipes include all native jewelry conversions and eight smelting metals', () => {
        for (const metal of ['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamantite', 'runite']) expect(itemMagicRecipe('superheat:' + metal).product).toBe(objId(metal + '_bar'));
        for (const gem of ['sapphire', 'emerald', 'ruby', 'diamond', 'dragonstone']) for (const shape of ['ring', 'amulet']) expect(itemMagicRecipe('enchant:' + (shape === 'amulet' ? 'strung_' : '') + gem + '_' + shape).level).toBeGreaterThan(0);
        expect(itemMagicRecipe('enchant:sapphire_necklace').product).toBe(objId('necklace_of_minigames_8'));
        expect(() => itemMagicRecipe('enchant:emerald_necklace')).toThrow();
        expect(() => itemMagicRecipe('superheat:lead')).toThrow();
    });

    test('alchemy uses native cost and excludes rune targets', () => {
        const r = itemMagicRecipe('high-alch', 'bronze_dagger');
        expect(r.spell).toBe('magic:highlvl_alchemy');
        expect(r.output).toBeGreaterThan(0);
        expect(itemMagicRecipe('low-alch', 'bronze_dagger').output).toBeLessThan(r.output);
        expect(() => itemMagicRecipe('high-alch', 'naturerune')).toThrow();
    });

    test('exact product, all inputs, XP and unrelated assets reconcile', () => {
        const r = itemMagicRecipe('superheat:steel');
        const costs = itemSpellCosts(r, []);
        const before = { ...costs };
        const after: Record<number, number> = { [r.product]: 1 };
        expect(itemSpellEffect(r, costs, before, before, 0, 0)).toBe('none');
        expect(itemSpellEffect(r, costs, before, after, 0, 53)).toBe('cast');
        expect(itemSpellEffect(r, costs, before, { ...after, [objId('coal')]: 1 }, 0, 53)).toBe('invalid');
        expect(itemSpellEffect(r, costs, before, { ...after, 995: 1 }, 0, 53)).toBe('invalid');
        expect(itemSpellEffect(r, costs, before, after, 0, 0)).toBe('invalid');
    });

    test('only wielded elemental staff substitutes its rune', () => {
        const r = itemMagicRecipe('superheat:gold');
        expect(itemSpellCosts(r, [{ id: 1387, slot: 3 }])[554]).toBeUndefined();
        expect(itemSpellCosts(r, [{ id: 1387, slot: 1 }])[554]).toBe(4);
    });

    test('finite runner confirms a real mocked dispatch effect and bounds count', async () => {
        const r = itemMagicRecipe('superheat:gold');
        let tick = 0;
        let xp = 0;
        let calls = 0;
        let inventory = Object.entries(r.inputs).map(([id, count], slot) => ({ id: Number(id), count, slot }));
        const state = () => ({ player: { worldX: 3200, worldZ: 3200, lifeId: 1, isDead: false }, equipment: [], inventory });
        const listeners = new Set<() => void>();
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            sdk: { getState: state, getInventory: () => inventory, getSkillXp: () => xp, getSkill: () => ({ level: 99 }) },
            bot: { dismissBlockingUI: async () => {} },
            direct: async (a: any) => {
                calls++;
                expect(a.type).toBe('spellOnItem');
                inventory = [{ id: r.product, count: 1, slot: 0 }];
                xp = 53;
                return { success: true };
            },
        };
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            const out = await runItemMagic(s, r, { count: 1, cap: 20 });
            expect(out.ok).toBe(true);
            expect(out.casts).toBe(1);
            expect(calls).toBe(1);
        } finally {
            clearInterval(timer);
        }
    });

    test('finite runner stops before dispatch and refuses insufficient supplies', async () => {
        const r = itemMagicRecipe('superheat:gold');
        let calls = 0;
        const s: any = { tick: () => 0, ended: new Promise(() => {}), sdk: { getState: () => ({ player: { worldX: 1, worldZ: 1, lifeId: 1 }, equipment: [] }), getInventory: () => [], getSkillXp: () => 0, getSkill: () => ({ level: 99 }) }, bot: { dismissBlockingUI: async () => {} }, direct: async () => { calls++; } };
        expect((await runItemMagic(s, r, { count: 1, cap: 20, stop: () => true })).stop).toBe('stopped');
        expect((await runItemMagic(s, r, { count: 1, cap: 20 })).stop).toBe('supplies');
        expect(calls).toBe(0);
    });

    test('native staff table supports both lava elements and gates member staff on F2P', () => {
        for (const id of [3053, 3054]) for (const rune of [554, 557]) {
            expect(elementalRuneCost(rune, 10, [{ id, slot: 3 }], true)).toBe(0);
            expect(elementalRuneCost(rune, 10, [{ id, slot: 3 }], false)).toBe(10);
        }
        expect(elementalRuneCost(556, 5, [{ id: 1397, slot: 3 }], false)).toBe(5);
        expect(elementalRuneCost(556, 5, [{ id: 1397, slot: 3 }], true)).toBe(0);
        expect(elementalRuneCost(556, 5, [{ id: 1381, slot: 3 }], false)).toBe(0);
    });

    test('an elemental staff removes spell runes but never the alchemy target debit', () => {
        const r = itemMagicRecipe('high-alch', 'airrune');
        expect(r.inputs[r.target]).toBe(1);
        expect(itemSpellCosts(r, [{ id: 1381, slot: 3 }])[r.target]).toBe(1);
    });

    test('runItemMagic equips a matching wearable elemental staff from inventory to save runes', async () => {
        const r = itemMagicRecipe('superheat:gold');
        let tick = 0;
        let xp = 0;
        let calls = 0;
        let equips = 0;
        let inventory: any[] = [{ id: 1387, name: 'Staff of fire', count: 1, slot: 0 }, { id: 444, count: 1, slot: 1 }, { id: 561, count: 1, slot: 2 }];
        const equipment: any[] = [];
        const listeners = new Set<() => void>();
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            sdk: {
                getState: () => ({ player: { worldX: 3200, worldZ: 3200, lifeId: 1, isDead: false }, equipment, inventory }),
                getInventory: () => inventory,
                getEquipment: () => equipment,
                getSkillXp: () => xp,
                getSkill: (n: string) => ({ level: n === 'Magic' || n === 'Smithing' ? 99 : 1, baseLevel: 1 }),
            },
            bot: {
                dismissBlockingUI: async () => {},
                equipItem: async (item: any) => {
                    equips++;
                    inventory = inventory.filter(i => i.id !== item.id);
                    equipment.push({ ...item, slot: 3 });
                    return { success: true };
                },
            },
            direct: async () => {
                calls++;
                inventory = inventory.filter(i => i.id !== 444 && i.id !== 561);
                inventory.push({ id: r.product, count: 1, slot: 0 });
                xp = 53;
                return { success: true };
            },
        };
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            const out = await runItemMagic(s, r, { count: 1, cap: 20 });
            expect(out.ok).toBe(true);
            expect(equips).toBe(1);
            expect(equipment[0]?.id).toBe(1387);
            expect(calls).toBe(1);
        } finally {
            clearInterval(timer);
        }
    });

    test('the gap after a cast is the p_delay of the native spell script', () => {
        expect(spellDelay('high-alch')).toBe(3);
        expect(spellDelay('low-alch')).toBe(1);
        expect(spellDelay('superheat:iron')).toBe(1);
        expect(spellDelay('enchant:sapphire_ring')).toBe(1);
        expect(() => spellDelay('teleport')).toThrow();
    });
});

describe('magic:teleport', () => {
    test('seven pinned teleport recipes resolve coordinates, levels and member requirement', () => {
        for (const name of ['varrock', 'lumbridge', 'falador', 'camelot', 'ardougne', 'watchtower', 'trollheim']) expect(nativeTeleport(name).to.x).toBeGreaterThan(0);
        expect(nativeTeleport('watchtower').to.level).toBe(2);
        expect(nativeTeleport('camelot').members).toBe(true);
        expect(() => nativeTeleport('kourend')).toThrow();
    });

    test('teleport confirms all rune debits, XP and radius-two destination', () => {
        const t = nativeTeleport('varrock');
        const b = { ...t.runes };
        const a = {};
        const p = { worldX: t.to.x + 2, worldZ: t.to.z, level: 0 };
        expect(teleportReceipt(t, t.runes, b, a, 0, 35, p)).toBe(true);
        expect(teleportReceipt(t, t.runes, b, a, 0, 35, { ...p, worldX: t.to.x + 3 })).toBe(false);
        expect(teleportReceipt(t, t.runes, b, b, 0, 35, p)).toBe(false);
        expect(teleportReceipt(t, t.runes, b, a, 0, 0, p)).toBe(false);
    });

    test('member teleport scopes are explicit and invalid batches reject before session reads', async () => {
        await expect(runTeleportMagic({} as any, nativeTeleport('camelot'), { casts: 1, cap: 100 })).rejects.toThrow('member');
        await expect(runTeleportMagic({} as any, nativeTeleport('varrock'), { casts: Infinity, cap: 100 })).rejects.toThrow('invalid');
    });

    test('teleport staged runner observes rune debit and actual destination before success', async () => {
        const t = nativeTeleport('varrock');
        let tick = 0;
        let xp = 0;
        let stock: Record<number, number> = { ...t.runes };
        let position = { worldX: 3200, worldZ: 3200, lifeId: 1, level: 0 };
        const listeners = new Set<() => void>();
        const inventory = () => Object.entries(stock).filter(([, n]) => n > 0).map(([id, count], slot) => ({ id: Number(id), count, slot }));
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            sdk: { getState: () => ({ player: position, inventory: inventory() }), getInventory: inventory, getEquipment: () => [], getSkillXp: () => xp, getSkill: () => ({ level: 99 }) },
            bot: { dismissBlockingUI: async () => {} },
            direct: async () => {
                stock = {};
                xp = 35;
                position = { ...position, worldX: t.to.x, worldZ: t.to.z };
                return { success: true };
            },
        };
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            const r = await runTeleportMagic(s, t, { casts: 1, cap: 100 });
            expect(r.ok).toBe(true);
            expect(r.casts).toBe(1);
        } finally {
            clearInterval(timer);
        }
    });

    test('shared CLI global stop prevents paid teleport dispatch', async () => {
        let actions = 0;
        const s: any = { tick: () => 0, ended: new Promise(() => {}), sdk: { getInventory: () => [], getEquipment: () => [], getSkill: () => ({ level: 99 }), getSkillXp: () => 0, getState: () => ({ player: { lifeId: 1, level: 0, worldX: 3185, worldZ: 3436 } }) }, direct: async () => { actions++; return { success: true }; } };
        const stop = () => magicStopRequested('owned', false, path => path === '.practice/stop-all', '');
        const r = await runTeleportMagic(s, nativeTeleport('varrock'), { casts: 1, cap: 50, stop });
        expect(r.ok).toBe(false);
        expect(r.casts).toBe(0);
        expect(actions).toBe(0);
    });
});

describe('magic:trip', () => {
    const job = (): MagicBankJob => ({ family: 'magic-npc', recipe: 'wind_strike', npc: 1, target: 2, batch: 1, cap: 600, returnTicks: 100, members: true, bank: { x: 3185, z: 3436, level: 0 }, site: { x: 3200, z: 3436, level: 0 } });

    test('magic refills add shared rune costs and keep the alchemy target distinct', () => {
        const s: any = { sdk: { getEquipment: () => [{ id: 1381, slot: 3 }], getSkill: () => ({ level: 99 }) } };
        const p = magicBankProfile(s, { ...job(), comboAlch: 'low-alch', alchemyTarget: 'bronze_dagger', comboTeleport: 'varrock' });
        expect(p.inputs).toEqual({ 558: 1, 554: 4, 561: 1, 563: 1, 1205: 1 });
        expect(p.outputs).toEqual([995]);
        expect(p.bank).toEqual(job().bank!);
        expect(p.site).toEqual(job().site!);
    });

    test('bank magic refuses missing target/site, unknown spells and unsafe teleport-combo batches', () => {
        for (const j of [{ ...job(), npc: -1 }, { ...job(), site: undefined }, { ...job(), recipe: 'vengeance' }, { ...job(), comboTeleport: 'varrock', batch: 2 }, { ...job(), family: 'magic-teleport', recipe: 'camelot', members: false }]) {
            expect(() => validateMagicBankJob(j as MagicBankJob)).toThrow();
        }
    });

    test('bank profile invokes real finite NPC worker and disables retaliation before paid casts', async () => {
        let tick = 0;
        let xp = 0;
        let retaliate = true;
        const calls: string[] = [];
        const stock: Record<number, number> = { 556: 2, 558: 2 };
        const listeners = new Set<() => void>();
        const inventory = () => Object.entries(stock).filter(([, n]) => n > 0).map(([id, count], slot) => ({ id: Number(id), count, slot }));
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            client: { selfSlot: 1, var: Array(109).fill(0) },
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            sdk: {
                getEquipment: () => [],
                getInventory: inventory,
                getSkill: () => ({ level: 99 }),
                getSkillXp: (name: string) => (name === 'Magic' ? xp : 0),
                getState: () => ({ player: { lifeId: 1, level: 0, worldX: 3200, worldZ: 3436 }, autoRetaliateEnabled: retaliate, nearbyNpcs: [{ id: 1, index: 4, hp: 10, inCombat: false, reachable: true, distance: 1, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] }] }),
            },
            bot: { dismissBlockingUI: async () => {} },
            direct: async (a: any) => {
                calls.push(a.type);
                if (a.type === 'clickComponent') {
                    expect(a.componentId).toBe(151);
                    retaliate = false;
                } else {
                    expect(retaliate).toBe(false);
                    stock[556]!--;
                    stock[558]!--;
                    xp += 6;
                }
                return { success: true };
            },
        };
        const p = magicBankProfile(s, job(), { runNpcMagic: runNpcMagic as any });
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            expect(await p.run(2, 100, () => false)).toBe(2);
            expect(calls).toEqual(['clickComponent', 'spellOnNpc', 'spellOnNpc']);
            expect(stock).toEqual({ 556: 0, 558: 0 });
        } finally {
            clearInterval(timer);
        }
    });

    test('remote teleports reserve an observed return spell per one-cast bank trip', () => {
        const s: any = { sdk: { getEquipment: () => [], getSkill: () => ({ level: 99 }) } };
        const j = { ...job(), family: 'magic-teleport' as const, recipe: 'trollheim', returnTeleport: 'varrock' };
        expect(magicBankProfile(s, j).inputs).toEqual({ 554: 3, 556: 3, 563: 3 });
        expect(() => validateMagicBankJob({ ...j, batch: 2 })).toThrow('one-cast');
    });

    test('special spell bank staging requires the actual native worn staff before withdrawing runes', () => {
        const s: any = { sdk: { getEquipment: () => [], getSkill: () => ({ level: 99 }) } };
        expect(() => magicBankProfile(s, { ...job(), recipe: 'iban_blast' })).toThrow('required staff');
        s.sdk.getEquipment = () => [{ id: 1409, slot: 3 }];
        expect(magicBankProfile(s, { ...job(), recipe: 'iban_blast' }).inputs).toEqual({ 554: 5, 560: 1 });
    });

    test('protection and retaliation are observed before the bank runner approaches an undead target', async () => {
        let ret = true;
        let prayer = false;
        const actions: string[] = [];
        const s: any = {
            sdk: {
                getEquipment: () => [],
                getSkill: () => ({ level: 99 }),
                getState: () => ({ autoRetaliateEnabled: ret, prayers: { prayerLevel: 99, prayerPoints: 99 } }),
                isPrayerActive: () => prayer,
                sendTogglePrayer: async (i: number) => {
                    expect(i).toBe(14);
                    actions.push('protect');
                    prayer = true;
                    return { success: true };
                },
            },
            direct: async (a: any) => {
                expect(a.componentId).toBe(151);
                actions.push('retaliation-off');
                ret = false;
            },
        };
        const p = magicBankProfile(s, { ...job(), recipe: 'crumble_undead', npc: 92, protectPrayer: 14 });
        await p.prepare!(() => false);
        expect(actions).toEqual(['retaliation-off', 'protect']);
        expect(ret).toBe(false);
        expect(prayer).toBe(true);
    });

    test('stopped NPC batch pays only its declared return and retains the original failure', async () => {
        let tick = 0;
        let xp = 0;
        let stopped = false;
        let teleports = 0;
        let player = { lifeId: 1, level: 0, worldX: 3197, worldZ: 3353 };
        const stock: Record<number, number> = { 556: 4, 558: 1, 554: 1, 563: 1 };
        const listeners = new Set<() => void>();
        const inv = () => Object.entries(stock).filter(([, count]) => count > 0).map(([id, count], slot) => ({ id: Number(id), count, slot }));
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            client: { selfSlot: 1, var: Array(109).fill(0) },
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            sdk: { getEquipment: () => [], getInventory: inv, getSkill: () => ({ level: 99 }), getSkillXp: (name: string) => (name === 'Magic' ? xp : 0), getState: () => ({ player, autoRetaliateEnabled: false, nearbyNpcs: [] }), sendCloseModal: async () => ({ success: true }) },
            bot: {
                dismissBlockingUI: async () => {
                    stopped = true;
                },
            },
            direct: async (a: any) => {
                expect(a.type).toBe('clickComponent');
                teleports++;
                stock[556]! -= 3;
                stock[554]!--;
                stock[563]!--;
                xp += 35;
                player = { ...player, worldX: 3213, worldZ: 3424 };
                return { success: true };
            },
        };
        const p = magicBankProfile(s, { ...job(), returnTeleport: 'varrock' }, { runNpcMagic: runNpcMagic as any });
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            await expect(p.run(1, 100, () => stopped)).rejects.toThrow('stopped/cap');
            expect(teleports).toBe(1);
            expect(stopped).toBe(true);
            expect(stock).toEqual({ 556: 1, 558: 1, 554: 0, 563: 0 });
        } finally {
            clearInterval(timer);
        }
    });

    test('configured return cannot bypass native high-Wilderness teleport restrictions', async () => {
        let dispatches = 0;
        const s: any = { tick: () => 0, sdk: { getState: () => ({ player: { lifeId: 1, level: 0, worldX: 3000, worldZ: 3800 } }), getSkill: () => ({ level: 99 }) }, direct: async () => { dispatches++; } };
        await expect(returnMagicTrip(s, { name: 'varrock', component: 'magic:varrock_teleport', level: 25, members: false, runes: { 554: 1, 556: 3, 563: 1 }, to: { x: 3213, z: 3424, level: 0 } }, true, 40)).rejects.toThrow('legal Wilderness exit');
        expect(dispatches).toBe(0);
    });

    test('NPC magic reaches the exact declared pen site before selecting a walking-reachable target', async () => {
        const { bankTravelTolerance } = await import('../../../scripts/microbot-bank-jobs');
        const { walkPath } = await import('../../core/src/walk');
        let at = { x: 3199, z: 3354, level: 0 };
        let tick = 0;
        let clicks = 0;
        const listeners = new Set<() => void>();
        const site = { x: 3197, z: 3353 };
        const deps: any = {
            pos: () => at,
            tick: () => tick,
            onTick: (f: () => void) => {
                listeners.add(f);
                return () => listeners.delete(f);
            },
            locs: () => [],
            plan: () => [site],
            walk: (x: number, z: number) => {
                clicks++;
                at = { x, z, level: 0 };
            },
            interactLoc: () => {
                throw Error('unexpected loc');
            },
        };
        const timer = setInterval(() => {
            tick++;
            for (const f of listeners) f();
        }, 1);
        try {
            const result = await walkPath(deps, [{ ...site, tol: bankTravelTolerance('magic-npc', true) }], { maxTicks: 10 });
            expect(result.ok).toBe(true);
            expect(clicks).toBeGreaterThan(0);
            expect(at).toEqual({ ...site, level: 0 });
            expect(bankTravelTolerance('magic-npc', false)).toBe(2);
            expect(bankTravelTolerance('fishing', true)).toBe(2);
            expect(bankTravelTolerance('cooking', true)).toBe(0);
        } finally {
            clearInterval(timer);
        }
    });
});

describe('magic:orbs', () => {
    test('native spell location encodes route then OPLOCT x,z,loc,spell', () => {
        const calls: any[] = [];
        const c = {
            isInGame: () => true,
            localPlayer: {},
            toSceneTile: () => ({ x: 4, z: 7 }),
            locSceneInfo: () => ({ shape: 10, angle: 0 }),
            routeToLoc: (...a: any[]) => {
                calls.push(['route', ...a]);
                return true;
            },
            writeOpcode: (n: number) => calls.push(['opcode', n]),
            out: { p2: (n: number) => calls.push(['p2', n]) },
        };
        expect(spellOnNativeLoc(c, 3000, 4000, 2152, 1186)).toEqual({ success: true, routed: true });
        expect(calls).toEqual([['route', 4, 7, 2152], ['opcode', 218], ['p2', 3000], ['p2', 4000], ['p2', 2152], ['p2', 1186]]);
        expect(() => spellOnNativeLoc({ ...c, locSceneInfo: () => null }, 3000, 4000, 2152, 1186)).toThrow('target absent');
        expect(() => spellOnNativeLoc(null, 3000, 4000, 2152, 1186)).toThrow('requires native');
    });

    test('orb conversion reconciles both runes, orb and XP', () => {
        const before = { raw: 2, product: 0, cosmic: 6, element: 60, xp: 1 };
        const after = { raw: 1, product: 1, cosmic: 3, element: 30, xp: 77 };
        expect(orbEffect(before, after)).toBe(true);
        expect(orbEffect(before, { ...after, cosmic: 6 })).toBe(false);
        expect(orbEffect(before, { ...after, element: 60 })).toBe(false);
        expect(orbEffect(before, { ...after, xp: 1 })).toBe(false);
        expect(Object.keys(orbRecipes)).toHaveLength(4);
        const staffCost = elementalRuneCost(556, 30, [{ id: 1381, slot: 3 }]);
        expect(staffCost).toBe(0);
        expect(orbEffect(before, { ...after, element: 60 }, staffCost)).toBe(true);
        expect(elementalRuneCost(556, 30, [{ id: 1381, slot: 5 }])).toBe(30);
    });

    test('invalid orb order accesses no session', async () => {
        await expect(chargeInventory(null as any, 'air', 0, 20)).rejects.toThrow('invalid orb order');
    });

    test('finite orb order confirms conversions and preserves unrelated stock', async () => {
        const items = [{ id: 567, count: 3 }, { id: 573, count: 1 }, { id: 564, count: 12 }, { id: 556, count: 120 }, { id: 995, count: 9 }];
        let xp = 100;
        let words = 0;
        const client = {
            executeBotAction: (_: unknown) => ({ success: false }),
            isInGame: () => true,
            localPlayer: {},
            toSceneTile: () => ({ x: 1, z: 2 }),
            locSceneInfo: () => ({ shape: 10 }),
            routeToLoc: () => true,
            writeOpcode: () => {},
            out: {
                p2: () => {
                    if (++words % 4 === 0) {
                        items[0]!.count--;
                        items[1]!.count++;
                        items[2]!.count -= 3;
                        items[3]!.count -= 30;
                        xp += 76;
                    }
                },
            },
        };
        let tick = 0;
        const s: any = {
            client,
            direct: (a: unknown) => client.executeBotAction(a),
            tick: () => tick,
            onTick: (cb: () => void) => {
                let active = true;
                const next = () =>
                    queueMicrotask(() => {
                        if (active) {
                            tick++;
                            cb();
                            next();
                        }
                    });
                next();
                return () => {
                    active = false;
                };
            },
            sdk: { getInventory: () => items, getEquipment: () => [], getSkill: () => ({ baseLevel: 66, level: 66 }), getSkillXp: () => xp, getState: () => ({ player: { lifeId: 1 }, nearbyLocs: [{ id: 2152, x: 3000, z: 4000 }] }) },
        };
        const result = await chargeInventory(s, 'air', 2, 80);
        expect(result).toMatchObject({ ok: true, made: 2, preserved: true });
        expect(words).toBe(8);
        expect(items[4]!.count).toBe(9);
    });

    test('instance executor bridge delegates other actions and restores method', () => {
        const original = (a: any) => a.type;
        const client = { executeBotAction: original };
        const restore = installSpellLocBridge(client);
        expect(client.executeBotAction({ type: 'closeModal' })).toBe('closeModal');
        restore();
        expect(client.executeBotAction).toBe(original);
    });

    test('CLI global stop callback prevents a second real charge action', async () => {
        const items = [{ id: 567, count: 2 }, { id: 573, count: 0 }, { id: 564, count: 6 }, { id: 556, count: 60 }];
        let xp = 100;
        let words = 0;
        let globalStop = false;
        let tick = 0;
        const client = {
            executeBotAction: (_: unknown) => ({ success: false }),
            isInGame: () => true,
            localPlayer: {},
            toSceneTile: () => ({ x: 1, z: 2 }),
            locSceneInfo: () => ({ shape: 10 }),
            routeToLoc: () => true,
            writeOpcode: () => {},
            out: {
                p2: () => {
                    if (++words % 4 === 0) {
                        items[0]!.count--;
                        items[1]!.count++;
                        items[2]!.count -= 3;
                        items[3]!.count -= 30;
                        xp += 76;
                        globalStop = true;
                    }
                },
            },
        };
        const s: any = {
            client,
            direct: (a: unknown) => client.executeBotAction(a),
            tick: () => tick,
            onTick: (cb: () => void) => {
                let active = true;
                const next = () =>
                    queueMicrotask(() => {
                        if (active) {
                            tick++;
                            cb();
                            next();
                        }
                    });
                next();
                return () => {
                    active = false;
                };
            },
            sdk: { getInventory: () => items, getEquipment: () => [], getSkill: () => ({ baseLevel: 66, level: 66 }), getSkillXp: () => xp, getState: () => ({ player: { lifeId: 1 }, nearbyLocs: [{ id: 2152, x: 3000, z: 4000 }] }) },
        };
        const stop = () => orbStopRequested('fixture', false, path => path === '.practice/stop-all' && globalStop, '');
        expect(stop()).toBe(false);
        const result = await chargeInventory(s, 'air', 2, 80, stop);
        expect(result.ok).toBe(false);
        expect(result.made).toBe(1);
        expect(words).toBe(4);
        expect(items[0]!.count).toBe(1);
        expect(stop()).toBe(true);
    });

    test('actual paid orb charge loses input ownership without a second cast or cleanup dispatch', async () => {
        const items = [{ id: 567, count: 2 }, { id: 573, count: 0 }, { id: 564, count: 6 }, { id: 556, count: 60 }];
        let xp = 100;
        let words = 0;
        let foreignInputs = 0;
        let tick = 0;
        const foreign = () => {
            foreignInputs++;
            return { success: true };
        };
        const client: any = {
            executeBotAction: (_: unknown) => ({ success: false }),
            isInGame: () => true,
            localPlayer: {},
            toSceneTile: () => ({ x: 1, z: 2 }),
            locSceneInfo: () => ({ shape: 10 }),
            routeToLoc: () => true,
            writeOpcode: () => {},
            out: {
                p2: () => {
                    if (++words % 4 === 0) {
                        items[0]!.count--;
                        items[1]!.count++;
                        items[2]!.count -= 3;
                        items[3]!.count -= 30;
                        xp += 76;
                        client.executeBotAction = foreign;
                    }
                },
            },
        };
        const s: any = {
            client,
            direct: (a: unknown) => client.executeBotAction(a),
            tick: () => tick,
            onTick: (cb: () => void) => {
                let active = true;
                const next = () =>
                    queueMicrotask(() => {
                        if (active) {
                            tick++;
                            cb();
                            next();
                        }
                    });
                next();
                return () => {
                    active = false;
                };
            },
            sdk: { getInventory: () => items, getEquipment: () => [], getSkill: () => ({ baseLevel: 66, level: 66 }), getSkillXp: () => xp, getState: () => ({ player: { lifeId: 1 }, nearbyLocs: [{ id: 2152, x: 3000, z: 4000 }] }) },
        };
        const owner = orbInputOwner(s);
        const r = await chargeInventory(s, 'air', 2, 80, () => !owner.valid(), () => owner.scoped(() => installSpellLocBridge(client)));
        expect(r.ok).toBe(false);
        expect(r.made).toBe(1);
        expect(words).toBe(4);
        expect(owner.valid()).toBe(false);
        expect(client.executeBotAction).toBe(foreign);
        expect(foreignInputs).toBe(0);
        if (owner.valid()) await s.direct({ type: 'closeModal' });
        expect(foreignInputs).toBe(0);
    });
});

describe('magic:orb-trip', () => {
    test('four native obelisks have exact source-map coordinates and bank families', () => {
        expect(orbSites).toEqual({ air: { x: 3088, z: 3569 }, earth: { x: 3086, z: 9932 }, water: { x: 2844, z: 3422 }, fire: { x: 2819, z: 9828 } });
        expect(orbHome('water')).toEqual({ x: 2945, z: 3369 });
        expect(orbHome('air')).toEqual({ x: 3185, z: 3436 });
    });

    test('orb batches require finite pack space and multiple refills', () => {
        expect(orbTripBudget(3, 2, 2000)).toBe(2);
        expect(() => orbTripBudget(1, 13, 2000)).toThrow();
        expect(() => orbTripBudget(Infinity, 1, 2000)).toThrow();
    });

    test('native floor trapdoor emits imported OPLOC1 only from observed exact tile and restores executor', () => {
        const words: any[] = [];
        const original = (a: any) => a.type;
        const c: any = { executeBotAction: original, isInGame: () => true, localPlayer: { routeX: [4], routeZ: [4] }, toSceneTile: (_x: number, z: number) => ({ x: 4, z: z === 3468 ? 5 : 4 }), locSceneInfo: () => ({ shape: 22 }), writeOpcode: (n: number) => words.push(n), out: { p2: (n: number) => words.push(n) } };
        const restore = installOrbFloorBridge(c, { x: 3097, z: 3467 });
        expect(c.executeBotAction({ type: 'closeModal' })).toBe('closeModal');
        expect(c.executeBotAction({ type: 'orbFloorLoc', x: 3097, z: 3468, locId: 1568 })).toEqual({ success: true });
        expect(words).toEqual([10, 3097, 3468, 1568]);
        c.localPlayer.routeX[0] = 3;
        expect(() => c.executeBotAction({ type: 'orbFloorLoc', x: 3097, z: 3468, locId: 1568 })).toThrow('exact tile');
        restore();
        expect(c.executeBotAction).toBe(original);
    });

    test('unreachable Fire midpoint rejects before movement; source corridor corner is reachable', () => {
        expect(orbPlanEndsAt({ x: 2895, z: 9792 }, { x: 2850, z: 9800 }, [{ x: 2853, z: 9802 }], 1)).toBe(false);
        expect(orbPlanEndsAt({ x: 2895, z: 9792 }, { x: 2850, z: 9809 }, [{ x: 2850, z: 9809 }], 1)).toBe(true);
        expect(orbPlanEndsAt({ x: 2850, z: 9809 }, { x: 2850, z: 9809 }, [], 0)).toBe(true);
    });

    test('water obelisk uses native two-square diagonal footprint rather than anchor tolerance', () => {
        expect(orbInteractions.water).toMatchObject({ shape: 11, angle: 1, width: 2, height: 2 });
        expect(orbInteractions.fire).toMatchObject({ shape: 11, angle: 3, width: 2, height: 2 });
        expect(orbPlanEndsAt({ x: 2841, z: 3424 }, { x: 2844, z: 3424 }, [{ x: 2844, z: 3424 }], 0)).toBe(true);
    });

    test('orb donor options are explicit finite native choices and preserve default homes', () => {
        expect(orbOptions({})).toEqual({});
        expect(orbHome('air', 'glory')).toEqual({ x: 3094, z: 3491 });
        expect(orbHome('fire')).toEqual({ x: 2945, z: 3369 });
        expect(orbOptions({ ORB_STAFF: 'owned', ORB_RETURN: 'glory', ORB_ENERGY_ID: '3008', ORB_ENERGY_DOSES: '2', ORB_ENERGY_BELOW: '50' })).toEqual({ staff: 'owned', returnMode: 'glory', energy: { id: 3008, maximumDoses: 2, below: 50 } });
        for (const o of [{ returnMode: 'ferox' }, { energy: { id: 12625, maximumDoses: 1, below: 50 } }, { energy: { id: 3008, maximumDoses: 0, below: 50 } }, { staff: -1 }]) {
            expect(() => validateOrbOptions(o as any)).toThrow();
        }
        expect(() => orbOptions({ ORB_ENERGY_DOSES: '2' })).toThrow();
    });

    test('owned staff selector uses native rune substitution and exact declared ownership', () => {
        const stock = [{ id: 1205, count: 1 }, { id: 1381, count: 1 }, { id: 1383, count: 1 }];
        expect(ownedOrbStaff(stock, 556, 'owned')).toBe(1381);
        expect(ownedOrbStaff(stock, 555, 'owned')).toBe(1383);
        expect(ownedOrbStaff(stock, 556, 1383)).toBeUndefined();
        expect(ownedOrbStaff([{ id: 1381, count: 0 }], 556, 'owned')).toBeUndefined();
        expect(ORB_GLORY.find(g => g.id === 1712)).toMatchObject({ charges: 4, nextId: 1710 });
        expect(ORB_GLORY.find(g => g.id === 1706)?.nextId).toBe(1704);
    });

    test('staff equip observes real worn receipt after SDK closes bank and preserves owned count', async () => {
        let open = true;
        let held = true;
        let worn = false;
        const s: any = {
            sdk: { getInventory: () => (held ? [{ id: 1381, count: 1, slot: 0 }] : []), getEquipment: () => (worn ? [{ id: 1381, count: 1, slot: 3 }] : []), getState: () => ({ bank: { isOpen: open } }) },
            bankObservation: () => (open ? { items: [], generation: 1 } : null),
            bot: {
                equipItem: async () => {
                    open = false;
                    held = false;
                    worn = true;
                },
            },
        };
        await equipOrbStaff(s, 1381, () => true);
        expect(open).toBe(false);
        expect(worn).toBe(true);
        expect(s.bankObservation()).toBeNull();
    });

    function orbOptionSession() {
        let queuedClose = false;
        let pendingRub = false;
        let potionDelayed = false;
        let tailDue = -1;
        let tailText = '';
        const messages: any[] = [{ type: 0, text: 'You have 3 doses of potion left.', tick: 0, observationId: 1 }];
        const events: { action: string; tick: number }[] = [];
        let tick = 0;
        const magic = 0;
        let dialog: any = { isOpen: false, isWaiting: false, options: [] };
        let player: any = { worldX: 3088, worldZ: 3569, level: 0, lifeId: 1, runEnergy: 40 };
        const stock: Record<number, number> = { 3008: 1, 1712: 1, 2357: 1, 995: 15 };
        const callbacks = new Set<() => void>();
        const actions: any[] = [];
        const inv = () => Object.entries(stock).filter(([, count]) => count > 0).map(([id, count], slot) => ({ id: Number(id), count, slot }));
        const s: any = {
            tick: () => tick,
            onTick: (f: () => void) => {
                callbacks.add(f);
                return () => callbacks.delete(f);
            },
            sdk: {
                getState: () => ({ player, inventory: inv(), gameMessages: messages, dialog, bank: { isOpen: false }, interface: { isOpen: false } }),
                getInventory: inv,
                getSkillXp: () => magic,
                getDialog: () => dialog,
                sendCloseModal: async () => {
                    events.push({ action: 'close', tick });
                    queuedClose = true;
                    return { success: true };
                },
                sendClickDialog: async (i: number) => {
                    expect(i).toBe(4);
                    stock[1712]!--;
                    stock[1710] = (stock[1710] ?? 0) + 1;
                    player = { ...player, worldX: 3087, worldZ: 3496 };
                    dialog = { isOpen: false, isWaiting: false, options: [] };
                    return { success: true };
                },
                sendUseItem: async (slot: number) => {
                    const row = inv().find(i => i.slot === slot)!;
                    actions.push(['sip', row.id]);
                    stock[row.id]!--;
                    const r = ORB_ENERGY.find(e => e.id === row.id)!;
                    stock[r.next] = (stock[r.next] ?? 0) + 1;
                    player = { ...player, runEnergy: Math.min(100, player.runEnergy + r.gain) };
                    potionDelayed = true;
                    tailDue = tick + 2;
                    const left = r.doses - 1;
                    tailText = left === 0 ? 'You have finished your potion.' : `You have ${left} dose${left === 1 ? '' : 's'} of potion left.`;
                    return { success: true };
                },
                sendInteractLoc: async () => ({ success: !potionDelayed }),
            },
            direct: async (a: any) => {
                events.push({ action: 'rub', tick });
                actions.push(a);
                expect(a.type).toBe('useInventoryItem');
                expect(a.optionIndex).toBe(4);
                pendingRub = true;
                return { success: true };
            },
        };
        const timer = setInterval(() => {
            tick++;
            if (potionDelayed && tick >= tailDue) {
                messages.push({ type: 0, text: tailText, tick, observationId: messages.length + 1 });
                potionDelayed = false;
            }
            if (pendingRub) {
                dialog = { isOpen: true, isWaiting: false, options: [{ index: 4, text: 'Edgeville.' }] };
                pendingRub = false;
            }
            if (queuedClose) {
                dialog = { isOpen: false, isWaiting: false, options: [] };
                queuedClose = false;
            }
            for (const f of callbacks) f();
        }, 1);
        return {
            s,
            stock,
            actions,
            events,
            timer,
            setEnergy: (n: number) => {
                player.runEnergy = n;
            },
            setSip: (f: any) => {
                s.sdk.sendUseItem = f;
            },
            setClick: (f: any) => {
                s.sdk.sendClickDialog = f;
            },
        };
    }

    test('actual energy consumer proves native dose chain plus restoration and refuses unnecessary full-energy debit', async () => {
        const f = orbOptionSession();
        try {
            expect(await drinkOrbEnergy(f.s, 3008, () => true)).toEqual({ 3008: -1, 3010: 1 });
            expect(f.s.sdk.getState().player.runEnergy).toBe(50);
            expect((await f.s.sdk.sendInteractLoc()).success).toBe(true);
            expect(f.s.tick()).toBeGreaterThanOrEqual(2);
            expect(f.stock[2357]).toBe(1);
            expect(f.stock[995]).toBe(15);
            f.setEnergy(100);
            await expect(drinkOrbEnergy(f.s, 3010, () => true)).rejects.toThrow('state absent');
            expect(f.actions).toHaveLength(1);
        } finally {
            clearInterval(f.timer);
        }
    });

    test('energy debit without native restoration fails exact consumer receipt', async () => {
        const f = orbOptionSession();
        try {
            f.setSip(async () => {
                f.stock[3008]!--;
                f.stock[3010] = 1;
                return { success: true };
            });
            await expect(drinkOrbEnergy(f.s, 3008, () => true)).rejects.toThrow('receipt unconfirmed');
        } finally {
            clearInterval(f.timer);
        }
    });

    test('Glory waits for deferred native CLOSE_MODAL before actual core Rub/dialogue and exact charge/landing', async () => {
        const f = orbOptionSession();
        try {
            expect(await returnOrbGlory(f.s, () => true)).toEqual({ 1712: -1, 1710: 1 });
            expect(f.actions).toHaveLength(1);
            expect(f.stock[995]).toBe(15);
            expect(f.stock[2357]).toBe(1);
            expect(f.s.sdk.getState().player.worldX).toBe(3087);
            expect(f.events.find(e => e.action === 'rub')!.tick).toBeGreaterThan(f.events.find(e => e.action === 'close')!.tick);
            expect(await returnOrbGlory(f.s, () => true)).toEqual({});
            expect(f.actions).toHaveLength(1);
        } finally {
            clearInterval(f.timer);
        }
    });

    test('Glory landing without exact charge or with foreign assets cannot pass', () => {
        expect(orbPackEffect({ 1712: 1, 995: 15 }, { 1710: 1, 995: 15 }, { 1712: -1, 1710: 1 })).toBe(true);
        expect(orbPackEffect({ 1712: 1, 995: 15 }, { 1710: 1, 995: 14 }, { 1712: -1, 1710: 1 })).toBe(false);
        expect(orbPackEffect({ 1712: 1 }, { 1712: 1 }, { 1712: -1, 1710: 1 })).toBe(false);
    });

    test('actual Glory consumer refuses landing with an unconfirmed native charge without a second dispatch', async () => {
        const f = orbOptionSession();
        try {
            f.setClick(async () => {
                f.s.sdk.getState = () => ({ player: { worldX: 3087, worldZ: 3496, level: 0 }, inventory: [], dialog: { isOpen: false, isWaiting: false, options: [] }, bank: { isOpen: false }, interface: { isOpen: false } });
                return { success: true };
            });
            await expect(returnOrbGlory(f.s, () => true)).rejects.toThrow('charge/landing receipt');
            expect(f.actions).toHaveLength(1);
            expect(f.stock[1712]).toBe(1);
            expect(f.stock[1710] ?? 0).toBe(0);
        } finally {
            clearInterval(f.timer);
        }
    });

    test('energy exact debit and restored energy cannot use stale system or player-chat completion', async () => {
        const f = orbOptionSession();
        try {
            const state = f.s.sdk.getState;
            f.s.sdk.getState = () => ({ ...state(), gameMessages: [...state().gameMessages, { type: 2, text: 'You have 3 doses of potion left.', tick: 3, observationId: 999 }] });
            f.setSip(async () => {
                f.stock[3008]!--;
                f.stock[3010] = 1;
                f.setEnergy(50);
                return { success: true };
            });
            await expect(drinkOrbEnergy(f.s, 3008, () => true)).rejects.toThrow('receipt unconfirmed');
        } finally {
            clearInterval(f.timer);
        }
    });

    const detectionPolicy = { radius: 14, unknownAppearance: 'escape' as const };
    const detectionOwn = { worldX: 3088, worldZ: 3571, level: 0, combatLevel: 100 };
    const detectionPeer = { kind: 'player' as const, index: 3, name: 'OwnedPeer', combatLevel: 100, x: 3089, z: 3571, distance: 1 };

    test('orb Wilderness classification uses both native combat ranges and observed air-staff exclusion', () => {
        expect(classifyOrbPeer(detectionOwn, detectionPeer, [], detectionPolicy)).toBe('danger');
        for (const id of [1381, 1397, 1405]) expect(classifyOrbPeer(detectionOwn, detectionPeer, [id], detectionPolicy)).toBe('air-staff');
        expect(classifyOrbPeer(detectionOwn, { ...detectionPeer, combatLevel: 108 }, [], detectionPolicy)).toBe('ignore');
        expect(classifyOrbPeer(detectionOwn, { ...detectionPeer, combatLevel: 102, z: 3520 }, [], detectionPolicy)).toBe('ignore');
        expect(classifyOrbPeer({ ...detectionOwn, worldZ: 3436 }, detectionPeer, [], detectionPolicy)).toBe('ignore');
        expect(classifyOrbPeer(detectionOwn, detectionPeer, undefined, detectionPolicy)).toBe('unknown');
        expect(classifyOrbPeer(detectionOwn, detectionPeer, undefined, { ...detectionPolicy, unknownAppearance: 'ignore' })).toBe('ignore');
    });

    test('public appearance equipment requires received ready identity and decodes native IDs rather than kit models', () => {
        const appearance = new Uint16Array(12);
        appearance[3] = 512 + 1381;
        appearance[4] = 256 + 18;
        const player = { name: 'OwnedPeer', ready: true, combatLevel: 100, appearance };
        const c: any = { players: { 3: player } };
        expect(orbPeerEquipment(c, detectionPeer)).toEqual([1381]);
        player.ready = false;
        expect(orbPeerEquipment(c, detectionPeer)).toBeUndefined();
        player.ready = true;
        player.name = 'Replacement';
        expect(orbPeerEquipment(c, detectionPeer)).toBeUndefined();
    });

    test('same-session detector latches after observed dangerous arrival and never clears on later loss of visibility', () => {
        const state: any = { player: { ...detectionOwn, worldZ: 3436 }, nearbyPlayers: [detectionPeer] };
        const s: any = { name: 'actor', tick: () => 9, client: { players: { 3: { ready: true, name: 'OwnedPeer', combatLevel: 100, appearance: new Uint16Array(12) } } }, sdk: { getState: () => state, getStateAge: () => 0 } };
        const monitor = orbPlayerDetection(s, detectionPolicy);
        expect(monitor.check()).toBe(false);
        state.player.worldZ = 3571;
        expect(monitor.check()).toBe(true);
        expect(monitor.trigger).toMatchObject({ index: 3, name: 'OwnedPeer', reason: 'danger', publicEquipment: [] });
        state.nearbyPlayers = [];
        state.player.worldZ = 3436;
        expect(monitor.check()).toBe(true);
    });

    test('orb player options are opt-in and reject unknown policies before gameplay', () => {
        expect(orbOptions({})).toEqual({});
        expect(orbOptions({ ORB_PLAYER_DETECTION: '1' })).toEqual({ playerDetection: { radius: 14, unknownAppearance: 'escape' } });
        expect(() => orbOptions({ ORB_PLAYER_UNKNOWN: 'ignore' })).toThrow('need');
        expect(() => validateOrbOptions({ playerDetection: { radius: 15, unknownAppearance: 'escape' } })).toThrow('policy');
    });

    test('scoped orb floor owner never adopts a foreign executor or restores over its replacement', () => {
        const original = () => ({ success: true });
        const foreign = () => ({ success: true });
        const client: any = { executeBotAction: original, isInGame: () => true, localPlayer: { routeX: [0], routeZ: [0] }, toSceneTile: () => ({ x: 0, z: 0 }), locSceneInfo: () => ({ shape: 22 }), writeOpcode: () => {}, out: { p2: () => {} } };
        const s: any = { client };
        const owner = orbInputOwner(s);
        const restore = owner.scoped(() => installOrbFloorBridge(client, { x: 3097, z: 3468 }));
        expect(owner.valid()).toBe(true);
        client.executeBotAction = foreign;
        expect(owner.valid()).toBe(false);
        restore();
        expect(client.executeBotAction).toBe(foreign);
        expect(() =>
            owner.scoped(() => {
                throw Error('must not install');
            }),
        ).toThrow('owner replaced');
        client.executeBotAction = original;
        expect(owner.valid()).toBe(false);
    });

    test('scoped orb bridge restoration returns only its own exact executor and rejects client replacement', () => {
        const original = () => ({ success: true });
        const client: any = { executeBotAction: original };
        const s: any = { client };
        const owner = orbInputOwner(s);
        const restore = owner.scoped(() => {
            const bridge = () => ({ success: true });
            client.executeBotAction = bridge;
            return () => {
                if (client.executeBotAction === bridge) client.executeBotAction = original;
            };
        });
        expect(owner.valid()).toBe(true);
        restore();
        expect(client.executeBotAction).toBe(original);
        expect(owner.valid()).toBe(true);
        s.client = { executeBotAction: original };
        expect(owner.valid()).toBe(false);
    });

    test('actual orb trip stops bank and final control inputs when executor changes during interface settlement', async () => {
        const original = () => ({ success: true });
        const foreign = () => ({ success: true });
        const client: any = { executeBotAction: original };
        const calls: string[] = [];
        const state: any = { player: { worldX: 3185, worldZ: 3436, level: 0, lifeId: 1, respawnCount: 0, isDead: false }, autoRetaliateEnabled: false, prayers: { prayerPoints: 99, activePrayers: {} }, interface: { isOpen: false }, bank: { isOpen: false } };
        const s: any = {
            client,
            ended: new Promise(() => {}),
            tick: () => 0,
            sdk: {
                getState: () => state,
                getSkill: () => ({ level: 99, baseLevel: 99 }),
                getInventory: () => [],
                getEquipment: () => [],
                sendCloseModal: async () => {
                    calls.push('close');
                    client.executeBotAction = foreign;
                },
            },
            bot: {
                openBank: async () => {
                    calls.push('bank');
                    return { success: true };
                },
            },
            direct: async () => {
                calls.push('control');
                return { success: true };
            },
        };
        const result = await runOrbTrips(
            s,
            'air',
            orbRecipes.air,
            async () => {
                calls.push('charge');
                return { ok: true, made: 1, detail: '' };
            },
            { target: 1, batch: 1, cap: 100, stop: () => false },
        );
        expect(result.ok).toBe(false);
        expect(result.inputOwnershipLost).toBe(true);
        expect(result.banked).toBe(false);
        expect(calls).toEqual(['close']);
        expect(client.executeBotAction).toBe(foreign);
    });

    test('real BotActions equip and unequip continuations refuse dispatch after owner replacement during UI dismissal', async () => {
        for (const mode of ['equip', 'unequip']) {
            const client: any = { executeBotAction: () => ({ success: true }) };
            const s: any = { client };
            const owner = orbInputOwner(s);
            const calls: string[] = [];
            const row: any = { id: 1381, name: 'Staff of air', slot: 3, count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] };
            const state: any = { dialog: { isOpen: true, options: [] }, inventory: [row], equipment: [row] };
            s.sdk = {
                getState: () => state,
                getInventory: () => state.inventory,
                getEquipment: () => state.equipment,
                sendClickDialog: async () => {
                    calls.push('dismiss');
                    return { success: true };
                },
                waitForStateChange: async () => {
                    state.dialog.isOpen = false;
                    client.executeBotAction = () => ({ success: true });
                    return state;
                },
                sendUseItem: async () => {
                    calls.push('equip');
                    return { success: true };
                },
                sendUseEquipmentItem: async () => {
                    calls.push('remove');
                    return { success: true };
                },
            };
            const bound = orbOwnedActions(s, owner.valid);
            await expect(mode === 'equip' ? bound.bot.equipItem(row) : bound.bot.unequipItem(row)).rejects.toThrow('input owner absent');
            expect(calls).toEqual(['dismiss']);
            expect(owner.valid()).toBe(false);
        }
    });

    test('real BotActions withdrawal refuses paid dispatch after owner replacement during note-mode synchronization', async () => {
        const client: any = { executeBotAction: () => ({ success: true }) };
        const s: any = { client };
        const owner = orbInputOwner(s);
        const calls: string[] = [];
        const row: any = { id: 567, name: 'Unpowered orb', slot: 0, count: 2 };
        const state: any = { interface: { isOpen: true }, bank: { noteMode: true, items: [row] }, inventory: [] };
        s.sdk = {
            getState: () => state,
            sendClickComponent: async () => {
                calls.push('note-mode');
                return { success: true };
            },
            waitForCondition: async () => {
                state.bank.noteMode = false;
                client.executeBotAction = () => ({ success: true });
                return state;
            },
            sendBankWithdraw: async () => {
                calls.push('withdraw');
                return { success: true };
            },
        };
        await expect(orbOwnedActions(s, owner.valid).bot.withdrawItem(row, 1, { asNote: false })).rejects.toThrow('input owner absent');
        expect(calls).toEqual(['note-mode']);
        expect(owner.valid()).toBe(false);
    });

    test('local SDK receiver also checks a send resumed after an internal connection wait', async () => {
        let owned = true;
        let wire = 0;
        const sdk: any = {
            sendUseItem: async function () {
                await Promise.resolve();
                owned = false;
                return this.sendAction();
            },
            sendAction: function () {
                return this.send();
            },
            send: () => {
                wire++;
                return { success: true };
            },
        };
        const bound = orbOwnedActions({ sdk }, () => owned);
        await expect(bound.sdk.sendUseItem(0, 1)).rejects.toThrow('input owner absent');
        expect(wire).toBe(0);
    });

    function supplyPotionFixture(id: number, mode = 'normal') {
        const families = [[2448, 181, 183, 185], [2434, 139, 141, 143]];
        const family = families.find(f => f.includes(id))!;
        const index = family.indexOf(id);
        const next = family[index + 1] ?? 229;
        const remaining = 3 - index;
        const completion = remaining === 0 ? 'You have finished your potion.' : `You have ${remaining} dose${remaining === 1 ? '' : 's'} of potion left.`;
        const stock: Record<number, number> = { [id]: 1, 995: 37 };
        const messages: any[] = [{ type: 0, text: completion, tick: -1, observationId: 1 }];
        const client: any = { executeBotAction: () => ({ success: true }) };
        const player = { lifeId: 1, respawnCount: 0, isDead: false };
        let tick = 0;
        let calls = 0;
        let prayer = 10;
        const callbacks = new Set<() => void>();
        const actions: any[] = [];
        const events: any[] = [];
        const timer = setInterval(() => {
            tick++;
            if (tick === 2 && mode !== 'stale') {
                messages.push({ type: mode === 'chat' ? 2 : 0, text: completion, tick, observationId: 3 });
                events.push({ kind: 'completion', tick });
            }
            if (tick === 3 && mode === 'owner') client.executeBotAction = () => ({ success: true });
            for (const cb of [...callbacks]) cb();
        }, 4);
        const s: any = {
            client,
            tick: () => tick,
            onTick: (f: () => void) => {
                callbacks.add(f);
                return () => callbacks.delete(f);
            },
            sdk: {
                getStateAge: () => 0,
                getInventory: () => Object.entries(stock).filter(([, n]) => n > 0).map(([key, count], slot) => ({ id: Number(key), count, slot })),
                getState: () => ({ player, prayers: { prayerPoints: prayer }, gameMessages: messages }),
                sendUseItem: async () => {
                    calls++;
                    events.push({ kind: 'sip', tick });
                    stock[id]!--;
                    stock[next] = (stock[next] ?? 0) + 1;
                    if (family[0] === 2434 && mode !== 'no-prayer') prayer = 41;
                    messages.push({ type: 0, text: 'You drink some of your potion.', tick, observationId: 2 });
                    if (mode === 'foreign-stock') stock[995]!++;
                    if (mode === 'lost') throw Error('lost reply after native debit');
                    return { success: true, phase: 'dispatch' };
                },
            },
            direct: async (a: any) => {
                actions.push({ ...a, tick });
                return { success: true };
            },
        };
        return { s, timer, stock, actions, events, calls: () => calls, tick: () => tick, next };
    }

    test('actual orb supply potion waits fresh delayed completion and three ticks before another protected input', async () => {
        for (const id of [2448, 181, 183, 185, 2434, 139, 141, 143]) {
            const f = supplyPotionFixture(id);
            try {
                expect(await drinkOrbSupplyPotion(f.s, id, () => true)).toEqual({ [id]: -1, [f.next]: 1 });
                await f.s.direct({ type: 'togglePrayer', prayerIndex: 14 });
                expect(f.calls()).toBe(1);
                expect(f.actions[0].tick).toBeGreaterThanOrEqual(5);
                expect(f.events.find(e => e.kind === 'completion').tick).toBe(2);
                expect(f.stock[995]).toBe(37);
            } finally {
                clearInterval(f.timer);
            }
        }
    });

    test('orb supply potion unknown completion, missing prayer restoration and foreign stock do not retry', async () => {
        for (const mode of ['stale', 'chat', 'no-prayer', 'foreign-stock']) {
            const f = supplyPotionFixture(mode === 'no-prayer' ? 2434 : 2448, mode);
            try {
                await expect(drinkOrbSupplyPotion(f.s, mode === 'no-prayer' ? 2434 : 2448, () => true)).rejects.toThrow('unconfirmed');
                expect(f.calls()).toBe(1);
                expect(f.actions).toEqual([]);
            } finally {
                clearInterval(f.timer);
            }
        }
    });

    test('orb supply potion reconciles one lost reply but owner replacement during settlement prevents following inputs', async () => {
        const lost = supplyPotionFixture(2448, 'lost');
        try {
            expect(await drinkOrbSupplyPotion(lost.s, 2448, () => true)).toEqual({ 2448: -1, 181: 1 });
            expect(lost.calls()).toBe(1);
        } finally {
            clearInterval(lost.timer);
        }
        const foreign = supplyPotionFixture(2448, 'owner');
        try {
            await expect(drinkOrbSupplyPotion(foreign.s, 2448, () => true)).rejects.toThrow('owner/life/stock');
            expect(foreign.calls()).toBe(1);
            expect(foreign.actions).toEqual([]);
        } finally {
            clearInterval(foreign.timer);
        }
    });
});

describe('magic:bones', () => {
    test('conversion requires every bone, product, rune debit and XP receipt', () => {
        const before = { bones: 4, bananas: 3, earth: 4, water: 4, nature: 2, xp: 100 };
        const after = { bones: 0, bananas: 7, earth: 2, water: 2, nature: 1, xp: 125 };
        expect(bonesEffect(before, after)).toBe(true);
        for (const key of Object.keys(after) as (keyof typeof after)[]) expect(bonesEffect(before, { ...after, [key]: before[key] })).toBe(false);
        expect(bonesEffect({ ...before, bones: 0 }, { ...after, bananas: 3 })).toBe(false);
    });

    function fixture(mode = 'normal') {
        let tick = 0;
        let casts = 0;
        let banked = 0;
        let closed = 0;
        let pack = { bones: 0, bananas: 0, earth: 4, water: 4, nature: 2, xp: 100 };
        const io: BonesIO = {
            tick: () => tick,
            stopped: () => false,
            level: () => 15,
            read: () => ({ ...pack }),
            prepare: async maximum => {
                pack.bones = Math.min(3, maximum);
                return true;
            },
            cast: async () => {
                casts++;
                tick++;
                if (mode === 'normal') pack = { ...pack, bones: 0, bananas: pack.bananas + pack.bones, earth: pack.earth - 2, water: pack.water - 2, nature: pack.nature - 1, xp: pack.xp + 25 };
            },
            wait: async () => {
                tick++;
            },
            deposit: async () => {
                banked += pack.bananas;
                const n = pack.bananas;
                pack.bananas = 0;
                return n;
            },
            close: async () => {
                closed++;
            },
        };
        return { io, counts: () => ({ casts, banked, closed }) };
    }

    test('bounded consumer banks exactly the requested output and stops', async () => {
        const f = fixture();
        const r = await runBonesConversion(f.io, { maximum: 5, cap: 40 });
        expect(r).toMatchObject({ ok: true, made: 5, banked: 5, casts: 2 });
        expect(f.counts()).toEqual({ casts: 2, banked: 5, closed: 1 });
    });

    test('a command reply without a conversion fails without a second spend', async () => {
        const f = fixture('none');
        const r = await runBonesConversion(f.io, { maximum: 5, cap: 40 });
        expect(r.ok).toBe(false);
        expect(f.counts().casts).toBe(1);
        expect(f.counts().closed).toBe(1);
    });

    test('invalid options and missing level refuse all casts', async () => {
        const f = fixture();
        await expect(runBonesConversion(f.io, { maximum: 0, cap: 40 })).rejects.toThrow();
        f.io.level = () => 14;
        expect((await runBonesConversion(f.io, { maximum: 5, cap: 40 })).ok).toBe(false);
        expect(f.counts().casts).toBe(0);
    });

    test('input exhaustion, cancellation and bank mismatch cannot report success', async () => {
        const missing = fixture();
        missing.io.prepare = async () => false;
        expect((await runBonesConversion(missing.io, { maximum: 5, cap: 40 })).ok).toBe(false);
        expect(missing.counts().casts).toBe(0);
        const stopped = fixture();
        stopped.io.stopped = () => true;
        expect((await runBonesConversion(stopped.io, { maximum: 5, cap: 40 })).ok).toBe(false);
        expect(stopped.counts().casts).toBe(0);
        const bank = fixture();
        bank.io.deposit = async () => 0;
        expect((await runBonesConversion(bank.io, { maximum: 5, cap: 40 })).ok).toBe(false);
        expect(bank.counts().casts).toBe(1);
        const cap = fixture();
        cap.io.prepare = async () => {
            cap.io.tick = () => 100;
            return true;
        };
        expect((await runBonesConversion(cap.io, { maximum: 5, cap: 40 })).ok).toBe(false);
        expect(cap.counts().casts).toBe(0);
    });

    test('SDK adapter withdraws finite unnoted inputs and pairs final bank receipts', async () => {
        const ids = { 526: 'Bones', 1963: 'Banana', 557: 'Earth rune', 555: 'Water rune', 561: 'Nature rune' };
        const pack: { id: number; name: string; count: number; slot: number }[] = [];
        const bank = new Map([[526, 7], [557, 4], [555, 4], [561, 2], [1963, 9]]);
        let generation = 1;
        let xp = 100;
        let tick = 0;
        let casts = 0;
        let bankOpen = false;
        let busyUntil = 0;
        const items = () => [...bank].map(([id, count]) => ({ id, name: ids[id as keyof typeof ids]!, count }));
        const add = (id: number, n: number) => {
            const item = pack.find(i => i.id === id);
            if (item) item.count += n;
            else pack.push({ id, name: ids[id as keyof typeof ids]!, count: n, slot: pack.length });
        };
        const s = {
            name: 'mock',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => {
                let active = true;
                const pump = () => {
                    if (active) {
                        tick++;
                        fn();
                        queueMicrotask(pump);
                    }
                };
                queueMicrotask(pump);
                return () => {
                    active = false;
                };
            },
            sdk: { getEquipment: () => [], getInventory: () => pack.filter(i => i.count > 0), getState: () => ({ player: { lifeId: 1, worldX: 0, worldZ: 0, level: 0 }, inventory: pack.filter(i => i.count > 0), bank: { isOpen: bankOpen } }), getSkill: () => ({ level: 15 }), getSkillXp: () => xp },
            bankObservation: () => ({ generation, items: items() }),
            bot: {
                openBank: async () => {
                    if (tick < busyUntil) return { success: false };
                    bankOpen = true;
                    generation++;
                    return { success: true };
                },
                closeBank: async () => {
                    bankOpen = false;
                },
                withdrawItem: async (pattern: RegExp, n: number, o: { asNote: boolean }) => {
                    expect(o.asNote).toBe(false);
                    const entry = items().find(i => pattern.test(i.name));
                    if (!entry || entry.count < n) return { success: false };
                    bank.set(entry.id, entry.count - n);
                    add(entry.id, n);
                    generation++;
                    return { success: true };
                },
                depositItem: async (item: { id: number }) => {
                    const p = pack.find(i => i.id === item.id)!;
                    bank.set(p.id, (bank.get(p.id) ?? 0) + p.count);
                    p.count = 0;
                    generation++;
                    return { success: true };
                },
            },
            direct: async () => {
                casts++;
                tick++;
                const bones = pack.find(i => i.id === 526)!;
                add(1963, bones.count);
                bones.count = 0;
                for (const [id, n] of [[557, 2], [555, 2], [561, 1]]) pack.find(i => i.id === id)!.count -= n!;
                xp += 25;
                busyUntil = tick + 3;
                return { success: true };
            },
        };
        const result = await runBonesBank(s as any, { maximum: 5, cap: 40 });
        expect(result).toMatchObject({ ok: true, made: 5, banked: 5, casts: 1 });
        expect(casts).toBe(1);
        expect(bank.get(1963)).toBe(14);
        expect(bank.get(526)).toBe(2);
    });

    test('staff receipts require exactly the substituted native rune costs', () => {
        const before = { bones: 2, bananas: 0, earth: 0, water: 2, nature: 1, xp: 100 };
        const after = { bones: 0, bananas: 2, earth: 0, water: 0, nature: 0, xp: 125 };
        expect(bonesEffect(before, after, { earth: 0, water: 2, nature: 1 })).toBe(true);
        expect(bonesEffect(before, after)).toBe(false);
    });

    for (const stopAt of ['open', 'withdraw'] as const) {
        test('bones preparation stops after an awaited bank ' + stopAt, async () => {
            const player = { lifeId: 1, respawnCount: 0 };
            const names = new Map([[526, 'Bones'], [557, 'Earth rune'], [555, 'Water rune'], [561, 'Nature rune']]);
            const stock = new Map([[526, 5], [557, 2], [555, 2], [561, 1]]);
            const pack: { id: number; name: string; count: number; slot: number }[] = [];
            const inputs: string[] = [];
            let stopped = false;
            let bankOpen = false;
            let generation = 0;
            const items = () => [...stock].map(([id, count]) => ({ id, count, name: names.get(id)! }));
            const s: any = {
                name: 'Owned',
                tick: () => 0,
                ended: new Promise(() => {}),
                onTick: () => () => {},
                sdk: { getEquipment: () => [], getInventory: () => pack, getSkill: () => ({ level: 15 }), getSkillXp: () => 0, getState: () => ({ player, inventory: pack, bank: { isOpen: bankOpen }, interface: { isOpen: false }, dialog: { isOpen: false } }) },
                bankObservation: () => ({ generation, items: items() }),
                bot: {
                    openBank: async () => {
                        inputs.push('open');
                        bankOpen = true;
                        generation++;
                        await Promise.resolve();
                        if (stopAt === 'open') stopped = true;
                        return { success: true };
                    },
                    withdrawItem: async (pattern: RegExp, count: number) => {
                        const item = items().find(i => pattern.test(i.name))!;
                        inputs.push('withdraw:' + item.id);
                        stock.set(item.id, stock.get(item.id)! - count);
                        pack.push({ id: item.id, count, slot: pack.length, name: item.name });
                        generation++;
                        await Promise.resolve();
                        if (stopAt === 'withdraw') stopped = true;
                        return { success: true };
                    },
                    closeBank: async () => {
                        inputs.push('close');
                        bankOpen = false;
                    },
                },
                direct: async () => {
                    inputs.push('cast');
                    return { success: true };
                },
            };
            const result = await runBonesBank(s, { maximum: 5, cap: 40, stop: () => stopped });
            expect(result).toMatchObject({ ok: false, made: 0, banked: 0, casts: 0, failure: 'bones conversion session stopped' });
            expect(inputs).toEqual(stopAt === 'open' ? ['open'] : ['open', 'withdraw:557']);
            for (const [id, initial] of [[526, 5], [557, 2], [555, 2], [561, 1]]) expect((stock.get(id!) ?? 0) + pack.filter(i => i.id === id).reduce((n, i) => n + i.count, 0)).toBe(initial!);
        });
    }

    test('bones adapter retains converted output when stopped during deposit bank open', async () => {
        const names = new Map([[526, 'Bones'], [1963, 'Banana'], [557, 'Earth rune'], [555, 'Water rune'], [561, 'Nature rune']]);
        const pack = [[526, 3], [557, 2], [555, 2], [561, 1]].map(([id, count], slot) => ({ id: id!, count: count!, slot, name: names.get(id!)! }));
        const stock = new Map([[1963, 9]]);
        const inputs: string[] = [];
        let stopped = false;
        let bankOpen = false;
        let generation = 0;
        let opens = 0;
        let xp = 100;
        let tick = 0;
        const inventory = () => pack.filter(i => i.count > 0);
        const items = () => [...stock].map(([id, count]) => ({ id, count, name: names.get(id)! }));
        const s: any = {
            name: 'Owned',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => {
                let active = true;
                const pump = () => {
                    if (active) {
                        tick++;
                        fn();
                        queueMicrotask(pump);
                    }
                };
                queueMicrotask(pump);
                return () => {
                    active = false;
                };
            },
            sdk: { getEquipment: () => [], getInventory: inventory, getSkill: () => ({ level: 15 }), getSkillXp: () => xp, getState: () => ({ player: { lifeId: 1, respawnCount: 0 }, inventory: inventory(), bank: { isOpen: bankOpen }, interface: { isOpen: false }, dialog: { isOpen: false } }) },
            bankObservation: () => ({ generation, items: items() }),
            bot: {
                openBank: async () => {
                    inputs.push('open');
                    opens++;
                    bankOpen = true;
                    generation++;
                    await Promise.resolve();
                    if (opens === 2) stopped = true;
                    return { success: true };
                },
                closeBank: async () => {
                    inputs.push('close');
                    bankOpen = false;
                },
                depositItem: async (item: { id: number }) => {
                    inputs.push('deposit');
                    const p = pack.find(i => i.id === item.id)!;
                    stock.set(p.id, (stock.get(p.id) ?? 0) + p.count);
                    p.count = 0;
                    generation++;
                    return { success: true };
                },
            },
            direct: async () => {
                inputs.push('cast');
                const bones = pack.find(i => i.id === 526)!;
                pack.push({ id: 1963, count: bones.count, slot: pack.length, name: names.get(1963)! });
                bones.count = 0;
                for (const [id, n] of [[557, 2], [555, 2], [561, 1]]) pack.find(i => i.id === id)!.count -= n!;
                xp += 25;
                return { success: true };
            },
        };
        const result = await runBonesBank(s, { maximum: 3, cap: 40, stop: () => stopped });
        expect(result).toMatchObject({ ok: false, made: 3, banked: 0, casts: 1, failure: 'bones conversion session stopped' });
        expect(inputs).toEqual(['open', 'close', 'cast', 'open']);
        expect(inventory()).toEqual([{ id: 1963, count: 3, slot: 4, name: 'Banana' }]);
        expect(stock.get(1963)).toBe(9);
    });

    test('final bones deposit cannot turn an expired budget or cancellation into success', async () => {
        const cap = fixture();
        cap.io.deposit = async () => {
            cap.io.tick = () => 100;
            return 3;
        };
        expect((await runBonesConversion(cap.io, { maximum: 3, cap: 40 })).ok).toBe(false);
        const stopped = fixture();
        stopped.io.deposit = async () => {
            stopped.io.stopped = () => true;
            return 3;
        };
        expect((await runBonesConversion(stopped.io, { maximum: 3, cap: 40 })).ok).toBe(false);
    });
});

describe('magic:earth-production', () => {
    test('death during approach returns uncredited and selects fresh goblins without extending the no-progress bound', async () => {
        const world = spyOn(coreBot, 'getWorld').mockResolvedValue({} as any);
        const account = spyOn(coreBot, 'accountOf').mockReturnValue({ skills: {} } as any);
        const travel = spyOn(walking, 'goTo').mockResolvedValue({ ok: true } as any);
        try {
            for (const fresh of [true, false]) {
                let tick = 0;
                let generation = 0;
                let stopped = false;
                const callbacks = new Set<() => void>();
                const client = {};
                const pack: any[] = [];
                const stock = [{ id: 995, count: 352310 }, { id: 554, count: 1482 }, { id: 557, count: 26 }, { id: 1440, count: 1 }, { id: 1891, count: 8 }].map(i => ({ ...i, name: String(i.id) }));
                const equipment = [1277, 1171, 1115].map(id => ({ id, count: 1 }));
                setEquipmentObserved(client, true);
                const npc = (index: number) => ({ id: 100, index, hp: 5, inCombat: false, reachable: true, x: 3255, z: 3226, distance: 3 });
                const state = { revision: 0, player: { worldX: 3255, worldZ: 3226, level: 0, combat: { inCombat: false, targetType: 'none', targetIndex: -1 } }, nearbyNpcs: [npc(2888)], inventory: pack, groundItems: [], combatEvents: [] as any[], bank: { isOpen: false, items: stock }, combatStyle: { currentStyle: 0 }, autoRetaliateEnabled: false };
                const selected: { index: number; tick: number }[] = [];
                const xp = 82100;
                const s: any = {
                    client,
                    name: 'fltargetloss',
                    tick: () => tick,
                    ended: new Promise(() => {}),
                    onTick: (cb: () => void) => {
                        callbacks.add(cb);
                        return () => callbacks.delete(cb);
                    },
                    bankObservation: () => (state.bank.isOpen ? { generation, items: stock } : null),
                    sdk: {
                        getState: () => state,
                        getInventory: () => pack,
                        getEquipment: () => equipment,
                        getSkillXp: () => xp,
                        getSkill: () => ({ level: 52, baseLevel: 49 }),
                        sendSetCombatStyle: async (n: number) => {
                            state.combatStyle.currentStyle = n;
                            return { success: true };
                        },
                    },
                    bot: {
                        dismissBlockingUI: async () => {},
                        openBank: async () => {
                            state.bank.isOpen = true;
                            generation++;
                            return { success: true };
                        },
                        closeBank: async () => {
                            state.bank.isOpen = false;
                        },
                        withdrawItem: async (item: any, n: number) => {
                            item.count -= n;
                            generation++;
                            pack.push({ id: item.id, name: item.name, count: n });
                            return { success: true };
                        },
                        depositItem: async (item: any) => {
                            stock.find(i => i.id === item.id)!.count += item.count;
                            pack.splice(pack.indexOf(item), 1);
                            generation++;
                            return { success: true };
                        },
                        attack: async (n: any) => {
                            selected.push({ index: n.index, tick });
                            if (fresh && selected.length === 2) {
                                stopped = true;
                                return { success: false, reason: 'out_of_reach', message: 'Cannot reach Goblin' };
                            }
                            await waitTicks(s, 3);
                            state.nearbyNpcs[0]!.hp = 0;
                            state.combatEvents = [{ tick, observationId: state.revision, type: 'damage_taken', sourceType: 'other_player', targetType: 'npc', targetIndex: n.index, damage: 5 }];
                            await waitTicks(s, 2);
                            state.nearbyNpcs = [];
                            await waitTicks(s, 4);
                            state.nearbyNpcs = [npc(n.index + 1)];
                            return { success: false, reason: 'timeout', message: 'Failed to interact with NPC: target_not_found' };
                        },
                    },
                };
                const timer = setInterval(() => {
                    tick++;
                    state.revision++;
                    for (const cb of callbacks) cb();
                }, 1);
                try {
                    const result = await runEarthProduction(s, { mode: 'talismans', cap: 20000, target: 1139, reserve: 30000, stop: () => stopped });
                    expect(result.kills).toBe(0);
                    expect(xp).toBe(82100);
                    expect(result.ok).toBe(false);
                    expect(selected[0]!.index).toBe(2888);
                    expect(selected[1]!.index).toBe(2889);
                    expect(selected[1]!.tick - selected[0]!.tick).toBe(9);
                    if (!fresh) {
                        expect(result.failure).toBe('Error: earth hunt no kill progress');
                        expect(result.ticks).toBeGreaterThan(240);
                        expect(result.ticks).toBeLessThan(260);
                        expect(result.conserved).toBe(true);
                    }
                    expect(callbacks.size).toBe(0);
                } finally {
                    clearInterval(timer);
                }
            }
        } finally {
            travel.mockRestore();
            account.mockRestore();
            world.mockRestore();
        }
    }, 10000);

    test('Earth cleanup banks eight nonstackable cakes and the remaining kit once per current item ID', async () => {
        let pack = [...Array.from({ length: 8 }, (_, slot) => ({ id: 1891, name: 'Cake', count: 1, slot })), { id: 1277, name: 'Bronze sword', count: 1, slot: 8 }, { id: 1277, name: 'Bronze sword', count: 1, slot: 9 }];
        let generation = 9;
        let checks = 0;
        const bank = [{ id: 1891, name: 'Cake', count: 0 }, { id: 1277, name: 'Bronze sword', count: 3 }];
        const calls: number[] = [];
        const receipts: any[] = [];
        const s: any = {
            name: 'fixture',
            tick: () => 1,
            sdk: { getInventory: () => pack, getState: () => ({ inventory: pack }) },
            bankObservation: () => ({ generation, at: 1, items: bank }),
            bot: {
                depositItem: async (item: any, amount: number) => {
                    expect(pack.find(i => i.id === item.id)).toBe(item);
                    expect(amount).toBe(-1);
                    calls.push(item.id);
                    bank.find(i => i.id === item.id)!.count += pack.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0);
                    pack = pack.filter(i => i.id !== item.id).map((i, slot) => ({ ...i, slot }));
                    generation++;
                    return { success: true };
                },
            },
        };
        const log = spyOn(console, 'log').mockImplementation(line => {
            if (String(line).startsWith('DEPOSIT_RECEIPT ')) receipts.push(JSON.parse(String(line).slice('DEPOSIT_RECEIPT '.length)));
        });
        try {
            await depositEarthInventory(s, () => {
                checks++;
            });
            expect(pack).toEqual([]);
            expect(calls).toEqual([1891, 1277]);
            expect(checks).toBe(2);
            expect(bank.map(i => i.count)).toEqual([8, 5]);
            expect(receipts.map(r => ({ id: r.itemId, amount: r.amount, packAfter: r.packAfter, bankBefore: r.bankBefore, bankAfter: r.bankAfter, generationBefore: r.generationBefore, generationAfter: r.generationAfter }))).toEqual([
                { id: 1891, amount: 8, packAfter: 0, bankBefore: 0, bankAfter: 8, generationBefore: 9, generationAfter: 10 },
                { id: 1277, amount: 2, packAfter: 0, bankBefore: 3, bankAfter: 5, generationBefore: 10, generationAfter: 11 },
            ]);
            await depositEarthInventory(s, () => {
                checks++;
            });
            expect(calls).toEqual([1891, 1277]);
            expect(checks).toBe(2);
        } finally {
            log.mockRestore();
        }
    });

    test('a level-one order buys only the air unlock, then switches to earth and bounds its last batch', () => {
        expect(productionBatch(1, 0, 1137, 625)).toEqual({ rune: 556, talisman: 1438, essence: 7, multiple: 1 });
        expect(productionBatch(9, 875, 1137, 618).rune).toBe(557);
        expect(productionBatch(26, 10000, 3, 100).essence).toBe(2);
        expect(productionBatch(52, 100000, 1, 100).essence).toBe(1);
        expect(productionBatch(52, 100000, 0, 100).essence).toBe(0);
    });

    test('a mid-fight food action re-engages the same observed target within one fight budget', async () => {
        let tick = 0;
        let food = 0;
        const xp = 0;
        let attacks = 0;
        const callbacks = new Set<() => void>();
        const npc = { id: 1, index: 7, hp: 7 };
        let alive = true;
        const s = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            sdk: { getSkillXp: () => xp, getState: () => ({ nearbyNpcs: alive ? [npc] : [] }) },
            bot: {
                attack: async (n: any) => {
                    expect(n.index).toBe(7);
                    attacks++;
                    return { success: true };
                },
            },
        } as any;
        let xpCur = 0;
        s.sdk.getSkillXp = () => xpCur;
        const timer = setInterval(() => {
            tick++;
            if (tick === 3) food++;
            if (attacks >= 2 && tick >= 5) {
                xpCur = 700;
                alive = false;
            }
            for (const cb of callbacks) cb();
        }, 1);
        try {
            await huntFight(s, npc, () => false, () => food);
            expect(attacks).toBe(2);
            expect(tick).toBeLessThan(100);
        } finally {
            clearInterval(timer);
        }
    });

    test('unknown XP and initial or repeated attack refusals remain explicit failures', async () => {
        for (const scenario of ['unknown-xp', 'missing-final-xp', 'initial-refusal', 'repeated-refusal']) {
            let tick = 0;
            let xp: number | undefined = scenario === 'unknown-xp' ? undefined : 82100;
            let attacks = 0;
            let alive = true;
            const npc = { id: 100, index: 2888, hp: 5 };
            const callbacks = new Set<() => void>();
            const state = () => ({ revision: tick, nearbyNpcs: alive ? [npc] : [], combatEvents: [] });
            const s: any = {
                tick: () => tick,
                onTick: (cb: () => void) => {
                    callbacks.add(cb);
                    return () => callbacks.delete(cb);
                },
                sdk: { getState: state, getSkillXp: () => xp },
                bot: {
                    attack: async () => {
                        attacks++;
                        if (scenario === 'missing-final-xp') {
                            npc.hp = 0;
                            for (const cb of callbacks) cb();
                            alive = false;
                            xp = undefined;
                            return { success: false, reason: 'timeout', message: 'Failed to interact with NPC: target_not_found' };
                        }
                        if (scenario === 'repeated-refusal' && attacks === 1) return { success: true };
                        return { success: false, reason: 'out_of_reach', message: 'Cannot reach Goblin' };
                    },
                },
            };
            const timer = setInterval(() => {
                tick++;
                for (const cb of callbacks) cb();
            }, 1);
            try {
                await expect(huntFight(s, npc, () => false, () => tick)).rejects.toThrow(scenario === 'unknown-xp' ? 'earth hunt strength XP unknown' : 'earth hunt attack refused');
                expect(attacks).toBe(scenario === 'unknown-xp' ? 0 : scenario === 'repeated-refusal' ? 2 : 1);
                expect(callbacks.size).toBe(0);
            } finally {
                clearInterval(timer);
            }
        }
    });

    test.each([
        ['npc_not_found', 'published'],
        ['npc_not_found', 'delayed'],
        ['npc_not_found', 'absent'],
        ['timeout', 'published'],
        ['timeout', 'delayed'],
        ['timeout', 'absent'],
    ])('an engaged %s retry settles %s own XP within the original fight deadline', async (reason, timing) => {
        let tick = 0;
        let xp = 82100;
        let attacks = 0;
        let alive = true;
        let settled = false;
        const npc = { id: 100, index: 2888, hp: 5 };
        const callbacks = new Set<() => void>();
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            sdk: { getSkillXp: () => xp, getState: () => ({ revision: tick, nearbyNpcs: alive ? [npc] : [], combatEvents: [] }) },
            bot: {
                attack: async (target: any) => {
                    expect(target.index).toBe(npc.index);
                    attacks++;
                    if (attacks === 1) return { success: true };
                    expect(tick).toBe(16);
                    await waitTicks(s, 4);
                    alive = false;
                    if (timing === 'published') xp += 700;
                    return { success: false, reason, message: 'Failed to interact with NPC: target_not_found' };
                },
            },
        };
        const timer = setInterval(() => {
            tick++;
            if (tick === 23 && timing === 'delayed') xp += 700;
            if (tick === 22 && timing === 'delayed') expect(settled).toBe(false);
            for (const cb of callbacks) cb();
        }, 1);
        try {
            const fight = huntFight(s, npc, () => false, () => 0).then(result => {
                settled = true;
                return result;
            });
            if (timing === 'absent') {
                await expect(fight).rejects.toThrow('earth hunt fight credit deadline');
                expect(tick).toBe(100);
                expect(xp).toBe(82100);
            } else {
                expect(await fight).toBe('credited');
                expect(xp).toBe(82800);
                expect(tick).toBe(timing === 'published' ? 21 : 23);
            }
            expect(attacks).toBe(2);
            expect(callbacks.size).toBe(0);
        } finally {
            clearInterval(timer);
        }
    }, 10000);

    test('unknown inputs never dispatch crafting or authorize an unsupported hunt', () => {
        for (const n of [-1, NaN, Infinity, 1.2]) expect(() => productionBatch(9, 875, n, 100)).toThrow();
        expect(talismanTarget(1440)).toEqual({ id: 1440, npcIds: [1, 2, 3, 4, 5, 6], spot: { x: 3221, z: 3219 } });
        expect(talismanTarget(1438).npcIds).toEqual([100]);
        expect(() => talismanTarget(557)).toThrow();
    });

    test('a talisman published after the NPC death delay is collected before leaving the kill', async () => {
        let tick = 0;
        let picked = 0;
        const callbacks = new Set<() => void>();
        const pack: any[] = [];
        const ground: any[] = [];
        const s = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            sdk: { getInventory: () => pack, getState: () => ({ groundItems: ground }) },
            bot: {
                pickupItem: async () => {
                    picked++;
                    pack.push({ id: 1440, count: 1 });
                    return { success: true };
                },
            },
        } as any;
        const timer = setInterval(() => {
            tick++;
            if (tick === 4) ground.push({ id: 1440, count: 1, distance: 1 });
            for (const cb of callbacks) cb();
        }, 1);
        try {
            expect(await collectHuntLoot(s, () => false, true)).toEqual({ id: 1440, count: 1 });
            expect(picked).toBe(1);
        } finally {
            clearInterval(timer);
        }
    });

    test('conservation binds essence debit, crafted output and food-stage transformations', () => {
        const before = new Map([[995, 352310], [554, 1482], [557, 2], [1436, 20], [1891, 1], [1438, 1], [1440, 1]]);
        const after = new Map([[995, 352310], [554, 1482], [557, 22], [1436, 10], [1893, 1], [1438, 1], [1440, 1]]);
        const ledger = { consumed: 10, crafted: 20, air: 0, eaten: { 1891: 1 } };
        expect(productionConserved(before, after, ledger)).toBe(true);
        expect(productionConserved(before, new Map(after).set(995, 352309), ledger)).toBe(false);
        expect(productionConserved(before, new Map(after).set(554, 1481), ledger)).toBe(false);
        expect(productionConserved(before, new Map(after).set(557, 21), ledger)).toBe(false);
        expect(productionConserved(before, new Map(after).set(1436, 9), ledger)).toBe(false);
        expect(productionConserved(before, new Map(after).set(1893, 0), ledger)).toBe(false);
    });

    test('equipping closes the bank, so every missing kit item must be withdrawn first', async () => {
        let open = true;
        const pack = new Set<number>();
        const worn = new Set<number>();
        await stageOwnedEquipment(
            [1277, 1171, 1115],
            () => [...worn],
            async id => {
                if (!open) throw Error('bank closed before kit withdrawal');
                pack.add(id);
            },
            async () => {
                open = false;
            },
            async id => {
                open = false;
                if (!pack.has(id)) throw Error('kit item missing');
                pack.delete(id);
                worn.add(id);
            },
        );
        expect([...worn]).toEqual([1277, 1171, 1115]);
        expect(pack.size).toBe(0);
    });
});
