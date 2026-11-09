import { readFileSync } from 'node:fs';
import { openBot } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { actionSessionOwner, finishActionSession } from './microbot-a-actions';
import { cookingRecipes } from './microbot-b-cooking';
import { runBankJob, validateBankJob, type BankJob } from './microbot-bank-jobs';
import { LOGS, lineTiles, type LogKind } from './firemaking-order';
import { geFiremakingOptions, NATIVE_GE_FIREMAKING_SITE, runGeFiremaking } from './microbot-ge-firemaking';

export type GeCookingOrder = Pick<BankJob, 'recipe' | 'target' | 'batch' | 'cap' | 'returnTicks' | 'members' | 'reserve'> & {
 log: LogKind;
 maximumFires: number;
};

type CookingDeps = {
 light: (s: Session, options: Parameters<typeof runGeFiremaking>[1], stop: () => boolean) => Promise<Pick<Awaited<ReturnType<typeof runGeFiremaking>>, 'ok' | 'logsBurnt'>>;
 cook: (s: Session, job: BankJob, stop: () => boolean) => Promise<Pick<Awaited<ReturnType<typeof runBankJob>>, 'ok' | 'completed' | 'trips' | 'atBank' | 'failure'>>;
};

const bank = {...NATIVE_GE_FIREMAKING_SITE.bank, level: 0};
const fireTiles = new Set(lineTiles(NATIVE_GE_FIREMAKING_SITE.rows).map(({x, z}) => `${x},${z}`));
const defaults: CookingDeps = {light: runGeFiremaking, cook: runBankJob};

function cookingJob(order: GeCookingOrder): BankJob {
 return {
  family: 'cooking', heat: 'fire', bank, recipe: order.recipe, target: order.target,
  batch: order.batch, cap: order.cap, returnTicks: order.returnTicks, members: order.members, reserve: order.reserve,
 };
}

export function validateGeCookingOrder(order: GeCookingOrder) {
 validateBankJob(cookingJob(order));
 const recipe = cookingRecipes().recipes.find(recipe => recipe.name === order.recipe && recipe.fire);
 if (!Object.hasOwn(LOGS, order.log) || !Number.isSafeInteger(order.maximumFires) ||
  order.maximumFires < 0 || order.maximumFires > 1000 || order.target > 1000 || order.batch > 28 ||
  !recipe) {
  throw Error('GE cooking requires a finite Native fire recipe and owned fire budget');
 }
 return recipe;
}

export async function runGeCooking(raw: Session, order: GeCookingOrder, stop = () => false, deps: CookingDeps = defaults) {
 const recipe = validateGeCookingOrder(order);
 const job = cookingJob(order);
 const owner = actionSessionOwner(raw, stop);
 const start = raw.tick();
 const remaining = () => order.cap - (raw.tick() - start);
 const position = () => raw.sdk.getState()?.player;
 const atBank = () => {
  const p = position();
  return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - bank.x), Math.abs(p.worldZ - bank.z)) <= 3;
 };
 const observedFire = () => raw.sdk.getState()?.nearbyLocs
  .filter(loc => loc.id === 2732 && loc.level === 0 && loc.reachable !== false && fireTiles.has(`${loc.x},${loc.z}`))
  .sort((a, b) => a.distance - b.distance)[0];

 let completed = 0, fires = 0, trips = 0, failure = '';
 try {
  if (!atBank()) throw Error('GE cooking requires the observed Varrock bank at entry');
  if ((raw.sdk.getSkill('Cooking')?.level ?? 0) < recipe.level) throw Error('Cooking level insufficient');
  while (completed < order.target) {
   if (owner.stopped() || remaining() <= order.returnTicks) throw Error('GE cooking stopped or return budget reached');
   let fire = observedFire();
   if (!fire) {
    if (fires >= order.maximumFires || remaining() < order.returnTicks + 120) throw Error('GE cooking fire budget exhausted');
    const options = geFiremakingOptions({LOG: order.log, MAX_LOGS: '1', CAP: String(Math.min(4000, remaining() - order.returnTicks))});
    const lit = await deps.light(raw, options, owner.stopped);
    fires += lit.logsBurnt;
    if (!lit.ok || lit.logsBurnt !== 1 || owner.stopped() || !atBank()) throw Error('GE cooking fire creation did not settle at the bank');
    fire = observedFire();
    if (!fire) throw Error('GE cooking Native fire unobserved after lighting');
   }
   if (remaining() <= order.returnTicks) throw Error('GE cooking return budget reached');
   const amount = Math.min(order.batch, order.target - completed);
   const batch = await deps.cook(owner.cleanup, {
    ...job, target: amount, batch: amount, cap: remaining(),
    site: {x: fire.x - 1, z: fire.z, level: 0},
   }, owner.stopped);
   completed += batch.completed;
   trips += batch.trips;
   if (!batch.ok) throw Error(batch.failure);
   if (batch.completed !== amount || !batch.atBank || !atBank()) throw Error('GE cooking batch did not settle at the bank');
  }
 } catch (error) {
  failure = error instanceof Error ? error.message : String(error);
 }
 return {ok: !failure && completed === order.target && atBank() && !owner.stopped(), completed, fires, trips, failure: failure || '-'};
}

if (import.meta.main) {
 const [account, path] = process.argv.slice(2);
 if (!account || !path || process.argv.length !== 4) throw Error('usage: microbot-ge-cooking.ts account order.json');
 const order = JSON.parse(readFileSync(path, 'utf8')) as GeCookingOrder;
 validateGeCookingOrder(order);
 let stopped = false;
 const session = await openBot(account, {onStop: async () => { stopped = true; }});
 const owner = actionSessionOwner(session);
 let ok = false, detail = '';
 try {
  const result = await runGeCooking(session, order, () => stopped);
  console.log('GE_COOKING_RESULT ' + JSON.stringify(result));
  ok = result.ok;
  detail = JSON.stringify(result);
 } catch (error) {
  detail = String(error);
 }
 await finishActionSession(owner, ok, detail);
}
