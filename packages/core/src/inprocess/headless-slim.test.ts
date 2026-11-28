import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    installHeadlessClientSlim,
    releaseSessionClient,
    slimCacheSource,
    slimCollisionBuilderSource,
    slimIfTypeSource,
    slimIncomingSource,
    slimInterfacesSource,
    slimLiteClientSource,
    slimLruCacheSource,
    slimModelSource,
    slimPix3dSource,
    slimSeqTypeSource,
    slimSpotTypeSource,
    slimZoneSource,
} from './headless-slim';
import { createShim } from './shim';
import { vendor } from './transport';

const readVendor = (rel: string) => readFileSync(vendor(rel), 'utf8').replace(/\r\n/g, '\n');

test('every headless-slim transform matches its pinned vendor source and falls back cleanly on unknown source', () => {
    const cases: [string, (s: string) => string][] = [
        ['server/webclient/src/datastruct/LruCache.ts', slimLruCacheSource],
        ['server/webclient/src/dash3d/Model.ts', slimModelSource],
        ['server/webclient/src/dash3d/Pix3D.ts', slimPix3dSource],
        ['server/webclient/src/lite/cache.ts', slimCacheSource],
        ['server/webclient/src/config/IfType.ts', slimIfTypeSource],
        ['server/webclient/src/config/SeqType.ts', slimSeqTypeSource],
        ['server/webclient/src/config/SpotType.ts', slimSpotTypeSource],
        ['server/webclient/src/lite/interfaces.ts', slimInterfacesSource],
        ['server/webclient/src/lite/LiteClient.ts', slimLiteClientSource],
        ['server/webclient/src/lite/protocol/zone.ts', slimZoneSource],
        ['server/webclient/src/lite/protocol/incoming.ts', slimIncomingSource],
        ['server/webclient/src/lite/world/CollisionBuilder.ts', slimCollisionBuilderSource],
    ];
    for (const [rel, fn] of cases) {
        const raw = readVendor(rel);
        const out = fn(raw);
        expect(out).not.toBe(raw);
        expect(fn('export const unrelated = 1;\n')).toBe('export const unrelated = 1;\n');
    }
});

test('slimmed InterfaceTable isolates per-client overrides on one shared active list and releases cleanly', async () => {
    installHeadlessClientSlim();
    await import(vendor('server/webclient/src/lite/dom-shim.ts'));
    const IfType = (await import(vendor('server/webclient/src/config/IfType.ts'))).default as any;
    const { InterfaceTable, captureBaseInterfaces, resetBaseInterfaces } = await import(vendor('server/webclient/src/lite/interfaces.ts'));
    const prevList = IfType.list;
    resetBaseInterfaces();
    try {
        const mk = (id: number, text: string) => Object.assign(new IfType(), {
            id, text, linkObjType: new Int32Array([1, 2]), linkObjNumber: new Int32Array([10, 20]),
        });
        IfType.list = [undefined, mk(1, 'base1'), mk(2, 'base2')];
        captureBaseInterfaces();

        const a = new InterfaceTable();
        const b = new InterfaceTable();
        const a1 = a.mutable(1)!;
        a1.text = 'clientA';
        a1.linkObjNumber![0] = 99;
        expect(a.owns(1)).toBe(true);
        expect(a.clonedCount).toBe(1);
        expect(b.owns(1)).toBe(false);

        a.activate();
        expect(IfType.list[1].text).toBe('clientA');
        expect(IfType.list[1].linkObjNumber[0]).toBe(99);

        b.activate();
        expect(IfType.list[1].text).toBe('base1');
        expect(IfType.list[1].linkObjNumber[0]).toBe(10);

        const b2 = b.mutable(2)!;
        b2.text = 'clientB';
        expect(b.list[2].text).toBe('clientB');
        expect(a.list[1].text).toBe('clientA');
        expect(a.list[2].text).toBe('base2');

        a.release();
        expect(a.clonedCount).toBe(0);
        b.release();
        expect(IfType.list[1].text).toBe('base1');
        expect(IfType.list[2].text).toBe('base2');
    } finally {
        resetBaseInterfaces();
        IfType.list = prevList;
    }
});

test('slimmed CollisionBuilder shares static base maps and copy-on-writes when overlay is non-empty', async () => {
    installHeadlessClientSlim();
    await import(vendor('server/webclient/src/lite/dom-shim.ts'));
    const { buildCollision } = await import(vendor('server/webclient/src/lite/world/CollisionBuilder.ts'));
    const fakeIndex = {
        size: 0,
        lookup: () => 0,
        mapFlags: (_l: number, x: number, z: number) => (x === 3205 && z === 3205 ? 1 : 0),
    };
    const mapsA: any[] = [null, null, null, null];
    const mapsB: any[] = [null, null, null, null];
    buildCollision(fakeIndex, 3200, 3200, mapsA, new Map());
    buildCollision(fakeIndex, 3200, 3200, mapsB, new Map());
    expect(mapsA[0]).toBe(mapsB[0]);
    expect(mapsA[0].flags[5 * 104 + 5]).not.toBe(0);

    // Non-empty overlay allocates a private map without mutating the shared static cache.
    const overlay = new Map<number, number>([[((2) * 0x40000000) + ((0) * 0x10000000) + ((3206) * 0x4000) + 3206, -1]]);
    buildCollision(fakeIndex, 3200, 3200, mapsB, overlay);
    expect(mapsB[0]).not.toBe(mapsA[0]);
});

