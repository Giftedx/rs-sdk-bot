import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { accountServerBeforeLogin, bestDamageSpell, bestFireSpell, canAttack, canCastCharge, castableFreeze, clearScoutIntel, hasVarrockTeleport, multiPileThreat, outclasses, pickScoutTargetForSquad, publishScoutIntel, readScoutIntel, restockLimit, restockMarket, restockPlan, RESTOCK_MARGIN_PERCENT, sectorStart, CLAIM_TTL_MS, escapeStep, escapeZ, isMulti, preyScore, freezeSpell, intercept, itemCost, kitFrom, lootAt, makeValuer, pickTrack, planLoot, Radar, spellId, sweep, wildLevel, type Track } from '../src/pvp/roam';
import marketRows from '../../../scripts/measure/pk-restock-market.json';
import type { RestockMarket } from '../src/pvp/roam';
// Rows of the market cache (.practice/market-all.json) for the items of the PK restock: the lowest ask and the units offered
// (scripts/measure/pk-restock-market.json). The prayer potion, the glory and the super potions are dear, the superantipoison and
// the antipoison have no seller, and the nature rune asks more than twice the hand limit that the plan once used. The limit of
// each item is the ask plus RESTOCK_MARGIN_PERCENT (10).
const RESTOCK_MARKET: RestockMarket = marketRows;
const RESTOCK_LIMITS = { 563: 770, 561: 698, 385: 974, 2434: 354_864, 1712: 4_675_000, 2440: 110_000, 2436: 110_000, 861: 104_500, 1113: 231_404 } as const;

test('roam pickup joins one native stack without eating combat food',async()=>{
 const inventory=Array.from({length:28},(_,slot)=>({id:slot===0?884:385,slot,count:1,optionsWithIndex:[{text:'Eat'}]}));const ground=[{id:884,name:'Iron arrow',count:5,x:1,z:1}];let eaten=0;
 const s:any={client:{objType:()=>({stackable:true})},sdk:{getInventory:()=>inventory,getState:()=>({groundItems:ground})},bot:{eatFood:async()=>{eaten++;return{success:false};},pickupItem:async()=>{inventory[0]!.count+=5;return{success:true};}}};
 const stats={loot:[]as string[],lootValue:0};expect(await lootAt(s,{x:1,z:1},{value:async()=>1000,min:1000,stats,emit:()=>{}})).toBe(5000);expect(eaten).toBe(0);expect(stats.lootValue).toBe(5000);
});
test('roam pickup skips unknown metadata and a food action with no observed room',async()=>{
 const inventory=Array.from({length:28},(_,slot)=>({id:385,slot,count:1,optionsWithIndex:[{text:'Eat'}]}));let picked=0,eaten=0;
 const s:any={client:{objType:()=>undefined},sdk:{getInventory:()=>inventory,getState:()=>({groundItems:[{id:1215,name:'Dragon dagger',count:1,x:1,z:1}]})},bot:{eatFood:async()=>{eaten++;return{success:true};},pickupItem:async()=>{picked++;return{success:true};}}};
 const ctx={value:async()=>30000,min:1000,stats:{loot:[]as string[],lootValue:0},emit:()=>{}};
 expect(await lootAt(s,{x:1,z:1},ctx)).toBe(0);expect(eaten).toBe(0);expect(picked).toBe(0);
 s.client.objType=()=>({stackable:false});expect(await lootAt(s,{x:1,z:1},ctx)).toBe(0);expect(picked).toBe(0);
});

test.each([1,2])('roam pickup reconciles exactly one food debit (observed %i)',async(debit)=>{
 const inventory=Array.from({length:28},(_,slot)=>({id:385,slot,count:1,optionsWithIndex:[{text:'Eat'}]}));let picked=0;
 const s:any={client:{objType:()=>({stackable:false})},sdk:{getInventory:()=>inventory,getState:()=>({groundItems:[{id:1215,name:'Dragon dagger',count:1,x:1,z:1}]})},bot:{eatFood:async()=>{inventory.splice(0,debit);return{success:true};},pickupItem:async()=>{picked++;inventory.push({id:1215,slot:0,count:1,optionsWithIndex:[]});return{success:true};}}};
 const stats={loot:[]as string[],lootValue:0};
 expect(await lootAt(s,{x:1,z:1},{value:async()=>30000,min:1000,stats,emit:()=>{}})).toBe(debit===1?30000:0);
 expect(picked).toBe(debit===1?1:0);
 expect(stats.lootValue).toBe(debit===1?30000:0);
});

