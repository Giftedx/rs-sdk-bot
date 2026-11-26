import { test, expect } from 'bun:test';
import { buildDropSources } from './drops';
import type { SourceCatalog } from './lookup';

const PROC_FILE = 'scripts/drop tables/scripts/shared_droptables.rs2';
const PROCS = `[proc,randomherb]()(namedobj, int)
def_int $random = 0;
$random = random(128);
if ($random < 32) {
    return (unidentified_guam, 1);
} else if ($random < 128) {
    return (unidentified_dwarf_weed, 1);
}

[proc,randomjewel]()(namedobj, int)
def_int $random = 0;
$random = random(128);
if ($random < 32) {
    return (uncut_sapphire, 1);
} else if ($random < 65) {
    if (map_members = ^true) {
        if ($random < 62 & %legendsquest = ^legends_complete) {
            return (dragonstone, 1);
        }
        return (nature_talisman, 1);
    }
}
`;

function catalog(): SourceCatalog {
    const files: Record<string, string> = { [PROC_FILE]: PROCS };
    const roll = (table: string) => ({ table, chance: 1, conditional: false, src: 'scripts/x.rs2:1' });
    return {
        drops: [{ trigger: 'testnpc', always: [], rolls: [roll('randomherb'), roll('randomjewel')], src: 'scripts/x.rs2:1' }],
        needed: new Map(['unidentified_guam', 'uncut_sapphire', 'dragonstone', 'nature_talisman'].map(i => [i, new Set(['test'])])),
        linesOf: (rel: string) => (files[rel] ?? '').split('\n'),
        npcsFor: () => ['testnpc'],
        npcPlace: () => ({ npc: 'testnpc', spawns: 1, tiles: [], src: null, wilderness: false }),
        npcByName: new Map(),
        deathDrop: new Map(),
        attackable: new Set(),
    } as unknown as SourceCatalog;
}

test('each drop proc starts its thresholds at 0, and a nested $random test stays inside its slot', () => {
    const s = buildDropSources(catalog());
    const chance = (item: string) => s.get(item)!.map(d => [d.chance, d.conditional]);
    expect(chance('unidentified_guam')).toEqual([[Math.round(32 / 128 * 1e6) / 1e6, false]]);
    expect(chance('uncut_sapphire')).toEqual([[Math.round(32 / 128 * 1e6) / 1e6, false]]);
    expect(chance('dragonstone')).toEqual([[Math.round(33 / 128 * 1e6) / 1e6, true]]);
    // Its nearest enclosing `if` is the members check, which is open on this world.
    expect(chance('nature_talisman')).toEqual([[Math.round(33 / 128 * 1e6) / 1e6, false]]);
});
