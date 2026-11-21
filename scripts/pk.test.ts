import { expect, test } from 'bun:test';
import {
    attackable, battleaxeWarcryMath, bestDamageSpell, bestFood, canCastChargeNow, castableFreeze, chargeVarpTicks, combatPrayers, dangerReason, defaultSpec, defaultStunSpec,
    estMaxHit, fightPlayer, freezeDuration, freezeSpell, hasStyle, isDying, ITEMS, killMessage, lowHealth, rewearStart, carriedPoison, carriedSplat, fledEnds, noteFightPoison, ownPoisonHit, poisonSplat, POISON_HOLD, specReasons,
    kitRotation, meleeWeaponDelay, negativeCastArmour, newSplats, nextStyle, nextTick, observePlayer, pickFakieWeapon,
    deathRisk, deathSkullFields, itemCostOf, ownSkull,
    pickFrozenKiteTile, pickWeighted, planPrayerTick, PRAYER, protectedStyles, seededRandom, shouldComboEat, skulled,
    SPELLS, STUNNED_SHOVE_SPOTANIM, weaponStyle, wildernessLevel,
} from './pk';

test('a weighted draw gives each index in the share of its weight', () => {
    const r = seededRandom(3), counts = [0, 0, 0, 0];
    for (let i = 0; i < 9900; i++) counts[pickWeighted([48, 35, 11, 5], r)]!++;
    expect(counts.map(n => Math.round(n / 100))).toEqual([48, 35, 11, 5]);
    expect(pickWeighted([0, 1], () => 0)).toBe(1);
    expect(pickWeighted([], () => 0.5)).toBe(0);
});

