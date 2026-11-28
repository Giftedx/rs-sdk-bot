// Headless LiteClient memory slimming via synchronous Bun.plugin transforms and post-unpack fallback trims.
// Keeps vendor/rs-sdk untouched while eliminating unused 3D rendering scratch tables, eager LruCache HashTables,
// async Bun.file threadpool wakeups, unused config tables, IfType rope strings, and per-bot array duplication.
import { plugin } from 'bun';
import { readFileSync } from 'node:fs';
import { vendor } from './transport';

const trimmedIfLists = new WeakSet<object>();
let slimPluginInstalled = false;

function replaceOrKeep(src: string, pairs: readonly [string, string][]): string {
    let out = src;
    for (const [needle, repl] of pairs) {
        if (!out.includes(needle)) return src;
        out = out.replace(needle, repl);
    }
    return out;
}

export function slimLruCacheSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '    readonly table: HashTable<T> = new HashTable(1024);',
            '    table: HashTable<T> | null = null;',
        ],
        [
            '    find(key: bigint): T | null {\n        const node = this.table.find(key);',
            '    find(key: bigint): T | null {\n        if (!this.table) return null;\n        const node = this.table.find(key);',
        ],
        [
            '        this.table.put(node, key);',
            '        (this.table ??= new HashTable(1024)).put(node, key);',
        ],
        [
            '    clear(): void {\n        while (true) {',
            '    clear(): void {\n        if (!this.table) return;\n        while (true) {',
        ],
    ]);
}

export function slimModelSource(src: string): string {
    return replaceOrKeep(src, [
        ['    static tmpVertexX: Int32Array = new Int32Array(2000);', '    static tmpVertexX: Int32Array = new Int32Array(0);'],
        ['    static tmpVertexY: Int32Array = new Int32Array(2000);', '    static tmpVertexY: Int32Array = new Int32Array(0);'],
        ['    static tmpVertexZ: Int32Array = new Int32Array(2000);', '    static tmpVertexZ: Int32Array = new Int32Array(0);'],
        ['    static tempFTran: Int32Array = new Int32Array(2000);', '    static tempFTran: Int32Array = new Int32Array(0);'],
        ['    static faceClippedX: boolean[] = new TypedArray1d(4096, false);', '    static faceClippedX: boolean[] = [];'],
        ['    static faceNearClipped: boolean[] = new TypedArray1d(4096, false);', '    static faceNearClipped: boolean[] = [];'],
        ['    static vertexScreenX: Int32Array = new Int32Array(4096);', '    static vertexScreenX: Int32Array = new Int32Array(0);'],
        ['    static vertexScreenY: Int32Array = new Int32Array(4096);', '    static vertexScreenY: Int32Array = new Int32Array(0);'],
        ['    static vertexScreenZ: Int32Array = new Int32Array(4096);', '    static vertexScreenZ: Int32Array = new Int32Array(0);'],
        ['    static vertexViewSpaceX: Int32Array = new Int32Array(4096);', '    static vertexViewSpaceX: Int32Array = new Int32Array(0);'],
        ['    static vertexViewSpaceY: Int32Array = new Int32Array(4096);', '    static vertexViewSpaceY: Int32Array = new Int32Array(0);'],
        ['    static vertexViewSpaceZ: Int32Array = new Int32Array(4096);', '    static vertexViewSpaceZ: Int32Array = new Int32Array(0);'],
        ['    static tmpDepthFaceCount: Int32Array = new Int32Array(1500);', '    static tmpDepthFaceCount: Int32Array = new Int32Array(0);'],
        ['    static tmpDepthFaces: Int32Array[] = new Int32Array2d(1500, 512);', '    static tmpDepthFaces: Int32Array[] = [];'],
        ['    static tmpPriorityFaceCount: Int32Array = new Int32Array(12);', '    static tmpPriorityFaceCount: Int32Array = new Int32Array(0);'],
        ['    static tmpPriorityFaces: Int32Array[] = new Int32Array2d(12, 2000);', '    static tmpPriorityFaces: Int32Array[] = [];'],
        ['    static tmpPriority10FaceDepth: Int32Array = new Int32Array(2000);', '    static tmpPriority10FaceDepth: Int32Array = new Int32Array(0);'],
        ['    static tmpPriority11FaceDepth: Int32Array = new Int32Array(2000);', '    static tmpPriority11FaceDepth: Int32Array = new Int32Array(0);'],
        ['    static tmpPriorityDepthSum: Int32Array = new Int32Array(12);', '    static tmpPriorityDepthSum: Int32Array = new Int32Array(0);'],
    ]);
}

