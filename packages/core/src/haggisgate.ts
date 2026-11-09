import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {assertSpecialistLogin} from './specialist-launch';
import {gateProblem,launchContext,readBound,fresh} from './launch-evidence';

// Haggis is the main account: every second it is logged in counts on the one playtime clock all 24 boards share
// It needs explicit, unexpired, source-bound authorization plus HAGGIS_RUN=1. Every login path checks this.
const root=resolve(import.meta.dir,'../../..');
export const GATE_FILE = join(root, '.practice', 'haggis-go.json');
const MAIN = 'haggis';

export function assertLoginAllowed(name: string, now = Date.now(), env = process.env, server?: string): string | undefined {
    if (name.toLowerCase() !== MAIN) return assertSpecialistLogin(root,name,now,env,server);
    if (env.HAGGIS_RUN !== '1') throw new Error('Haggis login refused: HAGGIS_RUN=1 is not set (the main account runs only the final route)');
    if (!existsSync(GATE_FILE)) throw new Error('Haggis login refused: no gate file; run bun scripts/haggis-gate.ts');
    let g: any;
    try { g = JSON.parse(readFileSync(GATE_FILE, 'utf8')); }
    catch (e) { throw new Error(`Haggis login refused: gate file unreadable (${String(e).slice(0, 120)}); run bun scripts/haggis-gate.ts`); }
    if (!g || typeof g !== 'object') throw new Error('Haggis login refused: gate file is not an object; run bun scripts/haggis-gate.ts');
    const problem=gateProblem(g,now);
    if(problem)throw new Error('Haggis login refused: '+problem);
    try {
        if(launchContext(root,g.snapshot).context!==g.context)throw Error('Source, route or targets changed');
        for(const ref of g.bindings)readBound(root,ref,[],false);
        const m=JSON.parse(readFileSync(join(root,'.practice/monitor.json'),'utf8'));
        if(!fresh(m.at,now,120000)||!Number.isFinite(m.freeGB)||m.freeGB<8||!Array.isArray(m.alerts)||m.alerts.some((a:any)=>a.level!=='fixed'))throw Error('Machine check no longer clear');
    }catch(e){throw new Error('Haggis login refused: '+String(e))}
}
