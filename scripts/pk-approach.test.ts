import {expect, test} from 'bun:test';
import {fightPlayer} from './pk';

async function approach(runEnergy: number | undefined, special: boolean, gap = 5) {
    let tick = 10, energy = Number.isInteger(runEnergy) && runEnergy! >= 0 && runEnergy! <= 100 ? runEnergy! * 100 : 0;
    let moving = false, running = false, firstHit: number | undefined;
    const attacks: number[] = [];
    const target = {index: 1, name: 'ApproachTarget', combatLevel: 126, x: 3094 + gap, z: 3555, distance: gap};
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512;
    const client = {var: {300: special ? 250 : 0, 301: 0, 172: 1}, players: [null, {headicons: 0, appearance, health: 20, totalHealth: 99}]};
    const state: any = {
        player: {worldX: 3094, worldZ: 3555, combatLevel: 126, hp: 99, maxHp: 99, runEnergy, lifeId: 1},
        skills: [{name: 'Magic', level: 99, baseLevel: 99}, {name: 'Prayer', level: 99, baseLevel: 99}],
        prayers: {prayerPoints: 0, activePrayers: []}, inventory: [], equipment: [{slot: 3, id: 1231, count: 1}],
        nearbyPlayers: [target], combatEvents: [], gameMessages: [],
    };
    const session: any = {
        name: 'ApproachActor', client, tick: () => tick, ended: new Promise(() => {}),
        onTick: (callback: () => void) => {
            const timer = setTimeout(() => {
                tick++;
                if (moving) {
                    // Native movement runs at two tiles with >=100 energy units. At maximum clamped weight a
                    // two-step tick costs 134 units; a one-step tick recovers eight at Agility 1.
                    const steps = Math.min(target.x - state.player.worldX - 1, running ? 2 : 1);
                    state.player.worldX += steps;
                    energy = steps === 2 ? Math.max(0, energy - 134) : Math.min(10000, energy + 8);
                    if (energy < 100) running = false;
                    if (runEnergy !== undefined) state.player.runEnergy = Math.floor(energy / 100);
                    target.distance = target.x - state.player.worldX;
                    if (target.distance === 1) { firstHit ??= tick; moving = false; }
                }
                callback();
            }, 0);
            return () => clearTimeout(timer);
        },
        sdk: {
            getState: () => state,
            sendClickComponent: () => { client.var[301] = 1; },
            sendInteractPlayer: () => {
                attacks.push(tick);
                if (attacks.length === 1) {
                    moving = true;
                    running = energy >= 100;
                    if (special) { client.var[300] = 0; client.var[301] = 0; }
                }
            },
        },
    };
    const result = await fightPlayer(session, target.name, {
        kit: {melee: [1231]}, rotation: ['melee'], cap: 11, log: () => {},
        ...(special ? {spec: {kit: [1231], bar: 'combat_stabsword:specbar', cost: 250, below: 1}} : {}),
    });
    return {attacks, firstHit, result};
}

for (const special of [false, true]) {
    const kind = special ? 'special' : 'normal';
    for (const energy of [100, 99, 50]) test(`${kind} melee approach at ${energy}% schedules the next turn at native arrival plus weapon delay`, async () => {
        const run = await approach(energy, special);
        expect(run.firstHit).toBe(13);
        expect(run.attacks.slice(0, 2)).toEqual([11, 17]);
        expect(run.result.specs).toBe(special ? 1 : 0);
    });
    test(`${kind} melee approach at 1% allows one running tick then accounts for exhaustion`, async () => {
        const run = await approach(1, special);
        expect(run.firstHit).toBe(14);
        expect(run.attacks.slice(0, 2)).toEqual([11, 18]);
    });
    test(`${kind} melee approach does not credit an extra running tick for an odd final step`, async () => {
        const run = await approach(1, special, 4);
        expect(run.firstHit).toBe(13);
        expect(run.attacks.slice(0, 2)).toEqual([11, 17]);
    });
    for (const energy of [0, undefined]) test(`${kind} melee approach with ${energy === undefined ? 'unknown' : 'empty'} energy keeps the walking bound`, async () => {
        const run = await approach(energy, special);
        expect(run.firstHit).toBe(15);
        expect(run.attacks.slice(0, 2)).toEqual([11, 19]);
    });
}
