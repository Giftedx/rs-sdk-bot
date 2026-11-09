import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { publisherRepo, stalled, STALL_MS } from '../src/watchdog';
import { launcherScript } from '../src/watchdog-install';
import { improved, progressOf } from '../src/coverage';

const p = (skillLevels: number, questsLive = 3) => ({ skillLevels, skills99: 7, questsLive, questTotal: 68, itemsHeld: 94, actionsNamed: 2325, done: false, remaining: [] });

test('a stall needs STALL_MS without any progress number rising', () => {
    const h = [{ at: 0, progress: p(100) }, { at: 1000, progress: p(101) }, { at: STALL_MS, progress: p(101) }];
    expect(stalled(h, STALL_MS)).toBeNull();
    expect(stalled(h, STALL_MS + 1000)).toEqual({ since: 1000, last: p(101) });
    expect(stalled([{ at: 0, progress: p(100) }], STALL_MS - 1)).toBeNull();
    expect(improved(p(100), p(100, 4))).toBe(true);
});

test('done needs every skill at 99, every quest live, every tradeable item and every action', () => {
    const b = (level: number, live: number) => ({ skills: [{ skill: 'Magic', bestLive: level }], quests: { liveComplete: Array(live).fill('q'), folders: [{ qp: 1 }, { qp: 1 }] }, items: { held: 2, tradeable: 2, tradeableHeld: 2 }, totals: { actions: 5, actionsNamed: 5 } });
    expect(progressOf(b(99, 2)).done).toBe(true);
    expect(progressOf(b(98, 2)).remaining).toEqual(['Magic 98/99']);
    expect(progressOf(b(99, 1)).remaining).toEqual(['quests 1/2 live']);
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
