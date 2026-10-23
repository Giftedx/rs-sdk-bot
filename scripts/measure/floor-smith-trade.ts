// Smithing 1 -> 99 floor with a helper: the smither never banks or walks. Preset floor_smith_trade (smither beside
// the Varrock west smithy anvil (3188,3426), hammer) and helper <bot>b, preset floor_smith_helper (Varrock west bank,
// every bar of the SMITHING bands in its bank). Run: FLOOR_HELPER=floor_smith_helper bun scripts/measure/floor-run.ts
// scripts/measure/floor-smith-trade.ts floor_smith_trade 3
// Per load: both players send "Trade with" (opplayer4) every tick until the trade opens (trade.rs2: the second
// request opens it; a busy partner, delayed or in a modal, refuses it), the helper offers All of each bar and
// accepts, the smither accepts both screens, then uses a bar on the anvil and picks Make 5/10.
// While the smither works, the helper banks for the next load. The helper's ticks are not on the smither's board.
// FLOOR_OVERLAP=1: the helper also sends trade requests during the smith delay (does a trade fit inside it?).
import { openBot, finish } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { SMITHING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, clearDialogs, openBank, bankOpen, bankItems, withdrawN, nearestLoc, countId, dialogOpen, type Meter } from './floor-lib';

const PRODUCT: Record<string, [number, number]> = {
    'bronze dagger': [1119, 0], 'bronze sq shield': [1122, 2], 'bronze warhammer': [1120, 2], 'bronze platebody': [1121, 3],
    'iron warhammer': [1120, 2], 'iron platebody': [1121, 3], 'steel platebody': [1121, 3], 'mithril platebody': [1121, 3],
    'adamant platebody': [1121, 3],
};
interface Job { bar: number; bars: number; band: string; xp: number; level: number }
const SPOT = { x: 3189, z: 3427 }; // helper waits here, east of the smither

