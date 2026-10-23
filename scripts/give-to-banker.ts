// Give everything to the banker: a finished account takes its banked coins out, walks to the banker in the
// Ardougne south bank (scripts/banker.ts must be running), and trades over its whole pack, one trade per pack.
// Usage: DEMO_OK=1 bun scripts/give-to-banker.ts <bot> [banker=Moneyshot]. Env KEEP=<regex> keeps matching items.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks } from '../packages/core/src/ticks';

const BANK_SPOT = { x: 2654, z: 3283 };
const name = process.argv[2]!;
const banker = process.argv[3] ?? 'Moneyshot';
const keep = process.env.KEEP ? new RegExp(process.env.KEEP, 'i') : null;

const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const p = s.sdk.getState()?.player;
    if (!p || Math.max(Math.abs(p.worldX - BANK_SPOT.x), Math.abs(p.worldZ - 3300)) > 80) {
        await finish([s], false, `not in Ardougne (${p?.worldX},${p?.worldZ})`);
    }
    await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    // Banked coins come out too: coins stack, so they take one slot.
    const o = await s.bot.openBank();
    if (o.success) {
        const banked = (s.sdk.getState()?.bank?.items ?? []).find((i: any) => /^coins$/i.test(i.name));
        if (banked) await s.bot.withdrawItem(/^coins$/i, -1);
        await s.bot.closeBank();
    } else console.log(`WARN openBank ${o.message}`);
    const giveable = () => s.sdk.getInventory().filter(i => !keep?.test(i.name));
    const coins0 = countItems(s, /^coins$/i);
    let trades = 0, items = 0;
    for (let i = 0; i < 6 && giveable().length; i++) {
        const before = giveable().length;
        const names = [...new Set(giveable().map(i => i.name))];
        const r = await s.bot.trade(new RegExp(`^${banker}$`, 'i'), {
            give: names.map(n => ({ item: new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), amount: -1 })),
            timeout: 60_000,
        });
        if (!r.success) { console.log(`WARN trade ${r.reason} ${r.message}`); await waitTicks(s, 5); continue; }
        trades++;
        items += before - giveable().length;
        console.log(`MILESTONE gave ${r.gave.map(g => `${g.count} ${g.name}`).join(', ')}`);
    }
    const left = giveable().length;
    await finish([s], left === 0, `trades=${trades} slots=${items} coins=${coins0} left=${left}`);
} catch (e) {
    await finish([s], false, `error: ${String(e)}`);
}