test('a seeded random source repeats for one seed and differs for another', () => {
    const draw = (seed: number) => { const r = seededRandom(seed); return [r(), r(), r()]; };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    for (const v of draw(7)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
});

test('newSplats counts each new hit splat on a player once, whoever our player faces', () => {
    const entity = { damageCycles: [0, 0, 0, 0], damageValues: [0, 0, 0, 0] }, client = { players: [null, entity] };
    const seen = { cycles: null as number[] | null };
    entity.damageCycles[0] = 170; entity.damageValues[0] = 9; // a splat from before the fight
    expect(newSplats(client, 1, seen)).toEqual([]);
    expect(newSplats(client, 1, seen)).toEqual([]);
    entity.damageCycles[1] = 240; entity.damageValues[1] = 18;
    entity.damageCycles[2] = 240; entity.damageValues[2] = 0; // a miss shows a splat of 0
    expect(newSplats(client, 1, seen)).toEqual([18, 0]);
    expect(newSplats(client, 1, seen)).toEqual([]);
    entity.damageCycles[0] = 310; entity.damageValues[0] = 22; // the first slot is used again
    expect(newSplats(client, 1, seen)).toEqual([22]);
    expect(newSplats({ players: [null, { headicons: 0 }] }, 1, { cycles: null })).toBeNull();
    expect(newSplats({}, 1, { cycles: null })).toBeNull();
});

test('Wilderness level follows wilderness_levels.rs2: surface from z 3520, the dungeon from z 9920', () => {
    expect(wildernessLevel(3519)).toBe(0);
    expect(wildernessLevel(3520)).toBe(1);
    expect(wildernessLevel(3555)).toBe(5);
    expect(wildernessLevel(3967)).toBe(56);
    expect(wildernessLevel(9920)).toBe(1);
    expect(wildernessLevel(9927)).toBe(1);
    expect(wildernessLevel(9928)).toBe(2);
});

test('a player is attackable when the combat gap fits the shallower Wilderness level', () => {
    expect(attackable({ z: 3555, combatLevel: 126 }, { z: 3555, combatLevel: 121 })).toBe(true);
    expect(attackable({ z: 3555, combatLevel: 126 }, { z: 3555, combatLevel: 120 })).toBe(false);
    expect(attackable({ z: 3700, combatLevel: 126 }, { z: 3555, combatLevel: 120 })).toBe(false);
    expect(attackable({ z: 3500, combatLevel: 126 }, { z: 3555, combatLevel: 126 })).toBe(false);
});

test('the freeze is the best one the Magic level allows', () => {
    expect(freezeSpell(99)).toBe(SPELLS.entangle);
    expect(freezeSpell(79)).toBe(SPELLS.entangle);
    expect(freezeSpell(78)).toBe(SPELLS.snare);
    expect(freezeSpell(50)).toBe(SPELLS.snare);
    expect(freezeSpell(20)).toBe(SPELLS.bind);
    expect(freezeSpell(19)).toBeNull();
});

test('castableFreeze and freezeDuration respect runes and Protect from Magic halving', () => {
    const runes = (earth: number, water: number, nature: number) => [
        { id: ITEMS.earthRune, count: earth },
        { id: ITEMS.waterRune, count: water },
        { id: ITEMS.natureRune, count: nature },
    ];
    expect(castableFreeze(99, runes(5, 5, 4))).toBe(SPELLS.entangle);
    expect(castableFreeze(99, runes(4, 4, 3))).toBe(SPELLS.snare);
    expect(castableFreeze(99, runes(3, 3, 2))).toBe(SPELLS.bind);
    expect(castableFreeze(99, runes(2, 2, 1))).toBeNull();
    expect(freezeDuration(SPELLS.entangle, false)).toBe(24);
    expect(freezeDuration(SPELLS.entangle, true)).toBe(12);
    expect(freezeDuration(SPELLS.snare, true)).toBe(8);
    expect(freezeDuration(SPELLS.bind, true)).toBe(4);
});

test('bestDamageSpell selects the strongest fire spell for Magic level and carried runes', () => {
    expect(bestDamageSpell(75, [{ id: ITEMS.bloodRune, count: 1 }])).toBe(SPELLS.fireWave);
    expect(bestDamageSpell(75, [{ id: ITEMS.deathRune, count: 1 }])).toBe(SPELLS.fireBlast);
    expect(bestDamageSpell(50, [{ id: ITEMS.chaosRune, count: 1 }])).toBe(SPELLS.fireBolt);
    expect(bestDamageSpell(20, [{ id: ITEMS.mindRune, count: 1 }])).toBe(SPELLS.fireStrike);
    expect(bestDamageSpell(99, [])).toBe(SPELLS.fireWave);
});

test('combatPrayers activates Steel Skin + Protect Item + overhead and toggles melee boosts only on melee turns', () => {
    const melee = combatPrayers(99, PRAYER.melee, true);
    expect(melee.want).toEqual([PRAYER.item, PRAYER.steelSkin, PRAYER.melee, PRAYER.ultimateStrength, PRAYER.incredibleReflexes]);
    expect(melee.off).toEqual([]);
    const magic = combatPrayers(99, PRAYER.magic, false);
    expect(magic.want).toEqual([PRAYER.item, PRAYER.steelSkin, PRAYER.magic]);
    expect(magic.off).toEqual([PRAYER.ultimateStrength, PRAYER.incredibleReflexes]);
    const low = combatPrayers(15, PRAYER.melee, true);
    expect(low.want).toEqual([PRAYER.rockSkin, PRAYER.superhumanStrength, PRAYER.clarityOfThought]);
});

test('defaultSpec identifies special-attack weapons from kit', () => {
    expect(defaultSpec({ melee: [1231, 1201], ranged: [861] })).toEqual({
        kit: [1231, 1201], bar: 'combat_stabsword:specbar', cost: 250, below: 0.65, style: 'melee',
    });
    expect(defaultSpec({ melee: [1305, 1201] })?.bar).toBe('combat_hacksword:specbar');
    expect(defaultSpec({ ranged: [861] })).toEqual({
        kit: [861], bar: 'combat_bow:specbar', cost: 350, below: 0.5, style: 'ranged',
    });
    expect(defaultSpec({ magic: [1401] })).toBeUndefined();
});

test('negativeCastArmour orders penalizing armour by torso, legs, shield, helm and skips melee', () => {
    const worn = [
        { id: 1163, slot: 0 }, // rune_full_helm
        { id: 1127, slot: 4 }, // rune_platebody
        { id: 1201, slot: 5 }, // rune_kiteshield
        { id: 1079, slot: 7 }, // rune_platelegs
    ];
    expect(negativeCastArmour(worn, 'melee', new Set())).toEqual([]);
    expect(negativeCastArmour(worn, 'magic', new Set()).map(x => x.slot)).toEqual([4, 7, 5, 0]);
    // knowledge/gear.json: the kiteshield has -2 ranged attack, as the helm does (ties go by slot).
    expect(negativeCastArmour(worn, 'ranged', new Set()).map(x => x.slot)).toEqual([4, 7, 0, 5]);
});

test('style turns follow the rotation and skip a style that is not usable', () => {
    const rotation = ['magic', 'ranged', 'melee'] as const;
    expect(nextStyle(rotation, -1, () => true)).toEqual({ style: 'magic', index: 0 });
    expect(nextStyle(rotation, 0, () => true)).toEqual({ style: 'ranged', index: 1 });
    expect(nextStyle(rotation, 2, () => true)).toEqual({ style: 'magic', index: 0 });
    expect(nextStyle(rotation, 0, s => s !== 'ranged')).toEqual({ style: 'melee', index: 2 });
    expect(nextStyle(rotation, 0, () => false)).toBeNull();
});

test('a style is usable only with a non-empty kit, so an empty magic list wastes no turn', () => {
    expect(hasStyle({ magic: [] }, 'magic')).toBe(false);
    expect(hasStyle({}, 'magic')).toBe(false);
    expect(hasStyle({ magic: [1401] }, 'magic')).toBe(true);
    const rotation = ['magic', 'ranged', 'melee'] as const;
    expect(nextStyle(rotation, -1, s => hasStyle({ magic: [], ranged: [861] }, s))).toEqual({ style: 'ranged', index: 1 });
});

test('a kill is read from any of the eleven killer messages, whatever the name case', () => {
    expect(killMessage("Pkdt2z6hk didn't stand a chance against you.", 'pkdt2z6hk')).toBe(true);
    expect(killMessage('With a crushing blow you finish Pkdt2z6hk.', 'pkdt2z6hk')).toBe(true);
    expect(killMessage('Iron Pker has won a free ticket to Lumbridge.', 'iron_pker')).toBe(true);
    expect(killMessage('You have defeated Someone Else.', 'pkdt2z6hk')).toBe(false);
    expect(killMessage('Oh dear you are dead!', 'pkdt2z6hk')).toBe(false);
});

test('overhead protect prayers and the skull are read from the head icon bits', () => {
    expect([...protectedStyles(0)]).toEqual([]);
    expect([...protectedStyles(1 << 3)]).toEqual(['melee']);
    expect([...protectedStyles(1 << 4)]).toEqual(['ranged']);
    expect([...protectedStyles((1 << 5) | 1)]).toEqual(['magic']);
    expect(skulled(1 | (1 << 5))).toBe(true);
    expect(skulled(1 << 5)).toBe(false);
});

test('a worn weapon attacks with the style its object name implies', () => {
    expect(weaponStyle(861)).toBe('ranged');   // magic_shortbow
    expect(weaponStyle(1401)).toBe('magic');   // mystic_fire_staff
    expect(weaponStyle(2417)).toBe('magic');   // zamorak_staff
    expect(weaponStyle(1231)).toBe('melee');   // dragon_dagger_p
    expect(weaponStyle(1305)).toBe('melee');   // dragon_longsword
    expect(weaponStyle(-1)).toBe('melee');
    expect(weaponStyle(undefined)).toBe('melee');
});

test("another player's head icons and worn items are read from the client's player entity", () => {
    const appearance = new Uint16Array(12); appearance[3] = 861 + 512; appearance[4] = 1127 + 512; appearance[8] = 7;
    const client = { players: [null, { headicons: (1 << 5) | 1, appearance, health: 30, totalHealth: 99 }] };
    const seen = observePlayer(client, 1)!;
    expect(seen.headicons).toBe(33);
    expect(seen.worn[3]).toBe(861);
    expect(seen.worn[4]).toBe(1127);
    expect(seen.worn[8]).toBe(-1);
    expect(seen.health / seen.totalHealth).toBeCloseTo(0.303, 2);
    expect(lowHealth(seen, 0.5)).toBe(true);
    expect(lowHealth(seen, 0.25)).toBe(false);
    expect(lowHealth({ ...seen, totalHealth: 0 }, 0.5)).toBe(false);
    expect(observePlayer(client, 0)).toBeNull();
    expect(observePlayer(undefined, 1)).toBeNull();
});

test('bestFood eats the best food held, then any other edible item', () => {
    const item = (name: string, eat = true) => ({ name, optionsWithIndex: eat ? [{ text: 'Eat' }] : [{ text: 'Drop' }] });
    expect(bestFood([item('Trout'), item('Shark'), item('Salmon')])?.name).toBe('Shark');
    expect(bestFood([item('Trout'), item('Salmon')])?.name).toBe('Salmon');
    expect(bestFood([item('Cake'), item('Law rune', false)])?.name).toBe('Cake');
    expect(bestFood([item('Law rune', false)])).toBeUndefined();
});

test('estMaxHit is about a quarter of combat, at least 10', () => {
    expect(estMaxHit(126)).toBe(32);
    expect(estMaxHit(20)).toBe(10);
});

test('dangerReason: no food near the max hit, a pile, a lost damage race, no prayer', () => {
    const base = { hp: 80, maxHp: 99, food: true, prayer: 50, oppMax: 30, hits: [] as { tick: number; damage: number; src: number }[], dealt: [] as { tick: number; damage: number }[], now: 100 };
    expect(dangerReason(base)).toBeNull();
    expect(dangerReason({ ...base, food: false, hp: 45 })).toMatch(/no food/);
    expect(dangerReason({ ...base, food: false, hp: 46 })).toBeNull();
    expect(dangerReason({ ...base, hits: [{ tick: 95, damage: 5, src: 1 }, { tick: 98, damage: 5, src: 2 }] })).toMatch(/2 players/);
    expect(dangerReason({ ...base, hits: [{ tick: 80, damage: 5, src: 1 }, { tick: 98, damage: 5, src: 2 }] })).toBeNull(); // first hit too old
    const race = { ...base, hp: 55, hits: [{ tick: 80, damage: 20, src: 1 }, { tick: 90, damage: 15, src: 1 }], dealt: [{ tick: 85, damage: 10 }] };
    expect(dangerReason(race)).toMatch(/losing the race/);
    expect(dangerReason({ ...race, hp: 60 })).toBeNull(); // still over 60%
    expect(dangerReason({ ...base, prayer: 0, hp: 49 })).toMatch(/no prayer/);
});

test('a tick wait resolves false once the session ends, so loops stop instead of hanging or spinning', async () => {
    let fire: (() => void) | undefined, endSession: (() => void) | undefined;
    const session = { onTick: (cb: () => void) => { fire = cb; return () => { fire = undefined; }; }, ended: new Promise<{ reason: string }>(r => { endSession = () => r({ reason: 'disconnected' }); }) };
    const first = nextTick(session);
    fire!();
    expect(await first).toBe(true);
    const second = nextTick(session);
    endSession!();
    expect(await second).toBe(false);
    expect(await nextTick(session)).toBe(false);
});

test('fightPlayer records same-tick multi-hit events/messages, executes same-tick spec, and skips ranged melee when self-frozen', async () => {
    let tick = 10;
    const actions: string[] = [];
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512;
    const client = {
        var: { 300: 1000, 301: 0, 172: 1 },
        players: [null, { headicons: 0, appearance, health: 20, totalHealth: 99 }],
    };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 1, id: 861, name: 'Magic shortbow', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ],
        equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [
            { observationId: 5, tick: 11, type: 'damage_dealt', targetType: 'other_player', damage: 18 },
            { observationId: 5, tick: 11, type: 'damage_dealt', targetType: 'other_player', damage: 14 },
        ],
        gameMessages: [],
    };
    const session: any = {
        client,
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                if (tick === 12) {
                    state.gameMessages = [
                        { observationId: 9, tick: 12, type: 0, text: 'A magical force stops you from moving!' },
                        { observationId: 9, tick: 12, type: 0, text: 'You have defeated Dummy.' },
                    ];
                }
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => { actions.push(`use:${slot}:${op}`); },
            sendClickComponent: (id: number) => { actions.push(`click:${id}`); },
            sendInteractPlayer: (idx: number, op: number) => { actions.push(`attack:${idx}:${op}`); },
            sendSpellOnPlayer: (idx: number, spell: number) => { actions.push(`spell:${idx}:${spell}`); },
            sendTogglePrayer: (p: number) => { state.prayers.activePrayers[p] = !state.prayers.activePrayers[p]; actions.push(`pray:${p}`); },
        },
    };
    const res = await fightPlayer(session, 'Dummy', {
        kit: { magic: [1401], ranged: [861], melee: [1231] },
        spec: { kit: [1231], bar: 'combat_stabsword:specbar', cost: 250, below: 0.5 },
        log: () => {},
    });
    expect(res.outcome).toBe('kill');
    expect(res.dealt).toBe(32); // both same-tick observationId=5 hits counted
    expect(res.specs).toBe(1);
    expect(actions.filter(a => !a.startsWith('pray:'))).toEqual(['use:0:2', 'click:7562', 'attack:1:2']);
    expect(actions.length).toBeLessThanOrEqual(5); // respects 5-packet USER_EVENT limit
});

