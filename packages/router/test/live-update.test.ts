import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { TRADE_HOLD_MS, preloadOnlyChange, addedPreloads, releaseClosure, applyUpdate, coordinatorHolds, gitIn, liveRuns, mergedDeliveryCopies, mergeText, parseStatus, rebasableDeliveryEdits, patchChangedFiles, patchCollisions, planUpdate, qualificationSource, readCheckout, reloadsFor, resetVendor, vendorExact, vendorReleaseFiles, vendorState, type UpdateInput } from '../src/live-update';
import { liveUpdateFile, reloadDue } from '../../core/src/live-reload';
import { releaseFiles, workerLaunchers } from '../../core/src/worker-release';
import { importClosure } from '../src/delivery-cli';

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

test('an unmerged delivery edit moves on top of master when the three-way merge is clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'rebase-delivery-')), snap = join(root, 'snap'), dir = join(root, '.practice', 'coordinator', 'delivery-prs');
    try {
        mkdirSync(join(snap, 'scripts'), { recursive: true }); mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'scripts'));
        const head = 'a\nb\nc\nd\ne\n', build = 'A\nb\nc\nd\ne\n', master = 'a\nb\nc\nd\nE\n', clash = 'X\nb\nc\nd\ne\n';
        writeFileSync(join(snap, 'scripts', 'q.ts'), build); writeFileSync(join(root, 'scripts', 'q.ts'), build);
        const record = (state: string) => writeFileSync(join(dir, 't9.json'), JSON.stringify({ taskId: 't9', files: ['scripts/q.ts'], snapshot: snap, state }));
        const hash = (p: string) => existsSync(p) ? readFileSync(p, 'utf8') : null;
        const files = { head: () => head, target: (p: string) => p === 'scripts/q.ts' ? master : null, local: (p: string) => hash(join(root, p)) };
        const dirty = [{ path: 'scripts/q.ts', sameAsTarget: false, untracked: false }];
        record('pending');
        const r = rebasableDeliveryEdits(root, dirty, ['scripts/q.ts'], files, mergeText, hash, {});
        expect(r.get('scripts/q.ts')).toEqual({ text: 'A\nb\nc\nd\nE\n', taskId: 't9' });
        // A Windows build copy with CRLF line ends merges by lines, the same as LF.
        writeFileSync(join(snap, 'scripts', 'q.ts'), build.replaceAll('\n', '\r\n')); writeFileSync(join(root, 'scripts', 'q.ts'), build.replaceAll('\n', '\r\n'));
        expect(rebasableDeliveryEdits(root, dirty, ['scripts/q.ts'], files, mergeText, hash, {}).get('scripts/q.ts')?.text).toBe('A\nb\nc\nd\nE\n');
        writeFileSync(join(snap, 'scripts', 'q.ts'), build); writeFileSync(join(root, 'scripts', 'q.ts'), build);
        // Master changed the same line: a conflict waits as before.
        expect(rebasableDeliveryEdits(root, dirty, ['scripts/q.ts'], { ...files, target: () => clash }, mergeText, hash, {}).size).toBe(0);
        // A local edit that is not the delivery's waits as before.
        writeFileSync(join(root, 'scripts', 'q.ts'), 'someone else\n');
        expect(rebasableDeliveryEdits(root, dirty, ['scripts/q.ts'], files, mergeText, hash, {}).size).toBe(0);
        // The merged text written by an earlier update is still the delivery's while it waits, and once it merged
        // the copy is adopted.
        writeFileSync(join(root, 'scripts', 'q.ts'), 'A\nb\nc\nd\nE\n');
        const marks = { 'scripts/q.ts': { hash: 'A\nb\nc\nd\nE\n', taskId: 't9' } };
        expect(rebasableDeliveryEdits(root, dirty, ['scripts/q.ts'], { ...files, head: () => master, target: () => 'a\nb\nc\nd\nE\nf\n' }, mergeText, hash, marks).get('scripts/q.ts')?.text)
            .toBe('A\nb\nc\nd\nE\nf\n');
        writeFileSync(join(dir, 't9.json'), JSON.stringify({ taskId: 't9', files: ['scripts/q.ts'], snapshot: snap, state: 'opened', url: 'https://x/pull/9' }));
        expect([...mergedDeliveryCopies(root, dirty, () => true, hash, marks)]).toEqual(['scripts/q.ts']);
        expect([...mergedDeliveryCopies(root, dirty, () => true, hash, { 'scripts/q.ts': { hash: 'A\nb\nc\nd\nE\n', taskId: 'other' } })]).toEqual([]);
        // The plan moves a file that carries a merge result.
        expect(planUpdate({ ...base, incoming: ['scripts/q.ts'], dirty: [{ ...dirty[0]!, rebase: 'x' }] }).action).toBe('update');
        expect(planUpdate({ ...base, incoming: ['scripts/q.ts'], dirty })).toEqual({ action: 'wait', reason: 'local edit differs from master: scripts/q.ts' });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mergeText returns the clean merge, or null on a conflict', () => {
    expect(mergeText('A\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')).toBe('A\nb\nc\nd\nE\n');
    expect(mergeText('X\nb\n', 'a\nb\n', 'Y\nb\n')).toBeNull();
});

