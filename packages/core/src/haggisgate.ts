import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Haggis is the main account: every second it is logged in counts on the one playtime clock all 24 boards share
// (Cooking's #1 is at tick 38). It may log in only when scripts/haggis-gate.ts has passed all 5 gates in the last
// 10 minutes and the run is started on purpose (HAGGIS_RUN=1). Every login path calls this first.
export const GATE_FILE = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'haggis-go.json');
const MAIN = 'haggis';

export function assertLoginAllowed(name: string, now = Date.now(), env = process.env): void {
    if (name.toLowerCase() !== MAIN) return;
    if (env.HAGGIS_RUN !== '1') throw new Error('Haggis login refused: HAGGIS_RUN=1 is not set (the main account runs only the final route)');
    if (!existsSync(GATE_FILE)) throw new Error('Haggis login refused: no gate file; run bun scripts/haggis-gate.ts');
    const g = JSON.parse(readFileSync(GATE_FILE, 'utf8')) as { go?: boolean; at?: number; gates?: { name: string; pass: boolean }[] };
    const failed = (g.gates ?? []).filter(x => !x.pass).map(x => x.name);
    if (g.go !== true || failed.length) throw new Error(`Haggis login refused: gates not passed (${failed.join(', ') || 'go=false'})`);
    if (!g.at || now - g.at > 10 * 60_000) throw new Error('Haggis login refused: gate check is older than 10 minutes; run it again');
}
