import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { openBot, randomEventsOf } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitUntil } from '../../../core/src/ticks';
import { expandPath, sessionWalker, walkPath } from '../../../core/src/walk';
import {
    bankTotals,
    claimSettlement,
    collectClaim,
    expectedRescueStop,
    GE_EXCHANGE_SPOT,
    GE_VARROCK_BANK,
    HEAL_FOOD,
    leaveBattlefield,
    loadGeItemCatalogue,
    marketEntryFailure,
    marketEntryTrace,
    marketTileSafe,
    orderAccounting,
    orderEscrow,
    orderItemMatcher,
    orderPaths,
    orderQuantity,
    orderRefusal,
    ownedBaseline,
    prepareMarketEntry,
    priorRounds,
    reconcilePlacement,
    rescueBank,
    rescueKit,
    rescuePocket,
    roundBaseline,
    terminalOrderClaim,
    validateRequest,
    collectionApplied,
    collectionRetrySafe,
    placementRetrySafe,
    observeOrderProgress,
    type RescueControl,
} from './ge-common';
import type { ItemOrder, ItemRequest, OrderView, RescueReceipt, SettledRound } from './types';
import { DRAYNOR_BANK, LUMBRIDGE_TO_DRAYNOR } from './walk';

export type { RescueControl };

let cachedCatalogue: readonly { id: number; name: string }[] | undefined;
const catalogue = () => (cachedCatalogue ??= loadGeItemCatalogue());

export function openOrderSession(actor: string, request: ItemRequest, rescue: RescueControl, onStop: () => void) {
    validateRequest(request);
    if (request.rescueMode === 'npc-respawn-once') process.env.DEATH_RECOVERY = '0';
    return openBot(actor, {
        onStop: async (session, detail) => {
            if (!expectedRescueStop(session, detail, rescue)) onStop();
        },
        onSessionEnd: async () => {
            onStop();
        },
    });
}

