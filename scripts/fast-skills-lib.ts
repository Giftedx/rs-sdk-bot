// Shared fresh-clock specialist utilities, unnoted supply manifests, tutorial skip, and burst-trade helpers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from '../packages/core/src/inprocess';
import { accountOf, finish, getWorld, openBot } from '../packages/core/src/bot';
import { levelForXp, xpForLevel } from '../packages/planner/src/curve';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../packages/core/src/walk';

export const ITEM_IDS = {
 chisel: 1755,
 uncut_opal: 1625,
 uncut_jade: 1627,
 uncut_red_topaz: 1629,
 uncut_sapphire: 1623,
 uncut_emerald: 1621,
 uncut_ruby: 1619,
 uncut_diamond: 1617,
 uncut_dragonstone: 1631,
 opal: 1609,
 jade: 1611,
 red_topaz: 1613,
 sapphire: 1607,
 emerald: 1605,
 ruby: 1603,
 diamond: 1601,
 dragonstone: 1615,
 necklace_of_minigames_8: 3853,
 raw_beef: 2132,
 raw_rat_meat: 2134,
 raw_bear_meat: 2136,
 raw_chicken: 2138,
 guamvial: 91,
 marrentillvial: 93,
 tarrominvial: 95,
 harralandervial: 97,
 ranarrvial: 99,
 iritvial: 101,
 avantoevial: 103,
 kwuarmvial: 105,
 cadantinevial: 107,
 dwarfweedvial: 109,
 torstolvial: 111,
 lantadymevial: 2483,
 toadflaxvial: 3002,
 snapdragonvial: 3004,
 eye_of_newt: 221,
 red_spiders_eggs: 223,
 limpwurt_root: 225,
 snape_grass: 231,
 unicorn_horn_dust: 235,
 white_berries: 239,
 dragon_scale_dust: 241,
 wine_of_zamorak: 245,
 jangerberries: 247,
 chocolate_dust: 1975,
 toads_legs: 2152,
 mortmyremushroom: 2970,
 cactus_potato: 3138,
 zamorak_brew_3: 189,
 dragon_bones: 536,
 hammer: 2347,
 bronze_bar: 2349,
 iron_bar: 2351,
 steel_bar: 2353,
 mithril_bar: 2359,
 adamantite_bar: 2361,
 blankrune: 1436,
 air_talisman: 1438,
 body_talisman: 1446,
 bodyrune: 559,
 airrune: 556,
 waterrune: 555,
 earthrune: 557,
 firerune: 554,
 mindrune: 558,
 cosmicrune: 564,
 lawrune: 563,
 bloodrune: 565,
 staff_of_fire: 1387,
 knife: 946,
 amulet_of_glory_4: 1712,
 amulet_of_magic: 1727,
 boots_wizard: 2579,
 sapphire_ring: 1637,
 emerald_ring: 1639,
 ruby_ring: 1641,
 diamond_ring: 1643,
 dragonstone_ring: 1645,
 ring_of_recoil: 2550,
 ring_of_dueling_8: 2552,
 ring_of_forging: 2568,
 ring_of_life: 2570,
 ring_of_wealth: 2572,
 prayer_potion_4: 2434,
 shark: 385,
} as const;

export const TRADE_OFFER_INV = 3322;
export const TRADE_MAIN_ACCEPT = 3420;
export const TRADE_CONFIRM_ACCEPT = 3546;
export const LUMBRIDGE_COURTYARD = { x: 3222, z: 3222, level: 0 } as const;
export const GLORY_IDS = [ITEM_IDS.amulet_of_glory_4, 1710, 1708, 1706] as const;
export const GAMES_NECKLACE_IDS = [
 ITEM_IDS.necklace_of_minigames_8,
 3855,
 3857,
 3859,
 3861,
 3863,
 3865,
 3867,
] as const;

export interface SupplyEntry {
 itemId: number;
 item: string;
 count: number;
}

export interface SpecialistArgs {
 account: string;
 cap: number;
 target: number;
 helpers: string[];
 env: Record<string, string | undefined>;
}

type CatalogItemRow = { id: number; name: string; debugname?: string; tradeable?: boolean };
let catalogCache: Map<number, CatalogItemRow> | null = null;

