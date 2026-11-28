import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../../core/src/inprocess';
import {
    assessZeroRiskKit,
    BIS_SWITCH_GEAR,
    createNeverSkullGuard,
    deathRisk,
    dhideTierOf,
    ENEMY_WEAPON_IDS,
    enforceZeroRiskGear,
    evaluateSpecPlan,
    fightPlayer,
    isCombatAttackAnim,
    itemCostOf,
    ITEMS,
    neverSkullOf,
    observeProvocations,
    postLootBankDue,
    PRAYER,
    rewearStart,
    RING_OF_RECOIL_ID,
    SPELLS,
    summarizeWeaponLoot,
} from '../src/pvp/fight';
import { kitFrom } from '../src/pvp/wild-rules';
import { createDaggerWatch, inferGearPrayerBonus } from '../src/pvp/squad-dagger';
import { cheapestExpendableSlot, pickUp, PICKUP_ITEMS, plannedPickups } from '../src/pvp/pk-gang';
import { createTeamFocus, maxOverkillAttackers, pickEnemy } from '../src/pvp/pk-team';
import { createSquadFocus } from '../src/pvp/squad';
import { verifyPvpStageSupplies } from '../src/pvp/stage-kit';
import { restock } from '../src/pvp/hunt-kits';
import { pickKit, RULES, type Account, type Gear } from '../../../scripts/squad-ready';

const envOf = (vars: Record<string, string>) => (name: string, fallback: string) => vars[name] ?? fallback;

