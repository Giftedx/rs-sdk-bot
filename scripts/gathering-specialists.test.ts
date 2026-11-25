import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { xpForLevel } from '../packages/planner/src/curve';
import type { Session } from '../packages/core/src/inprocess';
import { COOKING_SPECIALIST_SUPPLIES } from './cooking-specialist';
import { FIREMAKING_SPECIALIST_SUPPLIES } from './firemaking-specialist';
import { planFletchingActionCounts, pickNextFletchTier, FLETCHING_SPECIALIST_SUPPLIES, OBJ_HEADLESS_ARROW } from './fletching-specialist';
import { FISHING_SPECIALIST_SUPPLIES } from './fishing-specialist';
import { MINING_SPECIALIST_SUPPLIES, MINING_SPECIALIST_LIVE_SUPPLIES, remainingIronOresTo99, IRON_ORE_XP_25X } from './mining-specialist';
import {
    isArdougneResumeState,
    parseThievingCliArgs,
    selectPickpocketTarget,
    selectPickpocketTier,
    THIEVING_SPECIALIST_SUPPLIES,
    THIEVING_SPECIALIST_LIVE_SUPPLIES,
    THIEVING_PIZZAS,
} from './thieving-specialist';
import { WOODCUTTING_SPECIALIST_SUPPLIES } from './woodcutting-specialist';
import {
    OBJ_GAMES_8,
    OBJ_PINEAPPLE_PIZZA,
    OBJ_SUPER_ENERGY_4,
    TRADE_SIDE_INV_ID,
    TRADE_MAIN_ACCEPT_ID,
    TRADE_CONFIRM_ACCEPT_ID,
    startHelperTradeArm,
    receiveTradeFast,
} from './gathering-specialist-lib';
import { expandSupplyInventory, SPECIALIST_GATHERING_CASES } from './measure/specialist-gathering-cases';
import { benchCases, benchCoverage } from './measure/aio-bench-cases';
import {
    FLETCHING_SPECIALIST_LIVE_KIT,
    hasAtLeastKit,
    hasExactKit,
    kitSlotTotal,
    parseKitArg,
    parseKitOption,
    resolveBaseId,
    resolveConcreteKit,
    resolveSupplierKitPlan,
    SPECIALIST_KITS,
    type KitSpecItem,
} from '../packages/workers/src/logistics';

const ROOT = resolve(import.meta.dir, '..');
const ITEMS: { id: number; name: string; tradeable?: boolean }[] = JSON.parse(
    readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8'),
);

