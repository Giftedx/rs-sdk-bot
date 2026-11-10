import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { applyUpdate, coordinatorHolds, gitIn, liveRuns, parseStatus, planUpdate, readCheckout, reloadsFor, type UpdateInput } from '../src/live-update';
import { liveUpdateFile, reloadDue } from '../../core/src/live-reload';

const base: UpdateInput = { branch: 'master', ahead: 0, behind: 2, incoming: ['scripts/swarm.ts', 'docs/a.md'], dirty: [], holds: [], heldFiles: [] };

test('an update moves only a clean master checkout that nothing holds', () => {
    expect(planUpdate(base)).toEqual({ action: 'update', adopt: [] });
    expect(planUpdate({ ...base, branch: 'claude/topic' })).toEqual({ action: 'none', reason: 'checkout is on claude/topic' });
    expect(planUpdate({ ...base, behind: 0 })).toEqual({ action: 'none', reason: 'current' });
    expect(planUpdate({ ...base, ahead: 1 })).toEqual({ action: 'wait', reason: '1 local commits are not on origin/master' });
    expect(planUpdate({ ...base, holds: ['qualification q runs'] })).toEqual({ action: 'wait', reason: 'qualification q runs' });
    expect(planUpdate({ ...base, heldFiles: ['scripts/swarm.ts'] })).toEqual({ action: 'wait', reason: 'a running build owns scripts/swarm.ts' });
    expect(planUpdate({ ...base, heldFiles: ['scripts/other.ts'] }).action).toBe('update');
    expect(planUpdate({ ...base, incoming: ['tsconfig.json'] }).action).toBe('wait');
    expect(planUpdate({ ...base, incoming: ['packages/core/package.json'] })).toEqual({ action: 'wait', reason: 'dependency change needs bun install: packages/core/package.json' });
});

test('a live coordinator run holds an update that changes a file it loads; a standing job does not', () => {
    expect(planUpdate({ ...base, liveRuns: [{ name: 'Runner', files: ['scripts/blood-chest.ts', 'scripts/swarm.ts'] }] })).toEqual({ action: 'wait', reason: 'the live run of Runner loads scripts/swarm.ts' });
    expect(planUpdate({ ...base, liveRuns: [{ name: 'Runner', files: ['scripts/blood-chest.ts'] }] }).action).toBe('update');
    scratch('rsbot-live-runs-', dir => {
        const status = join(dir, '.practice', 'status'), rev = 'a'.repeat(64), now = 1_000_000;
        mkdirSync(status, { recursive: true });
        writeFileSync(join(dir, 'swarm.json'), JSON.stringify({ jobs: [{ account: 'Farmer', standing: true }] }));
        const row = (name: string, more: object) => writeFileSync(join(status, name + '.json'), JSON.stringify({ name, server: 'live', at: now - 1000, workEntry: 'scripts/a.ts,scripts/b.ts', workRevision: rev, ...more }));
        row('Runner', { coordinatorRunId: 'task-1' }); row('Farmer', {}); row('Done', { coordinatorRunId: 'task-2', result: 'ok' });
        row('Gone', { coordinatorRunId: 'task-3', at: now - 300_000 }); row('Practice', { coordinatorRunId: 'task-4', server: 'localhost' });
        expect(liveRuns(dir, 'live', entries => entries.map(e => e + '+imports'), now)).toEqual([{ name: 'Runner', files: ['scripts/a.ts+imports', 'scripts/b.ts+imports'] }]);
    });
});

test('a local edit holds the update unless it already has the bytes of master', () => {
    const same = { path: 'scripts/swarm.ts', sameAsTarget: true, untracked: false }, other = { path: 'swarm.json', sameAsTarget: false, untracked: false };
    // An edit to a file that the update does not change never matters.
    expect(planUpdate({ ...base, dirty: [same, other] })).toEqual({ action: 'update', adopt: [same] });
    expect(planUpdate({ ...base, dirty: [{ ...same, sameAsTarget: false }] })).toEqual({ action: 'wait', reason: 'local edit differs from master: scripts/swarm.ts' });
});

test('status records and daemon closures are read as git and the import graph give them', () => {
    expect(parseStatus(' M scripts/a.ts\0?? packages/x/new file.json\0R  scripts/b.ts\0scripts/old.ts\0')).toEqual([
        { path: 'scripts/a.ts', untracked: false }, { path: 'packages/x/new file.json', untracked: true },
        { path: 'scripts/b.ts', untracked: false }, { path: 'scripts/old.ts', untracked: false }]);
    expect(reloadsFor(['packages/core/src/fleet.ts'], { autopilot: ['scripts/autopilot.ts', 'packages/core/src/fleet.ts'], coordinator: ['packages/router/src/coordinator-cli.ts'] })).toEqual(['autopilot']);
    expect(reloadsFor(['docs/a.md'], { autopilot: ['scripts/autopilot.ts'] })).toEqual([]);
});

const scratch = (name: string, body: (dir: string) => void) => {
    const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, name));
    try { body(dir); } finally { if (new RegExp(`^${name}[^\\\\/]+$`).test(relative(parent, dir))) rmSync(dir, { recursive: true, force: true }); }
};