test('a local copy of a merged coordinator delivery is adopted; an unmerged or edited copy still waits', () => {
    const root = mkdtempSync(join(tmpdir(), 'merged-copies-')), snap = join(root, 'snap'), dir = join(root, '.practice', 'coordinator', 'delivery-prs');
    mkdirSync(join(snap, 'scripts'), { recursive: true }); mkdirSync(dir, { recursive: true }); mkdirSync(join(root, 'scripts'));
    writeFileSync(join(snap, 'scripts', 'a.ts'), 'build'); writeFileSync(join(snap, 'scripts', 'b.ts'), 'build-b');
    writeFileSync(join(root, 'scripts', 'a.ts'), 'build'); writeFileSync(join(root, 'scripts', 'b.ts'), 'edited later');
    const record = (taskId: string, state: string, url?: string) => writeFileSync(join(dir, taskId + '.json'), JSON.stringify({ taskId, files: ['scripts/a.ts', 'scripts/b.ts'], snapshot: snap, state, ...(url ? { url } : {}) }));
    const hash = (p: string) => existsSync(p) ? readFileSync(p, 'utf8') : null;
    const dirty = [{ path: 'scripts/a.ts', sameAsTarget: false, untracked: false }, { path: 'scripts/b.ts', sameAsTarget: false, untracked: false }];
    record('t1', 'opened', 'https://x/pull/1');
    expect([...mergedDeliveryCopies(root, dirty, () => false, hash)]).toEqual([]);
    expect([...mergedDeliveryCopies(root, dirty, url => url === 'https://x/pull/1', hash)]).toEqual(['scripts/a.ts']);
    record('t1', 'conflict');
    expect([...mergedDeliveryCopies(root, dirty, () => true, hash)]).toEqual([]);
    record('t1', 'empty');
    expect([...mergedDeliveryCopies(root, dirty, () => false, hash)]).toEqual(['scripts/a.ts']);
    // The plan adopts the merged copy and still waits on the other local edit.
    const plan = (b: boolean) => planUpdate({ ...base, incoming: ['scripts/a.ts', 'scripts/b.ts'], dirty: [{ ...dirty[0]!, mergedDelivery: true }, { ...dirty[1]!, mergedDelivery: b }] });
    expect(plan(false)).toEqual({ action: 'wait', reason: 'local edit differs from master: scripts/b.ts' });
    expect(plan(true)).toEqual({ action: 'update', adopt: [{ ...dirty[0]!, mergedDelivery: true }, { ...dirty[1]!, mergedDelivery: true }] });
});

test('a running qualification holds only an update that changes a file it can check', () => {
    const q = { ...base, qualifications: ['qualification q runs'] };
    expect(planUpdate({ ...q, incoming: ['packages/dashboard/client-shell.js', 'packages/dashboard/server.ts', 'docs/a.md', 'scripts/x.test.ts', 'research/INDEX.md'] })).toEqual({ action: 'update', adopt: [] });
    expect(planUpdate(q)).toEqual({ action: 'wait', reason: 'qualification q runs and checks scripts/swarm.ts' });
    for (const f of ['packages/core/src/bot.ts', 'packages/router/src/coordinator.ts', 'knowledge/items.json', 'vendor/rs-sdk/sdk/actions.ts', 'patches/rs-sdk-working.patch', 'bun.lock'])
        expect(planUpdate({ ...q, incoming: ['docs/a.md', f] }).action).toBe('wait');
    expect(qualificationSource('packages/dashboard/gen-item-alch.ts')).toBe(false);
    expect(qualificationSource('packages/core/test/ledger.test.ts')).toBe(false);
    expect(qualificationSource('scripts/goldfarm.ts')).toBe(true);
    expect(qualificationSource('vendor/rs-sdk/server/webclient/src/client.ts')).toBe(true);
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
        expect(coordinatorHolds(dir, () => workspace)).toEqual({ holds: [], heldFiles: [], qualifications: [] });
        writeFileSync(join(workspace, '.workspace.json'), JSON.stringify({ base: { 'scripts/owned.ts': 'h', 'scripts/new.ts': null } }));
        writeFileSync(join(coordination, 'state.json'), JSON.stringify({ tasks: [
            { status: 'running', spec: { id: 'qualify-a', kind: 'qualify' } }, { status: 'succeeded', spec: { id: 'qualify-b', kind: 'qualify' } },
            { status: 'running', spec: { id: 'build-c', kind: 'build', capability: 'cap' } }, { status: 'running', spec: { id: 'run-d', kind: 'run' } }] }));
        writeFileSync(join(coordination, 'publish-request.json'), '{}');
        expect(coordinatorHolds(dir, () => workspace)).toEqual({ holds: ['a build waits to publish'], heldFiles: ['scripts/owned.ts', 'scripts/new.ts'], qualifications: ['qualification qualify-a runs'] });
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

function adoptionFixture(dir: string) {
    const origin = join(dir, 'origin'), main = join(dir, 'main'); mkdirSync(origin);
    const run = (cwd: string, ...args: string[]) => {
        const r = gitIn(cwd)('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args);
        if (!r.ok) throw Error(args.join(' ') + ': ' + r.out); return r.out;
    };
    run(origin, 'init', '--quiet', '--initial-branch=master');
    for (const file of ['a.txt', 'b.txt', 'unrelated.txt']) writeFileSync(join(origin, file), 'base\n');
    run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'base');
    run(dir, 'clone', '--quiet', origin, main); run(main, 'config', 'core.autocrlf', 'false');
    for (const file of ['a.txt', 'b.txt']) writeFileSync(join(origin, file), 'target ' + file + '\n');
    run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'target'); run(main, 'fetch', '--quiet', 'origin', 'master');
    writeFileSync(join(main, 'a.txt'), 'staged A\n'); run(main, 'add', 'a.txt');
    writeFileSync(join(main, 'a.txt'), 'delivered A\r\n'); writeFileSync(join(main, 'b.txt'), 'delivered B\n');
    writeFileSync(join(main, 'unrelated.txt'), 'keep staged\n'); run(main, 'add', 'unrelated.txt');
    const git = gitIn(main), beforeIndex = git('diff', '--cached', '--binary').out, beforeHead = git('rev-parse', 'HEAD').out;
    const beforeEntries = Object.fromEntries(['a.txt', 'b.txt'].map(file => [file, git('rev-parse', ':' + file).out]));
    const adopt = [{ path: 'a.txt', untracked: false, sameAsTarget: false, rebase: 'rebased A\n' },
        { path: 'b.txt', untracked: false, sameAsTarget: false, mergedDelivery: true }];
    return { origin, main, git, adopt, beforeIndex, beforeHead, beforeEntries, run };
}

test('a refused merge restores delivered working bytes and exact staged contents without changing unrelated staging', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir);
        const refused = applyUpdate((...args) => args[0] === 'merge' ? { ok: false, out: 'injected merge refusal' } : f.git(...args), f.main, 'origin/master', f.adopt);
        expect(refused).toEqual({ ok: false, detail: 'merge refused: injected merge refusal' });
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('delivered A\r\n');
        expect(readFileSync(join(f.main, 'b.txt'), 'utf8')).toBe('delivered B\n');
        expect(f.git('diff', '--cached', '--binary').out).toBe(f.beforeIndex);
        expect(f.git('rev-parse', 'HEAD').out).toBe(f.beforeHead);
    });
});

