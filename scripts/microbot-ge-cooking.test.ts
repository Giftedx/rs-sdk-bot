import { expect, test } from 'bun:test';
import type { Session } from '../packages/core/src/inprocess';
import { runGeCooking, type GeCookingOrder } from './microbot-ge-cooking';

const order: GeCookingOrder = {
 recipe: 'cooking_generic_shrimp', target: 3, batch: 2,
 cap: 700, returnTicks: 120, members: true, log: 'normal', maximumFires: 1,
};

function fixture() {
 let tick = 0, burns = 0;
 const jobs: any[] = [];
 const player = { worldX: 3185, worldZ: 3436, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
 const state = { player, nearbyLocs: [] as any[] };
 const raw = {
  name: 'GeCookFixture', tick: () => tick, ended: new Promise(() => {}),
  client: { selfSlot: 1, executeBotAction() {} },
  sdk: { getState: () => state, getSkill: () => ({level: 99}) },
 } as unknown as Session;
 const fire = {id: 2732, x: 3193, z: 3431, level: 0, distance: 8, reachable: true};
 const deps = {
  light: async (s: Session, o: {maxLogs: number}) => {
   expect(s).toBe(raw);
   expect(o.maxLogs).toBe(1);
   tick += 25;
   burns++;
   state.nearbyLocs.push(fire);
   return {ok: true, logsBurnt: 1};
  },
  cook: async (_s: Session, job: any) => {
   tick += 20;
   jobs.push(job);
   return {ok: true, completed: job.target, trips: 1, atBank: true, failure: '-'};
  },
 };
 return {raw, state, fire, deps, jobs, burns: () => burns};
}

test('creates one Native fire and reuses it across bounded cooking refills', async () => {
 const f = fixture();
 const result = await runGeCooking(f.raw, order, () => false, f.deps);
 expect(result).toMatchObject({ok: true, completed: 3, fires: 1, trips: 2});
 expect(f.burns()).toBe(1);
 expect(f.jobs.map(job => [job.target, job.heat, job.site])).toEqual([
  [2, 'fire', {x: 3192, z: 3431, level: 0}],
  [1, 'fire', {x: 3192, z: 3431, level: 0}],
 ]);
 expect(f.jobs[1].cap).toBeLessThan(f.jobs[0].cap);
});

test('uses an observed local fire without burning a log and refuses a fire outside the declared area', async () => {
 const f = fixture();
 f.state.nearbyLocs = [{...f.fire, x: 3200}];
 expect(await runGeCooking(f.raw, {...order, maximumFires: 0}, () => false, f.deps)).toMatchObject({ok: false, completed: 0});
 f.state.nearbyLocs.push(f.fire);
 expect(await runGeCooking(f.raw, {...order, maximumFires: 0}, () => false, f.deps)).toMatchObject({ok: true, completed: 3, fires: 0});
 expect(f.burns()).toBe(0);
});

test('does not replay a cooking batch whose settlement failed', async () => {
 const f = fixture();
 f.state.nearbyLocs.push(f.fire);
 let calls = 0;
 const cook = async () => { calls++; return {ok: false, completed: 1, trips: 1, atBank: true, failure: 'unobserved effect'}; };
 const result = await runGeCooking(f.raw, order, () => false, {...f.deps, cook});
 expect(result).toMatchObject({ok: false, completed: 1, fires: 0, failure: 'unobserved effect'});
 expect(calls).toBe(1);
});

test('refuses an unavailable Cooking level before burning owned logs', async () => {
 const f = fixture();
 const underlevel = {...order, recipe: 'cooking_generic_lobster'};
 f.raw.sdk.getSkill = skill => ({level: skill === 'Cooking' ? 39 : 99}) as ReturnType<typeof f.raw.sdk.getSkill>;
 const result = await runGeCooking(f.raw, underlevel, () => false, f.deps);
 expect(result).toMatchObject({ok: false, completed: 0, fires: 0, failure: 'Cooking level insufficient'});
 expect(f.burns()).toBe(0);
 expect(f.jobs).toHaveLength(0);
});
