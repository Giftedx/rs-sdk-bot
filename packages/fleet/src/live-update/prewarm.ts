// After an update that changes route code or route data, the main checkout plans the slow walks of the last day again
// in the background (tools/route-prewarm.ts), so a live walk reads their legs from the shared leg store and does not
// pay a cold plan. ROUTE_PREWARM=0 turns it off.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { importClosure } from './inspect';

// The route planner a live walk runs (route-plan.ts starts it): its import closure is the route code.
export const ROUTE_ENTRY = 'packages/core/src/route-worker.ts';
type RouteInputs = { code: Set<string>; data: Set<string> };
const inputsByRoot = new Map<string, RouteInputs>();
// The route code and the names of the JSON files it reads (each '<name>.json' literal in it: knowledge/*.json through
// loadKnowledgeJson or join, packages/planner/src/haggis-travel.json).
export function routeInputs(root: string): RouteInputs {
    let inputs = inputsByRoot.get(root);
    if (inputs) return inputs;
    const code = new Set(importClosure([ROUTE_ENTRY], root)), data = new Set<string>();
    for (const file of code) {
        let text = '';
        try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
        for (const m of text.matchAll(/['"`/]([\w-]+\.json)['"`]/g)) data.add(m[1]!);
    }
    inputsByRoot.set(root, inputs = { code, data });
    return inputs;
}
export function routeCodeChanged(files: readonly string[], root: string): boolean {
    const { code, data } = routeInputs(root);
    return files.some(f => {
        const p = f.replaceAll('\\', '/');
        return p === 'vendor/rs-sdk' || code.has(p) || (p.endsWith('.json') && data.has(basename(p)));
    });
}

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
