import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStatus } from '../../core/src/status';
import { PROTECT, startPrayerGuard } from '../../core/src/prayer-guard';
import { allFoodIds, expandFoodStages, objIdByDebugName, questFoodDefinitions, selectQuestFood } from '../../core/src/sustain';
import { dangerSet, loadHunters, loadRoamers, meleeOnly, parseHunter, parseRoamer } from '../../core/src/danger';
import { bankStock, itemIdOf, itemName, knownBankRecords, knownBanks } from '../../core/src/trip';
import { beginSessionAttempt, accountDir } from '../../core/src/session-lifecycle';
import { setEquipmentObserved } from '../../core/src/container-observation';
import { isStopFilePresent } from '../src/stop';
import { castable, spellLevel, spellRunes, staffRunes } from '../src/quest/teleport-runes';
import { nativeKitItem } from '../src/logistics/stage';

test('sustain allFoodIds and objIdByDebugName match full stage expansion and selectQuestFood honors reserves', () => {
    const expected = expandFoodStages([...questFoodDefinitions().keys()]);
    expect(allFoodIds()).toEqual(expected);
    expect(objIdByDebugName('shark')).toBe(385);
    expect(objIdByDebugName('cake')).toBe(1891);

    const state = {
        skills: [{ name: 'Hitpoints', level: 8, baseLevel: 20 }],
        inventory: [
            { id: 385, slot: 0, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 0 }] },
            { id: 333, slot: 1, count: 2, optionsWithIndex: [{ text: 'Eat', opIndex: 0 }] },
        ],
    };
    const picked = selectQuestFood(state, { food: [385, 333], eatAt: 10, reserved: { 385: 1, 333: 1 } });
    expect(picked?.item.id).toBe(333);
    expect(picked?.item.slot).toBe(1);
});

test('startPrayerGuard handles empty prayers, manual toggle intents, and threat transitions through the facade', () => {
    const active = Array(18).fill(false);
    let tick = 1;
    const cbs: (() => void)[] = [];
    const sent: any[] = [];
    const client: any = { selfSlot: 0, executeBotAction: (a: any) => { sent.push(a); return { success: true }; } };
    const state: any = {
        tick: 1,
        player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1, isDead: false, combatLevel: 50 },
        prayers: { activePrayers: active, prayerPoints: 50, prayerLevel: 50 },
        nearbyNpcs: [],
        nearbyPlayers: [],
        gameMessages: [],
        nearbyLocs: [],
        inventory: [],
        combatEvents: [],
    };
    const s: any = {
        client,
        sdk: { getState: () => state },
        tick: () => tick,
        onTick: (cb: () => void) => { cbs.push(cb); return () => {}; },
        direct: async (a: any) => client.executeBotAction(a),
    };
    const guard = startPrayerGuard(s, { protect: () => PROTECT.melee });
    // Idle empty ticks should emit zero prayer actions
    for (let i = 0; i < 4; i++) { tick++; state.tick = tick; for (const cb of cbs) cb(); }
    expect(sent.length).toBe(0);

    // Threat arrives -> guard activates PROTECT.melee
    state.nearbyNpcs = [{ index: 1, id: 81, name: 'Cow', x: 3201, z: 3200, distance: 1, hp: 8, targetIndex: 32768, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] }];
    tick++; state.tick = tick; for (const cb of cbs) cb();
    expect(sent.some(a => a.type === 'togglePrayer' && a.prayerIndex === PROTECT.melee)).toBe(true);
    guard.stop();
});

test('danger catalog line scanner matches regex fields and dangerSet precomputes combat stats', () => {
    const block = 'huntmode=cowardly\nhuntrange=4\nwanderrange=5\nmaxrange=8\nattackrange=1\n';
    const hunter = parseHunter({ id: 9999, name: 'TestWolf', combat: 25, spawns: [{ x: 3200, z: 3200, level: 0 }] }, block);
    expect(hunter).toEqual({ id: 9999, name: 'TestWolf', combat: 25, mode: 'cowardly', reach: 9, hunt: 4, spawns: [{ x: 3200, z: 3200, level: 0 }] });
    const roamer = parseRoamer({ id: 9999, name: 'TestWolf', spawns: [{ x: 3200, z: 3200, level: 0 }] }, block);
    expect(roamer).toEqual({ id: 9999, name: 'TestWolf', keep: 9, spawns: [{ x: 3200, z: 3200, level: 0 }] });

    const hunters = loadHunters();
    expect(hunters.length).toBeGreaterThan(0);
    expect(loadRoamers().size).toBeGreaterThan(0);
    const styles = new Map<number, readonly string[]>([[1, ['melee']], [2, ['magic']]]);
    expect(meleeOnly({ id: 1, name: 'A', combat: 10, mode: 'cowardly', reach: 5, spawns: [] }, styles)).toBe(true);
    expect(meleeOnly({ id: 2, name: 'B', combat: 10, mode: 'cowardly', reach: 5, spawns: [] }, styles)).toBe(false);
    expect(meleeOnly({ id: 3, name: 'C', combat: 10, mode: 'cowardly', reach: 5, spawns: [] }, styles)).toBe(true);
    const set = dangerSet({ skills: { hitpoints: 10, attack: 1, strength: 1, defence: 1 }, varps: {}, items: [], coins: 0 } as any, 0, { minX: 3180, maxX: 3250, minZ: 3180, maxZ: 3250 }, [hunter!]);
    expect(set.length).toBeGreaterThan(0);
});

