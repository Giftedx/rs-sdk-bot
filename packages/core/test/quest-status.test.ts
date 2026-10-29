import {test,expect} from 'bun:test';
import {questDefinitions,questFlags} from '../src/quest-status';

test('all 68 journal components map; pristine red is unknown, server colours are observations',()=>{
 const defs=questDefinitions();expect(defs).toHaveLength(68);expect(new Set(defs.map(d=>d.id)).size).toBe(68);
 const client={ingame:true,ifType:(id:number)=>({colour:({1:0xff0000,2:0xf80000,3:0xf8f800,4:0x00f800} as any)[id]})};
 const flags=questFlags(client,[1,2,3,4,5].map(id=>({id,name:String(id)})));
 expect(flags?.map(f=>f.state)).toEqual(['unknown','not started','started','complete','unknown']);
 expect(questFlags({...client,ingame:false})).toBeNull();expect(questFlags(null)).toBeNull();
});

test('quest observations stay on their own client and do not need game actions',()=>{
 const defs=[{id:7333,name:"Cook's Assistant"}];
 const a={ingame:true,ifType:()=>({colour:0x00f800})},b={ingame:true,ifType:()=>({colour:0xf80000})};
 expect(questFlags(a,defs)?.[0]?.state).toBe('complete');expect(questFlags(b,defs)?.[0]?.state).toBe('not started');expect(questFlags(a,defs)?.[0]?.state).toBe('complete');
});