describe('gathering specialists supply & progression plans', () => {
    test('fletching ladder hits 99 in 240 actions using 7 stackable slots', () => {
        const plan = planFletchingActionCounts();
        expect(plan.actions).toBe(240);
        expect(plan.xp).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(plan.byTier).toEqual({
            bronze: 4,
            iron: 6,
            steel: 9,
            mithril: 15,
            adamant: 33,
            rune: 173,
        });
        expect(expandSupplyInventory(FLETCHING_SPECIALIST_SUPPLIES).length).toBe(7);
        expect(FLETCHING_SPECIALIST_SUPPLIES).toEqual({
            [OBJ_HEADLESS_ARROW]: 3600,
            39: 60,
            40: 90,
            41: 135,
            42: 225,
            43: 495,
            44: 2595,
        });
    });

    test('fletching tier picker obeys level unlocks and tip stock', () => {
        const counts = { ...FLETCHING_SPECIALIST_SUPPLIES };
        expect(pickNextFletchTier(0, counts)?.name).toBe('bronze');
        expect(pickNextFletchTier(xpForLevel(75), counts)?.name).toBe('rune');
        expect(pickNextFletchTier(xpForLevel(75), { ...counts, 44: 10 })?.name).toBe('adamant');
        expect(pickNextFletchTier(0, { ...counts, [OBJ_HEADLESS_ARROW]: 14 })).toBeNull();
    });

    test('supply inventories fit within companion 28 slots and main free space after drops', () => {
        const fletchSlots = expandSupplyInventory(FLETCHING_SPECIALIST_SUPPLIES).length;
        const fishSlots = expandSupplyInventory(FISHING_SPECIALIST_SUPPLIES).length;
        const mineSlots = expandSupplyInventory(MINING_SPECIALIST_SUPPLIES).length;
        const thieveSlots = expandSupplyInventory(THIEVING_SPECIALIST_SUPPLIES).length;

        expect(fletchSlots).toBe(7);
        expect(fishSlots).toBeLessThanOrEqual(16);
        expect(mineSlots).toBe(28);
        expect(thieveSlots).toBe(28);
        expect(THIEVING_PIZZAS).toBe(25);
        expect(THIEVING_SPECIALIST_SUPPLIES[OBJ_PINEAPPLE_PIZZA]).toBe(25);
        // 18 tutorial slots -> main drops 0 (fletch), 15 (fish, keeps tinderbox), 18 (mine), 18 (thieve).
        expect(28 - 18).toBeGreaterThanOrEqual(fletchSlots);
        expect(28 - (18 - 15) - fishSlots).toBeGreaterThanOrEqual(1);
        expect(28 - (18 - 18) - mineSlots).toBeGreaterThanOrEqual(0);
        expect(28 - (18 - 18) - thieveSlots).toBeGreaterThanOrEqual(0);
    });

    test('mining iron count from Doric reward covers level 99', () => {
        const doricXp = 32_500;
        const ores = remainingIronOresTo99(doricXp);
        expect(ores).toBe(1104);
        expect(doricXp + ores * IRON_ORE_XP_25X).toBeGreaterThanOrEqual(xpForLevel(99));
        expect(doricXp + (ores - 1) * IRON_ORE_XP_25X).toBeLessThan(xpForLevel(99));
    });

    test('thieving pickpocket ladder selects optimal Ardougne targets', () => {
        expect(selectPickpocketTier(1).name).toBe('man');
        expect(selectPickpocketTier(24).name).toBe('man');
        expect(selectPickpocketTier(25).name).toBe('warrior');
        expect(selectPickpocketTier(39).name).toBe('warrior');
        expect(selectPickpocketTier(40).name).toBe('guard');
        expect(selectPickpocketTier(54).name).toBe('guard');
        expect(selectPickpocketTier(55).name).toBe('knight');
        expect(selectPickpocketTier(99).name).toBe('knight');

        expect(isArdougneResumeState({ worldX: 2621, worldZ: 3293, level: 0 }, true)).toBe(true);
        expect(isArdougneResumeState({ worldX: 3222, worldZ: 3218, level: 0 }, true)).toBe(false);
        expect(isArdougneResumeState({ worldX: 2621, worldZ: 3293, level: 1 }, true)).toBe(false);
        expect(isArdougneResumeState({ worldX: 2621, worldZ: 3293, level: 0 }, false)).toBe(false);
        expect(parseThievingCliArgs(['HalfInch', 'RESUME=1', 'CAP=2200'], { LIVE: '1' })).toEqual({
            account: 'HalfInch',
            helperName: 'HalfInchb',
            cap: 2200,
            resume: true,
        });

        const warriorTier = selectPickpocketTier(25);
        expect(selectPickpocketTarget([
            { name: 'Warrior woman', distance: 2, x: 2624, z: 3297, reachable: false, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] },
            { name: 'Warrior woman', distance: 6, x: 2630, z: 3296, reachable: true, optionsWithIndex: [{ text: 'Pickpocket', opIndex: 3 }] },
        ], warriorTier).target?.x).toBe(2630);
    });

    test('extra:thieving-specialist-resume recovers Ardougne food saves within 1,850 ticks', () => {
        const resume = benchCases().find(x => x.key === 'extra:thieving-specialist-resume');
        expect(resume).toBeDefined();
        expect(resume!.presetConfig?.position).toEqual({ x: 2621, z: 3293, level: 0 });
        expect(resume!.presetConfig?.inventory?.length).toBe(27);
        expect(resume!.pass('LOGOUT logged-out\nRESULT ok level=99 totalTicks=1750')).toBe(true);
        expect(resume!.pass('LOGOUT logged-out\nRESULT ok level=99 totalTicks=1860')).toBe(false);
    });
});

