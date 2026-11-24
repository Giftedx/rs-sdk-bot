// Carrier player-to-player trades, tick-driven dual transfers, pipeline boundary timing, and owned swaps.
import type { Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';

type Publications = { tick: () => number; onTick: (cb: () => void) => () => void };
export type CraftBoundary = { tick: () => number | undefined; dispose: () => void };

export function runeHandoffPipeline(value = process.env.RUNE_HANDOFF_PIPELINE ?? '0', craftAfter = 'inventory'): boolean {
    if (value !== '0' && value !== '1') throw Error('RUNE_HANDOFF_PIPELINE must be0 or1');
    if (value === '1' && craftAfter !== 'trade-message') throw Error('the handoff pipeline requires trade-message crafting');
    return value === '1';
}

export function observeCraftCompletion(s: Publications, complete: () => boolean, stop: () => boolean): CraftBoundary {
    let anchor: number | undefined, scheduled = false, disposed = false, off = () => {};
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        off();
    };
    off = s.onTick(() => {
        if (disposed || scheduled) return;
        if (stop()) { dispose(); return; }
        if (!complete()) return;
        scheduled = true;
        queueMicrotask(() => {
            if (disposed) return;
            if (!stop() && complete()) anchor = s.tick();
            dispose();
        });
    });
    if (disposed) off();
    return { tick: () => anchor, dispose };
}

export function pipelineOpeningReady(s: Pick<Publications, 'tick'>, boundary: CraftBoundary): boolean {
    const at = boundary.tick();
    return at !== undefined && s.tick() - at >= 4;
}

const eager = true;
const inv = (s: Session) => s.sdk.getInventory();
export const ess = (s: Session) => {
    const items = inv(s);
    let n = 0;
    for (let i = 0; i < items.length; i++) if (items[i]!.id === 1436) n += items[i]!.count;
    return n;
};
export const state = (s: Session) => s.sdk.getState()!;
const trade = (s: Session) => state(s).trade;
const sumOfferCount = (items: readonly { count: number }[] | undefined): number | undefined => {
    if (!items) return undefined;
    let total = 0;
    for (let i = 0; i < items.length; i++) total += items[i]!.count;
    return total;
};

const RUNE_ADVANCE_RE = /^(@dbl@)?Congratulations, you just advanced a runecraft level\.$/i;
const RUNE_CRAFT_UNLOCK_RE = /^(?:Members can now|You can now) craft @dbl@(?:Air|Mind|Water|Earth|Fire|Body|Cosmic|Chaos|Nature|Law|Death) Runes@bla@\.$/;

const tradeSnapshotRow = (a: Session) => {
    const t = trade(a);
    return {
        name: a.name,
        open: t?.isOpen,
        screen: t?.screen,
        partner: t?.partner,
        my: sumOfferCount(t?.myOffer),
        their: sumOfferCount(t?.theirOffer),
        accepted: t?.myAccepted,
    };
};

const tradeSnapshotKey = (a: Session): string => {
    const t = trade(a);
    return `${a.name}|${t?.isOpen ? 1 : t?.isOpen === false ? 0 : ''}|${t?.screen ?? ''}|${t?.partner ?? ''}|${sumOfferCount(t?.myOffer) ?? ''}|${sumOfferCount(t?.theirOffer) ?? ''}|${t?.myAccepted ? 1 : t?.myAccepted === false ? 0 : ''}`;
};
const index = (s: Session, n: string) => state(s).nearbyPlayers.find(p => p.name.toLowerCase() === n.toLowerCase())?.index;
const messages = (s: Session) => state(s).gameMessages ?? [];
const cursor = (s: Session) => {
    const msgs = messages(s);
    let max = 0;
    for (let i = 0; i < msgs.length; i++) {
        const id = msgs[i]!.observationId ?? 0;
        if (id > max) max = id;
    }
    return max;
};

