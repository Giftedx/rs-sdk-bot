// Course entry helpers: Draynor sea transit, Wydin shop food, Stronghold Femi gate, travel, and Brimhaven entry.
import type { Session } from '../../../core/src/inprocess';
import type { PathDeps } from '../../../core/src/walk';
import { BRIMHAVEN_ARENA, COURSES, onCourse, resumeStep, type Pos } from './courses';
import type { Course } from './types';

let cachedTicksMod: typeof import('../../../core/src/ticks') | undefined;
let cachedWalkMod: typeof import('../../../core/src/walk') | undefined;
const loadTicksMod = (): typeof import('../../../core/src/ticks') => (cachedTicksMod ??= require('../../../core/src/ticks'));
const loadWalkMod = (): typeof import('../../../core/src/walk') => (cachedWalkMod ??= require('../../../core/src/walk'));

const TAG_RE = /<[^>]*>/g;
const SPACE_RE = /\s+/g;
const LINE_SPLIT_RE = /\n|\|/;
const CONTINUE_OPT_RE = /^click here to continue[.!]?$/i;
const TRADE_OPT_RE = /^trade$/i;
const CLERK_IZZY_RE = /izzy/i;
const PAY_OPT_RE = /^pay$/i;
const TALK_OPT_RE = /^talk-to$/i;
const BRIMHAVEN_PAY_OPT_RE = /use the agility arena|here's 200 coins/i;

export type Point = { x: number; z: number; tol?: number };

export function gnomeEntry(p: Pos): 'walk' | 'draynor' | null {
    if (p.level !== 0) return null;
    if (p.worldX <= 2760) return 'walk';
    return p.worldX >= 3000 && p.worldX <= 3110 && p.worldZ >= 3195 && p.worldZ <= 3290 ? 'draynor' : null;
}

export const DRAYNOR_ENTRY = {
    fare: 30,
    fares: 2,
    foodReserve: 12,
    foods: [/^banana$/i, /^cheese$/i],
    foodMax: 6,
    wydin: { id: 557, name: /^wydin$/i },
    shop: { x: 3015, z: 3206, tol: 1 },
    dock: { x: 3029, z: 3217, tol: 3 },
    toSarim: [
        { x: 3092, z: 3250, tol: 1 },
        { x: 3089, z: 3266, tol: 2 },
        { x: 3060, z: 3265, tol: 3 },
        { x: 3047, z: 3237, tol: 3 },
        { x: 3029, z: 3217, tol: 3 },
    ],
    toBrimhaven: [
        { x: 2920, z: 3160, tol: 5 },
        { x: 2850, z: 3175, tol: 5 },
        { x: 2800, z: 3200, tol: 5 },
        { x: 2774, z: 3228, tol: 3 },
    ],
    toCourse: [{ x: 2461, z: 3382, tol: 3 }],
    musaDeck: { x: 2956, z: 3143 },
    ardougneDeck: { x: 2683, z: 3268 },
};

export function draynorFunds(coins: number, ownedFood: number): string | null {
    const need = DRAYNOR_ENTRY.fare * DRAYNOR_ENTRY.fares + (ownedFood > 0 ? 0 : DRAYNOR_ENTRY.foodReserve);
    return coins >= need ? null : `draynor entry needs ${need} carried coins for boat fares${ownedFood > 0 ? '' : ' and food'}`;
}

export const STRONGHOLD_GATE = {
    id: 190,
    x: 2459,
    z: 3383,
    south: { x: 2461, z: 3382 },
    north: { x: 2461, z: 3385 },
    femi: /^ok then\.?$/i,
    attempts: 4,
    waitTicks: 30,
    quietTicks: 8,
    femiSettle: { box: { x: 2461, z: 3380 }, ticks: 11 },
};

const d8 = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export function gnomeApproachRoute(
    plan: (from: { x: number; z: number }, to: { x: number; z: number }) => { x: number; z: number }[],
    p: { x: number; z: number },
): 'direct' | 'gate' | null {
    const G = STRONGHOLD_GATE;
    const start = COURSES.gnome.start;
    const reaches = (from: { x: number; z: number }, to: { x: number; z: number }) => {
        if (d8(from, to) <= 1) return true;
        const end = plan(from, to).at(-1);
        return !!end && d8(end, to) <= 1;
    };
    if (reaches(p, start)) return 'direct';
    return reaches(p, G.south) && reaches(G.north, start) ? 'gate' : null;
}

export interface GateDeps {
    left: (label: string) => void;
    live: () => void;
    health: () => Promise<void>;
}

