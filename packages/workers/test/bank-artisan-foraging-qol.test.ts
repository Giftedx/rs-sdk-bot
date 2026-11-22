// Migrated unit tests for foraging care, Miscellania coffer, and QOL helpers.
import { describe, expect, test } from 'bun:test';
import { setEquipmentObserved } from '../../core/src/container-observation';
import {
    MISC_COFFER,
    cofferDepositEffect,
    cofferText,
    depositMiscCoffer,
    dropQolItems,
    druidPouchFillDelta,
    enableQolRun,
    enableSpecial,
    fillDruidPouch,
    holdPrayer,
    kittenCare,
    miscResourceEffect,
    miscResourceText,
    qolDropSelection,
    refillCannon,
    weedMiscellania,
} from '../src/bank-artisan';

describe('foraging:care', () => {
    test('native kitten feed selects explicit pet and confirms fresh message plus fish debit', async () => {
        const items = [{ id: 317, slot: 0, count: 2 }];
        const messages: any[] = [];
        const s: any = {
            tick: () => 0,
            sdk: {
                getInventory: () => items,
                getSkill: () => ({ level: 10 }),
                getState: () => ({ player: { lifeId: 1 }, nearbyNpcs: [{ index: 9, name: 'Kitten' }], gameMessages: messages }),
                sendUseItemOnNpc: async (slot: number, npc: number) => {
                    expect([slot, npc]).toEqual([0, 9]);
                    items[0]!.count--;
                    messages.push({ type: 0, observationId: 1, tick: 0, text: 'The kitten gobbles up the raw shrimps.' });
                },
            },
        };
        expect(await kittenCare(s, 9, 'feed', 20)).toMatchObject({ ok: true, input: 317 });
    });

    function weedSession(effect: (f: any) => void) {
        let tick = 0;
        let calls = 0;
        const messages: any[] = [];
        const inventory: any[] = [{ id: 995, count: 37, slot: 0 }];
        const skills = Array.from({ length: 21 }, (_, i) => ({ name: String(i), experience: 100 }));
        const player: any = { lifeId: 1, respawnCount: 0 };
        const client: any = { var: { 361: 50 << 18 }, executeBotAction: () => ({ success: true }) };
        setEquipmentObserved(client, true);
        const f: any = {
            messages,
            inventory,
            skills,
            player,
            client,
            get calls() {
                return calls;
            },
            s: {
                name: 'weedunit',
                client,
                ended: new Promise(() => {}),
                tick: () => tick,
                onTick: (cb: () => void) => {
                    let active = true;
                    const next = () =>
                        queueMicrotask(() => {
                            if (active) {
                                tick++;
                                cb();
                                next();
                            }
                        });
                    next();
                    return () => {
                        active = false;
                    };
                },
                sdk: {
                    getInventory: () => inventory,
                    getEquipment: () => [{ id: 3899, slot: 3, count: 1 }],
                    getSkill: (name: string) => ({ level: name === 'Herblore' ? 35 : 99 }),
                    getStateAge: () => 0,
                    getState: () => ({ player, skills, nearbyLocs: [{ id: 4678, x: 2, z: 3 }], gameMessages: messages }),
                },
                direct: async (a: any) => {
                    calls++;
                    expect(a).toMatchObject({ type: 'interactLoc', x: 2, z: 3, locId: 4678, optionIndex: 1 });
                    effect(f);
                    return { success: true };
                },
            },
        };
        return f;
    }

    function weedSuccess(f: any) {
        f.client.var[361] += 1 << 18;
        f.messages.push({ type: 0, observationId: f.messages.length + 1, tick: 0, text: 'You manage to weed some herbs and give them to Gardener Gunnhild.' });
    }

    test('actual Miscellania weeding accepts native fractional XP floor zero and whole-XP crossing with public approval', async () => {
        for (const crossing of [false, true]) {
            const f = weedSession(fn => {
                weedSuccess(fn);
                if (crossing) fn.skills[15].experience++;
            });
            const r = await weedMiscellania(f.s, 1, 40, () => false, 1);
            expect(r).toMatchObject({ ok: true, made: 1, preserved: true, herblorePublicXpDelta: crossing ? 1 : 0, approval: { before: 50, after: 51 } });
            expect(f.calls).toBe(1);
        }
    });

    test('approval decoder preserves unrelated signed affection bits in the same public varp', async () => {
        const f = weedSession(weedSuccess);
        f.client.var[361] |= 0x80000000;
        expect((await weedMiscellania(f.s, 1, 40, () => false, 1)).ok).toBe(true);
    });

    test('weeding declared native XP multiplier handles both default25 rounding phases and rejects wrong rate', async () => {
        for (const delta of [2, 3]) {
            const f = weedSession(fn => {
                weedSuccess(fn);
                fn.skills[15].experience += delta;
            });
            const r = await weedMiscellania(f.s, 1, 40);
            expect(r).toMatchObject({ ok: true, xpMultiplier: 25, herblorePublicXpDelta: delta });
        }
        const bad = weedSession(fn => {
            weedSuccess(fn);
        });
        expect((await weedMiscellania(bad.s, 1, 40)).ok).toBe(false);
    });

    test('weeding exact system success requires the exact public approval increment', async () => {
        for (const change of [0, 2]) {
            const f = weedSession(fn => {
                weedSuccess(fn);
                fn.client.var[361] = (50 + change) << 18;
            });
            const r = await weedMiscellania(f.s, 1, 40, () => false, 1);
            expect(r.ok).toBe(false);
            expect(f.calls).toBe(1);
        }
    });

    test('weeding public chat cannot supply the fresh native receipt', async () => {
        const f = weedSession(fn => {
            weedSuccess(fn);
            fn.messages[0].type = 2;
        });
        expect((await weedMiscellania(f.s, 1, 40, () => false, 1)).ok).toBe(false);
        expect(f.calls).toBe(1);
    });

    test('weeding retains whole stock and all other XP and prevents another input after life or executor replacement', async () => {
        for (const mode of ['stock', 'XP', 'life', 'owner']) {
            const f = weedSession(fn => {
                weedSuccess(fn);
                if (mode === 'stock') fn.inventory.push({ id: 440, count: 1, slot: 1 });
                if (mode === 'XP') fn.skills[0].experience++;
                if (mode === 'life') fn.player.lifeId++;
                if (mode === 'owner') fn.client.executeBotAction = () => ({ success: false });
            });
            expect((await weedMiscellania(f.s, 2, 80, () => false, 1)).ok).toBe(false);
            expect(f.calls).toBe(1);
        }
    });

    test('kitten wool attention confirms fresh dialogue and never consumes wool', async () => {
        const items = [{ id: 1759, slot: 0, count: 1 }];
        const dialogs: any[] = [];
        const s: any = {
            tick: () => 0,
            sdk: {
                getInventory: () => items,
                getSkill: () => ({ level: 10 }),
                getState: () => ({ player: { lifeId: 1 }, nearbyNpcs: [{ index: 9, name: 'Kitten' }], recentDialogs: dialogs }),
                sendUseItemOnNpc: async () => {
                    dialogs.push({ observationId: 1, tick: 0, text: ['That kitten loves to play with that ball of wool.', 'I think it is its favourite.'] });
                },
            },
        };
        expect(await kittenCare(s, 9, 'wool', 20)).toMatchObject({ ok: true, input: 1759 });
        expect(items[0]!.count).toBe(1);
    });

    test('public chat cannot impersonate native kitten attention receipt', async () => {
        let tick = 0;
        const messages: any[] = [];
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                let active = true;
                queueMicrotask(() => {
                    if (active) {
                        tick++;
                        cb();
                    }
                });
                return () => {
                    active = false;
                };
            },
            sdk: {
                getInventory: () => [{ id: 1759, slot: 0, count: 1 }],
                getSkill: () => ({ level: 10 }),
                getState: () => ({ player: { lifeId: 1 }, nearbyNpcs: [{ index: 9, name: 'Kitten' }], gameMessages: messages }),
                sendUseItemOnNpc: async () => {
                    messages.push({ type: 2, observationId: 1, tick: 0, text: 'That kitten loves to play with that ball of wool.' });
                },
            },
        };
        expect(await kittenCare(s, 9, 'wool', 1)).toMatchObject({ ok: false });
    });

    test('Druid pouch consumes exactly three harvests in native pear/stem/mushroom priority', () => {
        expect(druidPouchFillDelta([{ id: 2957, count: 1 }, { id: 2974, count: 2 }, { id: 2972, count: 2 }, { id: 2970, count: 5 }])).toEqual({
            input: 2957,
            charges: 8,
            delta: { 2957: -1, 2958: 8, 2974: -2, 2972: -1 },
        });
        expect(druidPouchFillDelta([{ id: 2958, count: 9 }, { id: 2970, count: 3 }])).toEqual({
            input: 2958,
            charges: 3,
            delta: { 2958: 3, 2970: -3 },
        });
        expect(() => druidPouchFillDelta([{ id: 2957, count: 1 }, { id: 2970, count: 2 }])).toThrow('three');
    });

    test('actual Druid fill requires native exact fresh credit, preserves unrelated stock, no repeated unknown action', async () => {
        for (const wrong of [false, true]) {
            let tick = 0;
            let done = false;
            let calls = 0;
            const cb = new Set<() => void>();
            const inventory: any[] = [
                { id: 2957, count: 1, slot: 0 },
                { id: 2974, count: 2, slot: 1 },
                { id: 2972, count: 1, slot: 2 },
                { id: 995, count: 37, slot: 3 },
            ];
            const messages: any[] = [];
            const s: any = {
                name: 'unit',
                tick: () => tick,
                onTick: (f: () => void) => {
                    cb.add(f);
                    return () => cb.delete(f);
                },
                ended: new Promise(() => {}),
                client: { ingame: true, ifType: () => ({ colour: 0x00f800 }), executeBotAction: () => ({ success: true }) },
                sdk: {
                    getState: () => ({ player: { lifeId: 1 }, gameMessages: messages, skills: [] }),
                    getSkill: () => ({ level: 99 }),
                    getInventory: () => inventory,
                    getEquipment: () => [],
                    sendUseItem: async () => {
                        calls++;
                        inventory.splice(0, 3, { id: 2958, count: wrong ? 9 : 8, slot: 0 });
                        messages.push({ type: 0, text: 'You add 8 natures harvests to your druid pouch.', observationId: 1, tick });
                        return { success: true };
                    },
                },
            };
            s.direct = async (a: any) => s.sdk.sendUseItem(a.slot, 1);
            const pending = fillDruidPouch(s, 1, 12).then(r => {
                done = true;
                return r;
            });
            for (let i = 0; i < 20 && !done; i++) {
                tick++;
                for (const f of [...cb]) f();
                for (let n = 0; n < 20; n++) await Promise.resolve();
            }
            const r = await pending;
            expect(r.ok).toBe(!wrong);
            expect(calls).toBe(1);
            expect(inventory.find(i => i.id === 995)?.count).toBe(37);
        }
    });

    test('Druid executor replacement after first paid fill prevents the second fill', async () => {
        let calls = 0;
        const inventory: any[] = [{ id: 2957, count: 1, slot: 0 }, { id: 2970, count: 6, slot: 1 }];
        const messages: any[] = [];
        const client: any = { ingame: true, ifType: () => ({ colour: 0x00f800 }), executeBotAction: () => ({ success: true }) };
        const s: any = {
            client,
            name: 'unit',
            tick: () => 0,
            ended: new Promise(() => {}),
            sdk: { getState: () => ({ player: { lifeId: 1 }, gameMessages: messages, skills: [] }), getSkill: () => ({ level: 99 }), getInventory: () => inventory, getEquipment: () => [] },
            direct: async () => {
                calls++;
                inventory[0] = { id: 2958, count: 3, slot: 0 };
                inventory[1].count -= 3;
                messages.push({ type: 0, text: 'You add 3 natures harvests to your druid pouch.', observationId: 1, tick: 0 });
                client.executeBotAction = () => ({ success: false });
                return { success: true };
            },
        };
        const r = await fillDruidPouch(s, 2, 20);
        expect(r.ok).toBe(false);
        expect(calls).toBe(1);
        expect(inventory[1].count).toBe(3);
    });

    test('weeding multiplier receipts use cumulative raw-floor bounds at phase0 and9', async () => {
        for (const rate of [1, 25]) {
            for (const phase of [0, 9]) {
                let raw = 1000 + phase;
                const f = weedSession(fn => {
                    raw += rate;
                    fn.skills[15].experience = Math.floor(raw / 10);
                    weedSuccess(fn);
                });
                const r = await weedMiscellania(f.s, 2, 80, () => false, rate);
                expect(r.ok).toBe(true);
                expect(r.herblorePublicXpDelta).toBe(Math.floor((phase + rate * 2) / 10));
                expect(f.calls).toBe(2);
            }
        }
        const bad = weedSession(fn => {
            fn.skills[15].experience += 3;
            weedSuccess(fn);
        });
        expect((await weedMiscellania(bad.s, 2, 80, () => false, 25)).ok).toBe(false);
        expect(bad.calls).toBe(2);
    });
});

