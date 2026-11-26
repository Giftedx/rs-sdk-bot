import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaggerWatch, DAGGER_DEFAULTS, DAGGER_IDS, daggerOptionsOf, daggerPickup, drainTicks, type DaggerOptions } from '../src/pvp/squad-dagger';
import { cancelAttack, drainedSwitch, GANG_DRAIN_PRAYERS, pickSquadFocus } from '../src/pvp/squad';
import { PRAYER } from '../src/pvp/fight';
import { contentRoot } from '../../knowledge/src/paths';

const env = (vars: Record<string, string>) => (name: string, fallback: string) => vars[name] ?? fallback;
const on: DaggerOptions = { offReads: 3, holdBelow: 0, holdTicks: 0 };
const read = (o: Partial<{ skulled: boolean; overhead: boolean; inCombat: boolean; hp: number | null }> = {}) => ({ skulled: false, overhead: true, inCombat: true, hp: null, ...o });

describe('daggerOptionsOf', () => {
    test('off unless SQUAD_DAGGER=1; the reads and the hold come from their variables', () => {
        expect(daggerOptionsOf(env({}))).toBeUndefined();
        expect(daggerOptionsOf(env({ SQUAD_DAGGER: '0', SQUAD_DAGGER_OFF_READS: '5' }))).toBeUndefined();
        expect(daggerOptionsOf(env({ SQUAD_DAGGER: '1' }))).toEqual(DAGGER_DEFAULTS);
        expect(daggerOptionsOf(env({ SQUAD_DAGGER: '1', SQUAD_DAGGER_OFF_READS: '5', SQUAD_DAGGER_HOLD: '0.5,120' }))).toEqual({ offReads: 5, holdBelow: 0.5, holdTicks: 120 });
        expect(daggerOptionsOf(env({ SQUAD_DAGGER: '1', SQUAD_DAGGER_HOLD: 'off' }))).toMatchObject({ holdBelow: 0, holdTicks: 0 });
    });
    test('a bad value throws with the name of its variable', () => {
        expect(() => daggerOptionsOf(env({ SQUAD_DAGGER: 'yes' }))).toThrow('SQUAD_DAGGER must');
        for (const bad of ['0', '1.5', 'x']) expect(() => daggerOptionsOf(env({ SQUAD_DAGGER: '1', SQUAD_DAGGER_OFF_READS: bad }))).toThrow('SQUAD_DAGGER_OFF_READS');
        for (const bad of ['0.5', '1,100', '0,100', '0.5,0', '0.5,10.5', '0.5,10,1']) expect(() => daggerOptionsOf(env({ SQUAD_DAGGER: '1', SQUAD_DAGGER_HOLD: bad }))).toThrow('SQUAD_DAGGER_HOLD');
    });
});

describe('rule a: no first strike on an unskulled gang account', () => {
    test('an unskulled account that has not attacked one of ours is blocked; an attack or a skull lifts the block', () => {
        const w = createDaggerWatch(on);
        expect(w.firstStrikeBlocked('Goondelf')).toBe(true);
        w.read('Goondelf', 10, read({ skulled: false }));
        expect(w.firstStrikeBlocked('goondelf')).toBe(true);
        w.attacked('goondelf', 11);
        expect(w.firstStrikeBlocked('Goondelf')).toBe(false);
        w.read('Ligma', 10, read({ skulled: true }));
        expect(w.firstStrikeBlocked('ligma')).toBe(false);
    });
    test('a kill or a long absence starts a new life: the account comes back unskulled with no attack on ours', () => {
        const w = createDaggerWatch(on, 100);
        w.read('Sugma', 10, read({ skulled: true }));
        w.attacked('Sugma', 10);
        w.died('Sugma');
        w.read('Sugma', 20, read({ skulled: false }));
        expect(w.firstStrikeBlocked('sugma')).toBe(true);
        w.attacked('Sugma', 21);
        expect(w.firstStrikeBlocked('sugma')).toBe(false);
        w.read('Sugma', 300, read({ skulled: false }));
        expect(w.firstStrikeBlocked('sugma')).toBe(true);
    });
    test('the target choice leaves out a blocked account and takes the one that attacked us', () => {
        const w = createDaggerWatch(on), now = 50;
        const view = [{ name: 'Goondelf', index: 1, distance: 2 }, { name: 'Ligma', index: 2, distance: 5 }];
        w.read('Goondelf', now, read({ skulled: false }));
        w.read('Ligma', now, read({ skulled: false }));
        const hp = new Map([[1, 0.3], [2, 0.9]]);
        const pick = () => pickSquadFocus({ view, targets: new Set(['goondelf', 'ligma']), health: p => hp.get(p.index)!, skip: new Set(w.skipped(view.map(v => v.name), now)) })?.name;
        expect(pick()).toBeUndefined();
        w.attacked('Ligma', now);
        expect(pick()).toBe('Ligma');
        w.attacked('Goondelf', now);
        expect(pick()).toBe('Goondelf');
    });
});