test('the coordinator holds an update for a running qualification and names the files of a running build', () => {
    scratch('rsbot-live-hold-', dir => {
        const coordination = join(dir, '.practice', 'coordinator'), workspace = join(dir, 'build', 'cap');
        mkdirSync(coordination, { recursive: true }); mkdirSync(workspace, { recursive: true });
        expect(coordinatorHolds(dir, () => workspace)).toEqual({ holds: [], heldFiles: [] });
        writeFileSync(join(workspace, '.workspace.json'), JSON.stringify({ base: { 'scripts/owned.ts': 'h', 'scripts/new.ts': null } }));
        writeFileSync(join(coordination, 'state.json'), JSON.stringify({ tasks: [
            { status: 'running', spec: { id: 'qualify-a', kind: 'qualify' } }, { status: 'succeeded', spec: { id: 'qualify-b', kind: 'qualify' } },
            { status: 'running', spec: { id: 'build-c', kind: 'build', capability: 'cap' } }, { status: 'running', spec: { id: 'run-d', kind: 'run' } }] }));
        writeFileSync(join(coordination, 'publish-request.json'), '{}');
        expect(coordinatorHolds(dir, () => workspace)).toEqual({ holds: ['a build waits to publish', 'qualification qualify-a runs'], heldFiles: ['scripts/owned.ts', 'scripts/new.ts'] });
        writeFileSync(join(coordination, 'state.json'), '{');
        expect(coordinatorHolds(dir, () => workspace).holds).toContain('coordinator state is not readable');
    });
});

test('a fast-forward adopts files that already hold the bytes of master and refuses a different edit', () => {
    scratch('rsbot-live-git-', dir => {
        const origin = join(dir, 'origin'), main = join(dir, 'main');
        mkdirSync(origin);
        const run = (cwd: string, ...args: string[]) => { const r = gitIn(cwd)('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args); if (!r.ok) throw Error(args.join(' ') + ': ' + r.out); return r.out; };
        run(origin, 'init', '--quiet', '--initial-branch=master');
        writeFileSync(join(origin, 'a.txt'), 'one\n'); writeFileSync(join(origin, 'keep.txt'), 'keep\n');
        run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'first');
        run(dir, 'clone', '--quiet', origin, main);
        // The updater's own git calls read the repository's settings: keep the bytes the same on every host.
        run(main, 'config', 'core.autocrlf', 'false');
        writeFileSync(join(origin, 'a.txt'), 'two\n'); writeFileSync(join(origin, 'new.txt'), 'new\n');
        run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'second');
        run(main, 'fetch', '--quiet', 'origin', 'master');
        // A delivery wrote master's bytes here before its pull request merged; keep.txt holds an unrelated edit.
        writeFileSync(join(main, 'a.txt'), 'two\n'); writeFileSync(join(main, 'new.txt'), 'new\n'); writeFileSync(join(main, 'keep.txt'), 'local\n');
        const git = gitIn(main), checkout = readCheckout(git, main, 'origin/master');
        expect(checkout).toMatchObject({ branch: 'master', ahead: 0, behind: 1, incoming: ['a.txt', 'new.txt'] });
        expect(checkout.dirty).toEqual([{ path: 'a.txt', untracked: false, sameAsTarget: true }, { path: 'new.txt', untracked: true, sameAsTarget: true }]);
        const plan = planUpdate({ ...checkout, holds: [], heldFiles: [] });
        if (plan.action !== 'update') throw Error('expected an update');
        expect(applyUpdate(git, main, 'origin/master', plan.adopt)).toEqual({ ok: true, detail: '' });
        expect(run(main, 'rev-parse', 'HEAD')).toBe(run(origin, 'rev-parse', 'HEAD'));
        expect(readFileSync(join(main, 'keep.txt'), 'utf8')).toBe('local\n');
        expect(run(main, 'status', '--porcelain')).toBe(' M keep.txt');

        writeFileSync(join(origin, 'keep.txt'), 'theirs\n'); writeFileSync(join(origin, 'late.txt'), 'late\n');
        run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'third');
        run(main, 'fetch', '--quiet', 'origin', 'master');
        writeFileSync(join(main, 'late.txt'), 'late\n');
        const next = readCheckout(git, main, 'origin/master');
        expect(planUpdate({ ...next, holds: [], heldFiles: [] })).toEqual({ action: 'wait', reason: 'local edit differs from master: keep.txt' });
        // A merge that git refuses leaves the bytes of an adopted untracked file in place.
        const refused = applyUpdate(git, main, 'origin/master', next.dirty.filter(d => d.sameAsTarget));
        expect(refused.ok).toBe(false);
        expect(readFileSync(join(main, 'late.txt'), 'utf8')).toBe('late\n');
        expect(readFileSync(join(main, 'keep.txt'), 'utf8')).toBe('local\n');
    });
});

test('a daemon reloads only for an update that is newer than its start and names it', () => {
    scratch('rsbot-live-mark-', dir => {
        expect(reloadDue(dir, 'autopilot', 0)).toBe(false);
        mkdirSync(join(dir, '.practice'));
        writeFileSync(liveUpdateFile(dir), JSON.stringify({ at: 100, from: 'a', to: 'b', files: 1, reload: ['autopilot'] }));
        expect(reloadDue(dir, 'autopilot', 50)).toBe(true);
        expect(reloadDue(dir, 'autopilot', 100)).toBe(false);
        expect(reloadDue(dir, 'fleet-agent', 50)).toBe(false);
        writeFileSync(liveUpdateFile(dir), '{');
        expect(reloadDue(dir, 'autopilot', 50)).toBe(false);
        expect(existsSync(liveUpdateFile(dir))).toBe(true);
    });
});
