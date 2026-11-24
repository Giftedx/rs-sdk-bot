// Owned-transfer admission, account/order leases, and handoff argument parsing.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fleetStateFile, simStatusDir } from '../../../core/src/practice-paths';
import { readLogoutProof } from '../../../core/src/session-lifecycle';
import { ownedAccounts } from '../../../core/src/tradeguard';
import { createHandoff, reconcileOrder, type OrderSnapshot } from './handoff';
import { ACCOUNT_NAME_RE, parseHandoff, type Handoff, type HandoffItem } from './preflight';
import { REPO_ROOT } from './types';

export { ACCOUNT_NAME_RE, parseHandoff, type Handoff, type HandoffItem };

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

export function assertAccountOwnership(names: string[], state: any, jobs: any[], stopped: (name: string) => boolean, runId: string) {
    if (stopped('coordinator')) throw Error('existing stop-coordinator; preserve owner pause');
    if (stopped('swarm')) throw Error('existing stop-swarm; preserve owner pause');
    const lowerNames: string[] = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        if (stopped(name)) throw Error(`existing stop-${name}; preserve owner pause`);
        lowerNames.push(name.toLowerCase());
    }
    if (!Array.isArray(jobs)) throw Error('swarm job ownership unavailable');
    if (state !== null && state !== undefined) {
        if (state.schemaVersion === 1 && typeof state.accounts === 'object' && state.accounts !== null) {
            for (let i = 0; i < names.length; i++) {
                if (state.accounts[lowerNames[i]!]?.paused === true) throw Error(`account paused in fleet state: ${names[i]}`);
            }
        } else if (state.version === 1 && Array.isArray(state.tasks)) {
            let tasksById: Map<string, any> | undefined;
            for (let t = 0; t < state.tasks.length; t++) {
                const record = state.tasks[t];
                if (record.status !== 'running') continue;
                const spec = record.spec;
                if (!spec) throw Error('coordinator task ownership unknown');
                const bindings: string[] = spec.participants ?? (spec.account ? [spec.account] : spec.accountFrom ? ['@' + spec.accountFrom] : []);
                for (let b = 0; b < bindings.length; b++) {
                    let resolved: unknown = bindings[b]!;
                    if ((resolved as string).startsWith('@')) {
                        if (!tasksById) {
                            tasksById = new Map<string, any>();
                            for (let k = 0; k < state.tasks.length; k++) {
                                const task = state.tasks[k];
                                if (task.spec?.id !== undefined) tasksById.set(task.spec.id, task);
                            }
                        }
                        resolved = tasksById.get((resolved as string).slice(1))?.receipt?.output?.account;
                    }
                    if (typeof resolved !== 'string') throw Error('coordinator participant ownership unresolved');
                    const resolvedLower = resolved.toLowerCase();
                    for (let i = 0; i < lowerNames.length; i++) {
                        if (resolvedLower === lowerNames[i] && (!runId || record.runId !== runId)) {
                            throw Error(`account lease conflict: ${names[i]}; coordinator ${spec.id} ${record.runId}`);
                        }
                    }
                }
            }
        } else {
            throw Error('fleet account ownership unavailable');
        }
    }
    const standing = process.env.STANDING === '1';
    const botGoal = process.env.BOT_GOAL;
    const runTag = runId ? '[' + runId + ']' : '';
    for (let j = 0; j < jobs.length; j++) {
        const job = jobs[j];
        if (job.enabled === false) continue;
        if (standing && job.standing === true && job.goal === botGoal) continue;
        if (runTag && String(job.goal ?? '').includes(runTag)) continue;
        const accs: string[] | undefined = job.accounts;
        for (let i = 0; i < lowerNames.length; i++) {
            const ln = lowerNames[i]!;
            let matched = false;
            if (accs) {
                for (let k = 0; k < accs.length; k++) {
                    if (accs[k]?.toLowerCase() === ln) { matched = true; break; }
                }
            } else if (job.account?.toLowerCase() === ln) {
                matched = true;
            }
            if (matched) {
                throw Error(`account lease conflict: ${names[i]}; swarm ${job.id ?? job.coordinatorTask ?? job.script}`);
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
    const state = read(fleetStateFile(root));
    if (!state) throw Error('fleet account ownership unavailable');
    const jobs = existsSync(join(root, 'swarm.json')) ? JSON.parse(readFileSync(join(root, 'swarm.json'), 'utf8')).jobs : undefined;
    assertAccountOwnership([...names], state, jobs, n => existsSync(join(dir, 'stop-' + n)), runId);
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
