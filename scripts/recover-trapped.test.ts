import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labelAreas, writeLabels, type Labels } from '../packages/core/src/components';
import { pathfindingDataKey } from '../packages/core/src/pathcache';
import { FLUFFS_FENCE } from './quest-sweep';
import { loadRecoveryLocationContext, recoverSessionToHub } from './recover-trapped';

const tempDirs: string[] = [];

function makeTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'recover-trapped-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.practice', 'cache'), { recursive: true });
    return dir;
}

afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function mockLabelsForOffHub(areaIdByTile: (x: number, z: number) => number): Labels {
    return {
        area: (_l, x, z) => areaIdByTile(x, z),
        areas: 4,
        tiles: 10,
        zones: { size: 0, keys: function* () {} },
        cells: new Uint16Array(0),
        zoneKeys: new Int32Array(0),
    };
}

function makeFakeSession(initialPos: { worldX: number; worldZ: number; level: number }) {
    let player = { ...initialPos, lifeId: 1, respawnCount: 0, isDead: false };
    let tick = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const cb of [...listeners]) cb();
    }, 2);
    const fenceLoc = {
        id: FLUFFS_FENCE.id,
        name: 'Fence',
        x: FLUFFS_FENCE.x,
        z: FLUFFS_FENCE.z,
        distance: 1,
        optionsWithIndex: [{ text: 'Squeeze-through', opIndex: 1 }],
    };
    const actions: string[] = [];
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        sdk: {
            getState: () => ({
                player,
                nearbyLocs: player.level === 0 && player.worldZ >= 3493 && player.worldZ <= 3517 ? [fenceLoc] : [],
                nearbyNpcs: [],
            }),
            getDialog: () => ({ isOpen: false, options: [] }),
            sendClickDialog: async () => {},
        },
        bot: {
            skipTutorial: async () => ({ success: true }),
            walkTo: async (x: number, z: number, level = 0) => {
                actions.push(`walkTo:${x},${z},${level}`);
                player = { ...player, worldX: x, worldZ: z, level };
                return { success: true };
            },
            interactLoc: async (loc: any) => {
                actions.push(`interactLoc:${loc.id}@${loc.x},${loc.z}`);
                if (loc.id === FLUFFS_FENCE.id) {
                    player = { ...player, worldX: FLUFFS_FENCE.x, worldZ: FLUFFS_FENCE.z - 1, level: 0 };
                }
                return { success: true };
            },
        },
        setPos(x: number, z: number, level = 0) {
            player = { ...player, worldX: x, worldZ: z, level };
        },
        dispose() {
            clearInterval(timer);
        },
    };
    return { s, actions };
}

