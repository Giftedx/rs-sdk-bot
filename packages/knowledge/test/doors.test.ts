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