describe('1. Hard Never-Skull Invariant (pk_skull.rs2)', () => {
    test('neverSkullOf parses 0/1 with configurable default and rejects invalid values', () => {
        expect(neverSkullOf(envOf({}), true)).toBe(true);
        expect(neverSkullOf(envOf({}), false)).toBe(false);
        expect(neverSkullOf(envOf({ NEVER_SKULL: '0' }), true)).toBe(false);
        expect(neverSkullOf(envOf({ NEVER_SKULL: '1' }), false)).toBe(true);
        expect(() => neverSkullOf(envOf({ NEVER_SKULL: 'yes' }), true)).toThrow('NEVER_SKULL must be 0 or 1');
    });

    test('createNeverSkullGuard mirrors exact 3-predator AND 2-prey FIFO eviction (pk_skull.rs2:9-25) and death resets', () => {
        const guard = createNeverSkullGuard({ forgetTicks: 200, selfName: 'BaitBot' });
        expect(guard.canAttackSafely('Goondelf', 10)).toBe(false);

        guard.recordIncomingAttack('Goondelf', 1, 10, 'hit');
        expect(guard.canAttackSafely('goondelf', 10)).toBe(true);
        // Same-tick duplicate observation does not triple-shift predator slots.
        guard.recordIncomingAttack('Goondelf', 1, 10, 'anim');
        guard.recordIncomingAttack('Ligma', 2, 11, 'hit');
        guard.recordIncomingAttack('Sugma', 3, 12, 'anim');
        expect(guard.canAttackSafely('goondelf', 12)).toBe(true);
        expect(guard.canAttackSafely('ligma', 12)).toBe(true);
        expect(guard.canAttackSafely('sugma', 12)).toBe(true);

        // Fourth incoming attack evicts Goondelf from OUR 3-slot predator FIFO,
        // BUT we are STILL in Goondelf's 2-slot prey FIFO (.%pk_prey1 = uid) -> still safe!
        guard.recordIncomingAttack('Fourth', 4, 13, 'hit');
        expect(guard.snapshot().predators).not.toContain('goondelf');
        expect(guard.canAttackSafely('goondelf', 13)).toBe(true);

        // Goondelf hits 1 other ally: we shift to prey2 -> still safe!
        guard.recordEnemyAttackOn('Goondelf', 'Ally1', 14);
        expect(guard.canAttackSafely('goondelf', 14)).toBe(true);

        // Goondelf hits a 2nd other ally: we are evicted from Goondelf's prey1..2 AND Goondelf is evicted from our predator1..3 -> BLOCKED!
        guard.recordEnemyAttackOn('Goondelf', 'Ally2', 15);
        expect(guard.canAttackSafely('goondelf', 15)).toBe(false);
        expect(guard.canAttackSafely('ligma', 15)).toBe(true);
        expect(guard.canAttackSafely('fourth', 15)).toBe(true);

        // Death of an enemy or our own respawn clears provocation.
        guard.recordDeath('Ligma');
        expect(guard.canAttackSafely('ligma', 16)).toBe(false);
        guard.resetOnOwnDeath();
        expect(guard.canAttackSafely('fourth', 16)).toBe(false);
    });

    test('isCombatAttackAnim accepts verified rev-289 combat attack/spec anims and rejects eat, teleport, alch, and non-combat anims', () => {
        expect(isCombatAttackAnim(402)).toBe(true);  // human_blunt_pummel
        expect(isCombatAttackAnim(426)).toBe(true);  // human_bow
        expect(isCombatAttackAnim(1062)).toBe(true); // puncture (DDS spec)
        expect(isCombatAttackAnim(1161)).toBe(true); // human_castentangle_staff
        expect(isCombatAttackAnim(1167)).toBe(true); // human_castwave_staff
        expect(isCombatAttackAnim(829)).toBe(false); // human_eat
        expect(isCombatAttackAnim(714)).toBe(false); // human_castteleport
        expect(isCombatAttackAnim(713)).toBe(false); // human_casthighlvlalchemy
        expect(isCombatAttackAnim(811)).toBe(false); // human_casting (Charge)
        expect(isCombatAttackAnim(-1)).toBe(false);
    });

    test('observeProvocations blocks facing+HP-bar bait, eat/tele anims, and attacks facing teammates; approves ONLY verified facing attack anims or corroborated hits', () => {
        const guard = createNeverSkullGuard();
        const allies = new Set(['ally1']);
        const nextId = observeProvocations({
            guard,
            now: 50,
            selfSlot: 10,
            allies,
            seenEventId: 0,
            nearbyPlayers: [
                { name: 'Ally1', index: 1, combatTargetType: 'player', combatTargetIndex: 10 },
                // Trap (a): Enemy facing us with active HP bar (combatTargetIndex === selfSlot) but NO attack anim or damage_taken -> BLOCKED!
                { name: 'FacingHpBarTrap', index: 2, inCombat: true, combatTargetType: 'player', combatTargetIndex: 10 },
                // Trap (b): Enemy facing us playing eat animation (829) -> BLOCKED!
                { name: 'EatBaiter', index: 3, inCombat: true },
                // Trap (b2): Enemy facing us playing teleport animation (714) -> BLOCKED!
                { name: 'TeleBaiter', index: 4, inCombat: false },
                // Trap (c): Nearby enemy playing real combat attack anim (402) while facing a teammate (99 != 10) -> BLOCKED!
                { name: 'HittingTeammate', index: 5, inCombat: true, combatTargetType: 'player', combatTargetIndex: 99 },
                // Real provocation #1: verified combat attack anim (1062 = DDS puncture) on frame 0 facing us -> APPROVED!
                { name: 'RealDdsAttacker', index: 6, inCombat: true },
                // Real provocation #2: corroborated damage_taken hit from enemy not facing another player -> APPROVED!
                { name: 'RealHitAttacker', index: 7, inCombat: true },
            ],
            combatEvents: [
                // Splat attributed to index 5 while index 5 faces player 99 must not be trusted.
                { observationId: 5, tick: 50, type: 'damage_taken', sourceType: 'other_player', targetType: 'player', sourceIndex: 5 },
                // Corroborated hit from index 7 facing us -> trusted!
                { observationId: 6, tick: 50, type: 'damage_taken', sourceType: 'other_player', targetType: 'player', sourceIndex: 7 },
            ],
            clientPlayers: [
                null,
                null,
                { faceEntity: 32768 + 10, primaryAnim: -1, primaryAnimCycle: 0, primaryAnimFrame: 0 },
                { faceEntity: 32768 + 10, primaryAnim: 829, primaryAnimCycle: 0, primaryAnimFrame: 0 },
                { faceEntity: 32768 + 10, primaryAnim: 714, primaryAnimCycle: 0, primaryAnimFrame: 0 },
                { faceEntity: 32768 + 99, primaryAnim: 402, primaryAnimCycle: 0, primaryAnimFrame: 0 },
                { faceEntity: 32768 + 10, primaryAnim: 1062, primaryAnimCycle: 0, primaryAnimFrame: 0 },
                { faceEntity: 32768 + 10, primaryAnim: -1, primaryAnimCycle: 0, primaryAnimFrame: 0 },
            ],
        });
        expect(nextId).toBe(6);
        expect(guard.canAttackSafely('ally1', 50)).toBe(false);
        expect(guard.canAttackSafely('facinghpbartrap', 50)).toBe(false);
        expect(guard.canAttackSafely('eatbaiter', 50)).toBe(false);
        expect(guard.canAttackSafely('telebaiter', 50)).toBe(false);
        expect(guard.canAttackSafely('hittingteammate', 50)).toBe(false);
        expect(guard.canAttackSafely('realddsattacker', 50)).toBe(true);
        expect(guard.canAttackSafely('realhitattacker', 50)).toBe(true);
    });

    test('fightPlayer with neverSkull=true blocks facing/eat/non-attack traps until verified attack anim, then retaliates immediately', async () => {
        let tick = 100;
        const listeners: (() => void)[] = [];
        const attacks: number[] = [];
        const prayers: number[] = [];
        const logs: string[] = [];
        let enemyAnim = 829; // Start with eat animation while facing us + HP bar: MUST NOT provoke!
        const player = { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1, runEnergy: 100 };
        const enemyClient = {
            headicons: 1,
            appearance: [0, 0, 0, 512 + 1231],
            health: 99,
            totalHealth: 99,
            spotanimId: -1,
            faceEntity: 32768 + 5,
            primaryAnim: enemyAnim,
            primaryAnimCycle: 0,
            primaryAnimFrame: 0,
        };
        const client = {
            selfSlot: 5,
            localPlayer: { headicons: 0 },
            var: { 300: 1000, 301: 0 },
            players: { 1: enemyClient },
        };
        const session = {
            name: 'baiter',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client,
            sdk: {
                getState: () => ({
                    player,
                    inventory: [{ id: ITEMS.shark, slot: 0, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [
                        { name: 'Prayer', level: 99, baseLevel: 99 },
                        { name: 'Magic', level: 99, baseLevel: 99 },
                        { name: 'Strength', level: 99, baseLevel: 99 },
                    ],
                    prayers: { prayerPoints: 99, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{
                        name: 'Goondelf',
                        index: 1,
                        x: 3068,
                        z: 3640,
                        distance: 1,
                        combatLevel: 126,
                        inCombat: true,
                        combatTargetType: 'player',
                        combatTargetIndex: 5,
                    }],
                    combatEvents: [],
                    gameMessages: [],
                    combatStyle: { currentStyle: 1, styles: [{ index: 0 }, { index: 1 }] },
                }),
                sendInteractPlayer: (idx: number) => { attacks.push(idx); },
                sendSpellOnPlayer: (idx: number) => { attacks.push(idx); },
                sendTogglePrayer: (p: number) => { prayers.push(p); },
                sendUseItem: () => {},
                sendWalk: () => {},
                sendClickComponent: () => {},
            },
        } as unknown as Session;

        const done = fightPlayer(session, 'Goondelf', {
            kit: { melee: [1231] },
            neverSkull: true,
            cap: 6,
            log: l => logs.push(l),
        });

        const step = async () => { tick++; enemyClient.primaryAnim = enemyAnim; for (const fn of [...listeners]) fn(); await new Promise(r => setTimeout(r, 0)); };
        // Ticks 1..3: Goondelf faces us with HP bar and plays eat anim 829 -> 0 attacks sent!
        for (let i = 0; i < 3; i++) await step();
        expect(attacks).toEqual([]);
        expect(logs.some(l => l.includes('PK never-skull bait hold'))).toBe(true);
        // Overhead protect prayer still activates defensively while baiting.
        expect(prayers).toContain(PRAYER.melee);

        // Tick 4+: Goondelf swings verified DDS puncture anim (1062) facing us -> retaliation fires immediately!
        enemyAnim = 1062;
        for (let i = 0; i < 4; i++) await step();
        const res = await done;
        expect(attacks.length).toBeGreaterThan(0);
        expect(res.attacks.melee).toBeGreaterThan(0);
        expect(res.unexpectedSkull).toBeUndefined();
    });

    test('fightPlayer with external provokedBy never bypasses external guard via local observation', async () => {
        let tick = 150;
        const listeners: (() => void)[] = [];
        const attacks: number[] = [];
        const session = {
            name: 'baiter',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client: {
                selfSlot: 5,
                localPlayer: { headicons: 0 },
                var: { 300: 1000, 301: 0 },
                players: {
                    1: {
                        headicons: 1,
                        appearance: [0, 0, 0, 512 + 1231],
                        health: 99,
                        totalHealth: 99,
                        spotanimId: -1,
                        faceEntity: 32768 + 5,
                        primaryAnim: 1062,
                        primaryAnimCycle: 0,
                        primaryAnimFrame: 0,
                    },
                },
            },
            sdk: {
                getState: () => ({
                    player: { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1 },
                    inventory: [],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [{ name: 'Prayer', level: 99, baseLevel: 99 }],
                    prayers: { prayerPoints: 99, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{ name: 'Goondelf', index: 1, x: 3068, z: 3640, distance: 1, combatLevel: 126 }],
                    combatEvents: [],
                    gameMessages: [],
                }),
                sendInteractPlayer: (idx: number) => { attacks.push(idx); },
                sendSpellOnPlayer: (idx: number) => { attacks.push(idx); },
                sendTogglePrayer: () => {},
                sendWalk: () => {},
            },
        } as unknown as Session;

        // External provokedBy returns false (e.g. caller's FIFO evicted this player) -> MUST stay blocked!
        const done = fightPlayer(session, 'Goondelf', {
            kit: { melee: [1231] },
            neverSkull: true,
            provokedBy: () => false,
            cap: 3,
            log: () => {},
        });
        for (let i = 0; i < 4; i++) {
            tick++;
            for (const fn of [...listeners]) fn();
            await new Promise(r => setTimeout(r, 0));
        }
        await done;
        expect(attacks).toEqual([]);
    });

    test('fightPlayer with neverSkull=true immediately aborts offense, enables Protect Item, and reports telemetry if ownSkull turns true', async () => {
        let tick = 200;
        const listeners: (() => void)[] = [];
        const attacks: number[] = [];
        const prayers: number[] = [];
        const alerts: { tick: number; target: string; lostValue: number }[] = [];
        const client = {
            selfSlot: 5,
            localPlayer: { headicons: 1 }, // Unexpectedly skulled!
            var: { 300: 1000, 301: 0 },
            players: { 1: { headicons: 1, appearance: [0, 0, 0, 512 + 1231], health: 99, totalHealth: 99, spotanimId: -1 } },
        };
        const session = {
            name: 'baiter',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client,
            sdk: {
                getState: () => ({
                    player: { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1 },
                    inventory: [{ id: 861, slot: 0, count: 1, name: 'Magic shortbow', optionsWithIndex: [] }],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [{ name: 'Prayer', level: 99, baseLevel: 99 }],
                    prayers: { prayerPoints: 99, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{ name: 'Goondelf', index: 1, x: 3068, z: 3640, distance: 1, combatLevel: 126 }],
                    combatEvents: [],
                    gameMessages: [],
                }),
                sendInteractPlayer: (idx: number) => { attacks.push(idx); },
                sendSpellOnPlayer: (idx: number) => { attacks.push(idx); },
                sendTogglePrayer: (p: number) => { prayers.push(p); },
                sendWalk: () => {},
            },
        } as unknown as Session;

        const done = fightPlayer(session, 'Goondelf', {
            kit: { melee: [1231] },
            neverSkull: true,
            onUnexpectedSkull: info => alerts.push({ tick: info.tick, target: info.target, lostValue: info.lostValue }),
            cap: 10,
            log: () => {},
        });
        tick++;
        for (const fn of [...listeners]) fn();
        const res = await done;
        expect(res.outcome).toBe('danger');
        expect(res.danger).toBe('unexpected skull');
        expect(res.unexpectedSkull).toBe(true);
        expect(attacks).toEqual([]);
        expect(prayers).toContain(PRAYER.item);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.target).toBe('Goondelf');
    });
});

describe('2. Zero-Risk 3+1 Kit Enforcement', () => {
    test('assessZeroRiskKit catches risked weapons/valuable gear and approves true 3+1 kits', () => {
        // Full rune + DDS(p) + MSB + Glory risks DDS(p), Glory, and MSB even with Protect Item!
        const riskyUnits = [
            { id: 1127, count: 1, name: 'Rune platebody' },     // 65,000
            { id: 1079, count: 1, name: 'Rune platelegs' },     // 64,000
            { id: 1201, count: 1, name: 'Rune kiteshield' },    // 54,400
            { id: 1163, count: 1, name: 'Rune full helm' },     // 35,200
            { id: 1231, count: 1, name: 'Dragon dagger(p)' },   // 24,000
            { id: 1712, count: 1, name: 'Amulet of glory(4)' }, // 17,625
            { id: 861, count: 1, name: 'Magic shortbow' },      // 1,600
            { id: 385, count: 18, name: 'Shark' },              // 300
        ];
        const risky = assessZeroRiskKit(riskyUnits, { cost: itemCostOf, requireProtectItem: true });
        expect(risky.ok).toBe(false);
        expect(risky.riskedWeapons4.map(w => w.id)).toEqual([1231, 861]);
        expect(risky.riskedValuableGear4.map(g => g.id)).toEqual([1712]);

        // True 3+1 zero-risk kit: Rune platebody (65k) + Rune platelegs (64k) + DDS(p) (24k) + MSB (1.6k)
        // with cheap low-cost pieces below 1,600 gp (Mithril full helm 1,430, Ring of recoil 900, Cape of legends 450, Climbing boots 12).
        const safeUnits = [
            { id: 1127, count: 1, name: 'Rune platebody' },
            { id: 1079, count: 1, name: 'Rune platelegs' },
            { id: 1231, count: 1, name: 'Dragon dagger(p)' },
            { id: 861, count: 1, name: 'Magic shortbow' },
            { id: 1159, count: 1, name: 'Mithril full helm' },
            { id: 2550, count: 1, name: 'Ring of recoil' },
            { id: 1052, count: 1, name: 'Cape of legends' },
            { id: 3105, count: 1, name: 'Climbing boots' },
            { id: 385, count: 20, name: 'Shark' },
        ];
        const safe = assessZeroRiskKit(safeUnits, { cost: itemCostOf, requireProtectItem: true });
        expect(safe.ok).toBe(true);
        expect(safe.riskedWeapons4).toEqual([]);
        expect(safe.riskedValuableGear4).toEqual([]);
        expect(safe.kept4).toEqual([1127, 1079, 1231, 861]);
        // Also verify raw deathRisk agrees: unskulled + Protect Item keeps all 4 exact items.
        expect(deathRisk(safeUnits, itemCostOf, false, true).kept).toEqual([1127, 1079, 1231, 861]);
    });

    test('enforceZeroRiskGear and squad-ready gang-bait-3plus1 downgrade excess armour to protect weapons', () => {
        const gearRows = JSON.parse(readFileSync(join(process.cwd(), 'knowledge', 'gear.json'), 'utf8')) as Gear[];
        const gear = new Map(gearRows.map(g => [g.id, g]));
        const now = Date.now();
        const acct: Account = {
            name: 'BaitOne',
            at: now,
            bankAt: now,
            pos: { x: 3092, z: 3496, level: 0 },
            levels: { attack: 99, strength: 99, defence: 99, hitpoints: 99, ranged: 99, magic: 99, prayer: 99 },
            quests: new Set(['lost city', 'dragon slayer']),
            worn: [],
            pack: [],
            bank: [
                { id: 1127, name: 'Rune platebody', count: 1 },
                { id: 1079, name: 'Rune platelegs', count: 1 },
                { id: 1201, name: 'Rune kiteshield', count: 1 },
                { id: 1163, name: 'Rune full helm', count: 1 },
                { id: 1159, name: 'Mithril full helm', count: 1 },
                { id: 1712, name: 'Amulet of glory(4)', count: 1 },
                { id: 1231, name: 'Dragon dagger(p)', count: 1 },
                { id: 861, name: 'Magic shortbow', count: 1 },
                { id: RING_OF_RECOIL_ID, name: 'Ring of recoil', count: 1 },
                { id: 884, name: 'Iron arrow', count: 300 },
                { id: 175, name: 'Antipoison(3)', count: 2 },
                { id: 563, name: 'Law rune', count: 10 },
                { id: 556, name: 'Air rune', count: 50 },
                { id: 557, name: 'Earth rune', count: 50 },
                { id: 555, name: 'Water rune', count: 50 },
                { id: 561, name: 'Nature rune', count: 50 },
                { id: 385, name: 'Shark', count: 40 },
            ],
            prayerPoints: 99,
        };
        const pick = pickKit(acct, gear, RULES['gang-bait-3plus1']!, now);
        expect(pick.ready).toBe(true);
        expect(pick.zeroRisk?.ok).toBe(true);
        expect(pick.zeroRisk?.riskedWeapons4).toEqual([]);
        expect(pick.zeroRisk?.riskedValuableGear4).toEqual([]);
        expect(pick.zeroRisk?.kept4).toContain(1231);
        expect(pick.zeroRisk?.kept4).toContain(861);
        expect(pick.worn.some(w => w.id === RING_OF_RECOIL_ID)).toBe(true);

        // Missing Ring of recoil blocks gang-bait-3plus1 until supplied.
        const noRecoilPick = pickKit({ ...acct, bank: acct.bank.filter(i => i.id !== RING_OF_RECOIL_ID) }, gear, RULES['gang-bait-3plus1']!, now);
        expect(noRecoilPick.ready).toBe(false);
        expect(noRecoilPick.reasons.some(r => /Ring of recoil/i.test(r))).toBe(true);

        // Also test standalone enforceZeroRiskGear with strict 3-keep limit.
        const enforced = enforceZeroRiskGear({
            worn: [
                { id: 1127, name: 'Rune platebody', count: 1, slot: 4 },
                { id: 1079, name: 'Rune platelegs', count: 1, slot: 7 },
                { id: 1163, name: 'Rune full helm', count: 1, slot: 0 },
                { id: 1231, name: 'Dragon dagger(p)', count: 1, slot: 3 },
            ],
            carried: [{ id: 861, name: 'Magic shortbow', count: 1 }],
            alternativesBySlot: new Map([
                [0, [{ item: { id: 1159, name: 'Mithril full helm', count: 1, slot: 0 }, id: 1159, name: 'Mithril full helm', cost: itemCostOf(1159), score: 20 }]],
                [7, [{ item: { id: 1067, name: 'Iron platelegs', count: 1, slot: 7 }, id: 1067, name: 'Iron platelegs', cost: itemCostOf(1067), score: 10 }]],
            ]),
            cost: itemCostOf,
            keepLimit: 3,
        });
        expect(enforced.assessment.strict3Ok).toBe(true);
        expect(enforced.assessment.riskedWeapons3).toEqual([]);
    });

    test('verifyPvpStageSupplies in bait mode rejects kits risking weapons and approves zero-risk 3+1 kits', () => {
        const risky = verifyPvpStageSupplies({
            mode: 'bait',
            magicLevel: 99,
            equipment: [
                { id: 1127, name: 'Rune platebody' },
                { id: 1079, name: 'Rune platelegs' },
                { id: 1201, name: 'Rune kiteshield' },
                { id: 1163, name: 'Rune full helm' },
                { id: 1231, name: 'Dragon dagger(p)' },
            ],
            inventory: [
                { id: 861, name: 'Magic shortbow', count: 1 },
                { id: 563, name: 'Law rune', count: 2 },
                { id: 556, name: 'Air rune', count: 10 },
                { id: 554, name: 'Fire rune', count: 10 },
                ...Array.from({ length: 10 }, () => ({ id: 385, name: 'Shark', count: 1 })),
            ],
        });
        expect(risky.ok).toBe(false);
        expect(risky.missing.some(m => m.includes('zero-risk 3+1 violation'))).toBe(true);

        const safe = verifyPvpStageSupplies({
            mode: 'bait',
            magicLevel: 99,
            equipment: [
                { id: 1127, name: 'Rune platebody' },
                { id: 1079, name: 'Rune platelegs' },
                { id: 1159, name: 'Mithril full helm' },
                { id: 1231, name: 'Dragon dagger(p)' },
            ],
            inventory: [
                { id: 861, name: 'Magic shortbow', count: 1 },
                { id: 563, name: 'Law rune', count: 2 },
                { id: 556, name: 'Air rune', count: 10 },
                { id: 554, name: 'Fire rune', count: 10 },
                ...Array.from({ length: 10 }, () => ({ id: 385, name: 'Shark', count: 1 })),
            ],
        });
        expect(safe.ok).toBe(true);
        expect(safe.zeroRisk?.ok).toBe(true);
    });
});

describe('3. Prayer-Drain / Smite-Burst Timing & 24v49 Overkill Coordination', () => {
    test('createDaggerWatch tracks overhead ticks, gear prayer bonus drain, lowPrayer, holdSpecForDrain, and smiteReady', () => {
        // Monk robe top (544, +6 prayer) + bottom (542, +5 prayer) = +11 prayer bonus.
        expect(inferGearPrayerBonus([544, 542])).toBe(11);

        const w = createDaggerWatch({ offReads: 3, holdBelow: 0.7, holdTicks: 300 });
        for (let t = 1; t <= 120; t++) {
            w.read('Goondelf', t, { skulled: true, overhead: true, inCombat: true, hp: 0.85, wornIds: [544, 542], basePrayer: 45 });
        }
        const snapMid = w.snapshot('Goondelf')!;
        expect(snapMid.overheadOnTicks).toBe(120);
        expect(snapMid.estPrayerPoints).toBeLessThan(15);
        expect(w.lowPrayer('Goondelf', 15)).toBe(true);
        expect(w.smiteReady('Goondelf')).toBe(false);

        // Fresh high-prayer target holds DPS specs while overhead is ON.
        w.read('Ligma', 10, { skulled: true, overhead: true, inCombat: true, hp: 0.9, basePrayer: 99 });
        expect(w.holdSpecForDrain('Ligma', 10)).toBe(true);

        // Once Goondelf's overhead drops for 3 combat ticks, smiteReady fires and holdSpecForDrain releases!
        for (let t = 121; t <= 123; t++) {
            w.read('Goondelf', t, { skulled: true, overhead: false, inCombat: true, hp: 0.8 });
        }
        expect(w.smiteReady('Goondelf')).toBe(true);
        expect(w.holdSpecForDrain('Goondelf', 123)).toBe(false);
    });

    test('evaluateSpecPlan conserves spec during holdSpecForDrain and dumps immediately on smiteBurst', () => {
        const base = {
            dying: false,
            canReachMelee: true,
            fled: false,
            running: false,
            castFreezePending: false,
            kiteTarget: false,
            at: { x: 3067, z: 3640 },
            target: { name: 'Goondelf', index: 1, x: 3068, z: 3640, distance: 1, combatLevel: 126 } as never,
            guarded: new Set<'melee' | 'ranged' | 'magic'>(),
            seen: { headicons: 1, worn: [], health: 90, totalHealth: 99, spotanim: -1 },
            energy: 500,
            lastSpecStyle: null,
            targetStunned: false,
            stunOpenForChain: true,
            spec: { kit: [1231], bar: 'combat_stabsword:specbar', cost: 250, below: 0.45, style: 'melee' as const },
            bursting: false,
            specReserve: 500,
            hasWeaponAndShield: false,
            invLength: 20,
            nearbyPlayers: [],
        };
        // Normal high-HP target: blocked by below (0.45) and specReserve (500).
        expect(evaluateSpecPlan(base).triggerNoVolley).toBe(false);
        // Even at low HP, holdSpecForDrain holds back DPS spec until enemy prayer drops.
        expect(evaluateSpecPlan({
            ...base,
            seen: { headicons: 1, worn: [], health: 35, totalHealth: 99, spotanim: -1 },
            specReserve: 0,
            holdSpecForDrain: true,
        }).triggerNoVolley).toBe(false);
        // The instant smiteBurst is true (skulled target drained / Protect Item OFF), spec fires at 90% HP bypassing specReserve!
        const burst = evaluateSpecPlan({ ...base, smiteBurst: true, holdSpecForDrain: true });
        expect(burst.triggerNoVolley).toBe(true);
        expect(burst.smite).toBe(true);
    });

    test('24v49 overkill caps roll overflow attackers onto secondary targets cleanly', () => {
        expect(maxOverkillAttackers(0)).toBe(0);
        expect(maxOverkillAttackers(0.10)).toBe(2);
        expect(maxOverkillAttackers(0.25)).toBe(3);
        expect(maxOverkillAttackers(0.45)).toBe(5);
        expect(maxOverkillAttackers(0.80)).toBe(Infinity);

        // TeamFocus: 2 allies already on 10% HP target 'A' -> 3rd ally rolls onto target 'B'!
        const focus = createTeamFocus();
        focus.assign('m1', 'A');
        focus.assign('m2', 'A');
        const live = [
            { f: { name: 'A' }, p: { name: 'A', distance: 1 } },
            { f: { name: 'B' }, p: { name: 'B', distance: 2 } },
        ];
        const hp = new Map([['A', 0.10], ['B', 0.60]]);
        const pickM3 = pickEnemy<{ name: string }, (typeof live)[number]>(live, undefined, 'low', x => hp.get(x.f.name)!, { focus, memberName: 'm3', nameOf: x => x.f.name });
        expect(pickM3?.f.name).toBe('B');
        // Member m1 already assigned to A still sees count excluding itself (1 < 2), so it finishes A.
        const pickM1 = pickEnemy<{ name: string }, (typeof live)[number]>(live, undefined, 'low', x => hp.get(x.f.name)!, { focus, memberName: 'm1', nameOf: x => x.f.name });
        expect(pickM1?.f.name).toBe('A');

        // SquadFocus overflow rolls 3rd member onto secondary multi-way target when primary is at 10% HP with 2 attackers.
        const sf = createSquadFocus();
        sf.assign('s1', 'Goondelf');
        sf.assign('s2', 'Goondelf');
        const view = [
            { name: 'Goondelf', index: 1, distance: 1, x: 3067, z: 3640, combatLevel: 126 },
            { name: 'Ligma', index: 2, distance: 2, x: 3068, z: 3640, combatLevel: 126 },
        ];
        const shp = new Map([[1, 0.10], [2, 0.70]]);
        const s3Pick = sf.pick({
            view,
            targets: new Set(['goondelf', 'ligma']),
            health: p => shp.get(p.index)!,
            inMulti: true,
            memberName: 's3',
            now: 10,
        });
        expect(s3Pick?.name).toBe('Ligma');
    });
});

describe('4. Enemy Weapon & High-Value Loot Vacuum', () => {
    test('PICKUP_ITEMS prioritizes all enemy weapons before armour and sharks', () => {
        const wanted = new Set(PICKUP_ITEMS);
        const ground = [
            { id: ITEMS.shark, count: 1, x: 3067, z: 3640, distance: 0 },
            { id: 1127, count: 1, x: 3067, z: 3640, distance: 0 }, // Rune platebody
            { id: 1333, count: 1, x: 3067, z: 3640, distance: 0 }, // Rune scimitar
            { id: 1305, count: 1, x: 3067, z: 3640, distance: 0 }, // Dragon longsword
            { id: 861, count: 1, x: 3067, z: 3640, distance: 0 },  // Magic shortbow
            { id: 1231, count: 1, x: 3067, z: 3640, distance: 0 }, // Dragon dagger(p)
        ];
        const ordered = plannedPickups(ground, wanted, 3).map(g => g.id);
        expect(ordered.indexOf(1305)).toBeLessThan(ordered.indexOf(1127));
        expect(ordered.indexOf(1333)).toBeLessThan(ordered.indexOf(1127));
        expect(ordered.indexOf(1231)).toBeLessThan(ordered.indexOf(1127));
        expect(ordered.indexOf(861)).toBeLessThan(ordered.indexOf(1127));
        expect(ordered.indexOf(1127)).toBeLessThan(ordered.indexOf(ITEMS.shark));
        expect(ENEMY_WEAPON_IDS.has(1305)).toBe(true);
        expect(ENEMY_WEAPON_IDS.has(1333)).toBe(true);
        expect(ENEMY_WEAPON_IDS.has(861)).toBe(true);
    });

    test('pickUp drops cheapest food (or empty vial first) on full 28-slot inventory to vacuum enemy weapons and never drops a shark for a shark', async () => {
        const rankOf = new Map(PICKUP_ITEMS.map((id, i) => [id, i]));
        const invWithVial = [
            { id: ITEMS.shark, slot: 0, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { id: 379, slot: 1, name: 'Lobster', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { id: 229, slot: 2, name: 'Vial', optionsWithIndex: [{ text: 'Drop', opIndex: 5 }] },
        ];
        expect(cheapestExpendableSlot(invWithVial, 0, rankOf)?.item.id).toBe(229);
        expect(cheapestExpendableSlot(invWithVial.slice(0, 2), 0, rankOf)?.item.id).toBe(379);
        // Never drop a shark to pick up a shark.
        expect(cheapestExpendableSlot([invWithVial[0]!], rankOf.get(ITEMS.shark)!, rankOf)).toBeUndefined();

        // Full 28-slot inventory: 27 sharks + 1 lobster -> drops lobster via sendDropItem (0 combat delay) to pick up Rune scimitar (1333)!
        let tick = 1;
        const dropped: number[] = [];
        const inv = [
            ...Array.from({ length: 27 }, (_, slot) => ({ id: ITEMS.shark, slot, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] })),
            { id: 379, slot: 27, count: 1, name: 'Lobster', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        ];
        const ground = [
            { id: 1333, count: 1, x: 3067, z: 3640, distance: 1, name: 'Rune scimitar' },
            { id: ITEMS.shark, count: 1, x: 3067, z: 3640, distance: 0, name: 'Shark' },
        ];
        const session = {
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { queueMicrotask(() => { tick++; fn(); }); return () => {}; },
            client: { objType: () => ({ stackable: false }) },
            sdk: {
                getState: () => ({ groundItems: ground }),
                getInventory: () => inv,
                sendDropItem: async (slot: number) => {
                    dropped.push(slot);
                    const idx = inv.findIndex(i => i.slot === slot);
                    if (idx >= 0) inv.splice(idx, 1);
                },
                sendUseItem: async () => { throw new Error('should drop instead of eating when sendDropItem is available'); },
            },
            bot: {
                pickupItem: async (item: { id: number; count: number; name: string }) => {
                    inv.push({ id: item.id, slot: 27, count: item.count, name: item.name, optionsWithIndex: [] });
                    const gIdx = ground.findIndex(g => g.id === item.id);
                    if (gIdx >= 0) ground.splice(gIdx, 1);
                    return { success: true };
                },
            },
        } as unknown as Session;

        const got = await pickUp(session, new Set(PICKUP_ITEMS), { radius: 3, maxTicks: 10 });
        expect(dropped).toEqual([27]);
        expect(got).toEqual({ 1333: 1 });
        expect(summarizeWeaponLoot(got, id => (id === 1333 ? 'rune_scimitar' : undefined))).toEqual({
            totalWeapons: 1,
            weapons: { 'rune scimitar': 1 },
        });
    });

    test('postLootBankDue triggers immediate banking when looted enemy weapons displace top-3 keeps or remain unprotected', () => {
        const baseKit = [
            { id: 1127, count: 1, name: 'Rune platebody' }, // 65k
            { id: 1079, count: 1, name: 'Rune platelegs' }, // 64k
            { id: 1231, count: 1, name: 'Dragon dagger(p)' }, // 24k
            { id: 861, count: 1, name: 'Magic shortbow' }, // 1.6k
            { id: 385, count: 15, name: 'Shark' },
        ];
        const ownCore = new Set([1127, 1079, 1231]);
        // Before looting: zero-risk 3+1 holds -> stay fighting!
        expect(postLootBankDue(baseKit, { cost: itemCostOf, ownCoreIds: ownCore, protectItem: true }).bankNow).toBe(false);

        // Looting a Dragon longsword (100k) displaces our DDS(p) from top-3 AND leaves MSB unprotected -> bank immediately!
        const withDlong = postLootBankDue([...baseKit, { id: 1305, count: 1, name: 'Dragon longsword' }], {
            cost: itemCostOf,
            ownCoreIds: ownCore,
            protectItem: true,
        });
        expect(withDlong.bankNow).toBe(true);
        expect(withDlong.displacedOwnGear).toEqual([1231]);

        // Looting a second Dragon dagger(p) (24k) leaves a weapon unprotected beyond 3+1 keeps -> bank immediately!
        const withLootedDds = postLootBankDue([...baseKit, { id: 1231, count: 1, name: 'Dragon dagger(p)' }], {
            cost: itemCostOf,
            ownCoreIds: ownCore,
            protectItem: true,
        });
        expect(withLootedDds.bankNow).toBe(true);
        expect(withLootedDds.riskedWeapons.map(w => w.id)).toContain(861);
    });

    test('restock banks looted enemy weapons/armour instead of equipping them over occupied slots', async () => {
        const equippedCalls: number[] = [];
        const deposited: number[] = [];
        const equipment = [
            { id: 1127, slot: 4, count: 1, name: 'Rune platebody' },
            { id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' },
        ];
        const inventory = [
            { id: 1305, slot: 0, count: 1, name: 'Dragon longsword', optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { id: 1113, slot: 1, count: 1, name: 'Rune chainbody', optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
            { id: 861, slot: 2, count: 1, name: 'Magic shortbow', optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ];
        const bank = [
            { id: 861, count: 1 },
            { id: 385, count: 30 },
        ];
        const session = {
            name: 'looter',
            sdk: {
                getEquipment: () => equipment,
                getInventory: () => inventory,
                getBankItems: () => bank,
                sendUseItem: async (slot: number) => { equippedCalls.push(slot); },
            },
            bot: {
                openBank: async () => ({ success: true }),
                closeBank: async () => ({ success: true }),
                depositItem: async (item: { id: number; slot: number; count: number }) => {
                    deposited.push(item.id);
                    const idx = inventory.findIndex(i => i.slot === item.slot);
                    if (idx >= 0) inventory.splice(idx, 1);
                    const b = bank.find(r => r.id === item.id);
                    if (b) b.count += item.count;
                    else bank.push({ id: item.id, count: item.count });
                },
                withdrawItem: async (row: { id: number; count: number }, count: number) => {
                    row.count -= count;
                    for (let i = 0; i < count; i++) inventory.push({ id: row.id, slot: inventory.length, count: 1, name: String(row.id), optionsWithIndex: [] });
                },
            },
        } as unknown as Session;

        const fault = await restock(session, 5, [{ id: 861, count: 1 }], { melee: [1231], ranged: [861] });
        expect(fault).toBeNull();
        // Neither looted Dragon longsword nor looted Rune chainbody was equipped; both were deposited to the bank!
        expect(equippedCalls).toEqual([]);
        expect(deposited).toContain(1305);
        expect(deposited).toContain(1113);
    });
});

describe('5. Zero-Tick-Waste Fight Loop', () => {
    test('rewearStart batches up to 4 stripped armour pieces in 1 single tick instead of N ticks', async () => {
        const clicks: number[] = [];
        let tickCalls = 0;
        const session = {
            sdk: {
                getState: () => ({ equipment: [] }),
                getInventory: () => [
                    { id: 1163, slot: 0, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }, // Rune full helm (hat)
                    { id: 1127, slot: 1, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }, // Rune platebody (torso)
                    { id: 1079, slot: 2, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }, // Rune platelegs (legs)
                ],
                sendUseItem: async (slot: number) => { clicks.push(slot); },
            },
        } as unknown as Session;

        const worn = await rewearStart(session, [1163, 1127, 1079], () => {}, async () => { tickCalls++; return true; });
        expect(worn).toBe(3);
        expect(clicks).toEqual([0, 1, 2]);
        expect(tickCalls).toBe(1);
    });

    test('fightPlayer stops immediately on 0-HP dying target when stopOnDying=true and never wastes attacks on corpses', async () => {
        let tick = 300;
        const listeners: (() => void)[] = [];
        const attacks: number[] = [];
        const session = {
            name: 'killer',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client: {
                localPlayer: { headicons: 0 },
                var: { 300: 1000, 301: 0 },
                players: { 1: { headicons: 1, appearance: [0, 0, 0, 512 + 1231], health: 0, totalHealth: 99, spotanimId: -1 } },
            },
            sdk: {
                getState: () => ({
                    player: { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1 },
                    inventory: [],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [{ name: 'Prayer', level: 99, baseLevel: 99 }],
                    prayers: { prayerPoints: 99, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{ name: 'Corpse', index: 1, x: 3068, z: 3640, distance: 1, combatLevel: 126 }],
                    combatEvents: [],
                    gameMessages: [],
                }),
                sendInteractPlayer: (idx: number) => { attacks.push(idx); },
                sendSpellOnPlayer: (idx: number) => { attacks.push(idx); },
                sendTogglePrayer: () => {},
                sendWalk: () => {},
            },
        } as unknown as Session;

        const done = fightPlayer(session, 'Corpse', { kit: { melee: [1231] }, stopOnDying: true, cap: 10, log: () => {} });
        tick++;
        for (const fn of [...listeners]) fn();
        const res = await done;
        expect(res.ticks).toBe(1);
        expect(attacks).toEqual([]);
    });

    test('fightPlayer still updates overhead prayer on the same tick as drinking a potion', async () => {
        let tick = 400;
        const listeners: (() => void)[] = [];
        const used: number[] = [];
        const prayers: number[] = [];
        const session = {
            name: 'drinker',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client: {
                localPlayer: { headicons: 0 },
                var: { 300: 0, 301: 0 },
                // Opponent holds a Magic shortbow (ranged -> Protect from Missiles = 13).
                players: { 1: { headicons: 1, appearance: [0, 0, 0, 512 + 861], health: 99, totalHealth: 99, spotanimId: -1 } },
            },
            sdk: {
                getState: () => ({
                    player: { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1 },
                    inventory: [{ id: 2434, slot: 4, count: 1, name: 'Prayer potion(4)', optionsWithIndex: [{ text: 'Drink', opIndex: 1 }] }],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [{ name: 'Prayer', level: 4, baseLevel: 99 }],
                    prayers: { prayerPoints: 4, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{ name: 'Ranger', index: 1, x: 3068, z: 3640, distance: 1, combatLevel: 126 }],
                    combatEvents: [],
                    gameMessages: [],
                }),
                sendUseItem: (slot: number) => { used.push(slot); },
                sendTogglePrayer: (p: number) => { prayers.push(p); },
                sendInteractPlayer: () => {},
                sendWalk: () => {},
            },
        } as unknown as Session;

        const done = fightPlayer(session, 'Ranger', { kit: { melee: [1231] }, restorePrayerAt: 20, cap: 2, log: () => {} });
        const step = async () => { tick++; for (const fn of [...listeners]) fn(); await new Promise(r => setTimeout(r, 0)); };
        await step();
        await step();
        await done;
        // Drank prayer potion AND turned on Protect from Missiles on the exact same tick!
        expect(used).toEqual([4]);
        expect(prayers).toContain(PRAYER.missiles);
    });

    test('fightPlayer with smiteBurst=true casts freeze lock immediately on drained skulled target', async () => {
        let tick = 500;
        const listeners: (() => void)[] = [];
        const spellsCast: number[] = [];
        const session = {
            name: 'smiter',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client: {
                localPlayer: { headicons: 0 },
                var: { 300: 0, 301: 0 },
                players: { 1: { headicons: 1, appearance: [0, 0, 0, 512 + 1231], health: 95, totalHealth: 99, spotanimId: -1 } },
            },
            sdk: {
                getState: () => ({
                    player: { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1 },
                    inventory: [
                        { id: ITEMS.earthRune, slot: 0, count: 20, name: 'Earth rune', optionsWithIndex: [] },
                        { id: ITEMS.waterRune, slot: 1, count: 20, name: 'Water rune', optionsWithIndex: [] },
                        { id: ITEMS.natureRune, slot: 2, count: 20, name: 'Nature rune', optionsWithIndex: [] },
                    ],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [
                        { name: 'Prayer', level: 99, baseLevel: 99 },
                        { name: 'Magic', level: 99, baseLevel: 99 },
                    ],
                    prayers: { prayerPoints: 99, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{ name: 'Drained', index: 1, x: 3069, z: 3640, distance: 2, combatLevel: 126 }],
                    combatEvents: [],
                    gameMessages: [],
                }),
                sendSpellOnPlayer: (_idx: number, spell: number) => { spellsCast.push(spell); },
                sendInteractPlayer: () => {},
                sendTogglePrayer: () => {},
                sendWalk: () => {},
            },
        } as unknown as Session;

        const done = fightPlayer(session, 'Drained', {
            kit: { melee: [1231] },
            freeze: 'flee',
            smiteBurst: () => true,
            cap: 2,
            log: () => {},
        });
        const step = async () => { tick++; for (const fn of [...listeners]) fn(); await new Promise(r => setTimeout(r, 0)); };
        await step();
        await step();
        await done;
        expect(spellsCast).toEqual([SPELLS.entangle]);
    });
});

describe('6. BiS Multi-Style Gear Switches & Zero-Risk Full-Switch Enforcement', () => {
    test('kitFrom builds per-style BiS switch lists (d-hide ranged, magic robes/cape/amulet, melee tank/gloves/boots) with weapons first', () => {
        const worn = [
            { id: 3751, name: 'Berserker helm', count: 1, slot: 0 },
            { id: 1127, name: 'Rune platebody', count: 1, slot: 4 },
            { id: 1079, name: 'Rune platelegs', count: 1, slot: 7 },
            { id: 1231, name: 'Dragon dagger(p)', count: 1, slot: 3 },
            { id: 1495, name: "Klank's gauntlets", count: 1, slot: 9 },
            { id: 3105, name: 'Climbing boots', count: 1, slot: 10 },
            { id: 2550, name: 'Ring of recoil', count: 1, slot: 12 },
        ];
        const pack = [
            { id: 861, name: 'Magic shortbow', count: 1 },
            { id: 2503, name: "Black d'hide body", count: 1 },
            { id: 2497, name: "Black d'hide chaps", count: 1 },
            { id: 2491, name: "Black d'hide vambraces", count: 1 },
            { id: 2412, name: 'Saradomin cape', count: 1 },
            { id: 2415, name: 'Saradomin staff', count: 1 },
            { id: 577, name: 'Wizard robe', count: 1 },
            { id: 1033, name: 'Zamorak robe', count: 1 },
            { id: 1727, name: 'Amulet of magic', count: 1 },
        ];
        const kit = kitFrom(worn, pack);
        // Weapons are always first so same-tick equip+attack fires weapon first within 5 packets/tick.
        expect(kit.melee?.[0]).toBe(1231);
        expect(kit.melee).toContain(1127);
        expect(kit.melee).toContain(1079);
        expect(kit.melee).toContain(1495);
        expect(kit.melee).toContain(3105);
        expect(kit.melee).toContain(3751);

        expect(kit.ranged?.[0]).toBe(861);
        expect(kit.ranged).toContain(2503);
        expect(kit.ranged).toContain(2497);
        expect(kit.ranged).toContain(2491);

        expect(kit.magic?.[0]).toBe(2415);
        expect(kit.magic).toContain(2412);
        expect(kit.magic).toContain(577);
        expect(kit.magic).toContain(1033);
        expect(kit.magic).toContain(1727);
        expect(dhideTierOf(new Set(kit.ranged))).toBe('black');
        expect(BIS_SWITCH_GEAR.meleeGloves).toContain(1495);
    });

    test('fightPlayer equips zero-cost magic freeze switches (god cape + wizard robe + amulet of magic) in the same tick as casting Entangle within 5 packets', async () => {
        let tick = 600;
        const listeners: (() => void)[] = [];
        const events: string[] = [];
        const session = {
            name: 'switcher',
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (fn: () => void) => { listeners.push(fn); return () => {}; },
            client: {
                localPlayer: { headicons: 0 },
                var: { 300: 0, 301: 0 },
                players: { 1: { headicons: 1, appearance: [0, 0, 0, 512 + 1231], health: 95, totalHealth: 99, spotanimId: -1 } },
            },
            sdk: {
                getState: () => ({
                    player: { worldX: 3067, worldZ: 3640, level: 0, hp: 99, maxHp: 99, combatLevel: 126, isDead: false, lifeId: 1 },
                    inventory: [
                        { id: 2412, slot: 0, count: 1, name: 'Saradomin cape', optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
                        { id: 577, slot: 1, count: 1, name: 'Wizard robe', optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
                        { id: 1727, slot: 2, count: 1, name: 'Amulet of magic', optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
                        { id: ITEMS.earthRune, slot: 3, count: 20, name: 'Earth rune', optionsWithIndex: [] },
                        { id: ITEMS.waterRune, slot: 4, count: 20, name: 'Water rune', optionsWithIndex: [] },
                        { id: ITEMS.natureRune, slot: 5, count: 20, name: 'Nature rune', optionsWithIndex: [] },
                    ],
                    equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)' }],
                    skills: [
                        { name: 'Prayer', level: 99, baseLevel: 99 },
                        { name: 'Magic', level: 99, baseLevel: 99 },
                    ],
                    prayers: { prayerPoints: 99, activePrayers: new Array(15).fill(false) },
                    nearbyPlayers: [{ name: 'Runner', index: 1, x: 3069, z: 3640, distance: 2, combatLevel: 126 }],
                    combatEvents: [],
                    gameMessages: [],
                }),
                sendUseItem: (slot: number) => { events.push(`wear:${slot}@${tick}`); },
                sendSpellOnPlayer: (_idx: number, spell: number) => { events.push(`spell:${spell}@${tick}`); },
                sendInteractPlayer: () => {},
                sendTogglePrayer: () => {},
                sendWalk: () => {},
            },
        } as unknown as Session;

        const done = fightPlayer(session, 'Runner', {
            kit: { melee: [1231] },
            freeze: 'flee',
            smiteBurst: () => true,
            cap: 2,
            log: () => {},
        });
        const step = async () => { tick++; for (const fn of [...listeners]) fn(); await new Promise(r => setTimeout(r, 0)); };
        await step();
        await step();
        await done;
        // All 3 magic switches + Entangle fired on tick 601 (4 packets <= 5 packet/tick cap).
        expect(events).toEqual(['wear:0@601', 'wear:1@601', 'wear:2@601', `spell:${SPELLS.entangle}@601`]);
    });

    test('squad-ready gang-bait-3plus1 and stage-kit verifyPvpStageSupplies include BiS switches while enforcing strict 3+1 deathRisk across full worn+pack kit', () => {
        const gearRows = JSON.parse(readFileSync(join(process.cwd(), 'knowledge', 'gear.json'), 'utf8')) as Gear[];
        const gear = new Map(gearRows.map(g => [g.id, g]));
        const now = Date.now();
        const acct: Account = {
            name: 'SwitchBait',
            at: now,
            bankAt: now,
            pos: { x: 3092, z: 3496, level: 0 },
            levels: { attack: 99, strength: 99, defence: 99, hitpoints: 99, ranged: 99, magic: 99, prayer: 99 },
            quests: new Set(['lost city', 'dragon slayer', 'death plateau', 'underground pass']),
            worn: [],
            pack: [],
            bank: [
                { id: 2503, name: "Black d'hide body", count: 1 },    // 13.48k (keep #2, meleeDef 162, +30 rng, +50 magDef)
                { id: 2497, name: "Black d'hide chaps", count: 1 },   // 6.22k (keep #3, meleeDef 89, +17 rng, +28 magDef)
                { id: 1231, name: 'Dragon dagger(p)', count: 1 },     // 24k (keep #1)
                { id: 861, name: 'Magic shortbow', count: 1 },        // 1.6k (keep #4 with Protect Item)
                { id: 1495, name: "Klank's gauntlets", count: 1 },    // 6gp (+2 str)
                { id: 3105, name: 'Climbing boots', count: 1 },       // 12gp (+2 str)
                { id: RING_OF_RECOIL_ID, name: 'Ring of recoil', count: 1 }, // 900gp
                { id: 2412, name: 'Saradomin cape', count: 1 },       // 100gp (+10 magAtk)
                { id: 577, name: 'Wizard robe', count: 1 },           // 15gp (+3 magAtk)
                { id: 1727, name: 'Amulet of magic', count: 1 },      // 900gp (+10 magAtk)
                { id: 892, name: 'Rune arrow', count: 300 },
                { id: 175, name: 'Antipoison(3)', count: 2 },
                { id: 563, name: 'Law rune', count: 10 },
                { id: 556, name: 'Air rune', count: 50 },
                { id: 557, name: 'Earth rune', count: 50 },
                { id: 555, name: 'Water rune', count: 50 },
                { id: 561, name: 'Nature rune', count: 50 },
                { id: 385, name: 'Shark', count: 40 },
            ],
            prayerPoints: 99,
        };
        const pick = pickKit(acct, gear, RULES['gang-bait-3plus1']!, now);
        expect(pick.ready).toBe(true);
        expect(pick.zeroRisk?.ok).toBe(true);
        expect(pick.zeroRisk?.riskedWeapons4).toEqual([]);
        expect(pick.zeroRisk?.riskedValuableGear4).toEqual([]);
        expect(pick.worn.some(w => w.id === 1495)).toBe(true);
        expect(pick.worn.some(w => w.id === 3105)).toBe(true);
        expect(pick.worn.some(w => w.id === RING_OF_RECOIL_ID)).toBe(true);
        // Zero-cost BiS magic switches + Black d'hide body/chaps all fit inside zero-risk 3+1!
        const allIds = new Set([...pick.worn.map(w => w.id), ...pick.carried.map(c => c.id)]);
        expect(allIds.has(2412)).toBe(true);
        expect(allIds.has(577)).toBe(true);
        expect(allIds.has(1727)).toBe(true);
        expect(allIds.has(2503)).toBe(true);
        expect(allIds.has(2497)).toBe(true);

        // Even when an extra Rune platebody (65k) is also banked, gang-bait-3plus1 never lets a carried d'hide switch violate 3+1!
        const withPlate = pickKit({ ...acct, bank: [{ id: 1127, name: 'Rune platebody', count: 1 }, ...acct.bank] }, gear, RULES['gang-bait-3plus1']!, now);
        expect(withPlate.ready).toBe(true);
        expect(withPlate.zeroRisk?.ok).toBe(true);
        expect(withPlate.zeroRisk?.riskedWeapons4).toEqual([]);
        expect(withPlate.zeroRisk?.riskedValuableGear4).toEqual([]);

        const stage = verifyPvpStageSupplies({
            mode: 'bait',
            magicLevel: 99,
            equipment: pick.worn,
            inventory: [
                ...pick.carried,
                { id: 554, name: 'Fire rune', count: 10 },
                ...pick.foodRows.flatMap(r => Array.from({ length: r.count }, () => ({ id: r.id, name: r.name, count: 1 }))),
            ],
        });
        expect(stage.ok).toBe(true);
        expect(stage.hasRecoil).toBe(true);
        expect(stage.switchCoverage).toEqual({
            melee: true,
            ranged: true,
            magic: true,
            dhideTier: 'black',
            hasMagicSwitch: true,
        });
    });
});