describe('recover-trapped off_hub_area and Lumber Yard handling', () => {
    test('recovers off_hub_area positions instead of misclassifying them as mainland hub ok', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub((x, z) => {
            if (x === 3013 && z === 3355) return 21;
            if (x === 3185 && z === 3436) return 21;
            if (x === 2930 && z === 9848) return 2497;
            if (x === 2931 && z === 9853) return 2497;
            if (x === 2933 && z === 3151) return 1610;
            return 21;
        });

        for (const [pos, expectedHub] of [
            [{ worldX: 2930, worldZ: 9848, level: 0 }, '3013,3355,0'],
            [{ worldX: 2931, worldZ: 9853, level: 0 }, '3013,3355,0'],
            [{ worldX: 2933, worldZ: 3151, level: 0 }, '3013,3355,0'],
        ] as const) {
            const { s } = makeFakeSession(pos);
            let walks = 0;
            try {
                const res = await recoverSessionToHub(s, {
                    capTicks: 200,
                    labels,
                    hubAreas,
                    walkToHub: async (_sess, target) => {
                        walks++;
                        s.setPos(target.x, target.z, target.level);
                        return { ok: true };
                    },
                });
                expect(walks).toBe(1);
                expect(res.ok).toBe(true);
                expect(res.kind).toBe('off_hub_area');
                expect(res.to).toBe(expectedHub);
            } finally {
                s.dispose();
            }
        }
    });

    test('exits Lumber Yard via FLUFFS_FENCE (2618) before routing to Varrock West bank', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub((x, z) => (x === 3298 && z === 3513 ? 1463 : 21));
        const { s, actions } = makeFakeSession({ worldX: 3298, worldZ: 3513, level: 0 });
        try {
            let walkStartZ = -1;
            const res = await recoverSessionToHub(s, {
                capTicks: 200,
                labels,
                hubAreas,
                walkToHub: async (_sess, target) => {
                    walkStartZ = s.sdk.getState().player.worldZ;
                    s.setPos(target.x, target.z, target.level);
                    return { ok: true };
                },
            });
            expect(res.ok).toBe(true);
            expect(res.kind).toBe('off_hub_area');
            expect(res.from).toBe('3298,3513,0');
            expect(res.to).toBe('3185,3436,0');
            expect(walkStartZ).toBe(FLUFFS_FENCE.z - 1);
            expect(actions).toEqual([
                `walkTo:${FLUFFS_FENCE.x},${FLUFFS_FENCE.z + 1},0`,
                `interactLoc:${FLUFFS_FENCE.id}@${FLUFFS_FENCE.x},${FLUFFS_FENCE.z}`,
            ]);
        } finally {
            s.dispose();
        }
    });

    test('loads cached route-areas.bin with exact or initializer-shifted compatible source hashes', async () => {
        const dir = makeTempRepo();
        const zones: [number, number, number][] = [
            [0, 3184, 3432],
            [0, 3008, 3352],
            [0, 2616, 3328],
            [0, 2928, 9848],
        ];
        // Link the three bank zones into one connected component and leave (2930,9848) disconnected.
        const built = labelAreas(
            zones,
            (_l, x, z) =>
                (x >= 3184 && x < 3192 && z >= 3432 && z < 3440)
                || (x >= 3008 && x < 3016 && z >= 3352 && z < 3360)
                || (x >= 2616 && x < 2624 && z >= 3328 && z < 3336)
                || (x === 2930 && z === 9848),
            (_l, _x, _z, _dx, _dz) => true,
        );
        // Simulate all 3 banks sharing area 0 via two distinct zones merged in a shared labels table:
        const keyParsed = JSON.parse(pathfindingDataKey()) as Record<string, unknown>;
        const shiftedSource = JSON.stringify({ ...keyParsed, initializer: '0'.repeat(64) });
        const cacheFile = join(dir, '.practice', 'cache', 'route-areas.bin');
        writeLabels(cacheFile, shiftedSource, built);

        const ctx = loadRecoveryLocationContext(dir);
        expect(ctx.labels).toBeDefined();
        expect(ctx.hubAreas?.size).toBeGreaterThan(0);

        const { s } = makeFakeSession({ worldX: 2930, worldZ: 9848, level: 0 });
        let walked = 0;
        try {
            const res = await recoverSessionToHub(s, {
                capTicks: 200,
                rootDir: dir,
                walkToHub: async (_sess, target) => {
                    walked++;
                    s.setPos(target.x, target.z, target.level);
                    return { ok: true };
                },
            });
            expect(walked).toBe(1);
            expect(res.ok).toBe(true);
            expect(res.kind).toBe('off_hub_area');
            expect(res.to).toBe('3013,3355,0');
        } finally {
            s.dispose();
        }

        // Different data hash must be rejected cleanly.
        const badDataSource = JSON.stringify({ ...keyParsed, data: 'f'.repeat(64) });
        writeLabels(cacheFile, badDataSource, built);
        expect(loadRecoveryLocationContext(dir)).toEqual({});
    });

    test('reports failure if route ends still inside an off_hub_area and does not walk healthy or Wilderness tiles', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub((x, z) => (x === 3185 && z === 3436 ? 21 : 1610));

        const stuck = makeFakeSession({ worldX: 2933, worldZ: 3151, level: 0 });
        try {
            const res = await recoverSessionToHub(stuck.s, {
                capTicks: 100,
                labels,
                hubAreas,
                walkToHub: async () => ({ ok: true }),
            });
            expect(res.ok).toBe(false);
            expect(res.kind).toBe('off_hub_area');
            expect(res.detail).toBe('ended still off_hub_area at 2933,3151,0');
        } finally {
            stuck.s.dispose();
        }

        const okHub = makeFakeSession({ worldX: 3185, worldZ: 3436, level: 0 });
        let walks = 0;
        try {
            const res = await recoverSessionToHub(okHub.s, {
                capTicks: 100,
                labels,
                hubAreas,
                walkToHub: async () => {
                    walks++;
                    return { ok: true };
                },
            });
            expect(walks).toBe(0);
            expect(res.ok).toBe(false);
            expect(res.kind).toBe('ok');
        } finally {
            okHub.s.dispose();
        }
    });
});
