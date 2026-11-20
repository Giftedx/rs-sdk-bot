// Prepare live RANGED_SPECIALIST_LIVE_KIT shortfalls: buy 1x Leather body at Varrock Thessalia, brew Prayer potions from Ranarr supplies, and decant partial Prayer potions to 4-dose.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf, finish, getWorld, openBot } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { runDirectChild } from '../packages/core/src/run-child';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { knownBanks } from '../packages/core/src/trip';
import { goTo, sessionWalker, walkPath } from '../packages/core/src/walk';

export const LIVE_PREP_IDS = {
    coins: 995,
    leatherBody: 1129,
    vialOfWater: 227,
    vialEmpty: 229,
    snapeGrass: 231,
    grimyRanarr: 207,
    ranarrWeed: 257,
    ranarrUnf: 99,
    prayerPot4: 2434,
    prayerPot3: 139,
    prayerPot2: 141,
    prayerPot1: 143,
} as const;

export const PRAYER_POTION_DOSE_IDS: Readonly<Record<1 | 2 | 3 | 4, number>> = {
    1: LIVE_PREP_IDS.prayerPot1,
    2: LIVE_PREP_IDS.prayerPot2,
    3: LIVE_PREP_IDS.prayerPot3,
    4: LIVE_PREP_IDS.prayerPot4,
};

export interface PrayerDoseCounts {
    1: number;
    2: number;
    3: number;
    4: number;
}

export interface DecantCombineStep {
    readonly fromDose: 1 | 2 | 3;
    readonly toDose: 1 | 2 | 3;
    readonly outHighDose: 2 | 3 | 4;
    readonly outLowDose: 0 | 1 | 2;
}

export interface PrayerDecantPlan {
    readonly totalDoses: number;
    readonly steps: readonly DecantCombineStep[];
    readonly finalCounts: PrayerDoseCounts;
    readonly emptyVialsProduced: number;
}

export interface PrayerBrewPlan {
    readonly herbloreLevel: number;
    readonly canClean: boolean;
    readonly canBrew: boolean;
    readonly brewable: number;
    readonly cleanNeeded: number;
    readonly unfNeeded: number;
    readonly vialsNeeded: number;
    readonly snapeNeeded: number;
}

export type PrepMode = 'all' | 'leather' | 'brew' | 'decant';

export interface RangedLivePrepArgs {
    readonly account: string;
    readonly mode: PrepMode;
    readonly cap: number;
    readonly bankSpot?: { readonly x: number; readonly z: number; readonly level: number };
}

const BANK_PRESETS: Readonly<Record<string, { readonly x: number; readonly z: number; readonly level: number }>> = {
    draynor: { x: 3092, z: 3243, level: 0 },
    edgeville: { x: 3094, z: 3491, level: 0 },
    varrock_east: { x: 3253, z: 3420, level: 0 },
    varrock_west: { x: 3185, z: 3436, level: 0 },
};

const ACCOUNT_RE = /^[A-Za-z0-9_ -]{1,12}$/;