export function slimPix3dSource(src: string): string {
    return replaceOrKeep(src, [
        ['    static divTable: Int32Array = new Int32Array(512);', '    static divTable: Int32Array = new Int32Array(0);'],
        ['    static divTable2: Int32Array = new Int32Array(2048);', '    static divTable2: Int32Array = new Int32Array(0);'],
        ['    static sinTable: Int32Array = new Int32Array(2048);', '    static sinTable: Int32Array = new Int32Array(0);'],
        ['    static cosTable: Int32Array = new Int32Array(2048);', '    static cosTable: Int32Array = new Int32Array(0);'],
        ['    static colourTable: Int32Array = new Int32Array(65536);', '    static colourTable: Int32Array = new Int32Array(0);'],
        [
            '    static {\n        for (let i: number = 1; i < 512; i++) {',
            '    static {\n        for (let i: number = 1; i < this.divTable.length; i++) {',
        ],
        [
            '        for (let i: number = 1; i < 2048; i++) {',
            '        for (let i: number = 1; i < this.divTable2.length; i++) {',
        ],
        [
            '        for (let i: number = 0; i < 2048; i++) {',
            '        for (let i: number = 0; i < this.sinTable.length; i++) {',
        ],
    ]);
}

export function slimCacheSource(src: string): string {
    return replaceOrKeep(src, [
        [
            "import { mkdir } from 'node:fs/promises';",
            "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        ],
        ['    FloType.init(config);', '    // headless: FloType unused'],
        ['    IdkType.init(config);', '    // headless: IdkType unused'],
        ['    VarpType.init(config);', '    // headless: VarpType unused'],
        [
            '    const cached = Bun.file(path);\n    if (await cached.exists()) {\n        const data = new Uint8Array(await cached.arrayBuffer());',
            '    if (existsSync(path)) {\n        const buf = readFileSync(path);\n        const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);',
        ],
        [
            '    await mkdir(dirname(path), { recursive: true });\n    await Bun.write(path, data);',
            '    mkdirSync(dirname(path), { recursive: true });\n    writeFileSync(path, data);',
        ],
    ]);
}

export function slimIfTypeSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '        this.spriteCache = new LruCache(50000);',
            '        this.spriteCache = null;\n        const internMap = new Map<string, string>();\n        const internStr = (s: string): string => { if (s.length === 0) return ""; let hit = internMap.get(s); if (hit === undefined) { internMap.set(s, s); hit = s; } return hit; };',
        ],
        [
            '                com.children = new Array(childCount);\n                com.childX = new Array(childCount);\n                com.childY = new Array(childCount);\n\n                for (let i: number = 0; i < childCount; i++) {\n                    com.children[i] = data.g2();\n                    com.childX[i] = data.g2b();\n                    com.childY[i] = data.g2b();\n                }',
            '                com.children = new Array(childCount);\n                for (let i: number = 0; i < childCount; i++) {\n                    com.children[i] = data.g2();\n                    data.pos += 4;\n                }',
        ],
        [
            '                com.invBackgroundX = new Int16Array(20);\n                com.invBackgroundY = new Int16Array(20);\n                com.invBackground = new TypedArray1d(20, null);\n\n                for (let i: number = 0; i < 20; i++) {\n                    if (data.g1() === 1) {\n                        com.invBackgroundX[i] = data.g2b();\n                        com.invBackgroundY[i] = data.g2b();\n\n                        const graphic: string = data.gjstr();\n                        if (media && graphic.length > 0) {\n                            const spriteIndex: number = graphic.lastIndexOf(\',\');\n                            com.invBackground[i] = this.getSprite(media, graphic.substring(0, spriteIndex), parseInt(graphic.substring(spriteIndex + 1)));\n                        }\n                    }\n                }',
            '                for (let i: number = 0; i < 20; i++) {\n                    if (data.g1() === 1) {\n                        data.pos += 4;\n                        data.gjstr();\n                    }\n                }',
        ],
        [
            '                for (let i: number = 0; i < 5; i++) {\n                    com.iop[i] = data.gjstr();\n                    if (com.iop[i]!.length === 0) {\n                        com.iop[i] = null;\n                    }\n                }',
            '                for (let i: number = 0; i < 5; i++) {\n                    const op = data.gjstr();\n                    com.iop[i] = op.length === 0 ? null : internStr(op);\n                }',
        ],
        [
            '            if (com.type === ComponentType.TYPE_TEXT) {\n                com.text = data.gjstr();\n                com.text2 = data.gjstr();\n            }',
            '            if (com.type === ComponentType.TYPE_TEXT) {\n                com.text = internStr(data.gjstr());\n                data.gjstr();\n            }',
        ],
        [
            '            if (com.buttonType === ButtonType.BUTTON_TARGET || com.type === ComponentType.TYPE_INV) {\n                com.targetVerb = data.gjstr();\n                com.targetBase = data.gjstr();\n                com.targetMask = data.g2();\n            }',
            '            if (com.buttonType === ButtonType.BUTTON_TARGET || com.type === ComponentType.TYPE_INV) {\n                data.gjstr();\n                data.gjstr();\n                com.targetMask = data.g2();\n            }',
        ],
        [
            '                com.buttonText = data.gjstr();',
            '                com.buttonText = internStr(data.gjstr());',
        ],
        [
            '        this.spriteCache = null;\n    }',
            '        internMap.clear();\n        this.spriteCache = null;\n    }',
        ],
    ]);
}

