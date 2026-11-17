import { expect, test } from 'bun:test';
import { fightPlayer, PRAYER, type FightOptions } from './pk';

type Packet = { kind: 'food' | 'equip' | 'walk' | 'attack' | 'npcAttack' | 'style' | 'prayer'; prayer?: number };
type Frame = { tick: number; packets: Packet[]; prayersBefore: boolean[] };

// The native engine reads at most five USER_EVENT packets per tick. Food, movement, prayer and style clicks each
// use one. A non-adjacent player attack also sends MOVE_OPCLICK before OPPLAYER2.
function prayersWithinTick(frame: Frame): boolean[] {
    const active = [...frame.prayersBefore];
    const overheads: readonly number[] = [PRAYER.magic, PRAYER.missiles, PRAYER.melee];
    for (const packet of frame.packets.slice(0, 5)) {
        if (packet.prayer === undefined) continue;
        const wasOn = active[packet.prayer];
        if (!wasOn && overheads.includes(packet.prayer)) {
            for (const p of overheads) active[p] = false;
        }
        active[packet.prayer] = !wasOn;
    }
    return active;
}

async function foodFight(o: {
    foodTick: number;
    cap: number;
    runner?: boolean;
    rangedOnly?: boolean;
    active?: number[];
    configureRapid?: boolean;
    npcCounter?: boolean;
    options?: Partial<FightOptions>;
}) {
    let tick = 10;
    const frames: Frame[] = [];
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512;
    const target = { index: 1, name: 'FoodDummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 };
    const activePrayers = new Array<boolean>(20).fill(false);
    for (const p of o.active ?? []) activePrayers[p] = true;
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers },
        inventory: [
            { slot: 0, id: 385, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
            { slot: 1, id: 861, name: 'Magic shortbow', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        ],
        equipment: [{ slot: 3, id: o.rangedOnly ? 861 : 1231, name: o.rangedOnly ? 'Magic shortbow' : 'Dragon dagger(p)', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [target],
        combatEvents: [],
        gameMessages: [],
        ...(o.configureRapid ? { combatStyle: { currentStyle: 0, styles: ['Accurate', 'Rapid'] } } : {}),
    };
    if (o.npcCounter) {
        state.inventory = [state.inventory[0], ...[
            { id: 1231, name: 'Dragon dagger(p)', verb: 'Wield' },
            { id: 1201, name: 'Rune kiteshield', verb: 'Wield' },
            { id: 1079, name: 'Rune platelegs', verb: 'Wear' },
            { id: 1127, name: 'Rune platebody', verb: 'Wear' },
        ].map((item, i) => ({ slot: i + 1, id: item.id, name: item.name, count: 1, optionsWithIndex: [{ text: item.verb, opIndex: 2 }] }))];
        state.equipment = [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }];
        // Diagonal contact has Chebyshev distance one, but a 1x1 NPC still needs a move to a side tile before Attack.
        state.nearbyNpcs = [{ index: 7, name: 'Guard', x: 3095, z: 3556, distance: 1, hp: 30, targetIndex: 32768,
            inCombat: true, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] }];
        state.gameMessages = [{ observationId: 1, tick: 11, type: 0, text: "I'm already under attack." }];
    }
    const record = (packet: Packet) => frames[frames.length - 1]!.packets.push(packet);
    const session: any = {
        name: 'FoodFighter',
        client: { var: { 300: 0, 301: 0, 172: 1 }, players: [null, { headicons: 0, appearance, health: 99, totalHealth: 99 }] },
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            const timer = setTimeout(() => {
                tick++;
                if (tick === o.foodTick) state.player.hp = 40;
                if (o.runner) {
                    target.x = 3095 + Math.max(0, tick - 11) * 2;
                    target.distance = target.x - state.player.worldX;
                }
                frames.push({ tick, packets: [], prayersBefore: [...state.prayers.activePrayers] });
                cb();
            }, 0);
            return () => clearTimeout(timer);
        },
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number) => { record({ kind: slot === 0 ? 'food' : 'equip' }); },
            sendWalk: () => { record({ kind: 'walk' }); },
            sendInteractPlayer: () => {
                if (Math.abs(target.x - state.player.worldX) + Math.abs(target.z - state.player.worldZ) !== 1) record({ kind: 'walk' });
                record({ kind: 'attack' });
            },
            sendInteractNpc: () => {
                record({ kind: 'walk' });
                record({ kind: 'npcAttack' });
            },
            sendTogglePrayer: (prayer: number) => {
                record({ kind: 'prayer', prayer });
                state.prayers.activePrayers[prayer] = !state.prayers.activePrayers[prayer];
            },
            sendSetCombatStyle: (style: number) => {
                record({ kind: 'style' });
                state.combatStyle.currentStyle = style;
            },
        },
    };
    const result = await fightPlayer(session, target.name, {
        kit: o.rangedOnly ? { ranged: [861] } : { melee: [1231], ranged: [861] },
        rotation: o.rangedOnly ? ['ranged'] : ['melee'],
        protectItem: false,
        flickEvery: 2,
        cap: o.cap,
        log: () => {},
        ...o.options,
    });
    return { result, frames, food: frames.find(frame => frame.tick === o.foodTick)! };
}