/** Build ordered pairwise combine moves (never using 4-dose pots, matching decant_potion.rs2) to maximize 4-dose Prayer potions. */
export function planPrayerDecantSteps(initial: Readonly<PrayerDoseCounts>): PrayerDecantPlan {
    const counts: PrayerDoseCounts = {
        1: Math.max(0, Math.floor(initial[1])),
        2: Math.max(0, Math.floor(initial[2])),
        3: Math.max(0, Math.floor(initial[3])),
        4: Math.max(0, Math.floor(initial[4])),
    };
    const steps: DecantCombineStep[] = [];
    let emptyVialsProduced = 0;

    const combine = (a: 1 | 2 | 3, b: 1 | 2 | 3): void => {
        counts[a]--;
        counts[b]--;
        const sum = a + b;
        const high = Math.min(4, sum) as 2 | 3 | 4;
        const low = (sum - high) as 0 | 1 | 2;
        counts[high]++;
        if (low === 1 || low === 2) counts[low]++;
        else emptyVialsProduced++;
        steps.push({ fromDose: a, toDose: b, outHighDose: high, outLowDose: low });
    };

    // Prioritize creating 4-dose pots via (3,3), (3,2), (3,1), (2,2), then consolidate leftovers upward toward 4.
    while (counts[3] + counts[2] + counts[1] >= 2) {
        if (counts[3] >= 2) combine(3, 3);
        else if (counts[3] >= 1 && counts[2] >= 1) combine(3, 2);
        else if (counts[3] >= 1 && counts[1] >= 1) combine(3, 1);
        else if (counts[2] >= 2) combine(2, 2);
        else if (counts[2] >= 1 && counts[1] >= 1) combine(2, 1);
        else if (counts[1] >= 2) combine(1, 1);
        else break;
    }

    const totalDoses = counts[4] * 4 + counts[3] * 3 + counts[2] * 2 + counts[1];
    return { totalDoses, steps, finalCounts: counts, emptyVialsProduced };
}

/** Plan how many Prayer potion(3) can be brewed from owned Grimy/clean ranarr, Ranarr unf, Vial of water, and Snape grass. */
export function planPrayerBrewBatch(stock: ReadonlyMap<number, number>, herbloreLevel: number): PrayerBrewPlan {
    const canClean = herbloreLevel >= 25;
    const canBrew = herbloreLevel >= 38;
    const grimy = stock.get(LIVE_PREP_IDS.grimyRanarr) ?? 0;
    const clean = stock.get(LIVE_PREP_IDS.ranarrWeed) ?? 0;
    const unf = stock.get(LIVE_PREP_IDS.ranarrUnf) ?? 0;
    const vials = stock.get(LIVE_PREP_IDS.vialOfWater) ?? 0;
    const snape = stock.get(LIVE_PREP_IDS.snapeGrass) ?? 0;
    if (!canBrew || snape <= 0) {
        return { herbloreLevel, canClean, canBrew, brewable: 0, cleanNeeded: 0, unfNeeded: 0, vialsNeeded: 0, snapeNeeded: 0 };
    }
    const unfUsed = Math.min(unf, snape);
    const snapeAfterUnf = snape - unfUsed;
    const usableHerbs = clean + (canClean ? grimy : 0);
    const herbBrews = Math.min(usableHerbs, vials, snapeAfterUnf);
    const cleanNeeded = Math.max(0, herbBrews - clean);
    return {
        herbloreLevel,
        canClean,
        canBrew,
        brewable: unfUsed + herbBrews,
        cleanNeeded,
        unfNeeded: unfUsed,
        vialsNeeded: herbBrews,
        snapeNeeded: unfUsed + herbBrews,
    };
}

/** Exact child-process invocation for buying 1x Leather body (1129) from Thessalia at Varrock clotheshop. */
export function buildLeatherBodyShopInvocation(account: string, cap = 600): {
    args: readonly string[];
    env: Readonly<Record<string, string>>;
} {
    return {
        args: ['scripts/shop-buyer.ts', account, 'data:clotheshop', String(cap)],
        env: {
            ITEMS: 'leather body',
            STOCK_TARGET: '1',
            STOP_AT_TARGET: '1',
            MAX_ITEMS: '1',
            BANK_PACK: '1',
            FLOAT: '500',
            COIN_RESERVE: '0',
            MAX_SPEND: '100',
            NO_BUY_TICKS: '25',
            BANK_AT: '1',
        },
    };
}

