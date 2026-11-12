import { expect, test } from 'bun:test';
import {
    attackable, bestDamageSpell, bestFood, castableFreeze, combatPrayers, dangerReason, defaultSpec,
    estMaxHit, fightPlayer, freezeDuration, freezeSpell, hasStyle, ITEMS, killMessage, lowHealth,
    kitRotation, negativeCastArmour, newSplats, nextStyle, nextTick, observePlayer, PRAYER, protectedStyles, seededRandom, skulled, SPELLS,
    weaponStyle, wildernessLevel,
} from './pk';

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
    expect(negativeCastArmour(worn, 'ranged', new Set()).map(x => x.slot)).toEqual([4, 7, 0]);
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
