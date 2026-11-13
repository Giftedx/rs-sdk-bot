// Death recovery for every bot that is not on a record run. On death the server drops the pack and the worn items on
// the death tile for ^lootdrop_duration = 200 ticks (content/scripts/player/scripts/death.rs2:134-135,
// drop tables/configs/lootdrop.constant). A tradeable item shows only to its owner for objRevealTicks (100) of those
// (engine InvOps.ts INV_DROPALL, WorldConfig.ts). The bot runs back from the respawn, picks its own items up and
// wears again what it wore. Then the session ends as a death, as before: the controller decides what runs next.
// It does not go back into the Wilderness (a player kill gives the items to the killer), past the despawn, or when
// a hunting NPC stronger than the bot stands near the tile (lootRisk in loot.ts). `DEATH_RECOVERY <result> ...`.
import { lootRisk, unitValue, type LootTables } from './loot';
import { wildernessLevel } from './prayer-guard';
import { waitUntil, type TickSource } from './ticks';

export type Tile = { x: number; z: number; level: number };
export type DeathSnapshot = { tick: number; at: Tile; lifeId?: number; pack: { id: number; count: number }[]; worn: number[] };

// Ticks the death drop stays on the ground, and the ticks kept back for the pickups at the end.
export const DROP_TICKS = 200, PICKUP_MARGIN = 15;
// A run covers at most 2 tiles a tick: a tile farther than this from the respawn cannot be reached in time.
export const RUN_TILES_PER_TICK = 2;
// Ticks to wait for the respawn; ticks for each pickup.
export const RESPAWN_TICKS = 20, PICKUP_TICKS = 8, PICKUP_TRIES = 3;
// A death tile this near (same level) gets one plain walk first: on the bench goTo stood 37 ticks before it moved
// for an 11-tile walk (extra:death-recovery, respawn=6 walk=49). The planned walk runs only when the plain one fails.
export const NEAR_WALK = 20;
const WEAR = /^(wield|wear)$/i;
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

// The bot's state on its last tick alive.
export function snapshot(st: any): DeathSnapshot | null {
    const p = st?.player;
    if (!p || p.isDead) return null;
    return {
        tick: st.tick ?? 0, at: { x: p.worldX, z: p.worldZ, level: p.level ?? 0 }, lifeId: p.lifeId,
        pack: (st.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count ?? 1 })),
        worn: (st.equipment ?? []).filter(Boolean).map((i: any) => i.id),
    };
}

// Null when the bot can go back, else the reason it cannot.
export function deathPlan(d: DeathSnapshot, now: number, at: { x: number; z: number; level: number }): string | null {
    if (wildernessLevel(d.at.x, d.at.z) > 0) return 'wilderness';
    if (d.pack.length === 0 && d.worn.length === 0) return 'nothing';
    const left = d.tick + DROP_TICKS - PICKUP_MARGIN - now;
    if (left <= 0 || (at.level === d.at.level && cheb(at, d.at) > left * RUN_TILES_PER_TICK)) return 'too-far';
    return null;
}

export interface RecoverySession extends TickSource {
    direct(a: any): Promise<unknown>;
}
export interface RecoveryOptions {
    // Walks to the tile and resolves when the walk ends; the signal aborts it at the despawn.
    walk(to: Tile, signal: AbortSignal): Promise<{ ok: boolean; reason?: string }>;
    tables: LootTables;
    danger: ReadonlyMap<number, number>;
    friends: ReadonlySet<string>;
    log(line: string): void;
}

const until = (s: RecoverySession, pred: (st: any) => boolean, ticks: number) => waitUntil(s, st => !!st && pred(st), { timeoutTicks: ticks });
const countOf = (st: any, id: number) => (st?.inventory ?? []).reduce((n: number, i: any) => (i.id === id ? n + (i.count ?? 1) : n), 0);

async function wearBack(s: RecoverySession, worn: readonly number[]): Promise<number> {
    let n = 0;
    for (const id of worn) {
        const st = s.sdk.getState();
        if ((st?.equipment ?? []).some((i: any) => i?.id === id)) continue;
        const item = (st?.inventory ?? []).find((i: any) => i.id === id);
        const op = item?.optionsWithIndex?.find((o: any) => WEAR.test(o.text ?? ''));
        if (!item || !op) continue;
        await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op.opIndex, reason: 'death-recovery' });
        if (await until(s, q => (q?.equipment ?? []).some((i: any) => i?.id === id), 3)) n++;
    }
    return n;
}

