import {expect,test} from 'bun:test';
import {configTable,decodeAppearance,WEAR_SLOTS} from './appearance';

// Writes a block the way Player.generateAppearance does: gender, head icons, 12 slots, 5 colours, 7 animations,
// the base-37 name, the combat level and the total level.
function block(name:string,combat:number,slots:(number|null)[],npc?:number){
 const out:number[]=[0,0];const p2=(v:number)=>out.push((v>>8)&255,v&255);
 for(let s=0;s<12;s++){if(npc!=null){p2(0xffff);p2(npc);break;}const v=slots[s];if(v==null)out.push(0);else p2(v);}
 out.push(1,2,3,4,5);for(let i=0;i<7;i++)p2(808);
 let v=0n;for(const c of name.toLowerCase())v=v*37n+BigInt(' abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(c));
 for(let i=7;i>=0;i--)out.push(Number((v>>BigInt(i*8))&255n));out.push(combat);p2(0);
 return btoa(String.fromCharCode(...out));
}

test('appearance: worn items by slot, body parts skipped, name and combat level read after the colours and animations',()=>{
 const slots:(number|null)[]=Array(12).fill(null);slots[0]=0x200+1155;slots[3]=0x200+1277;slots[4]=0x100+18;slots[7]=0x200+1075;
 expect(decodeAppearance(block('Money 01',27,slots))).toEqual({name:'money 01',combat:27,worn:[{slot:0,obj:1155},{slot:3,obj:1277},{slot:7,obj:1075}]});
 expect(WEAR_SLOTS[3]).toBe('Weapon');
});
test('appearance: an npc transform has no worn items; a short or broken block is null',()=>{
 expect(decodeAppearance(block('Imp',5,[],1))?.worn).toEqual([]);
 expect(decodeAppearance('AAA')).toBeNull();expect(decodeAppearance('not base64!')).toBeNull();
});
test('content table: pack ids joined to config names, with shown levels',()=>{
 const t=configTable('0=a\n1=b\n2=c',['[a]\nname=Bronze sword\n[b]\nname=Man\nvislevel=2\n[c]\ndesc=no name']);
 expect([...t]).toEqual([[0,{name:'Bronze sword'}],[1,{name:'Man',level:2}]]);
});
