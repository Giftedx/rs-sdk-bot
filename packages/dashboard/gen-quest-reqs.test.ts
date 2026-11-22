import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTENT_REQS, citeFaults, dropCycles, joinReqs, journalLevels, parseConstants, serverLevels, serverPrereqs, serverQuestPoints, wikiItems, wikiOnly, wikiReqs, type Reqs } from './gen-quest-reqs';

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

const ROUTE_BEFORE: Readonly<Record<string, readonly string[]>> = { Regicide: ['Underground Pass'] };

test('the asset holds every quest prerequisite that PK route rules enforce (ROUTE_BEFORE)', () => {
    const asset = JSON.parse(readFileSync(new URL('./client-assets/quest-reqs.json', import.meta.url), 'utf8')) as Record<string, Reqs>;
    for (const [quest, before] of Object.entries(ROUTE_BEFORE)) expect(asset[quest]?.q.map(([n]) => n)).toEqual(expect.arrayContaining([...before]));
});

test('the wiki requirements: skills, quest points and quest names; recommended and optional lines are left out', () => {
    const page = `# Hero's Quest\n\n## Requirements\n\n- Completion of **Shield of Arrav**, **Lost City**\n- 55 Quest Points\n- 50 Mining\n- 20 Agility (for shortcuts)\n- 33 Magic (for Telegrab spell)\n- 40 Ranged or 40 Magic\n- Recommended: Druidic Ritual quest complete\n- Ability to defeat a level 172 enemy\n\n## Items Needed\n\n- 50 Mining\n`;
    const w = wikiReqs(page, ['Shield of Arrav', 'Lost City', 'Druidic Ritual']);
    expect(w).toEqual({ s: new Map([['Mining', 50]]), qp: 55, q: ['Shield of Arrav', 'Lost City'] });
    // The server level wins and marks the line checked; a server-only skill is marked 2. A row that only the wiki
    // lists (Shield of Arrav here) is not in the output: wikiOnly names it.
    const levels = new Map([['Mining', 52], ['Prayer', 10]]);
    expect(joinReqs(levels, new Set([55]), new Set(['Lost City']), w)).toEqual({
        s: [['Mining', 52, 1], ['Prayer', 10, 2]], qp: [55, 1], q: [['Lost City', 1]],
    });
    expect(wikiOnly(levels, new Set([55]), new Set(['Lost City']), w)).toEqual(['Shield of Arrav']);
    // No content check of the wiki's level, quest points or quest: no row, and the quest points of the folder stand.
    expect(joinReqs(new Map(), new Set(), new Set(), w, new Set([40]))).toEqual({ s: [], qp: [40, 2], q: [] });
    expect(wikiOnly(new Map(), new Set(), new Set(), w)).toEqual(['50 Mining', '55 QP', 'Shield of Arrav', 'Lost City']);
});

test('the wiki items: real item names with counts; plurals fall back to the singular; quest-given items and coins are left out', () => {
    const page = `# Dragon Slayer\n\n## Items Needed\n\n- Silk\n- Wizard's Mind Bomb (or 33 Magic)\n- 3 Planks\n- 2,000+ gp (for the ship)\n- Anti-dragon shield (obtained during quest)\n- Food and combat equipment\n- Unknown thing\n\n## Rewards\n\n- Silk\n`;
    const items = new Map([['silk', { name: 'Silk', debugname: 'silk' }], ["wizard's mind bomb", { name: "Wizard's mind bomb", debugname: 'wizards_mind_bomb' }],
        ['plank', { name: 'Plank', debugname: 'plank' }], ['anti-dragon shield', { name: 'Anti-dragon shield', debugname: 'antidragonbreathshield' }]]);
    expect(wikiItems(page, items)).toEqual([['Silk', 1, 'silk'], ["Wizard's mind bomb", 1, 'wizards_mind_bomb'], ['Plank', 3, 'plank']]);
});

