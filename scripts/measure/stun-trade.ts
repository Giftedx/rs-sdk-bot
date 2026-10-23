// Stun-trade test: can food be handed to a thief inside its 8-tick pickpocket stun for free?
// Usage: bun scripts/measure/stun-trade.ts <bot> [trades=4]. Thief <bot> (preset stun_thief: Thieving 55 at the
// Ardougne knights, no food); helper <bot>b (preset stun_feeder: 26 lobsters, one tile away).
// Code basis: the trade op ([opplayer4,_], interface_trade/scripts/trade.rs2) checks only the duel arena and whether
// the partner is busy (delayed or in a modal); the stun (%stunned) blocks only pickpocketing and walking.
// Prints TRADE <n> lost=<ticks after the stun would have ended> for each trade.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const [name, nArg] = process.argv.slice(2);
const WANT = Number(nArg ?? 4);
const t = await openBot(name!);
const h = await openBot(`${name}b`).catch(async e => finish([t], false, `helper login: ${String(e)}`));
try {
    await waitTicks(t, 5);
    const seen = await waitUntil(t, st => (st?.nearbyPlayers ?? []).some((p: any) => p.name.toLowerCase() === `${name}b`.toLowerCase()), { timeoutTicks: 30 });
    if (!seen) await finish([t, h], false, 'helper never appeared nearby');
    const hp = () => t.sdk.getSkill('Hitpoints')?.level ?? 0;
    const lobs = () => countItems(t, /^lobster$/i);
    const rows: string[] = [];
    let trades = 0, picks = 0;
    const t0 = t.tick();
    while (trades < WANT && t.tick() - t0 < 1500) {
        const p = t.sdk.getState()?.player;
        const knight = (t.sdk.getState()?.nearbyNpcs ?? []).filter((n: any) => /^knight of ardougne$/i.test(n.name) && p && Math.max(Math.abs(n.x - p.worldX), Math.abs(n.z - p.worldZ)) <= 6).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (!knight) { await waitTicks(t, 1); continue; }
        if (hp() <= 4 && lobs() > 0) { await t.bot.eatFood(/^lobster$/i); continue; }
        const op = (knight as any).optionsWithIndex.find((o: any) => /pickpocket/i.test(o.text)).opIndex;
        const hp0 = hp();
        await t.direct({ type: 'interactNpc', npcIndex: (knight as any).index, optionIndex: op, reason: 'SDK' });
        await waitTicks(t, 2);
        picks++;
        if (hp() >= hp0) continue;
        // A fail: the stun started about now. Trade 5 lobsters inside it; the helper walks, the thief does not.
        const stunAt = t.tick();
        const before = lobs();
        if (process.env.FAST === '1') {
            // FAST: a trade opens when both players request each other (sdk sendTradeRequest: "requesting a player who
            // already requested you is the acceptance"). The helper requests first; the thief only answers and
            // accepts. The helper's own ticks do not count on the thief's board.
            const tIdx = (h.sdk.getState()?.nearbyPlayers ?? []).find((q: any) => q.name.toLowerCase() === name!.toLowerCase())?.index;
            const hIdx = (t.sdk.getState()?.nearbyPlayers ?? []).find((q: any) => q.name.toLowerCase() === `${name}b`.toLowerCase())?.index;
            if (tIdx === undefined || hIdx === undefined) { console.log('WARN player index missing'); break; }
const ts = (w: string) => console.log(`STEP ${w} t=${t.tick() - stunAt} thief=${JSON.stringify({o: t.sdk.getState()?.trade?.isOpen, s: t.sdk.getState()?.trade?.screen, th: t.sdk.getState()?.trade?.theirOffer?.length})} helper=${JSON.stringify({o: h.sdk.getState()?.trade?.isOpen, s: h.sdk.getState()?.trade?.screen, my: h.sdk.getState()?.trade?.myOffer?.length})}`);
            const r1 = await h.sdk.sendTradeRequest(tIdx); ts(`helper-request ${r1.success} ${r1.message ?? ''}`);
            await waitTicks(t, 1);
            // The fail script delays the thief (p_delay(0) twice in thieving.rs2), and the server drops a delayed
            // player's clicks, so answer every tick until the trade opens.
            for (let k = 0; k < 8 && !(t.sdk.getState()?.trade?.isOpen); k++) { await t.direct({ type: 'interactPlayer', playerIndex: hIdx, optionIndex: 4, reason: 'SDK' } as any); await waitTicks(t, 1); }
            ts('thief-answered');
            await waitUntil(h, st => st?.trade?.isOpen === true && st.trade.screen === 'offer', { timeoutTicks: 4 });
            ts('open-wait');
            const r3 = await h.bot.offerTradeItems([{ item: /^lobster$/i, amount: 5 }]); ts(`offer ${r3.success} ${r3.message ?? ''}`);
            await h.sdk.sendAcceptTrade();
            await waitUntil(t, st => (st?.trade?.theirOffer?.length ?? 0) > 0, { timeoutTicks: 6 });
            await t.sdk.sendAcceptTrade();
            await waitUntil(t, st => st?.trade?.screen === 'confirm', { timeoutTicks: 6 });
            await h.sdk.sendAcceptTrade();
            await t.sdk.sendAcceptTrade();
            await waitUntil(t, () => lobs() > before, { timeoutTicks: 8 });
        } else {
            const serve = t.bot.serveTrades({ from: new RegExp(`^${name}b$`, 'i'), maxTrades: 1, timeout: 30_000 });
            const give = h.bot.trade(new RegExp(`^${name}$`, 'i'), { give: [{ item: /^lobster$/i, amount: 5 }] });
            await Promise.all([serve, give]);
        }
        const doneAt = t.tick();
        trades++;
        const got = lobs() - before;
        rows.push(`TRADE ${trades} took=${doneAt - stunAt} lost=${Math.max(0, doneAt - stunAt - 8)} got=${got}`);
        console.log(rows[rows.length - 1]);
    }
    await finish([t, h], trades >= 1, `trades=${trades} picks=${picks} ${rows.join(' ; ')}`);
} catch (e) { await finish([t, h], false, String(e)); }
