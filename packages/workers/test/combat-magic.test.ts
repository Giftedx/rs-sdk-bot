import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadPathfinding } from '../../core/src/pathcache';
import { waitUntil } from '../../core/src/ticks';
import { xpForLevel } from '../../planner/src/curve';
import { CollisionType } from '../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { initPathfinding, isTileWalkable } from '../../../vendor/rs-sdk/sdk/pathfinding';
import * as rsmod from '../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import {
    validatePreflightResult,
    validateRateEstimate,
    validateRunOutcome,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import {
    AIR,
    BODY,
    CAST_RANGE,
    COMBAT_SITES,
    EARTH,
    MIND,
    QUIET_STOP,
    SPLASH_SITES,
    SPLASH_SPELLS,
    SPLASH_TILE,
    WATER,
    bankedSplashSpells,
    castReaches,
    combatEstimate,
    combatMagicRecipe,
    combatPreflight,
    combatWorkerModule,
    freeRunesFromEquipment,
    incomingFarmerProfile,
    magicStopRequested,
    nativeNpcSpell,
    npcCastEffect,
    packSpell,
    pickSplashTarget,
    prepareSplashStaffAtBank,
    runCombatModuleSession,
    runNpcMagic,
    runSplash,
    selectMagicTarget,
    splashBatchDone,
    splashDebuffSpells,
    splashPlan,
    splashSite,
    splashSpell,
    withCombatPrayer,
    withIncomingProtection,
    type CombatSession,
} from '../src/combat';

const SPLASH_TO = 66;
const SPLASH_KIT = { 'body rune': 150, 'earth rune': 425, 'water rune': 300 } as const;

beforeAll(async () => {
    await loadPathfinding();
}, 120_000);

// --- NPC magic tests ---

test('native standard strike/bolt/blast/wave and six debuffs resolve exact costs', () => {
    for (const el of ['wind', 'water', 'earth', 'fire']) {
        for (const tier of ['strike', 'bolt', 'blast', 'wave']) {
            expect(nativeNpcSpell(el + '_' + tier).level).toBeGreaterThan(0);
        }
    }
    for (const name of ['confuse', 'weaken', 'curse', 'vulnerability', 'enfeeble', 'stun', 'bind', 'snare', 'entangle']) {
        expect(nativeNpcSpell(name).debuff).toBe(true);
    }
    expect(nativeNpcSpell('stun').runes[566]).toBe(1);
    expect(() => nativeNpcSpell('ice_barrage')).toThrow();
});

test('NPC magic exact rune debit and XP receipt rejects unexplained input loss', () => {
    const costs = { 555: 3, 557: 2, 566: 1 };
    const b = { 555: 6, 557: 4, 566: 2, 995: 99 };
    const a = { 555: 3, 557: 2, 566: 1, 995: 99 };
    expect(npcCastEffect(costs, b, a, 0, 90)).toBe('cast');
    expect(npcCastEffect(costs, b, b, 0, 0)).toBe('none');
    expect(npcCastEffect(costs, b, { ...a, 995: 98 }, 0, 90)).toBe('invalid');
    expect(npcCastEffect(costs, b, a, 0, 0)).toBe('invalid');
});

test('NPC selection excludes exhausted and foreign targets, permits own combat', () => {
    const n: any = { id: 1, index: 3, hp: 3, inCombat: false, reachable: true, distance: 1, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] };
    expect(selectMagicTarget([n], 1, new Set(), 2)?.index).toBe(3);
    expect(selectMagicTarget([n], 1, new Set([3]), 2)).toBeUndefined();
    expect(selectMagicTarget([{ ...n, inCombat: true, targetIndex: 32770 }], 1, new Set(), 2)?.index).toBe(3);
    expect(selectMagicTarget([{ ...n, inCombat: true, targetIndex: 32771 }], 1, new Set(), 2)).toBeUndefined();
});

test('NPC magic rejects an unbounded request before reading session', async () => {
    await expect(runNpcMagic({} as any, nativeNpcSpell('stun'), { npc: 1, casts: 1001, cap: 20 })).rejects.toThrow('invalid');
});

test('NPC staged runner executes debit, XP and serial alch combo with finite completion', async () => {
    const spell = nativeNpcSpell('confuse');
    let tick = 0;
    let xp = 0;
    const calls: string[] = [];
    const combo = combatMagicRecipe('high-alch', 'bronze_dagger');
    const stock: Record<number, number> = {};
    for (const [id, n] of [...Object.entries(spell.runes), ...Object.entries(combo.inputs)]) {
        stock[Number(id)] = (stock[Number(id)] ?? 0) + n;
    }
    const inventory = () => Object.entries(stock).filter(([, n]) => n > 0).map(([id, count], slot) => ({ id: Number(id), count, slot }));
    const p = { worldX: 3200, worldZ: 3200, lifeId: 1, level: 0, isDead: false };
    const target: any = { id: 1, index: 2, hp: 3, inCombat: false, reachable: true, distance: 1, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] };
    const listeners = new Set<() => void>();
    const s: any = {
        tick: () => tick,
        ended: new Promise(() => {}),
        client: { selfSlot: 3, var: Array(109).fill(0) },
        onTick: (f: () => void) => {
            listeners.add(f);
            return () => listeners.delete(f);
        },
        sdk: {
            getState: () => ({ player: p, inventory: inventory(), equipment: [], nearbyNpcs: [target] }),
            getInventory: inventory,
            getEquipment: () => [],
            getSkillXp: (name: string) => (name === 'Magic' ? xp : 0),
            getSkill: () => ({ level: 99 }),
        },
        bot: { dismissBlockingUI: async () => {} },
        direct: async (a: any) => {
            calls.push(a.type);
            const costs = a.type === 'spellOnNpc' ? spell.runes : combo.inputs;
            for (const [id, n] of Object.entries(costs)) stock[Number(id)]! -= n;
            if (a.type === 'spellOnItem') stock[combo.product] = (stock[combo.product] ?? 0) + combo.output;
            xp += 50;
            return { success: true };
        },
    };
    const timer = setInterval(() => {
        tick++;
        for (const f of listeners) f();
    }, 1);
    try {
        const r = await runNpcMagic(s, spell, { npc: 1, casts: 1, cap: 100, combo });
        expect(r.ok).toBe(true);
        expect(r.combos).toBe(1);
        expect(calls).toEqual(['spellOnNpc', 'spellOnItem']);
    } finally {
        clearInterval(timer);
    }
});

test('finite NPC magic refuses native repeating autocast or unknown mode before any action', async () => {
    let actions = 0;
    const vars = Array(109).fill(0);
    vars[108] = 3;
    const s: any = { client: { selfSlot: 3, var: vars }, sdk: { getState: () => ({ player: { lifeId: 1 } }), getSkill: () => ({ level: 99 }) }, direct: async () => { actions++; } };
    await expect(runNpcMagic(s, nativeNpcSpell('wind_strike'), { npc: 1, casts: 1, cap: 100 })).rejects.toThrow('disable native autocast');
    expect(actions).toBe(0);
    delete s.client.var;
    await expect(runNpcMagic(s, nativeNpcSpell('wind_strike'), { npc: 1, casts: 1, cap: 100 })).rejects.toThrow('autocast mode unknown');
    expect(actions).toBe(0);
});

