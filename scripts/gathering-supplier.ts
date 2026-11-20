// Stage or withdraw a gathering specialist supply kit and hand it over at Lumbridge spawn in one Offer-All trade.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf, finish, getWorld, openBot } from '../packages/core/src/bot';
import { isLocalServer } from '../packages/core/src/localserver';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { goTo } from '../packages/core/src/walk';
import { HELPER_SPAWN, startHelperTradeArm, chebDist } from './gathering-specialist-lib';
import {
    assertSupplierAccount,
    DEFAULT_STAGE_BANK,
    hasExactKit,
    parseKitOption,
    runStage,
    withdrawExactKit,
} from './specialist-supplier';

async function runServe(args: string[]): Promise<void> {
    const kitSpec = parseKitOption(args);
    const positional = args.filter(a => !a.startsWith('--'));
    const holder = assertSupplierAccount(positional[0] ?? '', 'holder');
    const specialist = (positional[1] ?? '').trim();
    if (!specialist) throw Error('usage: gathering-supplier.ts <holder> <specialist> [--kit=fletching|fishing|fishing-live|mining|mining-live|thieving|thieving-live] [cap]');
    const capArg = positional.slice(2).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? process.env.CAP ?? (kitSpec ? 1500 : 600));
    if (!Number.isSafeInteger(CAP) || CAP < 50 || CAP > 50000) throw Error(`invalid CAP: ${CAP}`);

    const root = resolve(import.meta.dir, '..');
    const serverHost = (readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', holder, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    if (!serverHost) throw Error(`missing SERVER in bot.env for ${holder}`);
    const stopFile = () => existsSync(join(root, '.practice', `stop-${holder}`)) || (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));

    const s = await openBot(holder);
    const t0 = s.tick();
    const stop = () => stopFile() || s.tick() - t0 >= CAP;
    let handoffDone = false;
    try {
        await waitUntil(s, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
        if (kitSpec && !hasExactKit(s.sdk.getInventory(), kitSpec.kit)) {
            await withdrawExactKit(s, kitSpec.kit, DEFAULT_STAGE_BANK, stop);
        }
        const kit = s.sdk.getInventory().map(i => i.id);
        if (kit.length === 0) throw Error(`${holder} carries no kit to hand over`);
        const p = s.sdk.getState()?.player;
        if (!p || p.level !== 0 || chebDist({ x: p.worldX, z: p.worldZ }, HELPER_SPAWN) > 2) {
            const world = await getWorld();
            const r = await goTo(s, world, HELPER_SPAWN, accountOf(s), { legTimeoutTicks: 240 });
            if (!r.ok) throw Error(`walk to the Lumbridge handoff failed: ${r.detail}`);
        }
        const at = s.sdk.getState()!.player!;
        console.log('SUPPLIER_READY ' + JSON.stringify({
            holder, specialist, ...(kitSpec ? { kit: kitSpec.name } : {}), server: serverHost,
            at: { x: at.worldX, z: at.worldZ, level: at.level }, slots: kit.length,
        }));

        const arm = startHelperTradeArm(s, specialist, stop);
        try {
            while (!stop() && !handoffDone) {
                if (s.sdk.getInventory().length === 0 && !s.sdk.getTradeState().isOpen) {
                    handoffDone = true;
                    console.log('SUPPLIER_HANDOFF ' + JSON.stringify({ holder, specialist, ...(kitSpec ? { kit: kitSpec.name } : {}), tick: s.tick() - t0, items: kit.length }));
                    break;
                }
                await waitTicks(s, 1);
            }
        } finally {
            arm.close();
        }
        await finish([s], handoffDone, handoffDone ? `supplied ${specialist} in ${s.tick() - t0} ticks` : `supplier did not complete handoff within ${CAP} ticks`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.includes('--stage')) await runStage(args);
    else await runServe(args);
}
