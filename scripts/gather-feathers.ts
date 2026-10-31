// Feathers for headless arrows (route supply bill: 3,120 headless arrows short). Kills chickens and picks up their
// feathers (npc/scripts/chicken.rs2 drop table: 15 feathers 1/4, 5 feathers 1/4). Feathers stack in one pack slot,
// so the run needs no bank. The kill loop is the one in scripts/fishcook.ts chickenTrip.
// Usage: bun scripts/gather-feathers.ts <account>
// Env: PEN=x,z chicken pen centre (default Lumbridge 3229,3298; others 3017,3288 3187,3277 3197,3353 from
// npcs.json); TICKS (default 3000); TARGET feathers in the pack (default 2000).
import { openBot, finish, getWorld, accountOf, countItems, randomEventsOf } from '../packages/core/src/bot';
import { goTo } from '../packages/core/src/walk';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function parsePen(v: string | undefined): { x: number; z: number } {
    const m = (v ?? '').match(/^(\d+),(\d+)$/);
    return m ? { x: Number(m[1]), z: Number(m[2]) } : { x: 3229, z: 3298 };
}

// Chicken spawn tiles (npcs.json) nearest the pen centre: a centre can fall on a fence or an unreachable tile.
export function penTiles(pen: { x: number; z: number }, spawns: { x: number; z: number; level: number }[]): { x: number; z: number }[] {
    const d = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - pen.x), Math.abs(t.z - pen.z));
    return spawns.filter(t => t.level === 0 && d(t) <= 15).sort((a, b) => d(a) - d(b)).map(({ x, z }) => ({ x, z }));
}

// A route may finish beside a spawn, on the other side of a fence. Only an
// observed exact-tile arrival establishes entry into the pen.
export async function finishPenEntry(s: { sdk: { getState(): any }; bot: { walkTo(x:number,z:number,tolerance?:number):Promise<unknown> } }, tile: {x:number;z:number}): Promise<boolean> {
    const inside = () => { const p=s.sdk.getState()?.player; return p?.level===0&&p.worldX===tile.x&&p.worldZ===tile.z; };
    if (inside()) return true;
    await s.bot.walkTo(tile.x,tile.z,0);
    return inside();
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
        const spawns = (JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/npcs.json'), 'utf8')) as { name: string; spawns?: { x: number; z: number; level: number }[] }[])
            .filter(n => n.name === 'Chicken').flatMap(n => n.spawns ?? []);
        let there: Awaited<ReturnType<typeof goTo>> | undefined, entered=false;
        for (const t of [...penTiles(PEN, spawns).slice(0, 4), PEN]) {
            there = await goTo(s, await getWorld(), { ...t, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
            if (there.ok && await finishPenEntry(s,t)) { entered=true; break; }
        }
        if (!entered) await finish([s], false, `travel to chickens ${PEN.x},${PEN.z} failed: ${there&&!there.ok?there.reason+' '+there.detail:'exact pen entry unobserved'}`);
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
            if (await waitUntil(s, x => !(x?.nearbyNpcs ?? []).some((n: any) => n.index === c.index && (n.hp ?? 1) > 0), { timeoutTicks: 20 })
                && ++kills % 25 === 0) console.log(`FEATHERS kills=${kills} feathers=${countItems(s, FEATHER)} idle=${idle} t=${s.tick() - start}`);
        }
        // A pickup can meet the order while the previous chicken still retaliates.
        await waitUntil(s, x => x?.player?.combat?.inCombat === false, { timeoutTicks: 30 });
        const got = countItems(s, FEATHER) - f0;
        await finish([s], got > 0, `feathers=${countItems(s, FEATHER)} gained=${got} kills=${kills} idle=${idle} ticks=${s.tick() - start}`);
    } catch (e) { await finish([s], false, String(e)); }
}