test('wildLevel: 8 tiles per level from z 3520 inside x 2944-3391', () => {
    expect(wildLevel(3094, 3519)).toBe(0);
    expect(wildLevel(3094, 3520)).toBe(1);
    expect(wildLevel(3094, 3527)).toBe(1);
    expect(wildLevel(3094, 3528)).toBe(2);
    expect(wildLevel(3058, 3884)).toBe(46); // rune rocks
    expect(wildLevel(2943, 3700)).toBe(0);
    expect(wildLevel(3392, 3700)).toBe(0);
});

test('canAttack uses the lower of the two Wilderness levels', () => {
    const me = { x: 3058, z: 3884, combat: 126 };
    expect(canAttack(me, { x: 3058, z: 3880, combatLevel: 95 })).toBe(true);
    expect(canAttack(me, { x: 3094, z: 3530, combatLevel: 120 })).toBe(false);
    expect(canAttack({ ...me, z: 3500 }, { x: 3058, z: 3880, combatLevel: 126 })).toBe(false);
});

const track = (o: Partial<Track>): Track => ({ name: 'T', x: 3060, z: 3700, combatLevel: 100, vx: 0, vz: 0, ...o });

test('intercept: a still target is met where it stands', () => {
    const at = intercept({ x: 3060, z: 3660 }, track({}));
    expect([at.x, at.z]).toEqual([3060, 3700]);
    expect(at.ticks).toBe(20); // 40 tiles at 2 per tick
});

test('intercept cuts off a target walking south: the meeting tile is south of where it stands', () => {
    const at = intercept({ x: 3100, z: 3640 }, track({ vz: -1 }));
    expect(at.z).toBeLessThan(3700);
    expect(Math.max(Math.abs(at.x - 3100), Math.abs(at.z - 3640))).toBeLessThanOrEqual(2 * at.ticks);
});

test('intercept: a target running away at full speed from behind gets a tile ahead on its line', () => {
    const at = intercept({ x: 3060, z: 3600 }, track({ z: 3640, vz: 2 }));
    expect(at.z).toBeGreaterThan(3640);
    expect(at.ticks).toBeGreaterThan(120);
});

test('pickTrack takes the target met first, skips ours, skipped, out of range and outside', () => {
    const me = { x: 3060, z: 3700, combat: 100 };
    const tracks = [
        track({ name: 'Moneyshot', z: 3702 }),
        track({ name: 'Ran', z: 3704 }),
        track({ name: 'Gap', z: 3706, combatLevel: 140 }),
        track({ name: 'Outside', z: 3510 }),
        track({ name: 'Far', z: 3760 }),
        track({ name: 'Near', z: 3720 }),
    ];
    expect(pickTrack(me, tracks, new Set(['moneyshot']), 56, new Set(['ran']))?.track.name).toBe('Near');
    expect(pickTrack(me, tracks, new Set(['moneyshot']), 20, new Set(['ran']))).toBeNull(); // all deeper than 20
    expect(pickTrack(me, [], new Set(), 56)).toBeNull();
});

test('Radar keeps surface players and their speed between roster frames', () => {
    const r = new Radar();
    r.accept({ t: 'roster', k: 100, p: [[1, 'Goondelf', 3000, 3800, 0, 126], [2, 'Upstairs', 3000, 3800, 1, 50]] }, 1000);
    expect(r.tracks.get('goondelf')).toMatchObject({ x: 3000, z: 3800, vx: 0, vz: 0 });
    expect(r.tracks.has('upstairs')).toBe(false);
    r.accept({ t: 'roster', k: 110, p: [[1, 'Goondelf', 3010, 3780, 0, 126]] }, 2000);
    expect(r.tracks.get('goondelf')).toMatchObject({ vx: 1, vz: -2 });
    expect(r.fresh(2000 + 14_000)).toBe(true);
    expect(r.fresh(2000 + 16_000)).toBe(false);
    r.accept({ t: 'tick', k: 111 } as any, 3000);
    expect(r.tick).toBe(110);
});

test('freezeSpell picks the strongest freeze by Magic level', () => {
    expect(freezeSpell(91)).toBe(1592); // Entangle
    expect(freezeSpell(60)).toBe(1582); // Snare
    expect(freezeSpell(20)).toBe(1572); // Bind
    expect(freezeSpell(19)).toBeNull();
});

test('sweep covers the Wilderness inside the depth limit, west-east then back', () => {
    const deep = sweep(56);
    expect(deep.length).toBe(30);
    expect(deep.every(p => wildLevel(p.x, p.z) >= 1)).toBe(true);
    expect(deep[4]).toEqual({ x: 3330, z: 3540 });
    expect(deep[5]).toEqual({ x: 3330, z: 3620 });
    expect(sweep(15).every(p => wildLevel(p.x, p.z) <= 15)).toBe(true);
    expect(sweep(1)).toEqual([{ x: 3090, z: 3524 }]);
});