test('all thirty real player spells resolve exact native component, level, membership, costs and worn item', () => {
    const names = [
        ...['wind', 'water', 'earth', 'fire'].flatMap(e => ['strike', 'bolt', 'blast', 'wave'].map(t => e + '_' + t)),
        ...['confuse', 'weaken', 'curse', 'vulnerability', 'enfeeble', 'stun', 'bind', 'snare', 'entangle', 'crumble_undead', 'saradomin_strike', 'claws_of_guthix', 'flames_of_zamorak', 'iban_blast'],
    ];
    expect(names).toHaveLength(30);
    const db = readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/configs/magic/magic_combat_spells.dbrow', 'utf8');
    const items = new Map(
        readFileSync('vendor/rs-sdk/server/content/pack/obj.pack', 'utf8')
            .split(/\r?\n/)
            .flatMap(l => {
                const m = l.match(/^(\d+)=(.+)$/);
                return m ? ([[m[2]!, Number(m[1])] as const]) : [];
            }),
    );
    for (const name of names) {
        const spell = nativeNpcSpell(name);
        const body = db.split('[magic_spell_' + name + ']')[1]!.split('\n[')[0]!;
        const field = (key: string) => body.match(new RegExp('^data=' + key + ',(.+)$', 'm'))?.[1]?.trim();
        const runes = field('runesrequired')!.split(',');
        const expected: Record<number, number> = {};
        for (let i = 0; i < runes.length; i += 2) if (runes[i] !== 'null') expected[items.get(runes[i]!)!] = Number(runes[i + 1]);
        expect(spell.component).toBe(field('spellcom')!);
        expect(spell.level).toBe(Number(field('levelrequired')));
        expect(spell.members).toBe(field('members') === 'true');
        expect(spell.runes).toEqual(expected);
        expect(spell.requiredWorn).toBe(field('wornrequired') ? items.get(field('wornrequired')!) : undefined);
    }
    expect(nativeNpcSpell('crumble_undead')).toMatchObject({ level: 39, members: false, runes: { 562: 1, 556: 2, 557: 2 } });
    for (const [name, id] of [['saradomin_strike', 2415], ['claws_of_guthix', 2416], ['flames_of_zamorak', 2417], ['iban_blast', 1409]] as const) {
        expect(nativeNpcSpell(name).requiredWorn).toBe(id);
    }
    for (const name of ['skeleton_mage', 'skeleton_mage_attack', 'nezikchened', 'saradomin_strike_npc', 'claws_of_guthix_npc', 'flames_of_zamorak_npc', 'ice_barrage']) {
        expect(() => nativeNpcSpell(name)).toThrow('unsupported');
    }
});

test('required staves and member scope reject before any UI or paid spell action', async () => {
    let actions = 0;
    const s: any = {
        sdk: {
            getEquipment: () => [{ slot: 3, id: 1381 }],
            getState: () => {
                actions++;
                throw Error('should not inspect player');
            },
        },
        bot: {
            dismissBlockingUI: async () => {
                actions++;
            },
        },
        direct: async () => {
            actions++;
        },
    };
    for (const name of ['saradomin_strike', 'claws_of_guthix', 'flames_of_zamorak', 'iban_blast']) {
        const spell = nativeNpcSpell(name);
        await expect(runNpcMagic(s, spell, { npc: 1, casts: 1, cap: 30, members: true })).rejects.toThrow('requires worn staff');
        await expect(runNpcMagic({} as any, spell, { npc: 1, casts: 1, cap: 30 })).rejects.toThrow('member NPC spell');
    }
    s.sdk.getEquipment = () => [{ slot: 0, id: 1409 }];
    await expect(runNpcMagic(s, nativeNpcSpell('iban_blast'), { npc: 1, casts: 1, cap: 30, members: true })).rejects.toThrow('requires worn staff');
    expect(actions).toBe(0);
});

test('shared CLI global stop prevents a paid staged NPC cast', async () => {
    let actions = 0;
    const s: any = {
        tick: () => 0,
        ended: new Promise(() => {}),
        client: { selfSlot: 1, var: Array(109).fill(0) },
        sdk: {
            getInventory: () => [],
            getEquipment: () => [],
            getSkill: () => ({ level: 99 }),
            getSkillXp: () => 0,
            getState: () => ({ player: { lifeId: 1, level: 0, worldX: 3197, worldZ: 3353 }, nearbyNpcs: [] }),
        },
        direct: async () => {
            actions++;
            return { success: true };
        },
    };
    const stop = () => magicStopRequested('owned', false, path => path === '.practice/stop-all', '');
    const r = await runNpcMagic(s, nativeNpcSpell('wind_strike'), { npc: 41, casts: 1, cap: 50, stop });
    expect(r.ok).toBe(false);
    expect(r.casts).toBe(0);
    expect(actions).toBe(0);
});

async function hpFloorFixture(floor: number | undefined, change: 'hit' | 'below' | 'life' | 'respawn' | 'move' = 'hit') {
    let tick = 0;
    let xp = 0;
    let hp = 99;
    let actions = 0;
    let done = false;
    const listeners = new Set<() => void>();
    const player = { lifeId: 1, respawnCount: 0, isDead: false, level: 0, worldX: 3197, worldZ: 3353 };
    const inventory = [{ id: 556, count: 10 }, { id: 558, count: 10 }];
    const s: any = {
        client: { selfSlot: 1, var: Array(109).fill(0) },
        ended: new Promise(() => {}),
        tick: () => tick,
        onTick: (f: () => void) => {
            listeners.add(f);
            return () => listeners.delete(f);
        },
        bot: { dismissBlockingUI: async () => {} },
        sdk: {
            getState: () => ({ player, nearbyNpcs: [{ id: 41, index: 7, hp: 10, reachable: true, inCombat: false, distance: 1, optionsWithIndex: [{ text: 'Attack' }] }] }),
            getInventory: () => inventory,
            getEquipment: () => [],
            getSkill: (name: string) => ({ level: name === 'Hitpoints' ? hp : 99 }),
            getSkillXp: (name: string) => (name === 'Magic' ? xp : 0),
        },
        direct: async () => {
            actions++;
            inventory.forEach(i => i.count--);
            xp += 5;
            if (actions === 1) {
                if (change === 'hit') hp = 95;
                if (change === 'below') hp = 89;
                if (change === 'life') player.lifeId = 2;
                if (change === 'respawn') player.respawnCount = 1;
                if (change === 'move') player.worldX += 11;
            }
            return { success: true };
        },
    };
    const pending = runNpcMagic(s, nativeNpcSpell('wind_strike'), { npc: 41, casts: 2, cap: 80, ...(floor === undefined ? {} : { hpFloor: floor }) }).then(r => {
        done = true;
        return r;
    });
    for (let n = 0; n < 85 && !done; n++) {
        tick++;
        for (const f of [...listeners]) f();
        for (let k = 0; k < 12; k++) await Promise.resolve();
    }
    return { result: await pending, actions };
}

test('NPC magic keeps strict initial HP by default and permits only a declared bounded floor', async () => {
    const strict = await hpFloorFixture(undefined);
    expect(strict.result.ok).toBe(false);
    expect(strict.actions).toBe(1);
    const bounded = await hpFloorFixture(90);
    expect(bounded.result.ok).toBe(true);
    expect(bounded.actions).toBe(2);
    const below = await hpFloorFixture(90, 'below');
    expect(below.result.ok).toBe(false);
    expect(below.actions).toBe(1);
});

test('scalar initial life, respawn and position prevent a second paid action after mutable cached state changes', async () => {
    for (const change of ['life', 'respawn', 'move'] as const) {
        const r = await hpFloorFixture(90, change);
        expect(r.result.ok).toBe(false);
        expect(r.actions).toBe(1);
    }
});

test('declared HP floor rejects unknown, fractional, too low and above initial HP before paid input', async () => {
    for (const floor of [NaN, 9, 90.5, 100]) {
        await expect(hpFloorFixture(floor)).rejects.toThrow('HP floor');
    }
});

