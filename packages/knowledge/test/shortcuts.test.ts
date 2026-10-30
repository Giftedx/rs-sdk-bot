import { beforeAll, expect, test } from 'bun:test';
import { buildShortcuts, loadInput, parseCoord, type ShortcutEdge } from '../src/shortcuts';

// Each expected edge is checked by hand against the cited content lines.
let edges: ShortcutEdge[] = [];
beforeAll(() => { edges = buildShortcuts(loadInput()).edges; }, 120_000);

const find = (loc: string, from: [number, number, number], to: [number, number, number]) =>
    edges.filter(e => e.locName === loc && e.from.x === from[0] && e.from.z === from[1] && e.from.level === from[2] && e.to.x === to[0] && e.to.z === to[1] && e.to.level === to[2]);

test('coord literal 0_48_49_37_23 is x=3109 z=3159 level 0', () => {
    expect(parseCoord('0_48_49_37_23')).toEqual({ x: 3109, z: 3159, level: 0 });
});

// skill_agility/scripts/shortcuts.rs2:16-21 and maps/m40_48.jm2:5015: agility 5, p_telejump(movecoord(loc_coord, 0, 0, 3)).
test('Yanille watchtower climbing rocks need Agility 5', () => {
    const [e] = find('watchshortcut', [2561, 3108, 0], [2561, 3111, 0]);
    expect(e).toBeDefined();
    expect(e!.exact).toBe(true);
    expect(e!.requires?.skill).toEqual({ name: 'agility', level: 5 });
    expect(e!.kind).toBe('shortcut');
});

// skill_agility/scripts/shortcuts.rs2:1-14 then barbarian_course.rs2:114-119: refused from the east,
// agility 5, start = loc - 1 x, exactmove to start + 2 x. Placement maps/m45_52.jm2:5479.
test('Falador crumbling wall needs Agility 5 and crosses west to east only', () => {
    const at = edges.filter(e => e.locName === 'castlecrumbly' && e.from.x === 2935 && e.from.z === 3355);
    expect(at.length).toBe(1);
    expect(at[0]!.to).toEqual({ x: 2936, z: 3355, level: 0 });
    expect(at[0]!.requires?.skill).toEqual({ name: 'agility', level: 5 });
    expect(at[0]!.side?.[0]).toContain('coordx(coord) > coordx(loc_coord) = false');
});

// skill_agility/scripts/shortcuts.rs2:26-45: agility 20; from x < 2602 the player goes to loc - 1, then +1, +3, +1.
test('Coal trucks log balance needs Agility 20', () => {
    const [e] = find('mine_log_balance1', [2599, 3477, 1], [2603, 3477, 1]);
    expect(e).toBeDefined();
    expect(e!.requires?.skill).toEqual({ name: 'agility', level: 20 });
    expect(e!.side?.[0]).toContain('coordx(coord) < 2602 = true');
});

// areas/area_yanille/scripts/agility_dungeon.rs2:1-26: agility 49; the west pipe end 0_40_148_13_34 walks to
// 0_40_148_12_34, squeezes 3 east, then squeezes from 0_40_148_15_34 3 east to 2578,9506.
test('Yanille dungeon pipe needs Agility 49', () => {
    const [e] = find('obstical_pipe4', [2573, 9506, 0], [2578, 9506, 0]);
    expect(e).toBeDefined();
    expect(e!.exact).toBe(true);
    expect(e!.requires?.skill).toEqual({ name: 'agility', level: 49 });
});

// skill_agility/configs/shortcuts.loc:22-34 (agil_level_req 15, start 0_48_155_48_44) and shortcuts.rs2:152-193.
test('Edgeville dungeon monkey bars need Agility 15 from the south', () => {
    const [e] = find('loc_2320', [3120, 9964, 0], [3120, 9969, 0]);
    expect(e).toBeDefined();
    expect(e!.requires?.skill).toEqual({ name: 'agility', level: 15 });
});

// areas/area_yanille/scripts/magic_guild.rs2:19-22: p_teleport(0_48_49_37_23), no check.
test('Magic Guild portal to the Wizards Tower has no need', () => {
    const [e] = find('wiztowerportal', [2596, 3087, 2], [3109, 3159, 0]);
    expect(e).toBeDefined();
    expect(e!.requires).toBeUndefined();
    expect(e!.exact).toBe(true);
});

// skill_agility/scripts/shortcuts.rs2:65: stat_random(agility, 90, 250) = false is the fall into the river.
test('Karamja river log records its failure roll', () => {
    const e = edges.find(x => x.locName === 'zq_logbalance' && x.from.x === 2907);
    expect(e?.failure).toMatchObject({ stat: 'agility', low: 90, high: 250 });
});
