import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyDoor, parseTriggers } from '../src/doors';

const SCRIPTS = `[oploc1,miningguilddoor]
if (stat(mining) < 60) {
    ~mesbox("You need a Mining level of 60 to access the Mining Guild.");
    return;
}
~open_and_close_door(loc_param(next_loc_stage), ~check_axis(coord, loc_coord, loc_angle), false);

[oploc1,elenadoor2]
switch_int(%elenaquest) {
    case ^elena_complete : ~open_and_close_door2(loc_param(next_loc_stage), ~check_axis(coord, loc_coord, loc_angle), door_open);
    case default : mes("The door is locked.");
}

[oploc1,brasskeydoor]
mes("The door is locked.");

[oplocu,brasskeydoor]
switch_obj(last_useitem) {
    case edgevilledungeonkey : @open_edgeville_dungeon_door;
    case default : ~displaymessage(^dm_default);
}

[oploc1,haunteddoorl] @open_manor_entrance(^left);

[label,open_manor_entrance](int $side)
if(coordz(coord) > coordz(loc_coord)) {
    mes("The doors won't open.");
    return;
}

[oploc1,lockeddoor1]
p_arrivedelay;
mes("You try and open the door...");
p_delay(1);
mes("The door is locked.");

[oploc1,_door_closed] ~open_door(500);

[oploc1,oddthing]
~some_unknown_proc;
`;

const t = parseTriggers([{ text: SCRIPTS, file: 'scripts/x.rs2' }]);

test('skill door needs the level from stat(skill) < N', () => {
    expect(classifyDoor('miningguilddoor', undefined, t)).toMatchObject({ kind: 'skill', need: { skill: 'mining', level: 60 }, trigger: 'scripts/x.rs2:1' });
});

test('quest door names the varp it checks', () => {
    expect(classifyDoor('elenadoor2', undefined, t)).toMatchObject({ kind: 'quest', need: { varp: 'elenaquest' } });
});

test('key door is found from its oplocu trigger and names the key', () => {
    expect(classifyDoor('brasskeydoor', undefined, t)).toMatchObject({ kind: 'key', need: { item: 'edgevilledungeonkey' } });
});

test('one-way door is found through the label the trigger calls', () => {
    expect(classifyDoor('haunteddoorl', undefined, t)).toMatchObject({ kind: 'one_way' });
});

test('a door that only says locked is locked', () => {
    expect(classifyDoor('lockeddoor1', undefined, t)).toMatchObject({ kind: 'locked' });
});

test('a door with no own trigger uses its category trigger', () => {
    expect(classifyDoor('loc_1530', 'door_closed', t)).toMatchObject({ kind: 'open', trigger: expect.stringContaining('scripts/x.rs2:') });
});

test('a body it cannot read is unknown, not guessed', () => {
    expect(classifyDoor('oddthing', undefined, t).kind).toBe('unknown');
    expect(classifyDoor('no_trigger_at_all', undefined, t).kind).toBe('unknown');
});

test('plain gates open through ~open_gate and ~open_outer_gate', () => {
    const g = parseTriggers([{ text: '[oploc1,_gate_main_closed] ~open_gate;\n[oploc1,_gate_outer_closed] ~open_outer_gate;\n', file: 'scripts/gates.rs2' }]);
    expect(classifyDoor('loc_1551', 'gate_main_closed', g).kind).toBe('open');
    expect(classifyDoor('loc_1553', 'gate_outer_closed', g).kind).toBe('open');
});