export function loadItemCatalog(base = resolve(import.meta.dir, '..')): Map<number, CatalogItemRow> {
 if (catalogCache) return catalogCache;
 const rows = JSON.parse(readFileSync(resolve(base, 'knowledge/items.json'), 'utf8')) as CatalogItemRow[];
 catalogCache = new Map(rows.map(r => [r.id, r]));
 return catalogCache;
}

export function assertCatalogItems(entries: readonly SupplyEntry[], base?: string): void {
 const catalog = loadItemCatalog(base);
 for (const entry of entries) {
  if (!Number.isSafeInteger(entry.itemId) || entry.itemId < 1 || !Number.isSafeInteger(entry.count) || entry.count < 1) {
   throw Error(`invalid supply entry ${JSON.stringify(entry)}`);
  }
  const row = catalog.get(entry.itemId);
  if (!row) throw Error(`supply itemId ${entry.itemId} (${entry.item}) absent from knowledge/items.json`);
  if (!row.tradeable) throw Error(`supply itemId ${entry.itemId} (${entry.item}) is untradeable`);
 }
}

export function parseSpecialistArgs(
 argv: readonly string[] = process.argv.slice(2),
 env: Record<string, string | undefined> = process.env,
 defaults: { cap: number; target?: number; defaultHelpers?: number } = { cap: 2000 },
): SpecialistArgs {
 const settings = { ...env };
 const positional: string[] = [];
 for (const token of argv) {
  const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
  if (m) settings[m[1]!] = m[2]!;
  else positional.push(token);
 }
 const account = positional[0] ?? '';
 if (!account) throw Error('specialist account required');
 const cap = Number(settings.CAP ?? positional[1] ?? defaults.cap);
 const target = Number(settings.TARGET ?? settings.TARGET_LEVEL ?? defaults.target ?? 99);
 if (!Number.isSafeInteger(cap) || cap < 1) throw Error(`invalid CAP: ${settings.CAP ?? positional[1]}`);
 if (!Number.isSafeInteger(target) || target < 1 || target > 99) throw Error(`invalid TARGET: ${settings.TARGET}`);
 const helperRaw = settings.HELPERS ?? settings.COMPANIONS ?? '';
 const parsedHelpers = helperRaw
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
 const suffixes = 'bcdefghijklmnopqrstuvwxyz0123456789';
 const helpers = parsedHelpers.length
  ? parsedHelpers
  : Array.from({ length: defaults.defaultHelpers ?? 0 }, (_, i) => `${account}${suffixes[i]!}`);
 return { account, cap, target, helpers, env: settings };
}

export function countItem(inv: readonly { id: number; count: number }[], id: number): number {
 let total = 0;
 for (const item of inv) if (item.id === id) total += item.count;
 return total;
}

export function skillLevel(s: Session, skill: string): number {
 return s.sdk.getSkill(skill)?.baseLevel ?? levelForXp(s.sdk.getSkillXp(skill) ?? 0);
}

export function skillXp(s: Session, skill: string): number {
 return s.sdk.getSkillXp(skill) ?? 0;
}

export function playerPos(s: Session) {
 return s.sdk.getState()?.player ?? null;
}

export function nearTile(s: Session, x: number, z: number, tol = 2, level = 0): boolean {
 const p = playerPos(s);
 return !!p && p.level === level && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
}

// Opens companion helpers before the specialist so helper packets decode first in each game tick and
// the specialist's fresh clock begins only when all companions are already logged into the world.
// Companion guards (onStop/onSessionEnd) are suppressed so helper idle clocks never terminate long runs,
// and finish() alone performs settlement + logout so watchUnexpectedEnd never aborts LEDGER reporting.
export async function withSpecialistFleet<T>(
 specName: string,
 helperNames: readonly string[],
 fn: (spec: Session, helpers: Session[]) => Promise<{ ok: boolean; detail: string; value?: T }>,
 log: (line: string) => void = console.log,
): Promise<never> {
 await getWorld();
 const helpers: Session[] = [];
 let spec: Session | null = null;
 let ok = false;
 let detail = 'uninitialized';
 try {
  for (const name of helperNames) {
   helpers.push(
    await openBot(name, {
     log,
     onStop: async () => {},
     onSessionEnd: async () => {},
    }),
   );
  }
  spec = await openBot(specName, { log });
  const res = await fn(spec, helpers);
  ok = res.ok;
  detail = res.detail;
 } catch (error) {
  ok = false;
  detail = error instanceof Error ? error.message : String(error);
  log(`SPECIALIST_ERROR ${detail}`);
 } finally {
  const sessions = spec ? [...helpers, spec] : helpers;
  await finish(sessions, ok, detail);
 }
 throw Error('unreachable finish');
}

