import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COOLDOWN_MS, MAX_PER_DAY, launchRequest, launchDecisions, launchDecisionLine, planLaunches, readConfig, writeLaunchState, type Config, type Launch } from './cloud-launch';
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

    test('proved native busy refusals preserve attempts without spending the admission budget', () => {
        const busy:Launch={side:'cloud',kind:'codex',via:'codex',at:NOW-COOLDOWN_MS-1,ok:false,
            detail:'exit 1 CLOUD_NATIVE fail Target Cloud thread is busy; no fleet prompt was sent.'};
        const history=[...Array.from({length:10},(_,i)=>({...busy,at:busy.at-i*60_000})),
            ...Array.from({length:2},(_,i)=>({...busy,at:NOW-6*60*60_000-i*60_000,ok:true,detail:'admitted'}))];
        const saved=JSON.stringify(history);
        expect(plan({history})).toContain('cloud');
        const decision=launchDecisions({config,seen:new Map(),owned:new Map([['cloud',14]]),stranded:0,history,now:NOW}).find(d=>d.config.side==='cloud')!;
        expect(decision).toMatchObject({reason:'due',attempts24h:12,budgeted24h:2});
        expect(JSON.stringify(history)).toBe(saved);

        // The refusal still backs off and never overrides a current controller or provider cap.
        expect(plan({history:[...history,{...busy,at:NOW-1}]})).not.toContain('cloud');
        expect(launchDecisions({config,seen:new Map(),owned:new Map([['cloud',14]]),stranded:0,history:[{...busy,at:NOW-1}],now:NOW}).find(d=>d.config.side==='cloud')!.reason).toBe('cooldown');
        expect(plan({history,seen:new Map([['cloud',NOW]])})).not.toContain('cloud');
        expect(plan({history,config:{...config,maxCodex:0}})).not.toContain('cloud');
    });

    test('admitted, ambiguous and differently classified failures still spend all twelve slots', () => {
        const exact='exit 1 CLOUD_NATIVE fail Target Cloud thread is busy; no fleet prompt was sent.';
        const base:Launch={side:'cloud',kind:'codex',via:'codex',at:NOW-COOLDOWN_MS-1,ok:false,detail:exact};
        const counted:Launch[]=[{...base,ok:true},{...base,kind:'claude'},{...base,via:'cli'},
            {...base,detail:'busy'},{...base,detail:exact+' additional output'},
            {...base,detail:'exit 1 CLOUD_NATIVE fail Cloud admission was not confirmed. Submission remains blocked to avoid duplicates.'},
            {...base,detail:'exit null timed out'},{...base,detail:'exit 1 bootstrap failed'},{...base,detail:''}];
        for(const event of counted){
            const history=Array.from({length:MAX_PER_DAY},(_,i)=>({...event,at:event.at-i*60_000}));
            const decision=launchDecisions({config,seen:new Map(),owned:new Map([['cloud',14]]),stranded:0,history,now:NOW}).find(d=>d.config.side==='cloud')!;
            expect(decision).toMatchObject({reason:'daily-cap',attempts24h:12,budgeted24h:12});
            expect(plan({history})).not.toContain('cloud');
        }
    });

    test('the budget clearing time ignores busy refusals and retains excess counted attempts', () => {
        const oldest=NOW-24*60*60_000;
        const counted=Array.from({length:13},(_,i):Launch=>({side:'cloud',kind:'codex',via:'codex',at:oldest+(i+1)*60_000,ok:false,detail:'unknown outcome'}));
        const busy:Launch={...counted[0]!,at:oldest+1,detail:'exit 1 CLOUD_NATIVE fail Target Cloud thread is busy; no fleet prompt was sent.'};
        const history=[busy,...counted];
        const decision=launchDecisions({config,seen:new Map(),owned:new Map([['cloud',14]]),stranded:0,history,now:NOW}).find(d=>d.config.side==='cloud')!;
        expect(decision).toMatchObject({reason:'daily-cap',attempts24h:14,budgeted24h:13,retryMs:120_000});
        expect(launchDecisionLine(decision)).toBe('CLOUD_LAUNCH hold cloud: 24h admission budget 13/12 (14 attempts); retry in 120s');
    });

    test('every configured side explains its launch hold without a session link or credential', () => {
        const history: Launch[] = [{ side: 'cloud', kind: 'codex', via: 'codex', at: NOW - 60_000, ok: true, detail: 'private-session-link secret' }];
        const decisions=launchDecisions({config,seen:new Map([['claude-cloud',NOW-30_000]]),owned:new Map([['cloud',15]]),stranded:2,history,now:NOW});
        expect(decisions.map(d=>[d.config.side,d.reason])).toEqual([['claude-cloud','controller-recent'],['claude-cloud-2','provider-cap'],['cloud','starting']]);
        expect(launchDecisionLine(decisions[0]!)).toBe('CLOUD_LAUNCH hold claude-cloud: controller renewal 30s old (launch silence threshold 900s)');
        expect(launchDecisionLine(decisions[1]!)).toBe('CLOUD_LAUNCH hold claude-cloud-2: claude session cap 1/1');
        expect(launchDecisionLine(decisions[2]!)).toBe('CLOUD_LAUNCH hold cloud: admitted launch awaiting controller renewal; retry in 2340s');
        expect(decisions.map(launchDecisionLine).join('\n')).not.toMatch(/private-session-link|secret/);
    });

    test('failed-launch cooldown, daily budget, no demand and disabled config each name their clearing condition', () => {
        const input={config,seen:new Map<string,number>(),owned:new Map([['cloud',15]]),stranded:0,history:[] as Launch[],now:NOW};
        const failed:Launch={side:'cloud',kind:'codex',via:'codex',at:NOW-60_000,ok:false,detail:'busy'};
        const cooldown=launchDecisions({...input,history:[failed]}).find(d=>d.config.side==='cloud')!;
        expect(cooldown.reason).toBe('cooldown');
        expect(launchDecisionLine(cooldown)).toBe('CLOUD_LAUNCH hold cloud: last attempt failed; retry in 2340s');
        const history=Array.from({length:MAX_PER_DAY},(_,i)=>({...failed,at:NOW-COOLDOWN_MS-i*60_000}));
        const capped=launchDecisions({...input,history}).find(d=>d.config.side==='cloud')!;
        expect(capped.reason).toBe('daily-cap');
        expect(launchDecisionLine(capped)).toContain('24h admission budget 12/12 (12 attempts); retry in ');
        expect(launchDecisions(input)[0]!.reason).toBe('no-demand');
        expect(launchDecisionLine(launchDecisions(input)[0]!)).toContain('no owned or stranded accounts');
        expect(launchDecisions({...input,config:{...config,enabled:false}}).every(d=>d.reason==='disabled')).toBe(true);
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

    test('CLI --prompt rejects unknown provider kinds and missing sides with exit 2', () => {
        const badKind = Bun.spawnSync([process.execPath, 'scripts/cloud-launch.ts', '--prompt', 'bogus', 'cloud'], {
            cwd: process.cwd(),
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });
        expect(badKind.exitCode).toBe(2);
        expect(badKind.stderr.toString()).toContain('--prompt <claude|codex> <side>');

        const missingSide = Bun.spawnSync([process.execPath, 'scripts/cloud-launch.ts', '--prompt', 'claude'], {
            cwd: process.cwd(),
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
        });
        expect(missingSide.exitCode).toBe(2);
    });

    const tempDirs: string[] = [];
    afterEach(() => {
        while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    });

    test('writeLaunchState persists launch records atomically and prunes entries older than 7 days', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cloud-launch-state-'));
        tempDirs.push(dir);
        const stateFile = join(dir, 'state.json');
        const oldEntry: Launch = { side: 'cloud', kind: 'codex', via: 'codex', at: NOW - 8 * 24 * 60 * 60_000, ok: true, detail: 'old' };
        const freshEntry: Launch = { side: 'claude-cloud', kind: 'claude', via: 'routine', at: NOW - 1000, ok: true, detail: 'fired' };
        writeLaunchState(stateFile, [oldEntry, freshEntry], NOW);
        expect(existsSync(stateFile)).toBe(true);
        const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { launches: Launch[] };
        expect(saved.launches).toEqual([freshEntry]);
    });
});