test('pickTrack skips a target that can run out of range before a freeze lands', () => {
    expect(escapeZ(6)).toBe(3560);
    expect(escapeZ(0)).toBe(3520);
    const me = { x: 3094, z: 3570, combat: 97 };
    // Gap 6: out of range south of z 3560. At 3570 it is 10 tiles from escape: skipped. At 3600: 40 tiles, taken.
    expect(pickTrack(me, [track({ name: 'Edge', x: 3094, z: 3570, combatLevel: 91 })], new Set(), 56)).toBeNull();
    expect(pickTrack(me, [track({ name: 'Mid', x: 3094, z: 3590, combatLevel: 91 })], new Set(), 56)).toBeNull(); // 30 tiles
    expect(pickTrack(me, [track({ name: 'Deep', x: 3094, z: 3600, combatLevel: 91 })], new Set(), 56)?.track.name).toBe('Deep'); // 40 tiles
});

test('kitFrom: worn weapon and shield for melee, a carried bow, a carried staff; no empty magic', () => {
    const worn = [{ id: 1215, name: 'Dragon dagger', slot: 3 }, { id: 1540, name: 'Anti-dragon shield', slot: 5 }, { id: 1127, name: 'Rune platebody', slot: 4 }];
    const carried = [{ id: 861, name: 'Magic shortbow' }, { id: 1401, name: 'Mystic fire staff' }, { id: 385, name: 'Shark' }];
    expect(kitFrom(worn, carried)).toEqual({ magic: [1401], melee: [1215, 1540], ranged: [861] });
    expect(kitFrom([{ id: 1401, name: 'Mystic fire staff', slot: 3 }], [{ id: 1215, name: 'Dragon dagger' }, { id: 1201, name: 'Rune kiteshield' }, { id: 861, name: 'Magic shortbow' }]))
        .toEqual({ magic: [1401], melee: [1215, 1201], ranged: [861] });
    expect(kitFrom([{ id: 1333, name: 'Rune scimitar', slot: 3 }], [])).toEqual({ melee: [1333] });
    expect(kitFrom([{ id: 1387, name: 'Staff of fire', slot: 3 }], [])).toEqual({ magic: [1387] });
    expect(kitFrom([], [])).toEqual({});
});

test('spellId maps names and ids, and falls back to Fire Bolt', () => {
    expect(spellId('FIRE_WAVE')).toBe(1189);
    expect(spellId('fire_blast')).toBe(1181);
    expect(spellId('1158')).toBe(1158);
    expect(spellId('nonsense')).toBe(1169);
});

test('planLoot keeps stacks on or next to the kill tile worth the floor, most valuable first', () => {
    const at = { x: 3060, z: 3700 };
    const ground = [
        { id: 526, name: 'Bones', count: 1, x: 3060, z: 3700 },
        { id: 1215, name: 'Dragon dagger', count: 1, x: 3061, z: 3700 },
        { id: 995, name: 'Coins', count: 5000, x: 3060, z: 3701 },
        { id: 385, name: 'Shark', count: 1, x: 3060, z: 3700 },
        { id: 1079, name: 'Rune platelegs', count: 1, x: 3065, z: 3700 },
    ];
    const price = new Map([[526, 1], [1215, 300000], [995, 1], [385, 900], [1079, 38000]]);
    expect(planLoot(ground, at, price, 1000).map(g => [g.name, g.value])).toEqual([['Dragon dagger', 300000], ['Coins', 5000]]);
    expect(planLoot(ground, at, price, 500).map(g => g.name)).toEqual(['Dragon dagger', 'Coins', 'Shark']);
});

test('makeValuer: live market price, cost fallback, coins at 1, local server skips the market', async () => {
    const calls: string[] = [];
    const live = makeValuer('rs-sdk-demo.fly.dev', async url => { calls.push(url); if (url.endsWith('/1215')) return { referencePrice: 300000, basePrice: 30000 }; throw Error('down'); });
    expect(await live(1215)).toBe(300000);
    expect(await live(1215)).toBe(300000);
    expect(calls.length).toBe(1); // cached
    expect(calls[0]).toBe('https://rs-sdk.maxbittker.com/api/market/items/1215');
    expect(await live(526)).toBe(itemCost(526)); // market down: items.json cost
    expect(await live(995)).toBe(1);
    const local = makeValuer('localhost:8888', async () => { throw Error('must not call'); });
    expect(await local(1215)).toBe(itemCost(1215));
    expect(itemCost(1215)).toBe(30000);
});

