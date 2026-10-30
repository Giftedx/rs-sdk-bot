// Several owned donors hand one stackable item to one receiver, one after another, at Varrock West bank (the
// meeting tiles scripts/coin-courier.ts proved live). The receiver stays logged in between donors; each donor
// trades every one it holds in its pack, then logs out. At the end the receiver banks what it got. The trade runs
// through courier-handoff.ts with a receipt per pair under .practice/item-fanin/<order>-<donor>.
// Built for feathers: the chicken farmers (scripts/gather-feathers.ts) keep theirs in the pack, and BowBeforeMe
// holds the arrow shafts for headless arrows.
// Usage: bun scripts/item-fanin.ts <receiver> <donor> [donor ...] <item name>   (a swarm orchestrate job passes
// its accounts first, then its args)
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, settle, serverFromEnv, assertServerAllowed, getWorld, accountOf } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { goTo } from '../packages/core/src/walk';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { exactItem } from '../packages/core/src/cargo';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { readLogoutProof } from '../packages/core/src/session-lifecycle';
import { createHandoff } from './courier-handoff';
import { meetingTiles } from './coin-courier';
import { assertAccountOwnership, acquireAccountLeases, assertRecoverableStatus } from './handoff-inputs';

const BANK = { x: 3185, z: 3436 };

export function parseFanin(args: string[]) {
    const item = args.at(-1), [receiver, ...donors] = args.slice(0, -1);
    if (!receiver || !donors.length || !item || /^\d+$/.test(item)) throw Error('usage: item-fanin.ts <receiver> <donor> [donor ...] <item name>');
    if (new Set([receiver, ...donors].map(n => n.toLowerCase())).size !== donors.length + 1) throw Error('each account once');
    return { receiver, donors, item };
}

export const held = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

if (import.meta.main) {
    const args = process.argv.slice(2);
    // A swarm orchestrate job may pass the item first among its args: `--args Feather` after the accounts.
    const f = parseFanin(args), root = resolve(import.meta.dir, '..'), dir = join(root, '.practice');
    const all = [f.receiver, ...f.donors];
    const read = (p: string, fallback: any) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
    const host = (name: string) => serverFromEnv(readFileSync(join(root, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
    const server = host(f.receiver);
    if (all.some(n => host(n) !== server)) throw Error('fan-in accounts must use the same server');
    assertServerAllowed(server);
    const runId = process.env.COORDINATOR_RUN_ID ?? '', order = process.env.ITEM_ORDER ?? `fanin-${Date.now()}`;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    const check = (names: string[], open: Session[]) => {
        if (cancelled) throw Error('item fan-in cancelled');
        assertAccountOwnership(names, read(join(dir, 'coordinator/state.json'), null), read(join(root, 'swarm.json'), {}).jobs, n => existsSync(join(dir, 'stop-' + n)), runId);
        const owned = ownedAccounts(server);
        for (const n of names) {
            if (!owned.has(n.toLowerCase())) throw Error('not authenticated owned: ' + n);
            if (!open.some(s => s.name.toLowerCase() === n.toLowerCase()) && readLogoutProof(n, server).state !== 'confirmed')
                assertRecoverableStatus(read(join(dir, 'status', n + '.json'), null), null, () => true);
        }
    };
    const meet = meetingTiles(BANK)!;
    const results: { from: string; ok: boolean; count: number; detail: string }[] = [];
    let receiver: Session | undefined, release: (() => void) | undefined;
    try {
        check(all, []); release = acquireAccountLeases(all, runId);
        process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
        receiver = await openBot(f.receiver, { onStop: async () => cancel(), onSessionEnd: async () => cancel() });
        const world = await getWorld();
        const to = async (s: Session, tile: typeof meet[0]) => {
            const r = await goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 100 });
            if (!r.ok) throw Error(`route to ${tile.x},${tile.z} failed for ${s.name}: ${r.reason} ${r.detail}`);
            await s.bot.walkTo(tile.x, tile.z, 0);
            if (!await waitUntil(s, () => { const p = s.sdk.getState()?.player; return !!p && p.worldX === tile.x && p.worldZ === tile.z; }, { timeoutTicks: 20 }))
                throw Error(`meeting tile unobserved for ${s.name}`);
        };
        await to(receiver, meet[1]);
        for (const name of f.donors) {
            if (cancelled) break;
            let donor: Session | undefined, ok = false, count = 0, detail = '';
            try {
                check([f.receiver, name], [receiver]);
                donor = await openBot(name, { onStop: async () => cancel(), onSessionEnd: async () => cancel() });
                const stack = donor.sdk.getInventory().find(i => exactItem(f.item).test(i.name));
                if (!stack) { detail = `no ${f.item} in the pack`; ok = true; }
                else {
                    count = held(donor.sdk.getInventory(), stack.id);
                    const before = held(receiver.sdk.getInventory(), stack.id);
                    await to(donor, meet[0]);
                    const handoff = createHandoff([stack.id], join(dir, 'item-fanin', `${order}-${name}`));
                    const transfers = await Promise.allSettled([
                        handoff.sendHandoff(donor, f.receiver, server, [{ id: stack.id, count }], async () => {
                            const r = await donor!.bot.serveTrades({ from: exactItem(f.receiver), give: [{ item: exactItem(f.item), amount: count }], accept: offer => offer.length === 0, maxTrades: 1, timeout: 60_000 });
                            console.log('FANIN_TRADE ' + JSON.stringify({ account: name, result: r }));
                        }),
                        handoff.receiveHandoff(receiver, name, server, async () => {
                            const r = await receiver!.bot.trade(exactItem(name), { accept: offer => offer.length === 1 && offer[0]!.id === stack.id && offer[0]!.count === count, requestTimeout: 60_000, timeout: 60_000 });
                            console.log('FANIN_TRADE ' + JSON.stringify({ account: f.receiver, result: r }));
                        }),
                    ]);
                    const failed = transfers.find(r => r.status === 'rejected');
                    if (failed?.status === 'rejected') throw failed.reason;
                    ok = await waitUntil(receiver, () => held(receiver!.sdk.getInventory(), stack.id) === before + count && held(donor!.sdk.getInventory(), stack.id) === 0, { timeoutTicks: 20 });
                    detail = ok ? `${name} gave ${count} ${f.item}` : `trade effect unobserved: ${name} ${count} ${f.item}`;
                }
            } catch (error) { detail = String(error); }
            if (donor) await settle([donor], ok, detail);
            results.push({ from: name, ok, count, detail });
            console.log('FANIN_PAIR ' + JSON.stringify(results.at(-1)));
        }
        // Bank what came in at Varrock West, next to the meeting tiles.
        const got = receiver.sdk.getInventory().find(i => exactItem(f.item).test(i.name));
        if (got && !cancelled) {
            if ((await receiver.bot.openBank()).success && await waitUntil(receiver, () => !!receiver!.bankObservation?.(), { timeoutTicks: 20 })) await depositObserved(receiver, got);
            await receiver.bot.closeBank();
        }
    } catch (error) { results.push({ from: '-', ok: false, count: 0, detail: String(error) }); }
    finally {
        const ok = results.some(r => r.ok && r.count > 0);
        try { if (receiver) await settle([receiver], ok, `fan-in ${results.filter(r => r.ok).length}/${f.donors.length}: ${results.map(r => `${r.from} ${r.ok ? r.count : 'fail'}`).join(', ')}`); }
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); release?.(); }
        console.log('FANIN_RESULT ' + JSON.stringify(results));
        process.exitCode = ok ? 0 : 1;
    }
}