test('fightPlayer holds its special while the target runs: the freeze goes first, and a bow special waits for bow range', async () => {
    // The target starts 3 tiles east and runs 2 tiles east each tick, so it is beyond a shortbow's 7 tiles at the next turn.
    const run = async (freeze: 'flee' | undefined) => {
        let tick = 10;
        const actions: string[] = [];
        const target = { index: 1, name: 'Dummy', combatLevel: 126, x: 3097, z: 3555, distance: 3 };
        const rune = (slot: number, id: number, count: number) => ({ slot, id, name: 'Rune', count, optionsWithIndex: [] });
        const state: any = {
            player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
            skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
            prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
            inventory: [
                { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
                { slot: 1, id: 861, name: 'Magic shortbow', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
                rune(2, 557, 50), rune(3, 555, 50), rune(4, 561, 50),
            ],
            equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
            nearbyPlayers: [target],
            combatEvents: [],
            gameMessages: [],
        };
        const session: any = {
            client: { var: { 300: 1000, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance: new Uint16Array(12), health: 50, totalHealth: 99 }] },
            tick: () => tick,
            ended: new Promise(() => {}),
            onTick: (cb: () => void) => { setTimeout(() => { tick++; target.x += 2; target.distance += 2; cb(); }, 0); return () => {}; },
            sdk: {
                getState: () => state,
                sendUseItem: (slot: number, op: number) => { actions.push(`use:${slot}:${op}`); },
                sendClickComponent: (id: number) => { actions.push(`click:${id}`); },
                sendInteractPlayer: (idx: number, op: number) => { actions.push(`attack:${idx}:${op}`); },
                sendSpellOnPlayer: (idx: number, spell: number) => { actions.push(`spell:${idx}:${spell}`); },
                sendTogglePrayer: (p: number) => { state.prayers.activePrayers[p] = !state.prayers.activePrayers[p]; },
                sendWalk: () => {},
            },
        };
        const res = await fightPlayer(session, 'Dummy', {
            kit: { magic: [1401], ranged: [861], melee: [1231] }, freeze, cap: 8, log: () => {},
            spec: { kit: [1231], bar: 'combat_stabsword:specbar', cost: 250, below: 0.4 },
        });
        return { res, actions };
    };
    const held = await run('flee');
    expect(held.res.specs).toBe(0);
    expect(held.res.freezes).toBe(1);
    expect(held.actions).toContain(`spell:1:${SPELLS.entangle}`);
    expect(held.actions.some(a => a.startsWith('click:'))).toBe(false);
    const far = await run(undefined);
    expect(far.res.specs).toBe(0); // 13 tiles away: the bow special would stay armed with its energy
    expect(far.actions.some(a => a.startsWith('click:'))).toBe(false);
    expect(far.res.attacks.magic + far.res.attacks.ranged).toBe(2);
});

test('fightPlayer reserves 2 USER_EVENT packets for non-adjacent attack and re-equips inventory tank body on melee turns', async () => {
    let tick = 10;
    const perTick: string[][] = [];
    const appearance = new Uint16Array(12);
    appearance[3] = 861 + 512;
    const client = {
        var: { 300: 0, 301: 0, 172: 1 },
        players: [null, { headicons: 0, appearance, health: 99, totalHealth: 99 }],
    };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 1, id: 1201, name: 'Rune kiteshield', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 2, id: 1127, name: 'Rune platebody', count: 1, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
        ],
        equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
        // Distance > 1: interactPlayer emits MOVE_OPCLICK + OPPLAYER2 (2 USER_EVENT packets).
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3098, z: 3555, distance: 4 }],
        combatEvents: [],
        gameMessages: [],
    };
    const session: any = {
        client,
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                perTick.push([]);
                if (tick === 12) {
                    state.gameMessages = [{ observationId: 1, tick: 12, type: 0, text: 'You have defeated Dummy.' }];
                }
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => { perTick[perTick.length - 1]!.push(`use:${slot}:${op}`); },
            sendClickComponent: (id: number) => { perTick[perTick.length - 1]!.push(`click:${id}`); },
            sendInteractPlayer: (idx: number, op: number) => { perTick[perTick.length - 1]!.push(`attack:${idx}:${op}`); },
            sendSpellOnPlayer: (idx: number, spell: number) => { perTick[perTick.length - 1]!.push(`spell:${idx}:${spell}`); },
            sendTogglePrayer: (p: number) => { state.prayers.activePrayers[p] = !state.prayers.activePrayers[p]; perTick[perTick.length - 1]!.push(`pray:${p}`); },
        },
    };
    const res = await fightPlayer(session, 'Dummy', {
        kit: { melee: [1231, 1201] },
        rotation: ['melee'],
        freeze: false,
        log: () => {},
    });
    expect(res.outcome).toBe('kill');
    const firstTick = perTick[0]!;
    // Equips dagger (slot 0), shield (slot 1), and tank platebody (slot 2) discovered from inventory,
    // leaving 2 packets in the 5-packet budget for non-adjacent attack (3 equips + 2 attack = 5 USER_EVENT packets).
    expect(firstTick).toContain('use:0:2');
    expect(firstTick).toContain('use:1:2');
    expect(firstTick).toContain('use:2:2');
    expect(firstTick).toContain('attack:1:2');
    const userEvents = firstTick.filter(a => a.startsWith('pray:') || a.startsWith('use:') || a.startsWith('click:')).length + 2;
    expect(userEvents).toBeLessThanOrEqual(5);
});



test('kitRotation keeps an order the kit can use and falls back to the full order for a kit with none of its styles', () => {
    expect(kitRotation(['ranged', 'melee'], { ranged: [861], melee: [1231] })).toEqual(['ranged', 'melee']);
    expect(kitRotation(['ranged', 'melee'], { magic: [1401], melee: [1231] })).toEqual(['ranged', 'melee']);
    expect(kitRotation(['ranged', 'melee'], { magic: [1401] })).toEqual(['magic', 'ranged', 'melee']);
    expect(kitRotation(undefined, { melee: [1231] })).toEqual(['magic', 'ranged', 'melee']);
});

test('a thrown weapon attacks one tick sooner than a shortbow, and Rapid takes one tick off each', async () => {
    const { rangedWeaponDelay } = await import('./pk');
    const names = new Map([[861, 'magic_shortbow'], [868, 'rune_knife'], [811, 'rune_dart'], [5667, 'rune_knife_p']]);
    expect([rangedWeaponDelay([861], false, names), rangedWeaponDelay([861], true, names)]).toEqual([4, 3]);
    expect([rangedWeaponDelay([868, 1201], false, names), rangedWeaponDelay([868, 1201], true, names)]).toEqual([3, 2]);
    expect([rangedWeaponDelay([811], true, names), rangedWeaponDelay([5667], true, names), rangedWeaponDelay(undefined, true, names)]).toEqual([2, 2, 3]);
});

test('defaultSpec supports dragon halberd alongside dragon dagger, longsword, mace, claws and spear', () => {
    const names = new Map([[3204, 'dragon_halberd'], [3122, 'rune_claws'], [1249, 'dragon_spear']]);
    expect(defaultSpec({ melee: [3204] }, names)).toEqual({ kit: [3204], bar: 'combat_polearm:specbar', cost: 300, below: 0.6, style: 'melee' });
    expect(defaultSpec({ melee: [3122] }, names)).toEqual({ kit: [3122], bar: 'combat_claw:specbar', cost: 250, below: 0.6, style: 'melee' });
    expect(defaultSpec({ melee: [1249] }, names)).toMatchObject({ bar: 'combat_spear:specbar', stun: 4 });
});

