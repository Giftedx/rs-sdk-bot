// Owned-transfer admission, account/order leases, and handoff argument parsing.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readMergedPlan } from '../../../core/src/coordinator-jobs';
import { simStatusDir } from '../../../core/src/practice-paths';
import { readLogoutProof } from '../../../core/src/session-lifecycle';
import { ownedAccounts } from '../../../core/src/tradeguard';
import { createHandoff, reconcileOrder, type OrderSnapshot } from './handoff';
import { REPO_ROOT } from './types';

export const ACCOUNT_NAME_RE = /^[A-Za-z0-9_ -]{1,12}$/;

export type HandoffItem = { name: string; count: number };
export type Handoff = {
    donor: string;
    receiver: string;
    items: HandoffItem[];
    notes: boolean;
    keep?: string;
    x: number;
    z: number;
    approachMs?: number;
    requestMs: number;
    timeoutMs: number;
    graceMs: number;
};

export const ownerAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e.code !== 'ESRCH';
    }
};

export function acquireExclusiveLease(file: string, runId: string): () => void {
    mkdirSync(dirname(file), { recursive: true });
    const value = JSON.stringify({ pid: process.pid, runId, token: crypto.randomUUID() });
    try {
        writeFileSync(file, value, { flag: 'wx' });
    } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        const raw = readFileSync(file, 'utf8'), old = JSON.parse(raw);
        if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || !/^[a-f0-9-]{36}$/.test(old.token) || ownerAlive(old.pid)) {
            throw Error('account/order lease conflict: ' + file);
        }
        writeFileSync(file + '.reaped-' + old.token, value, { flag: 'wx' });
        if (readFileSync(file, 'utf8') !== raw) throw Error('lease changed during takeover: ' + file);
        unlinkSync(file);
        writeFileSync(file, value, { flag: 'wx' });
    }
    return () => {
        if (existsSync(file) && readFileSync(file, 'utf8') === value) unlinkSync(file);
    };
}

export function parseHandoff(args: string[]): Handoff {
    const [donor, receiver, ...rest] = args;
    if (!donor || !receiver || ![donor, receiver].every(n => n.trim() === n && ACCOUNT_NAME_RE.test(n) && !/^(main|haggis)$/i.test(n)) || donor.toLowerCase() === receiver.toLowerCase()) {
        throw new Error('two distinct non-reserved account names required');
    }
    const cfg: Handoff = { donor, receiver, items: [], notes: false, x: 2654, z: 3283, requestMs: 30_000, timeoutMs: 240_000, graceMs: 45_000 };
    const seen = new Set<string>();
    for (const arg of rest) {
        if (!arg.startsWith('--')) {
            const m = arg.match(/^(\d+):(.+)$/);
            const count = Number(m?.[1]), name = m?.[2]?.trim();
            if (!name || /[\r\n\0]/.test(name) || name.length > 80 || !Number.isSafeInteger(count) || count < 1) throw new Error('invalid handoff item/count');
            if (cfg.items.some(i => i.name.toLowerCase() === name.toLowerCase())) throw new Error('duplicate handoff item');
            cfg.items.push({ name, count });
            continue;
        }
        const [key, ...value] = arg.split('=');
        if (seen.has(key!)) throw new Error('duplicate handoff option');
        seen.add(key!);
        const v = value.join('=');
        if (key === '--notes' && !value.length) cfg.notes = true;
        else if (key === '--keep' && v && v.length <= 300) {
            new RegExp(v, 'i');
            cfg.keep = v;
        } else if (['--bank-x', '--bank-z', '--approach-ms', '--request-ms', '--timeout-ms', '--grace-ms'].includes(key!) && /^\d+$/.test(v)) {
            const fields: Record<string, 'x' | 'z' | 'approachMs' | 'requestMs' | 'timeoutMs' | 'graceMs'> = {
                '--bank-x': 'x', '--bank-z': 'z', '--approach-ms': 'approachMs', '--request-ms': 'requestMs', '--timeout-ms': 'timeoutMs', '--grace-ms': 'graceMs',
            };
            cfg[fields[key!]!] = Number(v);
        } else {
            throw new Error(`unknown/invalid handoff option ${key}`);
        }
    }
    if (!cfg.items.length || ![cfg.x, cfg.z].every(n => Number.isSafeInteger(n) && n > 0 && n < 16384)
        || cfg.approachMs !== undefined && (!Number.isSafeInteger(cfg.approachMs) || cfg.approachMs < 1000 || cfg.approachMs > 1_800_000)
        || !Number.isSafeInteger(cfg.requestMs) || cfg.requestMs < 1000 || cfg.requestMs > 60_000
        || !Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < cfg.requestMs || cfg.timeoutMs > 600_000
        || !Number.isSafeInteger(cfg.graceMs) || cfg.graceMs < 1000 || cfg.graceMs > 60_000) {
        throw new Error('invalid handoff bounds/items');
    }
    if (cfg.keep && cfg.items.some(i => new RegExp(cfg.keep!, 'i').test(i.name))) throw new Error('requested item overlaps protected KEEP');
    return cfg;
}

