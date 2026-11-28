import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { productionReview } from '../../collection';
import { compactExpiredOrderSummary, fleetSidesView } from '../../fleet-view';
import { tradeSettlement, validOrder } from '../../../core/src/fleet-trade-settlement';
import { isLocalServer } from '../../../core/src/localserver';
import { BANKER, every, FILES, MAIN, placeOf, shortPhase, snapshotFiles, type Status } from '../config';
import { world } from '../world';
import { type SwarmJob } from './plans';
import { died, results } from './results';
import { coinsOf, flowRate, foodOf, practiceNames, runStartCoins } from './statuses';

// ---------- alerts ----------
type Alert = { at: number; name: string; kind: 'death' | 'failure' | 'blocked' | 'stuck' | 'idle' | 'logout' | 'efficiency'; text: string; practice?: boolean };
const productionReviews = new Map<string, { at: number; texts: string[] }>();
function alerts(bots: any[], now: number): Alert[] {
    const out: Alert[] = [];
    const prac = practiceNames();
    for (const r of results) if (now - r.at < 12 * 3_600_000 && died(r.text)) out.push({ at: r.at, name: r.name, kind: 'death', text: (r.text.match(/died[^=]\S*(?: \S+){0,4}/)?.[0] ?? 'died').slice(0, 60) });
    for (const r of results) if (now - r.at < 86_400_000 && /logout\s*(fail|timeout|stuck)|logoutFail\w*=[1-9]/i.test(r.text)) out.push({ at: r.at, name: r.name, kind: 'logout', text: 'logout failed' });
    for (const b of bots) {
        if (!b.at) continue;
        const age = now - b.at;
        if(b.result&&!b.practice&&/^ok\b/.test(String(b.result))) productionReviews.set(b.name,{at:b.at,texts:productionReview(b)});
        const review=productionReviews.get(b.name);
        if(review&&now-review.at<3_600_000)for(const text of review.texts)out.push({at:review.at,name:b.name,kind:'efficiency',text});
        if (['failed','died','blocked'].includes(b.operation)) out.push({ at:b.at, name:b.name, kind:b.operation==='died'?'death':b.operation==='blocked'?'blocked':'failure', text:String(b.result||b.phase||'HP 0 observed').slice(0,110) });
        // Running = this process has printed no RESULT yet. No update for 60 s while running: stuck or crashed.
        // A job the swarm disabled or saw end is not stuck; without a swarm job, only the last 15 min count.
        // Fleet stock snapshots omit session results; their age cannot prove a worker is stuck.
        const js = String(b.job?.state ?? '');
        const meant = !b.remote && !b.snapshotOnly && (b.job ? /^(running|starting|external)/.test(js) : age < 15 * 60_000);
        if (!b.result && meant && age > 60_000) out.push({ at: b.at, name: b.name, kind: 'stuck', text: `no status for ${Math.round(age / 1000)} s while running` });
        if (b.fresh && !b.result) {
            const ts = b.tickStats && typeof b.tickStats === 'object' ? b.tickStats : null;
            if (ts && Number.isFinite(ts.currentStandStill)) {
                if (ts.currentStandStill > 20) {
                    const why = typeof ts.currentStandStillWhy === 'string' && ts.currentStandStillWhy ? ts.currentStandStillWhy : 'none';
                    const loc = typeof ts.currentStandStillAt === 'string' && ts.currentStandStillAt ? ` @ ${ts.currentStandStillAt}` : '';
                    out.push({ at: b.at, name: b.name, kind: 'idle', text: `standing still ${ts.currentStandStill} ticks (${why}${loc})` });
                } else if (Number.isFinite(ts.currentDialogTicks) && ts.currentDialogTicks > 20) {
                    out.push({ at: b.at, name: b.name, kind: 'idle', text: `dialog open ${ts.currentDialogTicks} ticks` });
                } else if (Number.isFinite(ts.currentWindowTicks) && ts.currentWindowTicks > 20) {
                    out.push({ at: b.at, name: b.name, kind: 'idle', text: `${ts.currentWindowKind || 'window'} open ${ts.currentWindowTicks} ticks` });
                } else if ((Number.isFinite(ts.windowTicks) && ts.windowTicks >= 100 && Number.isFinite(ts.windowStandStillPct) && ts.windowStandStillPct >= 60)
                    || (Number.isFinite(ts.ticks) && ts.ticks >= 200 && Number.isFinite(ts.standStillPct) && ts.standStillPct >= 60)) {
                    const top = Array.isArray(ts.topIdleBy) && ts.topIdleBy[0]?.[0] ? String(ts.topIdleBy[0][0]) : 'none';
                    const pct = Number.isFinite(ts.windowTicks) && ts.windowTicks >= 100 ? ts.windowStandStillPct : ts.standStillPct;
                    const span = Number.isFinite(ts.windowTicks) && ts.windowTicks >= 100 ? `${ts.windowTicks}t` : `${ts.ticks}t`;
                    out.push({ at: b.at, name: b.name, kind: 'efficiency', text: `high standing-still ${Math.round(pct)}% over ${span} (${top})` });
                } else if (Number.isFinite(ts.currentMoveStreak) && ts.currentMoveStreak > 120) {
                    out.push({ at: b.at, name: b.name, kind: 'efficiency', text: `moving ${ts.currentMoveStreak} ticks without xp/item` });
                }
            } else {
                const tl = String(b.timeline ?? '');
                const mi = tl.match(/i+$/);
                const md = tl.match(/d+$/);
                const mm = tl.match(/m+$/);
                if (mi && mi[0].length > 20) out.push({ at: b.at, name: b.name, kind: 'idle', text: `idle ${mi[0].length} ticks now` });
                else if (md && md[0].length > 20) out.push({ at: b.at, name: b.name, kind: 'idle', text: `dialog open ${md[0].length} ticks` });
                else if (mm && mm[0].length > 120) out.push({ at: b.at, name: b.name, kind: 'efficiency', text: `moving ${mm[0].length} ticks without xp/item` });
                else if (tl.length >= 100) {
                    let idleCount = 0;
                    for (let i = 0; i < tl.length; i++) if (tl[i] === 'i') idleCount++;
                    const pct = (100 * idleCount) / tl.length;
                    if (pct >= 60) out.push({ at: b.at, name: b.name, kind: 'efficiency', text: `high idle ${Math.round(pct)}% over ${tl.length}t` });
                }
            }
            if (/logout fail/i.test(b.phase ?? '')) out.push({ at: b.at, name: b.name, kind: 'logout', text: b.phase });
        }
    }
    // Live accounts first; practice alerts only for the last hour.
    for (const a of out) a.practice = prac.has(a.name);
    const seen = new Set<string>();
    return out.filter(a => !a.practice || now - a.at < 3_600_000).sort((a, b) => Number(!!a.practice) - Number(!!b.practice) || b.at - a.at).filter(a => { const k = a.name + a.kind + a.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}

// ---------- role-aware row data, picked from the swarm job's goal ----------
function roleView(s: Status, job: SwarmJob | null, fresh: boolean, xpRate: number | null) {
    const goal = String(s.goal ?? job?.goal ?? '');
    const pack = s.inventory ?? [];
    if (/^gold farm/i.test(goal)) {
        const coins = coinsOf(s), start = runStartCoins.get(s.name + '|' + s.started);
        const cpt = fresh ? flowRate(s.name, 'coins') : null, eat = fresh ? flowRate(s.name, 'food') : null;
        const food = foodOf(pack), bankFood = foodOf(s.bank);
        // Time until the pack and bank food is gone at the measured eat rate (game time, 0.4 s a tick); the farmer
        // refills its pack from the bank, so the pack alone is not the limit.
        const emptyTicks = eat && eat > 0 ? (food + bankFood) / eat : null;
        return { kind: 'gold', coins, made: start != null ? coins - start : null, coinsPerTick: cpt, food, bankFood, eatPerTick: eat, emptyMs: emptyTicks != null ? emptyTicks * world.tickMs : null };
    }
    // Food chain (research/food-chain.md): the cook banks cooked fish at Draynor; the courier carries them as notes.
    const fishCount = (l: any[] | null | undefined, re: RegExp) => (l ?? []).filter((i: any) => re.test(i?.name ?? '')).reduce((n: number, i: any) => n + i.count, 0);
    if (/^food chain: fish/i.test(goal)) return { kind: 'cook', cooked: fishCount(s.bank, /^(trout|salmon)$/i), raw: fishCount(pack, /^raw (trout|salmon)$/i), cookedPack: fishCount(pack, /^(trout|salmon)$/i), burnt: fishCount(s.bank, /^burnt fish$/i), feathers: fishCount(pack, /^feather$/i), xpPerTick: xpRate };
    if (/^food chain: courier/i.test(goal)) return { kind: 'courier', fish: fishCount(pack, /^(trout|salmon)$/i), coins: coinsOf(s), at: placeOf(s.pos) };
    if (/fish/i.test(goal) || s.role === 'fishing') return { kind: 'fish', xpPerTick: xpRate, feathers: pack.filter((i: any) => i?.name === 'Feather').reduce((n: number, i: any) => n + i.count, 0) };
    if (/woodcut|chop/i.test(goal) || s.role === 'woodcutting') return { kind: 'wood', xpPerTick: xpRate, hp: s.hp ?? null };
    // Only the banker's own goals ('bank', 'give to the bank'); skill goals such as 'Gather and bank ores' stay skill rows.
    if (/^(bank|give to the bank)\b/i.test(goal) || s.name === BANKER) return { kind: 'bank' };
    return { kind: 'xp', xpPerTick: xpRate };
}

// Vault value over time (in memory, one point a minute) for the economy sparkline.
const vaultTrend: { at: number; value: number; coins: number }[] = [];

// Food chain card (research/food-chain.md): the newest fish cook, courier and gold farmers in the live status files
// of the last 6 hours. A courier that last ran give-to-banker.ts with fish still counts as the courier.
function foodChain(st: Map<string, Status>, now: number) {
    const recent = [...st.values()].filter(s => now - s.at < 6 * 3_600_000 && !isLocalServer(s.server) && s.name !== MAIN);
    const newest = (f: (s: Status) => boolean) => recent.filter(f).sort((a, b) => b.at - a.at)[0] ?? null;
    const n = (l: any[] | null | undefined, re: RegExp) => (l ?? []).filter((i: any) => re.test(i?.name ?? '')).reduce((k: number, i: any) => k + i.count, 0);
    const FISH = /^(trout|salmon)$/i, fresh = (s: Status) => now - s.at < 20_000;
    const cook = newest(s => s.goal === 'fishcook.ts');
    const courier = newest(s => s.goal === 'foodcourier.ts' || (s.goal === 'give-to-banker.ts' && /trout|salmon/i.test(String(s.phase ?? ''))));
    if (!cook && !courier) return null;
    const farmers = recent.filter(s => s.goal === 'goldfarm.ts' && fresh(s)).map(s => ({ name: s.name, fresh: true, food: foodOf(s.inventory), bankFood: foodOf(s.bank) }));
    return {
        cook: cook && { name: cook.name, fresh: fresh(cook), at: cook.at, cooked: n(cook.bank, FISH), pack: n(cook.inventory, FISH), raw: n(cook.inventory, /^raw (trout|salmon)$/i), level: (cook.skills ?? []).find((k: any) => k.name === 'Cooking')?.level ?? null },
        courier: courier && { name: courier.name, fresh: fresh(courier), at: courier.at, fish: n(courier.inventory, FISH), place: placeOf(courier.pos), phase: shortPhase(String(courier.phase ?? '')) },
        farmers,
    };
}

type SettledOrderStamp = { mtimeMs: number; size: number; receiptSig: string };
const settledOrdersCache = new Map<string, SettledOrderStamp>();
const openOrderJsonCache = new Map<string, { mtimeMs: number; size: number; value: any }>();
const openReceiptJsonCache = new Map<string, { mtimeMs: number; size: number; value: any }>();

function readJsonCached(cache: Map<string, { mtimeMs: number; size: number; value: any }>, file: string, nowWall: number): any {
    try {
        const st = statSync(file);
        const hit = cache.get(file);
        if (hit && nowWall - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
        const value = JSON.parse(readFileSync(file, 'utf8'));
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
        return value;
    } catch {
        cache.delete(file);
        return null;
    }
}

function isSettledOrder(order: any, receipts: any[], now: number): boolean {
    if (!order || typeof order.id !== 'string') return false;
    if (receipts.some(r => r?.version !== undefined)) {
        return validOrder(order) && tradeSettlement(order, receipts, now).state === 'settled';
    }
    if (receipts.some(r => r?.ok === false)) return false;
    const ok = new Set(receipts.filter(r => r?.ok === true).map(r => r.role));
    return ok.has('from') && ok.has('to');
}

function projectCompactOrder(raw: any): any {
    if (!raw || typeof raw !== 'object') return raw;
    return {
        id: raw.id,
        server: raw.server,
        from: raw.from,
        to: raw.to,
        item: raw.item,
        count: raw.count,
        start: raw.start,
        end: raw.end,
        ...(raw.itemId !== undefined ? { itemId: raw.itemId } : {}),
        ...(raw.extra !== undefined ? { extra: raw.extra } : {}),
        ...(raw.meet !== undefined ? { meet: raw.meet } : {}),
    };
}

type ExpiredUnsettledEntry = { mtimeMs: number; size: number; receiptSig: string; order: any; receipts: any[] };
const expiredUnsettledCache = new Map<string, ExpiredUnsettledEntry>();

// Keep only unresolved orders and their receipts in memory; settled orders retain only a stat stamp and expired
// unsettled orders keep a compact pre-projected summary so thousands of historical trade files do not sit parsed in RAM.
function readOpenFleetOrdersAndReceipts(now: number): { orders: any[]; receipts: any[] } {
    return every(10_000, `open-fleet-orders:${FILES.fleet}`, () => {
        const ordersDir = join(FILES.fleet, 'orders'), receiptsDir = join(FILES.fleet, 'receipts');
        if (!existsSync(ordersDir)) {
            settledOrdersCache.clear();
            expiredUnsettledCache.clear();
            openOrderJsonCache.clear();
            openReceiptJsonCache.clear();
            return { orders: [], receipts: [] };
        }
        const nowWall = Date.now();
        const receiptsByPrefix = new Map<string, string[]>();
        if (existsSync(receiptsDir)) {
            for (const f of readdirSync(receiptsDir)) {
                if (!f.endsWith('.json')) continue;
                const dot = f.lastIndexOf('.', f.length - 6);
                if (dot <= 0) continue;
                const orderId = f.slice(0, dot);
                let list = receiptsByPrefix.get(orderId);
                if (!list) { list = []; receiptsByPrefix.set(orderId, list); }
                list.push(f);
            }
        }
        const orderFiles = new Set<string>();
        const activeOrderFiles = new Set<string>();
        const activeReceiptFiles = new Set<string>();
        const orders: any[] = [];
        const receipts: any[] = [];
        for (const f of readdirSync(ordersDir)) {
            if (!f.endsWith('.json')) continue;
            orderFiles.add(f);
            const full = join(ordersDir, f);
            let st;
            try { st = statSync(full); } catch { continue; }
            const orderId = f.slice(0, -5);
            const rFiles = receiptsByPrefix.get(orderId) ?? [];
            let receiptSig = '';
            if (rFiles.length) {
                const parts: string[] = [];
                for (const rf of rFiles) {
                    try {
                        const rst = statSync(join(receiptsDir, rf));
                        parts.push(`${rf}:${rst.size}:${rst.mtimeMs}`);
                    } catch { /* disappeared */ }
                }
                parts.sort();
                receiptSig = parts.join('|');
            }
            const settled = settledOrdersCache.get(f);
            if (settled && settled.mtimeMs === st.mtimeMs && settled.size === st.size && settled.receiptSig === receiptSig) {
                continue;
            }
            const expiredHit = expiredUnsettledCache.get(f);
            if (expiredHit && nowWall - st.mtimeMs > 1000 && expiredHit.mtimeMs === st.mtimeMs && expiredHit.size === st.size && expiredHit.receiptSig === receiptSig) {
                orders.push(expiredHit.order);
                if (expiredHit.receipts.length) receipts.push(...expiredHit.receipts);
                continue;
            }
            const order = readJsonCached(openOrderJsonCache, full, nowWall);
            if (!order) continue;
            const orderReceipts: any[] = [];
            for (const rf of rFiles) {
                const rFull = join(receiptsDir, rf);
                const rec = readJsonCached(openReceiptJsonCache, rFull, nowWall);
                if (rec) orderReceipts.push(rec);
            }
            if (isSettledOrder(order, orderReceipts, now)) {
                settledOrdersCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, receiptSig });
                expiredUnsettledCache.delete(f);
                openOrderJsonCache.delete(full);
                for (const rf of rFiles) openReceiptJsonCache.delete(join(receiptsDir, rf));
                continue;
            }
            settledOrdersCache.delete(f);
            if (Number.isFinite(order.end) && now > order.end && orderReceipts.every(r => !Number.isFinite(r?.at) || r.at <= now)) {
                const { order: slimOrder, receipts: slimReceipts } = compactExpiredOrderSummary(order, orderReceipts, now);
                expiredUnsettledCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, receiptSig, order: slimOrder, receipts: slimReceipts });
                openOrderJsonCache.delete(full);
                for (const rf of rFiles) openReceiptJsonCache.delete(join(receiptsDir, rf));
                orders.push(slimOrder);
                if (slimReceipts.length) receipts.push(...slimReceipts);
                continue;
            }
            expiredUnsettledCache.delete(f);
            activeOrderFiles.add(full);
            orders.push(projectCompactOrder(order));
            for (const rf of rFiles) activeReceiptFiles.add(join(receiptsDir, rf));
            receipts.push(...orderReceipts);
        }
        for (const key of settledOrdersCache.keys()) if (!orderFiles.has(key)) settledOrdersCache.delete(key);
        for (const key of expiredUnsettledCache.keys()) if (!orderFiles.has(key)) expiredUnsettledCache.delete(key);
        for (const key of openOrderJsonCache.keys()) if (!activeOrderFiles.has(key)) openOrderJsonCache.delete(key);
        for (const key of openReceiptJsonCache.keys()) if (!activeReceiptFiles.has(key)) openReceiptJsonCache.delete(key);
        return { orders, receipts };
    });
}