export function logPhase(s: Session, startTick: number, label: string, log: (line: string) => void = console.log): void {
 const p = playerPos(s);
 log(`PHASE ${label} tick=${s.tick() - startTick} pos=${p ? `${p.worldX},${p.worldZ},${p.level}` : '?'}`);
}

export async function skipTutorialFast(s: Session, deadlineTick: number): Promise<void> {
 const ready = await waitUntil(s, () => !!playerPos(s), { timeoutTicks: 20 });
 if (!ready) throw Error('tutorial start player state unobserved');
 while (s.tick() < deadlineTick) {
  const st = s.sdk.getState();
  const p = st?.player;
  if (!p) break;
  if (p.worldX >= 3160 && p.worldZ >= 3180) return;
  if (st.modalOpen && st.modalInterface === 3559) {
   await s.direct({ type: 'acceptCharacterDesign', reason: 'SDK' });
   await waitTicks(s, 1);
   continue;
  }
  const d = st.dialog;
  if (d?.isOpen) {
   if (d.isWaiting) {
    await waitTicks(s, 1);
    continue;
   }
   const yes = d.options.find((o: any) => /yes please/i.test(o.text));
   if (yes) {
    await s.direct({ type: 'clickDialogOption', optionIndex: yes.index, reason: 'SDK' });
   } else {
    const cont = d.options[0]?.index ?? 0;
    await s.direct({ type: 'clickDialogOption', optionIndex: cont, reason: 'SDK' });
   }
   await waitTicks(s, 1);
   continue;
  }
  const guide = s.sdk.findNearbyNpc(/^runescape guide$/i);
  if (guide) {
   await s.direct({ type: 'interactNpc', npcIndex: guide.index, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(s, 1);
 }
 throw Error('tutorial skip exceeded cap');
}

export async function clearBlockingModal(s: Session): Promise<void> {
 const st = s.sdk.getState();
 if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
  await s.direct({ type: 'closeModal', reason: 'SDK' });
 }
}

// Drops up to 5 unwanted items per tick (drop.rs2 has no p_delay and USER_EVENT.limit is 5).
export async function dropItemsFast(s: Session, keepIds: ReadonlySet<number>, deadlineTick: number): Promise<void> {
 while (s.tick() < deadlineTick) {
  const st = s.sdk.getState();
  const dropSlots = s.sdk.getInventory().filter(i => !keepIds.has(i.id)).map(i => i.slot);
  if (!dropSlots.length) return;
  const actions: Promise<unknown>[] = [];
  let budget = 5;
  if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
   actions.push(s.direct({ type: 'closeModal', reason: 'SDK' }));
   budget = 4;
  }
  for (const slot of dropSlots.slice(0, budget)) {
   actions.push(s.direct({ type: 'dropItem', slot, reason: 'SDK' }));
  }
  await Promise.all(actions);
  await waitTicks(s, 1);
 }
 throw Error('dropItemsFast exceeded cap');
}

export function findLocBy(s: Session, pred: (loc: ReturnType<Session['sdk']['getNearbyLocs']>[number]) => boolean) {
 return s.sdk.getNearbyLocs().filter(pred).sort((a, b) => a.distance - b.distance)[0] ?? null;
}

export function findNpcBy(s: Session, pred: (npc: ReturnType<Session['sdk']['getNearbyNpcs']>[number]) => boolean) {
 return s.sdk.getNearbyNpcs().filter(pred).sort((a, b) => a.distance - b.distance)[0] ?? null;
}

export async function waitNearPlayer(
 mover: Session,
 target: Session,
 deadlineTick: number,
 canStand?: (pos: NonNullable<ReturnType<typeof playerPos>>) => boolean,
): Promise<void> {
 while (mover.tick() < deadlineTick) {
  const mp = playerPos(mover);
  const tp = playerPos(target);
  if (
   mp &&
   tp &&
   mp.level === tp.level &&
   Math.max(Math.abs(mp.worldX - tp.worldX), Math.abs(mp.worldZ - tp.worldZ)) <= 1 &&
   (!canStand || canStand(mp))
  ) {
   return;
  }
  if (tp) {
   const close = mp && mp.level === tp.level && Math.max(Math.abs(mp.worldX - tp.worldX), Math.abs(mp.worldZ - tp.worldZ)) <= 1;
   const wx = close && canStand ? tp.worldX + 1 : tp.worldX;
   await mover.direct({ type: 'walkTo', x: wx, z: tp.worldZ, running: true, reason: 'SDK' });
  }
  await waitTicks(mover, 1);
 }
 throw Error(`helper ${mover.name} failed to reach ${target.name}`);
}

export interface BurstTradeSpec {
 giveIds?: readonly number[];
 returnIds?: readonly number[];
 deadlineTick: number;
 canStand?: (pos: NonNullable<ReturnType<typeof playerPos>>) => boolean;
 allowHelperOnSingleModal?: boolean;
}

// Executes a 3-to-4-tick trade: closes dialogs + sends requests together, then pipelines offer/accept/confirm within USER_EVENT.limit=5.
export async function burstTradeHost(spec: Session, helper: Session, opts: BurstTradeSpec): Promise<void> {
 const begin = spec.tick();
 await burstTradeInner(spec, helper, opts);
 console.log(`TRADE_TICKS helper=${helper.name} at=${begin} ticks=${spec.tick() - begin}`);
}

async function burstTradeInner(spec: Session, helper: Session, opts: BurstTradeSpec): Promise<void> {
 await waitNearPlayer(helper, spec, opts.deadlineTick, opts.canStand);
 const helperName = helper.name.toLowerCase();
 const specName = spec.name.toLowerCase();
 const getMsgs = () => spec.sdk.getState()?.gameMessages ?? [];
 const getHMsgs = () => helper.sdk.getState()?.gameMessages ?? [];
 const startObsId = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
 const startHObsId = getHMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
 const startTick = spec.tick();
 const initialHelperGive = new Map((opts.giveIds ?? []).map(id => [id, countItem(helper.sdk.getInventory(), id)]));
 const tradeAccepted = () =>
  getMsgs().some(
   m =>
    /Accepted trade\./i.test(m.text) &&
    (m.observationId !== undefined ? m.observationId > startObsId : m.tick > startTick),
  ) ||
  getHMsgs().some(
   m =>
    /Accepted trade\./i.test(m.text) &&
    (m.observationId !== undefined ? m.observationId > startHObsId : m.tick > startTick),
  );
 const tradeDeclined = () =>
  getMsgs().some(
   m =>
    /(?:declined trade|enough inventory space)/i.test(m.text) &&
    (m.observationId !== undefined ? m.observationId > startObsId : m.tick > startTick),
  );
 const transferredGive = () =>
  !!opts.giveIds?.length && opts.giveIds.some(id => countItem(helper.sdk.getInventory(), id) < (initialHelperGive.get(id) ?? 0));
 let sawConfirm = false;
 let lastOpenReqTick = -10;

 while (spec.tick() < opts.deadlineTick) {
  const st = spec.sdk.getTradeState();
  const ht = helper.sdk.getTradeState();

  if (!st.isOpen && !ht.isOpen) {
   if (tradeAccepted()) return;
   if (sawConfirm) {
    if (!tradeDeclined() && (!opts.giveIds?.length || transferredGive())) return;
    sawConfirm = false;
   }
   const specDlg = !!spec.sdk.getState()?.dialog?.isOpen;
   const helpDlg = !!helper.sdk.getState()?.dialog?.isOpen;
   const hTarget = spec.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === helperName);
   const sTarget = helper.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === specName);
   // Wait for spec's queued level-up dialogs before helper initiates trade so engineQueue cannot overwrite trademain.
   const openActs: Promise<unknown>[] = [];
   if (helpDlg) openActs.push(helper.direct({ type: 'closeModal', reason: 'SDK' }));
   if (specDlg) openActs.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
   // Send both OPPLAYER4 requests together once per 3-tick window so delayed packets cannot re-fire and close a newly opened trademain.
   const canRequest = (!specDlg || opts.allowHelperOnSingleModal) && !helpDlg && spec.tick() - lastOpenReqTick >= 3;
   if (canRequest && sTarget && hTarget) {
    lastOpenReqTick = spec.tick();
    openActs.push(helper.direct({ type: 'interactPlayer', playerIndex: sTarget.index, optionIndex: 4, reason: 'SDK' }));
    openActs.push(spec.direct({ type: 'interactPlayer', playerIndex: hTarget.index, optionIndex: 4, reason: 'SDK' }));
   }
   if (openActs.length) await Promise.all(openActs);
   await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
   continue;
  }

  lastOpenReqTick = -10;

  if (st.isOpen !== ht.isOpen && spec.sdk.getState()?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }

  if (st.screen === 'confirm' || ht.screen === 'confirm') {
   sawConfirm = true;
   const confirmActs: Promise<unknown>[] = [];
   if (ht.isOpen && ht.screen === 'confirm' && !ht.myAccepted) {
    confirmActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
   }
   if (st.isOpen && st.screen === 'confirm' && !st.myAccepted) {
    confirmActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
   }
   if (confirmActs.length) await Promise.all(confirmActs);
   await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
   continue;
  }

  const hWantSet = opts.giveIds ? new Set(opts.giveIds) : null;
  const hDistinctSlots = uniqueSlotsForIds(helper.sdk.getInventory(), hWantSet, ht.myOffer);
  const sReturnSet = opts.returnIds?.length ? new Set(opts.returnIds) : null;
  const sDistinctSlots = sReturnSet ? uniqueSlotsForIds(spec.sdk.getInventory(), sReturnSet, st.myOffer) : [];

  const hMainActs: Promise<unknown>[] = [];
  const sMainActs: Promise<unknown>[] = [];
  const sMaxOffers = sDistinctSlots.length > 4 ? 5 : 4;
  const sOffers = sDistinctSlots.slice(0, sMaxOffers);
  const specOfferComplete = sDistinctSlots.length <= sOffers.length;
  const hMaxOffers = hDistinctSlots.length > 4 ? 5 : 4;
  const hOffers = hDistinctSlots.slice(0, hMaxOffers);
  const helperOfferComplete = hDistinctSlots.length <= hOffers.length;
  for (const slot of hOffers) {
   hMainActs.push(helper.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
  }
  const hCanAccept = helperOfferComplete && specOfferComplete;
  if (hCanAccept && !ht.myAccepted && hOffers.length <= 4) {
   hMainActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
  }
  if (hCanAccept && (ht.myAccepted || hOffers.length <= 3) && hOffers.length === 0 && sOffers.length === 0) {
   hMainActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
  }

  for (const slot of sOffers) {
   sMainActs.push(spec.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
  }
  // Spec waits until helper has already placed every item before accepting trademain so helper's Offer-All never resets spec's accept.
  const specCanAccept = specOfferComplete && hDistinctSlots.length === 0;
  if (specCanAccept && !st.myAccepted && sOffers.length <= 4) {
   sMainActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
  }
  if (specCanAccept && ht.myAccepted && sOffers.length <= 3) {
   sMainActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
  }
  if (hMainActs.length) await Promise.all(hMainActs);
  if (sMainActs.length) await Promise.all(sMainActs);

  await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
 }

 throw Error(`burstTradeHost with ${helper.name} exceeded cap`);
}

function uniqueSlotsForIds(
 inv: readonly { id: number; count: number; slot: number }[],
 wantIds: ReadonlySet<number> | null,
 alreadyOffered: readonly { id: number; count: number }[],
): number[] {
 const offeredCounts = new Map<number, number>();
 for (const o of alreadyOffered) offeredCounts.set(o.id, (offeredCounts.get(o.id) ?? 0) + o.count);
 const totalInv = new Map<number, number>();
 const firstSlot = new Map<number, number>();
 for (const item of inv) {
  if (wantIds && !wantIds.has(item.id)) continue;
  totalInv.set(item.id, (totalInv.get(item.id) ?? 0) + item.count);
  if (!firstSlot.has(item.id)) firstSlot.set(item.id, item.slot);
 }
 const slots: number[] = [];
 for (const [id, needed] of totalInv) {
  if ((offeredCounts.get(id) ?? 0) < needed) slots.push(firstSlot.get(id)!);
 }
 return slots;
}

export async function runTo(s: Session, x: number, z: number, tol = 2, maxTicks = 200): Promise<void> {
 const walker = await sessionWalker(s);
 const res = await walkPath(walker, [{ x, z, tol }], { maxTicks });
 if (!res.ok && !nearTile(s, x, z, tol)) {
  const goRes = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), {
   maxRetriesPerLeg: 1,
   legTimeoutTicks: maxTicks,
  });
  if (!goRes.ok && !nearTile(s, x, z, tol)) {
   throw Error(`walk failed to ${x},${z}: ${goRes.detail ?? res.detail}`);
  }
 }
}

