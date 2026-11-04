import {test,expect} from 'bun:test';
import {chompyHuntingTile,bellowsCharges,ownChompyNotches,runChompy} from './microbot-a-chompy';
test('native post-quest ogre zone excludes Rantz quest turf',()=>{
 expect(chompyHuntingTile({worldX:2600,worldZ:2970,level:0})).toBe(true);expect(chompyHuntingTile({worldX:2635,worldZ:2965,level:0})).toBe(false);expect(chompyHuntingTile({worldX:2600,worldZ:2970,level:1})).toBe(false);expect(chompyHuntingTile({worldX:2700,worldZ:2970,level:0})).toBe(false);
});
test('bellows charges and only fresh exact own-kill messages count',()=>{
 expect(bellowsCharges([{id:2871,count:1},{id:2872,count:2},{id:2873,count:1},{id:2874,count:1}])).toBe(9);
 const text='You scratch a notch on your bow for the chompy bird kill.';
 expect(ownChompyNotches([{text,tick:1,type:0,observationId:3},{text,tick:2,type:0,observationId:5},{text:'Other '+text,tick:3,type:0,observationId:6}],3)).toBe(1);
 // A nearby player repeating the notch text in public chat is not an owned kill.
 expect(ownChompyNotches([{text,tick:2,type:2,observationId:5}],3)).toBe(0);
});
test('hunting rejects invalid unbounded request before session access',async()=>{await expect(runChompy({} as any,{kills:6,cap:2000,maxBaits:6})).rejects.toThrow('invalid');await expect(runChompy({} as any,{kills:2,cap:2000,maxBaits:1})).rejects.toThrow('invalid');});