export function slimSeqTypeSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '                this.frames = new Int16Array(this.numFrames);\n                this.iframes = new Int16Array(this.numFrames);\n                this.delay = new Int16Array(this.numFrames);\n\n                for (let i: number = 0; i < this.numFrames; i++) {\n                    this.frames[i] = dat.g2();\n\n                    this.iframes[i] = dat.g2();\n                    if (this.iframes[i] === 65535) {\n                        this.iframes[i] = -1;\n                    }\n\n                    this.delay[i] = dat.g2();\n                }',
            '                this.frames = new Int16Array(this.numFrames);\n                this.delay = new Int16Array(this.numFrames);\n\n                for (let i: number = 0; i < this.numFrames; i++) {\n                    this.frames[i] = dat.g2();\n                    dat.pos += 2;\n                    this.delay[i] = dat.g2();\n                }',
        ],
        [
            '            this.iframes = new Int16Array(1);\n            this.iframes[0] = -1;',
            '            this.iframes = null;',
        ],
        [
            '        if (this.preanim_move === -1) {',
            '        const hadWalkmerge = this.walkmerge !== null;\n        this.walkmerge = null;\n        if (this.preanim_move === -1) {',
        ],
        [
            '            if (this.walkmerge === null) {',
            '            if (!hadWalkmerge) {',
        ],
    ]);
}

export function slimSpotTypeSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '    recol_s: Uint16Array = new Uint16Array(6);\n    recol_d: Uint16Array = new Uint16Array(6);',
            '    recol_s: Uint16Array | null = null;\n    recol_d: Uint16Array | null = null;',
        ],
        [
            '            } else if (code >= 40 && code < 50) {\n                this.recol_s[code - 40] = dat.g2();\n            } else if (code >= 50 && code < 60) {\n                this.recol_d[code - 50] = dat.g2();',
            '            } else if (code >= 40 && code < 50) {\n                dat.pos += 2;\n            } else if (code >= 50 && code < 60) {\n                dat.pos += 2;',
        ],
    ]);
}