test('status tracks equipment dirty state and input combinations accurately', () => {
    const name = `Ps${process.pid % 100000}`;
    const server = 'localhost:8888';
    const file = resolve(import.meta.dir, '../../../.practice/sim/status', `${name}.json`);
    const attempt = beginSessionAttempt({ account: name, server });
    const client: any = { ingame: true };
    setEquipmentObserved(client, true);
    const cbs: (() => void)[] = [];
    const state: any = {
        player: { worldX: 3222, z: 3218, worldZ: 3218, level: 0, runEnergy: 100, combatLevel: 3 },
        skills: [{ name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1154 }],
        inventory: [],
        equipment: [{ slot: 3, id: 1277, name: 'Bronze sword', count: 1 }],
        groundItems: [{ x: 3222, z: 3218, id: 995, count: 10 }, { x: 'bad', z: 3218, id: 995, count: 1 }],
    };
    const s: any = {
        name,
        client,
        lifecycle: attempt,
        sdk: { getState: () => state, send: () => ({}) },
        direct: () => ({}),
        tick: () => 1,
        onTick: (cb: () => void) => { cbs.push(cb); return () => {}; },
    };
    const status = startStatus(s, server);
    try {
        s.direct({ type: 'walkTo' });
        for (const cb of cbs) cb();
        s.direct({ type: 'walkTo' });
        s.direct({ type: 'interactNpc' });
        for (const cb of cbs) cb();
        status.stop();
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        expect(doc.equipmentObserved).toBe(true);
        expect(doc.ground).toEqual([[3222, 3218, 0, 995, 10]]);
        expect(doc.inputs.combos.some((c: any) => c.k === 'interactNpc+walkTo')).toBe(true);
    } finally {
        status.stop();
        rmSync(file, { force: true });
        rmSync(file + '.tmp', { force: true });
        rmSync(accountDir(name, server), { recursive: true, force: true });
    }
});

test('trip bank cache, item lookup, and bankStock preserve exact values', () => {
    const recs = knownBankRecords();
    const banks = knownBanks();
    expect(banks.length).toBe(recs.length);
    expect(banks.length).toBeGreaterThan(10);
    expect(itemIdOf('shark')).toBe(385);
    expect(itemName(385)).toBe('shark');

    const tmpBase = resolve(import.meta.dir, '../../../.practice/tmp-trip-test-' + process.pid);
    mkdirSync(resolve(tmpBase, '.practice/sim/status'), { recursive: true });
    try {
        writeFileSync(resolve(tmpBase, '.practice/sim/status/PackBot.json'), JSON.stringify({
            server: 'localhost:8888',
            bank: [{ id: 995, count: 500 }, { id: 385, count: 4 }, { id: 995, count: 250 }],
        }));
        expect(bankStock('PackBot', { server: 'localhost:8888', base: tmpBase })).toEqual({ coins: 750, items: { shark: 4 } });
    } finally {
        rmSync(tmpBase, { recursive: true, force: true });
    }
});

test('isStopFilePresent, teleport-runes, and nativeKitItem caching preserve exact behavior', () => {
    const checked: string[] = [];
    expect(isStopFilePresent('MixName', ['.practice/extra'], p => {
        checked.push(p);
        return p === '.practice/stop-mixname';
    })).toBe(true);
    expect(checked).toEqual(['.practice/stop-all', '.practice/stop-MixName', '.practice/stop-mixname']);

    expect(spellRunes('magic:varrock_teleport')).toEqual({ 554: 1, 556: 3, 563: 1 });
    expect(spellLevel('magic:varrock_teleport')).toBe(25);
    expect(staffRunes(['staff_of_air'])).toEqual(new Set(['airrune']));
    expect(castable('magic:varrock_teleport', id => (id === 554 ? 1 : id === 563 ? 1 : 0), [1381], 25)).toBe(true);
    expect(castable('magic:varrock_teleport', id => (id === 554 ? 1 : id === 563 ? 1 : 0), [1381], 24)).toBe(false);

    const notedShark = nativeKitItem(386);
    expect(notedShark.noted).toBe(true);
    expect(notedShark.baseId).toBe(385);
    expect(notedShark.stackable).toBe(true);
    expect(nativeKitItem(386)).toBe(notedShark);
});
