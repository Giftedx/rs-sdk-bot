import {expect, test} from 'bun:test';
import {beside, newGiver, staged} from './site-givers';
import type {Session} from '../packages/core/src/inprocess';

const at = (x: number, z: number) => ({sdk: {getState: () => ({player: {worldX: x, worldZ: z}}), getInventory: () => []}, tick: () => 0}) as unknown as Session;

test('a giver is beside the gatherer only north, south, east or west of it', () => {
  const gatherer = at(3085, 3237);
  expect(beside(newGiver(at(3086, 3237)), gatherer)).toBe(true);
  expect(beside(newGiver(at(3085, 3236)), gatherer)).toBe(true);
  // A diagonal tile makes the gatherer step before the trade opens.
  expect(beside(newGiver(at(3086, 3238)), gatherer)).toBe(false);
  expect(beside(newGiver(at(3085, 3237)), gatherer)).toBe(false);
  expect(beside(newGiver(at(3087, 3237)), gatherer)).toBe(false);
});

test('staged counts the packs held and the packs on the way', () => {
  const ready = {...newGiver(at(0, 0)), ready: true, n: 24};
  const fetching = {...newGiver(at(0, 0)), planned: 10, flight: Promise.resolve()};
  const empty = {...newGiver(at(0, 0)), planned: 10, flight: Promise.resolve(), empty: true};
  const idle = newGiver(at(0, 0));
  expect(staged([ready, fetching, empty, idle])).toBe(34);
});
