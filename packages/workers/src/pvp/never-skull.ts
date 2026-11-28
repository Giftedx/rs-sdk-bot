// Strict retaliatory-only PvP skull guard matching rev-289 pk_skull.rs2 deserves_pk_skull:
// an attacker avoids a PK skull ONLY when:
//   .%pk_prey1 = uid | .%pk_prey2 = uid | %pk_predator1 = .uid | %pk_predator2 = .uid | %pk_predator3 = .uid
// Both FIFOs are tracked explicitly:
// - Per-bot 3-slot `predators` FIFO (last 3 incoming attacks on THIS account)
// - Observed per-enemy 2-slot `prey` FIFO (last 2 players each enemy was seen attacking)
// True incoming-attack proof is required before approving retaliation:
// - Either a verified combat attack animation (`isCombatAttackAnim`, rejecting eat/drink/block/tele)
//   starting on frame 0 / cycle 0 while facing THIS account (`faceEntity === 32768 + selfSlot`), OR
// - A corroborated `damage_taken` combat event from a visible non-ally player not facing another player.
// `combatTargetIndex === selfSlot` alone is NEVER trusted because StateCollector sets it whenever an
// enemy has any active HP bar and faces us (e.g. approaching from range or Follow/Trade before ~set_pk_vars runs).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePack } from '../../../knowledge/src/pack';
import { contentRoot } from '../../../knowledge/src/paths';

export const PREDATOR_SLOTS = 3;
export const PREY_SLOTS = 2;
export const DEFAULT_PROVOCATION_TTL_TICKS = 600;

export type ProvocationProof = 'hit' | 'anim';

export interface ProvocationRecord {
    readonly name: string;
    readonly index: number | null;
    readonly firstTick: number;
    readonly lastTick: number;
    readonly lastProof: ProvocationProof;
}

let cachedSeqNames: Map<number, string> | undefined;
let cachedCombatSeqNames: Set<string> | undefined;

function seqNameIsAttack(name: string | undefined): boolean {
    if (!name || !name.startsWith('human_')) return false;
    if (/(block|def|walk|run|ready|stand|idle|turn|death|heal|trap|emote|eat|drink|tele|alch|enchant|superheat|bones|charge)/.test(name)) return false;
    if (/^human_cast(?:strike|wave|entangle|ibanblast|zap|confuse|weaken|curse|enfeeble|stun)(?:_staff)?$/.test(name)) return true;
    if (/^human_(bow|xbow|crossbow|dart|knife|javelin|thrownaxe|chinchompa|throw|spear_throw)/.test(name)) return true;
    if (/^human_(stab|slash|blunt|spear|sword|dagger|scim|whip|axe|mace|unarmed|hack|lunge|attack|claw|halberd|battleaxe|warhammer|pickaxe|2h)/.test(name)) return true;
    return false;
}

