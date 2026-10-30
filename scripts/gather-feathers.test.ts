import { expect, test } from 'bun:test';
import { parsePen } from './gather-feathers';

test('the chicken pen comes from PEN, Lumbridge by default', () => {
    expect(parsePen('3017,3288')).toEqual({ x: 3017, z: 3288 });
    expect(parsePen(undefined)).toEqual({ x: 3229, z: 3298 });
    expect(parsePen('bad')).toEqual({ x: 3229, z: 3298 });
});