test('fightPlayer eats standard food and karambwan on the same tick with comboFood, and frees a full pack slot for worn glory escape', async () => {
    let tick = 10;
    const perTick: string[][] = [];
    const client = { var: { 300: 0, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance: new Uint16Array(12), health: 99, totalHealth: 99 }] };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 35, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: ITEMS.shark, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { slot: 1, id: ITEMS.karambwan, name: 'Cooked karambwan', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            ...Array.from({ length: 26 }, (_, i) => ({ slot: i + 2, id: 556, name: 'Air rune', count: 1, optionsWithIndex: [] })),
        ],
        equipment: [{ slot: 2, id: ITEMS.glory[0]!, name: 'Amulet of glory(4)', count: 1, optionsWithIndex: [] }, { slot: 3, id: 861, name: 'Magic shortbow', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3098, z: 3555, distance: 4 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        client, tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                perTick.push([]);
                if (tick === 18) state.player.worldZ = 3087; // Teleported out of Wilderness after glory slot freed and unequipped
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => {
                perTick[perTick.length - 1]!.push(`use:${slot}:${op}`);
                state.inventory = state.inventory.filter((x: any) => x.slot !== slot);
            },
            sendUseEquipmentItem: (slot: number, op: number) => {
                perTick[perTick.length - 1]!.push(`unequip:${slot}:${op}`);
                state.equipment = state.equipment.filter((x: any) => x.slot !== slot);
                state.inventory.push({ slot: 0, id: ITEMS.glory[0]!, name: 'Amulet of glory(4)', count: 1, optionsWithIndex: [{ text: 'Rub', opIndex: 1 }] });
            },
            sendClickComponent: (id: number) => { perTick[perTick.length - 1]!.push(`click:${id}`); },
            sendInteractPlayer: () => {},
            sendWalk: (x: number, z: number) => { perTick[perTick.length - 1]!.push(`walk:${x},${z}`); },
            sendTogglePrayer: () => {},
        },
    };
    const res = await fightPlayer(session, 'Dummy', {
        kit: { ranged: [861] }, rotation: ['ranged'], freeze: false, prayerFlick: false,
        eatAt: 50, comboFood: true, comboAt: 40, flee: true, escapeAt: 50, log: () => {},
    });
    expect(res.eaten).toBe(2); // Ate Shark + Cooked karambwan in the first tick window
    expect(perTick[0]).toEqual(['use:0:1', 'use:1:1']);
    expect(perTick.flat()).toContain('unequip:2:1');
    expect(perTick.flat()).toContain('use:0:1');
});

test('PRAYER indices match the 15 prayers (0-14) in the 2004 server config', async () => {
    const { PRAYER } = await import('./pk');
    const { PRAYER_NAMES } = await import('../vendor/rs-sdk/sdk/types');
    expect(PRAYER_NAMES.length).toBe(15);
    expect(Object.values(PRAYER).every(idx => idx >= 0 && idx < PRAYER_NAMES.length)).toBe(true);
    expect('smite' in PRAYER).toBe(false);
});

test('fightPlayer drinks Magic potion when magic kit is present and Magic is unboosted', async () => {
    const { fightPlayer } = await import('./pk');
    let tick = 10;
    const used: number[] = [];
    const state: any = {
        tick,
        player: { worldX: 3060, worldZ: 3880, level: 0, hp: 99, maxHp: 99, combatLevel: 100 },
        skills: [
            { name: 'Hitpoints', level: 99, baseLevel: 99 },
            { name: 'Magic', level: 80, baseLevel: 80 },
            { name: 'Defence', level: 99, baseLevel: 99 },
            { name: 'Prayer', level: 99, baseLevel: 99 },
        ],
        prayers: { activePrayers: new Array(15).fill(false), prayerPoints: 99 },
        inventory: [
            { id: 3040, slot: 0, count: 1, name: 'Magic potion(4)', optionsWithIndex: [{ text: 'Drink', opIndex: 1 }] },
            { id: 565, slot: 1, count: 50, name: 'Blood rune', optionsWithIndex: [] },
            { id: 554, slot: 2, count: 50, name: 'Fire rune', optionsWithIndex: [] },
            { id: 556, slot: 3, count: 50, name: 'Air rune', optionsWithIndex: [] },
        ],
        equipment: [{ id: 2417, slot: 3, count: 1, name: 'Staff of zamorak', optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 2, name: 'Dummy', x: 3060, z: 3884, combatLevel: 100, distance: 4 }],
        combatEvents: [], gameMessages: [], dialog: { isOpen: false },
    };
    const session: any = {
        name: 'MagePker',
        client: { getPlayer: () => undefined, objType: () => undefined },
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (fn: () => void) => {
            setTimeout(() => { tick++; state.tick = tick; fn(); }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number) => {
                used.push(state.inventory[slot]?.id);
                state.skills[1]!.level = 84;
            },
            sendWalk: () => {},
            sendTogglePrayer: () => {},
            sendSpellOnPlayer: () => {},
            sendClickComponent: () => {},
        },
    };
    await fightPlayer(session, 'Dummy', {
        kit: { magic: [2417] }, rotation: ['magic'], damageSpell: 1192,
        freeze: false, prayerFlick: false, cap: 5, log: () => {},
    });
    expect(used).toContain(3040);
});

test('planPrayerTick handles zeroDrainFlick (non-truncating step-down preserving Steel Skin + overhead) and offensiveFlick pre-enable', () => {
    const active = new Array(15).fill(false);
    // 5 active prayers at start (Protect Item, Steel Skin, Protect from Melee, Ultimate Strength, Incredible Reflexes)
    for (const p of [PRAYER.item, PRAYER.steelSkin, PRAYER.melee, PRAYER.ultimateStrength, PRAYER.incredibleReflexes]) active[p] = true;
    // Tick 13 (3 ticks after prayerDrainAt=10, >= 3 ticks before nextAttack=20): step down 5 -> 2 (keeping overhead + Steel Skin).
    const step = planPrayerTick({
        now: 13, nextAttack: 20, lastAttackAt: 9, walkingToMelee: false, prayerBase: 99, overhead: PRAYER.melee,
        activePrayers: active, prayerDrainAt: 10, flickAt: 10, flickEvery: 4,
        zeroDrainFlick: true, prayerFlick: true, offensiveFlick: false,
        upcomingStyle: 'melee', specMeleeLikely: false, defencePrayer: true, protectItem: true, budget: 5,
    });
    expect(step.didFlick).toBe(false);
    expect(step.nextDrainAt).toBe(10);
    expect(step.toggles).not.toContain(PRAYER.melee);
    expect(step.toggles).not.toContain(PRAYER.steelSkin);
    for (const p of step.toggles) active[p] = !active[p];
    expect(active.filter(Boolean).length).toBe(2);
    expect(active[PRAYER.melee]).toBe(true);
    expect(active[PRAYER.steelSkin]).toBe(true);

    // Tick 14 (4 ticks after prayerDrainAt=10): full 2-prayer off+on cycle clears prayer_drain timer cleanly inside 4 packets and leaves both ON.
    const flick = planPrayerTick({
        now: 14, nextAttack: 20, lastAttackAt: 9, walkingToMelee: false, prayerBase: 99, overhead: PRAYER.melee,
        activePrayers: active, prayerDrainAt: 10, flickAt: 10, flickEvery: 4,
        zeroDrainFlick: true, prayerFlick: true, offensiveFlick: false,
        upcomingStyle: 'melee', specMeleeLikely: false, defencePrayer: true, protectItem: true, budget: 5,
    });
    expect(flick.didFlick).toBe(true);
    expect(flick.nextDrainAt).toBe(14);
    expect(flick.toggles.length).toBe(4);
    for (const p of flick.toggles) active[p] = !active[p];
    expect(active[PRAYER.melee]).toBe(true);
    expect(active[PRAYER.steelSkin]).toBe(true);

    // zeroDrainFlick must never truncate a 3-prayer flick when active.length * 2 > budget (would leave Steel Skin off).
    const threeActive = new Array(15).fill(false);
    for (const p of [PRAYER.item, PRAYER.steelSkin, PRAYER.melee]) threeActive[p] = true;
    const noTruncate = planPrayerTick({
        now: 14, nextAttack: 16, lastAttackAt: 11, walkingToMelee: false, prayerBase: 99, overhead: PRAYER.melee,
        activePrayers: threeActive, prayerDrainAt: 10, flickAt: 10, flickEvery: 4,
        zeroDrainFlick: true, prayerFlick: true, offensiveFlick: false,
        upcomingStyle: 'ranged', specMeleeLikely: false, defencePrayer: true, protectItem: true, budget: 5,
    });
    expect(noTruncate.didFlick).toBe(false);

    // offensiveFlick drops Ultimate Strength + Incredible Reflexes on cooldown ticks after melee hit, then pre-enables on nextAttack - 1.
    const offState = new Array(15).fill(false);
    offState[PRAYER.melee] = true; offState[PRAYER.ultimateStrength] = true; offState[PRAYER.incredibleReflexes] = true;
    const dropOff = planPrayerTick({
        now: 10, nextAttack: 13, lastAttackAt: 9, walkingToMelee: false, prayerBase: 99, overhead: PRAYER.melee,
        activePrayers: offState, prayerDrainAt: 8, flickAt: 8, flickEvery: 4,
        zeroDrainFlick: false, prayerFlick: false, offensiveFlick: true,
        upcomingStyle: 'melee', specMeleeLikely: false, defencePrayer: false, protectItem: false, budget: 5,
    });
    expect(dropOff.toggles).toContain(PRAYER.ultimateStrength);
    expect(dropOff.toggles).toContain(PRAYER.incredibleReflexes);
    const preOn = planPrayerTick({
        now: 12, nextAttack: 13, lastAttackAt: 9, walkingToMelee: false, prayerBase: 99, overhead: PRAYER.melee,
        activePrayers: new Array(15).fill(false), prayerDrainAt: -1, flickAt: 8, flickEvery: 4,
        zeroDrainFlick: false, prayerFlick: false, offensiveFlick: true,
        upcomingStyle: 'melee', specMeleeLikely: false, defencePrayer: false, protectItem: false, budget: 5,
    });
    expect(preOn.toggles).toContain(PRAYER.ultimateStrength);
    expect(preOn.toggles).toContain(PRAYER.incredibleReflexes);
});

