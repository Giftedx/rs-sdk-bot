import {expect, test} from 'bun:test';
import {defaultSpec, fightPlayer, type FightOptions, type SpecConfig} from './pk';

const SPEAR = 1249;
const DAGGER = 1231;

async function protectedFight(o: {weapon?: number; hp?: number; below?: number; options?: Partial<FightOptions>} = {}) {
    let tick = 10;
    const weapon = o.weapon ?? SPEAR;
    const spec = defaultSpec({melee: [weapon]}, new Map([[SPEAR, 'dragon_spear'], [DAGGER, 'dragon_dagger_p']]))!;
    const actions: string[] = [];
    const appearance = new Uint16Array(12);
    appearance[3] = DAGGER + 512;
    const state: any = {
        player: {worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1},
        skills: [{name: 'Magic', level: 99, baseLevel: 99}, {name: 'Prayer', level: 99, baseLevel: 99}],
        prayers: {prayerPoints: 0, activePrayers: []},
        inventory: [], equipment: [{slot: 3, id: weapon, count: 1}],
        nearbyPlayers: [{index: 1, name: 'Protected', x: 3095, z: 3555, distance: 1, combatLevel: 126}],
        combatEvents: [], gameMessages: [],
    };
    const session: any = {
        client: {var: {300: 1000, 301: 0, 172: 1}, players: [null, {
            headicons: 1 << 3, appearance, health: o.hp ?? 80, totalHealth: 99,
        }]},
        tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {
            const timer = setTimeout(() => {tick++; cb();}, 0);
            return () => clearTimeout(timer);
        },
        sdk: {
            getState: () => state,
            sendClickComponent: () => {actions.push('special');},
            sendInteractPlayer: () => {actions.push('attack');},
            sendWalk: () => {actions.push('walk');},
        },
    };
    const result = await fightPlayer(session, 'Protected', {
        kit: {melee: [weapon]}, rotation: ['melee'], spec: {...spec, below: o.below ?? 1} as SpecConfig,
        cap: 2, log: () => {}, ...o.options,
    });
    return {result, actions};
}

test('a spear stun can open against Protect Melee at high health', async () => {
    const {result, actions} = await protectedFight();
    expect(result.specs).toBe(1);
    expect(actions).toEqual(['special', 'attack']);
});

test('a damaging special still waits for a protected target above quarter health', async () => {
    const {result, actions} = await protectedFight({weapon: DAGGER, hp: 50});
    expect(result.specs).toBe(0);
    expect(actions).not.toContain('special');
});

test('a spear stun keeps its configured target-health threshold', async () => {
    const {result, actions} = await protectedFight({below: 0.55});
    expect(result.specs).toBe(0);
    expect(actions).not.toContain('special');
});

test('a spear stun keeps the special-energy reserve', async () => {
    const {result, actions} = await protectedFight({options: {specReserve: 800}});
    expect(result.specs).toBe(0);
    expect(actions).not.toContain('special');
});

test('a spear stun waits for the shared hold to end', async () => {
    const {result, actions} = await protectedFight({options: {stunShare: {clock: () => 11, until: 15}}});
    expect(result.specs).toBe(0);
    expect(actions).not.toContain('special');
});

test('a damaging special can still finish a protected target below quarter health', async () => {
    const {result, actions} = await protectedFight({weapon: DAGGER, hp: 20});
    expect(result.specs).toBe(1);
    expect(actions).toEqual(['special', 'attack']);
});
