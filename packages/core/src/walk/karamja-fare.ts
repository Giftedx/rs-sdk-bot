// Karamja < 30 gp ship-fare escape via Luthas's banana crate job (quests/quest_hunt/scripts/luthas.rs2, banana_crate.rs2).
// An account stranded on Karamja with fewer than 30 coins cannot pay the customs officer (2953,3147 or 2772,3225).
// Picking 10 bananas from the free plantation trees (loc 2073..2077) and packing them into Luthas's crate (2072 at
// 2943,3151) pays 30 coins on completion, unlocking the Musa Point -> Port Sarim ferry route.
import type { Tile } from '../world';
import { waitTicks, waitUntil } from '../ticks';
import type { Walker } from '../walk-leg';
import { walkPath } from './path';
import { sessionWalker } from './session';

type Pos = { x: number; z: number; level: number };

export const KARAMJA_SHIP_FARE = 30;
export const KARAMJA_BANANA_ID = 1963;
export const KARAMJA_CRATE = { id: 2072, x: 2943, z: 3151, level: 0 } as const;
export const KARAMJA_LUTHAS_TILE: Tile = { x: 2939, z: 3154, level: 0 };
export const KARAMJA_GROVE_TILE: Tile = { x: 2925, z: 3156, level: 0 };
const BANANA_TREE_IDS = new Set([2073, 2074, 2075, 2076, 2077]);

// Covers Brimhaven (x <= 2825, z <= 3240) and Musa Point / Jiminua / Shilo (z <= 3190), excluding Rimmington and Crandor.
export const inKaramjaIsland = (p: Pos): boolean =>
    p.level === 0 && p.x >= 2750 && p.x <= 2965 && p.z >= 2880 && (p.z <= 3190 || (p.x <= 2825 && p.z <= 3240));

export function needsKaramjaFareEscape(from: Tile, to: Tile, coins: number): boolean {
    return inKaramjaIsland(from) && !inKaramjaIsland(to) && coins < KARAMJA_SHIP_FARE;
}

type KaramjaSession = Walker & {
    sdk: Walker['sdk'] & {
        getDialog?(): { isOpen: boolean; isWaiting?: boolean; text?: string; options: { index: number; text: string }[] } | null | undefined;
        sendClickDialog?(index: number): Promise<unknown>;
    };
    direct?(a: { type: string; [k: string]: unknown }): Promise<unknown>;
};

