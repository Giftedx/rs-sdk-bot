import {test,expect} from 'bun:test';
import type {PathPoint} from '../packages/core/src/walk';
import {runeMysteriesWalk,runeMysteriesStartProblem,walkRuneMysteries,exitRuneTower,runeMysteriesDecision} from './rune-mysteries-route';

test('starting talisman is not completion; package handoff interruption resumes notes',()=>{
 expect(runeMysteriesDecision('started',[1438])).toBe('talisman');
 expect(runeMysteriesDecision('not started',[1438])).toBe('duke');
 expect(runeMysteriesDecision('unknown',[1438])).toBe('observe');
 expect(runeMysteriesDecision('started',[290])).toBe('package');
 expect(runeMysteriesDecision('started',[])).toBe('recover-notes');
 expect(runeMysteriesDecision('started',[291])).toBe('notes');
 expect(runeMysteriesDecision('complete',[])).toBe('complete');
});
test('a new miner must qualify before entering the guarded Rune Mysteries route',()=>{
 for(const combat of [undefined,NaN,3,12,12.5])expect(runeMysteriesStartProblem(combat)).toMatch(/combat13/);
 expect(runeMysteriesStartProblem(13)).toBeNull();
});
test('Draynor to the Duke uses the proved north corridor instead of the jail shortcut',()=>{
 const route=runeMysteriesWalk({worldX:3092,worldZ:3243,level:0},{x:3205,z:3209,tol:2});
 expect(route).toContainEqual({x:3089,z:3320,tol:1});
 expect(route).toContainEqual({x:3180,z:3320,tol:0});
 expect(route.at(-1)).toEqual({x:3205,z:3209,tol:2});
});
test('Varrock and tower walking legs reuse both low-level corridors to avoid the wizard circle',()=>{
 const home={x:3221,z:3218,tol:2};
 const down=runeMysteriesWalk({worldX:3253,worldZ:3398,level:0},home);
 expect(down).toContainEqual({x:3171,z:3427,tol:0});
 expect(down).toContainEqual({x:3198,z:3370,tol:0});expect(down.at(-1)).toEqual(home);
 const up=runeMysteriesWalk({worldX:3109,worldZ:3166,level:0},{x:3253,z:3420,tol:2});
 expect(up).toContainEqual({x:3089,z:3320,tol:1});expect(up).toContainEqual({x:3171,z:3427,tol:0});
});

test('leaving the tower stays east of the Draynor wizards before taking the north corridor',()=>{
 const route=runeMysteriesWalk({worldX:3109,worldZ:3167,level:0},{x:3253,z:3420,tol:2});
 expect(route.slice(0,3)).toEqual([{x:3097,z:3212,tol:0},{x:3096,z:3230,tol:0},{x:3092,z:3243,tol:0}]);
 expect(route).toContainEqual({x:3089,z:3320,tol:1});
});
test('Lumbridge to the tower avoids the live bear damage point and the Draynor jail shortcut',()=>{
 const to={x:3109,z:3167,tol:1};
 const route=runeMysteriesWalk({worldX:3221,worldZ:3218,level:0},to);
 expect(route).toContainEqual({x:3226,z:3250,tol:0});
 expect(route).toContainEqual({x:3180,z:3258,tol:0});
 expect(route).toContainEqual({x:3100,z:3285,tol:0});
 expect(route).toContainEqual({x:3092,z:3243,tol:0});
 expect(route).toContainEqual({x:3096,z:3230,tol:0});
 expect(route).toContainEqual({x:3097,z:3212,tol:0});
 expect(route.at(-1)).toEqual(to);
});

test('the Draynor tower approach uses the walkable bank-side lane; unknown floors are refused',()=>{
 const to={x:3109,z:3167,tol:1};
 expect(runeMysteriesWalk({worldX:3092,worldZ:3243,level:0},to)).toEqual([{x:3096,z:3230,tol:0},{x:3097,z:3212,tol:0},to]);
 // A stopped forest leg already south of the jail must not head north again.
 expect(runeMysteriesWalk({worldX:3141,worldZ:3212,level:0},to)).toEqual([{x:3097,z:3212,tol:0},to]);
 expect(()=>runeMysteriesWalk(undefined,to)).toThrow('position');
 expect(()=>runeMysteriesWalk({worldX:3092,worldZ:3243,level:1},to)).toThrow('surface');
});

test('a failed corridor leg cannot fall back directly to the final destination',async()=>{
 const seen:PathPoint[]=[];
 await expect(walkRuneMysteries({worldX:3092,worldZ:3243,level:0},{x:3205,z:3209,tol:2},async point=>{seen.push(point);throw Error('route failure');})).rejects.toThrow('route failure');
 expect(seen).toEqual([{x:3092,z:3250,tol:0}]);
 const completed:PathPoint[]=[];
 await walkRuneMysteries({worldX:3092,worldZ:3243,level:0},{x:3205,z:3209,tol:2},async point=>{completed.push(point);});
 expect(completed).toContainEqual({x:3089,z:3320,tol:1});expect(completed.at(-1)).toEqual({x:3205,z:3209,tol:2});
});

test('a server restart while carrying the package resumes the western Varrock corridor',()=>{
 const route=runeMysteriesWalk({worldX:3220,worldZ:3270,level:0},{x:3212,z:3424,tol:2});
 expect(route[0]).toEqual({x:3230,z:3298,tol:0});
 const west=route.findIndex(p=>p.x===3198&&p.z===3370);
 const north=route.findIndex(p=>p.x===3171&&p.z===3427);
 expect(west).toBeGreaterThan(0);expect(north).toBeGreaterThan(west);
 expect(route.at(-1)).toEqual({x:3212,z:3424,tol:2});
});

test('tower exit waits for the surface objects, then crosses the inner door before opening the outer one',async()=>{
 const calls:string[]=[];let ready=false,inner=false,inHall=false;
 await exitRuneTower({waitForLanding:async()=>{ready=true;calls.push('observed');return true;},
  openDoor:async(_label,x,z)=>{expect(ready).toBe(true);if(x===3107){inner=true;calls.push('inner');}else{expect(inHall).toBe(true);calls.push('outer');}},
  dash:async(_label,x,z)=>{expect(inner).toBe(true);if(z===3164){inHall=true;calls.push('hall');}else calls.push('outside');}
 });expect(calls).toEqual(['observed','inner','hall','outer','outside']);
 const actions:string[]=[];
 await expect(exitRuneTower({waitForLanding:async()=>false,openDoor:async()=>{actions.push('door');},dash:async()=>{actions.push('walk');}})).rejects.toThrow('landing');
 expect(actions).toEqual([]);
});