export function slimInterfacesSource(src: string): string {
    if (!src.includes('this.list = base.slice();') || !src.includes('export function captureBaseInterfaces()')) {
        return src;
    }
    return `import IfType from '#/config/IfType.js';

let base: IfType[] | null = null;
let activeList: IfType[] | null = null;
let activeTable: InterfaceTable | null = null;

export function captureBaseInterfaces(): void {
    if (!base) {
        base = IfType.list;
        activeList = base.slice();
        activeTable = null;
        IfType.list = activeList;
    }
}

export function resetBaseInterfaces(): void {
    base = null;
    activeList = null;
    activeTable = null;
}

export class InterfaceTable {
    private readonly overrides = new Map<number, IfType>();

    constructor() {
        if (!base || !activeList) {
            throw new Error('lite: InterfaceTable created before the interface archive was loaded (call loadCache first)');
        }
    }

    get list(): IfType[] {
        this.activate();
        return activeList!;
    }

    activate(): void {
        if (!activeList || !base) return;
        if (activeTable === this && IfType.list === activeList) return;
        if (activeTable) {
            for (const id of activeTable.overrides.keys()) {
                activeList[id] = base[id]!;
            }
        }
        for (const [id, com] of this.overrides) {
            activeList[id] = com;
        }
        activeTable = this;
        IfType.list = activeList;
    }

    mutable(id: number): IfType | undefined {
        const existing = this.overrides.get(id);
        if (existing) return existing;
        const shared = base?.[id];
        if (!shared) return undefined;
        const copy: IfType = Object.assign(Object.create(IfType.prototype) as IfType, shared);
        if (shared.linkObjType) copy.linkObjType = shared.linkObjType.slice();
        if (shared.linkObjNumber) copy.linkObjNumber = shared.linkObjNumber.slice();
        this.overrides.set(id, copy);
        if (activeTable === this && activeList) activeList[id] = copy;
        return copy;
    }

    release(): void {
        if (activeTable === this && activeList && base) {
            for (const id of this.overrides.keys()) activeList[id] = base[id]!;
            activeTable = null;
        }
        this.overrides.clear();
    }

    get clonedCount(): number {
        return this.overrides.size;
    }

    owns(id: number): boolean {
        return this.overrides.has(id);
    }
}
`;
}

export function slimLiteClientSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '    npcIds: Int32Array = new Int32Array(16384);',
            '    npcIds: Int32Array = new Int32Array(512);',
        ],
        [
            '    groundObj: (LinkList<ClientObj> | null)[][][] = new TypedArray3d(BuildArea.LEVELS, BuildArea.SIZE, BuildArea.SIZE, null);',
            '    groundObj: (LinkList<ClientObj> | null)[][][] = [[], [], [], []];',
        ],
        [
            '    var: number[] = [];\n    varServ: number[] = [];',
            '    var: number[] = new Int32Array(5000) as unknown as number[];\n    varServ: number[] = new Int32Array(5000) as unknown as number[];',
        ],
        [
            '        for (let i = 0; i < 5000; i++) {\n            this.var[i] = 0;\n            this.varServ[i] = 0;\n        }',
            '        // Int32Array var/varServ are zero-initialized.',
        ],
    ]);
}

export function slimZoneSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '            if (inArea) {\n                if (!c.groundObj[level][x][z]) {\n                    c.groundObj[level][x][z] = new LinkList();\n                }\n                c.groundObj[level][x][z]?.push(new ClientObj(type, count));\n            }',
            '            if (inArea) {\n                const row = (c.groundObj[level][x] ??= new Array(BuildArea.SIZE).fill(null));\n                if (!row[z]) row[z] = new LinkList();\n                row[z]!.push(new ClientObj(type, count));\n            }',
        ],
        [
            '            if (inArea) {\n                const objs = c.groundObj[level][x][z];\n                if (objs) {\n                    for (let obj = objs.head(); obj !== null; obj = objs.next()) {\n                        if (obj.id === (type & 0x7fff)) {\n                            obj.unlink();\n                            break;\n                        }\n                    }\n                    if (objs.head() === null) {\n                        c.groundObj[level][x][z] = null;\n                    }\n                }\n            }',
            '            if (inArea) {\n                const row = c.groundObj[level][x];\n                const objs = row?.[z];\n                if (objs) {\n                    for (let obj = objs.head(); obj !== null; obj = objs.next()) {\n                        if (obj.id === (type & 0x7fff)) {\n                            obj.unlink();\n                            break;\n                        }\n                    }\n                    if (objs.head() === null) {\n                        row![z] = null;\n                    }\n                }\n            }',
        ],
        [
            '            if (inArea) {\n                const objs = c.groundObj[level][x][z];',
            '            if (inArea) {\n                const objs = c.groundObj[level][x]?.[z];',
        ],
        [
            '            if (inArea && pid !== c.selfSlot) {\n                if (!c.groundObj[level][x][z]) {\n                    c.groundObj[level][x][z] = new LinkList();\n                }\n                c.groundObj[level][x][z]?.push(new ClientObj(id, count));\n            }',
            '            if (inArea && pid !== c.selfSlot) {\n                const row = (c.groundObj[level][x] ??= new Array(BuildArea.SIZE).fill(null));\n                if (!row[z]) row[z] = new LinkList();\n                row[z]!.push(new ClientObj(id, count));\n            }',
        ],
    ]);
}

