import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateSupplies } from '../packages/core/src/launch-evidence';
import { componentId } from '../packages/core/src/logout';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { withoutJewelry, withoutSpells, withoutTeleports } from '../packages/core/src/walk';
import { observedSupplies } from '../packages/practice/src/specialist-rehearsal';
import { pickCourtyardMagicTarget, RAILING_PROTECT_Z, shouldEnableRailingProtectMelee } from './attack-specialist';
import { parseSpecialistBenchArgs } from './measure/specialist-bench';
import {
    ATTACK_SPECIALIST_KIT,
    assertSupplierAccount,
    countById,
    hasAtLeastKit,
    hasExactKit,
    kitRequirements,
    kitSlotTotal,
    moveGroundTo,
} from '../packages/workers/src/logistics';

const ROOT = resolve(import.meta.dir, '..');
const ITEMS: { id: number; name: string; tradeable?: boolean }[] = JSON.parse(
    readFileSync(join(ROOT, 'knowledge', 'items.json'), 'utf8'),
);

test('ATTACK_SPECIALIST_KIT fills 28 tradeable cataloged inventory slots', () => {
    expect(kitSlotTotal(ATTACK_SPECIALIST_KIT)).toBe(28);
    expect(ATTACK_SPECIALIST_KIT.length).toBe(10);
    const byId = new Map(ITEMS.map(item => [item.id, item]));
    for (const spec of ATTACK_SPECIALIST_KIT) {
        const entry = byId.get(spec.id);
        expect(entry).toBeDefined();
        expect(entry!.tradeable).toBe(true);
        expect(entry!.name).toBe(spec.name);
    }
    const exactInv = ATTACK_SPECIALIST_KIT.flatMap(spec =>
        spec.stackable
            ? [{ id: spec.id, count: spec.count }]
            : Array.from({ length: spec.count }, () => ({ id: spec.id, count: 1 })),
    );
    expect(exactInv.length).toBe(28);
    expect(hasExactKit(exactInv)).toBe(true);
    expect(hasAtLeastKit([...exactInv, { id: 556, count: 25 }, { id: 558, count: 15 }])).toBe(true);
    expect(countById(exactInv, 556)).toBe(1300);
});

test('spell components resolve in pinned interface.pack', () => {
    for (const key of ['magic:wind_strike', 'magic:fire_strike', 'magic:varrock_teleport', 'magic:camelot_teleport']) {
        expect(componentId(key)).toBeGreaterThan(0);
    }
});

test('assertSupplierAccount rejects reserved specialists and accepts ordinary accounts', () => {
    for (const reserved of RESERVED_ACCOUNTS) {
        expect(() => assertSupplierAccount(reserved)).toThrow('reserved');
        expect(() => assertSupplierAccount(reserved.toUpperCase())).toThrow('reserved');
    }
    expect(() => assertSupplierAccount('')).toThrow('invalid');
    expect(() => assertSupplierAccount('too_long_account_name')).toThrow('invalid');
    expect(assertSupplierAccount('Moneyshot')).toBe('Moneyshot');
});

test('observedSupplies and validateSupplies round-trip for ATTACK_SPECIALIST_KIT', () => {
    const ledger = JSON.stringify({
        tick: 100,
        from: 'spatk',
        to: 'hiltsdeep',
        fromItems: ATTACK_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
        toItems: [],
    });
    const observed = observedSupplies(ledger + '\n', 'hiltsdeep', ITEMS);
    expect(observed).toEqual(kitRequirements(ATTACK_SPECIALIST_KIT));

    const now = 1_000_000;
    const context = 'a'.repeat(64);
    const refs = new Map<string, any>([
        ['bank', { name: 'Moneyshot', server: 'rs-sdk-demo.fly.dev', bankAt: now - 1000, bank: ATTACK_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })) }],
        [
            'delivery',
            {
                ok: true,
                observed: true,
                server: 'rs-sdk-demo.fly.dev',
                from: 'Helper',
                to: 'Moneyshot',
                at: now - 2000,
                before: [],
                after: ATTACK_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
                items: ATTACK_SPECIALIST_KIT.map(k => ({ id: k.id, count: k.count })),
            },
        ],
    ]);
    const manifest = {
        version: 2,
        context,
        at: now - 1000,
        allocations: observed.map(req => ({
            item: req.item,
            itemId: req.itemId,
            count: req.count,
            holder: 'Moneyshot',
            recipient: 'hiltsdeep',
            bank: { path: 'bank' },
            delivery: { path: 'delivery' },
        })),
    };
    expect(() => validateSupplies(manifest, context, observed, ITEMS, ['Helper', 'Moneyshot'], now, ref => refs.get(ref.path), 'hiltsdeep')).not.toThrow();
});