describe('rule b: kill timing', () => {
    test('a skulled account with its overhead off for K reads in combat counts as drained; an overhead read resets it', () => {
        const w = createDaggerWatch(on);
        for (let t = 1; t <= 2; t++) w.read('Goondelf', t, read({ skulled: true, overhead: false }));
        expect(w.drained('goondelf')).toBe(false);
        w.read('Goondelf', 3, read({ skulled: true, overhead: false }));
        expect(w.drained('goondelf')).toBe(true);
        w.read('Goondelf', 4, read({ skulled: true, overhead: true }));
        expect(w.drained('goondelf')).toBe(false);
    });
    test('reads out of combat do not count, two members in one tick count once, and an overhead in either read wins', () => {
        const w = createDaggerWatch(on);
        w.read('Ligma', 1, read({ skulled: true, overhead: false, inCombat: false }));
        w.read('Ligma', 2, read({ skulled: true, overhead: false }));
        w.read('Ligma', 2, read({ skulled: true, overhead: false }));
        w.read('Ligma', 3, read({ skulled: true, overhead: false }));
        expect(w.snapshot('ligma')?.offReads).toBe(2);
        w.read('Ligma', 4, read({ skulled: true, overhead: false }));
        expect(w.drained('ligma')).toBe(true);
        w.read('Ligma', 5, read({ skulled: true, overhead: false }));
        w.read('Ligma', 5, read({ skulled: true, overhead: true }));
        expect(w.drained('ligma')).toBe(false);
        expect(w.snapshot('ligma')?.offReads).toBe(0);
    });
    test('an unskulled account with no overhead is not drained: its death keeps the dagger', () => {
        const w = createDaggerWatch(on);
        for (let t = 1; t <= 5; t++) w.read('Sugma', t, read({ skulled: false, overhead: false }));
        expect(w.drained('sugma')).toBe(false);
    });
    test('the target choice takes a drained account first, before one with a lower health bar', () => {
        const w = createDaggerWatch(on);
        const view = [{ name: 'Goondelf', index: 1, distance: 2 }, { name: 'Ligma', index: 2, distance: 2 }];
        for (let t = 1; t <= 3; t++) { w.read('Goondelf', t, read({ skulled: true, overhead: true })); w.read('Ligma', t, read({ skulled: true, overhead: false })); }
        const drained = new Set(view.map(v => v.name.toLowerCase()).filter(n => w.drained(n)));
        const hp = new Map([[1, 0.2], [2, 0.9]]);
        const targets = new Set(['goondelf', 'ligma']);
        expect(pickSquadFocus({ view, targets, health: p => hp.get(p.index)! })?.name).toBe('Goondelf');
        expect(pickSquadFocus({ view, targets, health: p => hp.get(p.index)!, priority: drained })?.name).toBe('Ligma');
    });
    test('the hold: a skulled account with its overhead on is held from its first read at or below the fraction, for the cap or until the overhead goes', () => {
        const w = createDaggerWatch({ offReads: 3, holdBelow: 0.5, holdTicks: 100 });
        w.read('Goondelf', 10, read({ skulled: true, hp: 0.6 }));
        expect(w.held('goondelf', 10)).toBe(false);
        w.read('Goondelf', 12, read({ skulled: true, hp: 0.5 }));
        expect(w.held('goondelf', 12)).toBe(true);
        // The bar of a later read (it ate) does not end the hold.
        w.read('Goondelf', 40, read({ skulled: true, hp: 0.8 }));
        expect(w.held('goondelf', 40)).toBe(true);
        expect(w.skipped(['Goondelf'], 40)).toEqual(['goondelf']);
        expect(w.held('goondelf', 112)).toBe(false);
        // The overhead off ends the hold at once.
        const v = createDaggerWatch({ offReads: 3, holdBelow: 0.5, holdTicks: 100 });
        v.read('Ligma', 10, read({ skulled: true, hp: 0.4 }));
        expect(v.held('ligma', 11)).toBe(true);
        v.read('Ligma', 12, read({ skulled: true, overhead: false, hp: 0.4 }));
        expect(v.held('ligma', 12)).toBe(false);
        // No hold for an unskulled account, and none with the hold off.
        const u = createDaggerWatch({ offReads: 3, holdBelow: 0.5, holdTicks: 100 });
        u.read('Sugma', 10, read({ skulled: false, hp: 0.3 }));
        expect(u.held('sugma', 10)).toBe(false);
        const off = createDaggerWatch(on);
        off.read('Sugma', 10, read({ skulled: true, hp: 0.3 }));
        expect(off.held('sugma', 10)).toBe(false);
    });
    test('the drain of the gang: a fight with Protect Item, Steel Skin and an overhead empties 99 points in 315 ticks', () => {
        expect(drainTicks(99, 2 + 12 + 12, 6 + 5)).toBe(315);
        expect(drainTicks(90, 2 + 12 + 12, 6 + 5)).toBe(285);
        expect(drainTicks(10, 0, 11)).toBe(Infinity);
    });
});

