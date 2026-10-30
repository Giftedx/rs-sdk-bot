// Feathers for headless arrows (route supply bill: 3,120 headless arrows short). Kills chickens and picks up their
// feathers (npc/scripts/chicken.rs2 drop table: 15 feathers 1/4, 5 feathers 1/4). Feathers stack in one pack slot,
// so the run needs no bank. The kill loop is the one in scripts/fishcook.ts chickenTrip.
// Usage: bun scripts/gather-feathers.ts <account>
// Env: PEN=x,z chicken pen centre (default Lumbridge 3229,3298; others 3017,3288 3187,3277 3197,3353 from
// npcs.json); TICKS (default 3000); TARGET feathers in the pack (default 2000).
import { openBot, finish, getWorld, accountOf, countItems, randomEventsOf } from '../packages/core/src/bot';
import { goTo } from '../packages/core/src/walk';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';

export function parsePen(v: string | undefined): { x: number; z: number } {
    const m = (v ?? '').match(/^(\d+),(\d+)$/);
    return m ? { x: Number(m[1]), z: Number(m[2]) } : { x: 3229, z: 3298 };
}

if (import.meta.main) {
    const name = process.argv[2]!, PEN = parsePen(process.env.PEN);
    const TICKS = Number(process.env.TICKS ?? 3000), TARGET = Number(process.env.TARGET ?? 2000);
    const FEATHER = /^feather$/i, CHICKEN = /^chicken$/i;
    const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
    const st = () => s.sdk.getState() as any, start = s.tick();
    const over = () => s.tick() - start >= TICKS || countItems(s, FEATHER) >= TARGET;
    const f0 = countItems(s, FEATHER);
    let kills = 0, idle = 0;
    try {
        const there = await goTo(s, await getWorld(), { x: PEN.x, z: PEN.z, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
        if (!there.ok) await finish([s], false, `travel to chickens ${PEN.x},${PEN.z} failed: ${there.reason} ${there.detail}`);
        while (!over()) {
            if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
            const loot = (st()?.groundItems ?? []).filter((g: any) => g.distance <= 8 && g.reachable !== false && FEATHER.test(g.name))
                .sort((a: any, b: any) => a.distance - b.distance)[0];
            if (loot) {
                const n0 = countItems(s, FEATHER);
                await s.direct({ type: 'pickupItem', x: loot.x, z: loot.z, itemId: loot.id, reason: 'SDK' });
                await waitUntil(s, () => countItems(s, FEATHER) > n0, { timeoutTicks: Math.min(12, loot.distance + 3) });
                continue;
            }
            const c = (st()?.nearbyNpcs ?? []).filter((n: any) => CHICKEN.test(n.name) && n.reachable !== false && (n.hp ?? 1) > 0
                && Math.max(Math.abs(n.x - PEN.x), Math.abs(n.z - PEN.z)) <= 10).sort((a: any, b: any) => a.distance - b.distance)[0];
            const op = c?.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text))?.opIndex;
            if (!c || op === undefined) { idle++; await waitTicks(s, 1); continue; }
            await s.direct({ type: 'interactNpc', npcIndex: c.index, optionIndex: op, reason: 'SDK' });
            if (await waitUntil(s, x => !(x?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && (n.hp ?? 1) > 0), { timeoutTicks: 20 })) kills++;
            if (kills % 25 === 1) console.log(`FEATHERS kills=${kills} feathers=${countItems(s, FEATHER)} idle=${idle} t=${s.tick() - start}`);
        }
        const got = countItems(s, FEATHER) - f0;
        await finish([s], got > 0, `feathers=${countItems(s, FEATHER)} gained=${got} kills=${kills} idle=${idle} ticks=${s.tick() - start}`);
    } catch (e) { await finish([s], false, String(e)); }
}
