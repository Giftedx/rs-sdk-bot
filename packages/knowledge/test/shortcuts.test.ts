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
// agility 5, start = loc - 1 x, exactmove to start + 2 x. Placement maps/m45_52.jm2:5479. The wall is on the
// tile's west edge: the player operates it from the loc tile (east) or from 2934 (west).
test('Falador crumbling wall needs Agility 5 and crosses west to east only', () => {
    const at = edges.filter(e => e.locName === 'castlecrumbly' && e.from.x === 2935 && e.from.z === 3355);
    expect(at.length).toBe(1);
    expect(at[0]!.starts).toEqual([{ x: 2934, z: 3355, level: 0 }]);
    expect(at[0]!.to).toEqual({ x: 2936, z: 3355, level: 0 });
    expect(at[0]!.requires?.skill).toEqual({ name: 'agility', level: 5 });
    expect(at[0]!.side).toBeUndefined();
});

// skill_agility/scripts/shortcuts.rs2:26-45: agility 20; from x < 2602 the player goes to loc - 1, then +1, +3, +1.
// maps/m40_54.jm2:5753 puts the log on level 1, and the MAP section gives tile 1 39 21 the bridge flag (f2): the
// engine and its collision have it on level 0. The open log tiles 2600-2601 are a closed pocket, not a start.
test('Coal trucks log balance needs Agility 20 and crosses on level 0', () => {
    const [e] = find('mine_log_balance1', [2599, 3477, 0], [2603, 3477, 0]);
    expect(e).toBeDefined();
    expect(e!.bridged).toBe(true);
    expect(e!.starts).toEqual([{ x: 2599, z: 3476, level: 0 }, { x: 2598, z: 3477, level: 0 }, { x: 2599, z: 3478, level: 0 }]);
    expect(e!.requires?.skill).toEqual({ name: 'agility', level: 20 });
    expect(edges.filter(x => x.locName === 'mine_log_balance1').map(x => [x.from.x, x.to.x])).toEqual([[2599, 2603], [2602, 2598]]);
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

// skill_agility/scripts/shortcuts.rs2:49-95: from x < 2909 two p_teleport moves of +2 from coord, else of -2; a failed
// roll (line 65) washes the player to $fail_end_coord. maps/m45_47.jm2:7148 and :7153 put the log ends on level 1 under
// the bridge flag. The player stands beside a log end on level 0 (live: 2910,3049 -> 2906,3049, travel.ts
// RIVER_LOG_TRAVEL). The open tile 2908,3049 between the ends is a closed pocket, not a start.
test('Karamja river log crosses 4 tiles on level 0 from the tile beside each end', () => {
    const rows = edges.filter(x => x.locName === 'zq_logbalance').map(x => ({ from: x.from, starts: x.starts, to: x.to, exact: x.exact, bridged: x.bridged, failure: x.failure && { stat: x.failure.stat, low: x.failure.low, high: x.failure.high, to: x.failure.to } }));
    expect(rows).toEqual([
        { from: { x: 2907, z: 3049, level: 0 }, starts: [{ x: 2906, z: 3049, level: 0 }], to: { x: 2910, z: 3049, level: 0 }, exact: true, bridged: true, failure: { stat: 'agility', low: 90, high: 250, to: { x: 2909, z: 3059, level: 0 } } },
        { from: { x: 2909, z: 3049, level: 0 }, starts: [{ x: 2910, z: 3049, level: 0 }], to: { x: 2906, z: 3049, level: 0 }, exact: true, bridged: true, failure: { stat: 'agility', low: 90, high: 250, to: { x: 2903, z: 3057, level: 0 } } },
    ]);
});

// general_use/scripts/gangplank.rs2:28-39: the disembark moves the player 1 then 2 tiles from coord, one level down.
// The plank (maps/m43_50.jm2:4741, 1 22 34) is operated from the deck tile 2775,3234,1 (o5); the level-1 tiles west,
// north and south of it have no overlay or underlay: open air, not a start.
test('Ardougne ship gangplank lands 3 tiles from the deck tile, one level down', () => {
    const rows = edges.filter(x => x.locName === 'ardougneshipplank_off' && x.from.x === 2774 && x.from.z === 3234);
    expect(rows.map(x => [x.starts, x.to])).toEqual([[[{ x: 2775, z: 3234, level: 1 }], { x: 2772, z: 3234, level: 0 }]]);
});

// areas/area_gnome/scripts/gnomevillage_fence.rs2:1-12: ~check_axis (doors/scripts/door_procs.rs2:77) picks the side
// from the player tile; the squeeze moves 1 tile, onto the railing tile going in and off it going out.
test('Tree Gnome Village loose railing has one landing for each side', () => {
    const rows = edges.filter(x => x.locName === 'treegnomelooserailing').map(x => [x.starts, x.to, x.side]);
    expect(rows).toEqual([
        [[{ x: 2515, z: 3161, level: 0 }, { x: 2516, z: 3161, level: 0 }], { x: 2515, z: 3160, level: 0 }, undefined],
        [[{ x: 2515, z: 3160, level: 0 }], { x: 2515, z: 3161, level: 0 }, undefined],
    ]);
});

// areas/area_mage_arena/scripts/mage_arena.rs2:82-96: from north of the barrier (shape 0, angle 1: a wall on the north
// edge of 3105,3953) the player steps onto the loc tile; from the loc tile it steps north. A landing on the wall's own
// tile is a move.
test('Mage arena barrier enters onto the loc tile and leaves north of it', () => {
    const rows = edges.filter(x => x.locName === 'magearena_scan' && x.from.x === 3105).map(x => [x.starts, x.to]);
    expect(rows).toEqual([
        [[{ x: 3105, z: 3954, level: 0 }], { x: 3105, z: 3953, level: 0 }],
        [[{ x: 3105, z: 3953, level: 0 }, { x: 3106, z: 3953, level: 0 }], { x: 3105, z: 3954, level: 0 }],
    ]);
    expect(edges.find(x => x.locName === 'magearena_scan' && x.to.z === 3953)?.conditions?.[0]).toStartWith('%magearena >= 6');
});
