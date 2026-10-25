import {test,expect} from 'bun:test';
import {fireMaxHit,fireFightSafe,fireDeathCredit} from './gather-fire-combat';
test('actual Fire110 maximum is11; mandatory retreat bounds are strict',()=>{expect(fireMaxHit).toBe(11);expect(fireFightSafe(31,8,249)).toBe(true);expect(fireFightSafe(30,8,249)).toBe(false);expect(fireFightSafe(71,7,1)).toBe(false);expect(fireFightSafe(71,16,250)).toBe(false);});
test('no partial XP, disappearance-only or unrelated excess bones counts as full Fire kill',()=>{expect(fireDeathCredit(11100,true,1)).toBe(true);expect(fireDeathCredit(11000,true,1)).toBe(false);expect(fireDeathCredit(11100,false,1)).toBe(false);expect(fireDeathCredit(11100,true,0)).toBe(false);expect(fireDeathCredit(11100,true,2)).toBe(false);});