const MELEE_PRAYERS = [PRAYER.steelSkin, PRAYER.melee, PRAYER.ultimateStrength, PRAYER.incredibleReflexes];

test('eating when a four-prayer flick is due keeps the overhead on within five native packets', async () => {
    const run = await foodFight({ foodTick: 12, cap: 3, active: MELEE_PRAYERS });
    expect(run.result.outcome).toBe('timeout');
    expect(run.food.packets.filter(packet => packet.kind === 'food')).toHaveLength(1);
    expect(run.food.packets.length).toBeLessThanOrEqual(5);
    expect(prayersWithinTick(run.food)[PRAYER.melee]).toBe(true);
});

test('food and a running-target chase share the same five-packet budget with prayer work', async () => {
    const run = await foodFight({ foodTick: 14, cap: 5, runner: true, active: MELEE_PRAYERS });
    expect(run.result.outcome).toBe('timeout');
    expect(run.food.packets.some(packet => packet.kind === 'food')).toBe(true);
    expect(run.food.packets.some(packet => packet.kind === 'walk')).toBe(true);
    for (const frame of run.frames) expect(frame.packets.length).toBeLessThanOrEqual(5);
    expect(prayersWithinTick(run.food)[PRAYER.melee]).toBe(true);
});

test('an opening meal shares its budget with a stand-off step, Rapid and combat prayers', async () => {
    const run = await foodFight({
        foodTick: 11,
        cap: 2,
        rangedOnly: true,
        configureRapid: true,
        options: { prayerFlick: false, protectItem: true, standOff: 5 },
    });
    expect(run.result.outcome).toBe('timeout');
    expect(run.food.packets.some(packet => packet.kind === 'food')).toBe(true);
    expect(run.food.packets.some(packet => packet.kind === 'walk')).toBe(true);
    expect(run.food.packets.some(packet => packet.kind === 'style')).toBe(true);
    expect(run.food.packets.length).toBeLessThanOrEqual(5);
});

test('counterattacking a diagonal NPC reserves both native attack packets before switching gear', async () => {
    const run = await foodFight({
        foodTick: 99,
        cap: 2,
        npcCounter: true,
        options: { kit: { melee: [1231, 1201, 1079] } },
    });
    const opening = run.frames[0]!;
    expect(run.result.outcome).toBe('timeout');
    expect(opening.packets.filter(packet => packet.kind === 'npcAttack')).toHaveLength(1);
    expect(opening.packets.filter(packet => packet.kind === 'walk')).toHaveLength(1);
    expect(opening.packets.some(packet => packet.kind === 'equip')).toBe(true);
    expect(opening.packets.length).toBeLessThanOrEqual(5);
});
