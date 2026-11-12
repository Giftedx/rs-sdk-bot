// Feathers for headless arrows (route supply bill: 3,120 headless arrows short). Kills chickens and picks up their
// feathers (npc/scripts/chicken.rs2 drop table: 15 feathers 1/4, 5 feathers 1/4). Feathers stack in one pack slot,
// so the run needs no bank. The kill loop is the one in scripts/fishcook.ts chickenTrip.
// Usage: bun scripts/gather-feathers.ts <account>
// Env: PEN=x,z chicken pen centre (default Lumbridge 3229,3298; others 3017,3288 3187,3277 3197,3353 from
// npcs.json); TICKS (default 3000); TARGET feathers in the pack (default 2000).
import { openBot, finish, countItems, randomEventsOf } from '../packages/core/src/bot';
import { approach } from './walk-to';
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

// The walk into the pen: `walk` to each tile in turn until one exact arrival, and null then. The later tiles are other
// ways past the fence, and a new try of a long walk that stopped on one leg. A failed walk that ends more than 15 tiles
// from the pen and no closer than the try before ends the travel with its cause: no route and no ferry fare are the
// same for every tile.
export async function enterPen(s: Parameters<typeof finishPenEntry>[0], pen: { x: number; z: number }, tiles: { x: number; z: number }[],
    walk: (to: { x: number; z: number; level: number }) => Promise<{ ok: boolean; reason?: string; detail?: string }>): Promise<string | null> {
    const far = () => { const p = s.sdk.getState()?.player; return p ? Math.max(Math.abs(p.worldX - pen.x), Math.abs(p.worldZ - pen.z)) : Infinity; };
    let fault = 'exact pen entry unobserved', best = far();
    for (const t of tiles) {
        const there = await walk({ ...t, level: 0 });
        if (there.ok && await finishPenEntry(s, t)) return null;
        fault = there.ok ? 'exact pen entry unobserved' : `${there.reason} ${there.detail}`;
        const d = far();
        if (!there.ok && d > 15 && d >= best) break;
        best = Math.min(best, d);
    }
    return fault;
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
        // The shared walker with the ferries: a pen across the sea from the start needs the fare from a bank, and a
        // start on another floor needs the stairs.
        const fault = await enterPen(s, PEN, [...penTiles(PEN, spawns).slice(0, 4), PEN], to => approach(s, to));
        if (fault) await finish([s], false, `travel to chickens ${PEN.x},${PEN.z} failed: ${fault}`);
        console.log(`MILESTONE pen t=${s.tick() - start} at=${st()?.player?.worldX},${st()?.player?.worldZ},${st()?.player?.level ?? 0}`);
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
