import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dropCycles, joinReqs, parseConstants, serverLevels, serverPrereqs, serverQuestPoints, wikiItems, wikiReqs, type Reqs } from './gen-quest-reqs';

test('the server checks: the highest level of each skill, quest points and completion gates, with ^constants', () => {
    const constants = parseConstants(['^hero_required_questpoints = 55\n^zanaris_complete = 6\n']);
    const scripts = ['if (stat(mining) < 52) {', 'if (stat_base(mining) >= 50) {', 'if (stat(hitpoints) < 20) {', 'if (stat(magic) < ^legends_magic) {',
        'if (%qp < ^hero_required_questpoints | %zanaris < ^zanaris_complete | %hero < ^hero_complete) {', 'if (%regicide_progress >= 3) {'];
    expect(serverLevels(scripts, new Map([['legends_magic', 56]]))).toEqual(new Map([['Mining', 52], ['Magic', 56]]));
    expect(serverQuestPoints(scripts, constants)).toEqual(new Set([55]));
    // The quest's own varp and a varp that is not compared to a completion value are not prerequisites.
    expect(serverPrereqs(scripts, new Map([['zanaris', 'quest_zanaris'], ['hero', 'quest_hero'], ['regicide_progress', 'quest_regicide']]), 'quest_hero')).toEqual(new Set(['quest_zanaris']));
});

test('a journal script states the start conditions: any completion test there is a prerequisite', () => {
    const varps = new Map([['upass', 'quest_upass'], ['regicide', 'quest_regicide']]);
    expect(serverPrereqs([], varps, 'quest_regicide', ['if(%upass = ^upass_complete) {'])).toEqual(new Set(['quest_upass']));
    expect(serverPrereqs(['if(%upass = ^upass_complete) {'], varps, 'quest_regicide')).toEqual(new Set());
});

test('the asset holds every quest prerequisite that the planner enforces (autopilot.ts ROUTE_BEFORE)', async () => {
    const { ROUTE_BEFORE } = await import('../planner/src/autopilot');
    const asset = JSON.parse(readFileSync(new URL('./client-assets/quest-reqs.json', import.meta.url), 'utf8')) as Record<string, Reqs>;
    for (const [quest, before] of Object.entries(ROUTE_BEFORE)) expect(asset[quest]?.q.map(([n]) => n)).toEqual(expect.arrayContaining([...before]));
});

test('the wiki requirements: skills, quest points and quest names; recommended and optional lines are left out', () => {
    const page = `# Hero's Quest\n\n## Requirements\n\n- Completion of **Shield of Arrav**, **Lost City**\n- 55 Quest Points\n- 50 Mining\n- 20 Agility (for shortcuts)\n- 33 Magic (for Telegrab spell)\n- 40 Ranged or 40 Magic\n- Recommended: Druidic Ritual quest complete\n- Ability to defeat a level 172 enemy\n\n## Items Needed\n\n- 50 Mining\n`;
    const w = wikiReqs(page, ['Shield of Arrav', 'Lost City', 'Druidic Ritual']);
    expect(w).toEqual({ s: new Map([['Mining', 50]]), qp: 55, q: ['Shield of Arrav', 'Lost City'] });
    // The server level wins and marks the line checked; a server-only skill is marked 2, a wiki-only line 0.
    expect(joinReqs(new Map([['Mining', 52], ['Prayer', 10]]), new Set([55]), new Set(['Lost City']), w)).toEqual({
        s: [['Mining', 52, 1], ['Prayer', 10, 2]], qp: [55, 1], q: [['Shield of Arrav', 0], ['Lost City', 1]],
    });
});

test('the wiki items: real item names with counts; plurals fall back to the singular; quest-given items and coins are left out', () => {
    const page = `# Dragon Slayer\n\n## Items Needed\n\n- Silk\n- Wizard's Mind Bomb (or 33 Magic)\n- 3 Planks\n- 2,000+ gp (for the ship)\n- Anti-dragon shield (obtained during quest)\n- Food and combat equipment\n- Unknown thing\n\n## Rewards\n\n- Silk\n`;
    const items = new Map([['silk', { name: 'Silk', debugname: 'silk' }], ["wizard's mind bomb", { name: "Wizard's mind bomb", debugname: 'wizards_mind_bomb' }],
        ['plank', { name: 'Plank', debugname: 'plank' }], ['anti-dragon shield', { name: 'Anti-dragon shield', debugname: 'antidragonbreathshield' }]]);
    expect(wikiItems(page, items)).toEqual([['Silk', 1, 'silk'], ["Wizard's mind bomb", 1, 'wizards_mind_bomb'], ['Plank', 3, 'plank']]);
});

test('a server-only prerequisite that needs the quest back is dropped', () => {
    const out: Record<string, Reqs> = {
        'Death Plateau': { s: [], q: [['Troll Stronghold', 2]] },
        'Troll Stronghold': { s: [['Agility', 15, 2]], q: [['Death Plateau', 0]] },
    };
    dropCycles(out);
    expect(out).toEqual({ 'Troll Stronghold': { s: [['Agility', 15, 2]], q: [['Death Plateau', 0]] } });
});
