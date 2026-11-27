import { describe, expect, test } from 'bun:test';
import type { DefectRecord } from '../src/contracts';
import { validateDefectRecord } from '../src/contracts';
import { OutcomeClassifier, DEATH_CLASS_TTL_MS } from '../src/outcome-classifier';
import { accountClassLevels, deathClassBlocks, defectBlocksAccount, FLEET_DEATH_HOLD_MS, isFleetWideDefect } from '../src/planner';
import { evaluateCombatSurvivability } from '../src/preflight';
import { statusDeathLevels } from '../../fleet/src/brain-runtime';

const T0 = 1_800_000_000_000;
const death = (levels?: { hitpoints: number; defence: number }): DefectRecord => ({
    id: 'defect:combat:giant:death',
    activityId: 'combat:giant',
    faultSignature: 'death',
    outcomeKind: 'death',
    account: 'FishAndChips',
    observedAt: T0,
    quarantinedAt: T0,
    expiresAt: T0 + DEATH_CLASS_TTL_MS,
    quarantined: true,
    logPath: '.practice/swarm-logs/FishAndChips.log',
    detail: 'DEATH at=3111,9846,0',
    count: 1,
    ...(levels ? { deathLevels: levels } : {}),
});

describe('death class defects', () => {
    test('a death holds every account for a day, then its class', () => {
        const d = death({ hitpoints: 59, defence: 40 });
        expect(validateDefectRecord(d)).toEqual([]);
        expect(isFleetWideDefect(d, T0 + 1000)).toBe(true);
        const later = T0 + FLEET_DEATH_HOLD_MS + 1000;
        expect(isFleetWideDefect(d, later)).toBe(false);
        // Weaker or equal in both: held.
        expect(defectBlocksAccount(d, 'Spitroaster', later, { hitpoints: 44, defence: 30 })).toBe(true);
        expect(defectBlocksAccount(d, 'Spitroaster', later, { hitpoints: 59, defence: 40 })).toBe(true);
        // Stronger in Hitpoints or Defence: free.
        expect(defectBlocksAccount(d, 'Shaftsinker', later, { hitpoints: 81, defence: 40 })).toBe(false);
        expect(defectBlocksAccount(d, 'Shaftsinker', later, { hitpoints: 50, defence: 60 })).toBe(false);
        // The account that died stays held.
        expect(defectBlocksAccount(d, 'FishAndChips', later, { hitpoints: 99, defence: 99 })).toBe(true);
        // After the class hold ends nothing is held.
        expect(deathClassBlocks(d, { hitpoints: 1, defence: 1 }, T0 + DEATH_CLASS_TTL_MS + 1)).toBe(false);
    });

    test('a death with no levels keeps the fleet-wide hold', () => {
        const d = death();
        expect(isFleetWideDefect(d, T0 + FLEET_DEATH_HOLD_MS * 5)).toBe(true);
    });

    test('the classifier records the class and keeps the stronger of two deaths', () => {
        const c = new OutcomeClassifier({ persist: false });
        const raw = (account: string, levels: { hitpoints: number; defence: number }) => ({
            activityId: 'combat:giant',
            account,
            status: 'fail',
            reason: 'died after 1 runs',
            died: true,
            deathLevels: levels,
            logPath: `.practice/swarm-logs/${account}.log`,
        });
        c.classifyAndApplyRaw(raw('FishAndChips', { hitpoints: 59, defence: 40 }), { now: T0 });
        c.classifyAndApplyRaw(raw('Spitroaster', { hitpoints: 65, defence: 30 }), { now: T0 + 1000 });
        const [d] = c.quarantinedDefects(T0 + 2000).filter(x => x.activityId === 'combat:giant');
        expect(d?.deathLevels).toEqual({ hitpoints: 65, defence: 40 });
        expect(d!.expiresAt).toBe(T0 + 1000 + DEATH_CLASS_TTL_MS);
    });

    test('status skills give the death levels', () => {
        expect(statusDeathLevels([{ name: 'Hitpoints', level: 59, xp: 1 }, { name: 'Defence', level: 40, xp: 1 }])).toEqual({ hitpoints: 59, defence: 40 });
        expect(statusDeathLevels(undefined)).toBeUndefined();
        expect(accountClassLevels({ skills: { Hitpoints: { level: 12 } } })).toEqual({ hitpoints: 12, defence: 1 });
    });
});

describe('brain admission floor', () => {
    const view = (hp: number, food: number) => ({
        name: 'Porksword',
        skills: { Hitpoints: { level: hp, xp: 0 }, Defence: { level: 1, xp: 0 } },
        side: 'local',
        protectedClock: false,
        pos: null,
        inventory: food ? { 379: food } : {},
        bank: { items: {}, observedAt: T0, trusted: true },
        equipment: {},
        quests: {},
    });
    test('refuses a 12 Hitpoints account at the wizards and asks food of a stronger one', () => {
        const world = { at: T0, side: 'local', server: 'live', accounts: {} } as never;
        const weak = evaluateCombatSurvivability(view(12, 20) as never, { threatNpcIds: [13], foodIds: [379] }, world);
        expect(weak.map(b => b.reason)).toEqual(['hitpoints']);
        expect(weak[0]!.message).toStartWith('admission: too weak');
        const hungry = evaluateCombatSurvivability(view(60, 0) as never, { threatNpcIds: [13], foodIds: [379] }, world);
        expect(hungry.map(b => b.reason)).toEqual(['food']);
        expect(hungry[0]!.required).toBeGreaterThan(0);
        expect(evaluateCombatSurvivability(view(60, 20) as never, { threatNpcIds: [13], foodIds: [379] }, world)).toEqual([]);
    });
});