// Runs the recovery and returns its result line (also logged).
export async function recoverDeath(s: RecoverySession, d: DeathSnapshot, o: RecoveryOptions): Promise<string> {
    const begin = s.tick();
    // The tick each stage ended, counted from the start: the respawn and the walk.
    let respawn = -1, walk = -1;
    const stages = () => `${respawn >= 0 ? ` respawn=${respawn}` : ''}${walk >= 0 ? ` walk=${walk}` : ''}`;
    const done = (result: string, extra = '') => { const line = `DEATH_RECOVERY ${result} at=${d.at.x},${d.at.z} ticks=${s.tick() - begin}${stages()}${extra}`; o.log(line); return line; };
    const alive = await until(s, st => !!st?.player && !st.player.isDead && (d.lifeId === undefined || st.player.lifeId !== d.lifeId || cheb({ x: st.player.worldX, z: st.player.worldZ }, d.at) > 1), RESPAWN_TICKS);
    if (!alive) return done('skip-no-respawn');
    respawn = s.tick() - begin;
    const p = s.sdk.getState().player;
    const why = deathPlan(d, s.tick(), { x: p.worldX, z: p.worldZ, level: p.level ?? 0 });
    if (why) return done(`skip-${why}`);
    const deadline = d.tick + DROP_TICKS - PICKUP_MARGIN;
    const stop = new AbortController();
    const off = s.onTick(() => { if (s.tick() >= deadline) stop.abort(new Error('death drop despawns')); });
    let walked: { ok: boolean; reason?: string } = { ok: false };
    const near = (q: any) => !!q?.player && q.player.level === d.at.level && cheb({ x: q.player.worldX, z: q.player.worldZ }, d.at) <= 1;
    try {
        if (p.level === d.at.level && cheb({ x: p.worldX, z: p.worldZ }, d.at) <= NEAR_WALK) {
            await s.direct({ type: 'walkTo', x: d.at.x, z: d.at.z, running: true, reason: 'death-recovery' });
            if (await waitUntil(s, near, { timeoutTicks: NEAR_WALK, signal: stop.signal })) walked = { ok: true };
        }
        if (!walked.ok && !stop.signal.aborted) walked = await o.walk(d.at, stop.signal);
    } finally { off(); walk = s.tick() - begin; }
    const q = s.sdk.getState()?.player;
    if (!q || q.level !== d.at.level || cheb({ x: q.worldX, z: q.worldZ }, d.at) > 1) return done('skip-walk', ` reason=${walked.reason ?? 'not-there'}`);
    // Our own items on the tile, the most valuable first.
    const ours = new Set([...d.pack.map(i => i.id), ...d.worn]);
    const piles = ((s.sdk.getState()?.groundItems ?? []) as any[]).filter(g => g.x === d.at.x && g.z === d.at.z && ours.has(g.id))
        .sort((a, b) => unitValue(b.id, o.tables) * b.count - unitValue(a.id, o.tables) * a.count);
    let picked = 0;
    for (const g of piles) {
        const st = s.sdk.getState();
        const risk = lootRisk(st, { ...g, distance: 0 }, o.danger, o.friends);
        // A fight that the walk brought on is no reason to leave the gear; a stronger hunter or a stranger is.
        if (risk && risk !== 'combat' && risk !== 'hp') return done(`abort-${risk}`, ` picked=${picked} of=${piles.length}`);
        if ((st?.inventory ?? []).length >= 28) await wearBack(s, d.worn);
        const before = countOf(s.sdk.getState(), g.id);
        for (let k = 0; k < PICKUP_TRIES; k++) {
            if (!(s.sdk.getState()?.groundItems ?? []).some((x: any) => x.id === g.id && x.x === g.x && x.z === g.z)) break;
            await s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'death-recovery' });
            if (await until(s, q2 => countOf(q2, g.id) > before, PICKUP_TICKS)) { picked++; break; }
        }
    }
    const worn = await wearBack(s, d.worn);
    return done(picked === piles.length ? 'ok' : 'partial', ` picked=${picked} of=${piles.length} worn=${worn}`);
}

// The flee guard (randomevents.ts `flee`) starts at this share of the maximum Hitpoints, with no food in the pack.
// An estimate: a 30 Hitpoints account flees at 9, above one hit of most NPCs that a low account fights.
export const FLEE_HP = 0.3;

// ---- death cause ----
// The damage the player took in the last CAUSE_TICKS ticks, by source, from the state's combat events. On a death
// openBot logs `DEATH at=x,z,level wild=N hp=h/max by=<source> taken=<damage> hits=<n> script=<file>`: the source
// that did the most damage, so each death can be fixed by its cause.
export const CAUSE_TICKS = 20;
export type Hit = { tick: number; damage: number; source: string };

// The name of a damage source: an NPC as `name#id`, a player as `player:name`.
export function sourceName(st: any, type: string, index: number): string {
    if (type === 'npc') { const n = (st?.nearbyNpcs ?? []).find((x: any) => x.index === index); return n ? `${String(n.name ?? 'npc').replace(/\s+/g, '_')}#${n.id}` : `npc@${index}`; }
    if (type === 'other_player') { const q = (st?.nearbyPlayers ?? []).find((x: any) => x.index === index); return `player:${q?.name ?? index}`; }
    return type;
}

export function damageLog() {
    const hits: Hit[] = [];
    const seen = new Set<string>();
    return {
        // Reads the new damage_taken events of a tick.
        read(st: any) {
            for (const e of st?.combatEvents ?? []) {
                if (e?.type !== 'damage_taken') continue;
                const key = e.observationId !== undefined ? `o${e.observationId}` : `${e.tick}:${e.sourceType}:${e.sourceIndex}:${e.damage}`;
                if (seen.has(key)) continue;
                seen.add(key);
                hits.push({ tick: e.tick ?? st.tick ?? 0, damage: e.damage ?? 0, source: sourceName(st, e.sourceType, e.sourceIndex) });
            }
            const now = st?.tick ?? 0;
            while (hits.length && now - hits[0]!.tick > CAUSE_TICKS) hits.shift();
            if (seen.size > 500) seen.clear();
        },
        // The death line's cause fields.
        cause(): string {
            const by = new Map<string, number>();
            for (const h of hits) by.set(h.source, (by.get(h.source) ?? 0) + h.damage);
            const top = [...by].sort((a, b) => b[1] - a[1])[0];
            return `by=${top?.[0] ?? 'unknown'} taken=${hits.reduce((n, h) => n + h.damage, 0)} hits=${hits.length}`;
        },
    };
}

export const deathLine = (d: DeathSnapshot | null, hp: string, cause: string, script: string) =>
    `DEATH at=${d ? `${d.at.x},${d.at.z},${d.at.level}` : 'unknown'} wild=${d ? wildernessLevel(d.at.x, d.at.z) : 0} hp=${hp} ${cause} script=${script.split(/[\\/]/).at(-1) ?? script}`;
