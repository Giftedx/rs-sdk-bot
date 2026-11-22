// Roster validation, staging shortfall math, basement exit contract, and status helpers for rune carriers.
import { noteStatusLine } from '../../../core/src/status';

export function runeCarrierMeasurePacks(mode: string | undefined): number | undefined {
    if (!mode?.startsWith('--body-measure')) return;
    const match = /^--body-measure=([1-9][0-9]*)$/.exec(mode), n = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(n) || n < 12 || n > 48) throw Error('body measurement requires12..48 full packs');
    return n;
}

export function runeCarrierStaged(mode: string | undefined): { altar: string; target: number } | undefined {
    if (!mode?.startsWith('--staged')) return;
    const match = /^--staged=([a-z]+):([1-9][0-9]?)$/.exec(mode), target = Number(match?.[2]);
    if (!match || target < 2 || target > 99) throw Error('staged carriers need --staged=<altar>:<level 2..99>');
    return { altar: match[1]!, target };
}

export function runeCarrierRoster(args: readonly string[]): string[] {
    const mode = args.at(-1);
    const measure = runeCarrierMeasurePacks(mode), staged = runeCarrierStaged(mode);
    const flag = (a: string) => a === '--carriers' || a === '--body-continuation' || a.startsWith('--body-measure') || a.startsWith('--staged');
    if ((!['--carriers', '--body-continuation'].includes(mode ?? '') && measure === undefined && staged === undefined) || args.filter(flag).length !== 1) {
        throw Error('carrier mode needs the complete roster followed by one mode flag');
    }
    const names = args.slice(0, -1);
    if (names.length < 3 || names.length > 17 || names.some(n => !/^[A-Za-z0-9]{1,12}$/.test(n)) || new Set(names.map(n => n.toLowerCase())).size !== names.length) {
        throw Error('carrier mode needs one crafter and2..16 distinct owned carriers');
    }
    if ((mode === '--body-continuation' || measure !== undefined) && names.length !== 17) {
        throw Error('body continuation requires the retained16 owned helpers');
    }
    return names;
}

export function assertFreshRuneSkills(skills: readonly { name: string; baseLevel: number; experience: number }[] | null | undefined): void {
    if (skills?.length !== 21 || skills.some(s => s.baseLevel !== (s.name === 'Hitpoints' ? 10 : 1) || s.experience !== (s.name === 'Hitpoints' ? 980 : 0))) {
        throw Error('carrier fresh route requires the original fresh skills');
    }
}

export function assertRuneDonor(
    player: { worldX: number; worldZ: number; level: number } | null | undefined,
    inventory: readonly { id: number; count: number }[],
): void {
    const count = (id: number) => inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    if (
        !player
        || player.level !== 0
        || Math.max(Math.abs(player.worldX - 3222), Math.abs(player.worldZ - 3222)) > 1
        || count(1436) !== 27
        || count(1438) !== 1
        || inventory.some(i => i.id !== 1436 && i.id !== 1438)
    ) {
        throw Error('opening donor needs27 essence and an air talisman beside the tutorial exit');
    }
}

// Cross to the west while south of the aggressive jail guards near 3107,3242.
export function runeStageBankApproach(p: { worldX: number; worldZ: number; level: number }) {
    return p.level === 0 && p.worldX >= 3080 && p.worldZ >= 3160 && p.worldZ < 3220
        ? [{ x: 3097, z: 3225 }, { x: 3097, z: 3247 }]
        : [];
}

export function runeStageRequirement(purpose: string | undefined, shortfalls: readonly { essence: number; talismans: number }[]) {
    if (purpose !== undefined && purpose !== 'fresh' && purpose !== 'existing-cohort') {
        throw Error('RUNE_STAGE_PURPOSE must be fresh or existing-cohort');
    }
    const fresh = purpose !== 'existing-cohort';
    return {
        essence: (fresh ? 432 : 0) + shortfalls.reduce((n, s) => n + s.essence, 0),
        talismans: (fresh ? 2 : 0) + shortfalls.reduce((n, s) => n + s.talismans, 0),
        airTalismans: fresh ? 1 : 0,
    };
}