describe('foraging:miscellania-coffer', () => {
    function fixture(o: { coffers?: number; resources?: boolean; member?: number; swapLife?: boolean; publicReceipt?: boolean; stopAtCount?: boolean; choiceLag?: number; collect?: boolean; badCredit?: boolean; crowded?: boolean } = {}) {
        let tick = 0;
        let modal = -1;
        let countOpen = false;
        let phase = '';
        let coffers = o.coffers ?? 1000;
        let observations = 0;
        let buttons = 0;
        let submits = 0;
        let no = 0;
        let talks = 0;
        const inventory = [{ id: 995, count: 5000, slot: 0 }, { id: 2357, count: 2, slot: 1 }];
        const equipment = [{ id: 1381, count: 1, slot: 3 }];
        const dialogs: any[] = [];
        const messages: any[] = [];
        const player = { worldX: 2499, worldZ: 3856, level: 1, lifeId: 1, respawnCount: 0, isDead: false };
        if (o.crowded) for (let i = 0; i < 20; i++) inventory.push({ id: 10000 + i, count: 1, slot: 2 + i });
        let delivery: { at: number; dialog: any } | undefined;
        let dialog: any = { isOpen: false, options: [], isWaiting: false };
        const text = (value: string) => {
            dialogs.push({ tick, observationId: ++observations, text: [value] });
            dialog = { isOpen: true, options: [{ index: 1, text: 'Click here to continue' }], isWaiting: false };
        };
        const state = () => ({ player, inventory, equipment, dialog, recentDialogs: dialogs, gameMessages: messages, nearbyNpcs: [{ id: 1375, index: 7, distance: 1, reachable: true }], skills: [{ name: 'Hitpoints', level: 50, baseLevel: 50, experience: 1000 }] });
        const s: any = {
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (cb: () => void) => {
                let active = true;
                queueMicrotask(() => {
                    if (active) {
                        tick++;
                        if (delivery && tick >= delivery.at) {
                            dialog = delivery.dialog;
                            delivery = undefined;
                        }
                        cb();
                    }
                });
                return () => {
                    active = false;
                };
            },
            client: { ingame: true, membersAccount: o.member ?? 1, getModalInterface: () => modal, isChatBackInputOpen: () => countOpen, ifType: (id: number) => (id === MISC_COFFER.balance ? { text: String(coffers) } : { colour: 0x00f800 }) },
            sdk: {
                getState: state,
                getInventory: () => inventory,
                getEquipment: () => equipment,
                getSkill: () => ({ level: 50 }),
                getDialog: () => dialog,
                sendCloseModal: async () => {
                    modal = -1;
                    countOpen = false;
                    dialog = { isOpen: false, options: [], isWaiting: false };
                    return { success: true };
                },
                sendInteractNpc: async (index: number, op: number) => {
                    expect([index, op]).toEqual([7, 1]);
                    talks++;
                    phase = 'greeting';
                    text('Greetings, Your Royal Highness.');
                    return { success: true };
                },
                sendClickDialog: async (index: number) => {
                    const old = dialog;
                    const lag = phase === 'choice' ? (o.choiceLag ?? 0) : 0;
                    if (phase === 'greeting') {
                        phase = 'choice';
                        dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'How is the Kingdom faring?' }, { index: 2, text: 'How do I manage the kingdom?' }] };
                    } else if (phase === 'choice') {
                        expect(index).toBe(1);
                        phase = o.resources ? 'resource-intro' : 'distribution';
                        text(o.resources ? 'Would you like to collect the resources gathered by your subjects?' : 'This is how your subjects are distributing their effort.');
                    } else if (phase === 'resource-intro') {
                        phase = 'resource-choice';
                        dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'Yes' }, { index: 2, text: 'No' }] };
                    } else if (phase === 'resource-choice') {
                        if (o.collect) {
                            expect(index).toBe(1);
                            inventory.push({ id: 1518, count: o.badCredit ? 8 : 9, slot: 2 });
                            inventory.push({ id: 254, count: 1, slot: 3 });
                            inventory.push({ id: 268, count: 1, slot: 4 });
                            phase = 'resources';
                            text('9 Maple Logs|2 Herbs');
                        } else {
                            expect(index).toBe(2);
                            no++;
                            phase = 'distribution';
                            text('This is how your subjects are distributing their effort.');
                        }
                    } else if (phase === 'resources') {
                        phase = 'distribution';
                        text('This is how your subjects are distributing their effort.');
                    } else if (phase === 'distribution' || phase === 'added') {
                        modal = MISC_COFFER.interface;
                        dialog = { isOpen: false, options: [], isWaiting: false };
                        phase = 'manage';
                    } else if (phase === 'prompt') {
                        countOpen = true;
                        dialog = { isOpen: false, options: [], isWaiting: false };
                    } else {
                        throw Error('unexpected dialog ' + phase);
                    }
                    if (lag) {
                        delivery = { at: tick + lag, dialog };
                        dialog = old;
                    }
                    return { success: true };
                },
                sendClickComponent: async (id: number) => {
                    expect(id).toBe(MISC_COFFER.deposit);
                    buttons++;
                    modal = -1;
                    phase = 'prompt';
                    text('You are carrying 5000 coins. Enter an amount to deposit in the coffers.');
                    return { success: true };
                },
                sendCountDialog: async (value: number) => {
                    submits++;
                    countOpen = false;
                    inventory[0]!.count -= value;
                    coffers += value;
                    if (o.swapLife) player.lifeId = 2;
                    phase = 'added';
                    if (o.publicReceipt) {
                        messages.push({ type: 2, observationId: ++observations, tick, text: 'Added ' + value + ' coins to the coffers.' });
                        modal = MISC_COFFER.interface;
                        dialog = { isOpen: false, options: [], isWaiting: false };
                    } else {
                        text('Added ' + value + ' coins to the coffers.');
                    }
                    return { success: true };
                },
            },
        };
        s.sdk.clickDialogByText = async (re: RegExp) => {
            const option = dialog.options.find((v: any) => re.test(v.text));
            if (!option) return { success: false };
            return s.sdk.sendClickDialog(option.index);
        };
        return { s, inventory, player, counts: () => ({ buttons, submits, no, talks }), stop: () => !!o.stopAtCount && countOpen };
    }

    test('only canonical native balance text and exact two-sided coin transfer qualify', () => {
        expect(cofferText('500,000')).toBeUndefined();
        expect(cofferText('1234')).toBe(1234);
        expect(cofferText('5000001')).toBeUndefined();
        expect(cofferDepositEffect(100, 1000, 900, 4999900, 5000000)).toBe(true);
        expect(cofferDepositEffect(101, 1000, 900, 4999900, 5000000)).toBe(false);
    });

    test('Ghrim resource path chooses No and deposits exactly once with coffer and stock receipts', async () => {
        const f = fixture({ resources: true });
        const r = await depositMiscCoffer(f.s, 1234, 100);
        expect(r).toMatchObject({ ok: true, submitted: true, coinsSpent: 1234, cofferBefore: 1000, cofferAfter: 2234, preserved: true, pending: false });
        expect(f.counts()).toEqual({ buttons: 1, submits: 1, no: 1, talks: 1 });
        expect(f.inventory[1]!.count).toBe(2);
    });

    test('deposit waits for its fresh prompt while the distribution page is still published', async () => {
        const f = fixture();
        const state = f.s.sdk.getState;
        const dialog = f.s.sdk.getDialog;
        const click = f.s.sdk.sendClickComponent;
        let until = -1;
        let old: any[] = [];
        f.s.sdk.getState = () => {
            const value = state();
            return f.s.tick() < until ? { ...value, recentDialogs: old } : value;
        };
        f.s.sdk.getDialog = () => (f.s.tick() < until ? { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'Click here to continue' }] } : dialog());
        f.s.sdk.sendClickComponent = async (id: number) => {
            old = [...state().recentDialogs];
            const r = await click(id);
            until = f.s.tick() + 3;
            return r;
        };
        const r = await depositMiscCoffer(f.s, 1234, 100);
        expect(r.ok).toBe(true);
        expect(f.counts().buttons).toBe(1);
        expect(f.counts().submits).toBe(1);
        expect(r.coinsSpent).toBe(1234);
    });

    test('a paid deposit waits for fresh Added text and the exact balance publication without another submission', async () => {
        const f = fixture();
        const state = f.s.sdk.getState;
        const dialog = f.s.sdk.getDialog;
        const submit = f.s.sdk.sendCountDialog;
        let until = -1;
        let old: any[] = [];
        f.s.sdk.getState = () => {
            const value = state();
            return f.s.tick() < until ? { ...value, recentDialogs: old } : value;
        };
        f.s.sdk.getDialog = () => (f.s.tick() < until ? { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'Click here to continue' }] } : dialog());
        f.s.sdk.sendCountDialog = async (amount: number) => {
            old = [...state().recentDialogs];
            const r = await submit(amount);
            until = f.s.tick() + 3;
            return r;
        };
        const r = await depositMiscCoffer(f.s, 1234, 100);
        expect(r.ok).toBe(true);
        expect(r.cofferAfter).toBe(2234);
        expect(f.counts().submits).toBe(1);
        expect(r.pending).toBe(false);
    });

    test('capacity clamp is refused before deposit button or amount packet', async () => {
        const f = fixture({ coffers: 4999990 });
        const r = await depositMiscCoffer(f.s, 20, 80);
        expect(r.ok).toBe(false);
        expect(r.detail).toContain('capacity');
        expect(f.counts().buttons).toBe(0);
        expect(f.counts().submits).toBe(0);
        expect(f.inventory[0]!.count).toBe(5000);
    });

    test('unknown membership and insufficient owned funds never start Ghrim dialogue', async () => {
        const f = fixture({ member: 0 });
        await expect(depositMiscCoffer(f.s, 100, 80)).rejects.toThrow('member');
        expect(f.counts().talks).toBe(0);
        const g = fixture();
        await expect(depositMiscCoffer(g.s, 5001, 80)).rejects.toThrow('owned');
        expect(g.counts().talks).toBe(0);
    });

    test('stop at count prompt never dispatches an amount', async () => {
        const f = fixture({ stopAtCount: true });
        const r = await depositMiscCoffer(f.s, 100, 80, f.stop);
        expect(r.ok).toBe(false);
        expect(r.submitted).toBe(false);
        expect(f.counts().submits).toBe(0);
        expect(f.inventory[0]!.count).toBe(5000);
    });

    test('cached original-life mutation after submit cannot qualify and never triggers retry', async () => {
        const f = fixture({ swapLife: true });
        const r = await depositMiscCoffer(f.s, 100, 80);
        expect(r.ok).toBe(false);
        expect(r.detail).toContain('life changed');
        expect(r.submitted).toBe(true);
        expect(f.counts().submits).toBe(1);
    });

    test('public chat cannot replace the private native addition receipt', async () => {
        const f = fixture({ publicReceipt: true });
        const r = await depositMiscCoffer(f.s, 100, 20);
        expect(r.ok).toBe(false);
        expect(f.counts().submits).toBe(1);
    });

    test('a dispatched Ghrim choice waits for published retirement instead of reinterpreting the stale menu', async () => {
        const f = fixture({ resources: true, choiceLag: 3 });
        const r = await depositMiscCoffer(f.s, 1234, 100);
        expect(r.ok).toBe(true);
        expect(f.counts()).toEqual({ buttons: 1, submits: 1, no: 1, talks: 1 });
    });

    test('native resource report audits exact noted credits and aggregated random herbs', () => {
        expect(miscResourceText('9 Maple Logs|2 Herbs')).toEqual({ 'Maple Logs': 9, Herbs: 2 });
        expect(miscResourceText('9 Maple Logs|garbage')).toBeUndefined();
        const before = new Map([[995, 50000]]);
        const after = new Map([[995, 50000], [1518, 9], [254, 1], [268, 1]]);
        expect(miscResourceEffect(before, after, '9 Maple Logs|2 Herbs')).toEqual({ 1518: 9, 254: 1, 268: 1 });
        expect(miscResourceEffect(before, after, '8 Maple Logs|2 Herbs')).toBeUndefined();
        after.set(995, 49999);
        expect(miscResourceEffect(before, after, '9 Maple Logs|2 Herbs')).toBeUndefined();
    });

    test('declared collection consumes one Yes then deposits with exact resource receipts', async () => {
        const f = fixture({ resources: true, collect: true, choiceLag: 3 });
        const r = await depositMiscCoffer(f.s, 1234, 100, () => false, { collectResources: true });
        expect(r).toMatchObject({ ok: true, collectionSubmitted: true, collectionConfirmed: true, collectionCredits: { 1518: 9, 254: 1, 268: 1 }, coinsSpent: 1234, pending: false });
        expect(f.counts()).toEqual({ buttons: 1, submits: 1, no: 0, talks: 1 });
    });

    test('resource credit mismatch preserves pending attribution and never deposits or repeats Yes', async () => {
        const f = fixture({ resources: true, collect: true, badCredit: true });
        const r = await depositMiscCoffer(f.s, 1234, 100, () => false, { collectResources: true });
        expect(r.ok).toBe(false);
        expect(r.collectionPending).toBe(true);
        expect(r.pending).toBe(true);
        expect(f.counts().submits).toBe(0);
        expect(f.counts().talks).toBe(1);
    });

    test('collection refuses missing capacity before destructive native resource generation', async () => {
        const f = fixture({ resources: true, collect: true, crowded: true });
        const r = await depositMiscCoffer(f.s, 1234, 100, () => false, { collectResources: true });
        expect(r.ok).toBe(false);
        expect(r.collectionSubmitted).toBe(false);
        expect(r.detail).toContain('note slots');
        expect(f.inventory.some(i => i.id === 1518)).toBe(false);
    });
});