test('explicit environmental ledger reconciles only actual stock outside rune cost and preserves default exactness', () => {
    const costs = { 556: 1, 558: 1 };
    const b = { 556: 5, 558: 5, 379: 8 };
    const rot = { 556: 5, 558: 5, 379: 7, 2959: 1 };
    const paid = { 556: 4, 558: 4, 379: 7, 2959: 1 };
    const env = { 379: -1, 2959: 1 };
    expect(npcCastEffect(costs, b, rot, 0, 0, env)).toBe('none');
    expect(npcCastEffect(costs, b, paid, 0, 5, env)).toBe('cast');
    expect(npcCastEffect(costs, b, paid, 0, 5)).toBe('invalid');
    expect(npcCastEffect(costs, b, { ...paid, 995: 1 }, 0, 5, env)).toBe('invalid');
    expect(npcCastEffect(costs, b, paid, 0, 5, { ...env, 556: -1 })).toBe('invalid');
    expect(npcCastEffect(costs, b, rot, 0, 5, env)).toBe('invalid');
});

async function environmentFixture(paid: boolean) {
    let tick = 0;
    let xp = 0;
    let actions = 0;
    let known = 0;
    const listeners = new Set<() => void>();
    const inventory: any[] = [{ id: 556, count: 5 }, { id: 558, count: 5 }, { id: 379, count: 8 }];
    const player = { lifeId: 1, respawnCount: 0, isDead: false, level: 0, worldX: 3200, worldZ: 3200 };
    const s: any = {
        client: { selfSlot: 1, var: Array(109).fill(0) },
        ended: new Promise(() => {}),
        tick: () => tick,
        onTick: (f: () => void) => {
            listeners.add(f);
            return () => listeners.delete(f);
        },
        bot: { dismissBlockingUI: async () => {} },
        sdk: {
            getState: () => ({ player, nearbyNpcs: [{ id: 41, index: 7, hp: 10, reachable: true, inCombat: false, distance: 1, optionsWithIndex: [{ text: 'Attack' }] }] }),
            getInventory: () => inventory,
            getEquipment: () => [],
            getSkill: () => ({ level: 99 }),
            getSkillXp: (name: string) => (name === 'Magic' ? xp : 0),
        },
        direct: async () => {
            actions++;
            inventory[2].count--;
            inventory.push({ id: 2959, count: 1 });
            known++;
            return { success: true };
        },
    };
    let done = false;
    const pending = runNpcMagic(s, nativeNpcSpell('wind_strike'), {
        npc: 41,
        casts: 1,
        cap: 50,
        environmentDelta: (): Record<number, number> => (known ? { 379: -known, 2959: known } : {}),
    }).then(r => {
        done = true;
        return r;
    });
    for (let n = 0; n < 55 && !done; n++) {
        tick++;
        if (paid && tick === 4) {
            inventory[0].count--;
            inventory[1].count--;
            xp = 5;
        }
        for (const cb of [...listeners]) cb();
        for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    return { r: await pending, actions };
}

test('actual NPC consumer waits through environmental-only publication for one original cast, never redispatches if absent', async () => {
    const paid = await environmentFixture(true);
    expect(paid.r.ok).toBe(true);
    expect(paid.actions).toBe(1);
    expect(paid.r.environmentReceipts[0]?.delta).toEqual({ 379: -1, 2959: 1 });
    const missing = await environmentFixture(false);
    expect(missing.r.ok).toBe(false);
    expect(missing.actions).toBe(1);
    expect(missing.r.failure).toContain('no repeated input');
});

test('passive continuation option leaves strict defaults and all foreign/dead/reach filters intact', () => {
    const n: any = { id: 132, index: 2003, hp: 6, inCombat: true, targetIndex: -1, reachable: true, distance: 1, optionsWithIndex: [{ text: 'Attack' }] };
    expect(selectMagicTarget([n], 132, new Set(), 1)).toBeUndefined();
    expect(selectMagicTarget([n], 132, new Set(), 1, () => true)).toBe(n);
    for (const bad of [{ ...n, targetIndex: 32770 }, { ...n, hp: 0 }, { ...n, reachable: false }, { ...n, id: 128 }]) {
        expect(selectMagicTarget([bad], 132, new Set(), 1, () => true)).toBeUndefined();
    }
    expect(selectMagicTarget([n], 132, new Set([2003]), 1, () => true)).toBeUndefined();
});

// --- Splash training tests ---

test('a level casts the best stat spell it has, and Wind Strike under Confuse', () => {
    expect(splashSpell(1).component).toBe('magic:wind_strike');
    expect(splashSpell(3).component).toBe('magic:confuse');
    expect(splashSpell(11).component).toBe('magic:weaken');
    expect(splashSpell(18).component).toBe('magic:weaken');
    expect(splashSpell(19).component).toBe('magic:curse');
    expect(splashSpell(99).component).toBe('magic:curse');
    expect(SPLASH_SPELLS.map(s => [s.level, s.xp])).toEqual([[19, 725], [11, 525], [3, 325], [1, 137]]);
});

test('the plan counts casts spell by spell up this server level curve, and their runes', () => {
    expect(splashPlan(xpForLevel(21), 66)).toEqual({ casts: 135, runes: { [BODY]: 135, [WATER]: 270, [EARTH]: 405, [MIND]: 0, [AIR]: 0 } });
    const fresh = splashPlan(0, 66);
    expect(fresh.casts).toBe(144);
    expect(fresh.runes).toEqual({ [BODY]: 142, [WATER]: 290, [EARTH]: 420, [MIND]: 2, [AIR]: 2 });
    expect(splashPlan(xpForLevel(66) - 725, 66).casts).toBe(1);
    expect(splashPlan(xpForLevel(66), 66)).toEqual({ casts: 0, runes: { [BODY]: 0, [WATER]: 0, [EARTH]: 0, [MIND]: 0, [AIR]: 0 } });
});

test('splash kit covers the plan from every level under the target', () => {
    for (let from = 1; from < SPLASH_TO; from++) {
        for (const past of [0, 100, 300]) {
            const { runes } = splashPlan(xpForLevel(from) + past, SPLASH_TO);
            expect(runes[BODY]!).toBeLessThanOrEqual(SPLASH_KIT['body rune']);
            expect(runes[WATER]!).toBeLessThanOrEqual(SPLASH_KIT['water rune']);
            expect(runes[EARTH]!).toBeLessThanOrEqual(SPLASH_KIT['earth rune']);
            expect(runes[MIND]!).toBeLessThanOrEqual(2);
        }
    }
});

test('no cow can stand beside the fence tile, and a cast from it reaches the field', () => {
    initPathfinding();
    const key = (x: number, z: number) => `${x},${z}`;
    const seen = new Set([key(2660, 3344)]);
    const queue: [number, number][] = [[2660, 3344]];
    while (queue.length) {
        const [x, z] = queue.shift()!;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 2640 || nx > 2690 || nz < 3325 || nz > 3370 || seen.has(key(nx, nz)) || !rsmod.canTravel(0, x, z, dx, dz, 2, 0, CollisionType.NORMAL)) continue;
            seen.add(key(nx, nz));
            queue.push([nx, nz]);
        }
    }
    const cows = [...seen].map(k => k.split(',').map(Number) as [number, number]);
    expect(cows.length).toBeGreaterThan(300);
    const gap = (sw: [number, number]) => Math.max(sw[0] - SPLASH_TILE.x, SPLASH_TILE.x - (sw[0] + 1), sw[1] - SPLASH_TILE.z, SPLASH_TILE.z - (sw[1] + 1), 0);
    expect(Math.min(...cows.map(gap))).toBe(2);
    const spawns: [number, number][] = [[2657, 3341], [2658, 3351], [2660, 3344], [2664, 3341], [2664, 3348], [2664, 3352], [2666, 3344], [2670, 3348], [2671, 3342], [2672, 3354]];
    expect(spawns.filter(([x, z]) => castReaches(SPLASH_TILE, { x, z })).length).toBeGreaterThanOrEqual(6);
    expect(castReaches(SPLASH_TILE, { x: 2664, z: 3341 })).toBe(true);
    expect(castReaches(SPLASH_TILE, { x: 2664, z: SPLASH_TILE.z + CAST_RANGE + 1 })).toBe(false);
});