export function exactCarrierOffer(
    t: ReturnType<Session['sdk']['getTradeState']>,
    giver: boolean,
    partner: string,
    amount: number,
): boolean {
    if (!t.isOpen || t.partner?.toLowerCase() !== partner.toLowerCase()) return false;
    const offered = giver ? t.myOffer : t.theirOffer;
    const returned = giver ? t.theirOffer : t.myOffer;
    if (returned && returned.length !== 0) return false;
    if (!offered) return amount === 0;
    let total = 0;
    for (let i = 0; i < offered.length; i++) {
        const item = offered[i]!;
        if (item.id !== 1436 || !Number.isSafeInteger(item.count) || item.count <= 0) return false;
        total += item.count;
    }
    return total === amount;
}

export function runeOpening(): 'incoming' | 'helper-ack' {
    const opening = process.env.RUNE_OPEN_AFTER ?? 'incoming';
    if (opening !== 'incoming' && opening !== 'helper-ack') throw Error('RUNE_OPEN_AFTER must be incoming or helper-ack');
    return opening;
}

export function runeConfirmation(value = process.env.RUNE_CONFIRM_AFTER ?? 'causal'): 'observed' | 'causal' {
    if (value !== 'observed' && value !== 'causal') throw Error('RUNE_CONFIRM_AFTER must be observed or causal');
    return value;
}

export function createRuneTradeRefresh(mode = process.env.RUNE_TRADE_REFRESH ?? 'packets') {
    if (mode !== 'packets' && mode !== 'poll') throw Error('RUNE_TRADE_REFRESH must be packets or poll');
    const seen = new WeakMap<Session, { packets: number; mutation: number }>();
    const dirty = new WeakMap<Session, number>();
    let scanned = 0, skipped = 0;
    return {
        dirty: (actor: Session) => { dirty.set(actor, (dirty.get(actor) ?? 0) + 1); },
        refresh: async (actor: Session) => {
            const packets = (actor.client as { packetsReceived?: number } | undefined)?.packetsReceived;
            const mutation = dirty.get(actor) ?? 0, last = seen.get(actor);
            if (mode === 'packets' && Number.isSafeInteger(packets) && last && last.packets === packets && last.mutation === mutation) {
                skipped++;
                return;
            }
            await actor.sdk.scanGroundItems(0);
            scanned++;
            if (Number.isSafeInteger(packets)) seen.set(actor, { packets: packets!, mutation });
        },
        stats: () => ({ mode, scanned, skipped }),
    };
}

