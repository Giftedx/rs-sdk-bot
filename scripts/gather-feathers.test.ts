import { expect, test } from 'bun:test';
import { parsePen, finishPenEntry } from './gather-feathers';

test('the chicken pen comes from PEN, Lumbridge by default', () => {
    expect(parsePen('3017,3288')).toEqual({ x: 3017, z: 3288 });
    expect(parsePen(undefined)).toEqual({ x: 3229, z: 3298 });
    expect(parsePen('bad')).toEqual({ x: 3229, z: 3298 });
});

test('pen tiles are the ground-floor chicken spawns within 15 tiles, nearest first', () => {
    const { penTiles } = require('./gather-feathers');
    expect(penTiles({ x: 2851, z: 3370 }, [{ x: 2855, z: 3372, level: 0 }, { x: 2852, z: 3369, level: 0 }, { x: 2852, z: 3369, level: 1 }, { x: 2900, z: 3370, level: 0 }]))
        .toEqual([{ x: 2852, z: 3369 }, { x: 2855, z: 3372 }]);
});

test('a successful route or walk reply outside a fence cannot admit the chicken worker',async()=>{
    let player={worldX:3196,worldZ:3351,level:0};const clicks:number[][]=[];
    const s={sdk:{getState:()=>({player})},bot:{walkTo:async(x:number,z:number,tolerance?:number)=>{clicks.push([x,z,tolerance!]);return {success:true};}}};
    expect(await finishPenEntry(s,{x:3197,z:3353})).toBe(false);
    expect(clicks).toEqual([[3197,3353,0]]);
    s.bot.walkTo=async()=>{player={worldX:3197,worldZ:3353,level:0};return {success:true};};
    expect(await finishPenEntry(s,{x:3197,z:3353})).toBe(true);
});

test('the pen walk ends at the first exact arrival, and a failed walk that ends no closer ends the travel with its cause',async()=>{
    const {enterPen}=require('./gather-feathers');
    const pen={x:3017,z:3288},tiles=[{x:3015,z:3290},{x:3018,z:3287},pen];
    let player={worldX:2575,worldZ:3269,level:1};const walks:string[]=[];
    const s={sdk:{getState:()=>({player})},bot:{walkTo:async()=>({success:true})}};
    // No route from the start: one try, not one for each tile.
    expect(await enterPen(s,pen,tiles,async(to:{x:number;z:number;level:number})=>{walks.push(`${to.x},${to.z},${to.level}`);return {ok:false,reason:'precondition',detail:'no route to 3015,3290,0'};}))
        .toBe('precondition no route to 3015,3290,0');
    expect(walks).toEqual(['3015,3290,0']);
    // A long walk that stops closer to the pen gets the next try; the second tile is entered.
    walks.length=0;
    expect(await enterPen(s,pen,tiles,async(to:{x:number;z:number;level:number})=>{
        walks.push(`${to.x},${to.z},${to.level}`);
        if(walks.length===1){player={worldX:2772,worldZ:3225,level:0};return {ok:false,reason:'timeout',detail:'walk stopped'};}
        player={worldX:to.x,worldZ:to.z,level:0};return {ok:true};
    })).toBeNull();
    expect(walks).toEqual(['3015,3290,0','3018,3287,0']);
    // A walk that arrives beside the fence tries the next tile, and the fault names the entry.
    player={worldX:3016,worldZ:3291,level:0};
    expect(await enterPen(s,pen,tiles,async()=>({ok:true}))).toBe('exact pen entry unobserved');
});
