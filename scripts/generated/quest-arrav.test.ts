import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ARRAV_SPOTS, runQuestArrav } from './quest-arrav';
import { wildernessLevel } from '../../packages/core/src/prayer-guard';

describe('Shield of Arrav quest script', () => {
    test('importing quest-arrav is side-effect free outside main or QUEST_SESSION', () => {
        expect(typeof runQuestArrav).toBe('function');
        const source = readFileSync('scripts/generated/quest-arrav.ts', 'utf8');
        expect(source).toContain('if (import.meta.main || !!(globalThis as { QUEST_SESSION?: unknown }).QUEST_SESSION)');
    });

    test('native Shield of Arrav content contract matches script IDs, doors, and non-teleport exit path', () => {
        const pack = readFileSync('vendor/rs-sdk/server/content/pack/obj.pack', 'utf8');
        for (const [id, name] of [
            [757, 'the_shield_of_arrav'],
            [759, 'phoenixkey2'],
            [761, 'intelligence_report'],
            [763, 'arravshield1'],
            [765, 'arravshield2'],
            [767, 'phoenix_crossbow'],
            [769, 'arravcertificate'],
        ] as const) {
            expect(pack).toMatch(new RegExp(`^${id}=${name}$`, 'm'));
        }
        const source = readFileSync('scripts/generated/quest-arrav.ts', 'utf8');
        expect(source).toContain("if (!q.canCast('magic:varrock_teleport'))");
        expect(source).toContain('worldZ ?? 9999) < LOC.baDoor.z');
    });

    test('every Shield of Arrav location including the Varrock cellar stays strictly outside the Wilderness', () => {
        expect(ARRAV_SPOTS.length).toBeGreaterThan(10);
        for (const spot of ARRAV_SPOTS) {
            expect(wildernessLevel(spot.x, spot.z)).toBe(0);
        }
    });
});