test('wiki requirements ignore ### Recommended subheadings, and journalLevels excludes advantage phrasing', () => {
    const page = `# Underground Pass\n\n## Requirements\n\n### Quest Prerequisites\n\n- Biohazard\n\n### Skill Requirements\n\n- 25 Ranged\n\n### Recommended\n\n- 50 Agility\n- 43 Prayer\n`;
    expect(wikiReqs(page, ['Biohazard'])).toEqual({ s: new Map([['Ranged', 25]]), qp: null, q: ['Biohazard'] });
    expect(journalLevels(['Level 35 agility|Level 13 or higher magic will be an advantage'])).toEqual(new Map([['Agility', 35]]));
    expect(journalLevels(['It would be an advantage to have at least one of Level 35 Herblore'])).toEqual(new Map());
    expect(journalLevels(['Level 30 Ranging|Level 30 Cooking'])).toEqual(new Map([['Ranged', 30], ['Cooking', 30]]));
});

test('a server-only prerequisite that needs the quest back is dropped', () => {
    const out: Record<string, Reqs> = {
        'Death Plateau': { s: [], q: [['Troll Stronghold', 2]] },
        'Troll Stronghold': { s: [['Agility', 15, 2]], q: [['Death Plateau', 1]] },
    };
    dropCycles(out);
    expect(out).toEqual({ 'Troll Stronghold': { s: [['Agility', 15, 2]], q: [['Death Plateau', 1]] } });
});

const contentScripts = new URL('../../vendor/rs-sdk/server/content/scripts/', import.meta.url);
const readContent = (file: string) => { try { return readFileSync(new URL(file, contentScripts), 'utf8'); } catch { return null; } };

test('each cited requirement outside a quest folder is a line of the content', () => {
    expect(citeFaults(readContent)).toEqual([]);
    // The rows that the wiki listed with no check in the quest's own folder.
    expect(CONTENT_REQS.quest_hero!.s!.map(([skill, level]) => `${level} ${skill}`).sort()).toEqual(['25 Herblore', '50 Mining', '53 Cooking', '53 Fishing']);
    expect(CONTENT_REQS.quest_upass!.s).toEqual([['Ranged', 25, ['areas/area_ardougne_east/scripts/king_lathas.rs2', 95, 'if(stat_base(ranged) < 25) {']]]);
});

test('a citation fails when the file, the line or the level does not match', () => {
    const read = (file: string) => file === 'a.rs2' ? 'first\nif(stat(mining) < 50) {\n' : null;
    expect(citeFaults(read, { quest_x: { s: [['Mining', 50, ['a.rs2', 2, 'stat(mining) < 50']]] } })).toEqual([]);
    expect(citeFaults(read, { quest_x: { s: [['Mining', 50, ['a.rs2', 1, 'stat(mining) < 50']]] } })).toEqual(['quest_x needs 50 Mining: a.rs2:1 does not hold "stat(mining) < 50" (line: "first")']);
    expect(citeFaults(read, { quest_x: { q: [['quest_y', ['b.rs2', 1, '^y_complete']]] } })).toEqual(['quest_x needs quest_y: b.rs2:1 is not in the content']);
    // The level of the row is not the level of the cited check.
    expect(citeFaults(read, { quest_x: { s: [['Mining', 5, ['a.rs2', 2, 'stat(mining) < 50']]] } })).toEqual(['quest_x needs 5 Mining: the text "stat(mining) < 50" does not hold the level 5']);
});

test('the asset holds no row that only the wiki lists, and holds the cited rows', () => {
    const asset = JSON.parse(readFileSync(new URL('./client-assets/quest-reqs.json', import.meta.url), 'utf8')) as Record<string, Reqs>;
    for (const [quest, r] of Object.entries(asset)) {
        for (const row of [...r.s, ...r.q, ...(r.qp ? [r.qp] : [])]) expect([quest, row.at(-1) === 1 || row.at(-1) === 2]).toEqual([quest, true]);
    }
    expect(asset["Hero's Quest"]!.s).toEqual([['Cooking', 53, 1], ['Fishing', 53, 1], ['Mining', 50, 1], ['Herblore', 25, 1]]);
    expect(asset['Underground Pass']!.s).toEqual([['Thieving', 50, 2], ['Ranged', 25, 1]]);
    expect(asset['Underground Pass']!.q).toEqual([['Biohazard', 1]]);
    expect(asset['Shilo Village']!.q).toEqual([['Jungle Potion', 1]]);
    expect(asset['Shades of Mortton']!.s).toEqual([['Crafting', 20, 2], ['Herblore', 15, 2], ['Firemaking', 5, 2]]);
    // quest_itgronigen makes the lens with no level check (quest_itgronigen.rs2 [label,craft_telescope_disc]).
    expect(asset['Observatory Quest']).toBeUndefined();
});
