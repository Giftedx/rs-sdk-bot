import {expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {loadOwners} from '../packages/core/src/fleet';
import {reserveFleetOwner, withFleetDataWrite} from './fleet-owner-claim';
import {recoverConcurrentPlanWrite} from '../packages/core/src/plan-lock';

// A git call has 20 s: beside the 11 other processes of the local gate one call passed the 5 s it had (ETIMEDOUT).
function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, {cwd, timeout: 20_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

const lockDir = (root: string) => join(root, '.practice', 'fleet-data-write');
const lockFile = (root: string) => join(lockDir(root), 'plan-write-lock.json');
const ownerNonce = '00000000-0000-4000-8000-000000000001';
function deadIntent(root: string, pid: number) {
    const dir = lockDir(root), intent = join(dir, `plan-write-${ownerNonce}.intent.json`);
    mkdirSync(dir, {recursive: true});
    writeFileSync(intent, JSON.stringify({pid, nonce: ownerNonce, at: 1}));
    linkSync(intent, lockFile(root));
    return intent;
}

test('fleet-data writer recovers a killed process but waits for a live writer', async () => {
    const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'rsbot-fleet-lock-'));
    try {
        const marker = join(root, 'ready'), worker = join(root, 'writer.ts');
        const module = resolve(import.meta.dir, 'fleet-owner-claim.ts').replaceAll('\\', '/');
        writeFileSync(worker, `import {withFleetDataWrite} from ${JSON.stringify(module)};
import {writeFileSync} from 'node:fs';
const [root, marker] = process.argv.slice(2);
await withFleetDataWrite(root!, async () => { writeFileSync(marker!, 'ready'); await Bun.sleep(60_000); });`);
        const child = Bun.spawn([process.execPath, worker, root, marker], {windowsHide: true, stdout: 'ignore', stderr: 'pipe'});
        try {
            const deadline = Date.now() + 3000;
            while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
            expect(existsSync(marker)).toBe(true);
            const before = readFileSync(lockFile(root), 'utf8');
            await expect(withFleetDataWrite(root, () => 0, 60)).rejects.toThrow('existing owner');
            expect(readFileSync(lockFile(root), 'utf8')).toBe(before);
            child.kill('SIGKILL');
            await child.exited;
            await expect(withFleetDataWrite(root, () => 42, 1000)).resolves.toBe(42);
            expect(existsSync(lockFile(root))).toBe(false);
            const archive = join(lockDir(root), 'plan-lock-recovery');
            const records = readdirSync(archive);
            expect(records).toHaveLength(1);
            expect(readFileSync(join(archive, records[0]!), 'utf8')).toBe(before);
        } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    } finally {
        if (/^rsbot-fleet-lock-[^/\\]+$/.test(relative(parent, root))) rmSync(root, {recursive: true, force: true});
    }
}, 6000);

test('a delayed recovery cannot remove the live replacement acquired by another recoverer', async () => {
    const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'rsbot-fleet-lock-'));
    let release: (() => void) | undefined, active: Promise<void> | undefined;
    try {
        deadIntent(root, 123);
        const first = recoverConcurrentPlanWrite(lockDir(root), () => {
            expect(recoverConcurrentPlanWrite(lockDir(root), () => false)).toBe(true);
            active = withFleetDataWrite(root, () => new Promise<void>(done => { release = done; }), 100);
            return false;
        });
        expect(first).toBe(false);
        const newOwner = JSON.parse(readFileSync(lockFile(root), 'utf8'));
        expect(newOwner.pid).toBe(process.pid);
        expect(newOwner.nonce).not.toBe(ownerNonce);
        release?.();
        await active;
        expect(existsSync(lockFile(root))).toBe(false);
    } finally {
        release?.();
        await active;
        if (/^rsbot-fleet-lock-[^/\\]+$/.test(relative(parent, root))) rmSync(root, {recursive: true, force: true});
    }
});

