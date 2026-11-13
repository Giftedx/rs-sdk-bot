import {expect, test} from 'bun:test';
import {CANNON_SPOTS, bandTicks, loadedBalls, pickTarget, reloadDue, type TargetNpc} from './cannon-fight';
import {FIGHTER_PROFILES, resolveFighterStep} from './aio-fighter';

const npc = (index: number, x: number, z: number, more: Partial<TargetNpc> = {}): TargetNpc => ({
  index, name: 'Poison spider', x, z, hp: 64, distance: 0, targetIndex: -1, reachable: true, optionsWithIndex: [{text: 'Attack', opIndex: 2}], ...more,
});

test('load message gives the loaded count', () => {
  expect(loadedBalls('You load the cannon with 30 cannonballs.')).toBe(30);
  expect(loadedBalls('You load the cannon with 1 cannonballs.')).toBe(1);
  expect(loadedBalls('The cannon is already full of ammo.')).toBe(0);
});

test('top-up is due on empty or after the interval', () => {
  expect(reloadDue({now: 119, lastLoad: 100, interval: 20, empty: false})).toBe(false);
  expect(reloadDue({now: 120, lastLoad: 100, interval: 20, empty: false})).toBe(true);
  expect(reloadDue({now: 101, lastLoad: 100, interval: 20, empty: true})).toBe(true);
});

test('target: in reach and near the cannon, attackers first, then low hitpoints', () => {
  const base = {target: /^poison spider$/i, centre: {x: 100, z: 100}, me: {x: 100, z: 98}, near: 10, reach: 7, skip: () => false};
  const far = npc(1, 100, 90), out = npc(2, 115, 100), low = npc(3, 104, 98, {hp: 10, distance: 4}), adjacent = npc(4, 101, 97, {distance: 1});
  expect(pickTarget([far, out], base)).toBeUndefined();
  expect(pickTarget([far, out, low], base)?.index).toBe(3);
  expect(pickTarget([low, adjacent], base)?.index).toBe(4);
  expect(pickTarget([low, adjacent], {...base, skip: i => i === 4})?.index).toBe(3);
  expect(pickTarget([npc(5, 101, 98, {name: 'Black demon'}), npc(6, 101, 98, {hp: 0}), npc(7, 101, 98, {reachable: false})], base)).toBeUndefined();
});

test('band ticks from first-seen level ticks', () => {
  expect(bandTicks(new Map([[55, 0], [60, 40], [70, 200]]), [55, 60, 70, 80])).toEqual({'55-60': 40, '60-70': 160});
});

test('spots are multiway rows with a target pattern, and the fighter routes to the worker', () => {
  for (const spot of Object.values(CANNON_SPOTS)) {
    expect(() => new RegExp(spot.target)).not.toThrow();
    expect(spot.near).toBeGreaterThan(0);
  }
  expect(FIGHTER_PROFILES.some(p => p.target === 'cannon')).toBe(true);
  const step = resolveFighterStep('cannon', ['SPOT=battlefield']);
  expect(step.script).toBe('scripts/cannon-fight.ts');
  expect(step.env.SPOT).toBe('battlefield');
});
