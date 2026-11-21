// Bounded one-shot extraction worker for offline stranded fleet accounts (ship decks, ship holds, upper floors,
// dungeons, Paterdomus Temple, and off-hub islands). Routes safely to a mainland ground-level bank and logs out.
// Usage: bun scripts/recover-trapped.ts <account> [capTicks=900] [--target=x,z,level]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finish, getWorld, openBot, sessionDied } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { BOARD_PLANK_IDS, DISEMBARK_PLANK_IDS, disembark, pickDisembarkPlank, type BoatSession } from '../packages/core/src/boat';
import { DECK_REACH, goTo, leaveDeck, type Walker } from '../packages/core/src/walk';
import { inPaterdomusTemple } from './generated/quest-priestperil';
import { classifyLocation, hubTargetFor, type LocationClassification } from './fleet-health';
import { leaveTutorial, onTutorialIsland, walkTarget, walkTargetPersist } from './walk-to';

const root = resolve(import.meta.dir, '..');

function isHealthyHubLoc(classification: LocationClassification): boolean {
    return classification.kind === 'ok';
}

// Recover from inside a sealed ship hold (`level === 0`) by climbing its deck ladder back to `level === 1`.
async function climbOutOfHold(s: Session, stop: () => boolean): Promise<boolean> {
    const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
    const ladder = locs
        .filter(l => /ladder/i.test(l.name ?? '') && (l.optionsWithIndex ?? []).some((o: any) => /^climb-?up$/i.test(o.text)))
        .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
    if (!ladder) return false;
    await s.bot.interactLoc(ladder, 'Climb-up');
    await waitUntil(s, () => stop() || (s.sdk.getState()?.player?.level ?? 0) === 1, { timeoutTicks: 15 });
    return (s.sdk.getState()?.player?.level ?? 0) === 1;
}

// Recover from an upper floor (`level > 0`): disembark gangplanks first, then try downward stairs/ladders.
async function descendToGround(s: Session, stop: () => boolean): Promise<boolean> {
    for (let step = 0; step < 4 && !stop(); step++) {
        const p = s.sdk.getState()?.player;
        if (!p) return false;
        if (p.level === 0) return true;
        if (p.level === 1 && pickDisembarkPlank(s as unknown as BoatSession, DECK_REACH + 4)) {
            const off = await disembark(s as unknown as BoatSession, { stop });
            if (off.ok) continue;
        }
        const locs = (s.sdk.getState()?.nearbyLocs ?? []) as any[];
        const down = locs
            .filter(l => l.id !== 273 && l.id !== 287 && !/ship'?s?\s*ladder/i.test(l.name ?? ''))
            .map(l => {
                const opts = (l.optionsWithIndex ?? []) as Array<{ text: string; opIndex: number }>;
                const cross = /(gang)?plank/i.test(l.name ?? '') && !BOARD_PLANK_IDS.has(l.id ?? -1)
                    ? opts.find(o => /^cross$/i.test(o.text))
                    : undefined;
                const climb = cross ?? opts.find(o => /^(?:climb|walk)-?down$/i.test(o.text));
                const rank = cross ? (DISEMBARK_PLANK_IDS.has(l.id ?? -1) ? 0 : 1) : 2;
                return climb ? { loc: l, op: climb, rank, dist: l.distance ?? 0 } : null;
            })
            .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.dist <= 24)
            .sort((a, b) => a.rank - b.rank || a.dist - b.dist)[0];
        if (!down) return false;
        const beforeLevel = p.level;
        await s.bot.interactLoc(down.loc, down.op.opIndex);
        await waitUntil(s, () => stop() || (s.sdk.getState()?.player?.level ?? beforeLevel) !== beforeLevel, { timeoutTicks: 20 });
    }
    return (s.sdk.getState()?.player?.level ?? 1) === 0;
}

// Clear a blocking Edgeville / generic gate or open Paterdomus Temple doors before routing to bank.
async function tryOpenBlockingExitDoor(s: Session, stop: () => boolean): Promise<void> {
    const p = s.sdk.getState()?.player;
    if (!p || !inPaterdomusTemple(p.worldX, p.worldZ, p.level)) return;
    const doors = ((s.sdk.getState()?.nearbyLocs ?? []) as any[])
        .filter(l => /door|gate/i.test(l.name ?? '') && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)))
        .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    for (const door of doors.slice(0, 2)) {
        if (stop()) break;
        await s.bot.interactLoc(door, 'Open');
        await waitTicks(s, 3);
        const cur = s.sdk.getState()?.player;
        if (cur && !inPaterdomusTemple(cur.worldX, cur.worldZ, cur.level)) return;
    }
}