type GatePage = {
    pageId: string | null;
    isOpen: boolean;
    isWaiting: boolean;
    text: string;
    options: { index: number; text: string; componentId?: number }[];
};
type GateObservation = { tick: number; page: GatePage };
type SettleMark = { tick: number; at: string; anim: number; open: boolean; text: string };
type FemiSettle = { start: number; end?: number; marks: SettleMark[] };
type FemiChoice = {
    tick: number;
    page: GatePage;
    index: number;
    reply: { success: boolean; reason?: string; message?: string };
    advanced?: GateObservation;
    accepted?: GateObservation;
    settle?: FemiSettle;
    completed?: GateObservation;
};

function sameGatePage(a: GatePage, b: GatePage): boolean {
    if (a.isOpen !== b.isOpen || a.text !== b.text || a.options.length !== b.options.length) return false;
    for (let i = 0; i < a.options.length; i++) {
        const x = a.options[i]!, y = b.options[i]!;
        if (x.index !== y.index || x.text !== y.text || x.componentId !== y.componentId) return false;
    }
    return true;
}
const femiThanks = (p: GatePage) => p.isOpen && p.text.split('\n').some(t => t === 'Thanks again friend!');
const femiAccepted = (p: GatePage) => p.isOpen && p.text.split('\n').some(t => t === 'Thanks traveller!');