test('real thieving Open handlers2550/2551 are side-locked despite an open procedure in the expanded body', () => {
    const file = 'scripts/skill_thieving/scripts/doors/locked_door.rs2';
    const axis = 'scripts/doors/scripts/door_procs.rs2';
    const real = parseTriggers([file, axis].map(file => ({ file, text: readFileSync(resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content', file), 'utf8') })));
    for (const loc of ['loc_2550', 'loc_2551']) {
        expect(classifyDoor(loc, undefined, real)).toMatchObject({ kind: 'one_way', need: { side: expect.stringContaining('lock_inversed') }, trigger: expect.stringContaining(file) });
    }
    // Existing item-use lockpick paths remain key-gated rather than unconditional Open.
    expect(classifyDoor('loc_2557', undefined, real).kind).toBe('key');
});

test('an unresolved conditional refusal plus Open is explicit conditional, not open or a guessed skill/quest', () => {
    const t = parseTriggers([{ file: 'conditional.rs2', text: '[oploc1,conditional]\nif (~condition) { mes("This door is locked."); return; }\n~open_door(500);' }]);
    expect(classifyDoor('conditional', undefined, t).kind).toBe('conditional');
});

test('a key door that lets the leaving side slip out is shut one way only', () => {
    const t = parseTriggers([{ file: 'phoenix.rs2', text: `[oploc1,hideout] @unlock(false);
[oplocu,hideout]
if(last_useitem = hideoutkey) {
    @unlock(true);
}
[label,unlock](boolean $key_used)
def_boolean $leaving= ~check_axis(coord, loc_coord, loc_angle);
if($leaving = false & $key_used = false) {
    mes("The door is securely locked.");
    return;
}
` }]);
    expect(classifyDoor('hideout', undefined, t)).toEqual({ kind: 'key', need: { whenAxis: false }, trigger: 'phoenix.rs2:1' });
});

test('real rev-289 door fixes classify Varrock SE gate, Rellekka doors, curtains, reverse double doors, Melzar exit, and gated entrances cleanly', () => {
    const contentRoot = resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content');
    const files = [
        'scripts/doors/scripts/door_procs.rs2',
        'scripts/doors/scripts/doubledoors.rs2',
        'scripts/areas/area_varrock/scripts/east_gate.rs2',
        'scripts/areas/area_vt/scripts/viking_door.rs2',
        'scripts/areas/area_alkharid/scripts/misc_locs.rs2',
        'scripts/quests/quest_dragon/scripts/melzars_maze.rs2',
        'scripts/quests/quest_viking/scripts/quest_viking.rs2',
        'scripts/areas/area_barbarian_outpost/scripts/outpost_gate.rs2',
    ];
    const t = parseTriggers(files.map(file => ({ file, text: readFileSync(resolve(contentRoot, file), 'utf8') })));
    expect(classifyDoor('guidorgatelclosed', 'varrock_gate', t).kind).toBe('open');
    expect(classifyDoor('guidorgaterclosed', 'varrock_gate', t).kind).toBe('open');
    expect(classifyDoor('viking_fur_door', undefined, t).kind).toBe('open');
    expect(classifyDoor('loc_1528', undefined, t).kind).toBe('open');
    expect(classifyDoor('posh_doubledoor_reverse_l', 'reverse_door_left_closed', t).kind).toBe('open');
    expect(classifyDoor('posh_doubledoor_reverse_r', 'reverse_door_right_closed', t).kind).toBe('open');
    expect(classifyDoor('funexit', undefined, t)).toMatchObject({ kind: 'one_way', need: { whenAxis: false } });
    expect(classifyDoor('viking_fencegate_l', undefined, t)).toMatchObject({ kind: 'quest', need: { varp: 'viking', minimum: 10 } });
    expect(classifyDoor('barbariangatel', 'outpost_gate', t)).toMatchObject({ kind: 'quest', need: { varp: 'barcrawl', minimum: 2 } });
});

const realTriggers = (files: string[]) => {
    const contentRoot = resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content');
    return parseTriggers(files.map(file => ({ file, text: readFileSync(resolve(contentRoot, file), 'utf8') })));
};

test('a key door whose Open admits the key holder or the leaving side names the key and shuts one way', () => {
    const t = realTriggers(['scripts/quests/quest_ball/scripts/quest_ball.rs2', 'scripts/doors/scripts/door_procs.rs2']);
    expect(classifyDoor('witchhousedoor', undefined, t)).toMatchObject({ kind: 'key', need: { item: 'witches_doorkey', whenAxis: false } });
});

test('Keep Le Faye doors refuse entry from outside and stay open one way from inside', () => {
    const t = realTriggers(['scripts/quests/quest_arthur/scripts/quest_arthur.rs2', 'scripts/doors/scripts/door_procs.rs2']);
    for (const loc of ['lefayeunopenabledoorl', 'lefayeunopenabledoorr']) {
        expect(classifyDoor(loc, 'keep_lefaye_door', t)).toMatchObject({ kind: 'one_way', need: { whenAxis: true } });
    }
});

test('key doors whose oplocu uses direct last_useitem and whose oploc1 checks inv_total name their key item', () => {
    const t = realTriggers(['scripts/quests/quest_ikov/scripts/ikov_dungeon.rs2', 'scripts/doors/scripts/door_procs.rs2']);
    expect(classifyDoor('ikov_shinykeydoor', undefined, t)).toMatchObject({ kind: 'key', need: { item: 'ikov_shinykey' } });
});

test('a key test that refuses the holder is not a key', () => {
    // golrie_gate_waterfall_quest: Open with Glarial's pebble says "Golrie has locked himself in."
    const t = realTriggers(['scripts/quests/quest_waterfall/scripts/quest_waterfall.rs2', 'scripts/doors/scripts/door_procs.rs2']);
    expect(classifyDoor('golrie_gate_waterfall_quest', undefined, t).need?.item).toBeUndefined();
});

test('a quest gate takes its stage from the constant passed to the proc that tests it', () => {
    const t = realTriggers(['scripts/areas/area_mausoleum/scripts/gates.rs2', 'scripts/doors/scripts/door_procs.rs2']);
    const constants = new Map([['priestperil_find_drezel_key', { value: 5 }], ['priestperil_meet_in_mausoleum', { value: 8 }]]);
    expect(classifyDoor('pip_underground_door1', undefined, t, constants)).toMatchObject({ kind: 'quest', need: { varp: 'priestperil', minimum: 5 } });
    expect(classifyDoor('pip_underground_door2', undefined, t, constants)).toMatchObject({ kind: 'quest', need: { varp: 'priestperil', minimum: 8 } });
    // Without the constant the stage is unknown, and the gate stays shut for every account.
    expect(classifyDoor('pip_underground_door1', undefined, t).need?.minimum).toBeUndefined();
});

test('a quest gate takes its stage from a direct test, and only when the varp is tested once', () => {
    const t = parseTriggers([{ file: 'g.rs2', text: `[oploc1,onegate]
if(%q >= ^q_started) {
    ~open_and_close_door2(loc_1538, ~check_axis_locactive(coord), door_open);
    return;
}
mes("The door is locked.");
[oploc1,twogate]
if(%q = 3) {
    mes("The door is locked.");
    return;
}
if(%q >= 2) {
    ~open_and_close_door2(loc_1538, ~check_axis_locactive(coord), door_open);
    return;
}
mes("The door is locked.");
` }]);
    const constants = new Map([['q_started', { value: 1 }]]);
    expect(classifyDoor('onegate', undefined, t, constants)).toMatchObject({ kind: 'quest', need: { varp: 'q', minimum: 1 } });
    expect(classifyDoor('twogate', undefined, t, constants).need?.minimum).toBeUndefined();
});