test('a refused update with a CRLF checkout restores the exact original delivery bytes and staging', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir); f.run(f.main, 'config', 'core.autocrlf', 'true');
        let merged = false;
        const refused = applyUpdate((...args) => {
            if (args[0] !== 'merge') return f.git(...args);
            merged = true;
            expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('target a.txt\r\n');
            return { ok: false, out: 'injected merge refusal' };
        }, f.main, 'origin/master', f.adopt);
        expect(merged).toBe(true);
        expect(refused).toEqual({ ok: false, detail: 'merge refused: injected merge refusal' });
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('delivered A\r\n');
        expect(readFileSync(join(f.main, 'b.txt'), 'utf8')).toBe('delivered B\n');
        expect(f.git('diff', '--cached', '--binary').out).toBe(f.beforeIndex);
    });
});

test('a later adoption refusal rolls back every earlier adopted path', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir);
        const refused = applyUpdate((...args) => args[0] === 'checkout' && args.at(-1) === 'b.txt'
            ? { ok: false, out: 'injected checkout refusal' } : f.git(...args), f.main, 'origin/master', f.adopt);
        expect(refused.detail).toBe('adopt b.txt: injected checkout refusal');
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('delivered A\r\n');
        expect(readFileSync(join(f.main, 'b.txt'), 'utf8')).toBe('delivered B\n');
        expect(f.git('diff', '--cached', '--binary').out).toBe(f.beforeIndex);
    });
});

test('an already-deleted adopted tracked file fast-forwards without reviving or staging the file', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir);
        f.run(f.origin, 'rm', '--quiet', 'b.txt'); f.run(f.origin, 'commit', '--quiet', '-m', 'remove obsolete source');
        f.run(f.main, 'fetch', '--quiet', 'origin', 'master');
        // Keep only the independently staged file; b.txt already has the deletion master needs.
        f.run(f.main, 'checkout', 'HEAD', '--', 'a.txt'); unlinkSync(join(f.main, 'b.txt'));
        const out = applyUpdate(f.git, f.main, 'origin/master', [{ path: 'b.txt', untracked: false, sameAsTarget: true }]);
        expect(out).toEqual({ ok: true, detail: '' });
        expect(existsSync(join(f.main, 'b.txt'))).toBe(false);
        expect(f.git('ls-files', '--', 'b.txt').out).toBe('');
        expect(f.git('show', ':unrelated.txt').out).toBe('keep staged');
    });
});

test('a held index lock does not prevent working-copy recovery and is preserved with durable original index entries', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir), lock = resolve(f.main, f.git('rev-parse', '--git-path', 'index.lock').out);
        const refused = applyUpdate((...args) => {
            if (args[0] !== 'merge') return f.git(...args);
            writeFileSync(lock, 'another Git writer'); return { ok: false, out: 'index is locked' };
        }, f.main, 'origin/master', f.adopt);
        expect(refused.ok).toBe(false); expect(refused.detail).toContain('rollback incomplete:');
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('delivered A\r\n');
        expect(readFileSync(join(f.main, 'b.txt'), 'utf8')).toBe('delivered B\n');
        expect(readFileSync(lock, 'utf8')).toBe('another Git writer');
        const recovery = /; originals: (.+)$/.exec(refused.detail)![1]!;
        const originals = JSON.parse(readFileSync(recovery, 'utf8'));
        expect(Buffer.from(originals[0].work.base64, 'base64').toString()).toBe('delivered A\r\n');
        expect(originals[0].index.object).toBe(f.beforeEntries['a.txt']!);
        expect(Buffer.from(originals[0].index.base64, 'base64').toString()).toBe('staged A\n');
        expect(originals.every((copy: any) => copy.index?.object)).toBe(true);
        unlinkSync(lock);
    });
});

test('an edit made immediately after checkout is not claimed by the updater or overwritten during rollback', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir);
        const refused = applyUpdate((...args) => {
            const result = f.git(...args);
            if (args[0] === 'checkout' && args.at(-1) === 'a.txt' && result.ok) {
                writeFileSync(join(f.main, 'a.txt'), 'concurrent after checkout\n');
                const staged = f.git('add', '--', 'a.txt'); if (!staged.ok) throw Error(staged.out);
            }
            return result;
        }, f.main, 'origin/master', f.adopt);
        expect(refused.ok).toBe(false); expect(refused.detail).toContain('changed concurrently during adoption');
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('concurrent after checkout\n');
        expect(f.git('show', ':a.txt').out).toBe('concurrent after checkout');
        expect(readFileSync(join(f.main, 'b.txt'), 'utf8')).toBe('delivered B\n');
        expect(f.git('rev-parse', 'HEAD').out).toBe(f.beforeHead);
        const recovery = /; originals: (.+)$/.exec(refused.detail)![1]!;
        expect(JSON.parse(readFileSync(recovery, 'utf8'))[0].index.object).toBe(f.beforeEntries['a.txt']!);
    });
});

