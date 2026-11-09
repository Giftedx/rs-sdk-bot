// Walk one account to Edgeville bank with a long route-planning budget.
// Live, a planned walk from Ardougne south bank gave up after 114 ticks ("no route to 3185,3436,0"): the default
// planning budget is 45 s (packages/core/src/world.ts ROUTE_BUDGET_MS) and that route takes about 117 s to plan offline.
// This walks in legs through the waypoint the offline plan chose, each with a 180 s budget.
// usage: DEMO_OK=1 bun scripts/pk-live/walk-edge.ts <account>
import { getWorld, openBot, accountOf, settle } from '../../packages/core/src/bot';
import { goTo } from '../../packages/core/src/walk';

const EDGEVILLE_BANK = { x: 3094, z: 3492, level: 0 };
// Offline plan from Ardougne south bank to Edgeville: walk to 2897,3428 (Taverley), then to Edgeville.
const WAYPOINTS = [{ x: 2897, z: 3428, level: 0 }, EDGEVILLE_BANK];
const BUDGET_MS = 180_000;

const name = process.argv[2];
if (!name) throw Error('usage: walk-edge.ts <account>');
const s = await openBot(name);
const here = () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
const near = (a: { x: number; z: number }, b: { x: number; z: number }, r: number) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= r;
let ok = false, detail = '';
try {
    const world = await getWorld();
    const start = here();
    console.log('WALK_EDGE_START ' + JSON.stringify({ at: start }));
    // Skip waypoints already passed: start from the first one nearer than the account is to Edgeville.
    const legs = start && near(start, EDGEVILLE_BANK, 150) ? [EDGEVILLE_BANK] : WAYPOINTS;
    for (const wp of legs) {
        const t0 = s.tick();
        const r = await goTo(s, world, wp, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: BUDGET_MS });
        console.log('WALK_EDGE_LEG ' + JSON.stringify({ to: wp, ok: r.ok, ticks: s.tick() - t0, at: here(), outcome: r }).slice(0, 600));
        if (!r.ok) { detail = `leg to ${wp.x},${wp.z} failed: ${JSON.stringify(r).slice(0, 200)}`; break; }
    }
    const end = here();
    ok = !!end && near(end, EDGEVILLE_BANK, 6);
    if (!ok && !detail) detail = `ended at ${JSON.stringify(end)}`;
} catch (error) { detail = String(error); }
const loggedOut = await settle([s], ok, ok ? 'at Edgeville bank' : detail);
console.log('WALK_EDGE ' + JSON.stringify({ ok, detail, at: here(), loggedOut }));
process.exit(ok && loggedOut ? 0 : 1);