export function parseRangedLivePrepArgs(argv: readonly string[]): RangedLivePrepArgs {
    const modeRaw = (argv.find(a => a.startsWith('--mode='))?.slice(7) ?? 'all').trim().toLowerCase();
    if (modeRaw !== 'all' && modeRaw !== 'leather' && modeRaw !== 'brew' && modeRaw !== 'decant') {
        throw Error(`ranged-live-prep: unknown --mode=${modeRaw} (expected all|leather|brew|decant)`);
    }
    const bankRaw = argv.find(a => a.startsWith('--bank='))?.slice(7).trim().toLowerCase();
    const bankSpot = bankRaw ? BANK_PRESETS[bankRaw] : undefined;
    if (bankRaw && !bankSpot) {
        throw Error(`ranged-live-prep: unknown --bank=${bankRaw} (expected ${Object.keys(BANK_PRESETS).join('|')})`);
    }
    const capFlag = argv.find(a => a.startsWith('--cap='))?.slice(6);
    const positional = argv.filter(a => !a.startsWith('--'));
    const account = positional[0] ?? '';
    if (!account || !ACCOUNT_RE.test(account)) throw Error(`ranged-live-prep: invalid account "${account}"`);
    if (RESERVED_ACCOUNTS.includes(account.toLowerCase())) throw Error(`ranged-live-prep: refuses reserved account "${account}"`);
    const cap = Number(capFlag ?? positional[1] ?? process.env.CAP ?? 1500);
    if (!Number.isSafeInteger(cap) || cap < 50 || cap > 20000) throw Error(`ranged-live-prep: invalid cap ${cap}`);
    return { account, mode: modeRaw, cap, bankSpot };
}

function stockMapFromRows(rows: readonly { id: number; count?: number }[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const r of rows) out.set(r.id, (out.get(r.id) ?? 0) + (r.count ?? 0));
    return out;
}

function countInInv(s: Session, id: number): number {
    return s.sdk.getInventory().reduce((sum, i) => (i.id === id ? sum + i.count : sum), 0);
}

async function moveToSpot(s: Session, to: { readonly x: number; readonly z: number; readonly level: number }, stop: () => boolean): Promise<void> {
    const p = s.sdk.getState()?.player;
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 2) return;
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 24) {
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: to.x, z: to.z, tol: 2 }], { maxTicks: 80, stop });
        if (r.ok) return;
    }
    const world = await getWorld();
    const r = await goTo(s, world, { x: to.x, z: to.z, level: to.level }, accountOf(s), { legTimeoutTicks: 150 });
    if (!r.ok) throw Error(`walk to ${to.x},${to.z},${to.level} failed: ${r.detail ?? r.reason}`);
}

async function openFreshBank(s: Session, fallbackBank: { readonly x: number; readonly z: number; readonly level: number }, stop: () => boolean) {
    if (!(await s.bot.openBank()).success) {
        await moveToSpot(s, fallbackBank, stop);
        const r = await s.bot.openBank();
        if (!r.success) throw Error(`openBank failed: ${r.message ?? r.reason}`);
    }
    const ok = await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 15 });
    if (!ok) throw Error('bank did not open');
}

async function depositAll(s: Session): Promise<void> {
    while (s.sdk.getInventory().length > 0) {
        const first = s.sdk.getInventory()[0];
        if (!first) break;
        const r = await s.bot.depositItem(first, -1);
        if (!r.success) throw Error(`deposit failed for ${first.name}: ${r.message ?? r.reason}`);
        await waitUntil(s, () => !s.sdk.getInventory().some(i => i.id === first.id), { timeoutTicks: 10 });
    }
}

async function withdrawExact(s: Session, id: number, count: number): Promise<void> {
    if (count <= 0) return;
    const row = s.sdk.getBankItems().find(i => i.id === id);
    if (!row || row.count < count) throw Error(`bank missing item ${id}: need ${count}, have ${row?.count ?? 0}`);
    const before = countInInv(s, id);
    const w = await s.bot.withdrawItem(row, count, { asNote: false });
    if (!w.success || !(await waitUntil(s, () => countInInv(s, id) === before + count, { timeoutTicks: 10 }))) {
        throw Error(`withdraw failed for ${id} x${count}: ${w.message ?? w.reason ?? 'count mismatch'}`);
    }
}