test.skipIf(process.platform === 'win32')('a mode change immediately after checkout is not overwritten during rollback', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir); f.run(f.main, 'config', 'core.filemode', 'true');
        const refused = applyUpdate((...args) => {
            const result = f.git(...args);
            if (args[0] === 'checkout' && args.at(-1) === 'a.txt' && result.ok) chmodSync(join(f.main, 'a.txt'), 0o755);
            return result;
        }, f.main, 'origin/master', f.adopt);
        expect(refused.ok).toBe(false); expect(refused.detail).toContain('changed concurrently during adoption');
        expect(statSync(join(f.main, 'a.txt')).mode & 0o111).not.toBe(0);
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('target a.txt\n');
        expect(f.git('rev-parse', 'HEAD').out).toBe(f.beforeHead);
        const recovery = /; originals: (.+)$/.exec(refused.detail)![1]!;
        expect(Buffer.from(JSON.parse(readFileSync(recovery, 'utf8'))[0].work.base64, 'base64').toString()).toBe('delivered A\r\n');
    });
});

test('rollback preserves a concurrent edit and staged change and retains the displaced originals for recovery', () => {
    scratch('rsbot-adopt-rollback-', dir => {
        const f = adoptionFixture(dir);
        const refused = applyUpdate((...args) => {
            if (args[0] !== 'merge') return f.git(...args);
            writeFileSync(join(f.main, 'a.txt'), 'concurrent A\n');
            const staged = f.git('add', '--', 'a.txt'); if (!staged.ok) throw Error(staged.out);
            return { ok: false, out: 'refused after another writer' };
        }, f.main, 'origin/master', f.adopt);
        expect(refused.ok).toBe(false); expect(refused.detail).toContain('changed concurrently');
        expect(readFileSync(join(f.main, 'a.txt'), 'utf8')).toBe('concurrent A\n');
        expect(f.git('show', ':a.txt').out).toBe('concurrent A');
        expect(readFileSync(join(f.main, 'b.txt'), 'utf8')).toBe('delivered B\n');
        expect(f.git('show', ':b.txt').out).toBe('base');
        expect(f.git('show', ':unrelated.txt').out).toBe('keep staged');
        const recovery = /; originals: (.+)$/.exec(refused.detail)![1]!;
        const originals = JSON.parse(readFileSync(recovery, 'utf8'));
        expect(Buffer.from(originals[0].work.base64, 'base64').toString()).toBe('delivered A\r\n');
    });
});

test('a changed SDK patch that alters a worker release file waits for a live run', () => {
    const before = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n'
        + 'diff --git a/sdk/x.ts b/sdk/x.ts\n--- a/sdk/x.ts\n+++ b/sdk/x.ts\n@@ -1 +1 @@\n-x\n+y\n'
        + 'diff --git a/server/webclient/src/lite/s.ts b/server/webclient/src/lite/s.ts\n--- a/server/webclient/src/lite/s.ts\n+++ b/server/webclient/src/lite/s.ts\n@@ -1 +1 @@\n-s\n+t\n';
    const engineOnly = before.replace('+two', '+three') + 'diff --git a/server/engine/new.ts b/server/engine/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/server/engine/new.ts\n@@ -0,0 +1 @@\n+n\n';
    // A change of line ends or of the last newline is not a change of the patch.
    expect(patchChangedFiles(before, before.replace(/\n/g, '\r\n').trimEnd())).toEqual([]);
    expect(patchChangedFiles(before, engineOnly)).toEqual(['a.txt', 'server/engine/new.ts']);
    expect(vendorReleaseFiles(before, engineOnly)).toEqual([]);
    expect(vendorReleaseFiles(before, before.replace('+y', '+z'))).toEqual(['vendor/rs-sdk/sdk/x.ts']);
    expect(vendorReleaseFiles(before, before.replace('-s\n+t', '-s\n+u'))).toEqual(['vendor/rs-sdk/server/webclient/src/lite/s.ts']);
    // A folder with no patch that gets one, and a patch that goes away: each release file of the patch changes.
    expect(vendorReleaseFiles('', before)).toEqual(['vendor/rs-sdk/sdk/x.ts', 'vendor/rs-sdk/server/webclient/src/lite/s.ts']);
    expect(vendorReleaseFiles(before, '')).toEqual(['vendor/rs-sdk/sdk/x.ts', 'vendor/rs-sdk/server/webclient/src/lite/s.ts']);

    const run = { name: 'Runner', files: ['scripts/blood-chest.ts'] }, release = ['vendor/rs-sdk/sdk/x.ts'];
    expect(planUpdate({ ...base, liveRuns: [run], vendorRelease: release })).toEqual({ action: 'wait', reason: 'the live run of Runner loads vendor/rs-sdk/sdk/x.ts (changed by the SDK patch)' });
    expect(planUpdate({ ...base, liveRuns: [], vendorRelease: release }).action).toBe('update');
    expect(planUpdate({ ...base, liveRuns: [run], vendorRelease: [] }).action).toBe('update');
});