export async function transfer(
    s: Session,
    h: Session,
    stop: () => boolean = () => false,
    amount = 27,
    craft?: { send: () => Promise<void>; complete: () => boolean },
    pipeline?: { boundary?: CraftBoundary },
): Promise<number> {
    const opening = runeOpening(), confirmation = runeConfirmation();
    const refresh = createRuneTradeRefresh();
    const mutate = <T>(actor: Session, work: () => Promise<T>) => { refresh.dirty(actor); return work(); };
    const direct = (actor: Session, action: Parameters<Session['direct']>[0]) => mutate(actor, () => actor.direct(action));
    const accept = (actor: Session) => mutate(actor, () => actor.sdk.sendAcceptTrade());
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 27) throw Error('carrier transfer amount must be1..27');
    if (pipeline && (!craft || !pipeline.boundary)) throw Error('pipeline handoff needs the previous exact craft boundary and combined crafting');
    const at = s.tick();
    if (!await waitUntil(s, () => ess(h) === amount && ess(s) === 0, { timeoutTicks: 10 })) throw Error('handoff stock unobserved');
    let opened = false, offerSent = false, last = '', requestPending = false, responseSent = false, levelupDismissed = false;
    let incomingCursor = 0, busyCursor = 0;
    const confirmed = new Set<Session>(), offerAccepted = new Set<Session>();
    let craftAt: number | undefined, readyAt: number | undefined;
    const reciprocal = process.env.RUNE_RECIPROCAL !== '0';
    let receiverEarly = false, receiverRetry = false;
    const earlyConfirmed = new Set<Session>();
    const acceptedCursors = new Map([[s, cursor(s)], [h, cursor(h)]]);
    const credited = () => ess(s) === amount && ess(h) === 0;
    const complete = () => (craft ? craftAt !== undefined && ess(s) === 0 && ess(h) === 0 && craft.complete() : credited());
    const accepted = () => [s, h].every(a => messages(a).some(m => m.type === 0 && m.sender === '' && m.text === 'Accepted trade.' && (m.observationId ?? 0) > acceptedCursors.get(a)!));
    const tickWaits = new Map<Session, Promise<void>>();
    const nextTick = (actor: Session) => {
        let pending = tickWaits.get(actor);
        if (!pending) {
            pending = waitTicks(actor, 1).then(() => { tickWaits.delete(actor); });
            tickWaits.set(actor, pending);
        }
        return pending;
    };
    const observationCursors = new Map([[s, cursor(s)], [h, cursor(h)]]);
    let phase = 'loop', phaseAt = s.tick(), phaseTime = performance.now();
    const mark = (next: string) => { phase = next; phaseAt = s.tick(); phaseTime = performance.now(); };
    const observe = (event: string) => console.log('RC_TRADE_WAIT ' + JSON.stringify({
        event,
        crafter: s.name,
        helper: h.name,
        tick: s.tick(),
        helperTick: h.tick(),
        elapsed: s.tick() - at,
        phase,
        phaseAt,
        phaseMs: Math.round(performance.now() - phaseTime),
        requestPending,
        responseSent,
        opened,
        incomingCursor,
        busyCursor,
        actors: [s, h].map(a => ({
            name: a.name,
            revision: state(a).revision,
            modal: state(a).dialog?.isOpen,
            open: trade(a)?.isOpen,
            screen: trade(a)?.screen,
            essence: ess(a),
            messages: messages(a)
                .filter(m => (m.observationId ?? 0) > Math.max(observationCursors.get(a)!, a === s ? incomingCursor : busyCursor))
                .filter(m => m.type === 4 || (m.type === 0 && /busy at the moment\.|Sending trade offer/.test(m.text)))
                .map(m => ({ type: m.type, sender: m.sender, text: m.text, observationId: m.observationId, tick: m.tick })),
        })),
    }));
    const observers = [s, h].map(a => (typeof a.onTick === 'function' ? a.onTick(() => {
        if (s.tick() - phaseAt >= 3) observe('publication:' + a.name);
    }) : () => {}));
    try {
        observe('begin');
        while (s.tick() - at < 35 && (craft ? !complete() : ess(s) !== amount) && !stop()) {
            mark('event-loop-yield');
            await new Promise<void>(resolve => setImmediate(resolve));
            mark('ground-scans');
            await Promise.all([refresh.refresh(s), refresh.refresh(h)]);
            mark('control');
            if (stop()) break;
            if (!craft && credited()) break;
            if (craft && craftAt === undefined && [s, h].every(a => confirmed.has(a) || earlyConfirmed.has(a)) && (accepted() || credited())) {
                if (stop()) break;
                craftAt = s.tick();
                await mutate(s, () => craft.send());
            }
            if (complete()) break;
            const snapshot = `${tradeSnapshotKey(s)}||${tradeSnapshotKey(h)}`;
            if (snapshot !== last) {
                console.log('RC_TRADE_STATE ' + JSON.stringify({ at: Date.now(), tick: s.tick(), actors: [tradeSnapshotRow(s), tradeSnapshotRow(h)] }));
                last = snapshot;
            }
            if (trade(s)?.isOpen || trade(h)?.isOpen) opened = true;
            if (!trade(s)?.isOpen && !trade(h)?.isOpen && !opened && !responseSent) {
                if (pipeline) {
                    if (pipelineOpeningReady(s, pipeline.boundary!)) {
                        const main = state(s).player, helper = state(h).player, si = index(h, s.name), hi = index(s, h.name), dialog = state(s).dialog;
                        const runeDialog = dialog?.allComponents?.some(c =>
                            RUNE_ADVANCE_RE.test(c.text) || RUNE_CRAFT_UNLOCK_RE.test(c.text));
                        if ((dialog?.isOpen && !runeDialog) || state(h).dialog?.isOpen) throw Error('pipeline handoff preserves unrelated dialogs');
                        if (main && helper && si !== undefined && hi !== undefined && main.level === helper.level && Math.max(Math.abs(main.worldX - helper.worldX), Math.abs(main.worldZ - helper.worldZ)) <= 1) {
                            if (ess(s) !== 0 || ess(h) !== amount) throw Error('pipeline opening stock changed');
                            const send = (a: Session, playerIndex: number) => {
                                if (stop()) throw Error('pipeline opening stopped');
                                return direct(a, { type: 'interactPlayer', playerIndex, optionIndex: 4, reason: 'SDK' });
                            };
                            mark('reciprocal-request');
                            const sent = await Promise.all([send(h, si), send(s, hi)]);
                            mark('control');
                            if (sent.some(r => !(r as { success?: boolean })?.success)) throw Error('pipeline reciprocal request refused');
                            requestPending = true;
                            responseSent = true;
                        }
                    }
                } else {
                    const dialog = state(s).dialog;
                    if (!levelupDismissed && dialog?.isOpen && dialog.allComponents?.some(c => RUNE_ADVANCE_RE.test(c.text))) {
                        mark('close-modal');
                        await direct(s, { type: 'closeModal', reason: 'SDK' });
                        mark('control');
                        levelupDismissed = true;
                    }
                    const incoming = () => messages(s).some(m => m.type === 4 && m.sender?.toLowerCase() === h.name.toLowerCase() && m.text === 'wishes to trade with you.' && (m.observationId ?? 0) > incomingCursor);
                    const ready = () => incoming() || (opening === 'helper-ack' && messages(h).some(m => m.type === 0 && m.sender === '' && m.text === 'Sending trade offer...' && (m.observationId ?? 0) > busyCursor));
                    if (requestPending && !ready() && messages(h).some(m => m.type === 0 && m.sender === '' && m.text.toLowerCase() === s.name.toLowerCase() + ' is busy at the moment.' && (m.observationId ?? 0) > busyCursor)) {
                        requestPending = false;
                        readyAt = undefined;
                    }
                    if (!requestPending && !stop()) {
                        const si = index(h, s.name), hi = index(s, h.name);
                        if (si !== undefined && hi !== undefined) {
                            incomingCursor = cursor(s);
                            busyCursor = cursor(h);
                            mark('helper-request');
                            const ask = direct(h, { type: 'interactPlayer', playerIndex: si, optionIndex: 4, reason: 'SDK' });
                            if (reciprocal) await Promise.all([ask, direct(s, { type: 'interactPlayer', playerIndex: hi, optionIndex: 4, reason: 'SDK' })]);
                            else await ask;
                            mark('control');
                            requestPending = true;
                        }
                    }
                    if (requestPending && ready() && !stop()) {
                        readyAt ??= s.tick();
                        const hi = index(s, h.name), main = state(s).player, helper = state(h).player;
                        const adjacent = !!main && !!helper && main.level === helper.level && Math.max(Math.abs(main.worldX - helper.worldX), Math.abs(main.worldZ - helper.worldZ)) <= 1;
                        if (hi !== undefined && (!reciprocal || adjacent || s.tick() - readyAt > 2)) {
                            mark('crafter-response');
                            await direct(s, { type: 'interactPlayer', playerIndex: hi, optionIndex: 4, reason: 'SDK' });
                            mark('control');
                            responseSent = true;
                        }
                    }
                }
            }
            for (const actor of [h, s]) {
                mark('offer-or-accept:' + actor.name);
                const t = trade(actor);
                if (!t?.isOpen) continue;
                if (t.partner && t.partner.toLowerCase() !== (actor === s ? h.name : s.name).toLowerCase()) throw Error('unexpected carrier trade partner');
                if (t.myAccepted || confirmed.has(actor)) continue;
                const giver = actor === h ? t.myOffer : t.theirOffer, receiver = actor === h ? t.theirOffer : t.myOffer;
                if (receiver?.length || (giver ?? []).some(i => i.id !== 1436) || (giver ?? []).reduce((n, i) => n + i.count, 0) > amount) throw Error('unexpected carrier trade stock');
                if (t.screen === 'confirm' && (giver ?? []).reduce((n, i) => n + i.count, 0) !== amount) throw Error('incomplete carrier confirmation');
                if (t.screen === 'offer') {
                    if (offerAccepted.has(actor)) {
                        if (pipeline && actor === s && receiverEarly && !receiverRetry && trade(h)?.screen === 'offer' && trade(h)?.myAccepted
                            && exactCarrierOffer(t, false, h.name, amount) && exactCarrierOffer(trade(h)!, true, s.name, amount)) {
                            if (stop()) break;
                            const acceptedOffer = await accept(s);
                            if (!acceptedOffer.success) throw Error('carrier offer retry refused ' + acceptedOffer.message);
                            receiverRetry = true;
                        }
                        continue;
                    }
                    if (actor === h && (t.myOffer?.length ?? 0) === 0 && !offerSent) {
                        const e = inv(h).find(i => i.id === 1436);
                        if (!e) continue;
                        const result = await mutate(h, () => h.sdk.sendOfferItem(e.slot, -1));
                        if (!result.success) throw Error('helper offer refused ' + result.message);
                        offerSent = true;
                        if (eager) {
                            const acceptedOffer = await accept(h);
                            if (!acceptedOffer.success) throw Error('carrier offer acceptance refused ' + acceptedOffer.message);
                            offerAccepted.add(h);
                        }
                        continue;
                    }
                    const offer = actor === s ? t.theirOffer : t.myOffer;
                    if ((offer ?? []).some(i => i.id !== 1436)) throw Error('unexpected item in owned handoff');
                    const total = (offer ?? []).reduce((n, i) => n + i.count, 0);
                    const helperTrade = trade(h);
                    const acknowledgedOwnedOffer = helperTrade?.isOpen && helperTrade.screen === 'offer' && helperTrade.myAccepted && offerAccepted.has(h);
                    const pendingOwnedOffer = actor === s && eager && offerSent && total === 0
                        && (helperTrade?.myOffer?.reduce((n, i) => n + i.count, 0) === amount || acknowledgedOwnedOffer || (!!pipeline && offerAccepted.has(h)));
                    if (!pendingOwnedOffer && total === 0) continue;
                    if (!pendingOwnedOffer && total !== amount) throw Error('unexpected essence offer ' + total);
                    if (!t.myAccepted) {
                        const acceptedOffer = await accept(actor);
                        if (!acceptedOffer.success) throw Error('carrier offer acceptance refused ' + acceptedOffer.message);
                        offerAccepted.add(actor);
                        if (pipeline && actor === s && total === 0) receiverEarly = true;
                    }
                } else if (t.screen === 'confirm' && !t.myAccepted) {
                    const acceptedConfirm = await accept(actor);
                    if (!acceptedConfirm.success) throw Error('carrier confirmation refused ' + acceptedConfirm.message);
                    confirmed.add(actor);
                }
            }
            const receiverTrade = trade(s), helperTrade = trade(h);
            if (confirmation === 'causal' && amount === 27 && offerSent && offerAccepted.has(s) && offerAccepted.has(h)
                && helperTrade?.isOpen && helperTrade.screen === 'offer' && helperTrade.myAccepted && exactCarrierOffer(helperTrade, true, s.name, amount)
                && receiverTrade?.isOpen && receiverTrade.screen === 'offer' && receiverTrade.partner?.toLowerCase() === h.name.toLowerCase() && (receiverTrade.myOffer ?? []).length === 0) {
                for (const peer of [s, h]) {
                    if (!earlyConfirmed.has(peer) && !confirmed.has(peer)) {
                        if (stop()) break;
                        earlyConfirmed.add(peer);
                        const result = await direct(peer, { type: 'clickComponent', componentId: 3546, reason: 'SDK' });
                        if (!(result as { success?: boolean })?.success) throw Error('causal carrier confirmation dispatch refused');
                    }
                }
            }
            if (pipeline && offerAccepted.size === 2 && trade(s)?.screen === 'offer' && trade(h)?.screen === 'offer'
                && exactCarrierOffer(trade(s)!, false, h.name, amount) && exactCarrierOffer(trade(h)!, true, s.name, amount)) {
                for (const actor of [s, h]) {
                    if (!earlyConfirmed.has(actor) && !confirmed.has(actor)) {
                        if (stop()) break;
                        const result = await direct(actor, { type: 'clickComponent', componentId: 3546, reason: 'SDK' });
                        if (!(result as { success?: boolean })?.success) throw Error('early carrier confirmation dispatch refused');
                        earlyConfirmed.add(actor);
                    }
                }
            }
            mark('next-publication');
            await Promise.race([nextTick(s), nextTick(h), Bun.sleep(20)]);
            mark('loop-condition');
        }
        observe('loop-exit');
        mark('inventory-reconciliation');
        if (!await waitUntil(s, complete, { timeoutTicks: 5 })) {
            throw Error(craft ? 'combined essence handoff and craft did not reconcile' : 'essence transfer did not reconcile');
        }
        return (craftAt ?? s.tick()) - at;
    } finally {
        observe('end');
        for (const off of observers) off();
        console.log('RC_TRADE_REFRESH ' + JSON.stringify(refresh.stats()));
    }
}