export async function navigateWorld(
 s: Session,
 x: number,
 z: number,
 level = 0,
 timeoutTicks = 250,
 signal?: AbortSignal,
): Promise<void> {
 if (signal?.aborted || nearTile(s, x, z, 2, level)) return;
 const p = playerPos(s);
 if (p && p.level === level && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= 24) {
  const walker = await sessionWalker(s);
  const quick = await walkPath(walker, [{ x, z, tol: 2 }], { maxTicks: Math.max(10, Math.min(120, timeoutTicks)), signal });
  if (signal?.aborted || quick.ok || nearTile(s, x, z, 2, level)) return;
 }
 const res = await goTo(s, await getWorld(), { x, z, level }, accountOf(s), {
  maxRetriesPerLeg: 1,
  legTimeoutTicks: Math.max(10, timeoutTicks),
  signal,
 });
 if (signal?.aborted) return;
 if (!res.ok && !nearTile(s, x, z, 2, level)) {
  throw Error(`goTo failed to ${x},${z},${level}: ${res.detail}`);
 }
}

export async function rubJewelryTeleport(
 s: Session,
 itemIds: number | readonly number[],
 choiceRegex: RegExp,
 arrived: () => boolean,
 deadlineTick: number,
): Promise<void> {
 const wanted = typeof itemIds === 'number' ? [itemIds] : itemIds;
 while (s.tick() < deadlineTick) {
  if (arrived()) return;
  const d = s.sdk.getDialog();
  if (d?.isOpen) {
   if (d.isWaiting) {
    await waitTicks(s, 1);
    continue;
   }
   const opt = d.options.find((o: any) => choiceRegex.test(o.text));
   if (opt) {
    await s.direct({ type: 'clickDialogOption', optionIndex: opt.index, reason: 'SDK' });
   } else {
    await s.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
   }
   await waitTicks(s, 1);
   continue;
  }
  const item = s.sdk.getInventory().find(i => wanted.includes(i.id));
  if (!item) throw Error(`jewelry item ${wanted.join('/')} missing for teleport`);
  await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: 4, reason: 'SDK' });
  await waitTicks(s, 1);
 }
 throw Error(`jewelry teleport ${wanted.join('/')} exceeded cap`);
}

