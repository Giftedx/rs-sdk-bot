// Bounded charter-boat legs, extracted from scripts/foodcourier.ts (sail, converse, disembark).
// Callers keep their own fare accounting, health checks and route policy. Pass a `before` hook for health,
// a `stop` for death or a cap, and an absolute `deadline` tick. Results report the observed boundary.
import { waitTicks, waitUntil, type TickSource } from './ticks';

type Pos = { worldX: number; worldZ: number; level: number };
type DialogOption = { index: number; text: string };
export interface BoatSession extends TickSource {
    sdk: {
        getState(): any;
        getDialog(): { isOpen: boolean; isWaiting?: boolean; options: DialogOption[] } | null | undefined;
        sendClickDialog(index: number): Promise<unknown>;
        findNearbyLoc(pattern: RegExp): unknown;
    };
    bot: {
        talkTo(npc: RegExp): Promise<{ success: boolean; message?: string }>;
        interactLoc(loc: any, option: string): Promise<unknown>;
    };
}
export interface BoatLimits {
    stop?: () => boolean;
    deadline?: number;                       // absolute game tick
    before?: () => Promise<void> | void;     // runs before each attempt (caller health checks)
}
export interface SailOptions extends BoatLimits {
    npc: RegExp;
    choices: RegExp[];                       // dialogue options to pick; other prompts take option 0
    deck: { x: number; z: number };
    deckRange?: number;                      // default 8, on level 1
    attempts?: number;                       // talk attempts, default 3
    converseTicks?: number;                  // dialogue ticks per attempt, default 60
    retryTicks?: number;                     // wait after a rejected talk, default 2
    onTalkFail?: (message: string) => void;
}
export interface DisembarkOptions extends BoatLimits {
    attempts?: number;                       // default 4
    missTicks?: number;                      // wait when no gangplank is in view, default 2
    crossTicks?: number;                     // ground wait after a cross, default 10
}
export type BoatOutcome = 'arrived' | 'stopped' | 'deadline' | 'rejected' | 'unobserved';
export interface BoatResult { ok: boolean; outcome: BoatOutcome; ticks: number; talks: number; rejected: number; detail: string }

const pos = (s: BoatSession): Pos | undefined => s.sdk.getState()?.player;
const at = (p: Pos | undefined) => p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';

function limits(s: BoatSession, o: BoatLimits) {
    const halted = (): BoatOutcome | null => o.stop?.() ? 'stopped' : o.deadline !== undefined && s.tick() >= o.deadline ? 'deadline' : null;
    const left = (n: number) => o.deadline === undefined ? n : Math.max(0, Math.min(n, o.deadline - s.tick()));
    return { halted, left };
}

export function onDeck(p: Pos | undefined, deck: { x: number; z: number }, range = 8): boolean {
    return !!p && p.level === 1 && Math.max(Math.abs(deck.x - p.worldX), Math.abs(deck.z - p.worldZ)) <= range;
}

// Talk to the boat NPC and answer its dialogue until the player stands on the destination deck.
export async function sail(s: BoatSession, o: SailOptions): Promise<BoatResult> {
    const start = s.tick(), { halted, left } = limits(s, o);
    const landed = () => onDeck(pos(s), o.deck, o.deckRange ?? 8);
    let talks = 0, rejected = 0, why: BoatOutcome | null = null;
    const done = (outcome: BoatOutcome, detail: string): BoatResult => ({ ok: outcome === 'arrived', outcome, ticks: s.tick() - start, talks, rejected, detail });
    for (let attempt = 0; attempt < (o.attempts ?? 3) && !landed(); attempt++) {
        if ((why = halted())) return done(why, `${why} before talk at=${at(pos(s))}`);
        await o.before?.();
        if ((why = halted())) return done(why, `${why} before talk at=${at(pos(s))}`);
        talks++;
        const t = await s.bot.talkTo(o.npc);
        if (!t.success) {
            rejected++; o.onTalkFail?.(t.message ?? '');
            if ((why = halted())) return done(why, `${why} after rejected talk at=${at(pos(s))}`);
            const n = left(o.retryTicks ?? 2); if (n > 0) await waitTicks(s, n);
            continue;
        }
        for (let i = 0; i < (o.converseTicks ?? 60) && !landed(); i++) {
            if ((why = halted())) return done(why, `${why} in dialogue at=${at(pos(s))}`);
            const d = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(c => o.choices.some(re => re.test(c.text)));
                await s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
    }
    if (landed()) return done('arrived', `deck at=${at(pos(s))}`);
    return done(rejected === talks && talks > 0 ? 'rejected' : 'unobserved', `no deck arrival talks=${talks} rejected=${rejected} at=${at(pos(s))}`);
}

// Cross the gangplank until the player stands on level 0.
export async function disembark(s: BoatSession, o: DisembarkOptions = {}): Promise<BoatResult> {
    const start = s.tick(), { halted, left } = limits(s, o);
    let crossings = 0, why: BoatOutcome | null = null;
    const done = (outcome: BoatOutcome, detail: string): BoatResult => ({ ok: outcome === 'arrived', outcome, ticks: s.tick() - start, talks: crossings, rejected: 0, detail });
    for (let i = 0; i < (o.attempts ?? 4); i++) {
        if (pos(s)?.level === 0) return done('arrived', `ground at=${at(pos(s))}`);
        if ((why = halted())) return done(why, `${why} on deck at=${at(pos(s))}`);
        await o.before?.();
        const d = s.sdk.getDialog();
        if (d?.isOpen) { await s.sdk.sendClickDialog(0); await waitTicks(s, 1); continue; }
        const plank = s.sdk.findNearbyLoc(/^gangplank$/i);
        if (!plank) { const n = left(o.missTicks ?? 2); if (n > 0) await waitTicks(s, n); continue; }
        crossings++;
        await s.bot.interactLoc(plank, 'Cross');
        const n = left(o.crossTicks ?? 10);
        if (n > 0) await waitUntil(s, st => st?.player?.level === 0, { timeoutTicks: n });
    }
    if (pos(s)?.level === 0) return done('arrived', `ground at=${at(pos(s))}`);
    return done(halted() ?? 'unobserved', `no ground arrival crossings=${crossings} at=${at(pos(s))}`);
}
