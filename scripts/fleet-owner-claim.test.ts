import {expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {loadOwners} from '../packages/core/src/fleet';
import {reserveFleetOwner} from './fleet-owner-claim';

function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, {cwd, timeout: 5000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

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
}, 20_000);