function loadCombatSeqNames(root = contentRoot()): Set<string> {
    if (cachedCombatSeqNames) return cachedCombatSeqNames;
    const set = new Set<string>();
    try {
        const configs = join(root, 'scripts/skill_combat/configs');
        for (const file of readdirSync(configs, { recursive: true }) as string[]) {
            if (!file.endsWith('.obj')) continue;
            for (const m of readFileSync(join(configs, file), 'utf8').matchAll(/^param=(?:stab|slash|crush)attack_anim,(\w+)/gm)) {
                set.add(m[1]!);
            }
        }
        const specDir = join(root, 'scripts/skill_combat/scripts/pvp/specs/scripts');
        for (const file of readdirSync(specDir)) {
            if (!file.endsWith('.rs2')) continue;
            for (const m of readFileSync(join(specDir, file), 'utf8').matchAll(/^\s*anim\((?!%)(\w+),/gm)) {
                set.add(m[1]!);
            }
        }
    } catch { /* fallback to seq-name heuristics */ }
    cachedCombatSeqNames = set;
    return set;
}

/**
 * Returns true ONLY for verified rev-289 PvP combat attack animations (melee, ranged, magic, specials).
 * Rejects eat/drink (829), teleport (714), block/defend, walk, idle, and emotes so non-combat animations
 * can never trigger false provocation under NEVER_SKULL=1.
 */
export function isCombatAttackAnim(anim: number): boolean {
    if (!Number.isInteger(anim) || anim < 0) return false;
    if (!cachedSeqNames) {
        try {
            cachedSeqNames = parsePack(readFileSync(join(contentRoot(), 'pack/seq.pack'), 'utf8'));
        } catch {
            cachedSeqNames = new Map();
        }
    }
    const name = cachedSeqNames.get(anim);
    if (!name) return false;
    return loadCombatSeqNames().has(name) || seqNameIsAttack(name);
}

/** Parses NEVER_SKULL (0 or 1), defaulting to `defaultOn` when unset or empty. */
export function neverSkullOf(
    get: (name: string, fallback: string) => string,
    defaultOn = false,
): boolean {
    const raw = get('NEVER_SKULL', defaultOn ? '1' : '0');
    if (raw !== '0' && raw !== '1') {
        throw new Error(`NEVER_SKULL must be 0 or 1, got ${raw}`);
    }
    return raw === '1';
}

const SELF_PREY_KEY = '__self__';

/**
 * Per-account tracker of players who have provably attacked THIS specific account.
 * Mirrors `pk_skull.rs2` (`%pk_predator1..3` on self AND `.%pk_prey1..2` on each enemy) so
 * retaliating against any approved player never applies a PK skull, even in 24-vs-49 multi-way fights.
 */
export function createNeverSkullGuard(opts: { forgetTicks?: number; selfName?: string } = {}) {
    const forgetTicks = opts.forgetTicks ?? DEFAULT_PROVOCATION_TTL_TICKS;
    const selfKey = opts.selfName ? opts.selfName.trim().toLowerCase() : SELF_PREY_KEY;
    // Exact 3-slot incoming attacker history (most recent at index 0), deduplicated within a single tick
    // so multiple observations of the same attack tick do not evict earlier predators.
    const predatorSlots: { key: string; tick: number }[] = [];
    // Observed per-enemy 2-slot prey history (most recent target at index 0).
    const enemyPreySlots = new Map<string, { target: string; tick: number }[]>();
    const records = new Map<string, ProvocationRecord>();

    const pushEnemyPrey = (attackerKey: string, victimKey: string, tick: number): void => {
        if (!attackerKey || !victimKey) return;
        let slots = enemyPreySlots.get(attackerKey);
        if (!slots) {
            slots = [];
            enemyPreySlots.set(attackerKey, slots);
        }
        if (slots[0]?.target === victimKey && slots[0].tick === tick) return;
        slots.unshift({ target: victimKey, tick });
        if (slots.length > PREY_SLOTS) slots.length = PREY_SLOTS;
    };

    const pruneExpired = (now: number) => {
        for (let i = predatorSlots.length - 1; i >= 0; i--) {
            if (now - predatorSlots[i]!.tick > forgetTicks) {
                predatorSlots.splice(i, 1);
            }
        }
        for (const [key, slots] of enemyPreySlots) {
            for (let i = slots.length - 1; i >= 0; i--) {
                if (now - slots[i]!.tick > forgetTicks) slots.splice(i, 1);
            }
            if (slots.length === 0) enemyPreySlots.delete(key);
        }
        for (const [key, rec] of records) {
            if (now - rec.lastTick > forgetTicks) {
                records.delete(key);
            }
        }
    };

    const recordIncomingAttack = (
        attackerName: string,
        attackerIndex: number | null,
        tick: number,
        proof: ProvocationProof,
    ): void => {
        const key = attackerName.trim().toLowerCase();
        if (!key) return;
        const prev = records.get(key);
        records.set(key, {
            name: key,
            index: attackerIndex ?? prev?.index ?? null,
            firstTick: prev ? prev.firstTick : tick,
            lastTick: Math.max(prev?.lastTick ?? tick, tick),
            lastProof: proof,
        });
        // Attacking us sets BOTH our %pk_predator1 AND the attacker's %pk_prey1.
        pushEnemyPrey(key, selfKey, tick);
        // Avoid double-shifting within the exact same tick for the same attacker.
        if (predatorSlots[0]?.key === key && predatorSlots[0].tick === tick) {
            return;
        }
        // Mirror pk_skull.rs2 set_pk_vars: predator3 = predator2; predator2 = predator1; predator1 = attacker.
        predatorSlots.unshift({ key, tick });
        if (predatorSlots.length > PREDATOR_SLOTS) {
            predatorSlots.length = PREDATOR_SLOTS;
        }
    };

    /** Records an observed attack by `attackerName` onto another player `victimName` (advances attacker's 2-slot `%pk_prey1..2` FIFO). */
    const recordEnemyAttackOn = (
        attackerName: string,
        victimName: string,
        tick: number,
    ): void => {
        const aKey = attackerName.trim().toLowerCase();
        const vKey = victimName.trim().toLowerCase();
        if (!aKey || !vKey) return;
        pushEnemyPrey(aKey, vKey === selfKey ? selfKey : vKey, tick);
    };

    const recordDeath = (playerName: string): void => {
        const key = playerName.trim().toLowerCase();
        if (!key) return;
        records.delete(key);
        enemyPreySlots.delete(key);
        for (let i = predatorSlots.length - 1; i >= 0; i--) {
            if (predatorSlots[i]!.key === key) {
                predatorSlots.splice(i, 1);
            }
        }
    };

    const resetOnOwnDeath = (): void => {
        predatorSlots.length = 0;
        enemyPreySlots.clear();
        records.clear();
    };

    const canAttackSafely = (
        targetName: string,
        now?: number,
    ): boolean => {
        const key = targetName.trim().toLowerCase();
        if (!key) return false;
        if (now !== undefined) pruneExpired(now);
        const rec = records.get(key);
        if (!rec) return false;
        if (now !== undefined && now - rec.lastTick > forgetTicks) return false;
        const inMyPredators = predatorSlots.some(slot => slot.key === key);
        const inTheirPrey = (enemyPreySlots.get(key) ?? []).some(slot => slot.target === selfKey);
        return inMyPredators || inTheirPrey;
    };

    const blockedNames = (names: Iterable<string>, now?: number): string[] => {
        if (now !== undefined) pruneExpired(now);
        const out: string[] = [];
        for (const name of names) {
            const key = name.trim().toLowerCase();
            if (key && !canAttackSafely(key, now)) out.push(key);
        }
        return out;
    };

    const filterSafeTargets = <P extends { name: string }>(
        players: readonly P[],
        now?: number,
    ): P[] => {
        if (now !== undefined) pruneExpired(now);
        return players.filter(p => canAttackSafely(p.name, now));
    };

    return {
        recordIncomingAttack,
        recordEnemyAttackOn,
        recordDeath,
        resetOnOwnDeath,
        canAttackSafely,
        blockedNames,
        filterSafeTargets,
        snapshot: () => ({
            predators: predatorSlots.map(s => s.key),
            enemyPrey: Object.fromEntries([...enemyPreySlots.entries()].map(([k, v]) => [k, v.map(s => s.target)])),
            records: [...records.values()],
        }),
    };
}

export type NeverSkullGuard = ReturnType<typeof createNeverSkullGuard>;

export interface ObserveProvocationInput {
    readonly guard: NeverSkullGuard;
    readonly now: number;
    readonly selfSlot: number;
    readonly allies?: ReadonlySet<string>;
    readonly nearbyPlayers: readonly {
        readonly name: string;
        readonly index: number;
        readonly inCombat?: boolean;
        readonly combatTargetType?: string;
        readonly combatTargetIndex?: number;
    }[];
    readonly combatEvents?: readonly {
        readonly observationId?: number;
        readonly tick: number;
        readonly type: string;
        readonly sourceType?: string;
        readonly targetType?: string;
        readonly sourceIndex?: number;
    }[];
    readonly seenEventId: number;
    readonly minTick?: number;
    readonly clientPlayers?: readonly ({
        readonly faceEntity?: number;
        readonly primaryAnim?: number;
        readonly primaryAnimCycle?: number;
        readonly primaryAnimFrame?: number;
    } | null)[] | undefined;
    /** Defaults to `isCombatAttackAnim` (rev-289 seq.pack + combat configs). */
    readonly isAttackAnim?: (animId: number) => boolean;
}

/**
 * Inspects one tick's combat events and client entity animations, recording ONLY provable incoming
 * attacks on THIS account into `guard` and advancing enemies' observed 2-slot `%pk_prey1..2` FIFOs
 * when they attack other players.
 * Never approves retaliation from `combatTargetIndex === selfSlot` alone (StateCollector.ts:1027-1042).
 * Returns the updated highest seen `combatEvent` observationId.
 */
export function observeProvocations(input: ObserveProvocationInput): number {
    const {
        guard,
        now,
        selfSlot,
        allies,
        nearbyPlayers,
        combatEvents,
        minTick = 0,
        clientPlayers,
        isAttackAnim = isCombatAttackAnim,
    } = input;
    let maxEventId = input.seenEventId;
    const byIndex = new Map<number, (typeof nearbyPlayers)[number]>();
    for (let i = 0; i < nearbyPlayers.length; i++) {
        byIndex.set(nearbyPlayers[i]!.index, nearbyPlayers[i]!);
    }
    for (let i = 0; i < nearbyPlayers.length; i++) {
        const p = nearbyPlayers[i]!;
        const key = p.name.toLowerCase();
        if (allies?.has(key)) continue;

        // 1. Verified combat attack animation starting (frame 0, cycle 0) while facing a player.
        // Covers 0-damage hits & splashes without false-triggering on eat/drink/block/walk/approach.
        let sawAnim = false;
        if (clientPlayers) {
            const ent = clientPlayers[p.index];
            if (
                ent
                && typeof ent.faceEntity === 'number'
                && ent.faceEntity >= 32768
                && typeof ent.primaryAnim === 'number'
                && ent.primaryAnim >= 0
                && (ent.primaryAnimCycle ?? 0) === 0
                && (ent.primaryAnimFrame ?? 0) === 0
                && isAttackAnim(ent.primaryAnim)
            ) {
                sawAnim = true;
                const targetIdx = ent.faceEntity - 32768;
                if (selfSlot >= 0 && targetIdx === selfSlot) {
                    guard.recordIncomingAttack(p.name, p.index, now, 'anim');
                } else {
                    const victim = byIndex.get(targetIdx);
                    guard.recordEnemyAttackOn(p.name, victim ? victim.name : `idx:${targetIdx}`, now);
                }
            }
        }

        // 2. Conservative eviction only: if an enemy targets a DIFFERENT player (never self!), advance their
        // 2-slot prey FIFO so stale self-entries are evicted conservatively. Never approve retaliation from
        // `combatTargetIndex === selfSlot` alone (StateCollector sets it on HP bar + face before ~set_pk_vars runs).
        if (!sawAnim && p.combatTargetType === 'player' && typeof p.combatTargetIndex === 'number' && p.combatTargetIndex >= 0) {
            if (selfSlot < 0 || p.combatTargetIndex !== selfSlot) {
                const victim = byIndex.get(p.combatTargetIndex);
                guard.recordEnemyAttackOn(p.name, victim ? victim.name : `idx:${p.combatTargetIndex}`, now);
            }
        }
    }

    // 3. Corroborated incoming player damage_taken events (when sourceIndex matches a visible non-ally player).
    if (combatEvents?.length) {
        for (let i = 0; i < combatEvents.length; i++) {
            const e = combatEvents[i]!;
            const id = e.observationId ?? e.tick;
            if (id <= input.seenEventId || e.tick < minTick) continue;
            if (id > maxEventId) maxEventId = id;
            if (
                e.type === 'damage_taken'
                && e.sourceType === 'other_player'
                && (e.targetType === undefined || e.targetType === 'player')
                && typeof e.sourceIndex === 'number'
                && e.sourceIndex >= 0
            ) {
                const src = byIndex.get(e.sourceIndex);
                if (src && !allies?.has(src.name.toLowerCase())) {
                    // When clientPlayers is available, reject StateCollector face-guess splats attributed
                    // to a player facing someone else.
                    const ent = clientPlayers?.[src.index];
                    const facingOther = selfSlot >= 0 && ent && typeof ent.faceEntity === 'number' && ent.faceEntity >= 32768 && ent.faceEntity !== 32768 + selfSlot;
                    if (!facingOther) {
                        guard.recordIncomingAttack(src.name, src.index, now, 'hit');
                    }
                }
            }
        }
    }
    return maxEventId;
}

/** Resolves the local player's entity slot index from an in-process client, or -1 if unavailable. */
export function localPlayerSlot(client: unknown): number {
    const c = client as { localPlayer?: unknown; players?: unknown[]; selfSlot?: number } | undefined;
    if (typeof c?.selfSlot === 'number' && Number.isSafeInteger(c.selfSlot) && c.selfSlot >= 0) {
        return c.selfSlot;
    }
    if (c?.players && c.localPlayer) {
        return c.players.indexOf(c.localPlayer);
    }
    return -1;
}