export const runeTickTrade = (value = process.env.RUNE_TICK_TRADE ?? '1'): boolean => {
    if (value !== '0' && value !== '1') throw Error('RUNE_TICK_TRADE must be 0 or 1');
    return value === '1';
};

const RUNE_LEVEL_DIALOG = /^(?:(?:@dbl@)?Congratulations, you just advanced a runecraft level\.|(?:Members can now|You can now) craft @dbl@\w+ Runes@bla@\.)$/i;

export async function tickTransfer(
    s: Session,
    h: Session,
    amount: number,
    craft: { send: () => Promise<void>; complete: () => boolean },
    stop: () => boolean = () => false,
    credited: () => void = () => {},
): Promise<number> {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 27) throw Error('carrier transfer amount must be1..27');
    const at = s.tick();
    if (!await waitUntil(s, () => stop() || (ess(h) === amount && ess(s) === 0), { timeoutTicks: 10 }) || stop()) {
        throw Error('handoff stock unobserved');
    }
    let failure: unknown, offerSent = false, craftAt: number | undefined, finished = false;
    const counts = { crafterRequests: 0, helperRequests: 0, crafterAccepts: 0, helperAccepts: 0, confirms: 0, closes: 0 };
    const fail = (e: unknown) => { failure ??= e; };
    const fire = (actor: Session, action: Parameters<Session['direct']>[0]) => {
        try { void Promise.resolve(actor.direct(action)).catch(fail); } catch (e) { fail(e); }
    };
    const partnerOk = (t: NonNullable<ReturnType<typeof trade>>, name: string) => !t.partner || t.partner.toLowerCase() === name.toLowerCase();
    const offered = (items: readonly { id: number; count: number }[] | undefined) => {
        if (!items) return 0;
        let total = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            if (item.id !== 1436) throw Error('unexpected item in owned handoff');
            total += item.count;
        }
        return total;
    };
    const crafter = () => {
        if (finished || failure) return;
        try {
            if (craftAt !== undefined) { if (craft.complete()) finished = true; return; }
            const st = state(s), t = st.trade;
            if (t?.isOpen) {
                if (!partnerOk(t, h.name)) throw Error('unexpected carrier trade partner');
                if (offered(t.myOffer) !== 0 || offered(t.theirOffer) > amount) throw Error('unexpected carrier trade stock');
                if (t.screen === 'offer') {
                    if (!t.myAccepted) { fire(s, { type: 'clickComponent', componentId: 3420, reason: 'SDK' }); counts.crafterAccepts++; }
                    fire(s, { type: 'clickComponent', componentId: 3546, reason: 'SDK' });
                    counts.confirms++;
                } else if (t.screen === 'confirm' && !t.myAccepted) {
                    if (offered(t.theirOffer) !== amount) throw Error('incomplete carrier confirmation');
                    fire(s, { type: 'clickComponent', componentId: 3546, reason: 'SDK' });
                    counts.confirms++;
                }
                return;
            }
            if (st.dialog?.isOpen) {
                if (!st.dialog.allComponents?.some(c => RUNE_LEVEL_DIALOG.test(c.text))) throw Error('carrier trade preserves unrelated dialogs');
                fire(s, { type: 'closeModal', reason: 'SDK' });
                counts.closes++;
            }
            if (ess(s) === amount && ess(h) === 0) {
                craftAt = s.tick();
                credited();
                void craft.send().catch(fail);
                return;
            }
            if (ess(s) === 0) {
                const hi = index(s, h.name);
                if (hi !== undefined) { fire(s, { type: 'interactPlayer', playerIndex: hi, optionIndex: 4, reason: 'SDK' }); counts.crafterRequests++; }
            }
        } catch (e) {
            fail(e);
        }
    };
    const helper = () => {
        if (finished || failure || craftAt !== undefined) return;
        try {
            const t = trade(h);
            if (t?.isOpen) {
                if (!partnerOk(t, s.name)) throw Error('unexpected carrier trade partner');
                const mine = offered(t.myOffer);
                if (offered(t.theirOffer) !== 0 || mine > amount) throw Error('unexpected carrier trade stock');
                if (t.screen === 'offer') {
                    if (mine === 0) {
                        if (offerSent) return;
                        const e = inv(h).find(i => i.id === 1436);
                        if (!e) throw Error('helper essence slot missing');
                        fire(h, { type: 'clickComponentWithOption', componentId: 3322, optionIndex: 4, slot: e.slot, reason: 'SDK' });
                        offerSent = true;
                        fire(h, { type: 'clickComponent', componentId: 3420, reason: 'SDK' });
                        counts.helperAccepts++;
                    } else {
                        if (!t.myAccepted) { fire(h, { type: 'clickComponent', componentId: 3420, reason: 'SDK' }); counts.helperAccepts++; }
                        fire(h, { type: 'clickComponent', componentId: 3546, reason: 'SDK' });
                        counts.confirms++;
                    }
                } else if (t.screen === 'confirm' && !t.myAccepted) {
                    fire(h, { type: 'clickComponent', componentId: 3546, reason: 'SDK' });
                    counts.confirms++;
                }
                return;
            }
            if (ess(h) === amount) {
                const si = index(h, s.name);
                if (si !== undefined) { fire(h, { type: 'interactPlayer', playerIndex: si, optionIndex: 4, reason: 'SDK' }); counts.helperRequests++; }
            }
        } catch (e) {
            fail(e);
        }
    };
    const offs = [s.onTick(crafter), h.onTick(helper)];
    try {
        helper();
        crafter();
        if (!await waitUntil(s, () => finished || !!failure || stop(), { timeoutTicks: 40 })) {
            throw Error('carrier trade and craft did not finish in 40 ticks');
        }
        if (failure) throw failure;
        if (stop()) throw Error('carrier trade stopped');
        if (ess(h) !== 0) throw Error('helper kept essence after the craft');
        console.log('RC_TICK_TRADE ' + JSON.stringify({ crafter: s.name, helper: h.name, at, craftAt, ticks: craftAt! - at, ...counts }));
        return craftAt! - at;
    } finally {
        for (const off of offs) off();
    }
}

