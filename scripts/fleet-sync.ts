// Shares fleet state between the two machines through git: pulls the other side's orders, receipts and snapshot,
// writes this side's bank snapshot (fleet/snapshots/<side>.json: name, server, bank, pack, worn and skill levels of
// this side's accounts from .practice/status; never credentials), commits fleet/ and pushes.
// Usage: bun scripts/fleet-sync.ts [--no-push]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_DIR, loadOwners, mySide, sideOf } from '../packages/core/src/fleet';

const root = resolve(import.meta.dir, '..');
const rows = (r: any[] | undefined) => (r ?? []).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count }));
export function snapshot(statuses: readonly any[], side = mySide(), owners = loadOwners(), now = Date.now()) {
    return { side, at: now, accounts: statuses.filter(s => typeof s?.name === 'string' && sideOf(s.name, owners) === side).map(s => ({
        name: s.name, server: s.server, at: s.at, bank: rows(s.bank), inventory: rows(s.inventory), equipment: rows(s.equipment),
        skills: (s.skills ?? []).map((k: any) => ({ name: k.name, level: k.level })),
    })) };
}
const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
};

if (import.meta.main) {
    const push = !process.argv.includes('--no-push');
    const pull = git('pull', '--rebase', '--autostash');
    if (!pull.ok) { console.log(`RESULT fail fleet-sync pull: ${pull.out}`); process.exit(1); }
    const dir = join(root, '.practice', 'status');
    const statuses = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]; } catch { return []; } }) : [];
    mkdirSync(join(FLEET_DIR(), 'snapshots'), { recursive: true });
    const snap = snapshot(statuses);
    writeFileSync(join(FLEET_DIR(), 'snapshots', `${snap.side}.json`), JSON.stringify(snap) + '\n');
    git('add', '--', 'fleet');
    const staged = !git('diff', '--cached', '--quiet', '--', 'fleet').ok;
    if (staged) { const c = git('commit', '-m', `fleet: ${snap.side} sync (${snap.accounts.length} accounts)`, '--', 'fleet'); if (!c.ok) { console.log(`RESULT fail fleet-sync commit: ${c.out}`); process.exit(1); } }
    if (push && staged) { const p = git('push'); if (!p.ok) { console.log(`RESULT fail fleet-sync push: ${p.out}`); process.exit(1); } }
    console.log(`RESULT ok fleet-sync side=${snap.side} accounts=${snap.accounts.length} committed=${staged} pushed=${push && staged}`);
}
