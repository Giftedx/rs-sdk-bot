import { join } from 'node:path';
import { productionReview } from '../../collection';
import { fleetSidesView } from '../../fleet-view';
import { isLocalServer } from '../../../core/src/localserver';
import { BANKER, FILES, fleetList, MAIN, placeOf, shortPhase, snapshotFiles, type Status } from '../config';
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
            const tl = String(b.timeline ?? ''), m = tl.match(/i+$/);
            if (m && m[0].length > 20) out.push({ at: b.at, name: b.name, kind: 'idle', text: `idle ${m[0].length} ticks now` });
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
    if (/bank/i.test(goal) || s.name === BANKER) return { kind: 'bank' };
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

function fleetSides(now: number) {
    return fleetSidesView(snapshotFiles(), fleetList(join(FILES.fleet, 'orders')), now, fleetList(join(FILES.fleet, 'receipts')));
}

export {
    alerts,
    fleetSides,
    foodChain,
    roleView,
    vaultTrend,
};
