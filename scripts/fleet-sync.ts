// Shares fleet state between the two machines through git, on the fleet-data branch in its own worktree
// (.practice/fleet-data), never in the code checkout: pulls the other side's orders, receipts and snapshot, writes
// this side's bank snapshot (fleet/snapshots/<side>.json: name, server, bank, pack, worn and skill levels of this
// side's listed accounts from .practice/status, never practice bots or credentials), commits fleet/ and pushes.
// Usage: bun scripts/fleet-sync.ts [--no-push]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_WORKTREE, loadOwners, mySide } from '../packages/core/src/fleet';

const root = resolve(import.meta.dir, '..');
const BRANCH = 'fleet-data';
const rows = (r: any[] | undefined) => (r ?? []).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count }));
export function snapshot(statuses: readonly any[], side = mySide(), owners = loadOwners(), now = Date.now()) {
    return { side, at: now, accounts: statuses.filter(s => typeof s?.name === 'string' && owners.get(s.name.toLowerCase())?.side === side && owners.get(s.name.toLowerCase())?.server === String(s.server).toLowerCase()).map(s => ({
        name: s.name, server: s.server, at: s.at, bank: rows(s.bank), inventory: rows(s.inventory), equipment: rows(s.equipment),
        skills: (s.skills ?? []).map((k: any) => ({ name: k.name, level: k.level })),
    })) };
}
const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
};

// The fleet-data worktree: the remote branch when it exists, else a new branch from the current commit (fleet/ seed).
export function ensureWorktree(dir = FLEET_WORKTREE): string {
    if (existsSync(join(dir, '.git'))) return dir;
    git(root, 'fetch', 'origin', BRANCH);
    const remote = git(root, 'rev-parse', '--verify', `origin/${BRANCH}`).ok;
    const local = git(root, 'rev-parse', '--verify', BRANCH).ok;
    const add = local ? git(root, 'worktree', 'add', dir, BRANCH) : remote ? git(root, 'worktree', 'add', '-b', BRANCH, dir, `origin/${BRANCH}`) : git(root, 'worktree', 'add', '-b', BRANCH, dir, 'HEAD');
    if (!add.ok) throw Error(`fleet worktree: ${add.out}`);
    git(dir, 'branch', '--set-upstream-to', `origin/${BRANCH}`);
    return dir;
}

export function runSync(push = true): string {
    const dir = ensureWorktree();
    const hasRemote = git(dir, 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH).ok;
    if (hasRemote) { const pull = git(dir, 'pull', '--rebase', 'origin', BRANCH); if (!pull.ok) throw Error(`pull: ${pull.out}`); }
    const statusDir = join(root, '.practice', 'status');
    const statuses = existsSync(statusDir) ? readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(statusDir, f), 'utf8'))]; } catch { return []; } }) : [];
    const owners = loadOwners(join(dir, 'fleet', 'owners.json')), snap = snapshot(statuses, mySide(), owners);
    mkdirSync(join(dir, 'fleet', 'snapshots'), { recursive: true });
    // Write only when an account changed: the time stamp alone makes no commit.
    const file = join(dir, 'fleet', 'snapshots', `${snap.side}.json`);
    const prior = (() => { try { return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).accounts); } catch { return ''; } })();
    if (prior !== JSON.stringify(snap.accounts)) writeFileSync(file, JSON.stringify(snap) + '\n');
    git(dir, 'add', '--', 'fleet');
    const staged = !git(dir, 'diff', '--cached', '--quiet').ok;
    if (staged) { const c = git(dir, 'commit', '-m', `fleet: ${snap.side} sync (${snap.accounts.length} accounts)`); if (!c.ok) throw Error(`commit: ${c.out}`); }
    const ahead = !hasRemote || git(dir, 'rev-list', '--count', `origin/${BRANCH}..HEAD`).out !== '0';
    if (push && ahead) { const p = git(dir, 'push', '-u', 'origin', BRANCH); if (!p.ok) throw Error(`push: ${p.out}`); }
    return `side=${snap.side} accounts=${snap.accounts.length} committed=${staged} pushed=${push && ahead}`;
}

if (import.meta.main) {
    try { console.log(`RESULT ok fleet-sync ${runSync(!process.argv.includes('--no-push'))}`); }
    catch (e) { console.log(`RESULT fail fleet-sync ${String(e)}`); process.exit(1); }
}
