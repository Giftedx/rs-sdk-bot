// Autopilot CLI: writes this fleet side's swarm jobs (packages/planner/src/autopilot.ts) into swarm.json. It replaces
// only jobs marked "autopilot": <this side>, keeps every other job, and never plans an account that an unmarked job
// names or another side owns. Each pass retires a planner job whose log since assignment shows repeated fail RESULTs,
// a death or near-total tick waste, and picks that account's next best template. Resources this side holds go to
// fleet/claims/<side>.json in the fleet-data worktree, which scripts/fleet-sync.ts shares, so sides never share a spot.
// Usage: bun scripts/autopilot.ts [swarm.json] [--dry] [--daemon]   (--daemon: a pass every 10 minutes)
// Run beside DEMO_OK=1 bun scripts/swarm.ts and bun scripts/fleet-agent.ts --daemon, with FLEET_SIDE set.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_DIR, FLEET_WORKTREE, loadOwners, mySide } from '../packages/core/src/fleet';
import { withPlanWrite } from '../packages/core/src/plan-lock';
import { accountFrom, assess, catalogue, mergeJobs, norm, pairKey, plan, plannableAccounts, reservedResources } from '../packages/planner/src/autopilot';
import { liveHelperStatuses, supplyBill, type BillRow } from '../packages/planner/src/supply-bill';
import { haggisActivities, haggisTravel, loadSnapshot, suppliesFor, TRICKS } from '../packages/planner/src/haggis';
import { tickWaste, wasteShare } from './tick-waste';

const root = resolve(import.meta.dir, '..'), prac = join(root, '.practice');
const CLAIM_MAX_AGE_MS = 2 * 3600_000;
type State = { assigned: Record<string, { template: string; offset: number; at: number }>; retired: Record<string, string> };

const readJson = (f: string, fallback: any) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeAtomic = (f: string, text: string) => { writeFileSync(`${f}.tmp`, text); renameSync(`${f}.tmp`, f); };
function readFrom(file: string, offset: number): string[] {
    if (!existsSync(file)) return [];
    const size = statSync(file).size, start = offset <= size ? offset : 0, buf = Buffer.alloc(Math.min(size - start, 4_000_000));
    const fd = openSync(file, 'r'); try { readSync(fd, buf, 0, buf.length, size - buf.length); } finally { closeSync(fd); }
    return buf.toString('latin1').split(/\r?\n/);
}

function routeBill(items: any[]): BillRow[] {
    try {
        const supplies = suppliesFor(haggisActivities(), { mode: 'realistic', tricks: new Set(TRICKS), travel: haggisTravel() } as any, loadSnapshot(join(root, 'research/hiscores-live.json')));
        return supplyBill(supplies, items, liveHelperStatuses());
    } catch (e) {
        console.log(`AUTOPILOT bill from the last saved supply bill: ${String(e).slice(0, 120)}`);
        return readJson(join(prac, 'coordinator/supply-bill.json'), { rows: [] }).rows;
    }
}

