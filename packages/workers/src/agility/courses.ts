// Agility course definitions, progressive tier selection, resume positions, and obstacle settlement rules.
import { canonicalCourseName, type AgilityCourseId, type AgilityOptions, type Course, type CourseDefinition } from './types';

export type Pos = { worldX: number; worldZ: number; level: number };

export const COURSES: Record<Course, CourseDefinition> = {
    gnome: {
        start: { x: 2474, z: 3437 },
        steps: [
            { name: 'log', id: 2295, x: 2474, z: 3435 },
            { name: 'net', id: 2285, x: 2473, z: 3425 },
            { name: 'branch', id: 2313, x: 2473, z: 3422 },
            { name: 'rope', id: 2312, x: 2478, z: 3420 },
            { name: 'treedown', id: 2314, x: 2486, z: 3419 },
            { name: 'net2', id: 2286, x: 2485, z: 3426 },
            { name: 'pipe', id: 154, x: 2484, z: 3431 },
        ],
    },
    barbarian: {
        start: { x: 2552, z: 3561 },
        pit: { name: 'pit', id: 1755, x: 2547, z: 9951 },
        steps: [
            { name: 'ropeswing', id: 2282, x: 2551, z: 3550 },
            { name: 'log', id: 2294, x: 2550, z: 3546 },
            { name: 'net', id: 2284, x: 2538, z: 3545 },
            { name: 'ledge', id: 2302, x: 2535, z: 3547 },
            { name: 'ladder', id: 3205, x: 2532, z: 3545, zero: true },
            { name: 'wall1', id: 1948, x: 2536, z: 3553 },
            { name: 'wall2', id: 1948, x: 2539, z: 3553 },
            { name: 'wall3', id: 1948, x: 2542, z: 3553 },
        ],
    },
    wilderness: {
        start: { x: 2998, z: 3916 },
        pit: { name: 'pit', id: 1755, x: 3005, z: 10363 },
        steps: [
            { name: 'pipe', id: 2288, x: 3004, z: 3938 },
            { name: 'ropeswing', id: 2283, x: 3005, z: 3952 },
            { name: 'stones', id: 2311, x: 3001, z: 3960 },
            { name: 'log', id: 2297, x: 3001, z: 3945 },
            { name: 'rocks', id: 2328, x: 2994, z: 3936, zero: true },
        ],
    },
};

export const BRIMHAVEN_ARENA = {
    entry: { x: 2808, z: 3191, level: 0 },
    clerkTile: { x: 2807, z: 3190, level: 0 },
    traderTile: { x: 2811, z: 3192, level: 0 },
    ladderDown: { id: 3617, x: 2809, z: 3194, level: 0 },
    ladderUp: { id: 3618, x: 2805, z: 9590, level: 3 },
    spawnInside: { x: 2805, z: 9590, level: 3 },
    bounds: { x1: 2752, x2: 2815, z1: 9536, z2: 9599 },
    varpId: 309,
    paidBitMask: 2,
    clerkId: 437,
    feeCoins: 200,
    ticketId: 2996,
    climbRopeId: 3610,
    pillarLocIds: [3608, 3581] as readonly number[],
    obstacleMinLevel: new Map<number, number>([
        [3583, 20], // agilityarena_handholds
    ]),
    obstacleIds: new Set([3565, 3570, 3571, 3572, 3553, 3555, 3557, 3551, 3559, 3561, 3564, 3566, 3578, 3583]),
    platformX: [2761, 2772, 2783, 2794, 2805] as readonly number[],
    platformZ: [9546, 9557, 9568, 9579, 9590] as readonly number[],
} as const;

export const SUPPORTED_AGILITY_COURSES = ['gnome', 'barbarian', 'wilderness', 'brimhaven', 'progressive'] as const;

export function progressiveCourseForLevel(
    level: number,
    options: { barcrawl?: number; potion?: boolean } = {},
): Course {
    if (level >= 52 || (options.potion && level >= 49)) return 'wilderness';
    if (level >= 35 && options.barcrawl === 2) return 'barbarian';
    return 'gnome';
}

export function agilityOptions(
    course: string,
    target: string,
    env: Record<string, string | undefined> = process.env,
): AgilityOptions {
    const normalized = canonicalCourseName(course);
    if (normalized === 'ape-atoll') {
        throw Error('ape-atoll agility course is unsupported on this rev-289 server');
    }
    if (!['gnome', 'barbarian', 'wilderness', 'brimhaven', 'progressive'].includes(normalized)) {
        throw Error('unknown agility course');
    }
    const integer = (value: string | undefined, fallback: number, max: number) => {
        const n = Number(value ?? fallback);
        if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error('invalid agility target or budget');
        return n;
    };
    return {
        course: normalized as AgilityCourseId,
        target: integer(target, 0, 99),
        maxLaps: integer(env.AGI_MAX_LAPS, 1000, 100000),
        maxTicks: integer(env.AGI_MAX_TICKS, 10000, 1000000),
        progressTicks: integer(env.AGI_PROGRESS_TICKS, 150, 10000),
        entryTicks: integer(env.AGI_ENTRY_TICKS, 2000, 100000),
        potion: env.AGI_POTION === '1',
    };
}

