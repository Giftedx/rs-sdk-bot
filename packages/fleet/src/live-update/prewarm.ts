// After an update that changes route code or route data, the main checkout plans the slow walks of the last day again
// in the background (tools/route-prewarm.ts), so a live walk reads their legs from the shared leg store and does not
// pay a cold plan. ROUTE_PREWARM=0 turns it off.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE_CODE = [
    /^packages\/core\/src\/(?:world|danger|walk)\//,
    /^packages\/core\/src\/(?:trip|travel|route-plan|route-worker|leg-cache|pathcache|components|door-policy)\.ts$/,
    /^knowledge\/(?:transports|doors|npcs|shortcuts|teleports|npc-travel|crossings)\.json$/,
    /^vendor\/rs-sdk$/,
];
export const routeCodeChanged = (files: readonly string[]): boolean => files.some(f => ROUTE_CODE.some(r => r.test(f.replaceAll('\\', '/'))));

// Starts tools/route-prewarm.ts as a detached process at the lowest priority it sets itself; its output goes to
// .practice/route-prewarm/run.log. The tool skips the run when free memory is low or the head was warmed before.
export function startRoutePrewarm(root: string, env: Record<string, string | undefined> = process.env, start: typeof spawn = spawn): boolean {
    if (env.ROUTE_PREWARM === '0') return false;
    try {
        const dir = join(root, '.practice', 'route-prewarm');
        mkdirSync(dir, { recursive: true });
        const out = openSync(join(dir, 'run.log'), 'a');
        const child = start(process.execPath, [join(root, 'tools', 'route-prewarm.ts')], { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true });
        child.unref();
        return true;
    } catch { return false; }
}