async function useItemPairConfirmed(s: Session, aId: number, bId: number, check: () => boolean, label: string): Promise<void> {
    const a = s.sdk.getInventory().find(i => i.id === aId && (aId !== bId || true));
    const b = aId === bId
        ? s.sdk.getInventory().find(i => i.id === bId && i.slot !== a?.slot)
        : s.sdk.getInventory().find(i => i.id === bId);
    if (!a || !b) throw Error(`missing pair (${aId}, ${bId}) for ${label}`);
    await s.sdk.sendUseItemOnItem(a.slot, b.slot);
    if (!(await waitUntil(s, check, { timeoutTicks: 10 }))) {
        throw Error(`item combine ${label} did not settle`);
    }
}

export async function runRangedLivePrep(opts: RangedLivePrepArgs): Promise<void> {
    const root = resolve(import.meta.dir, '..');
    const serverHost = (readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', opts.account, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    if (!serverHost) throw Error(`missing SERVER in bot.env for ${opts.account}`);

    let boughtLeatherBody = false;
    let brewed3Dose = 0;
    let decantedSteps = 0;

    if (opts.mode === 'leather') {
        const shopCall = buildLeatherBodyShopInvocation(opts.account, Math.min(600, opts.cap));
        const out = await runDirectChild([...shopCall.args], { ...process.env, ...shopCall.env });
        if (!/^RESULT ok(?: |$)/.test(out)) throw Error(`Thessalia Leather body buy failed: ${out}`);
        boughtLeatherBody = true;
        console.log('RANGED_LIVE_PREP ' + JSON.stringify({ account: opts.account, mode: opts.mode, leatherBodyBought: true, brewed3Dose: 0, decantedSteps: 0 }));
        return;
    }

    // For 'all', first inspect bank in a single login? Wait: if Leather body is absent and coins suffice, buy via shop-buyer before opening main bank for brew/decant.
    const s0 = await openBot(opts.account);
    let activeSession: Session | undefined = s0;
    const stopFile = () => existsSync(join(root, '.practice', `stop-${opts.account}`)) || (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));
    try {
        await waitUntil(s0, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
        const t0 = s0.tick();
        const stop = () => stopFile() || s0.tick() - t0 >= opts.cap;
        const p0 = s0.sdk.getState()!.player!;
        const fallbackBank = opts.bankSpot ?? (() => {
            const nearest = knownBanks()
                .filter(b => b.level === p0.level)
                .sort((a, b) => Math.max(Math.abs(a.x - p0.worldX), Math.abs(a.z - p0.worldZ)) - Math.max(Math.abs(b.x - p0.worldX), Math.abs(b.z - p0.worldZ)))[0];
            return nearest ?? BANK_PRESETS.draynor!;
        })();

        await openFreshBank(s0, fallbackBank, stop);
        await depositAll(s0);

        const initialTotals = stockMapFromRows(s0.sdk.getBankItems());
        const needLeather = opts.mode === 'all' && (initialTotals.get(LIVE_PREP_IDS.leatherBody) ?? 0) < 1 && (initialTotals.get(LIVE_PREP_IDS.coins) ?? 0) >= 25;
        if (needLeather) {
            await s0.bot.closeBank();
            await finish([s0], true, 'handoff to Thessalia shop purchase before brew/decant');
            activeSession = undefined;
            const shopCall = buildLeatherBodyShopInvocation(opts.account, Math.min(600, opts.cap));
            const out = await runDirectChild([...shopCall.args], { ...process.env, ...shopCall.env });
            if (!/^RESULT ok(?: |$)/.test(out)) throw Error(`Thessalia Leather body buy failed: ${out}`);
            boughtLeatherBody = true;
            const s1 = await openBot(opts.account);
            activeSession = s1;
            await waitUntil(s1, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
            await openFreshBank(s1, fallbackBank, () => stopFile() || s1.tick() - t0 >= opts.cap);
            await depositAll(s1);
        }

        const s = activeSession!;
        const herbLv = s.sdk.getSkill('Herblore')?.baseLevel ?? 1;
        if (opts.mode === 'all' || opts.mode === 'brew') {
            while (!stopFile()) {
                const brewPlan = planPrayerBrewBatch(stockMapFromRows(s.sdk.getBankItems()), herbLv);
                if (brewPlan.brewable <= 0) break;
                const bankNow = stockMapFromRows(s.sdk.getBankItems());
                const unfBatch = Math.min(9, brewPlan.unfNeeded);
                const herbBatch = Math.min(9 - unfBatch, brewPlan.brewable - unfBatch);
                const grimyCount = Math.min(herbBatch, bankNow.get(LIVE_PREP_IDS.grimyRanarr) ?? 0, brewPlan.cleanNeeded);
                const cleanCount = herbBatch - grimyCount;
                await withdrawExact(s, LIVE_PREP_IDS.ranarrUnf, unfBatch);
                await withdrawExact(s, LIVE_PREP_IDS.grimyRanarr, grimyCount);
                await withdrawExact(s, LIVE_PREP_IDS.ranarrWeed, cleanCount);
                await withdrawExact(s, LIVE_PREP_IDS.vialOfWater, herbBatch);
                await withdrawExact(s, LIVE_PREP_IDS.snapeGrass, unfBatch + herbBatch);
                await s.bot.closeBank();
                await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });

                while (countInInv(s, LIVE_PREP_IDS.grimyRanarr) > 0 && !stopFile()) {
                    const g0 = countInInv(s, LIVE_PREP_IDS.grimyRanarr);
                    const c0 = countInInv(s, LIVE_PREP_IDS.ranarrWeed);
                    const item = s.sdk.getInventory().find(i => i.id === LIVE_PREP_IDS.grimyRanarr)!;
                    await s.sdk.sendUseItem(item.slot, 1);
                    if (!(await waitUntil(s, () => countInInv(s, LIVE_PREP_IDS.grimyRanarr) === g0 - 1 && countInInv(s, LIVE_PREP_IDS.ranarrWeed) === c0 + 1, { timeoutTicks: 8 }))) {
                        throw Error('failed to clean Grimy ranarr');
                    }
                }
                while (countInInv(s, LIVE_PREP_IDS.ranarrWeed) > 0 && countInInv(s, LIVE_PREP_IDS.vialOfWater) > 0 && !stopFile()) {
                    const r0 = countInInv(s, LIVE_PREP_IDS.ranarrWeed);
                    const u0 = countInInv(s, LIVE_PREP_IDS.ranarrUnf);
                    await useItemPairConfirmed(s, LIVE_PREP_IDS.ranarrWeed, LIVE_PREP_IDS.vialOfWater, () => countInInv(s, LIVE_PREP_IDS.ranarrWeed) === r0 - 1 && countInInv(s, LIVE_PREP_IDS.ranarrUnf) === u0 + 1, 'ranarr+vial');
                }
                while (countInInv(s, LIVE_PREP_IDS.ranarrUnf) > 0 && countInInv(s, LIVE_PREP_IDS.snapeGrass) > 0 && !stopFile()) {
                    const u0 = countInInv(s, LIVE_PREP_IDS.ranarrUnf);
                    const p0c = countInInv(s, LIVE_PREP_IDS.prayerPot3);
                    await useItemPairConfirmed(s, LIVE_PREP_IDS.ranarrUnf, LIVE_PREP_IDS.snapeGrass, () => countInInv(s, LIVE_PREP_IDS.ranarrUnf) === u0 - 1 && countInInv(s, LIVE_PREP_IDS.prayerPot3) === p0c + 1, 'unf+snape');
                    brewed3Dose++;
                }
                await openFreshBank(s, fallbackBank, () => stopFile());
                await depositAll(s);
            }
        }

        const beforeDecantMap = stockMapFromRows(s.sdk.getBankItems());
        const prayer4Before = beforeDecantMap.get(LIVE_PREP_IDS.prayerPot4) ?? 0;

        if (opts.mode === 'all' || opts.mode === 'decant') {
            const decantPlan = planPrayerDecantSteps({
                1: beforeDecantMap.get(LIVE_PREP_IDS.prayerPot1) ?? 0,
                2: beforeDecantMap.get(LIVE_PREP_IDS.prayerPot2) ?? 0,
                3: beforeDecantMap.get(LIVE_PREP_IDS.prayerPot3) ?? 0,
                4: prayer4Before,
            });
            if (decantPlan.steps.length > 0) {
                const need1 = beforeDecantMap.get(LIVE_PREP_IDS.prayerPot1) ?? 0;
                const need2 = beforeDecantMap.get(LIVE_PREP_IDS.prayerPot2) ?? 0;
                const need3 = beforeDecantMap.get(LIVE_PREP_IDS.prayerPot3) ?? 0;
                if (need1 + need2 + need3 > 28) throw Error(`decant batch exceeds 28 slots (${need1 + need2 + need3})`);
                await withdrawExact(s, LIVE_PREP_IDS.prayerPot3, need3);
                await withdrawExact(s, LIVE_PREP_IDS.prayerPot2, need2);
                await withdrawExact(s, LIVE_PREP_IDS.prayerPot1, need1);
                await s.bot.closeBank();
                await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });

                for (const step of decantPlan.steps) {
                    const aId = PRAYER_POTION_DOSE_IDS[step.fromDose];
                    const bId = PRAYER_POTION_DOSE_IDS[step.toDose];
                    const outHighId = PRAYER_POTION_DOSE_IDS[step.outHighDose];
                    const highBefore = countInInv(s, outHighId);
                    await useItemPairConfirmed(
                        s,
                        aId,
                        bId,
                        () => countInInv(s, outHighId) === highBefore + 1,
                        `prayer(${step.fromDose})+prayer(${step.toDose})->(${step.outHighDose})`,
                    );
                    decantedSteps++;
                    await waitTicks(s, 1);
                }
                await openFreshBank(s, fallbackBank, () => stopFile());
                await depositAll(s);
            }
        }

        const finalBank = stockMapFromRows(s.sdk.getBankItems());
        const prayer4After = finalBank.get(LIVE_PREP_IDS.prayerPot4) ?? 0;
        const totalDosesAfter =
            prayer4After * 4
            + (finalBank.get(LIVE_PREP_IDS.prayerPot3) ?? 0) * 3
            + (finalBank.get(LIVE_PREP_IDS.prayerPot2) ?? 0) * 2
            + (finalBank.get(LIVE_PREP_IDS.prayerPot1) ?? 0);
        const leatherBodyCount = finalBank.get(LIVE_PREP_IDS.leatherBody) ?? 0;
        await s.bot.closeBank();

        const summary = {
            account: opts.account,
            mode: opts.mode,
            leatherBodyBought: boughtLeatherBody,
            leatherBodyCount,
            brewed3Dose,
            decantedSteps,
            prayer4Before,
            prayer4After,
            totalDosesAfter,
        };
        console.log('RANGED_LIVE_PREP ' + JSON.stringify(summary));
        await finish([s], true, `ranged-live-prep(${opts.mode}) leather=${leatherBodyCount} brewed=${brewed3Dose} prayer4=${prayer4Before}->${prayer4After}`);
    } catch (e) {
        if (activeSession) await finish([activeSession], false, String(e));
        else throw e;
    }
}

if (import.meta.main) {
    const opts = parseRangedLivePrepArgs(process.argv.slice(2));
    await runRangedLivePrep(opts);
}
