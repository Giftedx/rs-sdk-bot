import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNpcAttackStyles, npcAttackStyles } from '../src/npc-attack-styles';
import { parsePack } from '../src/pack';
import { contentRoot } from '../src/paths';

const ids = new Map([...parsePack(readFileSync(join(contentRoot(), 'pack/npc.pack'), 'utf8'))].map(([id, name]) => [name, id] as const));
const of = (name: string) => npcAttackStyles().get(ids.get(name)!);

test('ranged NPCs: [ai_applayer2,gnome] ~npc_rangeattack (area_gnome/scripts/gnomes.rs2:19)', () => {
    expect(of('gnome')).toEqual(['ranged']);
    expect(of('ardougne_archer')).toEqual(['ranged']);
});

test('magic NPCs', () => {
    expect(of('wizard')).toEqual(['magic']);
    expect(of('saradomin_mage')).toEqual(['magic']);
});

test('an NPC with melee and another style lists both', () => {
    expect(of('black_dragon')).toEqual(['melee', 'magic']);
});

test('an NPC with the default attack script is not in the table', () => {
    expect(ids.get('giant')).toBe(117);
    expect(of('giant')).toBeUndefined();
    expect(of('cow')).toBeUndefined();
});

test('a category script reaches each NPC of the category', () => {
    const table = npcAttackStyles();
    expect(table.size).toBeGreaterThan(60);
    for (const styles of table.values()) expect(styles.some(s => s !== 'melee')).toBe(true);
});

test('the kept table is the built table', () => {
    expect([...npcAttackStyles()]).toEqual([...buildNpcAttackStyles()]);
});

test('a spell that binds and drains puts magic first: chaos druid; a dragon keeps melee first', () => {
    expect(of('chaos_druid')![0]).toBe('magic');
    expect(of('black_dragon')).toEqual(['melee', 'magic']);
    expect(of('king_dragon')![0]).toBe('melee');
    const first = [...buildNpcAttackStyles()].filter(([, styles]) => styles.length > 1 && styles[0] === 'magic').map(([id]) => id);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(20);
});
