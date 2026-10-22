import { test, expect } from 'bun:test';
import { parseConfigs } from '../src/config';
import { buildItems } from '../src/items';
import { buildShops } from '../src/shops';
import { parseTransportHandlers, buildTransports } from '../src/transports';

test('config blocks remember the line of each property', () => {
    const [b] = parseConfigs('[knife]\nname=Knife\ncost=6\n', 'f.obj');
    expect(b!.propLines.cost).toEqual([3]);
});

test('buildItems maps pack ids, static cost and source line', () => {
    const blocks = parseConfigs('[knife]\nname=Knife\ncost=6\ntradeable=yes\n', 'scripts/a.obj');
    const items = buildItems(blocks, new Map([[946, 'knife']]));
    expect(items).toEqual([{ id: 946, name: 'Knife', debugname: 'knife', cost: 6, members: false, tradeable: true, src: 'scripts/a.obj:3' }]);
});

test('buildShops reads stockN=item,count,restock with the stock line as src', () => {
    const blocks = parseConfigs('[heroes_shop]\nscope=shared\nstock1=dragon_battleaxe,2,500 // note\n', 'scripts/h.inv');
    expect(buildShops(blocks)).toEqual([{
        inv: 'heroes_shop', file: 'scripts/h.inv', src: 'scripts/h.inv:1',
        stock: [{ item: 'dragon_battleaxe', count: 2, restockTicks: 500, src: 'scripts/h.inv:3' }],
    }]);
});

const HANDLERS = `// Ship ladder (climb up)
[oploc1,shipladder_angled]
p_arrivedelay;
switch_int (loc_angle) {
	case 0 : p_teleport(movecoord(coord, 0, 1, 2));
	case 1 : p_teleport(movecoord(coord, 2, 1, 0));
}

[oploc1,ship_ladder]
p_arrivedelay;
~climb_ladder(movecoord(coord(), 0, 1, 0), true);

[oploc1,fixed_ladder]
~climb_ladder(0_50_50_10_20, false);

[oploc1,weird_ladder]
p_teleport($dest);
`;

test('angled handler maps each angle to its offset', () => {
    const { handlers } = parseTransportHandlers(HANDLERS, 'scripts/l.rs2');
    const edges = buildTransports(handlers, [{ id: 7, x: 3000, z: 3000, level: 0, shape: 10, angle: 1, src: 'maps/m46_46.jm2:9' }], new Map([[7, 'shipladder_angled']]));
    expect(edges.edges).toEqual([{ locName: 'shipladder_angled', option: 'op1', from: { x: 3000, z: 3000, level: 0 }, to: { x: 3002, z: 3000, level: 1 }, src: 'maps/m46_46.jm2:9', handler: 'scripts/l.rs2:2' }]);
});

test('plain offset and absolute destinations both resolve', () => {
    const { handlers } = parseTransportHandlers(HANDLERS, 'scripts/l.rs2');
    const locs = [
        { id: 8, x: 3200, z: 3200, level: 0, shape: 10, angle: 2, src: 'a:1' },
        { id: 9, x: 3300, z: 3300, level: 1, shape: 10, angle: 0, src: 'b:1' },
    ];
    const { edges } = buildTransports(handlers, locs, new Map([[8, 'ship_ladder'], [9, 'fixed_ladder']]));
    expect(edges.map(e => e.to)).toEqual([{ x: 3200, z: 3200, level: 1 }, { x: 3210, z: 3220, level: 0 }]);
});

test('unknown handler shapes are reported as skipped', () => {
    const { skipped } = parseTransportHandlers(HANDLERS, 'scripts/l.rs2');
    expect(skipped).toEqual([{ locName: 'weird_ladder', handler: 'scripts/l.rs2:16' }]);
});

test('buildNpcs joins configs with map spawns by id', async () => {
    const { buildNpcs } = await import('../src/npcs');
    const blocks = parseConfigs('[man]\nname=Man\nvislevel=2\n', 'scripts/a.npc');
    const npcs = buildNpcs(blocks, new Map([[1, 'man']]), [{ id: 1, x: 3222, z: 3218, level: 0, src: 'maps/m50_50.jm2:7' }]);
    expect(npcs).toEqual([{ id: 1, name: 'Man', debugname: 'man', combat: 2, src: 'scripts/a.npc:1', spawns: [{ x: 3222, z: 3218, level: 0, src: 'maps/m50_50.jm2:7' }] }]);
});