export function agilityPreflight(o: AgilityOptions, base: number, current: number): string | null {
    if (o.course === 'ape-atoll') return 'ape-atoll agility course is unsupported on this rev-289 server';
    if (!Number.isFinite(base) || base < 1 || !Number.isFinite(current) || current < 1) return 'agility state unknown';
    if (base >= o.target && !o.stopOnMaxLaps) return 'already at target';
    if (o.course === 'barbarian' && (current < 35 || o.barcrawl !== 2)) {
        return 'barbarian requires level 35 and observed completed Barcrawl';
    }
    if (o.course === 'wilderness' && current < 52 && !(o.potion && current >= 49)) {
        return 'wilderness requires entry level 52';
    }
    return null;
}

export function inBrimhavenArena(p: Pos): boolean {
    const b = BRIMHAVEN_ARENA.bounds;
    return p.level === 3 && p.worldX >= b.x1 && p.worldX <= b.x2 && p.worldZ >= b.z1 && p.worldZ <= b.z2;
}

export function inBrimhavenPit(p: Pos): boolean {
    const b = BRIMHAVEN_ARENA.bounds;
    return p.level === 0 && p.worldX >= b.x1 && p.worldX <= b.x2 && p.worldZ >= b.z1 && p.worldZ <= b.z2;
}

export function onCourse(c: Course | 'brimhaven', p: Pos): boolean {
    if (c === 'brimhaven') return inBrimhavenArena(p);
    const [x, z, w, h] = c === 'gnome' ? [2465, 3410, 30, 35] : c === 'barbarian' ? [2528, 3540, 30, 18] : [2988, 3930, 22, 40];
    return p.level >= 0
        && p.level <= (c === 'gnome' ? 2 : c === 'barbarian' ? 1 : 0)
        && p.worldX >= x
        && p.worldX <= x + w
        && p.worldZ >= z
        && p.worldZ <= z + h;
}

// Read the next reachable obstacle from the actual landing tile, including saves after a fall.
// Transient obstacle tiles never count as a completed action; runAgility waits for effects.
export function resumeStep(c: Course, p: Pos): number {
    if (c === 'gnome') {
        if (p.level === 2) return p.worldX < 2483 ? 3 : 4;
        if (p.level === 1) return 2;
        if (p.worldZ >= 3433) return 0;
        if (p.worldZ >= 3427) return p.worldX >= 2480 ? 6 : 1;
        return p.worldX >= 2480 ? 5 : 1;
    }
    if (c === 'barbarian') {
        if (p.level === 1) return p.worldX <= 2533 ? 4 : 3;
        if (p.worldZ >= 3552) {
            if (p.worldX < 2537) return 5;
            if (p.worldX < 2540) return 6;
            if (p.worldX < 2543) return 7;
            return 0;
        }
        if (p.worldX <= 2533) return 5;
        if (p.worldX < 2546) return 2;
        return 1;
    }
    if (p.worldZ <= 3938) return 0;
    if (p.worldX <= 2994 && p.worldZ <= 3946) return 4;
    if (p.worldZ >= 3959) return p.worldX >= 3002 ? 2 : 3;
    if (p.worldZ >= 3955) return 2;
    return 1;
}

export const AGILITY_FOOD_PATTERN = /^(lobster|swordfish|shark|trout|salmon|tuna|shrimp|shrimps|cooked meat|bread|banana|cheese|cake|2\/3 cake|slice of cake)$/i;

// consume.rs2 player_consume_item sets %eat_delay = map_clock + 2 and discards any earlier eat.
export const EAT_DELAY_TICKS = 2;
export function eatReady(lastEffectTick: number, nowTick: number): boolean {
    return nowTick > lastEffectTick + EAT_DELAY_TICKS;
}

export const OBSTACLE_SETTLE = { quietTicks: 6, maxTicks: 40 };

export function wildernessStarted(name: string, p: Pos): boolean {
    if (p.level !== 0) return false;
    switch (name) {
        case 'pipe':
            return p.worldX === 3004 && p.worldZ >= 3940 && p.worldZ <= 3950;
        case 'ropeswing':
            return p.worldX === 3005 && p.worldZ >= 3953 && p.worldZ <= 3958;
        case 'stones':
            return p.worldZ === 3960 && p.worldX >= 2996 && p.worldX <= 3001;
        case 'log':
            return p.worldZ === 3945 && p.worldX >= 2994 && p.worldX <= 3002;
        default:
            return false;
    }
}