export function pass(planFile: string, dry: boolean): string[] {
    const side = mySide(), owners = loadOwners(), swarm = readJson(planFile, null);
    if (!swarm || !Array.isArray(swarm.jobs)) throw Error(`autopilot: ${planFile} has no jobs list`);
    const stateFile = join(prac, 'autopilot', `${side}.json`), state: State = { assigned: {}, retired: {}, ...readJson(stateFile, {}) };
    const items: any[] = readJson(join(root, 'knowledge/items.json'), []), byId = new Map(items.map(i => [i.id, i.name]));
    const prices: Record<string, number> = {};
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    const mineMarked = (j: any) => j?.autopilot === side;

    // Retire planner jobs whose own log lines show no progress.
    const log: string[] = [];
    for (const j of swarm.jobs.filter(mineMarked)) {
        const a = state.assigned[j.account];
        if (!a || a.template !== j.template) continue;
        const r = assess(readFrom(join(prac, 'swarm-logs', `${j.account}.log`), a.offset));
        if (r.retire) { state.retired[pairKey(j.account, j.template)] = r.reason; log.push(`AUTOPILOT retire ${j.account} ${j.template}: ${r.reason}`); }
    }

    // Resources other jobs hold: this file's other jobs (paused planner jobs included), and other sides' fresh claims.
    // Enabled hand-made jobs of this side's accounts go into this side's claim too, so a side with its own plan sees them.
    const listedNames = Object.keys(readJson(join(FLEET_DIR(), 'owners.json'), { accounts: {} }).accounts ?? {});
    const paused = new Set(listedNames.filter(n => existsSync(join(prac, `stop-${n}`))).map(n => n.toLowerCase()));
    const { taken, ownHeld } = reservedResources(swarm.jobs, side, paused, a => owners.get(a.toLowerCase())?.side ?? 'local');
    const claimDir = join(FLEET_DIR(), 'claims');
    if (existsSync(claimDir)) for (const f of readdirSync(claimDir).filter(f => f.endsWith('.json'))) {
        const c = readJson(join(claimDir, f), null);
        if (!c || c.side === side || !Array.isArray(c.resources) || !(Date.now() - c.at < CLAIM_MAX_AGE_MS)) continue;
        for (const r of c.resources) if (typeof r === 'string') taken[r] = (taken[r] ?? 0) + 1;
    }

    const listed = listedNames;
    const statusDir = join(prac, 'status'), statusFiles = existsSync(statusDir) ? readdirSync(statusDir) : [];
    const accounts = plannableAccounts(swarm.jobs, side, listed.filter(n => owners.get(n.toLowerCase())?.side === side), paused).map(n => {
        const f = statusFiles.find(f => f.toLowerCase() === `${n.toLowerCase()}.json`);
        return accountFrom(n, side, f ? readJson(join(statusDir, f), null) : null, id => byId.get(id));
    });
    const out = plan({ side, accounts, owners, bill: routeBill(items), templates: catalogue(), prices, waste: wasteShare(tickWaste(join(prac, 'swarm-logs'))), taken, retired: new Set(Object.keys(state.retired)), capacity: { 'catherby:lobster': 3 } });

    const { jobs, fresh } = mergeJobs(swarm.jobs, side, out, paused);
    for (const x of out) {
        if (!x.template) { log.push(`AUTOPILOT vacant ${x.account}: ${x.reason}`); delete state.assigned[x.account]; continue; }
        if (fresh.includes(x.account) || state.assigned[x.account]?.template !== x.template.id) {
            const lf = join(prac, 'swarm-logs', `${x.account}.log`);
            state.assigned[x.account] = { template: x.template.id, offset: existsSync(lf) ? statSync(lf).size : 0, at: Date.now() };
        }
        log.push(`AUTOPILOT ${fresh.includes(x.account) ? 'assign' : 'keep'} ${x.account} ${x.template.id} ${x.value.toFixed(2)}/tick ${x.reason}`);
    }
    if (dry) return [...log, 'AUTOPILOT dry run: nothing written'];
    writeAtomic(planFile, JSON.stringify({ ...swarm, jobs }, null, 2) + '\n');
    mkdirSync(join(prac, 'autopilot'), { recursive: true });
    writeAtomic(stateFile, JSON.stringify(state, null, 1) + '\n');
    if (existsSync(join(FLEET_WORKTREE, 'fleet', 'owners.json'))) {
        mkdirSync(join(FLEET_WORKTREE, 'fleet', 'claims'), { recursive: true });
        writeAtomic(join(FLEET_WORKTREE, 'fleet', 'claims', `${side}.json`), JSON.stringify({ side, at: Date.now(), resources: [...new Set([...ownHeld, ...out.flatMap(x => x.resources)])].sort() }) + '\n');
    }
    return log;
}

if (import.meta.main) {
    const args = process.argv.slice(2), planFile = resolve(args.find(a => !a.startsWith('--')) ?? join(root, 'swarm.json'));
    // The whole pass runs under the account-plan lock: the coordinator installs its own jobs into the same file.
    const once = async () => { try { const l = await withPlanWrite(() => pass(planFile, args.includes('--dry')), join(prac, 'coordinator')); console.log(l.join('\n')); console.log(`RESULT ok autopilot jobs=${l.filter(x => / (assign|keep) /.test(x)).length} retired=${l.filter(x => / retire /.test(x)).length}`); return true; }
        catch (e) { console.log(`RESULT fail autopilot ${String(e)}`); return false; } };
    if (!args.includes('--daemon')) process.exit(await once() ? 0 : 1);
    await once(); setInterval(once, 10 * 60_000);
}
