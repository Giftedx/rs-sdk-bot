// Measures the specialist's cost of one resupply: helper <bot>b (27 uncut gems) trades them all to <bot>.
// Prints SUPPLY <items received> <specialist ticks from request to items in pack>.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitUntil } from '../../packages/core/src/ticks';

const specName = process.argv[2]!;
const spec = await openBot(specName);
// If the helper login fails, the specialist must still log out (finish does that).
const helper = await openBot(`${specName}b`).catch(async e => finish([spec], false, `helper login: ${String(e)}`));
try {
    await waitUntil(helper, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 20 });
    const gems = (s: typeof spec) => (s.sdk.getState()?.inventory ?? []).filter(i => /^uncut /i.test(i.name)).length;
    const t0 = spec.tick();
    const serve = spec.bot.serveTrades({ from: new RegExp(`^${specName}b$`, 'i'), maxTrades: 1, timeout: 60_000 });
    const give = await helper.bot.trade(new RegExp(`^${specName}$`, 'i'), { give: [{ item: /^uncut /i, amount: -1 }] });
    await serve;
    await waitUntil(spec, () => gems(spec) >= 27, { timeoutTicks: 30 });
    const ticks = spec.tick() - t0;
    console.log(`SUPPLY ${gems(spec)} ${ticks}`);
    await finish([spec, helper], gems(spec) === 27, `received ${gems(spec)} gems in ${ticks} specialist ticks, trade ${give.success}`);
} catch (e) { await finish([spec, helper], false, String(e)); }