test('the SDK folder gets a new patch only when it held exactly the old patch or no patch', () => {
    scratch('rsbot-live-sdk-', root => {
        const vendor = join(root, 'vendor', 'rs-sdk'), patch = join(root, 'patches', 'rs-sdk-working.patch');
        expect(vendorState(root)).toBeNull(); expect(vendorExact(root)).toBeNull();
        mkdirSync(join(vendor, 'sdk'), { recursive: true }); mkdirSync(join(root, 'patches'));
        const run = (...args: string[]) => { const r = gitIn(vendor)('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args); if (!r.ok) throw Error(args.join(' ') + ': ' + r.out); return r.out; };
        const lines = (first: string, last = 'line 20') => [first, ...Array.from({ length: 18 }, (_, n) => `line ${n + 2}`), last].join('\n') + '\n';
        const file = (name: string) => readFileSync(join(vendor, name), 'utf8');
        run('init', '--quiet', '--initial-branch=master'); run('config', 'core.autocrlf', 'false');
        writeFileSync(join(vendor, 'package.json'), '{}\n'); writeFileSync(join(vendor, 'a.txt'), lines('one')); writeFileSync(join(vendor, 'keep.txt'), 'keep\n'); writeFileSync(join(vendor, 'sdk', 'x.ts'), 'x\n');
        run('add', '.'); run('commit', '--quiet', '-m', 'pinned');
        // A patch from an edit of the folder; the folder goes back to the pinned commit.
        const made = (edit: () => void, created: string[]): string => {
            edit(); run('add', '-N', '--', ...created);
            const text = run('diff') + '\n';
            run('reset', '--quiet'); run('checkout', '--', '.'); for (const name of created) rmSync(join(vendor, name));
            return text;
        };
        const first = made(() => { writeFileSync(join(vendor, 'a.txt'), lines('patched one')); writeFileSync(join(vendor, 'made.txt'), 'made\n'); }, ['made.txt']);
        const second = made(() => { writeFileSync(join(vendor, 'a.txt'), lines('patched two')); writeFileSync(join(vendor, 'other.txt'), 'other\n'); writeFileSync(join(vendor, 'sdk', 'x.ts'), 'y\n'); }, ['other.txt']);
        expect(patchChangedFiles(first, second)).toEqual(['a.txt', 'made.txt', 'other.txt', 'sdk/x.ts']);

        writeFileSync(patch, first);
        expect(vendorState(root)).toBe('clean'); expect(vendorExact(root)).toBe('clean');
        // A file that the folder does not track is not an edit of the SDK.
        writeFileSync(join(vendor, 'market.sqlite'), 'data');
        expect(vendorExact(root)).toBe('clean');
        run('apply', patch);
        expect(vendorState(root)).toBe('applied'); expect(vendorExact(root)).toBe('applied');
        const index = run('ls-files', '--stage');

        // An edit of a file outside the patch, and an edit in a patch file far from the patch: `git apply --check -R`
        // passes for both, and a restore would discard them. The exact check names them.
        writeFileSync(join(vendor, 'keep.txt'), 'my edit\n');
        expect(vendorState(root)).toBe('applied'); expect(vendorExact(root)).toBe('other');
        writeFileSync(join(vendor, 'keep.txt'), 'keep\n');
        writeFileSync(join(vendor, 'a.txt'), lines('patched one', 'my line'));
        expect(vendorState(root)).toBe('applied'); expect(vendorExact(root)).toBe('other');
        writeFileSync(join(vendor, 'a.txt'), lines('patched one'));
        // A file that the patch creates, with other content.
        writeFileSync(join(vendor, 'made.txt'), 'mine\n');
        expect(vendorExact(root)).toBe('other');
        writeFileSync(join(vendor, 'made.txt'), 'made\n');
        expect(vendorExact(root)).toBe('applied');
        // The exact check uses index files of its own.
        expect(run('ls-files', '--stage')).toBe(index);

        // A local file where the new patch creates one is in the way. A file that both patches create is not, and a
        // file that the new patch creates and that is not there is not.
        expect(patchCollisions(root, first, second)).toEqual([]);
        writeFileSync(join(vendor, 'other.txt'), 'my notes\n');
        expect(patchCollisions(root, first, second)).toEqual(['other.txt']);
        expect(patchCollisions(root, first, first)).toEqual([]);
        expect(patchCollisions(root, '', first)).toEqual(['made.txt']);
        // A reset with that file there removes nothing of it: the apply fails, and the file holds its content.
        writeFileSync(patch, second);
        const blocked = resetVendor(root, first);
        expect(blocked.ok).toBe(false); expect(file('other.txt')).toBe('my notes\n');
        rmSync(join(vendor, 'other.txt')); writeFileSync(patch, first); run('apply', patch);
        expect(vendorExact(root)).toBe('applied');

        // The old patch is staged in the folder's index, as after `git add`. The restore takes the pinned commit, so the
        // staged patch does not come back, and the index stays as it was.
        // A local file that is staged there, and that no patch names, is not a file of the old patch. The reset
        // touches only the files of the old patch, so that file and a later edit of it stay.
        writeFileSync(join(vendor, 'mine.txt'), 'staged\n');
        run('add', '--', 'a.txt', 'made.txt', 'mine.txt');
        writeFileSync(join(vendor, 'mine.txt'), 'staged, then edited\n');
        const staged = run('ls-files', '--stage');
        expect(staged).not.toBe(index);
        expect(vendorExact(root)).toBe('applied');

        // The update moved the patch file: the folder gets the new patch, and the file that only the old patch made goes.
        writeFileSync(patch, second);
        expect(vendorExact(root)).toBe('other');
        expect(resetVendor(root, first)).toEqual({ ok: true, detail: '' });
        expect(run('ls-files', '--stage')).toBe(staged);
        expect(file('a.txt')).toBe(lines('patched two')); expect(file('other.txt')).toBe('other\n'); expect(file('sdk/x.ts')).toBe('y\n');
        expect(existsSync(join(vendor, 'made.txt'))).toBe(false);
        expect(file('market.sqlite')).toBe('data');
        expect(vendorState(root)).toBe('applied'); expect(vendorExact(root)).toBe('applied');

        // A patch that does not apply: the result says so, and the folder holds the pinned files.
        writeFileSync(patch, second.replace('-one', '-not there'));
        const failed = resetVendor(root, second);
        expect(failed.ok).toBe(false); expect(failed.detail).toMatch(/^apply of patches\/rs-sdk-working\.patch: /);
        expect(file('a.txt')).toBe(lines('one')); expect(existsSync(join(vendor, 'other.txt'))).toBe(false);
        // No patch file in the new commit: the folder goes back to the pinned files.
        writeFileSync(patch, second); expect(resetVendor(root, '')).toEqual({ ok: true, detail: '' });
        rmSync(patch);
        expect(resetVendor(root, second)).toEqual({ ok: true, detail: '' });
        expect(file('a.txt')).toBe(lines('one')); expect(file('sdk/x.ts')).toBe('x\n'); expect(existsSync(join(vendor, 'other.txt'))).toBe(false);
        expect(vendorExact(root)).toBe('clean');
        // Through each reset above, the staged local file and the file that the SDK does not track kept their content.
        expect(file('mine.txt')).toBe('staged, then edited\n'); expect(file('market.sqlite')).toBe('data');
        expect(file('keep.txt')).toBe('keep\n');
    });
}, 60_000);

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

test('a fleet trade session holds an update that changes a file it loads: its entry is an absolute path', () => {
    scratch('rsbot-live-trade-', dir => {
        const status = join(dir, '.practice', 'status'), now = 10_000_000;
        mkdirSync(status, { recursive: true });
        writeFileSync(join(dir, 'swarm.json'), JSON.stringify({ jobs: [] }));
        const row = (name: string, more: object) => writeFileSync(join(status, name + '.json'), JSON.stringify({ name, server: 'live', at: now - 1000, started: now - 60_000, workRevision: 'a'.repeat(64), ...more }));
        // The fleet agent gives its trade workers the absolute path of the script (scripts/fleet-agent.ts tradeEnvironment).
        row('Giver', { workEntry: join(dir, 'scripts', 'fleet-trade.ts') });
        const asked: string[][] = [];
        const closure = (entries: string[]) => { asked.push(entries); return entries.includes('scripts/fleet-trade.ts') ? ['scripts/fleet-trade.ts', 'packages/core/src/inprocess.ts'] : []; };
        const runs = liveRuns(dir, 'live', closure, now);
        expect(asked).toEqual([['scripts/fleet-trade.ts']]);
        expect(runs).toEqual([{ name: 'Giver', files: ['scripts/fleet-trade.ts', 'packages/core/src/inprocess.ts'] }]);
        expect(planUpdate({ ...base, incoming: ['packages/core/src/inprocess.ts'], liveRuns: runs })).toEqual({ action: 'wait', reason: 'the live run of Giver loads packages/core/src/inprocess.ts' });
        // A trade session ends with its order window. One that still writes its status after TRADE_HOLD_MS holds no update.
        row('Giver', { workEntry: join(dir, 'scripts', 'fleet-trade.ts'), started: now - TRADE_HOLD_MS + 1000 });
        expect(liveRuns(dir, 'live', closure, now)).toHaveLength(1);
        row('Giver', { workEntry: join(dir, 'scripts', 'fleet-trade.ts'), started: now - TRADE_HOLD_MS });
        expect(liveRuns(dir, 'live', closure, now)).toEqual([]);
        // The limit is for a trade only: a coordinator run of that age still holds.
        row('Giver', { workEntry: 'scripts/a.ts', coordinatorRunId: 'task-1', started: now - 3 * TRADE_HOLD_MS });
        expect(liveRuns(dir, 'live', entries => entries.map(e => e + '+imports'), now)).toEqual([{ name: 'Giver', files: ['scripts/a.ts+imports'] }]);
    });
});

test('a live trade holds an update that changes a data or task file of its release: the hold reads the files that make the release id', () => {
    scratch('rsbot-live-release-', dir => {
        const repo = resolve(import.meta.dir, '../../..'), now = 10_000_000, status = join(dir, '.practice', 'status');
        mkdirSync(status, { recursive: true });
        writeFileSync(join(status, 'Giver.json'), JSON.stringify({ name: 'Giver', server: 'live', at: now - 1000, started: now - 60_000, workEntry: join(dir, 'scripts', 'fleet-trade.ts') }));
        const runs = liveRuns(dir, 'live', releaseClosure(repo), now);
        expect(runs).toHaveLength(1);
        // The same list as the release id of the worker (worker-release.ts capabilityRevision): the entry and the launchers.
        expect(runs[0]!.files).toEqual(releaseFiles(['scripts/fleet-trade.ts', ...workerLaunchers], repo));
        // A data file that the trade release holds and no import reaches: the import closure of the entry lacks it.
        const data = 'packages/planner/data/progression-routes.json';
        expect(importClosure(['scripts/fleet-trade.ts'], repo)).not.toContain(data);
        for (const file of [data, 'packages/router/tasks/owned-bank-observation.json', 'scripts/fleet-trade.ts']) {
            expect(runs[0]!.files, file).toContain(file);
            expect(planUpdate({ ...base, incoming: [file], liveRuns: runs }).action, file).toBe('wait');
        }
        // A file that is not in the release does not hold.
        expect(planUpdate({ ...base, incoming: ['docs/a.md'], liveRuns: runs }).action).toBe('update');
        // A run with no entry has no release files to name here (the launch release): it holds nothing by this list.
        writeFileSync(join(status, 'Giver.json'), JSON.stringify({ name: 'Giver', server: 'live', at: now - 1000, started: now - 60_000 }));
        expect(liveRuns(dir, 'live', releaseClosure(repo), now)).toEqual([{ name: 'Giver', files: [] }]);
    });
}, 60_000);

test('a live run whose entry gives no file holds each update: the files it loads are not known', () => {
    scratch('rsbot-live-unknown-', dir => {
        const status = join(dir, '.practice', 'status'), now = 10_000_000;
        mkdirSync(status, { recursive: true });
        writeFileSync(join(dir, 'swarm.json'), JSON.stringify({ jobs: [] }));
        writeFileSync(join(status, 'Lost.json'), JSON.stringify({ name: 'Lost', server: 'live', at: now - 1000, workEntry: 'scripts/gone.ts', workRevision: 'a'.repeat(64) }));
        const runs = liveRuns(dir, 'live', () => [], now);
        expect(runs).toEqual([{ name: 'Lost', files: [], unknown: true }]);
        expect(planUpdate({ ...base, liveRuns: runs })).toEqual({ action: 'wait', reason: 'the live run of Lost has an entry that this checkout cannot read: its files are not known' });
        // A row with no entry is as before: it names no file.
        writeFileSync(join(status, 'Lost.json'), JSON.stringify({ name: 'Lost', server: 'live', at: now - 1000, workRevision: 'a'.repeat(64) }));
        expect(liveRuns(dir, 'live', () => [], now)).toEqual([{ name: 'Lost', files: [] }]);
    });
});

const BUNFIG_BEFORE = 'preload = ["./packages/core/src/collision-lazy.ts"]\n\n[test]\npreload = ["./packages/core/src/collision-lazy.ts"]\n';
const BUNFIG_AFTER = 'preload = ["./packages/core/src/collision-lazy.ts", "./packages/core/src/bunzip-cache.ts"]\n\n[test]\npreload = ["./packages/core/src/collision-lazy.ts", "./packages/core/src/bunzip-cache.ts"]\n';
test('a bunfig change that only touches preload lines is no dependency change, and any other manifest change still waits', () => {
    expect(preloadOnlyChange(BUNFIG_BEFORE, BUNFIG_AFTER)).toBe(true);
    expect(addedPreloads(BUNFIG_BEFORE, BUNFIG_AFTER)).toEqual(['packages/core/src/bunzip-cache.ts']);
    // The same text, a change outside the preload lines, or a CRLF checkout.
    expect(preloadOnlyChange(BUNFIG_BEFORE, BUNFIG_BEFORE)).toBe(false);
    expect(preloadOnlyChange(BUNFIG_BEFORE, BUNFIG_AFTER + '[install]\nregistry = "https://example.invalid"\n')).toBe(false);
    expect(preloadOnlyChange(BUNFIG_BEFORE, BUNFIG_AFTER.replace('[test]', '[test.x]'))).toBe(false);
    expect(preloadOnlyChange(BUNFIG_BEFORE.replaceAll('\n', '\r\n'), BUNFIG_AFTER)).toBe(true);
    // Without the flag, and with the flag, for bunfig alone and next to another manifest.
    const base2: UpdateInput = { ...base, incoming: ['bunfig.toml', 'packages/core/src/bunzip-cache.ts'] };
    expect(planUpdate(base2)).toEqual({ action: 'wait', reason: 'dependency change needs bun install: bunfig.toml' });
    expect(planUpdate({ ...base2, bunfigPreloadOnly: false }).action).toBe('wait');
    expect(planUpdate({ ...base2, bunfigPreloadOnly: true })).toEqual({ action: 'update', adopt: [] });
    expect(planUpdate({ ...base2, incoming: ['bunfig.toml', 'package.json'], bunfigPreloadOnly: true })).toEqual({ action: 'wait', reason: 'dependency change needs bun install: package.json' });
    expect(planUpdate({ ...base2, incoming: ['bun.lock'], bunfigPreloadOnly: true }).action).toBe('wait');
});
test('readCheckout flags a bunfig that adds a preload file that the target holds, and not one that adds a missing file', () => {
    scratch('rsbot-live-bunfig-', dir => {
        const origin = join(dir, 'origin'), main = join(dir, 'main');
        mkdirSync(origin);
        const run = (cwd: string, ...args: string[]) => { const r = gitIn(cwd)('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args); if (!r.ok) throw Error(args.join(' ') + ': ' + r.out); };
        run(origin, 'init', '--quiet', '--initial-branch=master');
        mkdirSync(join(origin, 'packages/core/src'), { recursive: true });
        writeFileSync(join(origin, 'bunfig.toml'), BUNFIG_BEFORE); writeFileSync(join(origin, 'packages/core/src/collision-lazy.ts'), 'export {};\n');
        run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'first');
        run(dir, 'clone', '--quiet', origin, main); run(main, 'config', 'core.autocrlf', 'false');
        // The target adds the preload file and names it.
        writeFileSync(join(origin, 'bunfig.toml'), BUNFIG_AFTER); writeFileSync(join(origin, 'packages/core/src/bunzip-cache.ts'), 'export {};\n');
        run(origin, 'add', '.'); run(origin, 'commit', '--quiet', '-m', 'second');
        run(main, 'fetch', '--quiet', 'origin', 'master');
        const held = readCheckout(gitIn(main), main, 'origin/master');
        expect([...held.incoming].sort()).toEqual(['bunfig.toml', 'packages/core/src/bunzip-cache.ts']);
        expect(held.bunfigPreloadOnly).toBe(true);
        expect(planUpdate({ ...held, holds: [], heldFiles: [] }).action).toBe('update');
        // A target that names a preload file that it does not hold is a dependency change as before.
        run(origin, 'rm', '--quiet', 'packages/core/src/bunzip-cache.ts'); run(origin, 'commit', '--quiet', '-m', 'third');
        run(main, 'fetch', '--quiet', 'origin', 'master');
        const missing = readCheckout(gitIn(main), main, 'origin/master');
        expect(missing.bunfigPreloadOnly).toBe(false);
        expect(planUpdate({ ...missing, holds: [], heldFiles: [] })).toEqual({ action: 'wait', reason: 'dependency change needs bun install: bunfig.toml' });
        // An update that does not touch bunfig.toml carries no flag.
        const plain = readCheckout(gitIn(main), main, 'origin/master~1');
        expect('bunfigPreloadOnly' in plain).toBe(plain.incoming.includes('bunfig.toml'));
    });
}, 60_000);

test('a fleet trade session does not hold an update when its partner failed pre-login admission without a receipt', () => {
    scratch('rsbot-live-trade-deadlock-', dir => {
        const now = 10_000_000, status = join(dir, '.practice', 'status');
        const fleetDir = join(dir, '.practice', 'fleet-data', 'fleet');
        const orders = join(fleetDir, 'orders'), receipts = join(fleetDir, 'receipts'), prelogin = join(fleetDir, 'prelogin-failed');
        mkdirSync(status, { recursive: true });
        mkdirSync(orders, { recursive: true });
        mkdirSync(receipts, { recursive: true });
        writeFileSync(join(dir, 'swarm.json'), JSON.stringify({ jobs: [] }));
        writeFileSync(join(fleetDir, 'owners.json'), JSON.stringify({
            accounts: {
                Giver: { side: 'local', server: 'live' },
                Taker: { side: 'local', server: 'live' },
                CloudTaker: { side: 'cloud', server: 'live' },
            },
        }));
        const trade = { id: 'o-hold', server: 'live', from: 'Giver', to: 'Taker', item: 'Nature rune', count: 344, start: now - 120_000, end: now + 1_800_000 };
        writeFileSync(join(orders, 'o-hold.json'), JSON.stringify(trade));
        writeFileSync(join(receipts, 'o-hold.from.json'), JSON.stringify({
            version: 2, state: 'prepared', id: 'o-hold', account: 'Giver', partner: 'Taker', role: 'from',
            side: 'local', server: 'live', item: 'Nature rune', requested: 344, claim: '12345678-1234-1234-1234-123456789012',
            count: 0, ok: false, at: now - 60_000, detail: 'trade claimed',
        }));
        writeFileSync(join(status, 'Giver.json'), JSON.stringify({
            name: 'Giver', server: 'live', at: now - 1000, started: now - 60_000,
            workRevision: 'a'.repeat(64), workEntry: join(dir, 'scripts', 'fleet-trade.ts'),
        }));
        const closure = (entries: string[]) => entries.includes('scripts/fleet-trade.ts') ? ['scripts/fleet-trade.ts', 'packages/core/src/inprocess.ts'] : [];
        // Healthy local partner (logout check passes): Giver holds the update.
        expect(liveRuns(dir, 'live', closure, now, { fleetDir, side: 'local', checkLogout: () => {} })).toHaveLength(1);
        // Partner fails liveLogoutRef pre-login without writing a failed receipt: Giver no longer holds the update.
        expect(liveRuns(dir, 'live', closure, now, {
            fleetDir, side: 'local', checkLogout: () => { throw Error('account logout is not confirmed: Taker ended stopped'); },
        })).toEqual([]);
        // Owner stop file on partner also releases the hold.
        writeFileSync(join(dir, '.practice', 'stop-taker'), 'owner pause');
        expect(liveRuns(dir, 'live', closure, now, { fleetDir, side: 'local', checkLogout: () => {} })).toEqual([]);
        unlinkSync(join(dir, '.practice', 'stop-taker'));
        // Active partner session (currently trading) keeps the hold even if checkLogout would throw.
        writeFileSync(join(status, 'Taker.json'), JSON.stringify({
            name: 'Taker', server: 'live', at: now - 1000, started: now - 30_000,
            workRevision: 'a'.repeat(64), workEntry: join(dir, 'scripts', 'fleet-trade.ts'),
        }));
        expect(liveRuns(dir, 'live', closure, now, {
            fleetDir, side: 'local', checkLogout: () => { throw Error('held while active'); },
        }).map(r => r.name).sort()).toEqual(['Giver', 'Taker']);
        unlinkSync(join(status, 'Taker.json'));
        // Cross-side partner holds until prelogin-failed arrives via sync, then releases immediately.
        writeFileSync(join(orders, 'o-hold.json'), JSON.stringify({ ...trade, to: 'CloudTaker' }));
        expect(liveRuns(dir, 'live', closure, now, {
            fleetDir, side: 'local', checkLogout: () => { throw Error('not on this side'); },
        })).toHaveLength(1);
        mkdirSync(prelogin, { recursive: true });
        writeFileSync(join(prelogin, 'o-hold.to.json'), JSON.stringify({
            version: 1, id: 'o-hold', role: 'to', account: 'CloudTaker', partner: 'Giver',
            server: 'live', at: now - 5_000, detail: 'account logout is not confirmed',
        }));
        expect(liveRuns(dir, 'live', closure, now, { fleetDir, side: 'local', checkLogout: () => {} })).toEqual([]);
    });
});

test('a running specialist or main launch holds live-update and returns wait naming it', () => {
    scratch('rsbot-live-launch-', dir => {
        const coordination = join(dir, '.practice', 'coordinator');
        mkdirSync(coordination, { recursive: true });
        writeFileSync(join(coordination, 'state.json'), JSON.stringify({
            tasks: [
                { status: 'succeeded', spec: { id: 'run-done', kind: 'run', launch: 'specialist', account: 'PrevSpec' } },
                { status: 'running', spec: { id: 'run-ordinary', kind: 'run', launch: 'ordinary', account: 'Helper' } },
                { status: 'running', spec: { id: 'run-shaftshooter', kind: 'run', launch: 'specialist', account: 'Shaftshooter' } },
            ],
        }));
        const specHold = coordinatorHolds(dir, () => dir);
        expect(specHold.holds).toEqual(['specialist launch Shaftshooter runs']);
        expect(planUpdate({
            branch: 'master', ahead: 0, behind: 1, incoming: ['packages/router/src/goal-work.ts'], dirty: [],
            ...specHold,
        })).toEqual({ action: 'wait', reason: 'specialist launch Shaftshooter runs' });

        writeFileSync(join(coordination, 'state.json'), JSON.stringify({
            tasks: [{ status: 'running', spec: { id: 'run-haggis', kind: 'run', launch: 'main', account: 'Haggis' } }],
        }));
        const mainHold = coordinatorHolds(dir, () => dir);
        expect(mainHold.holds).toEqual(['main launch Haggis runs']);
        expect(planUpdate({
            branch: 'master', ahead: 0, behind: 1, incoming: ['README.md'], dirty: [],
            ...mainHold,
        })).toEqual({ action: 'wait', reason: 'main launch Haggis runs' });
    });
});
