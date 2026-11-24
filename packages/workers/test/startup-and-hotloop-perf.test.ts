import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { objPackIdSet, packMap, parsePackNameToId } from '../src/bank-artisan/catalog';
import { cookingRecipes } from '../src/bank-artisan/cooking';
import { HERBLORE_SPECIALIST_KIT, MAGIC_SPECIALIST_KIT } from '../src/logistics/specialist-supply';
import {
    ITEMS,
    SPELLS,
    bestFood,
    canCastChargeNow,
    castableFreeze,
    dangerReason,
    escapeCastable,
    getObjNames,
    isMulti,
    newSplats,
} from '../src/pvp/fight';
import { nativePvpSpell, validatePvpPlan } from '../src/pvp/microbot-pvp';
import { ThreatWatch, refineProtectActions } from '../src/pvp/pk-threat';
import { presetConfig, questPresetKeys, registerQuestPresets } from '../src/quest/presets';
import { Spells } from '../../../vendor/rs-sdk/sdk/spells';
import { retainedRecoveryTasks } from '../../../scripts/cloud-recover';
import type { Member, ThreatClass } from '../../core/src/pvp-threat';

const tempDirs: string[] = [];
afterEach(() => {
    registerQuestPresets(null);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

test('pvp/fight hot-loop helpers preserve food, danger, multi-way, splat, and spell semantics', () => {
    const foodInv = [
        { name: 'Rune platebody', optionsWithIndex: [{ text: 'Wear' }] },
        { name: 'Trout', optionsWithIndex: [{ text: 'Eat' }] },
        { name: 'Mystery cake', optionsWithIndex: [{ text: 'Use' }, { text: 'Eat' }] },
        { name: 'Shark', optionsWithIndex: [{ text: 'Eat' }] },
    ];
    expect(bestFood(foodInv)?.name).toBe('Shark');
    expect(bestFood(foodInv.slice(0, 3))?.name).toBe('Trout');
    expect(bestFood([foodInv[2]!])?.name).toBe('Mystery cake');
    expect(bestFood([foodInv[0]!])).toBeUndefined();

    expect(
        dangerReason({ hp: 20, maxHp: 99, food: false, prayer: 50, oppMax: 20, hits: [], dealt: [], now: 100 }),
    ).toBe('no food at HP 20');
    expect(
        dangerReason({
            hp: 90,
            maxHp: 99,
            food: true,
            prayer: 50,
            oppMax: 20,
            hits: [
                { tick: 95, damage: 5, src: 2 },
                { tick: 96, damage: 4, src: 3 },
                { tick: 97, damage: 2, src: 4 },
            ],
            dealt: [],
            now: 100,
        }),
    ).toBe('3 players hitting');
    expect(
        dangerReason({
            hp: 45,
            maxHp: 99,
            food: true,
            prayer: 50,
            oppMax: 20,
            hits: [{ tick: 90, damage: 32, src: 2 }],
            dealt: [{ tick: 90, damage: 10 }],
            now: 100,
        }),
    ).toBe('losing the race: took 32, dealt 10');
    expect(
        dangerReason({ hp: 40, maxHp: 99, food: true, prayer: 0, oppMax: 20, hits: [], dealt: [], now: 100 }),
    ).toBe('no prayer points');
    expect(
        dangerReason({ hp: 90, maxHp: 99, food: true, prayer: 50, oppMax: 20, hits: [{ tick: 99, damage: 5, src: 1 }], dealt: [], now: 100 }),
    ).toBeNull();

    expect(
        castableFreeze(85, [
            { id: ITEMS.earthRune, count: 5 },
            { id: ITEMS.waterRune, count: 5 },
            { id: ITEMS.natureRune, count: 4 },
        ]),
    ).toBe(SPELLS.entangle);
    expect(
        castableFreeze(85, [
            { id: ITEMS.earthRune, count: 4 },
            { id: ITEMS.waterRune, count: 4 },
            { id: ITEMS.natureRune, count: 3 },
        ]),
    ).toBe(SPELLS.snare);
    expect(
        castableFreeze(45, [
            { id: ITEMS.earthRune, count: 3 },
            { id: ITEMS.waterRune, count: 3 },
            { id: ITEMS.natureRune, count: 2 },
        ]),
    ).toBe(SPELLS.bind);

    expect(
        canCastChargeNow(
            80,
            [
                { id: ITEMS.fireRune, count: 3 },
                { id: ITEMS.bloodRune, count: 3 },
                { id: ITEMS.airRune, count: 3 },
            ],
            0,
        ),
    ).toBe(true);
    expect(
        canCastChargeNow(
            80,
            [
                { id: ITEMS.fireRune, count: 3 },
                { id: ITEMS.bloodRune, count: 3 },
                { id: ITEMS.airRune, count: 3 },
            ],
            12,
        ),
    ).toBe(false);
    expect(
        escapeCastable(
            Spells.VARROCK_TELEPORT,
            [
                { id: ITEMS.fireRune, count: 1 },
                { id: ITEMS.airRune, count: 3 },
                { id: ITEMS.lawRune, count: 1 },
            ],
            [],
            25,
        ),
    ).toBe(true);
    expect(escapeCastable(Spells.VARROCK_TELEPORT, [], [], 25)).toBe(false);

    const splatSeen: { cycles: number[] | null } = { cycles: null };
    const client = { players: [null, { damageCycles: [1, 0, 0, 0], damageValues: [12, 0, 0, 0] }] };
    expect(newSplats(client, 1, splatSeen)).toEqual([]);
    client.players[1] = { damageCycles: [1, 5, 0, 0], damageValues: [12, 24, 0, 0] };
    expect(newSplats(client, 1, splatSeen)).toEqual([24]);
    expect(newSplats(client, 2, splatSeen)).toBeNull();

    const customRoot = makeTempDir('multi-root-');
    mkdirSync(join(customRoot, 'vendor/rs-sdk/server/content/maps'), { recursive: true });
    writeFileSync(join(customRoot, 'vendor/rs-sdk/server/content/maps/multiway.csv'), '// comment\n0_50_50_8_16\n1_50_50_0_0\n');
    expect(isMulti((50 << 6) + 8, (50 << 6) + 16, customRoot)).toBe(true);
    expect(isMulti((50 << 6) + 0, (50 << 6) + 0, customRoot)).toBe(false);
    expect(isMulti(3070, 3640)).toBe(true);
    expect(isMulti(3222, 3222)).toBe(false);

    expect(getObjNames().get(ITEMS.shark)).toBe('shark');
});

test('pvp/pk-threat refineProtectActions and ThreatWatch adapt forgetting work across ticks', () => {
    const members: Member[] = [{ name: 'Ours1', x: 3070, z: 3640, combat: 126, prayer: 50, prayerLevel: 99, hp: 99, food: 8 }];
    const farMelee: ThreatClass = {
        record: {
            name: 'MeleeFar',
            combat: 126,
            tick: 10,
            x: 3076,
            z: 3640,
            wild: 16,
            multi: false,
            inView: true,
            worn: { weapon: 1333 },
            protect: [],
            skulled: false,
            nearest: { member: 'Ours1', dist: 6 },
            closing: true,
            speed: 1,
            styles: ['melee'],
            lastAttack: { style: 'melee', tick: 9 },
            weaponStyle: 'melee',
            targeting: null,
        },
        style: 'melee',
        cover: 'melee',
        by: 'attack',
        canHit: ['Ours1'],
        dangerous: true,
    };
    const closeMage: ThreatClass = {
        ...farMelee,
        record: {
            ...farMelee.record,
            name: 'MageTarget',
            x: 3074,
            worn: { weapon: 4675 },
            styles: ['magic'],
            lastAttack: { style: 'magic', tick: 10 },
            weaponStyle: 'magic',
            targeting: 'Ours1',
        },
        style: 'magic',
        cover: 'magic',
    };
    const refined = refineProtectActions(
        [farMelee, closeMage],
        members,
        [
            { kind: 'protect', member: 'Ours1', style: 'melee', reason: 'initial' },
            { kind: 'kit', member: 'Ours1', style: 'melee', wear: [1127], gain: 20, reason: 'old' },
        ],
        () => ({ wear: [2503], gain: 18 }),
    );
    expect(refined).toEqual([
        { kind: 'protect', member: 'Ours1', style: 'magic', reason: 'MageTarget magic by attack, 4 tiles' },
        { kind: 'kit', member: 'Ours1', style: 'magic', wear: [2503], gain: 18, reason: 'MageTarget magic: wear 2503 (+18)' },
    ]);

    let visible = true;
    const logs: string[] = [];
    const session = {
        name: 'Ours1',
        client: {
            localPlayer: null as unknown,
            players: [
                null,
                { name: 'Ours1' },
                { name: 'Rival', appearance: [], headicons: 0, primaryAnim: -1, spotanimId: -1 },
            ],
        },
        sdk: {
            getState: () => ({
                player: { name: 'Ours1', worldX: 3070, worldZ: 3640, combatLevel: 126, isDead: false, hp: 99 },
                nearbyPlayers: visible
                    ? [{ index: 2, name: 'Rival', combatLevel: 126, x: 3073, z: 3640, distance: 3 }]
                    : [],
                prayers: { activePrayers: [], prayerPoints: 50 },
            }),
            getEquipment: () => [],
            getInventory: () => [],
            getSkill: () => ({ level: 99 }),
        },
    };
    (session.client as { localPlayer: unknown }).localPlayer = session.client.players[1];
    const watch = new ThreatWatch({
        sessions: () => [session as never],
        server: 'demo.example:43594',
        friends: new Set(['ours1']),
        log: line => logs.push(line),
        recordRoot: false,
    });
    watch.step(1);
    expect(logs.filter(l => l.startsWith('ADAPT protect')).length).toBe(1);
    watch.step(2);
    expect(logs.filter(l => l.startsWith('ADAPT protect')).length).toBe(1);
    visible = false;
    watch.step(3);
    visible = true;
    watch.step(4);
    expect(logs.filter(l => l.startsWith('ADAPT protect')).length).toBe(2);
});

test('lazy catalog, cooking, presets, specialist kits, and microbot-pvp preserve contracts', () => {
    const parsed = parsePackNameToId('1=first\r\n2=second\nbad\n3=third\n');
    expect(parsed.get('first')).toBe(1);
    expect(parsed.get('second')).toBe(2);
    expect(parsed.get('third')).toBe(3);

    expect(packMap('obj').get('shark')).toBe(385);
    expect(objPackIdSet().has(385)).toBe(true);
    expect(cookingRecipes().recipes.length).toBeGreaterThan(20);

    const keys = questPresetKeys();
    expect(keys.length).toBeGreaterThan(0);
    const firstKey = keys[0]!;
    expect(presetConfig(firstKey)).toBeDefined();
    registerQuestPresets({ [firstKey]: { quest: 'custom-override' } as never });
    expect(presetConfig(firstKey)).toEqual({ quest: 'custom-override' } as never);

    expect(HERBLORE_SPECIALIST_KIT.some(i => i.id === 221 && i.name === 'Eye of newt')).toBe(true);
    expect(MAGIC_SPECIALIST_KIT.some(i => i.id === 385 && i.name === 'Shark')).toBe(true);

    expect(nativePvpSpell('fire_wave').maximum).toBeGreaterThan(0);
    expect(validatePvpPlan({ cap: 10, hpFloor: 50, steps: [{ kind: 'tank' }] }).cap).toBe(10);
});

test('cloud-recover retainedRecoveryTasks deduplicates archive, keeps current order, and sees archive updates', () => {
    const root = makeTempDir('recover-archive-');
    const archiveDir = join(root, '.practice/coordinator/archive');
    mkdirSync(archiveDir, { recursive: true });
    const archive = join(archiveDir, 'tasks.jsonl');

    const failedTask = {
        status: 'failed',
        runId: 'run-1',
        receipt: { ok: false, error: 'boom' },
        spec: { id: 'recover-1', kind: 'run', capability: 'session-recovery-only' },
    };
    const runningTask = {
        status: 'running',
        runId: 'run-1',
        spec: { id: 'recover-1', kind: 'run', capability: 'session-recovery-only' },
    };
    const currentTask = {
        status: 'pending',
        createdAt: 123,
        spec: { id: 'recover-2', kind: 'qualify', capability: 'session-recovery-only' },
    };

    writeFileSync(archive, JSON.stringify(failedTask) + '\n');
    const out1 = retainedRecoveryTasks(root, [runningTask, currentTask]);
    expect(out1.map(t => `${t.spec.id}:${t.status}`)).toEqual(['recover-1:failed', 'recover-2:pending']);

    // Repeat identical archive read (cache hit) preserves output and conflict detection.
    const out2 = retainedRecoveryTasks(root, [runningTask, currentTask]);
    expect(out2.map(t => `${t.spec.id}:${t.status}`)).toEqual(['recover-1:failed', 'recover-2:pending']);
    expect(() =>
        retainedRecoveryTasks(root, [{ ...failedTask, status: 'succeeded' }]),
    ).toThrow('recovery outcome archive conflict');

    // Rewriting archive invalidates cache immediately.
    const secondArchived = {
        status: 'succeeded',
        runId: 'run-2',
        receipt: { ok: true, output: null },
        spec: { id: 'recover-2', kind: 'qualify', capability: 'session-recovery-only' },
    };
    writeFileSync(archive, JSON.stringify(failedTask) + '\n' + JSON.stringify(secondArchived) + '\n');
    const out3 = retainedRecoveryTasks(root, []);
    expect(out3.map(t => `${t.spec.id}:${t.status}`)).toEqual(['recover-1:failed', 'recover-2:succeeded']);
});