test('defaultSpec/defaultStunSpec/meleeWeaponDelay cover all 3 dragon spears and rev-289 weapon speeds', () => {
    const names = new Map([
        [1231, 'dragon_dagger_p'], [1201, 'rune_kiteshield'],
        [1249, 'dragon_spear'], [1263, 'dragon_spear_p'], [3176, 'tbwt_dragon_spear_kp'],
        [3204, 'dragon_halberd'], [1319, 'rune_2h_sword'], [1305, 'dragon_longsword'],
    ]);
    expect(defaultSpec({ melee: [1263] }, names)).toEqual({ kit: [1263], bar: 'combat_spear:specbar', cost: 250, below: 0.55, style: 'melee', stun: 4 });
    expect(defaultSpec({ melee: [3176] }, names)).toEqual({ kit: [3176], bar: 'combat_spear:specbar', cost: 250, below: 0.55, style: 'melee', stun: 4 });
    expect(defaultStunSpec({ melee: [1231, 1201, 1249] }, names)).toEqual({ kit: [1249], bar: 'combat_spear:specbar', cost: 250, below: 0.55, style: 'melee', stun: 4 });
    expect(defaultStunSpec({ melee: [1231, 1201] }, names)).toBeUndefined();
    expect(meleeWeaponDelay([1249], names)).toBe(6);
    expect(meleeWeaponDelay([3176], names)).toBe(6);
    expect(meleeWeaponDelay([3204], names)).toBe(7);
    expect(meleeWeaponDelay([1319], names)).toBe(7);
    expect(meleeWeaponDelay([1305], names)).toBe(5);
    expect(meleeWeaponDelay([1231], names)).toBe(4);
});

test('shouldComboEat avoids non-KO karambwan suspension, and fightPlayer fixes karambwan delay timing', async () => {
    // At 56 HP vs 126 cb (oppMax=32, eatAt=65), Shark alone is eaten (no karambwan p_delay(2)).
    expect(shouldComboEat({ hp: 56, maxHp: 99, oppMax: 32, eatAt: 65, comboFood: true })).toBe(false);
    // At 31 HP (<= oppMax), combo-eat triggers to survive burst KO.
    expect(shouldComboEat({ hp: 31, maxHp: 99, oppMax: 32, eatAt: 65, comboFood: true })).toBe(true);
    expect(shouldComboEat({ hp: 20, maxHp: 99, oppMax: 32, eatAt: 65, comboFood: false })).toBe(false);

    let tick = 10;
    const perTick: string[][] = [];
    const client = { var: { 300: 0, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance: new Uint16Array(12), health: 99, totalHealth: 99 }] };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 58, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: ITEMS.shark, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { slot: 1, id: ITEMS.karambwan, name: 'Cooked karambwan', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        ],
        equipment: [{ slot: 3, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        client, tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                perTick.push([]);
                if (tick === 11) {
                    // After eating Shark (+20 -> 78) cleanly without karambwan, bot should attack on tick 14 (11 + 3), not blocked 4 ticks by p_delay(2).
                }
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => {
                perTick[perTick.length - 1]!.push(`use:${slot}:${op}`);
                if (slot === 0) state.player.hp += 20;
                state.inventory = state.inventory.filter((x: any) => x.slot !== slot);
            },
            sendClickComponent: () => {},
            sendInteractPlayer: (idx: number, op: number) => { perTick[perTick.length - 1]!.push(`attack:${idx}:${op}@${tick}`); },
            sendTogglePrayer: () => {},
        },
    };
    const res = await fightPlayer(session, 'Dummy', {
        kit: { melee: [1231] }, rotation: ['melee'], eatAt: 65, comboFood: true,
        freeze: false, prayerFlick: false, cap: 5, log: () => {},
    });
    expect(res.eaten).toBe(1); // Only Shark eaten at 58 HP; Cooked karambwan spared!
    expect(perTick[0]).toEqual(['use:0:1']);
    expect(perTick.flat()).toContain('attack:1:2@14'); // Attacks right on tick 11+3=14
});

test('pickFrozenKiteTile supports stepUnderFrozen, 4-corner diagonalFrozen, and clamps freeze kites to 10 tiles', () => {
    // Same-tile step-under moves onto target tile and rests once there.
    expect(pickFrozenKiteTile({ at: { x: 3092, z: 3555 }, target: { x: 3095, z: 3555 }, stepUnder: true, frozen: true })).toEqual({ x: 3095, z: 3555 });
    expect(pickFrozenKiteTile({ at: { x: 3095, z: 3555 }, target: { x: 3095, z: 3555 }, stepUnder: true, frozen: true })).toBeNull();
    // Diagonal picks an accessible alternate corner when primary preferred corner is blocked.
    expect(pickFrozenKiteTile({
        at: { x: 3097, z: 3555 }, target: { x: 3095, z: 3555 }, diagonal: true, frozen: true,
        canWalkTo: (x, z) => !(x === 3096 && z === 3556),
    })).toEqual({ x: 3096, z: 3554 });
    // Clamp freeze kite distance <= 10 so pvp_frozen walktrigger never breaks.
    const clamped = pickFrozenKiteTile({ at: { x: 3096, z: 3555 }, target: { x: 3095, z: 3555 }, kiteFrozen: 14, frozen: true });
    expect(clamped).toEqual({ x: 3105, z: 3555 });
});

test('pickFakieWeapon and dragon spear spotanim 254 trigger stunShare overlap and burstOnStun', async () => {
    const names = new Map([[1401, 'mystic_fire_staff'], [861, 'magic_shortbow'], [1231, 'dragon_dagger_p'], [1249, 'dragon_spear']]);
    const decoy = pickFakieWeapon({
        kit: { magic: [1401], ranged: [861], melee: [1231] },
        realStyle: 'magic',
        preferred: true,
        inventory: [
            { id: 1231, slot: 0, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { id: 861, slot: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ],
        equipment: [{ id: 1401, slot: 3 }],
        names,
    });
    expect(decoy?.style).toBe('melee');

    let tick = 10;
    const actions: string[] = [];
    const enemyEntity = { headicons: 0, appearance: new Uint16Array(12), health: 90, totalHealth: 99, spotanimId: -1 };
    const stunShare = { clock: () => tick, until: 15, stunnedUntil: 15, overlap: 1 };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 1, id: 1249, name: 'Dragon spear', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ],
        equipment: [{ slot: 3, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        name: 'BurstMate',
        client: { var: { 300: 1000, 301: 0, 172: 1 }, players: [null, enemyEntity] },
        tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                if (tick === 11) enemyEntity.spotanimId = STUNNED_SHOVE_SPOTANIM;
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => { actions.push(`use:${slot}:${op}@${tick}`); },
            sendClickComponent: (id: number) => { actions.push(`click:${id}@${tick}`); },
            sendInteractPlayer: (idx: number, op: number) => { actions.push(`attack:${idx}:${op}@${tick}`); },
            sendTogglePrayer: () => {},
        },
    };
    // With target high HP (90/99) and stunned spotanim 254 active, burstOnStun fires DDS spec immediately instead of normal poke!
    const res = await fightPlayer(session, 'Dummy', {
        kit: { melee: [1231] }, rotation: ['melee'], freeze: false, prayerFlick: false,
        spec: defaultSpec({ melee: [1231] }), stunShare, burstOnStun: true, specReserve: 500, cap: 2, log: () => {},
    });
    expect(res.specs).toBe(1);
    expect(stunShare.stunnedUntil).toBeGreaterThanOrEqual(15);
    expect(actions.some(a => a.startsWith('click:7562@'))).toBe(true);
});

test('stunSpec fires secondary dragon spear spec right on stunShare overlap tick (until - 1) while target is still stunned', async () => {
    let tick = 10;
    const actions: string[] = [];
    const enemyEntity = { headicons: 0, appearance: new Uint16Array(12), health: 90, totalHealth: 99, spotanimId: -1 };
    const stunShare = { clock: () => tick, until: 15, stunnedUntil: 15, overlap: 1 };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 1, id: 1249, name: 'Dragon spear', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ],
        equipment: [{ slot: 3, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        name: 'SpearChainer',
        client: { var: { 300: 1000, 301: 0, 172: 1 }, players: [null, enemyEntity] },
        tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                if (tick === 11) enemyEntity.spotanimId = STUNNED_SHOVE_SPOTANIM;
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => {
                actions.push(`use:${slot}:${op}@${tick}`);
                if (slot === 1) state.equipment = [{ slot: 3, id: 1249, name: 'Dragon spear', count: 1, optionsWithIndex: [] }];
            },
            sendClickComponent: (id: number) => { actions.push(`click:${id}@${tick}`); },
            sendInteractPlayer: (idx: number, op: number) => { actions.push(`attack:${idx}:${op}@${tick}`); },
            sendTogglePrayer: () => {},
        },
    };
    const kit = { melee: [1231, 1249] };
    // Start at tick 11 (first attack), then melee delay 4 -> nextAttack at tick 15? Start with tick skipping to 14 on tick 14: wait melee rate 4 from 11 puts nextAttack at 15, right on until! Actually verify with stunShare.until = 15, attack at tick 14: set tick = 13 before first tick so tick 14 is first attack tick (`until - 1`, while `stunnedUntil` 15 is STILL active!).
    tick = 13;
    const res = await fightPlayer(session, 'Dummy', {
        kit, rotation: ['melee'], freeze: false, prayerFlick: false,
        spec: defaultSpec(kit), stunSpec: defaultStunSpec(kit), stunShare, burstOnStun: true, cap: 2, log: () => {},
    });
    expect(res.specs).toBe(1);
    expect(actions).toContain('use:1:2@14'); // equipped dragon spear on exact overlap tick (until - 1 = 14)
    expect(stunShare.until).toBe(20); // extended cleanly from 15 + 5 = 20 with zero gap
});

