import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { routeCodeChanged, routeInputs, startRoutePrewarm } from '../src/live-update/prewarm';

const dir = mkdtempSync(join(tmpdir(), 'live-update-prewarm-'));
const repo = resolve(import.meta.dir, '../../..');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the route inputs are the route planner import closure and the JSON files it reads', () => {
    const { code, data } = routeInputs(repo);
    for (const f of ['packages/core/src/route-worker.ts', 'packages/core/src/trip.ts', 'packages/core/src/travel.ts', 'packages/core/src/world/search.ts',
        'packages/core/src/world/pathfinding.ts', 'packages/core/src/danger/guard.ts', 'packages/core/src/leg-cache.ts']) expect(code.has(f)).toBe(true);
    // Each knowledge file that travel.ts, trip.ts, world/* and danger/* read.
    for (const name of ['transports.json', 'doors.json', 'npcs.json', 'shortcuts.json', 'teleports.json', 'npc-travel.json', 'special-crossings.json', 'quests.json',
        'items.json', 'haggis-travel.json']) expect(data.has(name)).toBe(true);
});

test('a change to each route input starts a prewarm; other files do not', () => {
    const { code, data } = routeInputs(repo);
    for (const f of code) expect(routeCodeChanged([f], repo)).toBe(true);
    for (const name of data) {
        const f = existsSync(join(repo, 'knowledge', name)) ? `knowledge/${name}` : name;
        expect(routeCodeChanged([f], repo)).toBe(true);
    }
    expect(routeCodeChanged(['vendor/rs-sdk'], repo)).toBe(true);
    expect(routeCodeChanged(['packages\\core\\src\\world\\graph.ts'], repo)).toBe(true);
    for (const f of ['packages/dashboard/server.ts', 'docs/plans/joined-plan.md', 'scripts/swarm.ts', 'knowledge/gear.json']) expect(routeCodeChanged([f], repo)).toBe(false);
});

test('the prewarm starts detached and hidden with its log in .practice, and ROUTE_PREWARM=0 starts none', () => {
    const calls: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
    let unrefs = 0;
    const fake = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => { calls.push({ cmd, args, opts }); return { unref: () => { unrefs++; } }; }) as never;
    expect(startRoutePrewarm(dir, {}, fake)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([join(dir, 'tools', 'route-prewarm.ts')]);
    expect(calls[0]!.opts).toMatchObject({ cwd: dir, detached: true, windowsHide: true });
    expect(unrefs).toBe(1);
    expect(startRoutePrewarm(dir, { ROUTE_PREWARM: '0' }, fake)).toBe(false);
    expect(calls).toHaveLength(1);
});