test('a run that gained a level and then ran out of runes, ticks or cows is a finished batch, not a failed band', () => {
    for (const stop of ['supplies', 'cap', QUIET_STOP]) {
        expect(splashBatchDone(stop, 1)).toBe(true);
        expect(splashBatchDone(stop, 0)).toBe(false);
    }
    expect(QUIET_STOP).toBe('no cast in 300 ticks');
    for (const stop of ['lost hitpoints at the fence (98 of 99)', 'stopped', 'session ended', '']) {
        expect(splashBatchDone(stop, 5)).toBe(false);
    }
});

test('the coop site casts from the starter pack: the best spell the pack pays for, then Wind Strike', () => {
    const starter = [{ id: AIR, count: 25 }, { id: MIND, count: 15 }, { id: WATER, count: 6 }, { id: EARTH, count: 4 }, { id: BODY, count: 2 }];
    expect(packSpell(1, starter).component).toBe('magic:wind_strike');
    expect(packSpell(3, starter).component).toBe('magic:confuse');
    expect(packSpell(3, starter.filter(i => i.id !== BODY)).component).toBe('magic:wind_strike');
    expect(packSpell(3, []).component).toBe('magic:confuse');
    expect(splashSite().bank).toBe(true);
    expect(splashSite('coop')).toMatchObject({ bank: false, size: 1, hpFloor: 5 });
    expect(splashSite('coop').target({ id: 41, name: 'Chicken' })).toBe(true);
    expect(splashSite('coop').target({ id: 81, name: 'Cow' })).toBe(false);
    expect(() => splashSite('varrock')).toThrow('SPLASH_SITE');
});

test('pickSplashTarget falls back to Weaken and Confuse when Curse is on cooldown for all cows in reach', () => {
    const runes = [{ id: BODY, count: 10 }, { id: WATER, count: 30 }, { id: EARTH, count: 30 }];
    const spells = splashDebuffSpells(65, runes);
    expect(spells.map(s => s.component)).toEqual(['magic:curse', 'magic:weaken', 'magic:confuse']);
    const cows = [{ index: 1, distance: 3 }, { index: 2, distance: 5 }];
    const rest = new Map<string, number>();
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[0]!, spell: spells[0]! });
    rest.set('1:magic:curse', 120);
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[1]!, spell: spells[0]! });
    rest.set('2:magic:curse', 120);
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[0]!, spell: spells[1]! });
    rest.set('1:magic:weaken', 120);
    rest.set('2:magic:weaken', 120);
    expect(pickSplashTarget(cows, spells, rest, 100)).toEqual({ target: cows[0]!, spell: spells[2]! });
});

test('the coop tile is open floor that sees most of the coop within reach', () => {
    initPathfinding();
    const { tile } = SPLASH_SITES.coop!;
    expect(isTileWalkable(0, tile.x, tile.z)).toBe(true);
    let seen = 0;
    let open = 0;
    for (let x = 3223; x <= 3236; x++) {
        for (let z = 3293; z <= 3303; z++) {
            if (!isTileWalkable(0, x, z)) continue;
            open++;
            if (castReaches(tile, { x, z }, CAST_RANGE, 1)) seen++;
        }
    }
    expect(seen).toBeGreaterThanOrEqual(100);
    expect(seen).toBeLessThanOrEqual(open);
});

test('elemental staff in slot 3 eliminates its rune from splashPlan and splashDebuffSpells', () => {
    const free = freeRunesFromEquipment([{ id: 1385, slot: 3 }]);
    expect([...free]).toEqual([EARTH]);
    expect(splashPlan(xpForLevel(21), 66, free)).toEqual({
        casts: 135,
        runes: { [BODY]: 135, [WATER]: 270, [EARTH]: 0, [MIND]: 0, [AIR]: 0 },
    });
    expect(splashDebuffSpells(21, [{ id: BODY, count: 1 }, { id: WATER, count: 2 }], free).map(s => s.component)).toEqual(['magic:curse']);
});

test('prepareSplashStaffAtBank equips best covering bank staff or buys Staff of earth from Zaff', async () => {
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    let tick = 0;
    const inv: any[] = [];
    const eq: any[] = [];
    const bank: any[] = [{ id: 995, name: 'Coins', count: 2500, slot: 0 }, { id: 1381, name: 'Staff of air', count: 1, slot: 1 }];
    const shopItems = [{ id: 1385, name: 'Staff of earth', count: 2, buyPrice: 1500, slot: 0 }];
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 1);
    const s: any = {
        tick: () => tick,
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({ inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Magic' ? 21 : 1, baseLevel: n === 'Magic' ? 21 : 1 }),
        },
        bot: {
            openBank: async () => {
                bankOpen = true;
                gen++;
                return { success: true };
            },
            closeBank: async () => {
                bankOpen = false;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: item.id, name: item.name, count: n });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                const row = bank.find(r => r.id === removed.id);
                if (row) row.count += removed.count;
                else bank.push({ ...removed });
                gen++;
                return { success: true };
            },
            equipItem: async (item: any) => {
                bankOpen = false;
                const old = eq.splice(0, eq.length);
                for (const o of old) inv.push({ id: o.id, name: o.name, count: o.count });
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                eq.push({ ...removed, slot: 3 });
                return { success: true };
            },
            openShop: async () => {
                shopOpen = true;
                return { success: true };
            },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.id === 1385 ? 'Staff of earth' : 'Item', count: n });
                return { success: true };
            },
            closeShop: async () => {
                shopOpen = false;
                return { success: true };
            },
        },
    };
    try {
        const res = await prepareSplashStaffAtBank(s, {
            xp: xpForLevel(21),
            target: 66,
            bankSpot: { x: 3185, z: 3436 },
            allowZaffShop: true,
            stop: () => false,
            walkTo: async spot => {
                walks.push(`${spot.x},${spot.z}`);
                return true;
            },
        });
        expect(res.activeId).toBe(1385);
        expect(res.bought).toBe(1385);
        expect([...res.freeRunes]).toEqual([EARTH]);
        expect(walks).toEqual(['3203,3433', '3185,3436']);
        expect(eq[0]?.id).toBe(1385);
        expect(bank.find(i => i.id === 995)?.count).toBe(1000);
        expect(inv).toHaveLength(0);
    } finally {
        clearInterval(timer);
    }
});

