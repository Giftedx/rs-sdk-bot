import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {effectText} from './gen-item-stats';

test('an effect line names the heal, the boost, the restore and the run energy',()=>{
 expect(effectText([['stat_heal','hitpoints','12','0']])).toBe('heals 12');
 expect(effectText([['stat_change','attack','3','10']])).toBe('Attack +3 +10%');
 expect(effectText([['stat_change','attack','-3','0'],['stat_heal','hitpoints','1','0']])).toBe('Attack -3 · heals 1');
 expect(effectText([['stat_heal','prayer','7','25']])).toBe('restores Prayer 7 + 25%');
 expect(effectText(['attack','defence','strength','ranged','magic','mining','fishing'].map(s=>['stat_heal',s,'8','25']))).toBe('restores all stats 8 + 25%');
 expect(effectText([['healenergy','1000']])).toBe('run energy +10%');
 expect(effectText([['stat_heal','hitpoints','0','0']])).toBe('');
});

test('the item stats file has the food and the potions by item name',()=>{
 const stats=JSON.parse(readFileSync(new URL('./client-assets/item-stats.json',import.meta.url),'utf8'));
 expect(stats.Lobster).toBe('heals 12');
 expect(stats.Shark).toBe('heals 20');
 expect(stats['Prayer potion(3)']).toBe('restores Prayer 7 + 25%');
 expect(Object.keys(stats).length).toBeGreaterThan(150);
 for(const v of Object.values(stats))expect(typeof v==='string'&&v.length>0&&v.length<120).toBe(true);
});
