import { describe, expect, test } from 'bun:test';
import { COOLDOWN_MS, MAX_PER_DAY, launchRequest, planLaunches, readConfig, type Config, type Launch } from './cloud-launch';
import { LIVE_MS } from '../packages/core/src/fleet-assign';

const NOW = 1_800_000_000_000;
const config: Config = { maxClaude: 1, maxCodex: 1, sides: [
    { side: 'claude-cloud', kind: 'claude', via: 'routine', routine: 'trig_abc', tokenFile: '.practice/cloud-launch/t' },
    { side: 'claude-cloud-2', kind: 'claude', via: 'cli' },
    { side: 'cloud', kind: 'codex', env: 'env-1' },
] };
const plan = (o: Partial<Parameters<typeof planLaunches>[0]> = {}) => planLaunches({ config, seen: new Map(), owned: new Map([['claude-cloud', 14], ['cloud', 15]]), stranded: 0, history: [], now: NOW, ...o }).map(s => s.side);

describe('cloud launch', () => {
    test('starts one silent side of each kind within the caps', () => {
        expect(plan()).toEqual(['claude-cloud', 'cloud']);
        expect(plan({ config: { ...config, maxClaude: 2 }, stranded: 3 })).toEqual(['claude-cloud', 'claude-cloud-2', 'cloud']);
        expect(plan({ config: { ...config, enabled: false } })).toEqual([]);
    });

    test('a live side counts against its kind\'s cap and is not started', () => {
        expect(plan({ seen: new Map([['claude-cloud', NOW - LIVE_MS + 1]]), stranded: 5 })).toEqual(['cloud']);
        expect(plan({ seen: new Map([['claude-cloud', NOW - LIVE_MS]]) })).toEqual(['claude-cloud', 'cloud']);
    });

    test('a side with no accounts starts only when some side\'s accounts are stranded', () => {
        const owned = new Map([['cloud', 15]]);
        expect(plan({ owned, config: { ...config, sides: config.sides.filter(s => s.side !== 'claude-cloud') } })).toEqual(['cloud']);
        expect(plan({ owned, stranded: 2, config: { ...config, sides: config.sides.filter(s => s.side !== 'claude-cloud') } })).toEqual(['claude-cloud-2', 'cloud']);
    });

    test('cooldown, a starting session and the daily cap hold a side', () => {
        const recent: Launch[] = [{ side: 'claude-cloud', kind: 'claude', via: 'routine', at: NOW - COOLDOWN_MS + 1, ok: true, detail: '' }];
        // Its session is still starting: it holds the Claude cap, so claude-cloud-2 waits too.
        expect(plan({ history: recent, stranded: 4 })).toEqual(['cloud']);
        const failed: Launch[] = [{ ...recent[0]!, ok: false }];
        expect(plan({ history: failed, stranded: 4 })).toEqual(['claude-cloud-2', 'cloud']);
        const many: Launch[] = Array.from({ length: MAX_PER_DAY }, (_, i) => ({ side: 'cloud', kind: 'codex', via: 'codex', at: NOW - COOLDOWN_MS - i * 60_000, ok: true, detail: '' }));
        expect(plan({ history: many })).toEqual(['claude-cloud']);
    });

    test('requests: the routine fire, the claude CLI and the codex CLI each carry the one-command prompt', () => {
        const r = launchRequest(config.sides[0]!, 'tok');
        expect(r).toMatchObject({ kind: 'http', url: 'https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire' });
        if (r.kind === 'http') { expect(r.headers.authorization).toBe('Bearer tok'); expect(r.headers['anthropic-version']).toBe('2023-06-01'); }
        expect(() => launchRequest(config.sides[0]!)).toThrow('no token');
        const cli = launchRequest(config.sides[1]!);
        expect(cli.kind === 'exec' && cli.cmd.slice(0, 2)).toEqual(['claude', '--cloud']);
        const codex = launchRequest(config.sides[2]!);
        expect(codex.kind === 'exec' && codex.cmd.slice(0, 5)).toEqual(['codex', 'cloud', 'exec', '--env', 'env-1']);
        expect(codex.kind === 'exec' && codex.cmd[5]).toContain('--side cloud --watch-minutes 50');
        const native = launchRequest({ side: 'cloud', kind: 'codex', env: 'env-1', bin: 'C:\\codex\\codex.exe', watchMinutes: 30 });
        expect(native.kind === 'exec' && native.cmd[0]).toBe('C:\\codex\\codex.exe');
        expect(native.kind === 'exec' && native.cmd[5]).toContain('--watch-minutes 30 --stop-at-end');
    });

    test('config validation', () => {
        expect(readConfig(JSON.stringify(config)).sides).toHaveLength(3);
        expect(() => readConfig('{"sides":[{"side":"local","kind":"claude","via":"cli"}]}')).toThrow('bad side');
        expect(() => readConfig('{"sides":[{"side":"cloud","kind":"codex"}]}')).toThrow('Codex env');
        expect(() => readConfig('{"sides":[{"side":"claude-cloud","kind":"claude","routine":"trig_x"}]}')).toThrow('token');
    });
});
