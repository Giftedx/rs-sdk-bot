// Pray at an altar: walk beside a prayer altar and op Pray, which sets prayer points to the base level
// (skill_prayer/scripts/altar.rs2 pray_at_altar). The planner treats Protect from Melee as usable only at 43 points or
// more (danger.ts deadlyTo, from the current level), so a drained account first needs this before a walk onto ground
// where melee hunters live.
// Usage: bun scripts/pray-at-altar.ts <account> [ALTAR=x,z]   (default: the altar in PRAYER_ALTARS nearest the account)
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';
import { walkTarget } from './walk-to';

export type Altar = { id: number; x: number; z: number; level: number; label: string };
// Loc placements from the map files (vendor/rs-sdk/server/content/maps/m*.jm2, LOC section) of the locs with
// category=prayer_altar (skill_prayer/configs/altars.loc): 61 thrantaxaltar, 409 altar, 410 guthix_altar, 411 chaosaltar.
export const PRAYER_ALTARS: readonly Altar[] = [
    { id: 61, x: 3239, z: 3608, level: 0, label: 'Wilderness chaos temple' },
    { id: 409, x: 3253, z: 3486, level: 0, label: 'Varrock east church' },
    { id: 411, x: 2932, z: 3513, level: 0, label: 'Goblin Village chaos altar' },
    { id: 411, x: 3259, z: 3381, level: 0, label: 'Varrock south-east chaos altar' },
    { id: 410, x: 2925, z: 3483, level: 0, label: 'Taverley altar of Guthix' },
    { id: 409, x: 2853, z: 3348, level: 0, label: 'Entrana church' },
    { id: 409, x: 3243, z: 3205, level: 0, label: 'Lumbridge church' },
    { id: 409, x: 2991, z: 3177, level: 0, label: 'Port Sarim church' },
];
export const nearestAltar = (at: { x: number; z: number; level: number }, list: readonly Altar[] = PRAYER_ALTARS): Altar =>
    [...list].sort((a, b) => Math.max(Math.abs(a.x - at.x), Math.abs(a.z - at.z)) + (a.level === at.level ? 0 : 50)
        - (Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z)) + (b.level === at.level ? 0 : 50)))[0]!;
export function parseAltar(text: string | undefined, list: readonly Altar[] = PRAYER_ALTARS): Altar | undefined {
    if (!text) return undefined;
    const m = text.match(/^(\d+),(\d+)$/);
    const a = m ? list.find(r => r.x === Number(m[1]) && r.z === Number(m[2])) : undefined;
    if (!a) throw Error(`ALTAR=${text} is not in PRAYER_ALTARS`);
    return a;
}

export async function prayAtAltar(s: Session, altar: Altar): Promise<{ ok: boolean; detail: string }> {
    const points = () => s.sdk.getSkill('Prayer')?.level ?? 0, base = () => s.sdk.getSkill('Prayer')?.baseLevel ?? 1;
    if (points() >= base()) return { ok: true, detail: `prayer already full (${points()})` };
    // The altar's own tile is blocked: a walk that ends within 10 tiles is enough, since the loc click routes the rest.
    const walk = await walkTarget(s, { x: altar.x, z: altar.z, level: altar.level }, false) as { ok: boolean; reason?: string; detail?: string };
    const p = s.sdk.getState()?.player;
    if (!walk.ok && !(p && p.level === altar.level && Math.max(Math.abs(p.worldX - altar.x), Math.abs(p.worldZ - altar.z)) <= 10))
        return { ok: false, detail: `walk to the ${altar.label}: ${walk.reason ?? ''} ${walk.detail ?? ''}`.trim() };
    for (let i = 0; i < 4 && points() < base(); i++) {
        const loc = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === altar.id && l.x === altar.x && l.z === altar.z);
        const pray = loc?.optionsWithIndex.find(o => /^pray/i.test(o.text));
        if (!loc || !pray) return { ok: false, detail: `no Pray option on the ${altar.label} at ${altar.x},${altar.z}` };
        await s.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: pray.opIndex, reason: 'pray at altar' });
        await waitUntil(s, () => points() >= base(), { timeoutTicks: 15 });
    }
    return points() >= base() ? { ok: true, detail: `prayer ${points()} at the ${altar.label}` } : { ok: false, detail: `prayer ${points()} of ${base()} after praying` };
}

if (import.meta.main) {
    const [account] = process.argv.slice(2);
    if (!account) { console.log('RESULT fail usage: bun scripts/pray-at-altar.ts <account> [ALTAR=x,z]'); process.exit(2); }
    const s = await openBot(account);
    try {
        const p = s.sdk.getState()?.player;
        const altar = parseAltar(process.env.ALTAR) ?? nearestAltar({ x: p?.worldX ?? 0, z: p?.worldZ ?? 0, level: p?.level ?? 0 });
        const r = await prayAtAltar(s, altar);
        await finish([s], r.ok, `pray-at-altar ${r.detail}`);
    } catch (e) { await finish([s], false, String(e)); }
}