describe('the hold ends the attack click', () => {
    test('cancelAttack walks the member to its own tile, as the kill path of the fight loop does', () => {
        const walks: [number, number][] = [];
        const s = { sdk: { getState: () => ({ player: { worldX: 3067, worldZ: 3640 } }), sendWalk: (x: number, z: number) => { walks.push([x, z]); } } };
        expect(cancelAttack(s)).toBe(true);
        expect(walks).toEqual([[3067, 3640]]);
        expect(cancelAttack({ sdk: { getState: () => ({ player: null }), sendWalk: () => { walks.push([0, 0]); } } })).toBe(false);
        expect(walks).toHaveLength(1);
    });
});

describe('rule b: the switch to a drained target uses the filters of the target choice', () => {
    // Our member (client index 3) fights Goondelf; Ligma shows 0 prayer points.
    const watch = createDaggerWatch(on);
    for (let t = 1; t <= 3; t++) { watch.read('Goondelf', t, read({ skulled: true })); watch.read('Ligma', t, read({ skulled: true, overhead: false })); }
    const targets = new Set(['goondelf', 'ligma']);
    const me = { x: 3078, z: 3641, combatLevel: 110 };
    const ligma = { name: 'Ligma', index: 2, distance: 1, x: 3078, z: 3640, combatLevel: 126 };
    const goon = { name: 'Goondelf', index: 1, distance: 1, x: 3079, z: 3641, combatLevel: 126 };
    const sw = (view: (typeof ligma & { inCombat?: boolean; combatTargetType?: string; combatTargetIndex?: number })[], o: { skip?: Set<string>; inMulti: boolean; meAt?: { x: number; z: number } }) =>
        drainedSwitch({ current: 'Goondelf', watch, targets, focus: { view, health: () => 0.5, skip: o.skip, me: { ...me, ...(o.meAt ?? {}) }, inMulti: o.inMulti, selfIndex: 3 } })?.name;
    test('single-way: a drained target that fights another member is no switch (pickSquadFocus engagedByOther)', () => {
        expect(sw([goon, { ...ligma, inCombat: true, combatTargetType: 'player', combatTargetIndex: 7 }], { inMulti: false })).toBeUndefined();
        expect(sw([goon, { ...ligma, inCombat: true, combatTargetType: 'player', combatTargetIndex: 3 }], { inMulti: false })).toBe('Ligma');
    });
    test('multi-way: the same drained target is a switch; one in the skip set is not; a drained current target keeps its fight', () => {
        const multi = { ...ligma, x: 3067, z: 3640, inCombat: true, combatTargetType: 'player', combatTargetIndex: 7 };
        expect(sw([{ ...goon, x: 3068, z: 3641 }, multi], { inMulti: true, meAt: { x: 3067, z: 3641 } })).toBe('Ligma');
        expect(sw([{ ...goon, x: 3068, z: 3641 }, multi], { inMulti: true, meAt: { x: 3067, z: 3641 }, skip: new Set(['ligma']) })).toBeUndefined();
        expect(drainedSwitch({ current: 'Ligma', watch, targets, focus: { view: [goon, multi], health: () => 0.5, me, inMulti: true } })).toBeUndefined();
    });
    test('a choice that keeps the current target is no switch: a multi-way target before a drained one on single-way ground', () => {
        // The loop's choice with preferMulti takes Goondelf on multi-way ground before Ligma on single-way ground, so a
        // switch to Ligma would stop the fight and the loop would start it again on Goondelf.
        const goonMulti = { ...goon, x: 3068, z: 3641 };
        const focus = { view: [goonMulti, ligma], health: () => 0.5, me: { ...me, x: 3067, z: 3641 }, inMulti: true, selfIndex: 3 };
        expect(pickSquadFocus({ ...focus, targets, priority: new Set(['ligma']), preferMulti: true })?.name).toBe('Goondelf');
        expect(drainedSwitch({ current: 'Goondelf', watch, targets, focus: { ...focus, preferMulti: true } })).toBeUndefined();
        // With no multi-way preference the drained target comes first, and the switch goes to it.
        expect(drainedSwitch({ current: 'Goondelf', watch, targets, focus: { ...focus, preferMulti: false } })?.name).toBe('Ligma');
    });
});

