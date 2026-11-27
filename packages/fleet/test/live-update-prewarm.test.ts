import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeCodeChanged, startRoutePrewarm } from '../src/live-update/prewarm';

const dir = mkdtempSync(join(tmpdir(), 'live-update-prewarm-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('route code and route data start a prewarm; other files do not', () => {
    for (const f of ['packages/core/src/world/search.ts', 'packages/core/src/danger/tiles.ts', 'packages/core/src/walk/goto.ts', 'packages/core/src/trip.ts',
        'packages/core/src/leg-cache.ts', 'knowledge/npcs.json', 'knowledge/transports.json', 'vendor/rs-sdk', 'packages\\core\\src\\world\\graph.ts']) expect(routeCodeChanged([f])).toBe(true);
    for (const f of ['packages/core/src/status.ts', 'packages/dashboard/server.ts', 'knowledge/items.json', 'docs/plans/joined-plan.md']) expect(routeCodeChanged([f])).toBe(false);
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