export async function restockAtBank(
 s: Session,
 bankTile: { x: number; z: number; level?: number },
 itemId: number,
 targetCount: number,
 keepIds: ReadonlySet<number>,
 done: () => boolean,
 deadline: number,
 signal?: AbortSignal,
): Promise<boolean> {
 if (countItem(s.sdk.getInventory(), itemId) >= targetCount) return true;
 await navigateWorld(s, bankTile.x, bankTile.z, bankTile.level ?? 0, Math.max(10, deadline - s.tick()), signal);
 while (!done() && !signal?.aborted && s.tick() < deadline && !s.sdk.getState()?.bank?.isOpen) {
  const gen = s.bankObservation?.()?.generation ?? -1;
  const res = await s.bot.openBank();
  if (s.sdk.getState()?.bank?.isOpen) break;
  const sentTick = s.tick();
  if (res.success) {
   await waitUntil(s, () => s.tick() > sentTick && !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, {
    timeoutTicks: 6,
   });
  } else {
   await waitTicks(s, 1);
  }
 }
 if (done() || signal?.aborted || s.tick() >= deadline || !s.sdk.getState()?.bank?.isOpen) return false;

 const seenUnwanted = new Set<number>();
 for (const item of s.sdk.getInventory()) {
  if (item.id === itemId || keepIds.has(item.id) || seenUnwanted.has(item.id)) continue;
  seenUnwanted.add(item.id);
  const current = s.sdk.getInventory().find(i => i.id === item.id);
  if (current) await s.bot.depositItem(current, -1);
 }

 const bankItem = s.sdk.getState()?.bank?.items?.find((i: any) => i.id === itemId);
 if (bankItem && bankItem.count > 0) {
  const need = Math.min(targetCount - countItem(s.sdk.getInventory(), itemId), bankItem.count);
  if (need > 0) {
   const sentTick = s.tick();
   await s.bot.withdrawItem(bankItem, need, { asNote: false });
   await waitUntil(s, () => s.tick() > sentTick && countItem(s.sdk.getInventory(), itemId) >= targetCount, { timeoutTicks: 5 });
  }
 }
 if (s.sdk.getState()?.bank?.isOpen) {
  await s.bot.closeBank();
  const closeTick = s.tick();
  await waitUntil(s, () => s.tick() > closeTick && !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 4 });
 }
 return countItem(s.sdk.getInventory(), itemId) > 0;
}