export async function crossStrongholdGate(s: Session, d: GateDeps) {
    const { waitTicks } = loadTicksMod();
    const G = STRONGHOLD_GATE;
    const label = 'open Stronghold gate';
    const pos = () => s.sdk.getState()?.player;
    const inside = () => {
        const p = pos();
        return !!p && p.level === 0 && p.worldX === G.north.x && p.worldZ === G.north.z;
    };
    let opens = 0;
    let femi = 0;
    let choiceAttempts = 0;
    const dialog: string[] = [];
    const choices: FemiChoice[] = [];
    let pending: { page: GatePage; choice?: FemiChoice } | undefined;

    const clean = (v: string) => v.replace(TAG_RE, '').replace(SPACE_RE, ' ').trim();
    const page = (): GatePage => {
        const dlg = s.sdk.getState()?.dialog;
        const lines = new Set<string>();
        const pushLines = (raw: string | undefined) => {
            if (!raw) return;
            const parts = raw.split(LINE_SPLIT_RE);
            for (let i = 0; i < parts.length; i++) {
                const c = clean(parts[i]!);
                if (c) lines.add(c);
            }
        };
        pushLines(dlg?.text);
        const comps = dlg?.allComponents;
        if (comps) {
            for (let i = 0; i < comps.length; i++) pushLines(comps[i]!.text);
        }
        return {
            pageId: dlg?.pageId ?? null,
            isOpen: !!dlg?.isOpen,
            isWaiting: !!dlg?.isWaiting,
            text: [...lines].join('\n'),
            options: (dlg?.options ?? []).map(o => ({ index: o.index, text: o.text, componentId: o.componentId })),
        };
    };

    const trace = (event: string, detail: unknown) => {
        const p = pos();
        console.log(`AGILITY_ENTRY_GATE_DIALOG ${JSON.stringify({ event, tick: s.tick(), at: p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown', detail })}`);
    };

    const fail = (why: string): never => {
        const p = pos();
        const st = s.sdk.getState();
        const info = {
            at: p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown',
            opens,
            femi,
            choiceAttempts,
            choices,
            dialog: dialog.slice(-8),
            npcs: (st?.nearbyNpcs ?? []).filter(n => d8(n, G) <= 8).map(n => ({ id: n.id, name: n.name, x: n.x, z: n.z })),
            locs: (st?.nearbyLocs ?? []).filter(l => d8(l, G) <= 4).map(l => ({ id: l.id, name: l.name, x: l.x, z: l.z })),
            messages: (st?.gameMessages ?? []).slice(-10).map(m => m.text),
        };
        console.log(`AGILITY_ENTRY_GATE_FAIL ${JSON.stringify({ why, ...info })}`);
        throw Error(`${label}: ${why} ${JSON.stringify(info)}`);
    };

    for (let attempt = 0; attempt < G.attempts && !inside(); attempt++) {
        d.left(label);
        d.live();
        await d.health();
        d.live();
        opens++;
        const openReply = await s.direct({ type: 'interactLoc', x: G.x, z: G.z, locId: G.id, optionIndex: 1, reason: 'SDK' });
        trace('open-reply', { opens, reply: openReply });
        d.live();
        d.left(label);
        if (openReply && typeof openReply === 'object' && 'success' in openReply && openReply.success === false) {
            fail(`gate dispatch rejected ${JSON.stringify(openReply)}`);
        }
        let talked = false;
        let quiet = 0;
        const settling = () => {
            const st = choices[0]?.settle;
            return !!st && st.end === undefined;
        };

        for (let i = 0; (i < G.waitTicks || settling() || (femi === 1 && page().isOpen && i < G.waitTicks + 30)) && !inside(); i++) {
            d.left(label);
            await waitTicks(s, 1);
            d.live();
            d.left(label);
            const observed = { tick: s.tick(), page: page() };
            const p = observed.page;
            trace('observe', observed);
            if (pending) {
                if (sameGatePage(p, pending.page) || (pending.choice && p.isOpen && p.options.some(o => G.femi.test(o.text)))) {
                    quiet = 0;
                    continue;
                }
                trace('advanced', observed);
                if (pending.choice) pending.choice.advanced = observed;
                pending = undefined;
            }
            if (choices.length === 1 && choices[0]!.advanced && femiThanks(p) && !choices[0]!.completed) {
                choices[0]!.completed = observed;
                femi = 1;
                trace('femi-completed', observed);
                if (choices[0]!.settle) choices[0]!.settle.end = observed.tick;
            }
            const help = choices.length === 1 ? choices[0]! : undefined;
            if (help?.accepted && !help.settle && !help.completed && !p.isOpen) {
                help.settle = { start: observed.tick, marks: [] };
                trace('settle-start', { tick: observed.tick });
            }
            if (help && settling()) {
                const pl = pos();
                const st = help.settle!;
                const last = st.marks.at(-1);
                const mark: SettleMark = {
                    tick: observed.tick,
                    at: pl ? `${pl.worldX},${pl.worldZ},${pl.level}` : 'unknown',
                    anim: pl?.animId ?? -1,
                    open: p.isOpen,
                    text: p.text,
                };
                if (!last || last.at !== mark.at || last.anim !== mark.anim || last.open !== mark.open || last.text !== mark.text) {
                    st.marks.push(mark);
                    trace('settle', mark);
                }
                if (p.isOpen) fail('unexpected dialogue during Femi settlement');
                if (observed.tick - st.start >= G.femiSettle.ticks) fail('Femi settlement unresolved');
                continue;
            }
            if (p.isOpen && !p.isWaiting) {
                if (p.text && dialog.at(-1) !== p.text) dialog.push(p.text);
                const pick = p.options.find(o => G.femi.test(o.text));
                const continuation = p.options.length === 1 && CONTINUE_OPT_RE.test(p.options[0]!.text);
                if (!pick && p.options.length && !continuation) {
                    fail(`unexpected dialogue choice ${p.options.map(o => o.text).join(' | ')}`);
                }
                if (pick && (p.options.length !== 2 || !p.options.some(o => o.text === "Sorry, I'm a bit busy."))) {
                    fail('unexpected Femi choice page');
                }
                if (!p.pageId) fail('dialogue page identity unavailable');
                if (pick && choices.length) fail('repeated Femi choice after advancement');
                trace('dispatch', { page: p, index: pick?.index ?? 0 });
                if (pick) choiceAttempts++;
                const reply = pick ? await s.sdk.clickDialogByText(G.femi) : await s.sdk.sendClickDialog(0);
                trace('dispatch-reply', { page: p, index: pick?.index ?? 0, reply });
                const choice: FemiChoice | undefined = pick ? { tick: observed.tick, page: p, index: pick.index, reply } : undefined;
                if (choice) choices.push(choice);
                else if (help?.advanced && !help.accepted && !help.completed && femiAccepted(p)) help.accepted = observed;
                d.live();
                d.left(label);
                if (!reply?.success) fail(`dialogue dispatch rejected ${reply?.reason ?? reply?.message ?? 'missing reply'}`);
                pending = { page: p, choice };
                talked = true;
                quiet = 0;
                continue;
            }
            if (talked && ++quiet >= G.quietTicks) break;
        }
        if (page().isOpen) fail('dialogue advancement unobserved');
        if (choices.length && femi !== 1) fail('Femi completion unobserved');
    }

    if (!inside()) fail('north entrance unobserved');
    const p = pos()!;
    const r = { opens, femi, choiceAttempts, choices, at: `${p.worldX},${p.worldZ},${p.level}`, tick: s.tick() };
    console.log(`AGILITY_ENTRY_GATE ${JSON.stringify(r)}`);
    return r;
}