describe('foraging:qol', () => {
    test('special helper confirms transmitted native state after explicit specbar', async () => {
        const vars: number[] = [];
        vars[300] = 1000;
        vars[301] = 0;
        const s: any = { client: { var: vars }, tick: () => 0, sdk: { getState: () => ({ player: { lifeId: 1 } }), getSkill: () => ({ level: 10 }), getEquipment: () => [{ id: 1215, slot: 3 }], sendClickComponent: async () => { vars[301] = 1; } } };
        expect(await enableSpecial(s, 'combat_stabsword:specbar', 250, 20)).toMatchObject({ ok: true, changed: true, energy: 1000 });
    });

    test('cannon refill reconciles fresh explicit load count and ammo debit', async () => {
        const items = [{ id: 2, slot: 0, count: 50 }];
        const messages: any[] = [];
        const s: any = {
            tick: () => 0,
            sdk: {
                getState: () => ({ player: { lifeId: 1 }, nearbyLocs: [{ id: 6, x: 20, z: 30 }], gameMessages: messages }),
                getSkill: () => ({ level: 10 }),
                getInventory: () => items,
                sendUseItemOnLoc: async (slot: number, x: number, z: number, id: number) => {
                    expect([slot, x, z, id]).toEqual([0, 20, 30, 6]);
                    items[0]!.count -= 30;
                    messages.push({ type: 0, observationId: 1, tick: 0, text: 'You load the cannon with 30 cannonballs.' });
                },
            },
        };
        expect(await refillCannon(s, 20, 30, 20)).toMatchObject({ ok: true, loaded: 30 });
    });

    test('finite prayer hold restores originally inactive prayer', async () => {
        let active = false;
        let tick = 0;
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                let run = true;
                const next = () =>
                    queueMicrotask(() => {
                        if (run) {
                            tick++;
                            cb();
                            next();
                        }
                    });
                next();
                return () => {
                    run = false;
                };
            },
            sdk: { getState: () => ({ player: { lifeId: 1 } }), getSkill: () => ({ level: 99 }), isPrayerActive: () => active },
            bot: {
                activatePrayer: async () => {
                    active = true;
                    return { success: true };
                },
                deactivatePrayer: async () => {
                    active = false;
                    return { success: true };
                },
            },
        };
        expect(await holdPrayer(s, 0, 3)).toMatchObject({ ok: true, activated: true, restored: true });
        expect(active).toBe(false);
    });

    test('public chat plus ammo debit cannot impersonate native cannon load message', async () => {
        let tick = 0;
        const items = [{ id: 2, slot: 0, count: 50 }];
        const messages: any[] = [];
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => {
                let active = true;
                queueMicrotask(() => {
                    if (active) {
                        tick++;
                        cb();
                    }
                });
                return () => {
                    active = false;
                };
            },
            sdk: {
                getState: () => ({ player: { lifeId: 1 }, nearbyLocs: [{ id: 6, x: 20, z: 30 }], gameMessages: messages }),
                getSkill: () => ({ level: 10 }),
                getInventory: () => items,
                sendUseItemOnLoc: async () => {
                    items[0]!.count -= 30;
                    messages.push({ type: 2, observationId: 1, tick: 0, text: 'You load the cannon with 30 cannonballs.' });
                },
            },
        };
        expect(await refillCannon(s, 20, 30, 1)).toMatchObject({ ok: false, loaded: 30 });
    });

    function nativeQolActor(mode = 'paid', full = true) {
        let tick = 0;
        let done = false;
        let calls = 0;
        const callbacks = new Set<() => void>();
        const client: any = { executeBotAction: () => ({ success: true }), var: { 173: 0 }, localPlayer: { routeLength: 0 } };
        const player = { lifeId: 1, respawnCount: 0, isDead: false, worldX: 3185, worldZ: 3436, level: 0, runEnergy: 100, combat: { targetType: 'none' } };
        const inventory: any[] = [
            ...Array.from({ length: full ? 26 : 1 }, (_, slot) => ({ id: 440, name: 'Iron ore', count: 1, slot, optionsWithIndex: [] })),
            { id: 995, name: 'Coins', count: 37, slot: 26, optionsWithIndex: [] },
            { id: 1275, name: 'Rune pickaxe', count: 1, slot: 27, optionsWithIndex: [] },
        ];
        const state: any = { player, inventory, equipment: [{ id: 1387, slot: 3, count: 1 }], skills: [], bank: { isOpen: false }, interface: { isOpen: false }, dialog: { isOpen: false } };
        setEquipmentObserved(client, true);
        const s: any = {
            client,
            name: 'unit',
            tick: () => tick,
            onTick: (f: () => void) => {
                callbacks.add(f);
                return () => callbacks.delete(f);
            },
            ended: new Promise(() => {}),
            sdk: { getState: () => state, getInventory: () => inventory, getStateAge: () => 0, getSkill: () => ({ level: 99, baseLevel: 99 }) },
            direct: async (a: any) => {
                calls++;
                if (mode === 'missing') return { success: false };
                if (a.type === 'dropItem') {
                    const at = inventory.findIndex(i => i.slot === a.slot);
                    inventory.splice(at, 1);
                } else {
                    expect(a.componentId).toBe(153);
                    client.var[173] = 1;
                }
                if (mode === 'wrong-stock') inventory.find(i => i.id === 995).count--;
                if (mode === 'owner') client.executeBotAction = () => ({ success: false });
                if (mode === 'life') player.lifeId = 2;
                if (mode === 'lost') throw Error('lost reply');
                return { success: true };
            },
        };
        const run = async (f: () => Promise<any>) => {
            const pending = f().then(r => {
                done = true;
                return r;
            });
            for (let i = 0; i < 120 && !done; i++) {
                tick++;
                for (const cb of [...callbacks]) cb();
                for (let n = 0; n < 20; n++) await Promise.resolve();
            }
            return pending;
        };
        return { s, run, inventory, client, stats: () => ({ tick, calls }) };
    }

    const dropOrder = { ids: [440], names: [], mode: 'listed' as const, order: 'reverse' as const, maximumDrops: 2, cap: 40 };

    test('full-pack standalone drop uses explicit exact selection/order and retains unrelated stock', async () => {
        const a = nativeQolActor();
        const r = await a.run(() => dropQolItems(a.s, dropOrder));
        expect(r).toMatchObject({ ok: true, slots: 2, units: 2, dropped: { 440: 2 }, uncertain: false });
        expect(a.inventory.filter(i => i.id === 440).length).toBe(24);
        expect(a.inventory.find(i => i.id === 995).count).toBe(37);
        expect(a.inventory.some(i => i.slot === 25 || i.slot === 24)).toBe(false);
        const b = nativeQolActor();
        expect((await b.run(() => dropQolItems(b.s, { ...dropOrder, ids: [], names: ['coins', 'Rune pickaxe'], mode: 'except', maximumDrops: 26 }))).slots).toBe(26);
        expect(b.inventory.map(i => i.id)).toEqual([995, 1275]);
    });

    test('standalone drops require full pack, explicit native Drop, and no preexisting stop', async () => {
        const a = nativeQolActor('paid', false);
        expect(await dropQolItems(a.s, dropOrder)).toMatchObject({ ok: true, slots: 0, skipped: 'pack not full' });
        expect(a.stats().calls).toBe(0);
        const b = nativeQolActor();
        b.inventory.find(i => i.slot === 25).optionsWithIndex = [{ opIndex: 5, text: 'Destroy' }];
        expect((await dropQolItems(b.s, dropOrder)).ok).toBe(false);
        expect(b.stats().calls).toBe(0);
        const c = nativeQolActor();
        expect((await dropQolItems(c.s, dropOrder, () => true)).ok).toBe(false);
        expect(c.stats().calls).toBe(0);
    });

    test('exact lost drop reconciles once; unknown stock/life/executor outcomes park before another drop', async () => {
        const a = nativeQolActor('lost');
        expect((await a.run(() => dropQolItems(a.s, dropOrder))).ok).toBe(true);
        expect(a.stats().calls).toBe(2);
        for (const mode of ['missing', 'wrong-stock', 'life', 'owner']) {
            const b = nativeQolActor(mode);
            const r = await b.run(() => dropQolItems(b.s, dropOrder));
            expect(r.ok).toBe(false);
            expect(r.uncertain).toBe(true);
            expect(b.stats().calls).toBe(1);
        }
    });

    test('finite run applies strict public threshold and one observed native enable; skip and unknown do not retry', async () => {
        const a = nativeQolActor('lost');
        expect(await a.run(() => enableQolRun(a.s, 20, 8))).toMatchObject({ ok: true, changed: true, enabled: true, energyBefore: 100, energyAfter: 100 });
        expect(a.stats().calls).toBe(1);
        const b = nativeQolActor();
        expect(await enableQolRun(b.s, 100, 8)).toMatchObject({ ok: true, changed: false, enabled: false, skipped: 'energy threshold' });
        expect(b.stats().calls).toBe(0);
        const c = nativeQolActor('missing');
        expect((await c.run(() => enableQolRun(c.s, 20, 8))).ok).toBe(false);
        expect(c.stats().calls).toBe(1);
    });

    test('configured names match whole names, not substrings; column order is deterministic', () => {
        const rows = [{ id: 1, name: 'Iron ore', slot: 4, count: 1 }, { id: 2, name: 'Iron arrow', slot: 1, count: 1 }, { id: 3, name: 'Iron ore', slot: 0, count: 1 }];
        expect(qolDropSelection(rows, { ...dropOrder, ids: [], names: ['IRON ORE'], order: 'column', maximumDrops: 3 }).map(i => i.slot)).toEqual([0, 4]);
        expect(() => qolDropSelection(rows, { ...dropOrder, ids: [], names: [] })).toThrow('explicit');
    });
});
