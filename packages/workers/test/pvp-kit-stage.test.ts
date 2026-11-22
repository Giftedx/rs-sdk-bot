import {expect,test} from 'bun:test';
import {kitStageAccounting, stageSupplyDeficit, verifyPvpStageSupplies} from '../src/pvp/stage-kit';
import {GOD_LOADOUTS} from '../../core/src/pk-kits/god-specs';
const before=[{id:995,count:8352},{id:44,count:3},{id:882,count:25}];
const after=[{id:995,count:8284},{id:44,count:3},{id:882,count:25},{id:1985,count:2}];
test('staging counts only paid cheese and fares, preserving protected stock',()=>{
 expect(kitStageAccounting(before,after,68)).toBe(true);
 expect(kitStageAccounting(before,after,8)).toBe(false);
 expect(kitStageAccounting(before,after.filter(i=>i.id!==44),68)).toBe(false);
 expect(kitStageAccounting(before,[...after,{id:557,count:1}],68)).toBe(false);
 expect(kitStageAccounting(before,after.map(i=>i.id===882?{...i,count:24}:i),68)).toBe(false);
 expect(kitStageAccounting(before,after.map(i=>i.id===995?{...i,count:8152}:i),200)).toBe(false);
});

test('verifyPvpStageSupplies enforces rev-289 god cape/staff parity, Charge runes, escape, food, and prayer potions', () => {
 const validGod = verifyPvpStageSupplies({
  magicLevel: 85,
  mode: 'god-charge',
  equipment: [
   { id: GOD_LOADOUTS.saradomin.capeId, name: 'Saradomin cape' },
   { id: GOD_LOADOUTS.saradomin.staffId, name: 'Saradomin staff' },
   { id: 1712, name: 'Amulet of glory(4)' },
  ],
  inventory: [
   { id: 565, name: 'Blood rune', count: 30 },
   { id: 554, name: 'Fire rune', count: 30 },
   { id: 556, name: 'Air rune', count: 60 },
   { id: 2434, name: 'Prayer potion(4)', count: 2 },
   { id: 385, name: 'Shark', count: 14 },
  ],
 });
 expect(validGod.ok).toBe(true);
 expect(validGod.escape).toBe('glory');
 expect(validGod.canCharge).toBe(true);
 expect(validGod.maxGodCasts).toBe(15);

 const mismatched = verifyPvpStageSupplies({
  magicLevel: 85,
  mode: 'god-charge',
  equipment: [
   { id: GOD_LOADOUTS.zamorak.capeId, name: 'Zamorak cape' },
   { id: GOD_LOADOUTS.saradomin.staffId, name: 'Saradomin staff' },
  ],
  inventory: [
   { id: 563, name: 'Law rune', count: 1 },
   { id: 556, name: 'Air rune', count: 3 },
   { id: 554, name: 'Fire rune', count: 1 },
   { id: 2434, name: 'Prayer potion(4)', count: 1 },
   { id: 385, name: 'Shark', count: 10 },
  ],
 });
 expect(mismatched.ok).toBe(false);
 expect(mismatched.conflict).toEqual({ capeGod: 'zamorak', staffGod: 'saradomin' });
 expect(mismatched.escape).toBe('varrock_tele');
});

test('stageSupplyDeficit calculates missing quantities against staged stock', () => {
 expect(stageSupplyDeficit(
  [{ id: 563, count: 1 }, { id: 385, count: 14 }],
  [{ id: 563, count: 2 }, { id: 385, count: 10 }, { id: 2434, count: 2 }],
 )).toEqual([
  { id: 563, have: 1, need: 2, missing: 1 },
  { id: 2434, have: 0, need: 2, missing: 2 },
 ]);
});