export function goalXp(): number {
 return xpForLevel(99);
}

export function parseExternalSuppliers(env: Record<string, string | undefined> = process.env): string[] {
 return (env.PRACTICE_SUPPLIER ?? env.SUPPLIER ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
}

export async function withSingleSpecialist<T>(
 specName: string,
 fn: (spec: Session) => Promise<{ ok: boolean; detail: string; value?: T }>,
 log: (line: string) => void = console.log,
): Promise<never> {
 await getWorld();
 let spec: Session | null = null;
 let ok = false;
 let detail = 'uninitialized';
 try {
  spec = await openBot(specName, { log });
  const res = await fn(spec);
  ok = res.ok;
  detail = res.detail;
 } catch (error) {
  ok = false;
  detail = error instanceof Error ? error.message : String(error);
  log(`SPECIALIST_ERROR ${detail}`);
 } finally {
  await finish(spec ? [spec] : [], ok, detail);
 }
 throw Error('unreachable finish');
}

export async function tradeExternalSupplier(
 spec: Session,
 supplierNames: readonly string[],
 opts: {
  acceptOffer: (offer: readonly { id: number; count: number }[]) => boolean;
  give?: readonly { item: RegExp; amount: number }[];
  deadlineTick: number;
 },
): Promise<void> {
 const nameSet = new Set(supplierNames.map(n => n.toLowerCase()));
 while (spec.tick() < opts.deadlineTick) {
  await clearBlockingModal(spec);
  await spec.bot.dismissBlockingUI();
  const near = spec.sdk.getNearbyPlayers().find(p => nameSet.has(p.name.toLowerCase()));
  if (!near) {
   await waitTicks(spec, 1);
   continue;
  }
  const peerRe = new RegExp('^' + near.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const tr = await spec.bot.trade(peerRe, {
   ...(opts.give?.length ? { give: [...opts.give] } : {}),
   accept: offer => opts.acceptOffer(offer),
   requestTimeout: 10_000,
   timeout: 45_000,
   retryOnBusy: true,
  });
  if (tr.success) {
   await waitTicks(spec, 1);
   return;
  }
  await waitTicks(spec, 1);
 }
 throw Error(`tradeExternalSupplier(${supplierNames.join(',')}) exceeded cap`);
}

// Re-export curve helpers so specialist scripts import from one boundary.
export { finish, openBot, getWorld, accountOf, waitTicks, waitUntil, xpForLevel, levelForXp };

export function buildTradeGiveForIds(
 spec: Session,
 returnIds: readonly number[],
): { item: RegExp; amount: number }[] {
 if (!returnIds.length) return [];
 const catalog = loadItemCatalog();
 const wanted = new Set(returnIds);
 const counts = new Map<number, number>();
 for (const item of spec.sdk.getInventory()) {
  if (!wanted.has(item.id)) continue;
  counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 }
 return [...counts.entries()].map(([id, amount]) => {
  const name = catalog.get(id)?.name ?? `Item ${id}`;
  return { item: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), amount };
 });
}
