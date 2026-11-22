// Tutorial island exit, Elemental Workshop exit, and guarded cow-path obstacle checks.
import type { Outcome } from '../../../core/src/act';
import { accountOf, getWorld } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { questFlags } from '../../../core/src/quest-status';
import { waitUntil } from '../../../core/src/ticks';
import { expandPath, goTo, sessionWalker, walkPath, type PathDeps, type PathTile } from '../../../core/src/walk';

export function runeSupplyAssets(items: readonly { id: number; count: number }[]) {
    const totals: Record<number, number> = {};
    for (const i of items) totals[i.id] = (totals[i.id] ?? 0) + i.count;
    return totals;
}

export const onStarterIsland = (p: { worldX: number; worldZ: number; level?: number } | null | undefined): boolean =>
    !!p && p.worldX >= 3050 && p.worldX <= 3160 && p.worldZ >= 3050 && p.worldZ <= 3140;

export async function leaveRuneStarter(s: Session, stop: () => boolean) {
    const pos = () => s.sdk.getState()?.player;
    if (!await waitUntil(s, () => stop() || !!pos(), { timeoutTicks: 30 })) throw Error('starter position unobserved');
    if (stop()) throw Error('stopped during starter exit');
    const p = pos()!;
    if (onStarterIsland(p)) {
        const start = s.tick(), deadline = start + 100;
        let ended = false, designSent = false, talks = 0, last = '';
        void s.ended?.then(() => { ended = true; });
        const observation = () => {
            const state = s.sdk.getState(), cur = pos();
            return {
                position: cur ? { worldX: cur.worldX, worldZ: cur.worldZ, level: cur.level } : null,
                modalOpen: state?.modalOpen, modalInterface: state?.modalInterface, dialog: s.sdk.getDialog(),
                inventory: s.sdk.getInventory(), quest: questFlags(s.client)?.find(q => q.name === 'Rune Mysteries Quest')?.state ?? 'unknown',
                messages: state?.gameMessages?.slice(-3),
            };
        };
        const record = () => {
            const value = JSON.stringify(observation());
            if (value !== last) {
                last = value;
                console.log('RUNE_SUPPLY_STARTER ' + JSON.stringify({ tick: s.tick(), ...observation() }));
            }
            return value;
        };
        const check = () => {
            if (stop()) throw Error('stopped during starter exit');
            if (ended) throw Error('starter session ended');
            if (s.tick() > deadline) throw Error('starter entry deadline: action exceeded tick budget; ' + last);
        };
        const grant = [
            [1351, 1], [590, 1], [303, 1], [315, 1], [1925, 1], [1931, 1], [2309, 1], [1265, 1],
            [1205, 1], [1277, 1], [1171, 1], [841, 1], [882, 25], [556, 25], [558, 15], [555, 6], [557, 4], [559, 2],
        ] as const;
        const arrived = () => {
            const cur = pos();
            return !!cur && cur.level === 0 && cur.worldX >= 3200 && cur.worldX <= 3235 && cur.worldZ >= 3200 && cur.worldZ <= 3250;
        };
        const ready = () => arrived()
            && grant.every(([id, n]) => s.sdk.getInventory().filter(i => i.id === id).reduce((a, i) => a + i.count, 0) === n)
            && questFlags(s.client)?.some(q => q.name === 'Rune Mysteries Quest' && q.state !== 'unknown');
        while (true) {
            const page = record();
            check();
            if (ready()) break;
            if (s.tick() >= deadline) throw Error('starter entry deadline: mainland, tutorial grant or dialogue unobserved; ' + last);
            const state = s.sdk.getState(), dialog = s.sdk.getDialog();
            let action: Awaited<ReturnType<typeof s.sdk.sendClickDialog>> | undefined;
            if (state?.modalOpen) {
                if (state.modalInterface !== 3559) throw Error('unsupported tutorial modal; ' + last);
                if (!designSent) {
                    designSent = true;
                    action = await s.sdk.sendAcceptCharacterDesign();
                }
            } else if (!arrived() && dialog?.isOpen) {
                if (!dialog.isWaiting) {
                    const yes = dialog.options.find(o => /^yes please[.]?$/i.test(o.text));
                    if (yes && dialog.options.every(o => /^(yes please|no, thank you)[.]?$/i.test(o.text))) action = await s.sdk.clickDialogByText(/^yes please[.]?$/i);
                    else if (dialog.options.length === 0 || dialog.options.length === 1 && dialog.options[0]!.buttonType === 6) action = await s.sdk.sendClickDialog(0);
                    else throw Error('unsupported tutorial choice; ' + last);
                }
            } else if (!arrived() && (designSent || s.tick() - start >= 15) && talks < 3) {
                const guide = state?.nearbyNpcs.find(n => /^runescape guide$/i.test(n.name));
                const op = guide?.optionsWithIndex.find(o => /^talk-to$/i.test(o.text));
                if (guide && op) {
                    talks++;
                    action = await s.sdk.sendInteractNpc(guide.index, op.opIndex);
                }
            }
            check();
            if (action && !action.success) {
                record();
                throw Error('starter action refused: ' + JSON.stringify(action) + '; ' + last);
            }
            await waitUntil(s, () => stop() || ended || s.tick() >= deadline || JSON.stringify(observation()) !== page, { timeoutTicks: Math.min(8, deadline - s.tick()) });
        }
    }
    const current = pos()!;
    if (current.level !== 0 && current.worldX >= 3200 && current.worldX <= 3225 && current.worldZ >= 3200 && current.worldZ <= 3235) {
        const r = await goTo(s, await getWorld(), { x: 3226, z: 3250, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
        if (!r.ok) throw Error('starter floor exit: ' + JSON.stringify(r));
    }
    if (stop()) throw Error('stopped during starter exit');
}

export const ELEMENTAL_STAIRS_UP = { id: 3416, x: 2716, z: 9888 };
export const ELEMENTAL_ODD_WALL = { id: 3391, x: 2709, z: 3495 };
export const SEERS_BANK = { x: 2725, z: 3492, level: 0 };

type Pos = { worldX: number; worldZ: number; level?: number } | null | undefined;
export function inElementalBasement(p: Pos): boolean {
    return !!p && (p.level ?? 0) === 0 && p.worldX >= 2700 && p.worldX <= 2745 && p.worldZ >= 9860 && p.worldZ <= 9915;
}
export function inElementalStairwell(p: Pos): boolean {
    return !!p && (p.level ?? 0) === 0 && p.worldX >= 2708 && p.worldX <= 2712 && p.worldZ >= 3496 && p.worldZ <= 3499;
}
export function inElementalWorkshop(p: Pos): boolean {
    return inElementalBasement(p) || inElementalStairwell(p);
}

export interface ElementalExitOps {
    walkToStairs?: (s: Session) => Promise<void>;
    interact?: (s: Session, loc: any, option: number | RegExp) => Promise<unknown>;
    wait?: (s: Session, pred: () => boolean, timeoutTicks: number) => Promise<boolean>;
}

const nearbyLoc = (s: Session, match: (l: any) => boolean) =>
    (s.sdk.getState()?.nearbyLocs ?? []).filter(match).sort((a: any, b: any) => (a.distance ?? 0) - (b.distance ?? 0))[0];

export async function leaveElementalWorkshop(s: Session, stop: () => boolean = () => false, ops: ElementalExitOps = {}): Promise<Outcome | null> {
    const pos = () => s.sdk.getState()?.player;
    if (!inElementalWorkshop(pos())) return null;
    const start = s.tick?.() ?? 0;
    const elapsed = () => Math.max(0, (s.tick?.() ?? start) - start);
    const interact = ops.interact ?? ((sess, loc, option) => sess.bot.interactLoc(loc, option));
    const wait = ops.wait ?? ((sess, pred, timeoutTicks) => waitUntil(sess, () => stop() || pred(), { timeoutTicks }));
    const walkToStairs = ops.walkToStairs ?? (async sess => {
        await walkPath(await sessionWalker(sess), [{ x: ELEMENTAL_STAIRS_UP.x, z: ELEMENTAL_STAIRS_UP.z, tol: 2 }], { maxTicks: 60 });
    });
    const fail = (detail: string): Outcome => ({ ok: false, reason: stop() ? 'aborted' : 'precondition', detail, ticks: elapsed() });

    if (inElementalBasement(pos())) {
        let stairs = nearbyLoc(s, l => l.id === ELEMENTAL_STAIRS_UP.id || (/stair/i.test(l.name ?? '') && l.z >= 9880));
        if (!stairs) {
            await walkToStairs(s);
            if (stop()) return fail('stopped walking to Elemental Workshop stairs');
            stairs = nearbyLoc(s, l => l.id === ELEMENTAL_STAIRS_UP.id || (/stair/i.test(l.name ?? '') && l.z >= 9880));
        }
        for (let i = 0; i < 4 && inElementalBasement(pos()) && !stop(); i++) {
            const target = nearbyLoc(s, l => l.id === ELEMENTAL_STAIRS_UP.id || (/stair/i.test(l.name ?? '') && l.z >= 9880)) ?? stairs;
            if (!target) break;
            await interact(s, target, 1);
            await wait(s, () => !inElementalBasement(pos()), 10);
        }
        if (inElementalBasement(pos())) return fail('failed to climb Elemental Workshop stairs');
    }

    if (inElementalStairwell(pos())) {
        for (let i = 0; i < 4 && inElementalStairwell(pos()) && !stop(); i++) {
            const wall = nearbyLoc(s, l => l.id === ELEMENTAL_ODD_WALL.id || l.id === 3390 || (/odd looking wall/i.test(l.name ?? '') && l.z === ELEMENTAL_ODD_WALL.z));
            if (!wall) break;
            await interact(s, wall, 1);
            await wait(s, () => (pos()?.worldZ ?? 9999) <= ELEMENTAL_ODD_WALL.z, 10);
        }
        if (inElementalStairwell(pos())) return fail('failed to push Elemental Workshop exit wall');
    }

    return stop() ? fail('stopped during Elemental Workshop exit') : { ok: true, ticks: elapsed() };
}

export const COW_BEAR_BOXES = [
    [2632, 3274, 2633, 3280],
    [2691, 3341, 2694, 3344],
    [2692, 3331, 2698, 3333],
    [2702, 3344, 2702, 3344],
    [2706, 3330, 2708, 3336],
    [2716, 3330, 2718, 3336],
] as const;

const cowBearTile = (p: PathTile) =>
    COW_BEAR_BOXES.some(([x1, z1, x2, z2]) => Math.max(Math.max(x1 - p.x, 0, p.x - x2), Math.max(z1 - p.z, 0, p.z - z2)) <= 7);

export function guardCowWalker(base: PathDeps, safety: () => string | null) {
    let why: string | null = null;
    const check = () => { why ??= safety(); return why; };
    const validate = (level: number, from: PathTile, to: PathTile, corners: PathTile[]) => {
        if (level !== 0 || cowBearTile(from)) { why = 'cow route outside admitted floor/bear bounds'; return false; }
        const end = corners.at(-1);
        if (!end && from.x === to.x && from.z === to.z) return true;
        if (!end || Math.max(Math.abs(end.x - to.x), Math.abs(end.z - to.z)) > 1) { why = 'cow route incomplete: no empty/partial fallback'; return false; }
        if (expandPath(from, corners).some(cowBearTile)) { why = 'cow route intersects bear wander/hunt bounds'; return false; }
        return true;
    };
    const refuse = () => ({ success: false, phase: 'dispatch', reason: 'cow_route_guard', message: why ?? 'cow route unknown' });
    const deps: PathDeps = {
        ...base,
        plan: (level, from, to, avoid) => { const corners = base.plan(level, from, to, avoid); return validate(level, from, to, corners) ? corners : []; },
        walk: (x, z) => { if (check()) return refuse(); const p = base.pos(); if (!p || !validate(p.level, p, { x, z }, base.plan(p.level, p, { x, z }))) return refuse(); return base.walk(x, z); },
        interactLoc: (loc, op) => check() ? refuse() : base.interactLoc(loc, op),
        ...(base.runOn ? { runOn: () => check() ? refuse() : base.runOn!() } : {}),
    };
    return { deps, reason: check };
}
