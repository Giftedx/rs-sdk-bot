import { describe, expect, test } from 'bun:test';
import { DEFAULT_WATCH_MINUTES, MAX_RESTARTS_PER_HOUR, daemonCommand, mayRestart, newPlan, parseOptions, sessionPrompt } from './cloud-side';

describe('cloud side bootstrap', () => {
    test('options: the side comes from the flag or FLEET_SIDE, never local', () => {
        expect(parseOptions([], { FLEET_SIDE: 'claude-cloud' })).toEqual({ side: 'claude-cloud', watchMinutes: DEFAULT_WATCH_MINUTES, capacity: 4, stopAtEnd: false, setupOnly: false });
        expect(parseOptions(['--side', 'cloud', '--watch-minutes', '50', '--stop-at-end', '--capacity', '8'], {})).toMatchObject({ side: 'cloud', watchMinutes: 50, capacity: 8, stopAtEnd: true });
        expect(() => parseOptions([], {})).toThrow('cloud fleet side');
        expect(() => parseOptions(['--side', 'local'], {})).toThrow('cloud fleet side');
        expect(() => parseOptions(['--side', 'cloud', '--watch-minutes', '0'], {})).toThrow('watch-minutes');
    });

    test('a launched session is told to run one command and nothing else', () => {
        const claude = sessionPrompt('claude', 'claude-cloud');
        expect(claude).toContain('bun scripts/cloud-side.ts --side claude-cloud --watch-minutes 110');
        expect(claude).toContain('run_in_background');
        expect(claude).toContain('RESULT stop');
        const codex = sessionPrompt('codex', 'cloud');
        expect(codex).toContain('bun scripts/cloud-side.ts --side cloud --watch-minutes 50 --stop-at-end');
        expect(codex).not.toContain('run_in_background');
        expect(() => sessionPrompt('claude', 'local')).toThrow();
    });

    test('daemons and restarts', () => {
        expect(daemonCommand('swarm', 'p.json')).toEqual(['scripts/swarm.ts', 'p.json']);
        expect(daemonCommand('autopilot', 'p.json')).toEqual(['scripts/autopilot.ts', 'p.json', '--daemon']);
        expect(daemonCommand('fleet-agent', 'p.json')).toEqual(['scripts/fleet-agent.ts']);
        const now = 10 * 60 * 60_000, recent = Array.from({ length: MAX_RESTARTS_PER_HOUR }, (_, i) => now - i * 60_000);
        expect(mayRestart(recent, now)).toBe(false);
        expect(mayRestart(recent.map(t => t - 60 * 60_000), now)).toBe(true);
        expect(newPlan(6)).toEqual({ maxBots: 4, minFreeGB: 4, fleetCapacity: 6, jobs: [] });
    });
});