export function needsCourseApproach(c: Course | 'brimhaven', p: Pos): boolean {
    if (!onCourse(c, p)) return true;
    return c === 'gnome'
        && p.level === 0
        && resumeStep(c, p) === 0
        && Math.max(Math.abs(p.worldX - COURSES[c].start.x), Math.abs(p.worldZ - COURSES[c].start.z)) > 1;
}

export interface EntryTravelControls {
    left: (label: string) => void;
    live: () => void;
    health: () => Promise<void>;
    low: () => boolean;
    heals: () => number;
    interrupted: () => boolean;
    idleMs?: number;
}

export async function travelAgilityEntry(
    w: PathDeps,
    points: Point[],
    label: string,
    deadline: number,
    d: EntryTravelControls,
): Promise<void> {
    const { walkPath } = loadWalkMod();
    const goal = points.at(-1);
    if (!goal) throw Error(`${label}: missing entry goal`);
    let rest = points;
    let first: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
        d.left(label);
        d.live();
        await d.health();
        d.live();
        let lowStopped = false;
        const trace: string[] = [];
        const r = await walkPath(w, rest, {
            maxTicks: Math.max(1, deadline - (w.tick?.() ?? 0)),
            idleMs: d.idleMs,
            stop: () => {
                if (d.interrupted()) return true;
                if (d.low()) {
                    lowStopped = true;
                    return true;
                }
                return false;
            },
            log: message => {
                trace.push(message);
                if (trace.length > 20) trace.shift();
            },
        });
        const p = w.pos();
        const current = {
            ...r,
            at: p ? { ...p } : null,
            goal: { ...goal },
            nextPoint: rest[r.next] ?? null,
            nearby: w.locs().map(l => ({ id: l.id, name: l.name, x: l.x, z: l.z, options: l.optionsWithIndex })),
            messages: (w.messages?.() ?? []).slice(-20).map(m => ({ ...m })),
            trace,
        };
        first ??= current;
        const evidence = { label, attempt, first, current };
        console.log(`AGILITY_ENTRY_WALK ${JSON.stringify(evidence)}`);
        const fail = (why: string): never => {
            throw Error(`${label}: ${why} ${JSON.stringify(evidence)}`);
        };
        try {
            d.live();
        } catch (e) {
            fail(`${r.detail ?? 'walk result'}; ${String(e)}`);
        }
        if (d.interrupted()) fail(`${r.detail ?? 'walk result'}; session interrupted`);
        if (r.ok) {
            if (p && p.level === 0 && Math.max(Math.abs(p.x - goal.x), Math.abs(p.z - goal.z)) <= (goal.tol ?? 2)) return;
            fail('walk reported success without observed entry position');
        }
        if (r.detail !== 'stopped' || !lowStopped || !d.low()) fail(r.detail ?? 'walk failed without detail');
        const heals = d.heals();
        try {
            await d.health();
            d.live();
        } catch (e) {
            fail(`${r.detail}; ${String(e)}`);
        }
        if (d.interrupted()) fail(`${r.detail}; session interrupted`);
        if (d.heals() <= heals || d.low()) fail(`${r.detail}; food effect unobserved`);
        rest = rest.slice(Math.min(r.next, rest.length - 1));
    }
    throw Error(`${label}: low-HP recovery limit exhausted ${JSON.stringify({ first, goal })}`);
}

export interface EntryFoodDeps {
    approach: (points: Point[], label: string) => Promise<void>;
    left: (label: string) => void;
    live: () => void;
    coins: () => number;
    owned: () => number;
    deadline: number;
}