type Items = Record<number, number>;
const countItemsMap = (items: readonly { id: number; count: number }[]): Items => {
    const result: Items = {};
    for (const i of items) result[i.id] = (result[i.id] ?? 0) + i.count;
    return result;
};
const equalItems = (a: Items, b: Items) => {
    for (const k in a) {
        if ((a[Number(k)] ?? 0) !== (b[Number(k)] ?? 0)) return false;
    }
    for (const k in b) {
        if ((a[Number(k)] ?? 0) !== (b[Number(k)] ?? 0)) return false;
    }
    return true;
};

export async function ownedSwap(a: Session, b: Session, giveA: Items, giveB: Items, stop: () => boolean = () => false) {
    const actors = [a, b], gives = [giveA, giveB], before = actors.map(s => countItemsMap(s.sdk.getInventory()));
    const expected = before.map((items, i) => {
        const next = { ...items };
        for (const [id, n] of Object.entries(gives[i]!)) {
            if (n <= 0 || items[Number(id)] !== n) throw Error('swap must give the complete observed item count');
            next[Number(id)] = (next[Number(id)] ?? 0) - n;
        }
        for (const [id, n] of Object.entries(gives[1 - i]!)) next[Number(id)] = (next[Number(id)] ?? 0) + n;
        return next;
    });
    const complete = () => actors.every((s, i) => equalItems(countItemsMap(s.sdk.getInventory()), expected[i]!));
    const closed = () => actors.every(s => !s.sdk.getTradeState().isOpen);
    if (complete()) throw Error('swap must change owned stock');
    const start = a.tick(), sent = [false, false];
    let opened = false, lastRequest = -Infinity;
    while (a.tick() - start < 50 && (!complete() || !closed()) && !stop()) {
        await new Promise<void>(resolve => setImmediate(resolve));
        await Promise.all(actors.map(s => s.sdk.scanGroundItems(0)));
        const trades = actors.map(s => s.sdk.getTradeState());
        if (trades.some(t => t.isOpen)) opened = true;
        if (!opened && a.tick() - lastRequest >= 10) {
            const targets = actors.map((s, i) => s.sdk.getState()?.nearbyPlayers.find(p => p.name.toLowerCase() === actors[1 - i]!.name.toLowerCase()));
            if (targets.every(Boolean)) {
                for (let i = 0; i < 2; i++) await actors[i]!.direct({ type: 'interactPlayer', playerIndex: targets[i]!.index, optionIndex: 4, reason: 'SDK' });
                lastRequest = a.tick();
            }
        }
        for (let i = 0; i < 2; i++) {
            const s = actors[i]!, t = s.sdk.getTradeState();
            if (!t.isOpen) continue;
            if (t.partner && t.partner.toLowerCase() !== actors[1 - i]!.name.toLowerCase()) throw Error('unexpected swap partner');
            if (t.screen === 'offer' && !sent[i]) {
                const pack = s.sdk.getInventory();
                for (const id of Object.keys(gives[i]!)) {
                    const item = pack.find(x => x.id === Number(id));
                    if (!item) throw Error('swap item slot missing');
                    const r = await s.sdk.sendOfferItem(item.slot, -1);
                    if (!r.success) throw Error('swap offer refused');
                }
                sent[i] = true;
            }
            const mine = countItemsMap(t.myOffer), theirs = countItemsMap(t.theirOffer);
            for (const [ids, allowed] of [[mine, gives[i]!], [theirs, gives[1 - i]!]] as const) {
                if (Object.entries(ids).some(([id, n]) => n > (allowed[Number(id)] ?? 0))) throw Error('unexpected swap offer');
            }
            if (equalItems(mine, gives[i]!) && equalItems(theirs, gives[1 - i]!) && !t.myAccepted) await s.sdk.sendAcceptTrade();
        }
        await Promise.race(actors.map(s => waitTicks(s, 1)));
    }
    if (stop()) throw Error('owned swap stopped');
    if (!complete()) throw Error('owned swap did not reconcile');
    if (!closed()) throw Error('owned swap trade windows stayed open');
    return { ticks: a.tick() - start, before, after: actors.map(s => countItemsMap(s.sdk.getInventory())) };
}