export async function rescueMarketEntry(
    s: Session,
    request: ItemRequest,
    journalPath: string,
    stop: () => boolean,
    c: RescueControl,
    suppliedSnapshot: ReturnType<typeof rescueBank> | undefined = undefined,
    stage: (signal: AbortSignal) => Promise<{ ok: boolean }> = async signal =>
        walkPath(await sessionWalker(s), LUMBRIDGE_TO_DRAYNOR.map(([x, z, tol]) => ({ x, z, tol })), { signal, maxTicks: 500 }),
) {
    const st = s.sdk.getState();
    const p = st?.player;
    const hp = s.sdk.getSkill('Hitpoints');
    if (existsSync(journalPath)) throw Error('rescue intent already exists; uncertain rescue cannot repeat');
    if (stop() || !rescuePocket(p) || !rescueKit(s) || !p || p.isDead || !hp || !Number.isFinite(hp.level) || hp.level <= 0
        || !Number.isSafeInteger(p.lifeId) || !Number.isSafeInteger(p.respawnCount) || !Number.isFinite(hp.baseLevel) || hp.baseLevel <= 6) {
        throw Error('rescue refused: pocket, fresh unskulled state, sole tinderbox590 and no equipment required');
    }
    let wolf: NonNullable<typeof st>['nearbyNpcs'][number] | undefined;
    const nearbyNpcs = st?.nearbyNpcs;
    if (nearbyNpcs) {
        let bestDist = Infinity;
        for (let i = 0; i < nearbyNpcs.length; i++) {
            const n = nearbyNpcs[i]!;
            if (n.kind !== 'npc' || n.combatLevel !== 25 || n.reachable !== true
                || !Number.isSafeInteger(n.index) || n.index < 0
                || !Number.isFinite(n.distance) || n.distance <= 0 || n.distance > 16 || n.distance >= bestDist
                || !/^white wolf$/i.test(n.name)) continue;
            if (n.optionsWithIndex.some(o => /^attack$/i.test(o.text))) {
                bestDist = n.distance;
                wolf = n;
            }
        }
    }
    if (!wolf) throw Error('rescue refused: observed reachable White wolf25 required');
    const snapshot = suppliedSnapshot ?? rescueBank(request);
    const totals = new Map(bankTotals(snapshot.bank));
    ownedBaseline(request, totals.get(request.item) ?? 0);
    if ((totals.get(995) ?? 0) < orderEscrow(request) + request.reserve) throw Error('rescue refused: owned bank funding/reserve missing');
    const receipt: RescueReceipt = { phase: 'attempted', lifeId: p.lifeId, respawnCount: p.respawnCount, targetIndex: wolf.index, ...snapshot };
    const j: ItemOrder = {
        version: 1,
        request,
        phase: 'entry',
        coinsBefore: totals.get(995) ?? 0,
        itemsBefore: totals.get(request.item) ?? 0,
        previousIds: [],
        at: Date.now(),
        rescue: receipt,
    };
    const save = () => {
        j.at = Date.now();
        writeFileSync(journalPath + '.tmp', JSON.stringify(j, null, 2));
        renameSync(journalPath + '.tmp', journalPath);
    };
    const initial = { lifeId: p.lifeId, respawnCount: p.respawnCount };
    const baseHp = hp.baseLevel;
    const start = s.tick();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const halted = () => ended || stop() || Date.now() >= request.deadline;
    try {
        if (halted() || !rescueKit(s) || !rescuePocket(s.sdk.getState()?.player)) throw Error('rescue pre-engagement state changed');
        save();
        Object.assign(c, { active: true, start, ...initial });
        marketEntryTrace(s, 'rescue-intent', { targetIndex: wolf.index, lifeId: initial.lifeId, respawnCount: initial.respawnCount });
        const respawnOnce = async () => {
            try {
                await s.sdk.sendInteractNpc(wolf.index, wolf.optionsWithIndex.find(o => /^attack$/i.test(o.text))!.opIndex);
            } catch (error) {
                marketEntryTrace(s, 'rescue-attack-return', { error: String(error) });
            }
            const observed = await waitUntil(s, () => {
                const q = s.sdk.getState()?.player;
                if (halted()) throw Error('rescue stopped/disconnected/deadline');
                if (s.sdk.getStateAge() > 5000 || !q) throw Error('rescue state unknown');
                if (q.lifeId > initial.lifeId + 1 || q.respawnCount > initial.respawnCount + 1) throw Error('rescue unexpected second death');
                return q.lifeId === initial.lifeId + 1 && q.respawnCount === initial.respawnCount + 1 && !q.isDead
                    && q.level === 0 && Math.max(Math.abs(q.worldX - 3221), Math.abs(q.worldZ - 3218)) <= 3
                    && s.sdk.getSkill('Hitpoints')?.level === baseHp && rescueKit(s);
            }, { timeoutTicks: Math.max(1, 240 - (s.tick() - start)) });
            if (!observed || halted() || s.tick() - start >= 240) throw Error('rescue single Lumbridge respawn/retained kit/restored HP unproved');
        };
        const watch = randomEventsOf(s);
        if (watch) await watch.exclusive(respawnOnce);
        else await respawnOnce();
        c.active = false;
        receipt.phase = 'respawned';
        save();
        marketEntryTrace(s, 'rescue-respawned', { ...initial });
        const ac = new AbortController();
        const q0 = { ...s.sdk.getState()!.player! };
        const stageStart = s.tick();
        const guard = () => {
            const q = s.sdk.getState()?.player;
            if (halted() || s.tick() - stageStart >= 500 || !q || q.isDead || q.lifeId !== q0.lifeId || q.respawnCount !== q0.respawnCount
                || s.sdk.getSkill('Hitpoints')?.level !== baseHp || !rescueKit(s)) {
                ac.abort('rescue staging health/stop/state');
            }
        };
        const off = s.onTick(guard);
        try {
            guard();
            ac.signal.throwIfAborted();
            const walked = await stage(ac.signal);
            guard();
            ac.signal.throwIfAborted();
            const q = s.sdk.getState()?.player;
            if (!walked.ok || !q || q.level !== 0 || Math.max(Math.abs(q.worldX - DRAYNOR_BANK.x), Math.abs(q.worldZ - DRAYNOR_BANK.z)) > 2) {
                throw Error('rescue Draynor arrival unproved');
            }
            const generation = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success
                || !await waitUntil(s, () => {
                    guard();
                    return ac.signal.aborted || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation);
                }, { timeoutTicks: 15, signal: ac.signal })) {
                throw Error('rescue fresh Draynor bank unproved');
            }
            guard();
            ac.signal.throwIfAborted();
            const bank = s.bankObservation?.();
            if (!bank || JSON.stringify(bankTotals(bank.items)) !== JSON.stringify(bankTotals(snapshot.bank))) {
                throw Error('rescue complete bank assets changed');
            }
            await s.bot.closeBank();
            guard();
            ac.signal.throwIfAborted();
            receipt.phase = 'bank-reconciled';
            save();
            marketEntryTrace(s, 'rescue-bank-reconciled', { bank: bank.items });
        } finally {
            off();
            ac.abort();
        }
        return j;
    } catch (error) {
        j.failure = String(error);
        save();
        throw error;
    } finally {
        c.active = false;
    }
}

