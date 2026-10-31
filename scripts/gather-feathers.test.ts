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