export function slimIncomingSource(src: string): string {
    return replaceOrKeep(src, [
        [
            '                    if (x >= 0 && z >= 0 && x < BuildArea.SIZE && z < BuildArea.SIZE) {\n                        c.groundObj[c.minusedlevel][x][z] = null;\n                    }',
            '                    if (x >= 0 && z >= 0 && x < BuildArea.SIZE && z < BuildArea.SIZE) {\n                        const row = c.groundObj[c.minusedlevel][x];\n                        if (row) row[z] = null;\n                    }',
        ],
        [
            `    for (let x = startTileX; x !== endTileX; x += dirX) {
        for (let z = startTileZ; z !== endTileZ; z += dirZ) {
            const lastX = x + dx;
            const lastZ = z + dz;
            for (let level = 0; level < BuildArea.LEVELS; level++) {
                if (lastX >= 0 && lastZ >= 0 && lastX < BuildArea.SIZE && lastZ < BuildArea.SIZE) {
                    c.groundObj[level][x][z] = c.groundObj[level][lastX][lastZ];
                } else {
                    c.groundObj[level][x][z] = null;
                }
            }
        }
    }`,
            `    const nextGround: typeof c.groundObj = [[], [], [], []];
    for (let level = 0; level < BuildArea.LEVELS; level++) {
        const srcLevel = c.groundObj[level];
        if (!srcLevel) continue;
        for (let lastX = 0; lastX < srcLevel.length; lastX++) {
            const srcRow = srcLevel[lastX];
            if (!srcRow) continue;
            const x = lastX - dx;
            if (x < 0 || x >= BuildArea.SIZE) continue;
            for (let lastZ = 0; lastZ < srcRow.length; lastZ++) {
                const stack = srcRow[lastZ];
                if (!stack) continue;
                const z = lastZ - dz;
                if (z < 0 || z >= BuildArea.SIZE) continue;
                const dstRow = (nextGround[level][x] ??= new Array(BuildArea.SIZE).fill(null));
                dstRow[z] = stack;
            }
        }
    }
    c.groundObj = nextGround;`,
        ],
    ]);
}

export function slimCollisionBuilderSource(src: string): string {
    return replaceOrKeep(src, [
        [
            'export function buildCollision(index: LocIndex, baseX: number, baseZ: number, maps: (CollisionMap | null)[], overlay?: ReadonlyMap<number, number>): void {\n    for (let level = 0; level < BuildArea.LEVELS; level++) {\n        if (!maps[level]) {\n            maps[level] = new CollisionMap();\n        }\n        maps[level]!.reset();\n    }',
            `const LOC_LAYERS = [LocLayer.WALL, LocLayer.WALL_DECOR, LocLayer.GROUND, LocLayer.GROUND_DECOR] as const;
const STATIC_COLLISION_CACHE = new WeakMap<object, Map<string, CollisionMap[]>>();
const STATIC_COLLISION_MAX = 6;

function getStaticCollision(index: LocIndex, baseX: number, baseZ: number): CollisionMap[] {
    let byOrigin = STATIC_COLLISION_CACHE.get(index as unknown as object);
    if (!byOrigin) {
        byOrigin = new Map();
        STATIC_COLLISION_CACHE.set(index as unknown as object, byOrigin);
    }
    const key = \`\${baseX},\${baseZ}\`;
    const hit = byOrigin.get(key);
    if (hit) {
        byOrigin.delete(key);
        byOrigin.set(key, hit);
        return hit;
    }
    const built: CollisionMap[] = [];
    buildCollisionInto(index, baseX, baseZ, built, undefined);
    byOrigin.set(key, built);
    if (byOrigin.size > STATIC_COLLISION_MAX) {
        const oldest = byOrigin.keys().next().value;
        if (oldest !== undefined) byOrigin.delete(oldest);
    }
    return built;
}

export function buildCollision(index: LocIndex, baseX: number, baseZ: number, maps: (CollisionMap | null)[], overlay?: ReadonlyMap<number, number>): void {
    const shared = getStaticCollision(index, baseX, baseZ);
    if (!overlay || overlay.size === 0) {
        for (let level = 0; level < BuildArea.LEVELS; level++) maps[level] = shared[level]!;
        return;
    }
    for (let level = 0; level < BuildArea.LEVELS; level++) {
        if (!maps[level] || maps[level] === shared[level]) maps[level] = new CollisionMap();
    }
    buildCollisionInto(index, baseX, baseZ, maps, overlay);
}

function buildCollisionInto(index: LocIndex, baseX: number, baseZ: number, maps: (CollisionMap | null)[], overlay?: ReadonlyMap<number, number>): void {
    for (let level = 0; level < BuildArea.LEVELS; level++) {
        if (!maps[level]) {
            maps[level] = new CollisionMap();
        }
        maps[level]!.reset();
    }`,
        ],
        [
            'for (const layer of [LocLayer.WALL, LocLayer.WALL_DECOR, LocLayer.GROUND, LocLayer.GROUND_DECOR]) {',
            'for (let li = 0; li < LOC_LAYERS.length; li++) {\n                    const layer = LOC_LAYERS[li]!;',
        ],
    ]);
}