function bankedSplashFixture(magic: number, bank: any[], start = { worldX: 3185, worldZ: 3436 }) {
    let tick = 0;
    let bankOpen = false;
    let shopOpen = false;
    let gen = 1;
    let closedAtBankCount = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const fn of [...listeners]) fn();
    }, 2);
    const player = { ...start, level: 0 };
    const inv: any[] = [];
    const eq: any[] = [];
    const shopItems = [{ id: 1385, name: 'Staff of earth', count: 2, buyPrice: 1500, slot: 0 }];
    const walks: string[] = [];
    const withdraws: { id: number; n: number; worldX: number }[] = [];
    let invAtCombatStart: { id: number; count: number }[] = [];
    let bankAtCombatStart: { id: number; count: number }[] = [];

    const s: any = {
        tick: () => tick,
        ended: new Promise<void>(() => {}),
        onTick: (fn: () => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        direct: async () => ({ success: true }),
        bankObservation: () => (bankOpen ? { generation: gen, items: bank } : null),
        sdk: {
            getState: () => ({
                tick,
                player,
                inventory: inv,
                equipment: eq,
                bank: { isOpen: bankOpen, items: bank },
                shop: { isOpen: shopOpen, shopItems },
                nearbyNpcs: [],
                nearbyLocs: [],
                nearbyPlayers: [],
                gameMessages: [],
            }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => {
                if (n === 'Magic') return { level: magic, baseLevel: magic };
                if (n === 'Hitpoints') return { level: 10, baseLevel: 10 };
                return { level: 1, baseLevel: 1 };
            },
            getSkillXp: (n: string) => (n === 'Magic' ? xpForLevel(magic) : 0),
        },
        bot: {
            openBank: async () => {
                bankOpen = true;
                gen++;
                return { success: true };
            },
            closeBank: async () => {
                bankOpen = false;
                if (player.worldX === 2619 && closedAtBankCount === 0) {
                    closedAtBankCount++;
                    invAtCombatStart = inv.map(i => ({ id: i.id, count: i.count }));
                    bankAtCombatStart = bank.map(i => ({ id: i.id, count: i.count }));
                }
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                withdraws.push({ id: item.id, n, worldX: player.worldX });
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: item.id, name: item.name, count: n, slot: inv.length });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any, n: number) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const cur = inv[idx];
                const amt = n === -1 ? cur.count : n;
                cur.count -= amt;
                if (cur.count <= 0) inv.splice(idx, 1);
                const row = bank.find(r => r.id === item.id);
                if (row) row.count += amt;
                else bank.push({ id: item.id, name: item.name, count: amt, slot: bank.length });
                gen++;
                return { success: true };
            },
            equipItem: async (item: any) => {
                bankOpen = false;
                const old = eq.splice(0, eq.length);
                for (const o of old) inv.push({ id: o.id, name: o.name, count: o.count });
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                eq.push({ ...removed, slot: 3 });
                return { success: true };
            },
            openShop: async () => {
                shopOpen = true;
                return { success: true };
            },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.name, count: n, slot: inv.length });
                return { success: true };
            },
            closeShop: async () => {
                shopOpen = false;
                return { success: true };
            },
        },
    };

    const walkTo = async (spot: { x: number; z: number }) => {
        walks.push(`${spot.x},${spot.z}`);
        player.worldX = spot.x;
        player.worldZ = spot.z;
        return true;
    };
    return { s, eq, bank, walks, withdraws, walkTo, closed: () => closedAtBankCount > 0, atStart: () => ({ inv: invAtCombatStart, bank: bankAtCombatStart }), end: () => clearInterval(timer) };
}

test('runSplash captures east-side start before walking to Ardougne, buys Zaff Staff of earth, equips it, and withdraws 0 Earth runes', async () => {
    const f = bankedSplashFixture(21, [
        { id: 995, name: 'Coins', count: 2500, slot: 0 },
        { id: BODY, name: 'Body rune', count: 135, slot: 1 },
        { id: WATER, name: 'Water rune', count: 270, slot: 2 },
        { id: EARTH, name: 'Earth rune', count: 405, slot: 3 },
    ]);
    try {
        const res = await runSplash(f.s, { target: 66, cap: 500, stop: f.closed, walkTo: f.walkTo });
        expect(res.stop).toBe('stopped');
        expect(f.walks).toEqual(['3203,3433', '3185,3436', '2619,3332']);
        expect(f.eq[0]?.id).toBe(1385);
        expect(f.atStart().inv.find(i => i.id === BODY)?.count).toBe(135);
        expect(f.atStart().inv.find(i => i.id === WATER)?.count).toBe(270);
        expect(f.atStart().inv.find(i => i.id === EARTH)).toBeUndefined();
        expect(f.atStart().bank.find(i => i.id === EARTH)?.count).toBe(405);
        expect(f.withdraws.some(w => w.id === EARTH)).toBe(false);
        expect(f.bank.find(i => i.id === 995)?.count).toBe(1000);
    } finally {
        f.end();
    }
});

test('a banked run under Magic 3 casts Wind Strike with its mind and air runes; with none it stops for supplies', async () => {
    const kit = () => [
        { id: MIND, name: 'Mind rune', count: 2, slot: 0 },
        { id: AIR, name: 'Air rune', count: 2, slot: 1 },
        { id: BODY, name: 'Body rune', count: 10, slot: 2 },
        { id: WATER, name: 'Water rune', count: 30, slot: 3 },
        { id: EARTH, name: 'Earth rune', count: 30, slot: 4 },
    ];
    const f = bankedSplashFixture(1, kit(), { worldX: 2619, worldZ: 3332 });
    try {
        const res = await runSplash(f.s, { target: 66, cap: 500, stop: f.closed, walkTo: f.walkTo });
        expect(f.atStart().inv.find(i => i.id === MIND)?.count).toBe(2);
        expect(f.atStart().inv.find(i => i.id === AIR)?.count).toBe(2);
        expect(res.stop).toBe('stopped');
    } finally {
        f.end();
    }
    const none = bankedSplashFixture(1, kit().filter(i => i.id !== MIND), { worldX: 2619, worldZ: 3332 });
    try {
        expect((await runSplash(none.s, { target: 66, cap: 500, stop: none.closed, walkTo: none.walkTo })).stop).toBe('supplies');
    } finally {
        none.end();
    }
    expect(bankedSplashSpells(1, [{ id: MIND, count: 2 }, { id: AIR, count: 2 }]).map(s => s.component)).toEqual(['magic:wind_strike']);
    expect(bankedSplashSpells(2, [{ id: MIND, count: 1 }])).toEqual([]);
    expect(bankedSplashSpells(3, [{ id: MIND, count: 2 }, { id: AIR, count: 2 }])).toEqual([]);
    expect(bankedSplashSpells(11, [{ id: BODY, count: 1 }, { id: WATER, count: 3 }, { id: EARTH, count: 3 }, { id: MIND, count: 2 }, { id: AIR, count: 2 }]).map(s => s.component)).toEqual([
        'magic:weaken',
        'magic:confuse',
    ]);
});

// --- Prayer flicking and incoming protection tests ---

function prayerFixture() {
    let tick = 0;
    let timer = 0;
    let toggles = 0;
    let lost = false;
    let nativeActive = false;
    let loseFrom = Infinity;
    let workerAttacks = 0;
    let resumes = 0;
    let resumeMode = 'normal';
    const listeners = new Set<() => void>();
    const prayers = { activePrayers: Array(15).fill(false), prayerPoints: 99, prayerLevel: 99 };
    const player = { lifeId: 1, respawnCount: 0, isDead: false, level: 0, combat: { inCombat: false, targetType: 'none', targetIndex: -1 } };
    const npc = { kind: 'npc', index: 7, id: 81, x: 1, z: 1, distance: 1, reachable: true, hp: 8, maxHp: 8, inCombat: false, targetIndex: -1, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] };
    const state = { player, prayers, nearbyPlayers: [] as any[], nearbyNpcs: [npc], combatEvents: [] as any[] };
    const engage = () => {
        player.combat = { inCombat: true, targetType: 'npc', targetIndex: 7 };
        npc.inCombat = true;
        npc.targetIndex = 32769;
    };
    const s: any = {
        name: 'owned',
        client: { selfSlot: 1 },
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        ended: new Promise(() => {}),
        bot: {
            attack: async (n: any) => {
                expect(n.id).toBe(81);
                expect(n.index).toBe(7);
                workerAttacks++;
                engage();
                return { success: true };
            },
        },
        sdk: {
            getState: () => state,
            getPrayerState: () => prayers,
            isPrayerActive: (i: number) => prayers.activePrayers[i],
            getSkill: () => ({ level: 99 }),
            sendInteractNpc: async (index: number, op: number) => {
                expect([index, op]).toEqual([7, 2]);
                resumes++;
                if (resumeMode !== 'unknown') engage();
                return { success: resumeMode === 'normal', message: 'injected lost response' };
            },
            sendTogglePrayer: async (i: number) => {
                toggles++;
                player.combat = { inCombat: false, targetType: 'none', targetIndex: -1 };
                nativeActive = !nativeActive;
                timer = nativeActive ? 5 : 0;
                if (lost || toggles >= loseFrom) return { success: false, message: 'lost response, publication unavailable' };
                prayers.activePrayers[i] = !prayers.activePrayers[i];
                if (prayers.activePrayers[i]) timer = 5;
                else timer = 0;
                return { success: !lost, message: lost ? 'lost response' : 'sent' };
            },
        },
    };
    const step = async () => {
        tick++;
        if (timer > 0 && --timer === 0) {
            if (!lost && toggles < loseFrom) prayers.prayerPoints--;
            timer = 5;
        }
        state.combatEvents = player.combat.targetType === 'npc' && tick % 4 === 0 ? [{ tick, observationId: tick, type: 'damage_dealt', sourceType: 'player', targetType: 'npc', targetIndex: 7, damage: 0 }] : [];
        for (const cb of listeners) cb();
        for (let n = 0; n < 12; n++) await Promise.resolve();
    };
    return {
        s,
        state,
        prayers,
        step,
        toggles: () => toggles,
        workerAttacks: () => workerAttacks,
        resumes: () => resumes,
        resumeMode: (mode: string) => {
            resumeMode = mode;
        },
        lose: () => {
            lost = true;
        },
        loseAfter: (n: number) => {
            loseFrom = n;
        },
        nativeActive: () => nativeActive,
    };
}
const prayerOptions = { prayer: 10, cap: 100, hpFloor: 40 };