describe('rule c: the pickup of a kill', () => {
    test('a dagger lifts the skip for single-way ground and interlopers; an escape and a pickup that is off stay skipped', () => {
        expect(daggerPickup(null)).toBe('all');
        expect(daggerPickup('single-way')).toBe('daggers');
        expect(daggerPickup('2 interlopers')).toBe('daggers');
        expect(daggerPickup('escape')).toBe('skip');
        expect(daggerPickup('off')).toBe('skip');
        expect([...DAGGER_IDS].sort()).toEqual([1215, 1231]);
    });
});

describe('the bench drain of SQUAD_GANG_PRAYER', () => {
    test('the drain prayers are 50 effects a tick of the timer and none turns another off', () => {
        const root = contentRoot();
        const section = readFileSync(join(root, 'scripts/skill_prayer/configs/prayers.enum'), 'utf8').split('[prayer_drain_effects]')[1]!.split('[')[0]!;
        const effects = new Map([...section.matchAll(/^val=\^prayer_(\w+),(\d+)\r?$/gm)].map(m => [m[1]!, Number(m[2])]));
        const names: Record<number, string> = { [PRAYER.steelSkin]: 'steelskin', [PRAYER.ultimateStrength]: 'ultimatestrength', [PRAYER.incredibleReflexes]: 'incrediblereflexes', [PRAYER.melee]: 'protectfrommelee', [PRAYER.item]: 'protectitems' };
        expect(GANG_DRAIN_PRAYERS.reduce((n, p) => n + effects.get(names[p]!)!, 0)).toBe(50);
        const dbrow = readFileSync(join(root, 'scripts/skill_prayer/configs/prayers.dbrow'), 'utf8');
        for (const p of GANG_DRAIN_PRAYERS) {
            const row = dbrow.match(new RegExp(`data=prayer,\\^prayer_${names[p]}\\r?\\n([^\\[]*)`))?.[1] ?? null;
            expect(row).not.toBeNull();
            if (row === null) continue;
            for (const q of GANG_DRAIN_PRAYERS) if (q !== p) expect(row.includes(`prayer_deactivate,^prayer_${names[q]}`)).toBe(false);
        }
    });
});
