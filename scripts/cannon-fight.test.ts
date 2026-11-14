import {expect, test} from 'bun:test';
import {CANNON_LIFE, CANNON_REFRESH, CANNON_SPOTS, MSB, bandTicks, levelsMet, loadedBalls, parseLevels, parsePhases, pickTarget, reloadDue, specialDue, type TargetNpc} from './cannon-fight';
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

test('phases and stop levels parse, and a phase ends when all its levels are met', () => {
  expect(parseLevels('Ranged=99,defence=99, Hitpoints=99')).toEqual({Ranged: 99, Defence: 99, Hitpoints: 99});
  expect(() => parseLevels('Ranged=100')).toThrow();
  expect(parsePhases('1333:3:Defence=99;861:1')).toEqual([{weapon: 1333, style: 3, until: {Defence: 99}}, {weapon: 861, style: 1}]);
  expect(parsePhases('::Defence=99;')).toEqual([{until: {Defence: 99}}]);
  expect(() => parsePhases('x:1')).toThrow();
  const lv = (k: string) => ({Defence: 99, Ranged: 80} as Record<string, number>)[k] ?? 1;
  expect(levelsMet(lv, {Defence: 99})).toBe(true);
  expect(levelsMet(lv, {Defence: 99, Ranged: 99})).toBe(false);
  expect(levelsMet(lv, undefined)).toBe(false);
});

test('special only with the magic shortbow, the bar off, 350 energy and a fight on', () => {
  const base = {special: true, weapon: MSB, energy: 350, enabled: 0, fighting: true};
  expect(specialDue(base)).toBe(true);
  expect(specialDue({...base, energy: 349})).toBe(false);
  expect(specialDue({...base, enabled: 1})).toBe(false);
  expect(specialDue({...base, weapon: 1333})).toBe(false);
  expect(specialDue({...base, fighting: false})).toBe(false);
  expect(specialDue({...base, special: false})).toBe(false);
  expect(CANNON_REFRESH).toBeLessThan(CANNON_LIFE);
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

test('the spider spot walks out of the spiders\' map square before logout', () => {
  const c = CANNON_SPOTS.spiders!.clear!;
  // Map square 51_59 is z 3776-3839; the spiders wander 10 tiles from their spawns.
  expect(c.z).toBeLessThan(3776 - 10);
  expect(CANNON_SPOTS.battlefield!.clear).toBeUndefined();
});