export async function buyEntryFood(s: Session, d: EntryFoodDeps): Promise<{ bought: number; spent: number }> {
    const { waitUntil } = loadTicksMod();
    const E = DRAYNOR_ENTRY;
    const reserve = E.fare * E.fares;
    const wydin = () => (s.sdk.getState()?.nearbyNpcs ?? []).find(n => n.id === E.wydin.id && E.wydin.name.test(n.name));
    const fail = (why: string): never => {
        const p = s.sdk.getState()?.player;
        const nearby = (s.sdk.getState()?.nearbyNpcs ?? []).map(n => ({
            name: n.name,
            id: n.id,
            x: n.x,
            z: n.z,
            options: (n.optionsWithIndex ?? []).map(o => o.text),
        }));
        const info = { at: p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown', coins: d.coins(), nearby };
        console.log(`AGILITY_ENTRY_SHOP_FAIL ${JSON.stringify({ why, ...info })}`);
        throw Error(`food shop unavailable: ${why} ${JSON.stringify(info)}`);
    };

    if (!wydin()) await d.approach([E.shop], 'walk to Wydin');
    d.live();
    if (!wydin() && !await waitUntil(s, () => !!wydin(), { timeoutTicks: Math.max(1, Math.min(10, d.deadline - s.tick())) })) {
        fail('Wydin unobserved');
    }
    d.live();
    const npc = wydin()!;
    if (!(npc.optionsWithIndex ?? []).some(o => TRADE_OPT_RE.test(o.text))) fail('Wydin Trade option unobserved');

    let bought = 0;
    let spent = 0;
    try {
        const shop = await s.bot.openShop(npc);
        d.live();
        if (!shop.success || !s.sdk.getState()?.shop?.isOpen) fail(`open: ${shop.message}`);
        for (const item of E.foods) {
            for (let i = 0; i < 3 && bought < E.foodMax; i++) {
                d.left('food purchase');
                const line = s.sdk.getState()?.shop?.shopItems?.find(x => item.test(x.name));
                if (!line || line.count <= 0 || !Number.isFinite(line.buyPrice) || line.buyPrice < 0 || d.coins() - line.buyPrice < reserve) {
                    break;
                }
                const c0 = d.coins();
                const f0 = d.owned();
                const r = await s.bot.buyFromShop(line, 1);
                d.live();
                const cost = c0 - d.coins();
                const got = d.owned() - f0;
                console.log(`AGILITY_ENTRY_PURCHASE ${JSON.stringify({ item: line.name, sdkSuccess: r.success, bought: got, spent: cost, coins: d.coins(), tick: s.tick() })}`);
                if (got !== 1 || cost <= 0) break;
                bought++;
                spent += cost;
            }
        }
    } finally {
        await s.bot.closeShop();
    }
    if (bought < 1) fail('food purchase effect unobserved');
    if (d.coins() < reserve) throw Error('food purchase left too few coins for boat fares');
    return { bought, spent };
}

export function brimhavenPaid(s: Session): boolean {
    const raw = (s.client as { varServ?: Record<number, number> } | undefined)?.varServ?.[BRIMHAVEN_ARENA.varpId] ?? 0;
    return (raw & BRIMHAVEN_ARENA.paidBitMask) !== 0;
}

export async function payBrimhavenFee(
    s: Session,
    deadline: number,
    live: () => void,
    tick: () => Promise<void>,
): Promise<void> {
    if (brimhavenPaid(s)) return;
    const { waitUntil } = loadTicksMod();
    const clerk = () => (s.sdk.getState()?.nearbyNpcs ?? []).find(
        n => n.id === BRIMHAVEN_ARENA.clerkId || CLERK_IZZY_RE.test(n.name),
    );
    if (!clerk() && !await waitUntil(s, () => !!clerk(), { timeoutTicks: Math.max(1, Math.min(12, deadline - s.tick())) })) {
        throw Error('brimhaven entry: Cap\'n Izzy No-Beard unobserved');
    }
    const npc = clerk()!;
    const payOp = npc.optionsWithIndex.find(o => PAY_OPT_RE.test(o.text));
    if (payOp) {
        const res = await s.sdk.sendInteractNpc(npc.index, payOp.opIndex);
        if (!res.success) throw Error(`brimhaven fee payment refused: ${res.message}`);
        if (await waitUntil(s, () => brimhavenPaid(s), { timeoutTicks: Math.max(1, Math.min(12, deadline - s.tick())) })) {
            return;
        }
    }
    const talkOp = npc.optionsWithIndex.find(o => TALK_OPT_RE.test(o.text)) ?? npc.optionsWithIndex[0];
    if (!talkOp) throw Error('brimhaven entry: clerk interaction unavailable');
    const talk = await s.sdk.sendInteractNpc(npc.index, talkOp.opIndex);
    if (!talk.success) throw Error(`brimhaven clerk talk refused: ${talk.message}`);
    while (!brimhavenPaid(s) && s.tick() < deadline) {
        live();
        const dlg = s.sdk.getDialog();
        if (dlg?.isOpen && !dlg.isWaiting) {
            const opts = dlg.options ?? [];
            const pick = opts.find(o => BRIMHAVEN_PAY_OPT_RE.test(o.text));
            if (pick) await s.sdk.sendClickDialog(pick.index);
            else await s.sdk.sendClickDialog(0);
        }
        await tick();
    }
    if (!brimhavenPaid(s)) throw Error('brimhaven entry fee effect unobserved');
}
