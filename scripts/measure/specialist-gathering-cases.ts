import type { BenchCase } from './aio-bench-cases';
import type { SaveConfig } from '../../packages/practice/src/presets';
import { FLETCHING_SPECIALIST_SUPPLIES } from '../fletching-specialist';
import { FISHING_SPECIALIST_SUPPLIES } from '../fishing-specialist';
import { MINING_SPECIALIST_SUPPLIES } from '../mining-specialist';
import { THIEVING_SPECIALIST_SUPPLIES } from '../thieving-specialist';

const STACKABLE_SUPPLY_IDS = new Set([53, 39, 40, 41, 42, 43, 44, 313, 314, 995]);

export function expandSupplyInventory(counts: Readonly<Record<number, number>>): { id: number; count: number }[] {
    const items: { id: number; count: number }[] = [];
    for (const [idText, qty] of Object.entries(counts)) {
        const id = Number(idText);
        if (STACKABLE_SUPPLY_IDS.has(id)) {
            items.push({ id, count: qty });
        } else {
            for (let i = 0; i < qty; i++) items.push({ id, count: 1 });
        }
    }
    return items;
}

const FRESH_TUTORIAL_START: SaveConfig = {
    position: { x: 3094, z: 3106, level: 0 },
    varps: { 281: 0 },
};

const helperBesideLumbridge = (supplies: Readonly<Record<number, number>>): SaveConfig => ({
    position: { x: 3223, z: 3222, level: 0 },
    inventory: expandSupplyInventory(supplies),
});

const specialistPass = (stdout: string): boolean =>
    /^LOGOUT (?:logged-out\s*)+$/m.test(stdout)
    && /^RESULT ok .*?\blevel=99\b/m.test(stdout)
    && !/^RESULT fail\b/m.test(stdout);

export const SPECIALIST_GATHERING_CASES: BenchCase[] = [
    {
        key: 'skiller:fletching:specialist',
        script: 'scripts/aio-skiller.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['fletching', 'specialist', '{bot:b}'],
        companions: [{ suffix: 'b', preset: 'fresh_lumbridge', presetConfig: helperBesideLumbridge(FLETCHING_SPECIALIST_SUPPLIES) }],
        pass: specialistPass,
        timeoutMs: 600_000,
        output: /\bticks=(\d+)/,
    },
    {
        key: 'skiller:fishing:specialist',
        script: 'scripts/aio-skiller.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['fishing', 'specialist', '{bot:b}'],
        companions: [{ suffix: 'b', preset: 'fresh_lumbridge', presetConfig: helperBesideLumbridge(FISHING_SPECIALIST_SUPPLIES) }],
        pass: specialistPass,
        timeoutMs: 600_000,
        output: /\bticks=(\d+)/,
    },
    {
        key: 'skiller:mining:specialist',
        script: 'scripts/aio-skiller.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['mining', 'specialist', '{bot:b}'],
        companions: [{ suffix: 'b', preset: 'fresh_lumbridge', presetConfig: helperBesideLumbridge(MINING_SPECIALIST_SUPPLIES) }],
        pass: specialistPass,
        timeoutMs: 600_000,
        output: /\bticks=(\d+)/,
    },
    {
        key: 'skiller:thieving:specialist',
        script: 'scripts/aio-skiller.ts',
        preset: 'fresh_lumbridge',
        presetConfig: FRESH_TUTORIAL_START,
        scriptArgs: ['thieving', 'specialist', '{bot:b}'],
        companions: [{ suffix: 'b', preset: 'fresh_lumbridge', presetConfig: helperBesideLumbridge(THIEVING_SPECIALIST_SUPPLIES) }],
        pass: specialistPass,
        timeoutMs: 600_000,
        output: /\btotalTicks=(\d+)/,
    },
];