test('bestFireSpell picks by Magic level and the runes carried', () => {
    expect(bestFireSpell(91, [{ id: 565, count: 10 }, { id: 560, count: 10 }])).toBe(1189);
    expect(bestFireSpell(91, [{ id: 560, count: 10 }, { id: 562, count: 10 }])).toBe(1181);
    expect(bestFireSpell(70, [{ id: 565, count: 10 }, { id: 562, count: 10 }])).toBe(1169);
    expect(bestFireSpell(91, [{ id: 560, count: 0 }])).toBe(1158);
});

test('isMulti reads maps/multiway.csv zones: rune rocks single-way, west of them multi', () => {
    expect(isMulti(3058, 3884)).toBe(false);
    expect(isMulti(3040, 3900)).toBe(true);
    expect(isMulti(3094, 3540)).toBe(false);
});

test('preyScore favours skulled, busy, hurt, unprotected and no-teleport prey', () => {
    const t = track({ z: 3600 }); // level 11
    expect(preyScore(t, 20)).toBe(20);
    expect(preyScore({ ...t, skulled: true }, 20)).toBe(-20);
    expect(preyScore({ ...t, fighting: 'npc' }, 20)).toBe(-10);
    expect(preyScore({ ...t, hpFrac: 0.5 }, 20)).toBe(-10);
    expect(preyScore({ ...t, protect: [] }, 20)).toBe(10);
    expect(preyScore({ ...t, z: 3700 }, 20)).toBe(10);  // level 23: no normal teleport
    expect(preyScore({ ...t, z: 3800 }, 20)).toBe(-5);  // level 36: no glory either
    expect(preyScore(t, 20, true)).toBe(-10);           // ganged in multi-combat
});

test('pickTrack: single-way leaves fighters and other hunters\' claims; multi-combat gangs them', () => {
    const me = { x: 3060, z: 3700, combat: 100, name: 'hunter1' };
    const single = () => false, multi = () => true;
    const busy = [track({ name: 'Busy', z: 3705, fighting: 'player' })];
    expect(pickTrack(me, busy, new Set(), 56, new Set(), 40, new Map(), 0, single)).toBeNull();
    expect(pickTrack(me, busy, new Set(), 56, new Set(), 40, new Map(), 0, multi)?.track.name).toBe('Busy');
    const claims = new Map([['near', { hunter: 'hunter2', at: 1000 }]]);
    const two = [track({ name: 'Near', z: 3702 }), track({ name: 'Far', z: 3740 })];
    expect(pickTrack(me, two, new Set(), 56, new Set(), 40, claims, 2000, single)?.track.name).toBe('Far');
    expect(pickTrack(me, two, new Set(), 56, new Set(), 40, claims, 2000, multi)?.track.name).toBe('Near');
    // A stale claim (older than CLAIM_TTL_MS) is ignored; my own claim never blocks me.
    expect(pickTrack(me, two, new Set(), 56, new Set(), 40, claims, 1000 + CLAIM_TTL_MS + 1, single)?.track.name).toBe('Near');
    expect(pickTrack({ ...me, name: 'hunter2' }, two, new Set(), 56, new Set(), 40, claims, 2000, single)?.track.name).toBe('Near');
});

