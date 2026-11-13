import { expect, test } from 'bun:test';
import { dropCycles, joinReqs, parseConstants, serverLevels, serverPrereqs, serverQuestPoints, wikiReqs, type Reqs } from './gen-quest-reqs';

test('the server checks: the highest level of each skill, quest points and completion gates, with ^constants', () => {
    const constants = parseConstants(['^hero_required_questpoints = 55\n^zanaris_complete = 6\n']);
    const scripts = ['if (stat(mining) < 52) {', 'if (stat_base(mining) >= 50) {', 'if (stat(hitpoints) < 20) {', 'if (stat(magic) < ^legends_magic) {',
        'if (%qp < ^hero_required_questpoints | %zanaris < ^zanaris_complete | %hero < ^hero_complete) {', 'if (%regicide_progress >= 3) {'];
    expect(serverLevels(scripts, new Map([['legends_magic', 56]]))).toEqual(new Map([['Mining', 52], ['Magic', 56]]));
    expect(serverQuestPoints(scripts, constants)).toEqual(new Set([55]));
    // The quest's own varp and a varp that is not compared to a completion value are not prerequisites.
    expect(serverPrereqs(scripts, new Map([['zanaris', 'quest_zanaris'], ['hero', 'quest_hero'], ['regicide_progress', 'quest_regicide']]), 'quest_hero')).toEqual(new Set(['quest_zanaris']));
});

test('the wiki requirements: skills, quest points and quest names; recommended and optional lines are left out', () => {
    const page = `# Hero's Quest\n\n## Requirements\n\n- Completion of **Shield of Arrav**, **Lost City**\n- 55 Quest Points\n- 50 Mining\n- 20 Agility (for shortcuts)\n- Recommended: Druidic Ritual quest complete\n- Ability to defeat a level 172 enemy\n\n## Items Needed\n\n- 50 Mining\n`;
    const w = wikiReqs(page, ['Shield of Arrav', 'Lost City', 'Druidic Ritual']);
    expect(w).toEqual({ s: new Map([['Mining', 50]]), qp: 55, q: ['Shield of Arrav', 'Lost City'] });
    // The server level wins and marks the line checked; a server-only skill is marked 2, a wiki-only line 0.
    expect(joinReqs(new Map([['Mining', 52], ['Prayer', 10]]), new Set([55]), new Set(['Lost City']), w)).toEqual({
        s: [['Mining', 52, 1], ['Prayer', 10, 2]], qp: [55, 1], q: [['Shield of Arrav', 0], ['Lost City', 1]],
    });
});

test('a server-only prerequisite that needs the quest back is dropped', () => {
    const out: Record<string, Reqs> = {
        'Death Plateau': { s: [], q: [['Troll Stronghold', 2]] },
        'Troll Stronghold': { s: [['Agility', 15, 2]], q: [['Death Plateau', 0]] },
    };
    dropCycles(out);
    expect(out).toEqual({ 'Troll Stronghold': { s: [['Agility', 15, 2]], q: [['Death Plateau', 0]] } });
});
