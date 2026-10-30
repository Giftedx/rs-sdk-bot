// One donor hands the same exact coin amount to several owned receivers, one after another, at a shared bank
// (Varrock West by default). Each pair runs scripts/coin-courier.ts moveCoins unchanged, with its own journal under
// .practice/coin-courier/<order>-<receiver>; the donor stays logged in between pairs. A failed pair is reported and
// the next receiver still gets its turn.
// Usage: bun scripts/coin-fanout.ts <donor> <receiver> [receiver ...] <amount>   (a swarm orchestrate job passes
// its accounts first, then its args)
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, settle, serverFromEnv, assertServerAllowed } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { moveCoins, parseCoins } from './coin-courier';
import { assertAccountOwnership, acquireAccountLeases, assertRecoverableStatus } from './handoff-inputs';

export function parseFanout(args: string[]) {
    const [donor, ...rest] = args, amount = rest.at(-1), receivers = rest.slice(0, -1);
    if (!donor || !amount || !/^\d+$/.test(amount) || !receivers.length) throw Error('usage: coin-fanout.ts <donor> <receiver> [receiver ...] <amount>');
    if (new Set([donor, ...receivers].map(n => n.toLowerCase())).size !== receivers.length + 1) throw Error('each account once');
    return { donor, receivers, pairs: receivers.map(r => parseCoins([donor, r, amount])) };
}

if (import.meta.main) {
    const f = parseFanout(process.argv.slice(2)), root = resolve(import.meta.dir, '..'), dir = join(root, '.practice');
    const all = [f.donor, ...f.receivers];
    const read = (p: string, fallback: any) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
    const host = (name: string) => serverFromEnv(readFileSync(join(root, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
    const server = host(f.donor);
    if (all.some(n => host(n) !== server)) throw Error('coin accounts must use the same server');
    assertServerAllowed(server);
    const runId = process.env.COORDINATOR_RUN_ID ?? '', order = process.env.COIN_ORDER ?? `fanout-${Date.now()}`;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    const check = (names: string[], open: Session[]) => () => {
        if (cancelled) throw Error('coin fan-out cancelled');
        assertAccountOwnership(names, read(join(dir, 'coordinator/state.json'), null), read(join(root, 'swarm.json'), {}).jobs, n => existsSync(join(dir, 'stop-' + n)), runId);
        const owned = ownedAccounts(server);
        for (const n of names) {
            if (!owned.has(n.toLowerCase())) throw Error('not authenticated owned: ' + n);
            if (!open.some(s => s.name.toLowerCase() === n.toLowerCase())) assertRecoverableStatus(read(join(dir, 'status', n + '.json'), null), null, () => true);
        }
    };
    const results: { to: string; ok: boolean; detail: string }[] = [];
    let donor: Session | undefined, release: (() => void) | undefined;
    try {
        check(all, [])(); release = acquireAccountLeases(all, runId);
        process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
        donor = await openBot(f.donor, { onStop: async () => cancel(), onSessionEnd: async () => cancel() });
        for (const c of f.pairs) {
            if (cancelled) break;
            const open: Session[] = [donor];
            let ok = false, detail = '';
            try {
                open.push(await openBot(c.receiver, { onStop: async () => cancel(), onSessionEnd: async () => cancel() }));
                await moveCoins(c, open, join(dir, 'coin-courier', `${order}-${c.receiver}`), server, check([f.donor, c.receiver], open));
                ok = true; detail = `transferred ${c.amount} coins ${f.donor} -> ${c.receiver}`;
            } catch (error) { detail = String(error); }
            if (open[1]) await settle([open[1]], ok, detail);
            results.push({ to: c.receiver, ok, detail });
            console.log('FANOUT_PAIR ' + JSON.stringify(results.at(-1)));
        }
    } catch (error) { results.push({ to: '-', ok: false, detail: String(error) }); }
    finally {
        const ok = results.some(r => r.ok);
        try { if (donor) await settle([donor], ok, `fan-out ${results.filter(r => r.ok).length}/${f.receivers.length}: ${results.map(r => `${r.to} ${r.ok ? 'ok' : 'fail'}`).join(', ')}`); }
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); release?.(); }
        console.log('FANOUT_RESULT ' + JSON.stringify(results));
        process.exitCode = ok ? 0 : 1;
    }
}
