// Check of the key of the saved walk lengths (packages/core/src/danger.ts withDanger, leg-cache.ts): a length that
// one trip measured must be right for every other trip that reads it.
// It plans a set of real trips two times and compares the plans, byte for byte:
//   - alone: one process for each trip, with no saved length (ROUTE_LEG_CACHE=0), so each leg is measured for that
//     trip, as it was when the key held the start and end tile of the trip;
//   - shared: one process for all trips, so a later trip reads the lengths of the earlier trips under the key.
// The set has trips of a strong and of a weak account (two sets of closed danger ground), a trip that ends inside
// closed ground and a trip that starts there (the keep tiles that stay in the key).
// Usage: bun scripts/measure/route-key-parity.ts      exit 0 when every plan is equal, 1 when one differs.
import {resolve} from 'node:path';
import type {Account, Tile} from '../../packages/core/src/world';

const strong = {skills: {Attack: 70, Strength: 70, Defence: 70, Hitpoints: 70, Ranged: 80, Magic: 50, Prayer: 43}, varps: {}, items: [], coins: 5000} as unknown as Account;
const weak = {skills: {Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Ranged: 1, Magic: 1, Prayer: 1}, varps: {}, items: [], coins: 5000} as unknown as Account;
const tile = (x: number, z: number): Tile => ({x, z, level: 0});
const VARROCK = tile(3253, 3421), LUMBRIDGE = tile(3222, 3218), FALADOR = tile(2965, 3379), DRAYNOR = tile(3093, 3244), ARDOUGNE = tile(2619, 3332);
type Trip = {name: string; from: Tile; to: Tile; acct: Account};

async function trips(): Promise<Trip[]> {
    const {dangerSet, unpack} = await import('../../packages/core/src/danger');
    const {loadPathfinding} = await import('../../packages/core/src/pathcache');
    await loadPathfinding();
    const pf = await import('../../vendor/rs-sdk/sdk/pathfinding') as unknown as {initPathfinding(): void; isTileWalkable(level: number, x: number, z: number): boolean};
    pf.initPathfinding();
    // A walkable tile of the weak account's closed ground between Lumbridge and Varrock, the lowest tile first so the
    // choice is the same on every machine.
    const closed = [...dangerSet(weak, 0, {minX: 3180, maxX: 3300, minZ: 3200, maxZ: 3440})].sort((a, b) => a - b).map(unpack).find(t => pf.isTileWalkable(0, t.x, t.z));
    const list: Trip[] = [
        {name: 'strong varrock-lumbridge', from: VARROCK, to: LUMBRIDGE, acct: strong},
        {name: 'strong lumbridge-falador', from: LUMBRIDGE, to: FALADOR, acct: strong},
        {name: 'strong falador-varrock, start 2 tiles off', from: tile(FALADOR.x + 2, FALADOR.z), to: VARROCK, acct: strong},
        {name: 'strong varrock-ardougne', from: tile(VARROCK.x - 2, VARROCK.z), to: ARDOUGNE, acct: strong},
        {name: 'weak varrock-lumbridge', from: VARROCK, to: LUMBRIDGE, acct: weak},
        {name: 'weak draynor-varrock', from: DRAYNOR, to: tile(VARROCK.x - 1, VARROCK.z), acct: weak},
    ];
    if (closed) list.push({name: 'weak lumbridge to a tile inside closed ground', from: LUMBRIDGE, to: closed, acct: weak}, {name: 'weak from a tile inside closed ground to varrock', from: closed, to: VARROCK, acct: weak});
    return list;
}
async function plan(list: Trip[]): Promise<string[]> {
    const {createWorld, rsPathLength} = await import('../../packages/core/src/world');
    const {planTrip} = await import('../../packages/core/src/trip');
    const world = createWorld({pathLength: await rsPathLength()});
    return list.map(t => JSON.stringify(planTrip(world, t.from, t.to, t.acct, undefined)));
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..', '..'), all = await trips(), one = process.argv.indexOf('--one');
    if (one >= 0 || process.argv.includes('--shared')) {
        // A child: no saved length is read or written, so the only reuse is inside this process.
        const picked = one >= 0 ? [all[Number(process.argv[one + 1])]!] : all;
        console.log('PLANS ' + JSON.stringify(await plan(picked)));
        process.exit(0);
    }
    const child = (args: string[]): string[] => {
        const r = Bun.spawnSync(['bun', import.meta.path, ...args], {cwd: root, env: {...process.env, ROUTE_LEG_CACHE: '0'}, stdout: 'pipe', stderr: 'pipe', windowsHide: true});
        const line = r.stdout.toString().split(/\r?\n/).find(l => l.startsWith('PLANS '));
        if (r.exitCode !== 0 || !line) throw new Error(`route-key-parity: a planning process failed (${args.join(' ')}): ${r.stderr.toString().trim().split('\n').at(-1)}`);
        return JSON.parse(line.slice(6));
    };
    const started = performance.now(), shared = child(['--shared']);
    let different = 0, withRoute = 0;
    for (const [i, trip] of all.entries()) {
        const alone = child(['--one', String(i)])[0]!, same = alone === shared[i];
        if (!same) different++;
        if (alone !== 'null') withRoute++;
        console.log(`${same ? 'equal' : 'DIFFERENT'}  ${trip.name}  ${alone === 'null' ? 'no route' : `cost ${JSON.parse(alone).cost}, ${JSON.parse(alone).legs.length} legs`}${same ? '' : `\n  alone:  ${alone.slice(0, 300)}\n  shared: ${shared[i]!.slice(0, 300)}`}`);
    }
    const closedTrips = all.filter(t => t.name.includes('closed ground')).length;
    console.log(`RESULT ${different || !closedTrips || withRoute < 4 ? 'fail' : 'ok'} route-key-parity trips=${all.length} different=${different} withRoute=${withRoute} closedGroundTrips=${closedTrips} seconds=${Math.round((performance.now() - started) / 1000)}`);
    // No trip through closed ground, or few trips with a route, would make the check say nothing.
    process.exit(different || !closedTrips || withRoute < 4 ? 1 : 0);
}
