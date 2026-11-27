import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { npcTravel, ROLLED_QUEST_PASSAGES, shortcutTravel, travelAllowed, UNGATED_QUEST_PASSAGES } from '../src/travel';
import { createWorld, rsPathLength, type Account } from '../src/world';

const npcRecords = JSON.parse(readFileSync('knowledge/npc-travel.json', 'utf8')).records as any[];
const cutRows = JSON.parse(readFileSync('knowledge/shortcuts.json', 'utf8')).edges as any[];
const account = (over: Partial<Account> = {}): Account => ({ skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10, ranged: 1, magic: 1, prayer: 1 }, varps: {}, items: [], ...over });

test('a consumed pass or ticket is the whole fare: the edge needs no coins', () => {
    // shantay_pass.rs2 takes only the pass; captain_shanks.rs2 takes only the ticket once one is held.
    for (const id of ['shantay_guard_still:kharidian-desert-south-of-shantay-pass', 'captain_shanks:port-khazard', 'captain_shanks:port-sarim']) {
        const row = npcRecords.find(r => r.id === id);
        expect(row?.fare?.coins).toBeNull();
        for (const edge of npcTravel([row])) expect(edge.coins).toBe(0);
    }
    const shantay = npcTravel([npcRecords.find(r => r.id === 'shantay_guard_still:kharidian-desert-south-of-shantay-pass')])[0]!;
    expect(shantay.needs).toContainEqual({ held: 'shantay_pass', count: 1 });
    expect(travelAllowed(shantay, account({ coins: 0, items: ['shantay_pass'] }))).toBe(true);
    expect(travelAllowed(shantay, account({ coins: 500 }))).toBe(false);
    // A fare given only as a rule, with no consumed item, still asks for 200 coins.
    const ruleOnly = { ...npcRecords.find(r => r.id === 'shantay_guard_still:kharidian-desert-south-of-shantay-pass'), items: [] };
    expect(npcTravel([ruleOnly])[0]!.coins).toBe(200);
});

test('the lumber yard fence is a walker edge, and quest-kind trap rows stay out', () => {
    const fence = cutRows.filter(e => e.locName === 'gertrudefence');
    expect(fence.length).toBeGreaterThan(0);
    const edges = shortcutTravel(fence);
    expect(edges.some(e => e.from?.x === 3305 && e.from?.z === 3494 && e.to.x === 3305 && e.to.z === 3492 && e.to.level === 0)).toBe(true);
    // The pocket exits listed in travel.ts are the other quest rows that go in (pocket-exits.test.ts).
    const others = cutRows.filter(e => e.kind === 'quest' && !UNGATED_QUEST_PASSAGES.has(e.locName) && !ROLLED_QUEST_PASSAGES[e.locName]);
    expect(shortcutTravel(others)).toEqual([]);
});

test('a route out of the lumber yard crosses the fence', async () => {
    const travel = shortcutTravel(cutRows.filter(e => e.locName === 'gertrudefence'));
    const world = createWorld({ travel, pathLength: await rsPathLength() });
    const route = world.route({ x: 3313, z: 3509, level: 0 }, { x: 3182, z: 3440, level: 0 }, account());
    expect(route.ok).toBe(true);
    if (route.ok) expect(route.legs.some(l => l.kind === 'travel' && l.travel.run.how === 'loc' && l.travel.run.loc === 'gertrudefence')).toBe(true);
}, 60_000);