test('a waiting fleet-data writer recovers a lock whose owner id a later process holds', async () => {
    const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'rsbot-fleet-lock-'));
    try {
        const dir = lockDir(root);
        deadIntent(root, 123);
        // The id answers a signal. A failed read proves nothing, and so does a process that started before the record.
        expect(recoverConcurrentPlanWrite(dir, () => true, () => null, 100_000)).toBe(false);
        expect(recoverConcurrentPlanWrite(dir, () => true, () => new Map([[123, 0]]), 200_000)).toBe(false);
        expect(existsSync(lockFile(root))).toBe(true);
        // Its process started after the owner wrote the record: a different process. The 25 ms loop reads the result
        // that is kept, not the process table.
        let reads = 0;
        expect(recoverConcurrentPlanWrite(dir, () => true, () => { reads++; return new Map([[123, 60_000]]); }, 300_000)).toBe(true);
        expect(reads).toBe(1);
        expect(existsSync(lockFile(root))).toBe(false);
        expect(readdirSync(dir)).toEqual(['plan-lock-recovery']);
        await expect(withFleetDataWrite(root, () => 42, 1000)).resolves.toBe(42);
    } finally {
        if (/^rsbot-fleet-lock-[^/\\]+$/.test(relative(parent, root))) rmSync(root, {recursive: true, force: true});
    }
});

test('a killed recoverer leaves a ticket that another process can take over', () => {
    const parent = resolve(tmpdir()), root = mkdtempSync(join(parent, 'rsbot-fleet-lock-'));
    try {
        const dir = lockDir(root), intent = deadIntent(root, 123);
        renameSync(intent, join(dir, `plan-recover-${ownerNonce}-456-00000000-0000-4000-8000-000000000002.intent.json`));
        expect(recoverConcurrentPlanWrite(dir, pid => pid === 456)).toBe(false);
        expect(recoverConcurrentPlanWrite(dir, () => false)).toBe(true);
        expect(existsSync(lockFile(root))).toBe(false);
        expect(readdirSync(dir)).toEqual(['plan-lock-recovery']);
    } finally {
        if (/^rsbot-fleet-lock-[^/\\]+$/.test(relative(parent, root))) rmSync(root, {recursive: true, force: true});
    }
});

test('competing fleet sides reserve one name and retry only their own durable claim', async () => {
    const parent = resolve(tmpdir()), scratch = mkdtempSync(join(parent, 'rsbot-owner-claim-'));
    try {
        const remote = join(scratch, 'remote.git'), first = join(scratch, 'first'), second = join(scratch, 'second');
        git(scratch, 'init', '--bare', remote);
        git(scratch, 'init', first);
        mkdirSync(join(first, 'fleet'));
        writeFileSync(join(first, 'fleet', 'owners.json'), JSON.stringify({accounts: {Legacy: {side: 'local', server: 'rs-sdk-demo.fly.dev'}}}));
        git(first, 'add', 'fleet/owners.json');
        git(first, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'seed registry');
        git(first, 'remote', 'add', 'origin', remote);
        git(first, 'push', 'origin', 'HEAD:refs/heads/fleet-data');
        git(scratch, 'clone', '--branch', 'fleet-data', remote, second);
        const firstFleet = join(first, 'data');
        git(first, 'worktree', 'add', '-b', 'fleet-data', firstFleet, 'origin/fleet-data');
        const orderFile = join(firstFleet, 'fleet', 'unrelated-order.json');
        writeFileSync(orderFile, 'local pending order\n');
        const firstClaim = {account: 'Quiverfull', side: 'cloud', server: 'rs-sdk-demo.fly.dev', reservation: 'task-00000000-0000-4000-8000-000000000001'};
        const secondClaim = {...firstClaim, account: 'quiverfull', side: 'claude-cloud', reservation: 'task-00000000-0000-4000-8000-000000000002'};
        const a = () => reserveFleetOwner(first, firstClaim, firstFleet, join(firstFleet, 'fleet'));
        const b = () => reserveFleetOwner(second, secondClaim, second, join(second, 'fleet'));
        const results = await Promise.all([a(), b()]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await (results[0] ? a() : b())).toBe(true);
        expect(await (results[0] ? b() : a())).toBe(false);
        const owners = loadOwners(join(results[0] ? firstFleet : second, 'fleet', 'owners.json'));
        expect(owners.get('quiverfull')?.side).toBe(results[0] ? firstClaim.side : secondClaim.side);
        expect(owners.get('legacy')?.side).toBe('local');
        expect(git(first, '--git-dir=' + remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'fleet-data')).toBe('fleet/owners.json');
        expect(readFileSync(orderFile, 'utf8')).toBe('local pending order\n');
    } finally {
        if (/^rsbot-owner-claim-[^/\\]+$/.test(relative(parent, scratch))) rmSync(scratch, {recursive: true, force: true});
    }
}, 60_000);