test('native five-tick drain model distinguishes finite resets from holding during actual owned combat observations', async () => {
    for (const mode of ['flick', 'hold'] as const) {
        const f = prayerFixture();
        const r = await withCombatPrayer(f.s, { ...prayerOptions, mode }, async stop => {
            await f.s.bot.attack(f.state.nearbyNpcs[0]);
            for (let n = 0; n < 24 && !stop(); n++) await f.step();
            return { banked: true };
        });
        expect(r.ok).toBe(true);
        expect(r.restored).toBe(true);
        expect(r.result?.banked).toBe(true);
        expect(r.attacksObserved).toBe(6);
        expect(r.attacksWithPrayerObserved).toBeGreaterThan(0);
        expect(r.attackResumptions).toBeGreaterThan(0);
        expect(f.workerAttacks()).toBe(1);
        expect(f.prayers.activePrayers.some(Boolean)).toBe(false);
        if (mode === 'flick') {
            expect(r.spent).toBe(0);
            expect(r.cycles).toBeGreaterThan(0);
        } else {
            expect(r.spent).toBeGreaterThan(0);
        }
    }
});

test('lagged lost activation or lost reset OFF cannot authorize another toggle or claim restoration', async () => {
    for (const loseAt of [1, 2]) {
        const f = prayerFixture();
        f.loseAfter(loseAt);
        const clock = setInterval(() => {
            void f.step();
        }, 1);
        try {
            const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
                await f.s.bot.attack(f.state.nearbyNpcs[0]);
                for (let n = 0; n < 30 && !stop(); n++) await f.step();
                expect(stop()).toBe(true);
            });
            expect(r.ok).toBe(false);
            expect(r.failure).toContain('uncertain');
            expect(r.prayerStateUncertain).toBe(true);
            expect(r.restored).toBe(false);
            expect(f.toggles()).toBe(loseAt);
            expect(f.nativeActive()).toBe(loseAt === 1);
        } finally {
            clearInterval(clock);
        }
    }
});

test('a mutable player replacement cannot receive prayer cleanup intended for the original life', async () => {
    const f = prayerFixture();
    const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        await f.step();
        expect(f.toggles()).toBe(1);
        f.state.player.lifeId = 2;
        await f.step();
        expect(stop()).toBe(true);
    });
    expect(r.ok).toBe(false);
    expect(r.restored).toBe(false);
    expect(f.toggles()).toBe(1);
});

test('a rejected post-dispatch observation cannot turn the cached OFF state into restored proof', async () => {
    const f = prayerFixture();
    let nativeOn = false;
    let dispatches = 0;
    f.s.sdk.sendTogglePrayer = async () => {
        dispatches++;
        nativeOn = true;
        f.s.sdk.getState = () => {
            throw Error('injected observation failure');
        };
        return { success: true };
    };
    const result = await withCombatPrayer(f.s, prayerOptions, async () => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        await f.step();
    });
    expect(result.ok).toBe(false);
    expect(result.restored).toBe(false);
    expect(result.prayerStateUncertain).toBe(true);
    expect(dispatches).toBe(1);
    expect(nativeOn).toBe(true);
    expect(result.failure).toContain('observation failure');
});

test('foreign combat and operator stop halt the existing consumer and restore the original all-off state', async () => {
    for (const foreign of [true, false]) {
        const f = prayerFixture();
        let halted = false;
        const r = await withCombatPrayer(f.s, { ...prayerOptions, stop: () => halted }, async stop => {
            await f.s.bot.attack(f.state.nearbyNpcs[0]);
            await f.step();
            if (foreign) f.state.nearbyPlayers.push({ x: 1, z: 1 });
            else halted = true;
            await f.step();
            expect(stop()).toBe(true);
        });
        expect(r.ok).toBe(false);
        expect(r.restored).toBe(true);
        expect(f.prayers.activePrayers.some(Boolean)).toBe(false);
    }
});

test('missing prayer state, conflicting prayers and invalid offensive choices fail before the consumer', async () => {
    const f = prayerFixture();
    let ran = false;
    await expect(
        withCombatPrayer(f.s, { ...prayerOptions, prayer: 14 }, async () => {
            ran = true;
        }),
    ).rejects.toThrow('offensive');
    f.prayers.activePrayers[1] = true;
    await expect(
        withCombatPrayer(f.s, prayerOptions, async () => {
            ran = true;
        }),
    ).rejects.toThrow('all prayers off');
    expect(ran).toBe(false);
    expect(f.toggles()).toBe(0);
});

test('lost successful resume reply reconciles one same-cow dispatch after observed prayer ON', async () => {
    const f = prayerFixture();
    const original = f.s.bot.attack;
    f.resumeMode('lost-reply');
    const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        for (let n = 0; n < 24 && !stop(); n++) await f.step();
        return { banked: true };
    });
    expect(r.ok).toBe(true);
    expect(r.attackStateUncertain).toBe(false);
    expect(f.workerAttacks()).toBe(1);
    expect(f.resumes()).toBe(r.attackResumptions);
    expect(f.s.bot.attack).toBe(original);
});

test('unknown resume outcome stops after one packet and restores known owned prayer state', async () => {
    const f = prayerFixture();
    const original = f.s.bot.attack;
    f.resumeMode('unknown');
    const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        for (let n = 0; n < 24 && !stop(); n++) await f.step();
        expect(stop()).toBe(true);
        return { banked: true };
    });
    expect(r.ok).toBe(false);
    expect(r.attackStateUncertain).toBe(true);
    expect(r.failure).toContain('unconfirmed');
    expect(f.resumes()).toBe(1);
    expect(f.workerAttacks()).toBe(1);
    expect(r.restored).toBe(true);
    expect(f.s.bot.attack).toBe(original);
});

test('prayer activation cannot resume a replaced, foreign, distant, dead or wrong-life bound cow', async () => {
    for (const mode of ['id', 'index', 'private-owner', 'peer', 'distance', 'dead', 'life']) {
        const f = prayerFixture();
        const toggle = f.s.sdk.sendTogglePrayer;
        f.s.sdk.sendTogglePrayer = async (i: number) => {
            const r = await toggle(i);
            if (f.prayers.activePrayers[i]) {
                if (mode === 'id') f.state.nearbyNpcs[0]!.id = 82;
                if (mode === 'index') f.state.nearbyNpcs[0]!.index = 8;
                if (mode === 'private-owner') f.state.nearbyNpcs[0]!.targetIndex = 32770;
                if (mode === 'peer') f.state.nearbyPlayers.push({ x: 11, z: 1 });
                if (mode === 'distance') f.state.nearbyNpcs[0]!.distance = 3;
                if (mode === 'dead') f.state.nearbyNpcs[0]!.hp = 0;
                if (mode === 'life') f.state.player.lifeId = 2;
            }
            return r;
        };
        const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
            await f.s.bot.attack(f.state.nearbyNpcs[0]);
            for (let n = 0; n < 10 && !stop(); n++) await f.step();
        });
        expect(r.ok).toBe(false);
        expect(f.workerAttacks()).toBe(1);
        expect(f.resumes()).toBe(0);
    }
});