const SLIM_TRANSFORMS: readonly [RegExp, (src: string) => string][] = [
    [/[\\/]webclient[\\/]src[\\/]datastruct[\\/]LruCache\.ts$/, slimLruCacheSource],
    [/[\\/]webclient[\\/]src[\\/]dash3d[\\/]Model\.ts$/, slimModelSource],
    [/[\\/]webclient[\\/]src[\\/]dash3d[\\/]Pix3D\.ts$/, slimPix3dSource],
    [/[\\/]webclient[\\/]src[\\/]lite[\\/]cache\.ts$/, slimCacheSource],
    [/[\\/]webclient[\\/]src[\\/]config[\\/]IfType\.ts$/, slimIfTypeSource],
    [/[\\/]webclient[\\/]src[\\/]config[\\/]SeqType\.ts$/, slimSeqTypeSource],
    [/[\\/]webclient[\\/]src[\\/]config[\\/]SpotType\.ts$/, slimSpotTypeSource],
    [/[\\/]webclient[\\/]src[\\/]lite[\\/]interfaces\.ts$/, slimInterfacesSource],
    [/[\\/]webclient[\\/]src[\\/]lite[\\/]LiteClient\.ts$/, slimLiteClientSource],
    [/[\\/]webclient[\\/]src[\\/]lite[\\/]protocol[\\/]zone\.ts$/, slimZoneSource],
    [/[\\/]webclient[\\/]src[\\/]lite[\\/]protocol[\\/]incoming\.ts$/, slimIncomingSource],
    [/[\\/]webclient[\\/]src[\\/]lite[\\/]world[\\/]CollisionBuilder\.ts$/, slimCollisionBuilderSource],
];

// Install synchronous onLoad transforms before session.ts loads webclient modules.
// Uses readFileSync (never Bun.file().text()) so loading never wakes Bun's async IO threadpool on Windows.
export function installHeadlessClientSlim(): void {
    if (slimPluginInstalled) return;
    slimPluginInstalled = true;
    plugin({
        name: 'rs-headless-client-slim',
        setup(build) {
            for (const [filter, transform] of SLIM_TRANSFORMS) {
                build.onLoad({ filter }, args => {
                    try {
                        const raw = readFileSync(args.path, 'utf8');
                        return { contents: transform(raw.replace(/\r\n/g, '\n')), loader: 'ts' };
                    } catch {
                        return undefined;
                    }
                });
            }
        },
    });
}