export function assertAccountOwnership(names: string[], state: any, jobs: any[], stopped: (name: string) => boolean, runId: string) {
    for (const name of ['coordinator', 'swarm', ...names]) if (stopped(name)) throw Error(`existing stop-${name}; preserve owner pause`);
    if (!state || state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(jobs)) throw Error('coordinator account ownership unavailable');
    for (const record of state.tasks.filter((r: any) => r.status === 'running')) {
        const spec = record.spec;
        if (!spec) throw Error('coordinator task ownership unknown');
        const bindings = spec.participants ?? (spec.account ? [spec.account] : spec.accountFrom ? ['@' + spec.accountFrom] : []);
        const accounts = bindings.map((n: string) => n.startsWith('@') ? state.tasks.find((r: any) => r.spec?.id === n.slice(1))?.receipt?.output?.account : n);
        if (accounts.some((n: unknown) => typeof n !== 'string')) throw Error('coordinator participant ownership unresolved');
        for (const name of names) {
            if (accounts.some((n: string) => n.toLowerCase() === name.toLowerCase()) && (!runId || record.runId !== runId)) {
                throw Error(`account lease conflict: ${name}; coordinator ${spec.id} ${record.runId}`);
            }
        }
    }
    for (const job of jobs) {
        for (const name of names) {
            if (!(process.env.STANDING === '1' && job.standing === true && job.goal === process.env.BOT_GOAL)
                && job.enabled !== false && (job.accounts ?? [job.account]).some((n: string) => n?.toLowerCase() === name.toLowerCase())
                && (!runId || !String(job.goal ?? '').includes('[' + runId + ']'))) {
                throw Error(`account lease conflict: ${name}; swarm ${job.id ?? job.coordinatorTask ?? job.script}`);
            }
        }
    }
}

export function assertHandoffOwnership(c: Handoff, state: any, jobs: any[], stopped: (name: string) => boolean, runId = '') {
    assertAccountOwnership([c.donor, c.receiver], state, jobs, stopped, runId);
}

export function acquireAccountLeases(names: string[], runId: string, base = resolve(REPO_ROOT, '.practice/account-leases')): () => void {
    if (!names.length || names.some(n => !ACCOUNT_NAME_RE.test(n) || n.trim() !== n)) throw Error('invalid account lease names');
    const releases: (() => void)[] = [];
    const release = () => { for (const done of releases.splice(0).reverse()) done(); };
    try {
        for (const name of [...new Set(names.map(n => n.toLowerCase()))].sort()) releases.push(acquireExclusiveLease(join(base, name + '.lock'), runId));
        return release;
    } catch (e) {
        release();
        throw e;
    }
}

export function assertRecoverableStatus(status: any, owner: any, alive: (pid: number) => boolean) {
    if (!status || status.result) return;
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.goal || status.goal !== owner.goal || alive(owner.pid)) {
        throw Error('account session ownership unsettled: ' + status.name);
    }
}

