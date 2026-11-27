import { describe, expect, test } from 'bun:test';
import { BRAIN_DROP_CYCLES, BRAIN_RUN_MIN_MS, brainDropKeep, countBrainDrops } from '../src/swarm';

const NOW = 1_000_000_000;
const base = (over: Partial<Parameters<typeof brainDropKeep>[0]> = {}): Parameters<typeof brainDropKeep>[0] => ({
    run: { accounts: ['WellHung'], started: NOW - 45_000, brain: true },
    now: NOW,
    dropCycles: 1,
    stopAll: false,
    brainActive: true,
    handAccount: () => false,
    held: () => false,
    ended: () => false,
    replacement: () => undefined,
    idleReason: () => 'max_bots_limit',
    ...over,
});

describe('brain run kept when one brain cycle drops it', () => {
    test('a young repeating brain run that the plan drops for slot pressure keeps running', () => {
        expect(brainDropKeep(base())).toContain('younger');
        expect(brainDropKeep(base({ idleReason: () => 'demand_saturated' }))).toBeDefined();
        expect(brainDropKeep(base({ idleReason: () => 'spot_capacity_full' }))).toBeDefined();
        expect(brainDropKeep(base({ idleReason: () => undefined }))).toBeDefined();
    });

    test('a re-plan that cannot rebuild the running plan (planner blocker) keeps the run', () => {
        for (const reason of ['no_matching_demand_or_activity', 'unresolvable_supply:1975', 'missing_coins:500', 'missing_food_supply', 'combat_survivability:protection', 'combat_survivability:defence']) {
            expect(brainDropKeep(base({ idleReason: () => reason }))).toBeDefined();
        }
    });

    test('a finite brain job (quest) runs to its end at any age and drop count', () => {
        const run = { accounts: ['WellHung'], started: NOW - 3 * BRAIN_RUN_MIN_MS, brain: true, finite: true };
        expect(brainDropKeep(base({ run, dropCycles: 9 }))).toBe('finite job runs to its end');
    });

    test('an old repeating run stops only after BRAIN_DROP_CYCLES cycles in a row drop it', () => {
        const run = { accounts: ['WellHung'], started: NOW - BRAIN_RUN_MIN_MS - 1, brain: true };
        expect(brainDropKeep(base({ run, dropCycles: BRAIN_DROP_CYCLES - 1 }))).toBeDefined();
        expect(brainDropKeep(base({ run, dropCycles: BRAIN_DROP_CYCLES }))).toBeUndefined();
    });

    test('a stop of all runs, a disabled brain, a hand run or a real plan change stops the run', () => {
        expect(brainDropKeep(base({ stopAll: true }))).toBeUndefined();
        expect(brainDropKeep(base({ brainActive: false }))).toBeUndefined();
        expect(brainDropKeep(base({ run: { accounts: ['WellHung'], started: NOW - 1000 } }))).toBeUndefined();
        expect(brainDropKeep(base({ handAccount: () => true }))).toBeUndefined();
        expect(brainDropKeep(base({ held: () => true }))).toBeUndefined();
        expect(brainDropKeep(base({ ended: () => true }))).toBeUndefined();
        expect(brainDropKeep(base({ replacement: () => 'fleet_trade' }))).toBeUndefined();
        expect(brainDropKeep(base({ replacement: () => 'session_recovery' }))).toBeUndefined();
        for (const reason of ['dead', 'paused_owner', 'side_paused_owner', 'in_trade', 'reserved_for_transfer', 'owned_by_other_side:cloud']) {
            expect(brainDropKeep(base({ idleReason: () => reason }))).toBeUndefined();
        }
    });

    test('countBrainDrops counts each new brain cycle once and forgets a run the plan holds again', () => {
        const drops = new Map<string, { cycles: number; cycleAt: number }>();
        countBrainDrops(drops, new Set(['a']), 100);
        countBrainDrops(drops, new Set(['a']), 100);
        expect(drops.get('a')!.cycles).toBe(1);
        countBrainDrops(drops, new Set(['a']), 200);
        expect(drops.get('a')!.cycles).toBe(2);
        countBrainDrops(drops, new Set(), 300);
        expect(drops.has('a')).toBe(false);
    });
});

test('a brain run that a swarm stop ended is released; an owner stop, no food or a flee stays stopped', async () => {
    const { brainStopEnd, SWARM_STOP } = await import('../src/swarm');
    const own = 'stopped after 1 runs';
    expect(brainStopEnd(own, 'RESULT fail stop file', SWARM_STOP.removed)).toBe('released: stopped after 1 runs');
    expect(brainStopEnd(own, 'RESULT fail Error: live admission paused by stop file', undefined)).toBe('released: stopped after 1 runs');
    expect(brainStopEnd(own, 'RESULT fail Error: cargo stopped chain rounds=1 ok=0 failed=1', SWARM_STOP.drain)).toBe('released: stopped after 1 runs');
    // The owner's own stop file text keeps the end.
    expect(brainStopEnd(own, 'RESULT fail stop file', 'owner: hold for the barcrawl test')).toBe(own);
    // Stops that need a resupply or a heal first.
    expect(brainStopEnd(own, 'RESULT fail no food', undefined)).toBe(own);
    expect(brainStopEnd(own, 'RESULT fail ticks=40 hp=3 fled=true', undefined)).toBe(own);
    // Other ends are untouched.
    expect(brainStopEnd('blocked after 2 runs', 'RESULT fail stop file', undefined)).toBe('blocked after 2 runs');
});

test('a finite brain run (a location recovery) that a re-plan drops at a combat floor runs to its end', () => {
    const run = { accounts: ['BackdoorMan'], started: NOW - 7_000, brain: true, finite: true };
    expect(brainDropKeep(base({ run, idleReason: () => 'combat_survivability:defence' }))).toBe('finite job runs to its end');
    // A death or an owner pause still stops it.
    expect(brainDropKeep(base({ run, idleReason: () => 'dead' }))).toBeUndefined();
    expect(brainDropKeep(base({ run, idleReason: () => 'paused_owner' }))).toBeUndefined();
});