test('pickCourtyardMagicTarget prioritizes engaged attackers and ignores busy others', () => {
    const zoneOk = (x: number, z: number) => x >= 3217 && x <= 3225 && z >= 3210 && z <= 3229;
    const atkOp = [{ text: 'Attack' }];
    const attackerOutOfZone = { index: 2836, name: 'Man', tileX: 3227, tileZ: 3221, distance: 5, inCombat: true, targetIndex: 32768 + 4, optionsWithIndex: atkOp };
    const nearbyRat = { index: 2837, name: 'Rat', tileX: 3222, tileZ: 3222, distance: 1, inCombat: false, optionsWithIndex: atkOp };
    const busyOther = { index: 2838, name: 'Man', tileX: 3222, tileZ: 3221, distance: 1, inCombat: true, targetIndex: 32768 + 9, optionsWithIndex: atkOp };

    expect(pickCourtyardMagicTarget([nearbyRat, attackerOutOfZone], {
        selfSlot: 4,
        engagedTargetIndex: null,
        activeTargetIndex: 2837,
        avoid: new Set([2836]),
        zoneOk,
    })?.index).toBe(2836);

    expect(pickCourtyardMagicTarget([nearbyRat, busyOther], {
        selfSlot: 4,
        engagedTargetIndex: 2838,
        activeTargetIndex: 2837,
        avoid: new Set([2838]),
        zoneOk,
    })?.index).toBe(2838);

    const nearbyMan = { index: 2839, name: 'Man', tileX: 3223, tileZ: 3220, distance: 3, inCombat: false, optionsWithIndex: atkOp };
    expect(pickCourtyardMagicTarget([busyOther, nearbyRat, nearbyMan], {
        selfSlot: 4,
        engagedTargetIndex: null,
        activeTargetIndex: null,
        avoid: new Set(),
        zoneOk,
    })?.index).toBe(2839);
});

test('shouldEnableRailingProtectMelee enables Protect from Melee once crossing worldZ <= 3255', () => {
    expect(RAILING_PROTECT_Z).toBe(3255);
    expect(shouldEnableRailingProtectMelee({ worldZ: 3260 }, Array(15).fill(false))).toBe(false);
    expect(shouldEnableRailingProtectMelee({ worldZ: 3255 }, Array(15).fill(false))).toBe(true);
    expect(shouldEnableRailingProtectMelee({ worldZ: 3188 }, Array(15).fill(false))).toBe(true);
    const active = Array(15).fill(false);
    active[14] = true;
    expect(shouldEnableRailingProtectMelee({ worldZ: 3188 }, active)).toBe(false);
});

test('parseSpecialistBenchArgs splits child env overrides from positional specialist args', () => {
    const plan = parseSpecialistBenchArgs(
        ['aiobf1', 'aiobf1s', 'scripts/attack-specialist.ts', '5000', 'LOOT_WATCH=0', 'PRAYER_GUARD=0', 'EAT_GUARD=0'],
        ROOT,
    );
    expect(plan).toEqual({
        bot: 'aiobf1',
        supplier: 'aiobf1s',
        specialistScript: 'scripts/attack-specialist.ts',
        supplierScript: 'scripts/aio-logistics.ts',
        supplierRole: 'specialist-supplier',
        specialistArgs: ['5000'],
        childEnv: { LOOT_WATCH: '0', PRAYER_GUARD: '0', EAT_GUARD: '0' },
    });
    expect(() => parseSpecialistBenchArgs(['a', 'b', 'scripts/does-not-exist.ts'], ROOT)).toThrow(/missing script/);
});

test('moveGroundTo exists and withoutSpells strips lawrune so full-kit suppliers never stop at banks for teleport runes', () => {
    expect(typeof moveGroundTo).toBe('function');
    const stripped = withoutSpells({
        skills: {},
        quests: [],
        items: ['lawrune', 'airrune', 'staffoffire'],
        counts: { lawrune: 30, airrune: 1300 },
        coins: 200,
    } as any);
    expect(stripped.items).toEqual(['airrune', 'staffoffire']);
    expect(stripped.counts?.lawrune).toBe(0);
});

test('withoutJewelry and withoutTeleports strip charged teleport jewelry while leaving withoutSpells unchanged', () => {
    const account = {
        skills: {},
        quests: [],
        items: ['lawrune', 'amulet_of_glory_4', 'ring_of_dueling_8', 'games_necklace_8', 'staffoffire'],
        counts: { lawrune: 30, amulet_of_glory_4: 1, ring_of_dueling_8: 1, games_necklace_8: 1, staffoffire: 1 },
        coins: 200,
    } as any;
    expect(withoutSpells(account).items).toEqual(['amulet_of_glory_4', 'ring_of_dueling_8', 'games_necklace_8', 'staffoffire']);
    const noJewel = withoutJewelry(account);
    expect(noJewel.items).toEqual(['lawrune', 'staffoffire']);
    expect(noJewel.counts?.amulet_of_glory_4).toBe(0);
    expect(noJewel.counts?.ring_of_dueling_8).toBe(0);
    expect(noJewel.counts?.games_necklace_8).toBe(0);
    expect(noJewel.counts?.lawrune).toBe(30);
    const noTp = withoutTeleports(account);
    expect(noTp.items).toEqual(['staffoffire']);
    expect(noTp.counts?.lawrune).toBe(0);
    expect(noTp.counts?.amulet_of_glory_4).toBe(0);
});
