import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { publisherRepo, recoveryLog, restartCommand, stalled, STALL_MS } from '../src/watchdog';
import { launcherScript } from '../src/watchdog-install';
import { improved, progressOf } from '../src/coverage';

test('a restart uses the recorded plan of the autopilot and starts nothing without that file', () => {
    const plan = 'C:/fleet/.practice/cloud-handoff/swarm.json', there = (p: string) => p === plan;
    expect(restartCommand('fleet-agent', { args: [], env: { DEMO_OK: '1' } }, () => false)).toEqual(['scripts/fleet-agent.ts', '--daemon']);
    expect(restartCommand('autopilot', { args: [plan], env: {} }, there)).toEqual(['scripts/autopilot.ts', plan, '--daemon']);
    for (const args of [[], ['C:/fleet/gone.json'], ['--dry'], [plan, '--dry'], [plan, plan]]) expect(restartCommand('autopilot', { args, env: {} }, there), args.join(' ')).toMatch(/^its recorded plan is not a file/);
});

const p =(skillLevels: number, questsLive = 3) => ({ skillLevels, skills99: 7, questsLive, questTotal: 68, itemsHeld: 94, actionsNamed: 2325, goalVersion: 1 as const, goalMetrics: { 'army.levels': skillLevels, 'quests.complete': questsLive }, done: false, remaining: [] });

test('a stall needs STALL_MS without any progress number rising', () => {
    const h = [{ at: 0, progress: p(100) }, { at: 1000, progress: p(101) }, { at: STALL_MS, progress: p(101) }];
    expect(stalled(h, STALL_MS)).toBeNull();
    expect(stalled(h, STALL_MS + 1000)).toEqual({ since: 1000, last: p(101) });
    expect(stalled([{ at: 0, progress: p(100) }], STALL_MS - 1)).toBeNull();
    expect(improved(p(100), p(100, 4))).toBe(true);
});

test('coverage totals cannot complete the owner goals or hide a goal stall', () => {
    const b = (level: number, live: number) => ({ skills: [{ skill: 'Magic', bestLive: level }], quests: { liveComplete: Array(live).fill('q'), folders: [{ qp: 1 }, { qp: 1 }] }, items: { held: 2, tradeable: 2, tradeableHeld: 2 }, totals: { actions: 5, actionsNamed: 5 } });
    expect(progressOf(b(99, 2)).done).toBe(false);
    expect(progressOf(b(99, 2)).remaining).toContain('Owner goal observations unavailable');
    const before=p(100), after={...p(100),skillLevels:1881,skills99:19,itemsHeld:2756,actionsNamed:5807};
    expect(improved(before,after)).toBe(false);
    expect(stalled([{at:0,progress:before},{at:STALL_MS,progress:after}],STALL_MS)).not.toBeNull();
    expect(improved(before,{...after,goalMetrics:{...before.goalMetrics,'main.gap':-100}})).toBe(false);
    expect(improved({...before,goalMetrics:{'main.gap':-100}}, {...after,goalMetrics:{'main.gap':-50}})).toBe(true);
});

test('legacy coverage history cannot claim progress under the owner goal contract',()=>{
    const legacy={...p(100),goalVersion:undefined,goalMetrics:undefined};
    expect(improved(legacy,{...legacy,actionsNamed:5807,skillLevels:1881})).toBe(false);
    expect(stalled([{at:0,progress:legacy},{at:STALL_MS,progress:p(100)}],STALL_MS)).toBeNull();
});

test('a restored observation below the recorded high water does not clear a stall',()=>{
 const history=[{at:0,progress:p(100)},{at:1000,progress:p(0)},{at:STALL_MS,progress:p(100)}];
 expect(stalled(history,STALL_MS)).toEqual({since:0,last:p(100)});
 expect(stalled([...history,{at:STALL_MS+1,progress:p(101)}],STALL_MS+1)).toBeNull();
});

test('the hidden launcher runs the watchdog with window style 0 from the repo', () => {
    const bun = join('C:', 'bun', 'bun.exe'), repo = join('F:', 'repo'), v = launcherScript(bun, repo);
    expect(v).toContain(`shell.CurrentDirectory = "${repo}"`);
    expect(v).toContain(`""${bun}"" ""${join(repo, 'packages', 'router', 'src', 'watchdog.ts')}""", 0, False`);
});

test('the publisher repository comes from the clone origin URL', () => {
    expect(publisherRepo('https://github.com/Giftedx/rs-fleet-command.git\n')).toBe('Giftedx/rs-fleet-command');
    expect(publisherRepo('git@github.com:Giftedx/rs-fleet-command')).toBe('Giftedx/rs-fleet-command');
    expect(publisherRepo('https://example.com/a/b.git')).toBeNull();
    expect(publisherRepo('')).toBeNull();
});

test('the watchdog log takes the recovery lines of a call, and the exit of a call that failed or did not end', () => {
    const out = 'noise\nCLOUD_RECOVER submitting local-recovery-qualified-x, local-recover-bigpackage-x (Bigpackage endedAt 5)\r\nSubmitted to shared queue\n';
    expect(recoveryLog(out, '', 0)).toEqual(['session recovery: submitting local-recovery-qualified-x, local-recover-bigpackage-x (Bigpackage endedAt 5)']);
    // A pass with nothing to recover adds no line.
    expect(recoveryLog('', '', 0)).toEqual([]);
    expect(recoveryLog('CLOUD_RECOVER refused: coordinator is not running\n', '', 1)).toEqual(['session recovery: refused: coordinator is not running', 'session recovery call exit 1: ']);
    expect(recoveryLog('', 'error: boom', null)).toEqual(['session recovery call did not end in time: error: boom']);
});