describe('bench registration and catalog integration', () => {
    test('all 7 specialist bench cases are registered with fresh tutorial=0 fixtures and strict pass checks', () => {
        const cases = benchCases();
        for (const [key, expectedCompanions] of [
            ['skiller:fletching:specialist', 1],
            ['skiller:fishing:specialist', 1],
            ['skiller:mining:specialist', 1],
            ['skiller:thieving:specialist', 1],
            ['skiller:cooking:specialist', 1],
            ['skiller:firemaking:specialist', 2],
            ['skiller:woodcutting:specialist', 1],
        ] as const) {
            const c = cases.find(x => x.key === key);
            expect(c, key).toBeDefined();
            expect(c!.presetConfig?.varps?.[281]).toBe(0);
            expect(c!.companions?.length).toBe(expectedCompanions);
            expect(c!.pass('LOGOUT logged-out\nRESULT ok level=99 ticks=53')).toBe(true);
            expect(c!.pass('LOGOUT logged-out logged-out\nRESULT ok level=99 ticks=53')).toBe(true);
            expect(c!.pass('LOGOUT logged-out\nRESULT ok level=98 ticks=53')).toBe(false);
            expect(c!.pass('LOGOUT logged-out\nRESULT ok helper supplied\nRESULT fail cap')).toBe(false);
            expect(c!.pass('RESULT ok level=99 ticks=53')).toBe(false);
        }
        expect(SPECIALIST_GATHERING_CASES.length).toBe(7);
        expect(benchCoverage().gaps).toEqual([]);
    });

    test('gathering kits match supply bills, cataloged tradeable names, and --kit option parsing', () => {
        const byId = new Map(ITEMS.map(item => [item.id, item]));
        const suppliesBySkill = {
            fletching: FLETCHING_SPECIALIST_SUPPLIES,
            'fletching-live': FLETCHING_SPECIALIST_SUPPLIES,
            fishing: FISHING_SPECIALIST_SUPPLIES,
            thieving: THIEVING_SPECIALIST_SUPPLIES,
            'thieving-live': THIEVING_SPECIALIST_LIVE_SUPPLIES,
            cooking: COOKING_SPECIALIST_SUPPLIES,
            'cooking-live': COOKING_SPECIALIST_SUPPLIES,
            woodcutting: WOODCUTTING_SPECIALIST_SUPPLIES,
            'woodcutting-live': WOODCUTTING_SPECIALIST_SUPPLIES,
            firemaking: FIREMAKING_SPECIALIST_SUPPLIES,
        } as const;
        expect(expandSupplyInventory(MINING_SPECIALIST_SUPPLIES).length).toBe(28);
        expect(MINING_SPECIALIST_LIVE_SUPPLIES).toEqual(MINING_SPECIALIST_SUPPLIES);
        expect(parseKitArg(['--kit=fletching-live'])).toBe('fletching-live');
        expect(resolveSupplierKitPlan('fletching-live').combined).toBe(FLETCHING_SPECIALIST_LIVE_KIT);
        for (const [skill, supplies] of Object.entries(suppliesBySkill) as [keyof typeof suppliesBySkill, Record<number, number>][]) {
            const parsed = parseKitOption(['holder', 'spec', `--kit=${skill}`]);
            expect(parsed).not.toBeNull();
            expect(parsed!.name).toBe(skill);
            const kit: readonly KitSpecItem[] = SPECIALIST_KITS[skill];
            expect(parsed!.kit).toBe(kit);
            const expanded = expandSupplyInventory(supplies);
            expect(kitSlotTotal(kit)).toBe(expanded.length);
            expect(hasExactKit(expanded, kit)).toBe(true);
            for (const spec of kit) {
                const entry = byId.get(resolveBaseId(spec.id));
                expect(entry, `${skill}:${spec.id}`).toBeDefined();
                expect(entry!.tradeable).toBe(true);
                expect(entry!.name).toBe(spec.name);
                expect(supplies[spec.id]).toBe(spec.count);
            }
        }
        expect(parseKitOption(['holder', 'spec'])).toBeNull();
        expect(parseKitOption(['holder', 'spec'], 'attack').name).toBe('attack');
        expect(() => parseKitOption(['--kit=bogus'])).toThrow('unknown --kit=bogus');
    });

    test('fishing kit accepts charged glories with >=2 charges (4/3/2) and resolves concrete bank stock', () => {
        const fishingKit = SPECIALIST_KITS.fishing;
        const expanded = expandSupplyInventory(FISHING_SPECIALIST_SUPPLIES);
        const withoutGlory = expanded.filter(item => item.id !== 1712);

        for (const [gloryId, gloryName] of [
            [1712, 'Amulet of glory(4)'],
            [1710, 'Amulet of glory(3)'],
            [1708, 'Amulet of glory(2)'],
        ] as const) {
            const pack = [...withoutGlory, { id: gloryId, count: 1 }];
            expect(hasExactKit(pack, fishingKit)).toBe(true);
            expect(hasAtLeastKit(pack, fishingKit)).toBe(true);
            const resolved = resolveConcreteKit(fishingKit, pack);
            const glorySpec = resolved.find(item => item.count === 1 && (item.id === 1712 || item.id === gloryId));
            expect(glorySpec?.id).toBe(gloryId);
            expect(glorySpec?.name).toBe(gloryName);
        }

        for (const badGloryId of [1706, 1704]) {
            const pack = [...withoutGlory, { id: badGloryId, count: 1 }];
            expect(hasExactKit(pack, fishingKit)).toBe(false);
            expect(hasAtLeastKit(pack, fishingKit)).toBe(false);
        }

        const duplicateGlory = [...withoutGlory, { id: 1712, count: 1 }, { id: 1710, count: 1 }];
        expect(hasExactKit(duplicateGlory, fishingKit)).toBe(false);
    });

    test('pipelined trade handoff finishes 7-slot fletching and 2-slot thieving-live in <= 4 ticks without OPPLAYER4 collisions', async () => {
        async function runTradeSim(supplies: Readonly<Record<number, number>>, rttTicks: 0 | 1): Promise<{ tradeTicks: number; declinedCount: number; helperTailOps: number }> {
            type InvItem = { id: number; name: string; count: number; slot: number };
            type TradeState = {
                isOpen: boolean;
                screen: 'offer' | 'confirm' | null;
                partner: string | null;
                myOffer: { id: number; count: number; slot: number }[];
                theirOffer: { id: number; count: number; slot: number }[];
                myAccepted: boolean;
                partnerAccepted: boolean;
            };
            type QueuedPkt = { deliverTick: number; action: { type: string; [k: string]: unknown } };
            type SimActor = {
                name: string;
                index: number;
                inv: InvItem[];
                tradePartnerReq: string | null;
                inTradeWith: string | null;
                screen: 'offer' | 'confirm' | null;
                offer: InvItem[];
                accepted: boolean;
                confirmed: boolean;
                inBuf: QueuedPkt[];
                visibleTrade: TradeState;
                visibleInv: InvItem[];
                listeners: Set<() => void>;
                clientTick: number;
            };

            const makeInv = (counts: Readonly<Record<number, number>>): InvItem[] =>
                expandSupplyInventory(counts).map((item, slot) => ({ id: item.id, name: String(item.id), count: item.count, slot }));
            const emptyTrade = (): TradeState => ({
                isOpen: false, screen: null, partner: null, myOffer: [], theirOffer: [], myAccepted: false, partnerAccepted: false,
            });
            const makeActor = (name: string, index: number, inv: InvItem[]): SimActor => ({
                name, index, inv, tradePartnerReq: null, inTradeWith: null, screen: null, offer: [], accepted: false, confirmed: false,
                inBuf: [], visibleTrade: emptyTrade(), visibleInv: inv.map(x => ({ ...x })), listeners: new Set(), clientTick: 0,
            });

            const helper = makeActor('Moneyshot', 583, makeInv(supplies));
            const main = makeActor('JustTheTip', 115, []);
            let serverTick = 0;
            let declinedCount = 0;
            let helperTailOps = 0;
            let done = false;

            const closeTrade = (a: SimActor, b: SimActor) => {
                if (a.screen) declinedCount++;
                for (const p of [a, b]) {
                    p.inv.push(...p.offer);
                    p.offer = [];
                    p.screen = null;
                    p.inTradeWith = null;
                    p.accepted = false;
                    p.confirmed = false;
                }
            };

            const applyPacket = (actor: SimActor, other: SimActor, a: { type: string; [k: string]: unknown }): boolean => {
                if (a.type === 'interactPlayer' && a.optionIndex === 4) {
                    if (actor.inv.length === 0 && main.inv.length > 0) helperTailOps++;
                    // OpPlayerHandler clears any open modal, which fires [if_close,trademain] ("Other player declined trade.").
                    if (actor.screen) closeTrade(actor, other);
                    if (a.playerIndex !== other.index) return true;
                    actor.tradePartnerReq = other.name;
                    if (other.tradePartnerReq === actor.name && !actor.screen && !other.screen) {
                        actor.tradePartnerReq = null;
                        other.tradePartnerReq = null;
                        for (const [p, q] of [[actor, other], [other, actor]] as const) {
                            p.inTradeWith = q.name;
                            p.screen = 'offer';
                            p.offer = [];
                            p.accepted = false;
                            p.confirmed = false;
                        }
                    }
                    return true;
                }
                if (a.type === 'clickComponentWithOption' && a.componentId === TRADE_SIDE_INV_ID && a.optionIndex === 4) {
                    if (actor.screen !== 'offer') return false;
                    const slotIdx = Number(a.slot);
                    const idx = actor.inv.findIndex(it => it.slot === slotIdx);
                    if (idx === -1) return false;
                    const targetId = actor.inv[idx]!.id;
                    const moved = actor.inv.filter(it => it.id === targetId);
                    actor.inv = actor.inv.filter(it => it.id !== targetId);
                    for (const m of moved) {
                        const existing = actor.offer.find(o => o.id === m.id);
                        if (existing) existing.count += m.count;
                        else actor.offer.push({ ...m, slot: actor.offer.length });
                    }
                    actor.accepted = false;
                    other.accepted = false;
                    return true;
                }
                if (a.type === 'clickComponent' && a.componentId === TRADE_MAIN_ACCEPT_ID) {
                    if (actor.screen !== 'offer') return false;
                    actor.accepted = true;
                    if (other.accepted) {
                        actor.screen = 'confirm';
                        other.screen = 'confirm';
                        actor.confirmed = false;
                        other.confirmed = false;
                    }
                    return true;
                }
                if (a.type === 'clickComponent' && a.componentId === TRADE_CONFIRM_ACCEPT_ID) {
                    if (actor.screen !== 'confirm') return false;
                    actor.confirmed = true;
                    if (other.confirmed) {
                        for (const o of helper.offer) {
                            const ex = main.inv.find(i => i.id === o.id);
                            if (ex && [39, 40, 41, 42, 43, 44, 53].includes(o.id)) ex.count += o.count;
                            else main.inv.push({ ...o, slot: main.inv.length });
                        }
                        for (const o of main.offer) helper.inv.push({ ...o, slot: helper.inv.length });
                        for (const p of [helper, main]) {
                            p.offer = [];
                            p.screen = null;
                            p.inTradeWith = null;
                            p.accepted = false;
                            p.confirmed = false;
                        }
                    }
                    return true;
                }
                return false;
            };

            const snapshotTrade = (actor: SimActor, other: SimActor): TradeState => {
                if (!actor.screen) return emptyTrade();
                const mapItems = (xs: InvItem[]) => xs.map((x, i) => ({ id: x.id, count: x.count, slot: i }));
                return {
                    isOpen: true,
                    screen: actor.screen,
                    partner: other.name,
                    myOffer: mapItems(actor.offer),
                    theirOffer: mapItems(other.offer),
                    myAccepted: actor.screen === 'offer' ? actor.accepted : actor.confirmed,
                    partnerAccepted: actor.screen === 'offer' ? other.accepted : other.confirmed,
                };
            };

            const wrapSession = (self: SimActor, peer: SimActor): Session => ({
                name: self.name,
                sdk: {
                    getInventory: () => self.visibleInv,
                    getTradeState: () => self.visibleTrade,
                    getState: () => ({
                        player: { worldX: 3222, worldZ: 3222, level: 0 },
                        nearbyPlayers: [{ index: peer.index, name: peer.name, x: 3222, z: 3222 }],
                    }),
                } as unknown as Session['sdk'],
                bot: { walkTo: async () => ({ success: true }) } as unknown as Session['bot'],
                tick: () => self.clientTick,
                onTick: cb => {
                    self.listeners.add(cb);
                    return () => { self.listeners.delete(cb); };
                },
                direct: async action => {
                    self.inBuf.push({ deliverTick: serverTick + rttTicks, action });
                    return { success: true, phase: 'dispatch' };
                },
                close: async () => {},
                ended: new Promise(() => {}),
            });

            const helperSess = wrapSession(helper, main);
            const mainSess = wrapSession(main, helper);

            const stepServerAndDeliver = () => {
                serverTick++;
                for (const [actor, other] of [[helper, main], [main, helper]] as const) {
                    let userEvents = 0;
                    const remaining: QueuedPkt[] = [];
                    for (const pkt of actor.inBuf) {
                        if (pkt.deliverTick <= serverTick && userEvents < 5) {
                            const counted = applyPacket(actor, other, pkt.action);
                            if (counted) userEvents++;
                        } else {
                            remaining.push(pkt);
                        }
                    }
                    actor.inBuf = remaining;
                }
                for (const [actor, other] of [[helper, main], [main, helper]] as const) {
                    actor.visibleTrade = snapshotTrade(actor, other);
                    actor.visibleInv = actor.inv.map(x => ({ ...x }));
                    actor.clientTick = serverTick;
                }
                for (const actor of [helper, main]) {
                    for (const cb of [...actor.listeners]) if (actor.listeners.has(cb)) cb();
                }
            };

            const timer = setInterval(() => {
                if (!done) stepServerAndDeliver();
            }, 1);

            try {
                const arm = startHelperTradeArm(helperSess, main.name, () => done || serverTick > 40);
                const tradeTicks = await receiveTradeFast(mainSess, helperSess, supplies, () => done || serverTick > 40, arm);
                return { tradeTicks, declinedCount, helperTailOps };
            } finally {
                done = true;
                clearInterval(timer);
            }
        }

        for (const rttTicks of [0, 1] as const) {
            const fletch = await runTradeSim(FLETCHING_SPECIALIST_SUPPLIES, rttTicks);
            expect(fletch.declinedCount, `fletch rtt=${rttTicks}`).toBe(0);
            expect(fletch.helperTailOps, `fletch tail rtt=${rttTicks}`).toBe(0);
            expect(fletch.tradeTicks, `fletch ticks rtt=${rttTicks}`).toBeLessThanOrEqual(4);

            const thieve = await runTradeSim(THIEVING_SPECIALIST_LIVE_SUPPLIES, rttTicks);
            expect(thieve.declinedCount, `thieve rtt=${rttTicks}`).toBe(0);
            expect(thieve.helperTailOps, `thieve tail rtt=${rttTicks}`).toBe(0);
            expect(thieve.tradeTicks, `thieve ticks rtt=${rttTicks}`).toBeLessThanOrEqual(4);
        }
    });
});
