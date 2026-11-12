// Firemaking on the Draynor burn line with helpers that drop the logs (the record route's method, rune.fast step 2:
// "helpers drop logs"), live. Practice source: scripts/measure/floor-fm-line.ts (642-678 ticks 1-99, no bank).
// Usage: bun scripts/firemaking-line.ts <runner> <helper> [helper ...] [KEY=value ...]   Keys (or env): TARGET_LEVEL
// (default 99), CAP (ticks of the runner, default 6000).
// - The helpers stand at the Draynor bank and hold the log stock in their banks. Each takes a batch of 28 logs of the
//   plan and drops it one log per tile on the next free tiles of the line (scripts/firemaking-order.ts BURN_ROWS, in
//   lineTiles order), each log only when the runner reaches it within AHEAD_TICKS, then banks for its next batch.
// - The runner logs in only when the first batch shows to it: a player drop shows to others 100 ticks after the drop
//   (engine WorldConfig objRevealTicks) and lasts 300 (drop.rs2: lootdrop_duration 200 * 3 / 2). The board counts
//   playtime, so the wait before the login is free. The runner holds only a tinderbox and lights each log where it lies
//   ([opobj4] light_logs_ground); the fire pushes it one tile west, onto the next log.
// - A fire lasts 100 to 199 ticks (firemaking.rs2 firemaking_success). One lap of the 56 line tiles takes about 224
//   ticks at 4 ticks a log, and a helper skips a tile that holds a fire or a log.
// - The plan: the highest tier that the level allows and the helpers hold (PROGRESSIVE=stock), at this server's
//   rate 25 (firemaking.obj productexp 400, 600, 900, 1350, 2025, 3038 tenths).
// Prints FM_LINE_RESULT and a RESULT line for the runner. The helpers bank what is left and log out.
import { existsSync, readFileSync } from 'node:fs';
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { depositObserved } from '../packages/core/src/deposit';
import { BURN_ROWS, DRAYNOR_BANK, LOGS, TINDERBOX, lineTiles, xpForLevel, levelForXp } from './firemaking-order';

export const BATCH = 28, REVEAL_TICKS = 100, DROP_LIFE_TICKS = 300;
// XP of one log at rate 25, by item id (firemaking.obj productexp in tenths * 25 / 10).
export const LOG_XP: Readonly<Record<number, number>> = {
    [LOGS.normal.id]: 1000, [LOGS.oak.id]: 1500, [LOGS.willow.id]: 2250, [LOGS.maple.id]: 3375, [LOGS.yew.id]: 5062.5, [LOGS.magic.id]: 7595,
};
const TIERS = Object.values(LOGS);

// The log ids in burn order, from this XP to the target: at each log, the highest tier that the level allows and the
// stock still holds. Stops at the target, or when the stock has no log the level burns.
export function planLine(xp: number, target: number, stock: Readonly<Record<number, number>>): number[] {
    const left: Record<number, number> = { ...stock }, out: number[] = [];
    while (xp < xpForLevel(target)) {
        const level = levelForXp(xp), tier = [...TIERS].reverse().find(t => t.level <= level && (left[t.id] ?? 0) > 0);
        if (!tier) break;
        out.push(tier.id); left[tier.id]!--; xp += LOG_XP[tier.id]!;
    }
    return out;
}
// The batches of a plan: consecutive runs of BATCH logs, each with its count of each id.
export function batches(plan: readonly number[]): { from: number; ids: number[]; counts: Record<number, number> }[] {
    const out = [];
    for (let from = 0; from < plan.length; from += BATCH) {
        const ids = plan.slice(from, from + BATCH), counts: Record<number, number> = {};
        for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
        out.push({ from, ids, counts });
    }
    return out;
}
// Which helper drops each batch: in turn, but only one whose bank still holds the batch. Undefined when no helper does.
export function assignBatches(work: readonly { counts: Record<number, number> }[], holds: readonly Record<number, number>[]): number[] | undefined {
    const left = holds.map(h => ({ ...h })), out: number[] = [];
    for (let b = 0; b < work.length; b++) {
        const k = [...Array(left.length).keys()].map(i => (b + i) % left.length).find(i => Object.entries(work[b]!.counts).every(([id, n]) => (left[i]![Number(id)] ?? 0) >= n));
        if (k === undefined) return undefined;
        for (const [id, n] of Object.entries(work[b]!.counts)) left[k]![Number(id)]! -= n;
        out.push(k);
    }
    return out;
}
// Whether a helper may drop log i now: the batch before is down, and the runner, at its pace of ticksPerLog, reaches
// the log within AHEAD_TICKS. A drop lives 300 ticks and shows after 100, so a log dropped 220 ticks ahead shows in
// time and lives 80 ticks past the runner's arrival. Below Firemaking 45 a light takes several 4-tick rolls, so a
// whole batch dropped at once would rot at its end.
export const AHEAD_TICKS = 220;
export const mayDrop = (i: number, lit: number, ticksPerLog: number, previousDown: boolean) => previousDown && (i - lit) * Math.max(1, ticksPerLog) <= AHEAD_TICKS;
// The runner's pace: the mean ticks between its last lights (8 before it has lit two).
export function pace(lightTicks: readonly number[], window = 10): number {
    const t = lightTicks.slice(-window - 1);
    return t.length < 2 ? 8 : (t.at(-1)! - t[0]!) / (t.length - 1);
}