export async function recoverSessionToHub(
    s: Session,
    options: { capTicks?: number; target?: { x: number; z: number; level: number }; stop?: () => boolean } = {},
): Promise<{ ok: boolean; kind: string; detail: string; from: string; to: string }> {
    const cap = options.capTicks ?? 900;
    const t0 = s.tick();
    const p0 = s.sdk.getState()?.player;
    const from = p0 ? `${p0.worldX},${p0.worldZ},${p0.level}` : 'unknown';
    const stop = () => !!options.stop?.() || s.tick() - t0 >= cap || (!!p0 && sessionDied(p0, s.sdk.getState()?.player));

    const cur = () => {
        const p = s.sdk.getState()?.player;
        return p ? { worldX: p.worldX, worldZ: p.worldZ, level: p.level } : undefined;
    };
    const pos = cur();
    if (!pos) return { ok: false, kind: 'unknown', detail: 'no player state on login', from, to: from };

    const initial = classifyLocation(pos);
    const target = options.target ?? initial.targetHub ?? hubTargetFor(pos);
    if (!initial.autoFixable) {
        return { ok: false, kind: initial.kind, detail: initial.summary, from, to: from };
    }

    if (onTutorialIsland(s.sdk.getState()?.player)) {
        const tut = await leaveTutorial(s, () => s.bot.skipTutorial(), () => Promise.resolve(), stop);
        if (!tut?.ok) {
            const end = cur();
            return { ok: false, kind: initial.kind, detail: `tutorial skip failed: ${tut?.reason ?? ''} ${tut?.detail ?? ''}`.trim(), from, to: end ? `${end.worldX},${end.worldZ},${end.level}` : from };
        }
    }

    const afterTut = cur();
    if (afterTut?.level === 0 && classifyLocation(afterTut).kind === 'ship_hold') {
        await climbOutOfHold(s, stop);
    }

    const afterHold = cur();
    if (afterHold && afterHold.level > 0) {
        if (afterHold.level === 1 && pickDisembarkPlank(s as unknown as BoatSession, DECK_REACH + 4)) {
            await leaveDeck(s as unknown as Walker, stop);
        }
        const now = cur();
        if (now && now.level > 0) await descendToGround(s, stop);
    }

    const afterFloor = cur();
    if (afterFloor && inPaterdomusTemple(afterFloor.worldX, afterFloor.worldZ, afterFloor.level)) {
        await tryOpenBlockingExitDoor(s, stop);
    }

    const beforeRoute = cur();
    if (!beforeRoute) return { ok: false, kind: initial.kind, detail: 'lost player state during recovery', from, to: from };

    // Only walk all the way to the hub bank when off-hub, on an upper floor, in a dungeon, or > 20 tiles from hub.
    const distToTarget = beforeRoute.level === target.level ? Math.max(Math.abs(beforeRoute.worldX - target.x), Math.abs(beforeRoute.worldZ - target.z)) : Infinity;
    const curClass = classifyLocation(beforeRoute);
    if (beforeRoute.level !== 0 || !isHealthyHubLoc(curClass) || distToTarget > 20) {
        const res = await walkTargetPersist(s, target, 4, t => walkTarget(s, t, false, undefined, { noJewelry: true }));
        if (!res.ok) {
            const world = await getWorld();
            const fallback = await goTo(s, world, target, { skills: {}, varps: {}, items: [] }, { legTimeoutTicks: 120, noJewelry: true });
            if (!fallback.ok) {
                const end = cur();
                const at = end ? `${end.worldX},${end.worldZ},${end.level}` : 'unknown';
                return { ok: false, kind: initial.kind, detail: `route failed: ${fallback.reason ?? res.reason ?? ''} ${fallback.detail ?? res.detail ?? ''}`.trim(), from, to: at };
            }
        }
    }

    const end = cur();
    const to = end ? `${end.worldX},${end.worldZ},${end.level}` : 'unknown';
    const finalClass = end ? classifyLocation(end) : initial;
    const ok = !!end && end.level === 0 && isHealthyHubLoc(finalClass);
    return {
        ok,
        kind: initial.kind,
        detail: ok ? `recovered from ${initial.kind} (${from}) to ${to}` : `ended still ${finalClass.kind} at ${to}`,
        from,
        to,
    };
}

function parseTargetArg(args: readonly string[]): { x: number; z: number; level: number } | undefined {
    const raw = args.find(a => a.startsWith('--target='));
    if (!raw) return undefined;
    const parts = raw.slice('--target='.length).split(',').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isSafeInteger(n))) {
        throw Error(`invalid --target=${raw}`);
    }
    return { x: parts[0]!, z: parts[1]!, level: parts[2] ?? 0 };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const account = args.find(a => !a.startsWith('--'));
    const capArg = args.filter(a => !a.startsWith('--'))[1];
    const capTicks = capArg !== undefined ? Number(capArg) : 900;
    if (!account || !Number.isSafeInteger(capTicks) || capTicks < 1) {
        console.error('Usage: bun scripts/recover-trapped.ts <account> [capTicks=900] [--target=x,z,level]');
        process.exit(1);
    }
    const target = parseTargetArg(args);
    const stopFile = join(root, '.practice', `stop-${account}`);
    const stop = () => {
        if (!existsSync(stopFile)) return false;
        try { return !readFileSync(stopFile, 'utf8').startsWith('fleet-health'); } catch { return true; }
    };
    const s = await openBot(account).catch(err => finish([], false, `login: ${String(err)}`));
    try {
        const res = await recoverSessionToHub(s, { capTicks, target, stop });
        await finish([s], res.ok, `recover=${res.kind} from=${res.from} to=${res.to} ${res.detail}`);
    } catch (error) {
        await finish([s], false, String(error));
    }
}
