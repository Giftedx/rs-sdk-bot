import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(import.meta.dir + '/index.html', 'utf8');
const code = html.slice(html.indexOf('function viewerMaxLevel(){'), html.indexOf('function syncRoofs(){'));
const level = (sel: string, S: any, w: any = {}) => new Function('window', 'S', 'sel', `${code};return viewerMaxLevel();`)({ atlasRoofsOff: () => true, ...w }, S, sel);

test('roof removal draws up to the followed player floor', () => {
    expect(level('Bob', { roster: [['bob', 3200, 3200, 1, 3]], bots: [] })).toBe(1);
    expect(level('Bob', { roster: [], bots: [{ name: 'Bob', pos: { level: 0 } }] })).toBe(0);
    expect(level('Bob', { roster: [['ann', 1, 1, 2, 3]], bots: [{ name: 'Ann', pos: { level: 0 } }] }, { atlasFollowOther: 'Ann' })).toBe(2);
});
test('every floor draws with the switch off, in free camera, or with no known floor', () => {
    const S = { roster: [['bob', 3200, 3200, 0, 3]], bots: [] };
    expect(level('Bob', S, { atlasRoofsOff: () => false })).toBe(3);
    expect(level('Bob', S, { atlasFreeCamera: true })).toBe(3);
    expect(level('Nobody', S)).toBe(3);
});