function fleetSides(now: number, snapshots = snapshotFiles()) {
    const { orders, receipts } = readOpenFleetOrdersAndReceipts(now);
    return fleetSidesView(snapshots, orders, now, receipts);
}

// Live standing-still, dialog/window/move stall, and high-waste summary across fresh local bots for dashboard and tools/now.ts.
function tickHealthView(bots: any[]) {
    const standingStillNow: { name: string; streak: number; at: string | null; why: string | null; standStillPct: number; script: string | null }[] = [];
    const dialogStalls: { name: string; ticks: number; script: string | null }[] = [];
    const windowStalls: { name: string; ticks: number; kind: string; script: string | null }[] = [];
    const moveStalls: { name: string; ticks: number; script: string | null }[] = [];
    const highWaste: { name: string; standStillPct: number; windowStandStillPct: number; windowTicks: number; maxStandStill: number; why: string | null; script: string | null }[] = [];
    let liveBots = 0;
    for (const b of bots) {
        if (!b?.fresh || b.practice || b.result || b.remote || b.snapshotOnly) continue;
        liveBots++;
        const ts = b.tickStats && typeof b.tickStats === 'object' ? b.tickStats : null;
        if (ts && Number.isFinite(ts.ticks)) {
            const streak = Number(ts.currentStandStill) || 0;
            const winTicks = Number(ts.windowTicks) || 0;
            const winPct = Number(ts.windowStandStillPct) || 0;
            const standPct = Number(ts.standStillPct) || 0;
            const dlgTicks = Number(ts.currentDialogTicks) || 0;
            const winOpen = Number(ts.currentWindowTicks) || 0;
            const mvStreak = Number(ts.currentMoveStreak) || 0;
            const topWhy = typeof ts.currentStandStillWhy === 'string' && ts.currentStandStillWhy
                ? ts.currentStandStillWhy
                : (Array.isArray(ts.topIdleBy) && ts.topIdleBy[0]?.[0] ? String(ts.topIdleBy[0][0]) : null);
            const script = typeof ts.script === 'string' ? ts.script : (typeof b.goal === 'string' ? b.goal : null);
            if (streak >= 15) {
                standingStillNow.push({
                    name: b.name,
                    streak,
                    at: typeof ts.currentStandStillAt === 'string' ? ts.currentStandStillAt : (b.pos ? `${b.pos.x},${b.pos.z}` : null),
                    why: topWhy,
                    standStillPct: standPct,
                    script,
                });
            }
            if (dlgTicks > 20) dialogStalls.push({ name: b.name, ticks: dlgTicks, script });
            if (winOpen > 20) windowStalls.push({ name: b.name, ticks: winOpen, kind: String(ts.currentWindowKind || 'window'), script });
            if (mvStreak > 120) moveStalls.push({ name: b.name, ticks: mvStreak, script });
            if ((winTicks >= 60 && winPct >= 40) || (ts.ticks >= 200 && standPct >= 50)) {
                highWaste.push({
                    name: b.name,
                    standStillPct: standPct,
                    windowStandStillPct: winTicks >= 60 ? winPct : standPct,
                    windowTicks: winTicks >= 60 ? winTicks : ts.ticks,
                    maxStandStill: Number(ts.maxStandStill) || streak,
                    why: topWhy,
                    script,
                });
            }
            continue;
        }
        const tl = String(b.timeline ?? '');
        if (!tl.length) continue;
        let idle = 0;
        for (let i = 0; i < tl.length; i++) if (tl[i] === 'i') idle++;
        const streak = tl.match(/i+$/)?.[0].length ?? 0;
        const dlg = tl.match(/d+$/)?.[0].length ?? 0;
        const mv = tl.match(/m+$/)?.[0].length ?? 0;
        const pct = Math.round((1000 * idle) / tl.length) / 10;
        const script = typeof b.goal === 'string' ? b.goal : null;
        if (streak >= 15) {
            standingStillNow.push({
                name: b.name,
                streak,
                at: b.pos ? `${b.pos.x},${b.pos.z}` : null,
                why: null,
                standStillPct: pct,
                script,
            });
        }
        if (dlg > 20) dialogStalls.push({ name: b.name, ticks: dlg, script });
        if (mv > 120) moveStalls.push({ name: b.name, ticks: mv, script });
        if (tl.length >= 60 && pct >= 40) {
            highWaste.push({
                name: b.name,
                standStillPct: pct,
                windowStandStillPct: pct,
                windowTicks: tl.length,
                maxStandStill: streak,
                why: null,
                script,
            });
        }
    }
    standingStillNow.sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name));
    dialogStalls.sort((a, b) => b.ticks - a.ticks || a.name.localeCompare(b.name));
    windowStalls.sort((a, b) => b.ticks - a.ticks || a.name.localeCompare(b.name));
    moveStalls.sort((a, b) => b.ticks - a.ticks || a.name.localeCompare(b.name));
    highWaste.sort((a, b) => b.windowStandStillPct - a.windowStandStillPct || a.name.localeCompare(b.name));
    return {
        liveBots,
        standingStillNow: standingStillNow.slice(0, 15),
        dialogStalls: dialogStalls.slice(0, 15),
        windowStalls: windowStalls.slice(0, 15),
        moveStalls: moveStalls.slice(0, 15),
        highWaste: highWaste.slice(0, 15),
    };
}

export {
    alerts,
    fleetSides,
    foodChain,
    roleView,
    tickHealthView,
    vaultTrend,
};