// 'none' when the account is not stranded on Karamja under 30 gp, 'earned' when it holds >= 30 coins,
// 'stuck' when the banana-crate job could not be completed.
export async function earnKaramjaFare(
    s: Walker,
    to: Tile,
    stop: () => boolean = () => false,
): Promise<'none' | 'earned' | 'stuck'> {
    const sess = s as KaramjaSession;
    const pos = (): Pos | null => {
        const p = s.sdk.getState()?.player;
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const inv = (): readonly { id: number; slot: number; count?: number }[] => (s.sdk.getState()?.inventory ?? []) as { id: number; slot: number; count?: number }[];
    const coins = () => inv().filter(i => i.id === 995).reduce((n, i) => n + (i.count ?? 1), 0);
    const bananas = () => inv().filter(i => i.id === KARAMJA_BANANA_ID);
    const start = pos();
    if (!start || !needsKaramjaFareEscape(start, to, coins())) return 'none';
    if (inv().length >= 28 && !bananas().length) return 'stuck';
    if (typeof sess.direct !== 'function' || typeof sess.sdk.getDialog !== 'function' || typeof sess.sdk.sendClickDialog !== 'function') return 'stuck';

    const done = (r: 'earned' | 'stuck', why: string) => {
        const p = pos();
        console.log(`WALK_KARAMJA_FARE from=${start.x},${start.z},${start.level} ${r} coins=${coins()} at=${p?.x},${p?.z} ${why}`);
        return r;
    };

    const moveTo = async (goal: Tile, tol = 2): Promise<boolean> => {
        const p = pos();
        if (!p || p.level !== goal.level) return false;
        if (Math.max(Math.abs(p.x - goal.x), Math.abs(p.z - goal.z)) <= tol) return true;
        if (sess.client) {
            try {
                const deps = await sessionWalker(sess as unknown as Parameters<typeof sessionWalker>[0], { noFareFloat: true });
                const r = await walkPath(deps, [{ x: goal.x, z: goal.z, tol }], { maxTicks: 240, stop });
                if (r.ok) return true;
            } catch {
                // Fall back to direct walkTo when route-worker/pathfinder adapter is unavailable.
            }
        }
        await s.bot.walkTo(goal.x, goal.z, tol);
        const after = pos();
        return !!after && after.level === goal.level && Math.max(Math.abs(after.x - goal.x), Math.abs(after.z - goal.z)) <= tol;
    };

    const messages = () => (s.sdk.getState()?.gameMessages ?? []) as readonly { text: string; tick?: number }[];
    const talkLuthas = async (patterns: readonly RegExp[]): Promise<void> => {
        if (!(await moveTo(KARAMJA_LUTHAS_TILE, 3))) return;
        const npc = ((s.sdk.getState()?.nearbyNpcs ?? []) as { index: number; name?: string; distance?: number }[])
            .filter(n => /^luthas$/i.test(n.name ?? ''))
            .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
        if (!npc) return;
        await sess.direct!({ type: 'interactNpc', npcIndex: npc.index, optionIndex: 1, reason: 'SDK' });
        let opened = false, shut = 0;
        for (let t = 0; t < 40 && !stop(); t++) {
            const d = sess.sdk.getDialog!();
            if (d?.isOpen) {
                opened = true;
                shut = 0;
                if (!d.isWaiting) {
                    const pick = d.options.find(o => patterns.some(re => re.test(o.text)));
                    await sess.sdk.sendClickDialog!(pick ? pick.index : (d.options[0]?.index ?? 0));
                }
            } else if (opened && ++shut >= 2) {
                break;
            }
            if (coins() >= KARAMJA_SHIP_FARE && !d?.isOpen) break;
            await waitTicks(s, 1);
        }
    };

    // 1. Accept employment (or collect payment if a crate was already filled).
    await talkLuthas([/offer me employment/i, /thank you, i'll be on my way/i, /crate isn't full/i]);
    if (coins() >= KARAMJA_SHIP_FARE) return done('earned', 'already filled crate');

    // 2. Pick bananas and pack into Luthas's crate until full (10 bananas) or stopped.
    let packed = 0;
    let crateFull = false;
    for (let round = 0; round < 12 && !stop() && !crateFull && packed < 10; round++) {
        const need = Math.min(10 - packed, Math.max(0, 28 - inv().length));
        if (need > 0 && bananas().length < 10 - packed) {
            if (!(await moveTo(KARAMJA_GROVE_TILE, 4))) break;
            for (let pick = 0; pick < need && !stop() && inv().length < 28 && bananas().length < 10 - packed; pick++) {
                const tree = ((s.sdk.getState()?.nearbyLocs ?? []) as { id: number; x: number; z: number; distance?: number }[])
                    .filter(l => BANANA_TREE_IDS.has(l.id))
                    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
                if (!tree) {
                    await waitTicks(s, 2);
                    continue;
                }
                const before = bananas().length;
                await sess.direct!({ type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: 1, reason: 'SDK' });
                await waitUntil(s, () => stop() || bananas().length > before, { timeoutTicks: 10 });
            }
        }
        if (!bananas().length) break;
        if (!(await moveTo(KARAMJA_CRATE, 2))) break;
        while (bananas().length > 0 && !stop() && !crateFull && packed < 10) {
            const b = bananas()[0]!;
            const before = bananas().length;
            const msgCount = messages().length;
            await sess.direct!({ type: 'useItemOnLoc', itemSlot: b.slot, x: KARAMJA_CRATE.x, z: KARAMJA_CRATE.z, locId: KARAMJA_CRATE.id, reason: 'SDK' });
            await waitUntil(
                s,
                () => stop() || bananas().length < before || messages().length > msgCount || !!sess.sdk.getDialog!()?.isOpen,
                { timeoutTicks: 8 },
            );
            const newMsgs = messages().slice(msgCount);
            if (newMsgs.some(m => /crate is already full|crate is full/i.test(m.text))) {
                crateFull = true;
                break;
            }
            if (newMsgs.some(m => /why would i want to do that/i.test(m.text))) {
                await talkLuthas([/offer me employment/i]);
                if (!(await moveTo(KARAMJA_CRATE, 2))) break;
                continue;
            }
            if (bananas().length < before) packed++;
            const d = sess.sdk.getDialog!();
            if (d?.isOpen && !d.isWaiting) await sess.sdk.sendClickDialog!(0);
        }
    }

    // 3. Collect the 30-coin payment from Luthas.
    if (packed >= 10 || crateFull) {
        await talkLuthas([/thank you, i'll be on my way/i, /offer me employment/i]);
    }
    return coins() >= KARAMJA_SHIP_FARE ? done('earned', `packed=${packed}`) : done('stuck', `packed=${packed}`);
}