test('fightPlayer performs 1-tick fakie switch on cooldown, stepUnderFrozen onto frozen melee foe, and zeroDrainFlick', async () => {
    let tick = 10;
    const perTick: string[][] = [];
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512; // enemy holds melee dragon_dagger_p
    const enemyEntity = { headicons: 0, appearance, health: 99, totalHealth: 99, spotanimId: -1 };
    const state: any = {
        player: { worldX: 3092, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 1, id: 861, name: 'Magic shortbow', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ],
        equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 3 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        name: 'FakieBot',
        client: { var: { 300: 0, 301: 0, 172: 1 }, players: [null, enemyEntity] },
        tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                perTick.push([]);
                if (tick === 11) enemyEntity.spotanimId = 179; // entangle_impact freezes melee enemy
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => {
                const list = perTick[perTick.length - 1]!;
                list.push(`use:${slot}:${op}@${tick}`);
                const invIdx = state.inventory.findIndex((i: any) => i.slot === slot);
                if (invIdx >= 0) {
                    const prev = state.equipment.find((e: any) => e.slot === 3);
                    const next = state.inventory.splice(invIdx, 1)[0];
                    if (prev) state.inventory.push({ ...prev, slot: next.slot, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] });
                    state.equipment = [{ ...next, slot: 3 }];
                }
            },
            sendSpellOnPlayer: (idx: number, spell: number) => { perTick[perTick.length - 1]!.push(`spell:${idx}:${spell}@${tick}`); },
            sendInteractPlayer: (idx: number, op: number) => { perTick[perTick.length - 1]!.push(`attack:${idx}:${op}@${tick}`); },
            sendWalk: (x: number, z: number) => { perTick[perTick.length - 1]!.push(`walk:${x},${z}@${tick}`); },
            sendTogglePrayer: (p: number) => {
                state.prayers.activePrayers[p] = !state.prayers.activePrayers[p];
                perTick[perTick.length - 1]!.push(`pray:${p}@${tick}`);
            },
        },
    };
    const res = await fightPlayer(session, 'Dummy', {
        kit: { magic: [1401], ranged: [861], melee: [1231] },
        rotation: ['magic', 'ranged'],
        freeze: false,
        zeroDrainFlick: true,
        fakieSwitch: 'melee',
        stepUnderFrozen: true,
        protectItem: false,
        defencePrayer: false,
        cap: 8,
        log: () => {},
    });
    const flat = perTick.flat();
    expect(flat.some(a => a.startsWith('walk:3095,3555@'))).toBe(true); // stepped onto frozen melee foe's tile
    expect(flat.some(a => a.startsWith('use:0:2@1'))).toBe(true); // equipped melee dagger fakie during cooldown
    expect(res.flicks).toBeGreaterThanOrEqual(1); // zeroDrainFlick reset active prayer cycle cleanly
});

test('battleaxeWarcryMath, Charge varp/rune gating, and Dragon Battleaxe warcry self-buff', async () => {
    // Exact specwep.rs2:67-77 math at maxed combat stats: each 99 drains 9 -> sum 36 -> +19 Strength.
    expect(battleaxeWarcryMath({ Attack: 99, Defence: 99, Ranged: 99, Magic: 99 })).toEqual({
        drained: { attack: 9, defence: 9, ranged: 9, magic: 9 },
        strengthBoost: 19,
    });
    const runes = (f: number, b: number, a: number) => [{ id: 554, count: f }, { id: 565, count: b }, { id: 556, count: a }];
    expect(canCastChargeNow(80, runes(3, 3, 3), 0)).toBe(true);
    expect(canCastChargeNow(80, runes(3, 3, 3), 120)).toBe(false); // varp 272 already active -> skip recast
    expect(canCastChargeNow(79, runes(3, 3, 3), 0)).toBe(false);
    expect(canCastChargeNow(80, runes(2, 3, 3), 0)).toBe(false);
    expect(chargeVarpTicks({ var: { 272: 240 } })).toBe(240);

    let tick = 10;
    const clicks: number[] = [], uses: number[] = [];
    const state: any = {
        tick,
        player: { worldX: 3060, worldZ: 3880, level: 0, hp: 99, maxHp: 99, combatLevel: 126 },
        skills: [
            { name: 'Attack', level: 99, baseLevel: 99 },
            { name: 'Strength', level: 99, baseLevel: 99 },
            { name: 'Defence', level: 99, baseLevel: 99 },
            { name: 'Magic', level: 99, baseLevel: 99 },
            { name: 'Hitpoints', level: 99, baseLevel: 99 },
            { name: 'Prayer', level: 99, baseLevel: 99 },
        ],
        prayers: { activePrayers: new Array(15).fill(false), prayerPoints: 99 },
        inventory: [
            { id: ITEMS.dragonBattleaxe, slot: 0, count: 1, name: 'Dragon battleaxe', optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { id: 554, slot: 1, count: 3, name: 'Fire rune', optionsWithIndex: [] },
            { id: 565, slot: 2, count: 3, name: 'Blood rune', optionsWithIndex: [] },
            { id: 556, slot: 3, count: 3, name: 'Air rune', optionsWithIndex: [] },
        ],
        equipment: [{ id: 1231, slot: 3, count: 1, name: 'Dragon dagger(p)', optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 2, name: 'Foe', x: 3060, z: 3881, combatLevel: 126, distance: 1 }],
        combatEvents: [], gameMessages: [], dialog: { isOpen: false },
    };
    const varArr = new Array(400).fill(0);
    varArr[300] = 1000;
    varArr[272] = 200; // Charge already active -> Charge click must be skipped
    const session: any = {
        name: 'AxeBot',
        client: { var: varArr, players: [null, null, { appearance: [], headicons: 0, health: 99, totalHealth: 99 }] },
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => { tick++; state.tick = tick; cb(); }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number) => {
                const it = state.inventory.find((i: any) => i.slot === slot);
                if (it) uses.push(it.id);
            },
            sendClickComponent: (id: number) => { clicks.push(id); },
            sendInteractPlayer: () => {},
            sendTogglePrayer: () => {},
            sendWalk: () => {},
        },
    };
    await fightPlayer(session, 'Foe', {
        kit: { melee: [1231, ITEMS.dragonBattleaxe] },
        rotation: ['melee'],
        charge: true,
        battleaxeBuff: true,
        freeze: false,
        prayerFlick: false,
        cap: 4,
        log: () => {},
    });
    expect(clicks).not.toContain(SPELLS.charge); // Charge already active via varp 272 -> zero wasted cast
    expect(uses).toContain(ITEMS.dragonBattleaxe); // equipped 1377 and triggered warcry specbar
    expect(clicks.length).toBeGreaterThanOrEqual(1);
});

