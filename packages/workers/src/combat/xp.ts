import type { CombatMode, CombatTile, CombatConfig } from './types';
import { COMBAT_MODE_SET } from './types';

// Level curve matching server/engine/src/engine/entity/Player.ts:77-99 (`2^(L/10) * 300`).
const TABLE: number[] = (() => {
    const t: number[] = [];
    let acc = 0;
    for (let i = 0; i < 99; i++) {
        const level = i + 1;
        acc += Math.floor(level + Math.pow(2.0, level / 10.0) * 300.0);
        t.push((Math.floor(acc / 4) * 10) / 10);
    }
    return t;
})();

export function xpForLevel(level: number): number {
    if (level <= 1) return 0;
    return TABLE[Math.min(level, 99) - 2]!;
}

export function levelForXp(xp: number): number {
    for (let i = 97; i >= 0; i--) {
        if (xp >= TABLE[i]!) return Math.min(i + 2, 99);
    }
    return 1;
}

export function parseCoord(raw: string | undefined, fallback?: CombatTile): CombatTile {
    if (!raw) {
        if (fallback) return { ...fallback };
        throw Error('missing coordinate');
    }
    const parts = raw.split(',').map(v => Number(v.trim()));
    if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n))) {
        throw Error(`invalid coordinate "${raw}"`);
    }
    return {
        x: Math.trunc(parts[0]!),
        z: Math.trunc(parts[1]!),
        level: Math.trunc(parts[2] ?? fallback?.level ?? 0),
    };
}

export function isCombatMode(value: string): value is CombatMode {
    return COMBAT_MODE_SET.has(value);
}

export function combatEnvRecord(cfg: CombatConfig): Record<string, string | undefined> {
    const merged: Record<string, string | undefined> = { ...process.env };
    if (cfg.env) {
        for (const [key, value] of Object.entries(cfg.env)) {
            if (value !== undefined) merged[key] = value;
        }
    }
    if (cfg.args) {
        for (const arg of cfg.args) {
            const idx = arg.indexOf('=');
            if (idx > 0 && /^[A-Z0-9_]+$/.test(arg.slice(0, idx))) {
                merged[arg.slice(0, idx)] = arg.slice(idx + 1);
            }
        }
    }
    if (cfg.targetSkill && !merged.TRAIN_SKILL) merged.TRAIN_SKILL = cfg.targetSkill;
    if (cfg.targetLevel !== undefined && !merged.TARGET_LEVEL) merged.TARGET_LEVEL = String(cfg.targetLevel);
    if (cfg.capTicks !== undefined && !merged.CAP) merged.CAP = String(cfg.capTicks);
    if (cfg.maxKills !== undefined && !merged.MAX_KILLS) merged.MAX_KILLS = String(cfg.maxKills);
    if (cfg.spot && !merged.SPOT) merged.SPOT = cfg.spot;
    if (cfg.bank && !merged.TRAIN_BANK) merged.TRAIN_BANK = cfg.bank;
    return merged;
}

export function positionalCombatArgs(cfg: CombatConfig): string[] {
    return (cfg.args ?? []).filter(a => !/^[A-Z0-9_]+=/.test(a));
}

export function countPackItems(items: ReadonlyArray<{ id: number; count: number }>, ids: ReadonlySet<number> | number): number {
    let total = 0;
    for (const item of items) {
        if (typeof ids === 'number' ? item.id === ids : ids.has(item.id)) {
            total += item.count;
        }
    }
    return total;
}

export function skillLevelOf(
    skills: ReadonlyArray<{ name: string; level?: number; baseLevel?: number; xp?: number }> | undefined,
    name: string,
): number {
    const found = skills?.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!found) return name.toLowerCase() === 'hitpoints' ? 10 : 1;
    if (typeof found.baseLevel === 'number') return found.baseLevel;
    if (typeof found.level === 'number') return found.level;
    return typeof found.xp === 'number' ? levelForXp(found.xp) : 1;
}

export function totalInventoryDelta(
    before: ReadonlyArray<{ id: number; count: number }>,
    after: ReadonlyArray<{ id: number; count: number }>,
): Record<number, number> {
    const counts = new Map<number, number>();
    for (const item of after) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
    for (const item of before) counts.set(item.id, (counts.get(item.id) ?? 0) - item.count);
    const out: Record<number, number> = {};
    for (const [id, delta] of counts) {
        if (delta !== 0) out[id] = delta;
    }
    return out;
}