export function transferOrderKey(value: string, label = 'transfer order') {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw Error('invalid ' + label);
    return value;
}

export function checkTransferAccounts(
    root: string,
    names: readonly string[],
    server: string,
    open: readonly { name: string }[],
    runId: string,
    io: { owned?: (server: string) => ReadonlySet<string>; logoutState?: (name: string, server: string) => string } = {},
) {
    const dir = join(root, '.practice'), read = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const jobs = existsSync(join(root, 'swarm.json')) ? readMergedPlan(root).jobs : undefined;
    assertAccountOwnership([...names], read(join(dir, 'coordinator/state.json')), jobs, n => existsSync(join(dir, 'stop-' + n)), runId);
    const owned = (io.owned ?? ownedAccounts)(server), logoutState = io.logoutState ?? ((name, host) => readLogoutProof(name, host).state);
    for (const name of names) {
        if (!owned.has(name.toLowerCase())) throw Error('not authenticated owned: ' + name);
        if (!open.some(s => s.name.toLowerCase() === name.toLowerCase())) {
            const state = logoutState(name, server);
            if (state === 'confirmed') continue;
            if (state !== 'none') throw Error('account session ownership unsettled: ' + name + ' (' + state + ')');
            assertRecoverableStatus(read(join(simStatusDir(root), name + '.json')) ?? read(join(dir, 'status', name + '.json')), null, () => true);
        }
    }
}

export function exactOrder(
    key: string,
    from: string,
    to: string,
    server: string,
    items: { name: string; count: number }[],
    base = resolve(REPO_ROOT, '.practice/item-handoffs'),
) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(key)) throw Error('HANDOFF_ORDER is required: exact key, 1-64 letters/digits/hyphens');
    if (![from, to].every(n => ACCOUNT_NAME_RE.test(n)) || from.toLowerCase() === to.toLowerCase() || !server) throw Error('invalid exact order identity');
    if (!items.length || items.some(i => !i.name || !Number.isSafeInteger(i.count) || i.count <= 0) || new Set(items.map(i => i.name.toLowerCase())).size !== items.length) throw Error('invalid exact order items');
    const root = join(base, key), file = join(root, `${from.toLowerCase()}-${to.toLowerCase()}.json`);
    const read = (): any => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const previous = read(), identity = { order: key, from: from.toLowerCase(), to: to.toLowerCase(), server, items: items.map(i => ({ ...i, name: i.name.toLowerCase() })) };
    if (previous?.state === 'settled') throw Error('payout prerequisite: order already settled; no login');
    if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) throw Error('order unresolved: identity/items or bank/pack baseline unavailable; ' + JSON.stringify(previous));
    if (previous?.state === 'entering' && (!previous.owner || !Number.isSafeInteger(previous.owner.pid) || previous.owner.pid <= 0 || !previous.owner.goal || previous.baseline || previous.expected)) {
        throw Error('order unresolved: invalid entry owner or premature baseline');
    }
    if (previous && previous.state !== 'entering' && (previous.state !== 'prepared' || !previous.baseline || !Array.isArray(previous.expected) || previous.expected.length !== items.length
        || previous.expected.some((i: any, k: number) => !Number.isSafeInteger(i.id) || i.id <= 0 || i.count !== items[k]!.count))) {
        throw Error('order unresolved: invalid saved baseline/expected items; ' + JSON.stringify(previous));
    }
    const save = (value: any) => { mkdirSync(root, { recursive: true }); const temp = file + '.' + process.pid + '.tmp'; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, file); };
    const prepare = (expected: { id: number; count: number }[], baseline: OrderSnapshot) => {
        const entry = read();
        if (entry && (entry.state !== 'entering' || entry.owner?.pid !== process.pid || entry.owner?.goal !== (process.env.BOT_GOAL ?? ''))) {
            throw Error('order already prepared; reconcile before retry');
        }
        if (expected.length !== items.length || expected.some((i, k) => i.count !== items[k]!.count)) throw Error('order expected quantities differ');
        const receipt = {
            ...entry, token: entry?.token ?? crypto.randomUUID(), from, to, server, at: Date.now(), state: 'prepared', expected, identity, baseline,
            owner: entry?.owner ?? { pid: process.pid, goal: process.env.BOT_GOAL ?? '', at: Date.now() },
        };
        if (reconcileOrder(receipt, baseline) !== 'resume') throw Error('invalid initial baseline');
        mkdirSync(root, { recursive: true });
        if (entry) save(receipt); else writeFileSync(file, JSON.stringify(receipt), { flag: 'wx' });
        return receipt;
    };
    const settle = (current: OrderSnapshot) => {
        const receipt = read();
        if (reconcileOrder(receipt, current) !== 'settle') throw Error('receiver bank credit not settled');
        const settled = { ...receipt, state: 'settled', afterHoldings: current, settledAt: Date.now() };
        save(settled);
        return settled;
    };
    const claim = () => {
        const release = acquireExclusiveLease(file + '.claim.lock', key);
        try {
            const r = read();
            if (JSON.stringify(r?.owner ?? null) !== JSON.stringify(previous?.owner ?? null) || r?.state === 'settled') throw Error('order owner changed; no login');
            if (r?.owner && r.owner.pid !== process.pid && ownerAlive(r.owner.pid)) throw Error('order owner still alive: ' + r.owner.pid);
            const owner = { pid: process.pid, goal: process.env.BOT_GOAL ?? '', at: Date.now(), token: crypto.randomUUID() };
            const next = {
                ...(r ?? { token: crypto.randomUUID(), from, to, server, identity, state: 'entering', at: Date.now() }),
                recoveryOwner: r?.owner ?? null,
                previousOwners: [...(r?.previousOwners ?? []), ...(r?.owner ? [r.owner] : [])],
                owner,
            };
            if (r) save(next); else writeFileSync(file, JSON.stringify(next), { flag: 'wx' });
            return next;
        } finally {
            release();
        }
    };
    return { file, read, prepare, settle, claim };
}