test('each special bar that pk.ts names exists in the interface pack of the server', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const pack = readFileSync(resolve(import.meta.dir, '../vendor/rs-sdk/server/content/pack/interface.pack'), 'utf8');
    const known = new Set(pack.split(/\r?\n/).map(line => line.slice(line.indexOf('=') + 1)).filter(name => name.endsWith(':specbar')));
    const used = new Set([...readFileSync(resolve(import.meta.dir, 'pk.ts'), 'utf8').matchAll(/'(combat_[a-z0-9_]+:specbar)'/g)].map(match => match[1]!));
    expect(known.size).toBeGreaterThan(10);
    expect(used.size).toBeGreaterThan(5);
    // A name that the pack does not hold throws "no interface component" at the first special of that weapon.
    expect([...used].filter(bar => !known.has(bar))).toEqual([]);
});

// Our own skull and what a death costs (content death.rs2 pvp_death_lose_items).
const COSTS: Record<number, number> = { 1215: 40_000, 1127: 65_000, 1201: 30_000, 385: 150, 995: 1, 1: 0 };
const cost = (id: number) => COSTS[id] ?? 0;
const KIT_UNITS = [{ id: 1215, count: 1 }, { id: 1127, count: 1 }, { id: 1201, count: 1 }, { id: 385, count: 10 }, { id: 995, count: 500 }, { id: 1, count: 3 }];

test('deathRisk: no skull keeps the 3 dearest units, Protect Item one more, a skull only that one', () => {
    expect(deathRisk(KIT_UNITS, cost, false, false)).toEqual({ keeps: 3, kept: [1127, 1215, 1201], keptValue: 135_000, lostValue: 10 * 150 + 500, lostUnits: 513 });
    expect(deathRisk(KIT_UNITS, cost, false, true)).toMatchObject({ keeps: 4, kept: [1127, 1215, 1201, 385], keptValue: 135_150, lostUnits: 512 });
    expect(deathRisk(KIT_UNITS, cost, true, false)).toEqual({ keeps: 0, kept: [], keptValue: 0, lostValue: 135_000 + 1500 + 500, lostUnits: 516 });
    expect(deathRisk(KIT_UNITS, cost, true, true)).toEqual({ keeps: 1, kept: [1127], keptValue: 65_000, lostValue: 72_000, lostUnits: 515 });
});

test('deathSkullFields: the skull bit, the keep count and the loss of the last tick alive, empty with no client', () => {
    expect(deathSkullFields({ skull: false, units: KIT_UNITS, protect: false }, cost)).toBe(' skull=0 keeps=3 lost=513 lostValue=2000');
    expect(deathSkullFields({ skull: true, units: KIT_UNITS, protect: true }, cost)).toBe(' skull=1 keeps=1 lost=515 lostValue=72000');
    expect(deathSkullFields({ skull: null, units: KIT_UNITS, protect: true }, cost)).toBe('');
    expect(deathSkullFields(null, cost)).toBe('');
});

test('deathRisk keeps one unit at a time, never an item with no cost, and tolerates a pack with fewer units than keeps', () => {
    // A stack of 2 of the dearest item gives 2 of the 3 keeps.
    expect(deathRisk([{ id: 1215, count: 2 }, { id: 1201, count: 1 }, { id: 385, count: 5 }], cost, false, false)).toMatchObject({ kept: [1215, 1215, 1201], lostUnits: 5 });
    expect(deathRisk([{ id: 1, count: 4 }], cost, false, true)).toEqual({ keeps: 4, kept: [], keptValue: 0, lostValue: 0, lostUnits: 4 });
    expect(deathRisk([], cost, true, true)).toEqual({ keeps: 1, kept: [], keptValue: 0, lostValue: 0, lostUnits: 0 });
    // The real table: a dragon dagger has a cost, an unknown item has none.
    expect(itemCostOf(1215)).toBeGreaterThan(0);
    expect(itemCostOf(999_999)).toBe(0);
});

test('ownSkull reads the head icon of the local player', () => {
    expect(ownSkull({ localPlayer: { headicons: 1 } })).toBe(true);
    expect(ownSkull({ localPlayer: { headicons: 8 } })).toBe(false);
    expect(ownSkull({ localPlayer: { headicons: 9 } })).toBe(true);
    expect(ownSkull({ localPlayer: {} })).toBe(false);
    expect(ownSkull({})).toBeNull();
    expect(ownSkull(undefined)).toBeNull();
});

// One short fight with our own head icon `headicons`, to see whether Protect Item (prayer 8) goes on.
async function protectItemRun(headicons: number | null, protectItem: boolean | 'skulled' | undefined) {
    let tick = 10;
    const actions: string[] = [], logs: string[] = [];
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512;
    const client: any = { var: { 300: 1000, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance, health: 20, totalHealth: 99 }], ...(headicons === null ? {} : { localPlayer: { headicons } }) };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [{ slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] }, { slot: 1, id: 995, name: 'Coins', count: 500, optionsWithIndex: [] }],
        equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        client, tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => { setTimeout(() => { tick++; if (tick === 16) state.gameMessages = [{ observationId: 9, tick: 16, type: 0, text: 'You have defeated Dummy.' }]; cb(); }, 0); return () => {}; },
        sdk: {
            getState: () => state, sendUseItem: () => {}, sendClickComponent: () => {}, sendInteractPlayer: () => {}, sendSpellOnPlayer: () => {},
            sendTogglePrayer: (p: number) => { state.prayers.activePrayers[p] = !state.prayers.activePrayers[p]; actions.push(`pray:${p}`); },
        },
    };
    const res = await fightPlayer(session, 'Dummy', { kit: { magic: [1401], melee: [1231] }, ...(protectItem === undefined ? {} : { protectItem }), log: l => logs.push(l) });
    return { res, actions, logs, protectOn: actions.includes(`pray:${PRAYER.item}`) };
}

test('protectItem "skulled" turns Protect Item on only while our own skull shows; the default and true keep it on; false keeps it off', async () => {
    expect((await protectItemRun(1, 'skulled')).protectOn).toBe(true);
    expect((await protectItemRun(0, 'skulled')).protectOn).toBe(false);
    expect((await protectItemRun(null, 'skulled')).protectOn).toBe(false);
    expect((await protectItemRun(0, undefined)).protectOn).toBe(true);
    expect((await protectItemRun(0, true)).protectOn).toBe(true);
    expect((await protectItemRun(1, false)).protectOn).toBe(false);
});

test('the fight logs our skull and what a death would cost, once for each skull state', async () => {
    const skull = await protectItemRun(1, undefined), plain = await protectItemRun(0, undefined);
    expect(skull.res.outcome).toBe('kill');
    const lines = (r: { logs: string[] }) => r.logs.filter(l => l.startsWith('PK skull '));
    // Skulled with Protect Item (the default): 1 item kept. With no skull the 3 dearest are kept, and Protect Item keeps a fourth.
    expect(lines(skull)).toHaveLength(1);
    expect(lines(skull)[0]).toMatch(/^PK skull on: a death keeps 1 item and loses \d+ items worth \d+$/);
    expect(lines(plain)).toHaveLength(1);
    expect(lines(plain)[0]).toMatch(/^PK skull off: a death keeps 4 items and loses \d+ items worth \d+$/);
    expect((await protectItemRun(null, undefined)).logs.some(l => l.startsWith('PK skull '))).toBe(false);
});

// The tick in which the fight drinks an antipoison after "You have been poisoned!" (the message comes in tick 11).
async function antipoisonTick(cureNow: boolean | undefined): Promise<number | null> {
    let tick = 10, drank: number | null = null;
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512;
    const client: any = { var: { 300: 1000, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance, health: 20, totalHealth: 99 }] };
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [{ slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { slot: 1, id: 2446, name: 'Antipoison(4)', count: 1, optionsWithIndex: [{ text: 'Drink', opIndex: 1 }] }],
        equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        client, tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => {
                tick++;
                if (tick === 11) state.gameMessages = [{ observationId: 5, tick: 11, type: 0, text: 'You have been poisoned!' }];
                if (tick === 20) state.gameMessages = [...state.gameMessages, { observationId: 9, tick: 20, type: 0, text: 'You have defeated Dummy.' }];
                cb();
            }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state, sendClickComponent: () => {}, sendInteractPlayer: () => {}, sendSpellOnPlayer: () => {}, sendTogglePrayer: () => {},
            sendUseItem: (slot: number) => { if (slot === 1 && drank === null) drank = tick; },
        },
    };
    await fightPlayer(session, 'Dummy', { kit: { magic: [1401], melee: [1231] }, ...(cureNow === undefined ? {} : { cureNow }), log: () => {} });
    return drank;
}