test('pickTrack prefers a skulled target a little further away', () => {
    const me = { x: 3060, z: 3700, combat: 100 };
    const pair = [track({ name: 'Close', z: 3710 }), track({ name: 'Skull', z: 3760, skulled: true })];
    expect(pickTrack(me, pair, new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Skull');
});

test('escapeStep: glory to level 30, teleport to 20, else run south', () => {
    expect(escapeStep(0, { glory: false, teleport: false })).toBe('out');
    expect(escapeStep(30, { glory: true, teleport: true })).toBe('glory');
    expect(escapeStep(31, { glory: true, teleport: true })).toBe('run');
    expect(escapeStep(20, { glory: false, teleport: true })).toBe('teleport');
    expect(escapeStep(21, { glory: false, teleport: true })).toBe('run');
    expect(escapeStep(5, { glory: false, teleport: false })).toBe('run');
});

test('pickTrack skips a target that outclasses us or stands in a pile', () => {
    const me = { x: 3060, z: 3700, combat: 100 };
    expect(pickTrack(me, [track({ name: 'Big', z: 3705, combatLevel: 104 })], new Set(), 56, new Set(), 40, new Map(), 0, () => false)).toBeNull();
    expect(pickTrack(me, [track({ name: 'Even', z: 3705, combatLevel: 103 })], new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Even');
    const pile = [track({ name: 'Mark', z: 3705 }), track({ name: 'A', x: 3062, z: 3706 }), track({ name: 'B', x: 3058, z: 3704 })];
    // Each of the three has two strangers within 6 tiles: all skipped.
    expect(pickTrack(me, pile, new Set(), 56, new Set(), 40, new Map(), 0, () => false)).toBeNull();
    // Our own accounts near a target are not a pile.
    expect(pickTrack(me, pile, new Set(['a', 'b']), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Mark');
});

test('castableFreeze needs the level and the runes', () => {
    const runes = (earth: number, water: number, nature: number) => [{ id: 557, count: earth }, { id: 555, count: water }, { id: 561, count: nature }];
    expect(castableFreeze(91, runes(67, 1, 0))).toBeNull();      // live Mightyrod: 1 water, no nature
    expect(castableFreeze(91, runes(10, 10, 10))).toBe(1592);    // Entangle
    expect(castableFreeze(91, runes(4, 4, 3))).toBe(1582);       // runes for Snare only
    expect(castableFreeze(60, runes(10, 10, 10))).toBe(1582);    // level for Snare only
    expect(castableFreeze(19, runes(10, 10, 10))).toBeNull();
});

test('pickTrack skips a target at our level whose weapon is worth over twice ours', () => {
    const me = { x: 3060, z: 3700, combat: 126, weaponValue: itemCost(1331) }; // adamant scimitar
    const goondelf = track({ name: 'Goondelf', z: 3705, combatLevel: 126, weapon: 1215 }); // dragon dagger
    expect(pickTrack(me, [goondelf], new Set(), 56, new Set(), 40, new Map(), 0, () => false)).toBeNull();
    expect(pickTrack({ ...me, weaponValue: itemCost(1215) }, [goondelf], new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Goondelf');
    // A much weaker player with a good weapon is still prey.
    expect(pickTrack(me, [{ ...goondelf, combatLevel: 110 }], new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Goondelf');
});

test('restockPlan: law runes first, then freeze runes, within the coins, at the market ask plus the margin', () => {
    const M = RESTOCK_MARKET, L = RESTOCK_LIMITS;
    // 9 law, 0 nature, 1 water, about 4,900 coins: nothing for law; 4 nature runes at 698 each, and 500 gp kept for water.
    expect(restockPlan({ law: 9, nature: 0, water: 1, coins: 4943, magic: 91 }, M)).toEqual([
        { kind: 'ge', item: 561, quantity: 4, limit: L[561], owned: 0 },
        { kind: 'shop', profile: 'betty', maxSpend: 500 },
    ]);
    expect(restockPlan({ law: 1, nature: 20, water: 50, coins: 20000, magic: 72 }, M)).toEqual([{ kind: 'ge', item: 563, quantity: 10, limit: L[563], owned: 1 }]);
    expect(restockPlan({ law: 0, nature: 0, water: 0, coins: 3000, magic: 40 }, M)).toEqual([{ kind: 'ge', item: 563, quantity: 2, limit: L[563], owned: 0 }]);
    // 1,000 coins stay: 1,000 left buys one law rune at 770, and no nature rune is left to buy.
    expect(restockPlan({ law: 0, nature: 0, water: 0, coins: 2000, magic: 91 }, M)).toEqual([{ kind: 'ge', item: 563, quantity: 1, limit: L[563], owned: 0 }]);
    expect(restockPlan({ law: 0, nature: 0, water: 0, coins: 1769, magic: 91 }, M)).toEqual([]);
    expect(restockPlan({ law: 5, nature: 10, water: 20, coins: 99999, magic: 91 }, M)).toEqual([]);
});

test('restockPlan limits are the ask plus 10 percent, and an item with no ask, no seller or no market has no step', () => {
    const base = { law: 0, nature: 8, water: 20, coins: 1_000_000, magic: 40 };
    expect(RESTOCK_MARGIN_PERCENT).toBe(10);
    // The limit never falls below the ask, and a fractional limit rounds up: 634 x 1.1 = 697.4.
    for (const [id, quote] of Object.entries(RESTOCK_MARKET)) if (quote.ask !== null) expect(restockLimit(RESTOCK_MARKET, Number(id))).toBe(Math.ceil(quote.ask * 1.1 - 1e-9));
    expect(restockLimit(RESTOCK_MARKET, 561)).toBe(698);
    // A rising ask moves the limit and the quantity with it; the hand limit of 1,600 is gone.
    expect(restockPlan(base, { 563: { ask: 1000, sell: 50 } })).toEqual([{ kind: 'ge', item: 563, quantity: 10, limit: 1100, owned: 0 }]);
    expect(restockPlan({ ...base, coins: 3000 }, { 563: { ask: 1000, sell: 50 } })).toEqual([{ kind: 'ge', item: 563, quantity: 1, limit: 1100, owned: 0 }]);
    // Few units for sale cap the quantity. No ask, no seller, a zero ask or no row gives no step.
    expect(restockPlan(base, { 563: { ask: 1000, sell: 3 } })).toEqual([{ kind: 'ge', item: 563, quantity: 3, limit: 1100, owned: 0 }]);
    expect(restockPlan(base, { 563: { ask: null, sell: 50 } })).toEqual([]);
    expect(restockPlan(base, { 563: { ask: 1000, sell: 0 } })).toEqual([]);
    expect(restockPlan(base, { 563: { ask: 0, sell: 50 } })).toEqual([]);
    expect(restockPlan(base, {})).toEqual([]);
    // With no market only the shop step can remain.
    expect(restockPlan({ law: 9, nature: 8, water: 1, coins: 100_000, magic: 91, food: 0, glory: false, prayerPots: 0, superPots: true, antipoison: true }, {})).toEqual([{ kind: 'shop', profile: 'betty', maxSpend: 500 }]);
    expect(restockPlan({ law: 9, nature: 0, water: 1, coins: 100_000, magic: 91 }, { 561: { ask: 100, sell: 100 } })).toEqual([
        { kind: 'ge', item: 561, quantity: 20, limit: 110, owned: 0 }, { kind: 'shop', profile: 'betty', maxSpend: 500 }]);
});

test('restockPlan adds sharks, a magic shortbow and a rune chainbody when coins allow', () => {
    const M = RESTOCK_MARKET, L = RESTOCK_LIMITS, base = { law: 5, nature: 10, water: 20, magic: 91 };
    expect(restockPlan({ ...base, coins: 20000, food: 4, sharks: 3 }, M)).toEqual([{ kind: 'ge', item: 385, quantity: 16, limit: L[385], owned: 3 }]);
    expect(restockPlan({ ...base, coins: 20000, food: 15 }, M)).toEqual([]);
    expect(restockPlan({ ...base, coins: 200000, food: 20, ranged: 99, magicShortbow: false }, M)).toEqual([{ kind: 'ge', item: 861, quantity: 1, limit: L[861], owned: 0 }]);
    // The shortbow and 20,000 coins for the next restock: 124,499 does not cover them, 125,501 does.
    expect(restockPlan({ ...base, coins: 124_499, food: 20, ranged: 99, magicShortbow: false }, M)).toEqual([]);
    expect(restockPlan({ ...base, coins: 125_501, food: 20, ranged: 99, magicShortbow: false }, M)).toEqual([{ kind: 'ge', item: 861, quantity: 1, limit: L[861], owned: 0 }]);
    expect(restockPlan({ ...base, coins: 5000000, food: 20, defence: 99, runeBody: false }, M)).toEqual([{ kind: 'ge', item: 1113, quantity: 1, limit: L[1113], owned: 0 }]);
    expect(restockPlan({ ...base, coins: 5000000, food: 20, defence: 30, runeBody: false }, M)).toEqual([]);
});

test('sectorStart spreads hunters round the sweep, the same each run', () => {
    const legs = sweep(30).length;
    const starts = ['Mightyrod', 'Shaftmaker', 'Bigchopper', 'OreElse', 'Bigpackage'].map(n => sectorStart(n, legs));
    expect(new Set(starts).size).toBeGreaterThanOrEqual(4);
    expect(starts.every(i => i >= 0 && i < legs)).toBe(true);
    expect(sectorStart('Mightyrod', legs)).toBe(sectorStart('mightyrod', legs));
    expect(sectorStart('x', 0)).toBe(0);
});

test('outclasses: higher combat, or a far better weapon at about our level', () => {
    const me = { combat: 126, weaponValue: itemCost(1331) }; // adamant scimitar
    expect(outclasses(me, { combatLevel: 126, weapon: 1215 })).toBe(true);   // Goondelf, dragon dagger
    expect(outclasses(me, { combatLevel: 130 })).toBe(true);                 // 4 levels above
    expect(outclasses(me, { combatLevel: 126, weapon: 1331 })).toBe(false);
    expect(outclasses(me, { combatLevel: 110, weapon: 1215 })).toBe(false);  // much lower combat
    expect(outclasses({ combat: 126 }, { combatLevel: 126, weapon: 1215 })).toBe(false); // our weapon unknown
});

test('hasVarrockTeleport recognizes Mystic/battlestaff air and fire staves alongside rune stacks', () => {
    const runes = (law: number, air: number, fire: number) => [
        ...(law ? [{ name: 'Law rune', count: law }] : []),
        ...(air ? [{ name: 'Air rune', count: air }] : []),
        ...(fire ? [{ name: 'Fire rune', count: fire }] : []),
    ];
    expect(hasVarrockTeleport(24, runes(1, 3, 1), [])).toBe(false);
    expect(hasVarrockTeleport(25, runes(0, 3, 1), [])).toBe(false);
    expect(hasVarrockTeleport(25, runes(1, 2, 1), [])).toBe(false);
    expect(hasVarrockTeleport(25, runes(1, 3, 0), [])).toBe(false);
    expect(hasVarrockTeleport(25, runes(1, 3, 1), [])).toBe(true);
    expect(hasVarrockTeleport(70, runes(1, 3, 0), [{ name: 'Mystic fire staff' }])).toBe(true);
    expect(hasVarrockTeleport(70, runes(1, 0, 1), [{ name: 'Mystic air staff' }])).toBe(true);
    expect(hasVarrockTeleport(70, runes(1, 0, 1), [{ name: 'Air battlestaff' }])).toBe(true);
});

test('multiPileThreat flags 2+ attackable strangers near us only in multi-combat', () => {
    const me = { x: 3040, z: 3900, combat: 100 }; // wildy 48
    const single = () => false, multi = () => true;
    const foes = [
        { name: 'PkerA', combatLevel: 100, distance: 4 },
        { name: 'PkerB', combatLevel: 102, distance: 7 },
    ];
    expect(multiPileThreat(me, foes, new Set(), single)).toBeNull();
    expect(multiPileThreat(me, foes, new Set(), multi)).toContain('multi pile: 2 attackable enemies');
    expect(multiPileThreat(me, foes, new Set(['pkera']), multi)).toBeNull(); // ally excluded
    expect(multiPileThreat(me, [foes[0]!, { name: 'Far', combatLevel: 100, distance: 9 }], new Set(), multi)).toBeNull();
    expect(multiPileThreat({ x: 3094, z: 3555, combat: 100 }, [{ name: 'PkerA', combatLevel: 100, distance: 3 }, { name: 'LowScout', combatLevel: 60, distance: 3 }], new Set(), multi)).toBeNull(); // wildy 5: cb 60 cannot attack 100
});

test('pickTrack skips attackable piles while ignoring non-attackable bystanders', () => {
    const me = { x: 3060, z: 3880, combat: 100 };
    const target = { name: 'Prey', x: 3064, z: 3880, combatLevel: 100, vx: 0, vz: 0 };
    const pile = [target, { name: 'Friend1', x: 3065, z: 3881, combatLevel: 100, vx: 0, vz: 0 }, { name: 'Friend2', x: 3066, z: 3882, combatLevel: 100, vx: 0, vz: 0 }];
    expect(pickTrack(me, pile, new Set(), 56, new Set(), 40, new Map(), 0, () => true)).toBeNull();
    const lowPile = [target, { name: 'Skiller1', x: 3065, z: 3881, combatLevel: 3, vx: 0, vz: 0 }, { name: 'Skiller2', x: 3066, z: 3882, combatLevel: 3, vx: 0, vz: 0 }];
    expect(pickTrack(me, lowPile, new Set(), 56, new Set(), 40, new Map(), 0, () => true)?.track.name).toBe('Prey');
});

test('bestDamageSpell picks matching 2004 God Spell and canCastCharge gates on 80 Magic and runes', () => {
    const runes = (fire: number, blood: number, air: number) => [{ id: 554, count: fire }, { id: 565, count: blood }, { id: 556, count: air }];
    expect(spellId('FLAMES_OF_ZAMORAK')).toBe(1192);
    expect(spellId('CLAWS_OF_GUTHIX')).toBe(1191);
    expect(spellId('SARADOMIN_STRIKE')).toBe(1190);
    expect(bestDamageSpell(80, runes(4, 2, 1), [{ id: 2417 }])).toBe(1192);
    expect(bestDamageSpell(80, runes(1, 2, 4), [{ id: 2416 }])).toBe(1191);
    expect(bestDamageSpell(80, runes(2, 2, 4), [{ id: 2415 }])).toBe(1190);
    expect(bestDamageSpell(59, runes(4, 2, 1), [{ id: 2417 }])).toBe(1158);
    expect(bestDamageSpell(80, runes(3, 2, 1), [{ id: 2417 }])).toBe(1189); // short 1 fire for Flames -> Fire Wave
    expect(canCastCharge(80, runes(3, 3, 3), 1192)).toBe(true);
    expect(canCastCharge(79, runes(3, 3, 3), 1192)).toBe(false);
    expect(canCastCharge(80, runes(2, 3, 3), 1192)).toBe(false);
    expect(canCastCharge(80, runes(3, 3, 3), 1189)).toBe(false);
});

test('shared scout intel publishes, filters by TTL/bracket/maxWild, prioritizes multi-way skulled prey, and clears', () => {
    const file = join(tmpdir(), `pk-roam-intel-${Date.now()}-${Math.random()}.json`);
    const now = 1_000_000;
    try {
        publishScoutIntel({ target: 'SingleGuy', x: 3090, z: 3600, combatLevel: 120, hpFrac: 0.9, skulled: false, multi: false, wild: 11, scout: 'ScoutA', at: now }, file);
        publishScoutIntel({ target: 'MultiSkull', x: 3067, z: 3640, combatLevel: 120, hpFrac: 0.5, skulled: true, multi: true, wild: 16, scout: 'ScoutB', at: now }, file);
        publishScoutIntel({ target: 'TooDeep', x: 3060, z: 3880, combatLevel: 120, hpFrac: 0.2, skulled: true, multi: true, wild: 46, scout: 'ScoutC', at: now }, file);
        publishScoutIntel({ target: 'StaleGuy', x: 3067, z: 3640, combatLevel: 120, hpFrac: 0.1, skulled: true, multi: true, wild: 16, scout: 'ScoutD', at: now - 30_000 }, file);
        const intel = readScoutIntel(file, now);
        expect(intel.map(i => i.target)).toEqual(['SingleGuy', 'MultiSkull', 'TooDeep']);
        const picked = pickScoutTargetForSquad({ me: { x: 3070, z: 3630, combat: 126 }, intel, maxWild: 20, now });
        expect(picked?.target).toBe('MultiSkull');
        clearScoutIntel('MultiSkull', file, now);
        expect(readScoutIntel(file, now).map(i => i.target)).toEqual(['SingleGuy', 'TooDeep']);
    } finally {
        rmSync(file, { force: true });
    }
});

test('restockMarket reads the fresh quotes of the market cache and nothing from a missing or old file', () => {
    const root = mkdtempSync(join(tmpdir(), 'restock-market-')), now = 1_800_000_000_000;
    try {
        expect(restockMarket(root, now)).toEqual({ market: {}, at: null });
        mkdirSync(join(root, '.practice'));
        const write = (at: number) => writeFileSync(join(root, '.practice/market-all.json'), JSON.stringify({ at, items: {
            563: { name: 'Law rune', price: 760, bid: 240, ask: 700, trades: 297, sell: 105_042 },
            2448: { name: 'Superantipoison(4)', price: null, bid: null, ask: null, trades: 0, sell: 0 },
        } }));
        write(now - 60_000);
        const fresh = restockMarket(root, now);
        expect(fresh.at).toBe(now - 60_000);
        expect(fresh.market[563]).toMatchObject({ ask: 700, sell: 105_042 });
        expect(restockPlan({ law: 0, nature: 8, water: 20, coins: 100_000, magic: 40 }, fresh.market)).toEqual([{ kind: 'ge', item: 563, quantity: 10, limit: 770, owned: 0 }]);
        // A cache older than 30 minutes gives no quote, so the plan has no GE step.
        write(now - 31 * 60_000);
        const old = restockMarket(root, now);
        expect(old).toEqual({ market: {}, at: null });
        expect(restockPlan({ law: 0, nature: 8, water: 20, coins: 100_000, magic: 40 }, old.market)).toEqual([]);
        writeFileSync(join(root, '.practice/market-all.json'), '{');
        expect(restockMarket(root, now)).toEqual({ market: {}, at: null });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('accountServerBeforeLogin checks the side, restores a missing bot.env, then reads the server; an unreadable bot.env throws', () => {
    const calls: string[] = [];
    const server = accountServerBeforeLogin('Acct', { assertOwn: n => { calls.push('own ' + n); }, restore: n => { calls.push('restore ' + n); }, read: n => { calls.push('read ' + n); return 'demo.example:43594'; } });
    expect(server).toBe('demo.example:43594');
    expect(calls).toEqual(['own Acct', 'restore Acct', 'read Acct']);
    const noFile = () => accountServerBeforeLogin('Acct', { assertOwn: () => {}, restore: () => {}, read: () => { throw new Error('ENOENT: no such file, open bot.env'); } });
    expect(noFile).toThrow('ENOENT');
    // The other side's account is refused before any restore.
    const restored: string[] = [];
    const other = () => accountServerBeforeLogin('Acct', { assertOwn: () => { throw new Error('owned by cloud'); }, restore: n => { restored.push(n); }, read: () => 'x' });
    expect(other).toThrow('owned by cloud');
    expect(restored).toEqual([]);
});