const [bot] = process.argv.slice(2);
const s = await openBot(bot!);
const h = await openBot(`${bot}b`).catch(async e => finish([s], false, `helper login: ${String(e)}`));
try {
    await tick(s, 3);
    const m = meter(s, 'Smithing');
    const hm = meter(h, 'Smithing');
    const jobs: Job[] = [];
    for (const st of ladder(SMITHING)) {
        const [bar, bars] = Object.entries(st.band.inputs)[0]!;
        for (let i = 0; i < st.actions; i++) jobs.push({ bar: objId(bar), bars, band: st.band.name, xp: st.band.xp, level: st.band.from });
    }
    // Loads of whole jobs, 27 bar slots each (the smither keeps the hammer).
    const loads: Job[][] = [];
    for (let i = 0; i < jobs.length;) { let slots = 27; const l: Job[] = []; while (i < jobs.length && jobs[i]!.bars <= slots) { slots -= jobs[i]!.bars; l.push(jobs[i]!); i++; } loads.push(l); }
    const need = (l: Job[]) => { const n = new Map<number, number>(); for (const j of l) n.set(j.bar, (n.get(j.bar) ?? 0) + j.bars); return n; };
    const idxOf = (a: Session, name: string) => (a.sdk.getState()?.nearbyPlayers ?? []).find((q: any) => q.name.toLowerCase() === name.toLowerCase())?.index as number | undefined;
    const tradeOpen = (a: Session) => !!(a.sdk.getState() as any)?.trade?.isOpen;
    const screen = (a: Session) => (a.sdk.getState() as any)?.trade?.screen as string | undefined;
    const at = (a: Session, p: { x: number; z: number }) => { const q = a.sdk.getState()!.player!; return Math.max(Math.abs(q.worldX - p.x), Math.abs(q.worldZ - p.z)) <= 0; };

    // ---- Helper: load, walk to the spot, trade, repeat. Runs beside the smither's loop.
    let loaded = -1, served = -1, overlapOpened = 0, helperStop = false;
    let smithing = false;
    // Once a load's trade screen has opened, nobody requests again for that load: a request while the screen is
    // open (or switching from offer to confirm, which reads closed for a tick) resets the trade.
    let openedFor = -1;
    const helperLoop = (async () => {
        for (let li = 0; li < loads.length && !helperStop; li++) {
            if (!(await openBank(h, hm) >= 0)) { console.log(`WARN helper bank at load ${li}`); return; }
            // Deposit the products the smither handed back.
            const seenD = new Set<number>();
            for (const it of inv(h)) if (!seenD.has(it.id)) { seenD.add(it.id); await send(h, hm, { type: 'bankDeposit', slot: it.slot, amount: -1 }); }
            for (const [id, c] of need(loads[li]!)) {
                let b = bankItems(h).find(x => x.id === id);
                for (let r = 0; r < 3 && (!b || b.count < c); r++) { await tick(h); b = bankItems(h).find(x => x.id === id); }
                if (!b || b.count < c) { console.log(`WARN helper bank short of ${id}`); return; }
                await withdrawN(h, hm, b.slot, c);
            }
            await send(h, hm, { type: 'closeModal' });
            const tw = h.tick();
            while ((bankOpen(h) || [...need(loads[li]!)].some(([id, c]) => countId(h, id) < c)) && h.tick() - tw < 30) await tick(h);
            await send(h, hm, { type: 'walkTo', x: SPOT.x, z: SPOT.z });
            while (!at(h, SPOT) && h.tick() - tw < 60) await tick(h);
            loaded = li;
            // Trade: request every tick, offer All of each bar, accept both screens.
            while (served < li && !helperStop) {
                const mi = idxOf(h, bot!);
                if (tradeOpen(h)) openedFor = li;
                if (!tradeOpen(h)) {
                    // Both sides request every tick until the screen opens (the second request opens it).
                    if (openedFor !== li && mi !== undefined && (!smithing || process.env.FLOOR_OVERLAP === '1')) await send(h, hm, { type: 'interactPlayer', playerIndex: mi, optionIndex: 4 });
                } else if (screen(h) === 'offer') {
                    const st: any = h.sdk.getState();
                    if ((st.trade.myOffer?.length ?? 0) === 0) {
                        const seen = new Set<number>();
                        for (const it of inv(h)) if (!seen.has(it.id)) { seen.add(it.id); await h.sdk.sendOfferItem(it.slot, -1); }
                        if (smithing) overlapOpened++;
                    } else if (!st.trade.myAccepted) await h.sdk.sendAcceptTrade();
                } else if (screen(h) === 'confirm' && !(h.sdk.getState() as any).trade.myAccepted) await h.sdk.sendAcceptTrade();
                await tick(h);
            }
        }
    })();

    // ---- Smither.
    let ok = true, waitTicks = 0, tradeTicks = 0, smithTicks = 0, useTicks = 0;
    for (let li = 0; li < loads.length && ok; li++) {
        const tc = s.tick();
        await clearDialogs(s, m, 'close');
        const tw = s.tick();
        while (loaded < li && s.tick() - tw < 200) await tick(s);
        waitTicks += s.tick() - tw;
        // Trade.
        const tt = s.tick();
        const want = need(loads[li]!);
        let closedRun = 0;
        while (s.tick() - tt < 40 && [...want].some(([id, c]) => countId(s, id) < c)) {
            closedRun = tradeOpen(s) ? 0 : closedRun + 1;
            if (openedFor === li && closedRun >= 6) { openedFor = -1; console.log(`NOTE trade ${li} restarted`); }
            const hi = idxOf(s, `${bot}b`);
            if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
            if (tradeOpen(s)) openedFor = li;
            if (!tradeOpen(s)) { if (hi !== undefined && openedFor !== li) await send(s, m, { type: 'interactPlayer', playerIndex: hi, optionIndex: 4 }); }
            else {
                const st: any = s.sdk.getState();
                const offered = (st.trade.theirOffer ?? []).reduce((n: number, x: any) => n + (x.count ?? 1), 0);
                const total = [...want].reduce((n, [, c]) => n + c, 0);
                // Hand the products back in the same trade (the smither never banks).
                const hammer = objId('hammer');
                if (screen(s) === 'offer' && (st.trade.myOffer?.length ?? 0) === 0 && inv(s).some(x => x.id !== hammer)) {
                    const seen = new Set<number>();
                    for (const it of inv(s)) if (it.id !== hammer && !seen.has(it.id)) { seen.add(it.id); await s.sdk.sendOfferItem(it.slot, -1); }
                } else if (!st.trade.myAccepted && (screen(s) === 'confirm' || (offered >= total && (st.trade.myOffer?.length ?? 0) >= (inv(s).some(x => x.id !== hammer) ? 1 : 0)))) await s.sdk.sendAcceptTrade();
            }
            await tick(s);
            if (process.env.FLOOR_DEBUG === '1') {
                const msg = (a: Session) => ((a.sdk.getState() as any)?.gameMessages ?? []).slice(-2).map((g: any) => g.text).join(' | ');
                console.log(`NOTE trade +${s.tick() - tt} hi=${hi} open=${tradeOpen(s)}/${tradeOpen(h)} screen=${screen(s)}/${screen(h)} smith="${msg(s)}" helper="${msg(h)}" sInv=${inv(s).map(x => x.id).join(",")} hInv=${inv(h).length} my=${JSON.stringify((s.sdk.getState() as any)?.trade?.myOffer?.length)} their=${JSON.stringify((s.sdk.getState() as any)?.trade?.theirOffer?.map((x: any) => x.id + "x" + x.count))} acc=${(s.sdk.getState() as any)?.trade?.myAccepted}/${(h.sdk.getState() as any)?.trade?.myAccepted}`);
            }
        }
        served = li;
        const tradeT = s.tick() - tt;
        tradeTicks += tradeT;
        if ([...want].some(([id, c]) => countId(s, id) < c)) { console.log(`WARN trade ${li} did not deliver`); ok = false; break; }
        // Smith the load: one interface session per run of equal jobs.
        const l = loads[li]!;
        let k = 0, useT = 0, smT = 0;
        while (k < l.length) {
            let r = 1;
            while (k + r < l.length && l[k + r]!.band === l[k]!.band) r++;
            // Make 5 and Make 10 run on until the bars run out, so ask only for 1, 5 or 10 and never more than planned.
            r = r >= 10 ? 10 : r >= 5 ? 5 : 1;
            const j = l[k]!;
            if (level(s, 'Smithing') < j.level) { console.log(`WARN level ${level(s, 'Smithing')} < ${j.level}`); ok = false; break; }
            const anvil = (s.sdk.getState()?.nearbyLocs ?? []).find((x: any) => /^anvil$/i.test(x.name) && x.x === 3188 && x.z === 3426) ?? (s.sdk.getState()?.nearbyLocs ?? []).find((x: any) => /^anvil$/i.test(x.name));
            const tu = s.tick();
            const use = () => { const bar = inv(s).find(x => x.id === j.bar)!; return send(s, m, { type: 'useItemOnLoc', itemSlot: bar.slot, x: anvil.x, z: anvil.z, locId: anvil.id }); };
            await clearDialogs(s, m, 'close');
            await use();
            while (!(s.sdk.getState() as any)?.interface?.isOpen && s.tick() - tu < 30) {
                await tick(s);
                if (dialogOpen(s)) { await send(s, m, { type: 'closeModal' }); await use(); m.levelTicks++; }
                else if ((s.tick() - tu) % 3 === 0) await use();
                if (process.env.FLOOR_DEBUG === "1") console.log(`NOTE use +${s.tick() - tu} iface=${(s.sdk.getState() as any)?.interface?.interfaceId} dialog=${dialogOpen(s)} msgs=${((s.sdk.getState() as any)?.gameMessages ?? []).slice(-2).map((g: any) => g.text).join(" | ")}`);
            }
            useT += s.tick() - tu;
            const ts = s.tick();
            const [com, slot] = PRODUCT[j.band]!;
            const op = r === 1 ? 1 : r <= 5 ? 2 : 3;
            const x0 = xp(s, 'Smithing');
            const before = countId(s, j.bar);
            smithing = true;
            await send(s, m, { type: 'clickComponentWithOption', componentId: com, optionIndex: op, slot });
            const target = before - Math.min(r, op === 1 ? 1 : op === 2 ? 5 : 10) * j.bars;
            const click = { type: "clickComponentWithOption", componentId: com, optionIndex: op, slot };
            while (countId(s, j.bar) > target && s.tick() - ts < 80) { await tick(s);
                // A click sent before the interface items arrive is refused or ignored: click again while it shows and no bar went.
                if (countId(s, j.bar) === before && (s.tick() - ts) % 3 === 0 && (s.sdk.getState() as any)?.interface?.isOpen) await send(s, m, click); if (process.env.FLOOR_DEBUG === "1") console.log(`NOTE smith +${s.tick() - ts} iface=${(s.sdk.getState() as any)?.interface?.interfaceId} dialog=${dialogOpen(s)} bars=${countId(s, j.bar)} msgs=${((s.sdk.getState() as any)?.gameMessages ?? []).slice(-1).map((g: any) => g.text).join(" | ")}`); }
            smithing = false;
            const made = (before - countId(s, j.bar)) / j.bars;
            smT += s.tick() - ts;
            band(m, j.band, xp(s, 'Smithing') - x0, s.tick() - ts, made);
            m.actions += made;
            if (made <= 0) { console.log(`WARN nothing smithed for ${j.band}`); ok = false; break; }
            k += made;
        }
        useTicks += useT; smithTicks += smT;
        console.log(`CYCLE ${li + 1} items=${l.length} level=${level(s, 'Smithing')} clear=${tw - tc} waitHelper=${tt - tw} trade=${tradeT} use=${useT} smith=${smT} total=${s.tick() - tc}`);
        if (level(s, 'Smithing') >= 99) break;
    }
    helperStop = true;
    await Promise.race([helperLoop, tick(s, 5)]);
    const line = report(s, m, `waitTicks=${waitTicks} tradeTicks=${tradeTicks} useTicks=${useTicks} smithTicks=${smithTicks} overlapOpened=${overlapOpened}`);
    await finish([s, h], ok && level(s, 'Smithing') >= 99, line);
} catch (e) { await finish([s, h], false, String(e)); }
