import {test,expect} from 'bun:test';
import {insideLegacyTrawler,trawlerEffect,runTrawlerSupport,type TrawlerDriver} from './microbot-b-trawler';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const state=(id=954,n=2,xp=100)=>({player:{worldX:1885,worldZ:4825,level:1,lifeId:1},inventory:[{id,count:n,slot:0,optionsWithIndex:[{text:'Bail-with',opIndex:1}]}],skills:[{name:'Crafting',level:50,experience:xp},{name:'Hitpoints',level:10}],nearbyLocs:[{id:2172,x:1880,z:4826,level:1,distance:1,optionsWithIndex:[{text:'Inspect',opIndex:1}]}],gameMessages:[]} as unknown as BotWorldState);
test('native support effects require exact supply debit and XP only for net',()=>{
 expect(insideLegacyTrawler(state())).toBe(true);expect(trawlerEffect(state(),state(),'net')).toBe(false);
 expect(trawlerEffect(state(),state(954,1,105),'net')).toBe(true);
 expect(()=>trawlerEffect(state(),state(954,1,100),'net')).toThrow('reconcile');
 expect(trawlerEffect(state(583,1),state(585,1),'bail','fill')).toBe(true);
 expect(trawlerEffect(state(585,1),state(583,1),'bail','empty')).toBe(true);
 expect(trawlerEffect(state(1941,10),state(1941,9),'leak')).toBe(true);
});
test('finite net support distinguishes fresh failed RNG roll and successful own repair',async()=>{
 let current=state(),tick=0,actions=0;
 const d:TrawlerDriver={state:()=>current,tick:()=>tick,stop:()=>false,item:async()=>true,object:async()=>{actions++;if(actions===1){current=structuredClone(current);current.gameMessages.push({type:0,text:'You fail to repair the net in the harsh conditions.',tick:1,observationId:1} as any);}else current=state(954,1,105);return true;},wait:async p=>p(),step:async()=>{tick++;}};
 expect(await runTrawlerSupport(d,{mode:'net',maximum:1,cap:50,maxAttempts:2})).toEqual({mode:'net',completed:1,attempts:2,ticks:1});
});
test('bailing cycles finish with same empty bucket and no XP claim',async()=>{
 let current=state(583,1),tick=0;
 current.player!.worldX=2017;current.player!.level=0;
 const d:TrawlerDriver={state:()=>current,tick:()=>tick,stop:()=>false,object:async()=>true,item:async()=>{current=structuredClone(current);const item=current.inventory[0]!;item.id=item.id===583?585:583;item.optionsWithIndex=[{text:item.id===583?'Bail-with':'Empty',opIndex:1}];return true;},wait:async p=>p(),step:async()=>{tick++;}};
 expect((await runTrawlerSupport(d,{mode:'bail',maximum:2,cap:50,maxAttempts:2})).completed).toBe(2);expect(current.inventory[0]!.id).toBe(583);
});