export async function exitRuneTower(
    io: {
        waitForLanding: () => Promise<boolean>;
        openDoor: (label: string, x: number, z: number) => Promise<void>;
        dash: (label: string, x: number, z: number, tol: number) => Promise<void>;
    },
    label = 'tower exit',
): Promise<void> {
    if (!await io.waitForLanding()) throw Error('Rune Mysteries prerequisite: tower landing objects unobserved');
    await io.openDoor(`${label} inner door`, 3107, 3162);
    await io.dash(`${label} hall`, 3108, 3164, 1);
    await io.openDoor(`${label} north door`, 3109, 3166);
    await io.dash(`${label} outside`, 3109, 3167, 0);
}

export async function exitRuneStageBasement(io: {
    position: () => { worldX: number; worldZ: number; level: number };
    openDoor: (label: string, x: number, z: number) => Promise<void>;
    dash: (label: string, x: number, z: number, tol: number) => Promise<void>;
    climb: () => Promise<void>;
    waitForLanding: () => Promise<boolean>;
}): Promise<void> {
    const p = io.position();
    if (p.worldZ < 9000) return;
    if (p.level !== 0 || p.worldX < 3100 || p.worldX > 3120 || p.worldZ < 9550 || p.worldZ > 9580) {
        throw Error('Rune staging basement entry unsupported');
    }
    if (p.worldX >= 3111 && p.worldZ <= 9559) {
        await io.openDoor('skull room exit', 3111, 9559);
        await io.dash('skull room corridor', 3110, 9559, 0);
    }
    await io.dash('basement door approach', 3109, 9570, 0);
    await io.openDoor('basement door exit', 3108, 9570);
    await io.dash('upward ladder approach', 3104, 9576, 0);
    await io.climb();
    const landed = io.position();
    if (landed.worldX !== 3105 || landed.worldZ !== 3162 || landed.level !== 0) {
        throw Error('Rune staging upward ladder landing unobserved');
    }
    await exitRuneTower(io, 'Rune staging tower exit');
}

export function runeStageRoster(args: readonly string[]) {
    const flag = args.at(-1), mode = flag === '--rune-carriers' ? 'carriers' : flag === '--rune-opening' ? 'opening' : null, names = args.slice(0, -1);
    if (
        !mode
        || names.length < (mode === 'carriers' ? 2 : 1)
        || names.length > (mode === 'carriers' ? 5 : 1)
        || names.some(n => !/^[A-Za-z0-9]{1,12}$/.test(n) || /^(?:main|haggis)$/i.test(n))
        || new Set(names.map(n => n.toLowerCase())).size !== names.length
    ) {
        throw Error('Rune staging requires one supplier and1..4 carriers, or one opening donor');
    }
    return { mode, names } as { mode: 'carriers' | 'opening'; names: string[] };
}

export function runeCarrierShortfall(items: readonly { id: number; count: number }[]) {
    if (!Array.isArray(items) || items.some(i => !Number.isSafeInteger(i.id) || i.id < 0 || !Number.isSafeInteger(i.count) || i.count < 0)) {
        throw Error('Rune staging bank stock unobserved');
    }
    const count = (id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    return { essence: Math.max(0, 405 - count(1436)), talismans: Math.max(0, 1 - count(1446)) };
}

export async function runeStageAuthenticate<T extends { name: string }>(
    name: string,
    open: () => Promise<T>,
    owned: () => ReadonlySet<string>,
): Promise<T> {
    const session = await open();
    if (session.name.toLowerCase() !== name.toLowerCase() || !owned().has(name.toLowerCase())) {
        throw Error('Rune staging needs authenticated owned participants');
    }
    return session;
}

export function runeStageStatus(names: readonly string[]) {
    for (const name of names) noteStatusLine(name, 'MILESTONE finite Rune carrier staging');
    return (name: string, line: string) => {
        noteStatusLine(name, line);
        console.log(line);
    };
}