test('an antipoison goes down in the first tick after the poison by default, and a tick later with cureNow false', async () => {
    expect(await antipoisonTick(undefined)).toBe(11);
    expect(await antipoisonTick(true)).toBe(11);
    expect(await antipoisonTick(false)).toBeGreaterThan(11);
});

test('isDying: a health bar at 0 is a target that is dying, and lowHealth is true there', () => {
    const seen = { headicons: 0, worn: [], health: 0, totalHealth: 99, spotanim: -1 };
    expect(isDying(seen)).toBe(true);
    expect(lowHealth(seen, 0.3)).toBe(true);
    expect(isDying({ ...seen, health: 1 })).toBe(false);
    // No health bar yet (the target has not been hit) is not dying, and neither is no observation.
    expect(isDying({ ...seen, totalHealth: 0 })).toBe(false);
    expect(isDying(null)).toBe(false);
});

test('rewearStart wears the starting armour that sits in the pack with its slot empty, and nothing else', async () => {
    // Rune full helm 1163 (hat), rune platebody 1127 (torso, worn), rune platelegs 1079 (legs), dragon dagger 1215 (weapon), and an item the account did not wear at the start.
    const used: [number, number][] = [], logs: string[] = [];
    const wear = [{ text: 'Wear', opIndex: 2 }];
    const s: any = { sdk: {
        getState: () => ({ equipment: [{ id: 1127, slot: 4 }] }),
        getInventory: () => [{ id: 1163, slot: 3, optionsWithIndex: wear }, { id: 1079, slot: 4, optionsWithIndex: wear }, { id: 1215, slot: 5, optionsWithIndex: wear }, { id: 1201, slot: 6, optionsWithIndex: wear }],
        sendUseItem: async (slot: number, op: number) => { used.push([slot, op]); },
    } };
    let ticks = 0;
    expect(await rewearStart(s, [1163, 1127, 1079, 1215], l => logs.push(l), async () => { ticks++; return true; })).toBe(2);
    expect(used).toEqual([[3, 2], [4, 2]]);
    expect(ticks).toBe(2);
    expect(logs).toEqual(['PK wore 2 pieces of the starting armour again']);
    // Nothing missing, nothing to wear.
    used.length = 0;
    expect(await rewearStart(s, [1127], undefined, async () => true)).toBe(0);
    expect(used).toEqual([]);
});

test('isDying guards the freeze and the special: not read here, see the fight loop; the helper is the test of the rule', () => {
    expect(isDying({ headicons: 0, worn: [], health: 0, totalHealth: 70, spotanim: -1 })).toBe(true);
});

test('specReasons names the rules that let a special go, and none when no rule does', () => {
    const off = { fled: false, bursting: false, volleying: false, chainStun: false, low: false };
    expect(specReasons(off)).toBe('none');
    expect(specReasons({ ...off, low: true })).toBe('low');
    expect(specReasons({ ...off, fled: true, low: true })).toBe('fled+low');
    expect(specReasons({ fled: true, bursting: true, volleying: true, chainStun: true, low: true })).toBe('fled+burst+volley+chain+low');
});

test('fledEnds: the flee state ends when the flee hold has run out, no freeze holds the target and it stands within 2 tiles', () => {
    // fled, gap 1, now 20, flee hold until 14, frozen until 10: ends.
    expect(fledEnds(true, 1, 20, 14, 10)).toBe(true);
    expect(fledEnds(true, 2, 20, 14, 10)).toBe(true);
    // Not while it is still fleeing (the hold has not run out), not while a freeze holds it, not farther than 2 tiles, not when it never fled.
    expect(fledEnds(true, 1, 13, 14, 10)).toBe(false);
    expect(fledEnds(true, 1, 20, 14, 25)).toBe(false);
    expect(fledEnds(true, 3, 20, 14, 10)).toBe(false);
    expect(fledEnds(false, 1, 20, 14, 10)).toBe(false);
});

test('ownPoisonHit reads a poison hitsplat (type 2) that is still showing on the own player; carriedPoison holds a poison between fights for 40 ticks', () => {
    const client = (types: number[], cycles: number[], now = 100) => ({ localPlayer: { damageTypes: types, damageCycles: cycles }, getClientCycle: () => now });
    expect(ownPoisonHit(client([2, 0, 0, 0], [170, 0, 0, 0]))).toBe(true);
    // A damage hitsplat (type 1), an old poison hitsplat (its cycle is past), no splat data, no cycle function.
    expect(ownPoisonHit(client([1, 0, 0, 0], [170, 0, 0, 0]))).toBe(false);
    expect(ownPoisonHit(client([2, 0, 0, 0], [90, 0, 0, 0]))).toBe(false);
    expect(ownPoisonHit({})).toBe(false);
    expect(ownPoisonHit({ localPlayer: { damageTypes: [2], damageCycles: [500] } })).toBe(false);
    // The carry: a poison noted at tick 50 is carried to a fight that starts at tick 80 (30 ticks later), not to one at tick 91, and not when it was cured.
    const key = {};
    noteFightPoison(key, true, 50);
    expect(carriedPoison(key, 80)).toBe(true);
    expect(carriedPoison(key, 50 + POISON_HOLD)).toBe(true);
    expect(carriedPoison(key, 50 + POISON_HOLD + 1)).toBe(false);
    noteFightPoison(key, false, 60);
    expect(carriedPoison(key, 70)).toBe(false);
    expect(carriedPoison({}, 70)).toBe(false);
    expect(carriedPoison(undefined, 70)).toBe(false);
    // The splat is returned by its end cycle, so that a loop counts it once: a splat that ends at 170 is the same one at cycle 100, 130 and 160 and a new one ends later.
    expect(poisonSplat(client([2, 0, 0, 0], [170, 0, 0, 0], 100))).toBe(170);
    expect(poisonSplat(client([2, 0, 0, 0], [170, 0, 0, 0], 160))).toBe(170);
    expect(poisonSplat(client([2, 0, 0, 0], [170, 0, 0, 0], 170))).toBe(0);
    expect(poisonSplat(client([2, 2, 0, 0], [170, 260, 0, 0], 100))).toBe(260);
    expect(poisonSplat(client([1, 0, 0, 0], [170, 0, 0, 0]))).toBe(0);
    // The splat that a fight used is carried to the next fight.
    const k2 = {};
    noteFightPoison(k2, false, 60, 170);
    expect(carriedSplat(k2)).toBe(170);
    expect(carriedSplat({})).toBe(0);
    expect(carriedSplat(undefined)).toBe(0);
});

test('fightPlayer prefers castable escapeSpell in Wild <= 20 even with worn glory and full pack', async () => {
    let tick = 10;
    const actions: string[] = [];
    const client = { var: { 300: 0, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance: new Uint16Array(12), health: 99, totalHealth: 99 }] };
    const state: any = {
        player: { worldX: 3094, worldZ: 3600, combatLevel: 126, hp: 50, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 45, baseLevel: 45 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [
            { slot: 0, id: 563, name: 'Law rune', count: 2, optionsWithIndex: [] },
            { slot: 1, id: 556, name: 'Air rune', count: 10, optionsWithIndex: [] },
            ...Array.from({ length: 26 }, (_, i) => ({ slot: i + 2, id: ITEMS.shark, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] })),
        ],
        equipment: [{ slot: 2, id: ITEMS.glory[0]!, name: 'Amulet of glory(4)', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3098, z: 3600, distance: 4 }],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        client, tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            setTimeout(() => { tick++; cb(); }, 0);
            return () => {};
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number) => { actions.push(`use:${slot}`); },
            sendUseEquipmentItem: (slot: number) => { actions.push(`unequip:${slot}`); },
            sendClickComponent: (id: number) => { actions.push(`click:${id}`); if (id === SPELLS.camelotTeleport) state.player.worldZ = 2757; },
            sendInteractPlayer: () => {},
            sendWalk: () => {},
            sendTogglePrayer: () => {},
        },
    };
    const res = await fightPlayer(session, 'Dummy', {
        kit: { ranged: [861] }, rotation: ['ranged'], freeze: false, prayerFlick: false,
        eatAt: 30, flee: true, escapeAt: 50, escapeSpell: SPELLS.camelotTeleport, log: () => {},
    });
    expect(res.outcome).toBe('escaped');
    expect(actions).toEqual([`click:${SPELLS.camelotTeleport}`]);
});
