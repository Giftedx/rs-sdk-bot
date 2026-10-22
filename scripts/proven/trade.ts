// Proven script 5: giver <bot> (preset trade_giver, 100 coins) trades 50 coins to <bot>b (preset trade_receiver,
// one tile east). Both run in this process. Checks the receiver's coins rose by 50.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitUntil } from '../../packages/core/src/ticks';

const giverName = process.argv[2]!;
const a = await openBot(giverName);
const b = await openBot(`${giverName}b`);
try {
    // A partner who just logged in is not in the nearby-players list for a few ticks ("Player not found nearby").
    const seen = await waitUntil(a, st => (st?.nearbyPlayers ?? []).some((p: { name: string }) => p.name.toLowerCase() === `${giverName}b`.toLowerCase()), { timeoutTicks: 30 });
    if (!seen) await finish([a, b], false, 'partner never appeared nearby');
    const coins0 = countItems(b, /^coins$/i);
    const serve = b.bot.serveTrades({ from: new RegExp(`^${giverName}$`, 'i'), maxTrades: 1, timeout: 60_000 });
    const give = await a.bot.trade(new RegExp(`^${giverName}b$`, 'i'), { give: [{ item: /^coins$/i, amount: 50 }] });
    await serve;
    const coins1 = countItems(b, /^coins$/i);
    await finish([a, b], coins1 - coins0 === 50, `receiver coins ${coins0} -> ${coins1}, trade ${give.success ? 'ok' : (give as any).message}`);
} catch (e) { await finish([a, b], false, String(e)); }
