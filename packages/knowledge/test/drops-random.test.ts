import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseDrops} from '../src/drops';

test('calc(random(n)+offset) preserves the exclusive random domain, not a fixed count or mean',()=>{
    for(const [n,offset] of [[12,1],[11,2],[1,7],[6,0]]){
        const expression=`calc(random(${n}) + ${offset})`;
        const text=`[ai_queue3,fixture]\ndef_int $r = random(128);\nif ($r < 5) {\nobj_add(npc_coord, bolts, ${expression}, ^lootdrop_duration);\n}\n`;
        const roll=parseDrops(text,'fixture.rs2')[0]!.rolls[0]!;
        const possible=Array.from({length:n!},(_,i)=>offset!+i);
        expect([roll.count,roll.countMax]).toEqual([Math.min(...possible),Math.max(...possible)]);
    }
});

test('actual pinned dragon bolt drops retain their source-bound amount range',()=>{
    const root=join(import.meta.dir,'../../../vendor/rs-sdk/server/content/scripts/drop tables/scripts');
    for(const [name,min,max] of [['bronze_dragon',1,12],['iron_dragon',2,12],['steel_dragon',2,12]] as const){
        const path=join(root,`${name}.rs2`);
        const rows=parseDrops(readFileSync(path,'utf8'),`${name}.rs2`);
        const bolt=rows.flatMap(t=>t.rolls).find(r=>r.item==='bolts');
        expect(bolt).toBeDefined();
        expect([bolt!.count,bolt!.countMax]).toEqual([min,max]);
        expect(readFileSync(path,'utf8').split(/\r?\n/)[Number(bolt!.src.split(':').at(-1))-1]).toContain('calc(random(');
    }
});