export function payoutOrder(env: Record<string, string | undefined> = process.env, base = resolve(REPO_ROOT, '.practice/item-handoffs')) {
    if (!env.HANDOFF_ORDER && !env.HANDOFF_ITEM_ID) return;
    const order = env.HANDOFF_ORDER ?? '', id = Number(env.HANDOFF_ITEM_ID);
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(order) || !Number.isSafeInteger(id) || id <= 0) throw Error('payout prerequisite: invalid exact order');
    const root = join(base, order), receipt = createHandoff([id], root);
    const preflight = (from: string, to: string) => {
        if (![from, to].every(n => ACCOUNT_NAME_RE.test(n))) throw Error('payout prerequisite: invalid order identity');
        const p = join(root, `${from.toLowerCase()}-${to.toLowerCase()}.json`);
        if (existsSync(p)) {
            const prior = JSON.parse(readFileSync(p, 'utf8'));
            throw Error(`payout prerequisite: order ${prior.state === 'settled' ? 'already settled' : 'unresolved'}; reconcile before retry`);
        }
    };
    const expected = (want: { name: string; count: number }[], inventory: { id: number; name: string; count: number }[]) => {
        if (want.length !== 1 || !Number.isSafeInteger(want[0]!.count) || want[0]!.count <= 0) throw Error('payout prerequisite: one exact item required');
        const matching = inventory.filter(i => i.name.toLowerCase() === want[0]!.name.toLowerCase() && i.count > 0);
        if (!matching.length || matching.some(i => i.id !== id) || matching.reduce((n, i) => n + i.count, 0) < want[0]!.count) {
            throw Error('payout prerequisite: exact item stock missing');
        }
        return [{ id, count: want[0]!.count }];
    };
    return { id, root, receipt, preflight, expected };
}