type Tile = { x: number; z: number };
const TILES = lineTiles(BURN_ROWS);
const count = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const banked = (s: Session, id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const at = (s: Session) => { const p = s.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ }; };
const fireAt = (s: Session, t: Tile) => (s.sdk.getState()?.nearbyLocs ?? []).some(l => l.x === t.x && l.z === t.z && /^fire$/i.test(l.name));
const groundAt = (s: Session, t: Tile, id?: number) => (s.sdk.getState()?.groundItems ?? []).some(g => g.x === t.x && g.z === t.z && (id === undefined || g.id === id));

if (import.meta.main) {
    // KEY=value arguments set the same options as the environment (a bench case passes arguments only).
    const args = process.argv.slice(2), opt: Record<string, string | undefined> = { ...process.env };
    for (const a of args) { const m = /^([A-Z_]+)=(.*)$/.exec(a); if (m) opt[m[1]!] = m[2]!; }
    const [runnerName, ...helperNames] = args.filter(a => !/^[A-Z_]+=/.test(a));
    const target = Number(opt.TARGET_LEVEL ?? 99), cap = Number(opt.CAP ?? 6000);
    if (!runnerName || !helperNames.length || !Number.isSafeInteger(target) || target < 2 || target > 99) throw Error('usage: firemaking-line.ts <runner> <helper> [helper ...]');
    const stopFile = (n: string) => existsSync(`.practice/stop-${n}`) || existsSync('.practice/stop-all');
    const helpers: Session[] = [];
    let runner: Session | undefined, stop = false, failure = '';
    const fail = (why: string) => { if (!failure) failure = why; stop = true; };
    try {
        for (const n of helperNames) helpers.push(await openBot(n, { onStop: async (_s, why) => fail(`helper ${n}: ${why}`) }));
        // The stock: every helper's bank and pack, read at the bank.
        const stock: Record<number, number> = {}, holds: Record<number, number>[] = [];
        for (const h of helpers) {
            await walkPath(await sessionWalker(h), [{ ...DRAYNOR_BANK, tol: 2 }], { maxTicks: 400 });
            if (!(await h.bot.openBank()).success || !await waitUntil(h, () => !!h.bankObservation?.(), { timeoutTicks: 20 })) throw Error(`helper ${h.name}: bank did not open`);
            // An empty pack takes a whole batch: everything goes to the bank first.
            for (const it of [...h.sdk.getInventory()]) if (h.sdk.getInventory().some(i => i.id === it.id)) await depositObserved(h, it);
            if (h.sdk.getInventory().length) throw Error(`helper ${h.name}: pack not empty after the deposit`);
            const mine: Record<number, number> = {};
            for (const t of TIERS) { mine[t.id] = banked(h, t.id); stock[t.id] = (stock[t.id] ?? 0) + mine[t.id]!; }
            holds.push(mine);
        }
        // The runner's XP from its fleet status (offline), 0 with no status; a wrong value only changes the plan's end.
        const runnerXp = (() => { try { return Number(JSON.parse(readFileSync(`.practice/status/${runnerName}.json`, 'utf8')).skills.find((k: any) => k.name === 'Firemaking').xp) || 0; } catch { return 0; } })();
        const plan = planLine(runnerXp, target, stock), work = batches(plan);
        if (!plan.length) throw Error(`no log in the helpers' stock that Firemaking ${levelForXp(runnerXp)} burns`);
        const owner = assignBatches(work, holds);
        if (!owner) throw Error('no helper holds a whole batch: move the logs so that each batch of 28 is in one bank');
        console.log('FM_LINE_PLAN ' + JSON.stringify({ stock, logs: plan.length, batches: work.length, endLevel: levelForXp(runnerXp + plan.reduce((n, id) => n + LOG_XP[id]!, 0)) }));
        const tileOf: (Tile | undefined)[] = [], droppedAt: number[] = [];
        let cursor = 0, lit = 0, down = -1;
        const lightTicks: number[] = [];
        // A helper's next free tile: the cursor moves on past a tile that holds a fire or a log now.
        const nextTile = (h: Session) => { for (let k = 0; k < TILES.length; k++) { const t = TILES[cursor % TILES.length]!; cursor++; if (!fireAt(h, t) && !groundAt(h, t)) return t; } return undefined; };
        const helperRun = async (h: Session, k: number) => {
            for (let b = 0; b < work.length && !stop; b++) {
                if (owner[b] !== k) continue;
                const batch = work[b]!;
                // Take the batch at the bank while the line burns.
                if (!h.sdk.getState()?.bank?.isOpen) { await walkPath(await sessionWalker(h), [{ ...DRAYNOR_BANK, tol: 2 }], { maxTicks: 200 }); await h.bot.openBank(); await waitUntil(h, () => !!h.bankObservation?.(), { timeoutTicks: 20 }); }
                for (const [id, n] of Object.entries(batch.counts)) {
                    const need = n - count(h, Number(id)), row = h.sdk.getState()?.bank?.items.find(i => i.id === Number(id));
                    if (need > 0 && (!row || !(await h.bot.withdrawItem(row, need, { asNote: false })).success || !await waitUntil(h, () => count(h, Number(id)) >= n, { timeoutTicks: 10 })))
                        return fail(`helper ${h.name}: withdraw ${need} of ${id} for batch ${b}`);
                }
                await h.bot.closeBank();
                for (let j = 0; j < batch.ids.length && !stop; j++) {
                    while (!stop && !mayDrop(batch.from + j, lit, pace(lightTicks), down >= b - 1)) await waitTicks(h, 1);
                    if (stop) break;
                    const id = batch.ids[j]!, t = nextTile(h);
                    if (!t) return fail('no free line tile');
                    const w = await walkPath(await sessionWalker(h), [{ ...t, tol: 0 }], { maxTicks: 60, stop: () => stop });
                    if (!w.ok) return fail(`helper ${h.name}: walk to ${t.x},${t.z}`);
                    const slot = h.sdk.getInventory().find(i => i.id === id)?.slot, n0 = count(h, id);
                    if (slot === undefined) return fail(`helper ${h.name}: no log ${id} in the pack`);
                    await h.direct({ type: 'dropItem', slot, reason: 'SDK' });
                    if (!await waitUntil(h, () => count(h, id) < n0, { timeoutTicks: 6 })) return fail(`helper ${h.name}: drop at ${t.x},${t.z} unobserved`);
                    tileOf[batch.from + j] = t; droppedAt[batch.from + j] = h.tick();
                }
                down = Math.max(down, b);
            }
            // Off the line, then bank what is left.
            await walkPath(await sessionWalker(h), [{ ...DRAYNOR_BANK, tol: 2 }], { maxTicks: 200 });
            if ((await h.bot.openBank()).success) for (const t of TIERS) { const it = h.sdk.getInventory().find(i => i.id === t.id); if (it) await depositObserved(h, it); }
        };
        const loops = helpers.map((h, k) => helperRun(h, k).catch(e => fail(`helper ${h.name}: ${String(e)}`)));
        // The runner logs in when the first log has aged to its reveal, less a few ticks of login.
        const first = helpers[0]!;
        while (!stop && (droppedAt[0] === undefined || first.tick() - droppedAt[0] < REVEAL_TICKS - 5)) await waitTicks(first, 1);
        if (stop) throw Error(failure);
        runner = await openBot(runnerName, { onStop: async (_s, why) => fail(`runner: ${why}`) });
        const r = runner, start = r.tick(), xp = () => r.sdk.getSkillXp('Firemaking') ?? 0, level = () => r.sdk.getSkill('Firemaking')?.baseLevel ?? 0;
        if (!await waitUntil(r, () => !!r.sdk.getState()?.player && r.sdk.getSkillXp('Firemaking') !== null, { timeoutTicks: 20 })) throw Error('runner state unobserved');
        if (count(r, TINDERBOX) < 1) throw Error('runner has no tinderbox in the pack');
        const startXp = xp();
        if (startXp !== runnerXp) console.log(`FM_LINE_WARN runner XP ${startXp}, plan from ${runnerXp}`);
        let waited = 0, retries = 0, lost = 0;
        for (let i = 0; i < plan.length && level() < target && !stop; i++) {
            if (r.tick() - start >= cap) { fail('cap'); break; }
            if (stopFile(runnerName)) { fail('stop file'); break; }
            const id = plan[i]!, w0 = r.tick();
            while (!stop && (!tileOf[i] || !groundAt(r, tileOf[i]!, id))) {
                if (tileOf[i] && r.tick() - droppedAt[i]! > DROP_LIFE_TICKS + 20) break;
                await waitTicks(r, 1);
            }
            waited += r.tick() - w0;
            const t = tileOf[i];
            if (!t || !groundAt(r, t, id)) { lit = i + 1; lost++; console.log(`FM_LINE_WARN log ${i} (${id}) at ${t ? `${t.x},${t.z}` : 'no tile'} not seen`); continue; }
            const before = xp();
            let sent = r.tick();
            // A refusal counts only when the server says it after this light was sent.
            const refused = () => (r.sdk.getState()?.gameMessages ?? []).some(m => m.tick >= sent && /can't light a fire here/i.test(m.text));
            for (let tries = 0; tries < 30 && !stop && groundAt(r, t, id) && xp() === before; tries++) {
                sent = r.tick();
                await r.direct({ type: 'interactGroundItem', x: t.x, z: t.z, itemId: id, optionIndex: 4, reason: 'SDK' });
                await waitUntil(r, () => xp() > before || !groundAt(r, t, id) || refused(), { timeoutTicks: 6 });
                if (refused()) break;
                if (xp() === before && groundAt(r, t, id)) retries++;
            }
            // lit counts every log handled, lit or lost, so a lost log does not hold the next batch back.
            lit = i + 1;
            if (xp() > before) lightTicks.push(r.tick());
            if (xp() === before) { lost++; console.log(`FM_LINE_WARN log ${i} at ${t.x},${t.z} not lit`); }
        }
        stop = true;
        await Promise.race([Promise.all(loops), waitTicks(r, 60)]);
        const out = { ok: level() >= target, level: level(), xp: xp() - startXp, lit, lost, retries, waited, ticks: r.tick() - start, failure };
        console.log('FM_LINE_RESULT ' + JSON.stringify(out));
        await finish([r, ...helpers], out.ok, `firemaking-line level=${out.level} target=${target} lit=${lit} lost=${lost} waited=${waited} ticks=${out.ticks}${failure ? ` failure=${failure}` : ''}`);
    } catch (e) { stop = true; await finish([...(runner ? [runner] : []), ...helpers], false, String(e)); }
}