test('only the existing accepted cow input is bound and method ownership is restored', async () => {
    const f = prayerFixture();
    let inputs = 0;
    const rejected = async () => {
        inputs++;
        return { success: false, message: 'unknown dispatch' };
    };
    f.s.bot.attack = rejected;
    const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        expect(stop()).toBe(true);
        await f.step();
    });
    expect(r.ok).toBe(false);
    expect(inputs).toBe(1);
    expect(f.toggles()).toBe(0);
    expect(f.resumes()).toBe(0);
    expect(f.s.bot.attack).toBe(rejected);
});

test('another input owner cannot receive same-cow retargets or be overwritten on cleanup', async () => {
    const f = prayerFixture();
    const toggle = f.s.sdk.sendTogglePrayer;
    const other = async () => ({ success: false });
    f.s.sdk.sendTogglePrayer = async (i: number) => {
        const r = await toggle(i);
        if (f.prayers.activePrayers[i]) f.s.bot.attack = other;
        return r;
    };
    const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        for (let n = 0; n < 10 && !stop(); n++) await f.step();
    });
    expect(r.ok).toBe(false);
    expect(f.resumes()).toBe(0);
    expect(f.s.bot.attack).toBe(other);
});

test('input ownership change before prayer activation produces no prayer or resume packets', async () => {
    const f = prayerFixture();
    const other = async () => ({ success: false });
    const r = await withCombatPrayer(f.s, prayerOptions, async stop => {
        await f.s.bot.attack(f.state.nearbyNpcs[0]);
        f.s.bot.attack = other;
        await f.step();
        expect(stop()).toBe(true);
    });
    expect(r.ok).toBe(false);
    expect(f.toggles()).toBe(0);
    expect(f.resumes()).toBe(0);
    expect(f.s.bot.attack).toBe(other);
});

function incomingFixture() {
    let tick = 0;
    let xp = 0;
    let health = 99;
    let toggles = 0;
    let casts = 0;
    let mode = '';
    let unknown = false;
    const listeners = new Set<() => void>();
    const prayers = { activePrayers: Array(15).fill(false), prayerPoints: 99, prayerLevel: 99 };
    const player: any = { name: 'Owned', worldX: 1, worldZ: 1, level: 0, lifeId: 1, respawnCount: 0, isDead: false, combat: { inCombat: false, targetType: 'none', targetIndex: -1 } };
    const npc: any = { id: 7, index: 7, name: 'Farmer', x: 2, z: 1, distance: 1, reachable: true, hp: 12, maxHp: 12, inCombat: false, targetIndex: -1, animId: -1, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] };
    const inventory: any[] = [{ id: 558, count: 10, slot: 0 }];
    const native = { type: { id: 7 } };
    const client: any = { var: Object.assign([], { 108: 0 }), selfSlot: 1, npc: { 7: native }, executeBotAction: () => ({ success: true }) };
    const state: any = { player, prayers, nearbyNpcs: [npc], nearbyPlayers: [], gameMessages: [], combatEvents: [], dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false } };
    const s: any = {
        name: 'Owned',
        client,
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        sdk: {
            getState: () => state,
            getStateAge: () => 0,
            getPrayerState: () => prayers,
            isPrayerActive: (i: number) => prayers.activePrayers[i],
            getInventory: () => inventory,
            getEquipment: () => [{ id: 1381, count: 1, slot: 3 }, { id: 1540, count: 1, slot: 5 }],
            getSkill: () => ({ level: health, baseLevel: 99 }),
            getSkillXp: (name: string) => (name === 'Magic' ? xp : 0),
            sendTogglePrayer: async (i: number) => {
                toggles++;
                if (mode === 'owner') client.executeBotAction = () => ({ success: false });
                if (mode === 'life') player.lifeId++;
                if (mode === 'peer') state.nearbyPlayers = [{ name: 'Foreign' }];
                if (mode === 'unknown') {
                    unknown = true;
                    return { success: false };
                }
                prayers.activePrayers[i] = !prayers.activePrayers[i];
                player.combat.targetType = 'none';
                return { success: true };
            },
        },
        direct: async (a: any) => {
            if (a.type === 'spellOnNpc') {
                if (!prayers.activePrayers[14]) throw Error('paid before protection');
                casts++;
                if (mode === 'castUnknown') return { success: true };
                inventory[0].count--;
                xp += 5.5;
                player.combat = { inCombat: true, targetType: 'npc', targetIndex: 7 };
                npc.inCombat = true;
                npc.targetIndex = 32769;
            }
            return { success: true };
        },
    };
    const step = () => {
        tick++;
        if (npc.inCombat && tick % 6 === 0) {
            npc.animId = 433;
            if (!prayers.activePrayers[14]) health--;
        } else {
            npc.animId = -1;
        }
        for (const cb of [...listeners]) cb();
    };
    return {
        s,
        player,
        npc,
        client,
        prayers,
        inventory,
        step,
        tick: () => tick,
        casts: () => casts,
        toggles: () => toggles,
        unknown: () => unknown,
        mode: (m: string) => {
            mode = m;
        },
    };
}
const incomingOptions = { cap: 100, hpFloor: 70, spell: 'wind_strike' };

test('incoming native profile is explicit Farmer7/rate6/attack433/melee14 rather than inventing cow rate', () => {
    expect(incomingFarmerProfile()).toMatchObject({ npc: 7, rate: 6, anim: 433, prayer: 14, lead: 2 });
});

test('actual runNpcMagic gets initial protection before paid cast and finite conservative incoming resets', async () => {
    const f = incomingFixture();
    const timer = setInterval(f.step, 1);
    try {
        const r = await withIncomingProtection(f.s, incomingOptions, async (owned, stop, finish) => {
            const m = await runNpcMagic(owned, nativeNpcSpell('wind_strike'), { npc: 7, casts: 3, cap: 80, members: true, stop });
            finish();
            return m;
        });
        expect(r.ok).toBe(true);
        expect(r.result?.casts).toBe(3);
        expect(f.casts()).toBe(3);
        expect(f.inventory[0].count).toBe(7);
        expect(r.attacksObserved).toBeGreaterThan(0);
        expect(r.attacksProtected).toBe(r.attacksObserved);
        expect(r.cycles).toBeGreaterThan(0);
        expect(r.restored).toBe(true);
        expect(f.prayers.activePrayers.some(Boolean)).toBe(false);
    } finally {
        clearInterval(timer);
    }
});

test('initial protection lost life/executor/peer or unknown toggle forbids first worker paid cast', async () => {
    for (const mode of ['owner', 'life', 'peer', 'unknown']) {
        const f = incomingFixture();
        f.mode(mode);
        const timer = setInterval(f.step, 1);
        try {
            const r = await withIncomingProtection(f.s, incomingOptions, owned =>
                runNpcMagic(owned, nativeNpcSpell('wind_strike'), { npc: 7, casts: 1, cap: 20, members: true }),
            );
            expect(r.ok).toBe(false);
            expect(f.casts()).toBe(0);
            expect(f.toggles()).toBeLessThanOrEqual(mode === 'peer' ? 2 : 1);
            if (mode === 'unknown') expect(r.prayerStateUncertain).toBe(true);
        } finally {
            clearInterval(timer);
        }
    }
});

