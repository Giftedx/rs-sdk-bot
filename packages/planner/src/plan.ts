import { levelForXp, xpForLevel } from './curve';

export interface Method {
    id: string;
    skill: string;
    level: number; // level needed to start it
    xpPerHour: number; // XP per hour of the account's own scored playtime
    source: 'measured' | 'estimated';
}

export interface Segment { method: string; fromLevel: number; toLevel: number; xp: number; hours: number }
export type SkillPlan =
    | { ok: true; segments: Segment[]; hours: number }
    | { ok: false; blockedAt: number; segments: Segment[]; hours: number };

// Fastest plan for one skill with no item costs: at every level use the fastest unlocked method, and
// switch at the level where a faster one unlocks. With rates that only depend on level, this greedy
// choice is optimal (a faster method can only be used from its unlock level onward).
export function planSkill(input: { skill: string; fromXp: number; toLevel: number; methods: Method[] }): SkillPlan {
    const methods = input.methods.filter(m => m.skill === input.skill && m.xpPerHour > 0);
    const target = xpForLevel(input.toLevel);
    const segments: Segment[] = [];
    let xp = input.fromXp;
    let hours = 0;
    while (xp < target) {
        const level = levelForXp(xp);
        const best = methods.filter(m => m.level <= level).sort((a, b) => b.xpPerHour - a.xpPerHour)[0];
        if (!best) return { ok: false, blockedAt: level, segments, hours };
        // Run it until the next level where something faster unlocks, or the target.
        const nextUnlock = methods.filter(m => m.level > level && m.xpPerHour > best.xpPerHour).map(m => m.level).sort((a, b) => a - b)[0];
        const stopXp = Math.min(target, nextUnlock !== undefined ? xpForLevel(nextUnlock) : target);
        const gained = stopXp - xp;
        const h = gained / best.xpPerHour;
        const last = segments[segments.length - 1];
        const toLevel = stopXp === target ? input.toLevel : levelForXp(stopXp);
        if (last && last.method === best.id) { last.toLevel = toLevel; last.xp += gained; last.hours += h; }
        else segments.push({ method: best.id, fromLevel: level, toLevel, xp: gained, hours: h });
        hours += h;
        xp = stopXp;
    }
    return { ok: true, segments, hours };
}
