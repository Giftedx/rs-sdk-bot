import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { intentForEntry } from '../packages/planner/src/progression-catalog';
import { FIGHTER_PROFILES } from './aio-fighter';
import {
    DEFENCE_SPECIALIST_KIT,
    HP_SPECIALIST_KIT,
    KIT_BY_BOARD,
    SPECIALIST_TARGETS,
    STRENGTH_SPECIALIST_KIT,
    assertNonReservedAccount,
    countById,
    hasAtLeastKit,
    hasExactKit,
    kitRequirements,
    kitSlotTotal,
    pickCourtyardMagicTarget,
} from './combat-quest-specialists';
import { runQuestBall } from './generated/quest-ball';
import { runQuestGrandTree } from './generated/quest-grandtree';
import { runQuestMM } from './generated/quest-mm';
import { runQuestTree } from './generated/quest-tree';
import { runWaterfall } from './generated/waterfall';
import { benchCases } from './measure/aio-bench-cases';
import {
    SPECIALIST_COMBAT_QUESTS_CASES,
    kitToSaveInventory,
    supplierPresetConfig,
    tankPostPresetConfig,
    tankSupplierPresetConfig,
} from './measure/specialist-combat-quests-cases';

const ROOT = resolve(import.meta.dir, '..');

function loadObjPack(): Map<number, string> {
    const map = new Map<number, string>();
    const raw = readFileSync(join(ROOT, 'vendor', 'rs-sdk', 'server', 'content', 'pack', 'obj.pack'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const id = Number(line.slice(0, eq));
        if (Number.isSafeInteger(id)) map.set(id, line.slice(eq + 1).trim());
    }
    return map;
}

function loadItemsById(): Map<number, { id: number; name: string; tradeable: boolean }> {
    const arr = JSON.parse(readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8')) as {
        id: number;
        name: string;
        tradeable: boolean;
    }[];
    return new Map(arr.map(x => [x.id, x]));
}

function rev289XpForLevel(level: number): number {
    let acc = 0;
    for (let i = 1; i < level; i++) {
        acc += Math.floor(i + Math.pow(2.0, i / 10.0) * 300.0);
    }
    return Math.floor(acc / 4);
}

describe('Combat-quest specialists: targets, kits, and saves', () => {
    test('board targets enforce >=2% margin under live #1 records', () => {
        expect(SPECIALIST_TARGETS.hitpoints).toEqual({
            board: 'hitpoints',
            liveChampion: 'nickvitalsq',
            liveTicks: 11343,
            targetTicks: 11116,
        });
        expect(SPECIALIST_TARGETS.strength).toEqual({
            board: 'strength',
            liveChampion: 'nicksinew',
            liveTicks: 3288,
            targetTicks: 3222,
        });
        expect(SPECIALIST_TARGETS.defence).toEqual({
            board: 'defence',
            liveChampion: 'nickbicep',
            liveTicks: 4323,
            targetTicks: 4236,
        });
        for (const t of Object.values(SPECIALIST_TARGETS)) {
            expect(t.targetTicks).toBeLessThanOrEqual(Math.floor(t.liveTicks * 0.98));
        }
    });

    test('every specialist supply kit fits 28 slots and holds tradeable rev 289 IDs', () => {
        const objPack = loadObjPack();
        const itemsById = loadItemsById();

        for (const board of ['hitpoints', 'strength', 'defence'] as const) {
            const kit = KIT_BY_BOARD[board];
            expect(kitSlotTotal(kit)).toBeLessThanOrEqual(28);
            const saveInv = kitToSaveInventory(kit);
            expect(saveInv.length).toBe(kitSlotTotal(kit));
            expect(saveInv.length).toBeLessThanOrEqual(28);

            for (const entry of kit) {
                const debugName = objPack.get(entry.id);
                expect(debugName).toBeDefined();
                const isNoted = debugName!.startsWith('cert_');
                const baseId = isNoted ? entry.id - 1 : entry.id;
                const baseItem = itemsById.get(baseId);
                expect(baseItem).toBeDefined();
                expect(baseItem!.tradeable).toBe(true);
                expect(baseItem!.name.toLowerCase()).toBe(entry.name.toLowerCase());
                if (isNoted) {
                    expect(entry.stackable).toBe(true);
                    expect(objPack.get(baseId)).toBe(debugName!.slice('cert_'.length));
                }
            }

            const dragonBones = kit.find(k => k.id === 536)?.count ?? 0;
            expect(dragonBones * 72 * 25).toBeGreaterThanOrEqual(rev289XpForLevel(43));
        }

        expect(HP_SPECIALIST_KIT.find(k => k.id === 386)?.count).toBeGreaterThanOrEqual(3 + 2 + 3 + 7);
        expect(HP_SPECIALIST_KIT.find(k => k.id === 2435)?.count).toBeGreaterThanOrEqual(1 + 2 + 3 + 9);
        expect(HP_SPECIALIST_KIT.find(k => k.id === 563)?.count).toBeGreaterThanOrEqual(18);
        expect(STRENGTH_SPECIALIST_KIT).toBe(KIT_BY_BOARD.strength);
        expect(DEFENCE_SPECIALIST_KIT).toBe(KIT_BY_BOARD.defence);
        expect(STRENGTH_SPECIALIST_KIT.find(k => k.id === 3105)?.count).toBe(1);
        expect(DEFENCE_SPECIALIST_KIT.find(k => k.id === 565)?.count).toBeGreaterThanOrEqual(1600);
        expect(kitRequirements(STRENGTH_SPECIALIST_KIT).length).toBe(STRENGTH_SPECIALIST_KIT.length);
    });

    test('inventory kit matchers and companion save presets are consistent', () => {
        const hpInv = kitToSaveInventory(HP_SPECIALIST_KIT).map((x, slot) => ({ ...x, slot }));
        expect(hasAtLeastKit(hpInv, HP_SPECIALIST_KIT)).toBe(true);
        expect(hasExactKit(hpInv, HP_SPECIALIST_KIT)).toBe(true);
        expect(countById(hpInv, 386)).toBe(20);
        expect(countById([{ id: 386, baseId: 385, count: 20 }], 385)).toBe(20);

        const mutated = [...hpInv, { id: 9999, count: 1, slot: 27 }];
        expect(hasExactKit(mutated, HP_SPECIALIST_KIT)).toBe(false);

        const sup = supplierPresetConfig(HP_SPECIALIST_KIT);
        expect(sup.inventory?.length).toBe(28);
        const tankSup = tankSupplierPresetConfig(STRENGTH_SPECIALIST_KIT);
        expect(tankSup.skills?.Defence).toBe(1);
        expect(tankSup.skills?.Magic).toBe(1);
        expect(tankSup.skills?.Ranged).toBe(99);
        expect(tankSup.bank?.some(b => b.id === 563 && b.count >= 50)).toBe(true);
        expect(tankSup.bank?.some(b => b.id === 391 && b.count >= 500)).toBe(true);
        const tankPost = tankPostPresetConfig();
        expect(tankPost.position?.z).toBeGreaterThanOrEqual(3900);
        expect(tankPost.equipment?.some(e => e.id === 2552 && e.slot === 12)).toBe(true);
        expect(tankPost.inventory?.length).toBe(28);
        expect(tankPost.inventory?.every(i => i.id === 391)).toBe(true);
    });
});

describe('Combat-quest specialists: safety, targeting, and registration', () => {
    test('assertNonReservedAccount refuses every reserved specialist account', () => {
        for (const name of RESERVED_ACCOUNTS) {
            expect(() => assertNonReservedAccount(name)).toThrow(/reserved/);
        }
        expect(assertNonReservedAccount('benchtest1')).toBe('benchtest1');
    });

    test('pickCourtyardMagicTarget prefers engaged, then incoming attacker, then Man/Woman in zone', () => {
        const zoneOk = (x: number, z: number) => x >= 3217 && x <= 3225 && z >= 3210 && z <= 3229;
        const man = { index: 1, name: 'Man', x: 3220, z: 3220, distance: 4, hp: 7, inCombat: false, optionsWithIndex: [{ text: 'Attack' }] };
        const rat = { index: 2, name: 'Giant rat', x: 3221, z: 3221, distance: 1, hp: 5, inCombat: false, optionsWithIndex: [{ text: 'Attack' }] };
        const goblin = { index: 3, name: 'Goblin', x: 3219, z: 3219, distance: 1, hp: 5, inCombat: false, optionsWithIndex: [{ text: 'Attack' }] };
        const attacker = { index: 4, name: 'Goblin', x: 3222, z: 3222, distance: 2, hp: 5, inCombat: true, targetIndex: 32768 + 12, optionsWithIndex: [{ text: 'Attack' }] };
        const outside = { index: 5, name: 'Man', x: 3240, z: 3220, distance: 1, hp: 7, inCombat: false, optionsWithIndex: [{ text: 'Attack' }] };

        expect(pickCourtyardMagicTarget([outside, rat, goblin, man], { avoid: new Set(), zoneOk })?.index).toBe(1);
        expect(pickCourtyardMagicTarget([goblin, attacker, man], { selfSlot: 12, avoid: new Set(), zoneOk })?.index).toBe(4);
        expect(pickCourtyardMagicTarget([goblin, attacker, man], { selfSlot: 12, engagedTargetIndex: 1, avoid: new Set(), zoneOk })?.index).toBe(1);
    });

    test('composable quest runners export cleanly and catalog/bench registration matches', () => {
        for (const fn of [runQuestBall, runQuestTree, runQuestGrandTree, runQuestMM, runWaterfall]) {
            expect(typeof fn).toBe('function');
        }
        for (const target of ['specialist-hp', 'specialist-strength', 'specialist-defence']) {
            expect(FIGHTER_PROFILES.some(p => p.target === target)).toBe(true);
            const bench = benchCases().find(c => c.key === `fighter:${target}`);
            expect(bench).toBeDefined();
            expect(bench?.presetConfig).toEqual({});
        }
        expect(SPECIALIST_COMBAT_QUESTS_CASES.length).toBe(3);
        expect(intentForEntry('scripts/hp-specialist.ts', [], {}, undefined)).toEqual({ kind: 'train', skill: 'hitpoints', targetLevel: 99 });
        expect(intentForEntry('scripts/strength-specialist.ts', [], {}, undefined)).toEqual({ kind: 'train', skill: 'strength', targetLevel: 99 });
        expect(intentForEntry('scripts/defence-specialist.ts', [], {}, undefined)).toEqual({ kind: 'train', skill: 'defence', targetLevel: 99 });
    });
});