test('unconfirmed prior paid-worker input never authorizes a second cast or retired success', async () => {
    const f = incomingFixture();
    f.mode('castUnknown');
    const timer = setInterval(f.step, 1);
    try {
        const r = await withIncomingProtection(f.s, incomingOptions, async (owned, _stop, finish) => {
            await owned.direct({ type: 'spellOnNpc', npcIndex: 7, spellComponent: 1152 } as any);
            finish();
        });
        expect(r.ok).toBe(false);
        expect(f.casts()).toBe(1);
        expect(r.failure).toContain('unconfirmed');
    } finally {
        clearInterval(timer);
    }
});

test('new private owner or reused bound NPC after first paid receipt stops without another spell', async () => {
    for (const change of ['foreign', 'reuse', 'life']) {
        const f = incomingFixture();
        const timer = setInterval(() => {
            f.step();
            if (f.tick() === 5) {
                if (change === 'foreign') f.npc.targetIndex = 32770;
                if (change === 'reuse') f.client.npc[7] = { type: { id: 7 } };
                if (change === 'life') f.player.lifeId++;
            }
        }, 1);
        try {
            const r = await withIncomingProtection(f.s, incomingOptions, (owned, stop) =>
                runNpcMagic(owned, nativeNpcSpell('wind_strike'), { npc: 7, casts: 3, cap: 80, members: true, stop }),
            );
            expect(r.ok).toBe(false);
            expect(f.casts()).toBe(1);
            expect(f.inventory[0].count).toBe(9);
        } finally {
            clearInterval(timer);
        }
    }
});

test('lost OFF publication permits no repeated prayer or following paid cast', async () => {
    const f = incomingFixture();
    const toggle = f.s.sdk.sendTogglePrayer;
    f.s.sdk.sendTogglePrayer = async (i: number) => {
        if (f.toggles() === 1) f.mode('unknown');
        return toggle(i);
    };
    const timer = setInterval(f.step, 1);
    try {
        const r = await withIncomingProtection(f.s, incomingOptions, (owned, stop) =>
            runNpcMagic(owned, nativeNpcSpell('wind_strike'), { npc: 7, casts: 3, cap: 80, members: true, stop }),
        );
        expect(r.ok).toBe(false);
        expect(r.prayerStateUncertain).toBe(true);
        expect(f.toggles()).toBe(2);
        expect(f.casts()).toBe(1);
    } finally {
        clearInterval(timer);
    }
});

// --- Combat WorkerModule integration tests for magic & prayer modes ---

describe('combatWorkerModule magic and prayer modes', () => {
    const emptyWorld: WorkerWorldView = { at: Date.now(), side: 'local', server: 'localhost:8888', accounts: {} };
    const makeAcct = (overrides: Partial<WorkerAccountView> = {}): WorkerAccountView => ({
        name: 'MagicTester',
        side: 'local',
        protectedClock: false,
        skills: { Magic: { level: 55, xp: 170_000 }, Hitpoints: { level: 50, xp: 105_000 }, Prayer: { level: 43, xp: 55_000 } },
        quests: {},
        inventory: {},
        equipment: {},
        bank: { items: {}, observedAt: Date.now(), trusted: true },
        pos: { x: 3253, z: 3420, level: 0 },
        ...overrides,
    });

    test('preflight and estimate cover magic-order, magic-npc, magic-splash, magic-splash-coop, and prayer-flick', () => {
        const acct = makeAcct();
        for (const mode of ['magic-order', 'magic-npc', 'magic-splash', 'magic-splash-coop', 'prayer-flick'] as const) {
            expect(COMBAT_SITES[mode]).toBeDefined();
            const pre = combatPreflight(acct, { mode }, emptyWorld);
            expect(() => validatePreflightResult(pre)).not.toThrow();
            expect(pre.ok).toBe(true);
            const est = combatEstimate(acct, { mode }, emptyWorld);
            expect(() => validateRateEstimate(est)).not.toThrow();
        }
        const f2pBlocked = combatPreflight(acct, { mode: 'magic-splash', members: false }, emptyWorld);
        expect(f2pBlocked.ok).toBe(false);
        const lowPrayer = combatPreflight(makeAcct({ skills: { Magic: { level: 10, xp: 1200 }, Hitpoints: { level: 10, xp: 1154 }, Prayer: { level: 0, xp: 0 } } }), { mode: 'prayer-flick' }, emptyWorld);
        expect(lowPrayer.ok).toBe(false);
    });

    test('runCombatModuleSession dispatches magic-npc cleanly and validates RunOutcome', async () => {
        let tick = 0;
        let xp = 0;
        const listeners = new Set<() => void>();
        const stock: Record<number, number> = { 556: 5, 558: 5 };
        const inventory = () => Object.entries(stock).filter(([, n]) => n > 0).map(([id, count], slot) => ({ id: Number(id), count, slot }));
        const player = { worldX: 3229, worldZ: 3298, lifeId: 1, respawnCount: 0, level: 0, isDead: false };
        const chicken: any = { id: 41, index: 7, hp: 3, inCombat: false, reachable: true, distance: 1, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] };
        const session = {
            name: 'ModuleNpcMagic',
            tick: () => tick,
            onTick: (cb: () => void) => {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
            ended: new Promise<void>(() => {}),
            client: { selfSlot: 1, var: Array(109).fill(0) },
            sdk: {
                getState: () => ({ player, inventory: inventory(), equipment: [], nearbyNpcs: [chicken], nearbyPlayers: [], combatEvents: [] }),
                getInventory: inventory,
                getEquipment: () => [],
                getSkill: () => ({ level: 50, baseLevel: 50 }),
                getSkillXp: (n: string) => (n === 'Magic' ? xp : 0),
            },
            bot: { dismissBlockingUI: async () => {} },
            direct: async () => {
                stock[556]!--;
                stock[558]!--;
                xp += 55;
                return { success: true };
            },
        } as unknown as CombatSession;
        const timer = setInterval(() => {
            tick++;
            for (const fn of [...listeners]) fn();
        }, 1);
        try {
            const outcome = await runCombatModuleSession(session, { mode: 'magic-npc', args: ['wind_strike', '41', '2', '100'] });
            expect(() => validateRunOutcome(outcome)).not.toThrow();
            expect(outcome.kind).toBe('target_met');
            expect(outcome.activityId).toBe('combat:magic-npc');
            if (outcome.kind === 'target_met') {
                expect(outcome.unitsCompleted).toBe(2);
                expect(outcome.xpGained?.Magic).toBe(110);
            }
        } finally {
            clearInterval(timer);
        }
    });

    test('runCombatModuleSession classifies splash supply exhaustion as missing_supply', async () => {
        const session = {
            name: 'ModuleSplashShort',
            tick: () => 0,
            onTick: () => () => {},
            ended: new Promise<void>(() => {}),
            bankObservation: () => null,
            sdk: {
                getState: () => ({
                    player: { worldX: 3229, worldZ: 3292, level: 0 },
                    inventory: [],
                    equipment: [],
                    nearbyNpcs: [],
                    nearbyLocs: [],
                    nearbyPlayers: [],
                    gameMessages: [],
                }),
                getInventory: () => [],
                getEquipment: () => [],
                getSkill: (n: string) => ({ level: n === 'Hitpoints' ? 10 : 1, baseLevel: n === 'Hitpoints' ? 10 : 1 }),
                getSkillXp: (n: string) => (n === 'Magic' ? 0 : 1154),
            },
        } as unknown as CombatSession;
        const outcome = await combatWorkerModule.run(session, { mode: 'magic-splash-coop', targetLevel: 8, capTicks: 100 });
        expect(() => validateRunOutcome(outcome)).not.toThrow();
        expect(outcome.kind).toBe('missing_supply');
        expect(outcome.activityId).toBe('combat:magic-splash-coop');
    });
});