export async function runOwnedItem(
    s: Session,
    request: ItemRequest,
    journalPath: string,
    stop: () => boolean,
    cancel: boolean,
    fillWaitTicks: number,
    rescueControl: RescueControl = { active: false, start: 0, lifeId: 0, respawnCount: 0 },
) {
    validateRequest(request);
    const quantity = orderQuantity(request);
    const isItem = orderItemMatcher(request.item, catalogue());
    if (s.name.toLowerCase() !== request.actor.toLowerCase()) throw Error('order actor identity mismatch');
    marketEntryTrace(s, 'entry-state-wait');
    if (!await waitUntil(s, () => stop() || (!!s.sdk.getState()?.player && s.sdk.getStateAge() <= 5000 && !!s.sdk.getSkill('Hitpoints')), { timeoutTicks: 15 }) || stop()) {
        throw Error('observed market entry state deadline/stop');
    }
    marketEntryTrace(s, 'entry-state-ready');
    let entryJournal: ItemOrder | undefined;
    if (existsSync(journalPath)) {
        entryJournal = JSON.parse(readFileSync(journalPath, 'utf8'));
        if (entryJournal?.version !== 1 || !['entry', 'placing', 'open', 'cancelling', 'collecting', 'settled'].includes(entryJournal.phase)
            || !Array.isArray(entryJournal.previousIds) || JSON.stringify(entryJournal.request) !== JSON.stringify(request)) {
            throw Error('journal request identity/config/state changed');
        }
        if ((entryJournal.rescue && entryJournal.rescue.phase !== 'bank-reconciled')
            || (entryJournal.phase === 'entry' && entryJournal.rescue?.phase !== 'bank-reconciled')) {
            throw Error('uncertain rescue intent; inspect before any action');
        }
    }
    if (request.rescueMode && !entryJournal) {
        if (cancel) throw Error('cannot cancel unsubmitted rescue order');
        entryJournal = await rescueMarketEntry(s, request, journalPath, stop, rescueControl);
    }
    await leaveBattlefield(s, () => stop() || Date.now() >= request.deadline);
    await prepareMarketEntry(s, () => stop() || Date.now() >= request.deadline);
    const state = () => s.sdk.getState();
    const held = (id: number) => {
        const inv = s.sdk.getInventory();
        let total = 0;
        for (let i = 0; i < inv.length; i++) {
            const row = inv[i]!;
            if (row.id === id) total += row.count;
        }
        return total;
    };
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = s.tick();
    const hp0 = hp();
    const p0 = state()?.player;
    const bankObservation = () => {
        const observed = s.bankObservation?.();
        if (observed || process.env.REPLAY_ONLY !== '1') return observed;
        const q = state();
        return q?.bank.isOpen && Array.isArray(q.bank.items)
            ? { generation: q.revision ?? s.tick(), at: Date.now(), items: q.bank.items.map(i => ({ id: i.id, name: i.name, count: i.count })) }
            : null;
    };
    const entryFailure = marketEntryFailure(p0, hp0);
    if (entryFailure) throw Error(entryFailure);
    if (!p0) throw Error('market position unknown');
    let hpGuard = hp0;
    const foodUsed: { id: number; count: number }[] = [];
    const preparationFood = new Set<number>();
    let ended = false;
    let died = false;
    let damaged = false;
    let hpMin = hp0;
    let failure = '';
    let bankItems: readonly { id: number; name: string; count: number }[] = [];
    let baseline: Map<number, number> | undefined;
    let journal: ItemOrder | undefined = entryJournal;
    const save = () => {
        if (!journal) throw Error('missing order journal');
        journal.at = Date.now();
        writeFileSync(journalPath + '.tmp', JSON.stringify(journal, null, 2));
        renameSync(journalPath + '.tmp', journalPath);
    };
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, hp());
        damaged ||= hp() < hpGuard || (!!p && !marketTileSafe({ x: p.worldX, z: p.worldZ, level: p.level }));
        died ||= !!p?.isDead || (p?.lifeId ?? p0.lifeId) !== p0.lifeId || (p?.respawnCount ?? 0) > (p0.respawnCount ?? 0);
    });
    const terminal = () => ended || died;
    const over = () => terminal() || damaged || stop() || s.tick() - start >= 500;
    const count = (a: readonly { id: number; name: string; count: number }[], match: (i: { id: number; name: string }) => boolean) => {
        let total = 0;
        for (let idx = 0; idx < a.length; idx++) {
            const row = a[idx]!;
            if (match(row)) total += row.count;
        }
        return total;
    };
    const isCoins = (i: { id: number }) => i.id === 995;
    const coinsTotal = () => held(995) + count(bankItems, isCoins) + count(s.sdk.getEquipment(), isCoins);
    const itemTotal = () => count(s.sdk.getInventory(), isItem) + count(bankItems, isItem) + count(s.sdk.getEquipment(), isItem);
    const assets = () => {
        const m = new Map<number, number>();
        const addAll = (rows: readonly { id: number; name: string; count: number }[]) => {
            for (let idx = 0; idx < rows.length; idx++) {
                const i = rows[idx]!;
                const id = isItem(i) ? request.item : i.id;
                m.set(id, (m.get(id) ?? 0) + i.count);
            }
        };
        addAll(s.sdk.getInventory());
        addAll(bankItems);
        addAll(s.sdk.getEquipment());
        return m;
    };
    const capture = () => {
        const bank = bankObservation();
        if (!state()?.bank.isOpen || !bank) throw Error('fresh bank observation required');
        bankItems = bank.items.map(i => ({ id: i.id, name: i.name, count: i.count }));
    };
    const walk = async (to: { x: number; z: number }, cleanup = false) => {
        const end = () => terminal() || (!cleanup && over()) || s.tick() - start >= 680;
        if (end()) throw Error('market route stopped');
        const p = state()?.player;
        if (p && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 1) return;
        const deps = await sessionWalker(s);
        const plan = deps.plan;
        deps.plan = (level, from, goal) => {
            const corners = plan(level, from, goal);
            if (!corners.length || [from, ...expandPath(from, corners)].some(pt => !marketTileSafe({ ...pt, level }))) {
                throw Error('market full path outside known bank rectangle');
            }
            return corners;
        };
        if (!(await walkPath(deps, [{ ...to, tol: 1 }], { maxTicks: 120, stop: end })).ok) throw Error('market bank/GE route failed');
    };
    const openBank = async () => {
        await s.bot.dismissBlockingUI();
        const gen = bankObservation()?.generation ?? 0;
        if (!state()?.bank.isOpen
            && (!(await s.bot.openBank()).success
                || !await waitUntil(s, () => (!!state()?.bank.isOpen && (bankObservation()?.generation ?? 0) > gen) || terminal(), { timeoutTicks: 15 })
                || terminal())) {
            throw Error('market bank open unproved');
        }
        capture();
    };
    const bankPack = async () => {
        for (const id of new Set([995, ...preparationFood, ...s.sdk.getInventory().filter(isItem).map(i => i.id)])) {
            const item = s.sdk.getInventory().find(i => i.id === id);
            if (item) {
                const amount = held(id);
                if (await depositObserved(s, item) !== amount) throw Error('market bank credit mismatch');
                capture();
            }
        }
    };
    const view = (): OrderView => {
        const ge = s.sdk.getGEState();
        if (!ge || s.sdk.getStateAge() > 5000) throw Error('fresh private GE state required');
        const offer = journal?.offerId === undefined ? undefined : ge.offers.find(o => o.id === journal!.offerId);
        if (journal && offer) {
            const update = observeOrderProgress(journal, offer, Date.now());
            if (!journal.progress || update.delta.filled || update.delta.gross || update.delta.tax) {
                journal.progress = update.current;
                save();
            }
        }
        return { actor: s.name, server: request.server, offers: ge.offers, coins: coinsTotal(), items: itemTotal() };
    };

    try {
        await walk(GE_VARROCK_BANK);
        await openBank();
        baseline = assets();
        if (journal?.phase === 'entry' && (JSON.stringify(bankTotals(bankItems)) !== JSON.stringify(bankTotals(journal.rescue!.bank)) || !rescueKit(s))) {
            throw Error('rescue market bank/kit changed');
        }
        await bankPack();
        if (hp() <= 6) {
            if (over()) throw Error('market health preparation stopped');
            const food = HEAL_FOOD.map(id => bankItems.find(i => i.id === id && i.id !== request.item && i.count > 0)).find(Boolean);
            if (!food) throw Error(`market health preparation: currentHP=${hp()}; acquire 1 owned meal (${HEAL_FOOD.join(',')}) at this bank`);
            preparationFood.add(food.id);
            const n = held(food.id);
            const bankBefore = count(bankItems, i => i.id === food.id);
            const gen = bankObservation()?.generation ?? 0;
            const beforeHp = hp();
            const live = state()?.bank.items.find(i => i.id === food.id);
            if (!live) throw Error('market health preparation food missing from open bank');
            const eaten = () => held(food.id) === n && hp() > beforeHp;
            await s.bot.withdrawItem(live, 1, { asNote: false });
            if (!await waitUntil(s, () => {
                const bank = bankObservation();
                return terminal() || ((held(food.id) === n + 1 || eaten()) && (bank?.generation ?? 0) > gen && count(bank?.items ?? [], i => i.id === food.id) === bankBefore - 1);
            }, { timeoutTicks: 10 }) || terminal()) {
                throw Error('market health preparation withdrawal unobserved');
            }
            capture();
            await s.bot.closeBank();
            if (over()) throw Error('market health preparation stopped');
            const target = s.sdk.getInventory().find(i => i.id === food.id);
            if (!target && !eaten()) throw Error('market health preparation food missing');
            if (target && held(food.id) === n + 1) {
                try { await s.bot.eatFood(target); } catch { /* Observe a possibly applied action. */ }
            }
            const healed = await waitUntil(s, () => terminal() || (held(food.id) === n && hp() > 6 && hp() > beforeHp), { timeoutTicks: 10 });
            if (held(food.id) === n) foodUsed.push({ id: food.id, count: 1 });
            if (!healed || terminal() || hp() <= 6 || hp() <= beforeHp) throw Error('market health preparation pack debit/HP gain unobserved');
            hpGuard = hp();
            await openBank();
        }

        for (let attempt = 0; attempt < 4; attempt++) {
            let remaining = journal ? roundBaseline(journal).quantity : quantity;
            let roundEscrow = remaining * request.limit;
            if (journal?.phase === 'settled') {
                const accounted = orderAccounting(journal);
                if (accounted.outcomeUnresolved || coinsTotal() !== journal.coinsBefore - accounted.spent || itemTotal() !== journal.itemsBefore + accounted.acquired) {
                    throw Error('settled order assets changed');
                }
                if (accounted.acquired === quantity) break;
                if (cancel || Date.now() >= request.deadline || over() || (journal.rounds?.length ?? 0) >= 16) {
                    throw Error('exact order deadline/cancel/recovery budget exhausted; accounted stock and refund retained');
                }
                remaining = quantity - accounted.acquired;
                roundEscrow = remaining * request.limit;
            }
            const needsFunding = !journal || journal.phase === 'entry' || journal.phase === 'settled' || (journal.phase === 'placing' && journal.submission === 'prepared');
            if (needsFunding) {
                if (cancel) throw Error('no submitted order to cancel');
                if (!journal) ownedBaseline(request, itemTotal());
                const failureReason = orderRefusal({
                    now: Date.now(),
                    deadline: request.deadline,
                    over: over(),
                    coins: coinsTotal(),
                    escrow: roundEscrow,
                    quantity: remaining,
                    limit: request.limit,
                    reserve: request.reserve,
                    pack: s.sdk.getInventory().length,
                });
                if (failureReason) throw Error(failureReason);
                if (journal && journal.phase === 'placing' && (coinsTotal() !== roundBaseline(journal).coins || itemTotal() !== roundBaseline(journal).items)) {
                    throw Error('prepared order asset baseline changed');
                }
                const coins = s.sdk.findBankItem(/^coins$/i);
                const beforeBank = count(bankItems, i => i.id === 995);
                const gen = bankObservation()?.generation ?? 0;
                if (!coins || !(await s.bot.withdrawItem(coins, roundEscrow, { asNote: false })).success
                    || !await waitUntil(s, () => {
                        const bank = bankObservation();
                        return held(995) === roundEscrow && (bank?.generation ?? 0) > gen && count(bank?.items ?? [], i => i.id === 995) === beforeBank - roundEscrow;
                    }, { timeoutTicks: 10 })) {
                    throw Error('owned order funding unobserved');
                }
                capture();
                if (count(bankItems, i => i.id === 995) !== beforeBank - roundEscrow) throw Error('owned order bank debit mismatch');
            }
            await s.bot.closeBank();
            if (over()) throw Error('market budget/stop before GE');
            await walk(GE_EXCHANGE_SPOT);
            if (!(await s.bot.openGE(15000)).success) throw Error('GE interface unavailable');
            if (over()) throw Error('market operation budget/stop');
            if (journal?.phase === 'settled') {
                const prior = priorRounds(journal);
                const accounted = orderAccounting(journal);
                const v = view();
                if (journal.offerId === undefined || v.offers.some(o => o.id === journal!.offerId) || accounted.outcomeUnresolved) {
                    throw Error('previous settled offer still visible or unproved');
                }
                const round: SettledRound = {
                    offerId: journal.offerId,
                    quantity: prior.quantity,
                    acquired: accounted.acquired - prior.acquired,
                    refund: prior.escrow - (accounted.spent - prior.spent),
                    progress: journal.progress,
                };
                journal = {
                    rescue: journal.rescue,
                    version: 1,
                    request,
                    phase: 'placing',
                    submission: 'prepared',
                    coinsBefore: journal.coinsBefore,
                    itemsBefore: journal.itemsBefore,
                    previousIds: v.offers.map(o => o.id),
                    at: Date.now(),
                    rounds: [...(journal.rounds ?? []), round],
                };
                save();
            }
            if (!journal || journal.phase === 'entry') {
                const v = view();
                ownedBaseline(request, v.items);
                journal = {
                    rescue: journal?.rescue,
                    version: 1,
                    request,
                    phase: 'placing',
                    submission: 'prepared',
                    coinsBefore: v.coins,
                    itemsBefore: v.items,
                    previousIds: v.offers.map(o => o.id),
                    at: Date.now(),
                };
                save();
            }
            const acquiredBeforeRound = priorRounds(journal).acquired;
            if (journal.phase === 'placing' && placementRetrySafe(journal, view())) {
                if (Date.now() >= request.deadline || over()) throw Error('order deadline/stop before submission');
                journal.submission = 'attempted';
                save();
                await s.bot.placeGEOffer({ item: request.item, side: 'buy', quantity: priorRounds(journal).quantity, price: request.limit }, 20000);
            }
            if (journal.phase === 'placing') {
                await waitUntil(s, () => {
                    try {
                        return !!reconcilePlacement(journal!, view());
                    } catch (e) {
                        if (String(e).includes('escrow')) return false;
                        throw e;
                    }
                }, { timeoutTicks: 10 });
                const found = reconcilePlacement(journal, view());
                if (!found) throw Error('placement outcome unresolved;inspect before another order');
                journal.offerId = found.id;
                journal.phase = 'open';
                save();
            }
            if (journal.phase === 'collecting') {
                const v = view();
                if (!collectionApplied(journal, v)) {
                    if (!collectionRetrySafe(journal, v) || over()) throw Error('collection outcome unresolved;inspect journal before retry');
                    const collected = await collectClaim((id, notes) => s.bot.collectGEOffer(id, notes, 15000), journal.offerId!, remaining > 1);
                    if (!await waitUntil(s, () => collectionApplied(journal!, view()), { timeoutTicks: 10 })) {
                        throw Error('resumed exact collection unproved: ' + collected.message);
                    }
                }
                Object.assign(journal, claimSettlement(journal, journal.claim!));
                journal.phase = 'settled';
                delete journal.failure;
                save();
            } else if (journal.phase === 'open' || journal.phase === 'cancelling') {
                const find = (v: OrderView) => v.offers.find(o => o.id === journal!.offerId);
                let v = view();
                let offer = find(v);
                if (offer?.state === 'open' && journal.phase === 'open' && !cancel && Date.now() < request.deadline && fillWaitTicks > 0 && !over()) {
                    await waitUntil(s, () => over() || Date.now() >= request.deadline || s.sdk.getGEState()?.offers.find(o => o.id === journal!.offerId)?.state !== 'open', {
                        timeoutTicks: fillWaitTicks,
                    });
                    v = view();
                    offer = find(v);
                }
                if (!offer || !((o: typeof offer) => o.item === journal!.request.item && o.side === 'buy' && o.quantity === priorRounds(journal!).quantity && o.price === journal!.request.limit)(offer)
                    || v.coins !== roundBaseline(journal).coins - roundEscrow || v.items !== roundBaseline(journal).items) {
                    throw Error('private order/escrow identity changed');
                }
                if (offer.state === 'open') {
                    if (terminal() || s.tick() - start >= 580) throw Error('market settlement budget exhausted');
                    journal.phase = 'cancelling';
                    save();
                    await s.bot.cancelGEOffer(offer.id, 15000);
                    if (!await waitUntil(s, () => terminal() || s.sdk.getGEState()?.offers.find(o => o.id === journal!.offerId)?.state !== 'open', { timeoutTicks: 10 }) || terminal()) {
                        throw Error('cancellation not observed');
                    }
                    v = view();
                    offer = find(v);
                    if (!offer || offer.state === 'open') throw Error('cancellation not observed');
                    journal.phase = 'open';
                    save();
                }
                terminalOrderClaim(journal, offer);
                if (v.coins !== roundBaseline(journal).coins - roundEscrow || v.items !== roundBaseline(journal).items) {
                    throw Error('pre-collection asset baseline changed');
                }
                if (s.sdk.getInventory().length > 26 || offer.items < 0 || offer.items > remaining || offer.coins < 0 || offer.coins > roundEscrow) {
                    throw Error('collection space or claim unproved');
                }
                if (terminal() || s.tick() - start >= 600) throw Error('market settlement budget exhausted');
                journal.claim = { coinsBefore: v.coins, itemsBefore: v.items, coins: offer.coins, items: offer.items };
                journal.phase = 'collecting';
                save();
                const collected = await collectClaim((id, notes) => s.bot.collectGEOffer(id, notes, 15000), offer.id, remaining > 1);
                if (!await waitUntil(s, () => collectionApplied(journal!, view()), { timeoutTicks: 10 })) {
                    throw Error('exact order collection unproved;inspect journal before retry: ' + collected.message);
                }
                Object.assign(journal, claimSettlement(journal, journal.claim));
                journal.phase = 'settled';
                delete journal.failure;
                save();
            }
            if (journal.phase !== 'settled' || orderAccounting(journal).acquired === quantity) break;
            if (orderAccounting(journal).acquired === acquiredBeforeRound) break;
            await s.bot.dismissBlockingUI();
            await walk(GE_VARROCK_BANK, true);
            await openBank();
            await bankPack();
        }
    } catch (error) {
        failure = String(error);
        if (journal) {
            journal.failure = failure;
            save();
        }
    } finally {
        if (!terminal()) {
            try {
                await s.bot.dismissBlockingUI();
                await walk(GE_VARROCK_BANK, true);
                await openBank();
                await bankPack();
                await s.bot.closeBank();
            } catch (error) {
                failure = [failure, String(error)].filter(Boolean).join('; ');
            }
        }
        off();
    }
    const final = assets();
    const { acquired, refund, spent, escrow, maximumExposure, outcomeUnresolved } = orderAccounting(journal);
    const unrelated = !!baseline && [...new Set([...baseline.keys(), ...final.keys()])].every(
        id => [995, request.item].includes(id)
            || (baseline!.get(id) ?? 0) - foodUsed.filter(f => f.id === id).reduce((n, f) => n + f.count, 0) === (final.get(id) ?? 0),
    );
    const conserved = !outcomeUnresolved && escrow !== null && !!journal
        && (final.get(995) ?? 0) === (journal.coinsBefore - escrow - spent)
        && (final.get(request.item) ?? 0) === journal.itemsBefore + acquired;
    const targetMet = journal?.phase === 'settled' && acquired === quantity;
    const banked = !!journal && count(bankItems, i => i.id === request.item) === journal.itemsBefore + acquired
        && count(s.sdk.getInventory(), i => isItem(i) || i.id === 995) === 0 && count(s.sdk.getEquipment(), isItem) === 0;
    const reserveKept = (final.get(995) ?? 0) >= request.reserve;
    if (!failure && journal?.phase === 'settled' && !targetMet) {
        failure = `exact order short: acquired ${acquired}/${quantity}; accounted stock and refund retained; ${Date.now() >= request.deadline ? 'deadline exhausted' : 'finite recovery/no-progress budget exhausted'}`;
    }
    if (!failure && (!banked || !reserveKept || !conserved || !unrelated)) failure = 'final bank/reserve/asset reconciliation failed';
    const ok = !failure && !terminal() && !damaged && !stop() && unrelated && conserved && targetMet && banked && reserveKept;
    if (journal) {
        if (failure) journal.failure = failure;
        else if (ok) delete journal.failure;
        save();
    }
    return {
        ok,
        foodUsed,
        phase: journal?.phase ?? 'unplaced',
        pending: journal?.phase === 'open',
        quantity,
        targetMet,
        banked,
        reserveKept,
        acquired,
        newItemsThisSession: (final.get(request.item) ?? 0) - (baseline?.get(request.item) ?? 0),
        cashDeltaThisSession: (final.get(995) ?? 0) - (baseline?.get(995) ?? 0),
        refund,
        spent,
        escrow,
        maximumExposure,
        outcomeUnresolved,
        offerId: journal?.offerId,
        progress: journal?.progress ?? null,
        costBasis: journal?.phase === 'settled' && !outcomeUnresolved
            ? { units: acquired, coins: spent, scope: 'Acquisition cost only; no sale, delivery or realized profit claimed' }
            : null,
        reviewAt: request.reviewAt,
        deadline: request.deadline,
        unrelated,
        conserved,
        hpMin,
        died,
        damaged,
        stopped: stop(),
        finalCoins: final.get(995) ?? 0,
        finalItems: final.get(request.item) ?? 0,
        ticks: s.tick() - start,
        failure: failure || '-',
    };
}