// Fallback runtime trim for cases where vendor modules were imported before installHeadlessClientSlim ran.
export async function trimHeadlessClientCaches(): Promise<void> {
    if (typeof globalThis.document === 'undefined') return;
    try {
        const [ifMod, modelMod, pixMod, floMod, idkMod, varpMod, seqMod, spotMod] = await Promise.all([
            import(vendor('server/webclient/src/config/IfType.ts')),
            import(vendor('server/webclient/src/dash3d/Model.ts')),
            import(vendor('server/webclient/src/dash3d/Pix3D.ts')),
            import(vendor('server/webclient/src/config/FloType.ts')),
            import(vendor('server/webclient/src/config/IdkType.ts')),
            import(vendor('server/webclient/src/config/VarpType.ts')),
            import(vendor('server/webclient/src/config/SeqType.ts')),
            import(vendor('server/webclient/src/config/SpotType.ts')),
        ]);
        const IfType = ifMod.default as { list?: any[]; spriteCache?: unknown } | undefined;
        const Model = modelMod.default as Record<string, any> | undefined;
        const Pix3D = pixMod.default as Record<string, any> | undefined;
        if (Model) {
            if (Model.tmpDepthFaces?.length) Model.tmpDepthFaces = [];
            if (Model.tmpPriorityFaces?.length) Model.tmpPriorityFaces = [];
            if (Model.faceClippedX?.length) Model.faceClippedX = [];
            if (Model.faceNearClipped?.length) Model.faceNearClipped = [];
            for (const key of ['vertexScreenX', 'vertexScreenY', 'vertexScreenZ', 'vertexViewSpaceX', 'vertexViewSpaceY', 'vertexViewSpaceZ', 'tmpVertexX', 'tmpVertexY', 'tmpVertexZ', 'tmpDepthFaceCount', 'tmpPriorityFaceCount', 'tmpPriority10FaceDepth', 'tmpPriority11FaceDepth', 'tmpPriorityDepthSum', 'tempFTran']) {
                if (Model[key]?.length) Model[key] = new Int32Array(0);
            }
        }
        if (Pix3D) {
            for (const key of ['colourTable', 'divTable', 'divTable2', 'sinTable', 'cosTable']) {
                if (Pix3D[key]?.length) Pix3D[key] = new Int32Array(0);
            }
        }
        const FloType = floMod.default as { list?: unknown[] } | undefined;
        const IdkType = idkMod.default as { list?: unknown[] } | undefined;
        const VarpType = varpMod.default as { list?: unknown[] } | undefined;
        if (FloType?.list?.length) FloType.list = [];
        if (IdkType?.list?.length) IdkType.list = [];
        if (VarpType?.list?.length) VarpType.list = [];
        const SeqType = seqMod.default as { list?: any[] } | undefined;
        if (Array.isArray(SeqType?.list)) {
            for (let i = 0; i < SeqType.list.length; i++) {
                const seq = SeqType.list[i];
                if (!seq) continue;
                seq.iframes = null;
                seq.walkmerge = null;
            }
        }
        const SpotType = spotMod.default as { list?: any[] } | undefined;
        if (Array.isArray(SpotType?.list)) {
            for (let i = 0; i < SpotType.list.length; i++) {
                const sp = SpotType.list[i];
                if (!sp) continue;
                sp.recol_s = null;
                sp.recol_d = null;
            }
        }
        if (IfType) {
            IfType.spriteCache = null;
            const list = IfType.list;
            if (Array.isArray(list) && !trimmedIfLists.has(list)) {
                trimmedIfLists.add(list);
                const internMap = new Map<string, string>();
                const internStr = (s: unknown): unknown => {
                    if (typeof s !== 'string') return s;
                    if (s.length === 0) return '';
                    let hit = internMap.get(s);
                    if (hit === undefined) { internMap.set(s, s); hit = s; }
                    return hit;
                };
                for (let i = 0; i < list.length; i++) {
                    const com = list[i];
                    if (!com) continue;
                    com.childX = null;
                    com.childY = null;
                    com.invBackgroundX = null;
                    com.invBackgroundY = null;
                    com.invBackground = null;
                    if ('text2' in com) com.text2 = null;
                    if ('targetBase' in com) com.targetBase = null;
                    if ('targetVerb' in com) com.targetVerb = null;
                    if (typeof com.text === 'string') com.text = internStr(com.text);
                    if (typeof com.buttonText === 'string') com.buttonText = internStr(com.buttonText);
                    if (Array.isArray(com.iop)) {
                        for (let j = 0; j < com.iop.length; j++) com.iop[j] = internStr(com.iop[j]);
                    }
                }
                internMap.clear();
            }
        }
    } catch { /* optional memory trim when vendor modules are absent in unit doubles */ }
}

// Release heavy per-session LiteClient arrays after session stop while preserving fields status/settle still read
// (`ingame`, `varServ`, `membersAccount`, `mainOverlayId`, `interfaces`).
export function releaseSessionClient(client: unknown): void {
    const c = client as Record<string, any> | null | undefined;
    if (!c || typeof c !== 'object') return;
    if (Array.isArray(c.groundObj)) c.groundObj = [[], [], [], []];
    if (Array.isArray(c.collision)) c.collision.fill(null);
    if (Array.isArray(c.npc)) c.npc.length = 0;
    if (Array.isArray(c.players)) c.players.length = 0;
    if (Array.isArray(c.playerAppearanceBuffer)) c.playerAppearanceBuffer.length = 0;
    if (Array.isArray(c.dialogHistory)) c.dialogHistory.length = 0;
    if ('collector' in c) c.collector = null;
    if ('executor' in c) c.executor = null;
}