test('createShim delivers state and action results directly to BotSDK without JSON.stringify round-trip', async () => {
    const { BotSDK } = await import(vendor('sdk/index.ts'));
    const sdk = new BotSDK({ botUsername: 'direct', password: 'pw', autoLaunchBrowser: false, autoReconnect: false, showChat: false });
    let handleMessageCalls = 0;
    const origProto = BotSDK.prototype.handleMessage;
    const client: any = {
        collectBotState: (tick: number) => ({
            tick,
            inGame: true,
            player: { name: 'direct', worldX: 3200, worldZ: 3200, level: 0 },
            skills: [{ name: 'Hitpoints', level: 10, baseLevel: 10, experience: 1154 }, { name: 'Stat99', level: 1, baseLevel: 1, experience: 0 }],
            inventory: [],
            equipment: [],
            nearbyNpcs: [],
            nearbyPlayers: [{ index: 1, name: 'ally', x: 3201, z: 3202, combatLevel: 3 }],
            nearbyLocs: [],
            groundItems: [],
            gameMessages: [
                { type: 0, text: 'Welcome', sender: '', tick },
                { type: 2, text: 'hello', sender: 'ally', tick },
            ],
            trade: { isOpen: true, myOffer: [{ id: 995, count: 50 }], theirOffer: [{ id: 1511, count: 3 }] },
        }),
        executeBotAction: () => ({ success: true, message: 'dispatched' }),
        setOnGameTickCallback(cb: (() => void) | null) { this._cb = cb; },
        getMaxMessageLength: () => 250,
    };
    (BotSDK.prototype as any).handleMessage = function (...args: unknown[]) {
        handleMessageCalls++;
        return (origProto as any).apply(this, args);
    };
    try {
        const shim = createShim(client, sdk);
        shim.start();
        let observedTick = -1;
        const off = sdk.onStateUpdate((st: { tick: number }) => { observedTick = st.tick; });
        client._cb();
        expect(handleMessageCalls).toBe(0);
        expect(observedTick).toBe(1);
        const st: any = sdk.getState();
        expect(st.skills.Hitpoints.baseLevel).toBe(10);
        expect(st.skills.Stat99).toBeUndefined();
        expect(st.nearbyPlayers[0].worldX).toBe(3201);
        expect(st.nearbyPlayers[0].worldZ).toBe(3202);
        expect(st.trade.myOffer[0].amount).toBe(50);
        expect(st.trade.theirOffer[0].amount).toBe(3);
        expect(st.gameMessages).toHaveLength(1);
        expect(st.gameMessages[0].text).toBe('Welcome');
        expect((sdk as any).serverMaxMessageLength).toBe(250);

        const res = await sdk.sendAction({ type: 'noop', reason: 'test' } as any);
        expect(res.success).toBe(true);
        expect(handleMessageCalls).toBe(0);
        off();
        shim.stop('stopped');
    } finally {
        (BotSDK.prototype as any).handleMessage = origProto;
    }
});

test('releaseSessionClient clears heavy arrays while preserving status-readable fields', () => {
    const client: any = {
        ingame: false,
        membersAccount: 1,
        mainOverlayId: -1,
        varServ: new Int32Array(5000),
        groundObj: [[new Array(104)], [], [], []],
        collision: [{ flags: new Int32Array(4) }, null, null, null],
        npc: [null, { id: 1 }],
        players: [null, { id: 2 }],
        playerAppearanceBuffer: [null, {}],
        dialogHistory: [{ text: ['hi'], tick: 1, interfaceId: 1 }],
        collector: { heavy: true },
        executor: { heavy: true },
    };
    client.varServ[101] = 32;
    releaseSessionClient(client);
    expect(client.groundObj).toEqual([[], [], [], []]);
    expect(client.collision).toEqual([null, null, null, null]);
    expect(client.npc).toHaveLength(0);
    expect(client.players).toHaveLength(0);
    expect(client.playerAppearanceBuffer).toHaveLength(0);
    expect(client.dialogHistory).toHaveLength(0);
    expect(client.collector).toBeNull();
    expect(client.executor).toBeNull();
    expect(client.varServ[101]).toBe(32);
    expect(client.membersAccount).toBe(1);
});
