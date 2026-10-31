import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {createSaveData} from '../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import {handleSaveRequest, type SaveWorld} from '../src/save-endpoint';
import {addEntry, endpointBase, entryBytes, findEntry, loadSnapshot, readLibrary, replaceCheckpoint, summarize} from '../src/save-library';
import {checkExpect, pointBotAt, TickWindow} from '../src/rehearse';
import {pidsFile} from '../src/stack';

// createSaveData stamps the clock into each save, so the fixture is built once.
const SMITH = createSaveData({position: {x: 3274, z: 3186, level: 0}, skills: {Smithing: 50},
    inventory: [{id: 440, count: 1}, {id: 440, count: 1}, {id: 2351, count: 1}], bank: [{id: 440, count: 200}, {id: 995, count: 77}]});
const smith = () => SMITH.slice();
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('summary reads position, trained skills, pack, worn and bank from the binary save', () => {
    const s = summarize(smith());
    expect(s.position).toEqual({x: 3274, z: 3186, level: 0});
    expect(s.skills.Smithing!.level).toBe(50);
    expect(s.skills.Hitpoints!.level).toBe(10);
    expect(s.skills.Magic).toBeUndefined();
    expect(s.inventory).toEqual({440: 2, 2351: 1});
    expect(s.bank).toEqual({440: 200, 995: 77});
    expect(s.worn).toEqual({});
});

test('a corrupt save is refused before the library writes anything', () => {
    const dir = tmp('savelib-');
    const bad = smith().slice();
    bad[10] ^= 1;
    expect(() => addEntry({name: 'bad', bytes: bad, source: {account: 'x', via: 'file', tick: null}, segment: 's', rsSdk: 'r'}, dir)).toThrow(/CRC/);
    expect(readLibrary(dir).entries).toEqual([]);
});

test('library entry keeps name, source, segment, engine revision and summary; replace keeps one entry; segments survive', () => {
    const dir = tmp('savelib-');
    writeFileSync(join(dir, 'library.json'), JSON.stringify({entries: [], segments: [{id: 'keep'}]}));
    const input = {name: 'smith-50', bytes: smith(), source: {account: 'flsmith1', via: 'endpoint' as const, tick: 1234}, segment: 'anvil input', rsSdk: 'b565f2d9'};
    addEntry(input, dir);
    const e = addEntry({...input, segment: 'anvil input, replaced'}, dir);
    const lib = readLibrary(dir) as {entries: unknown[]; segments: unknown[]};
    expect(lib.entries.length).toBe(1);
    expect(lib.segments).toEqual([{id: 'keep'}]);
    expect(findEntry('smith-50', dir)).toEqual(e);
    expect(e.source).toEqual({account: 'flsmith1', via: 'endpoint', tick: 1234});
    expect(e.engine).toEqual({rsSdk: 'b565f2d9', saveVersion: summarize(smith()).version});
    expect(e.summary.inventory[2351]).toBe(1);
    expect(entryBytes(e, dir)).toEqual(Buffer.from(smith()));
    writeFileSync(join(dir, e.file), Buffer.from(smith()).fill(0xff, 20, 21));
    expect(() => entryBytes(e, dir)).toThrow(/sha256/);
    expect(() => addEntry({...input, name: 'Bad Name'}, dir)).toThrow(/invalid library name/);
    expect(() => addEntry({...input, name: 'ok', segment: ' '}, dir)).toThrow(/route segment/);
});

function fakeRoot(version = 9) {
    const root = tmp('rssdk-');
    mkdirSync(join(root, 'server/engine/src/engine/entity'), {recursive: true});
    writeFileSync(join(root, 'server/engine/src/engine/entity/PlayerLoading.ts'), `public static readonly SAV_VERSION: number = ${version};`);
    mkdirSync(join(root, 'server/engine/data'), {recursive: true});
    return root;
}

test('load writes the snapshot under another account and replaces its market checkpoint', async () => {
    const dir = tmp('savelib-'), root = fakeRoot();
    addEntry({name: 'smith-50', bytes: smith(), source: {account: 'flsmith1', via: 'file', tick: null}, segment: 'anvil input', rsSdk: 'r'}, dir);
    const db = new Database(join(root, 'server/engine/data/market.sqlite'));
    db.exec('CREATE TABLE accounts(owner TEXT PRIMARY KEY, save BLOB)');
    db.query('INSERT INTO accounts VALUES(?,?)').run('rhtest1', new Uint8Array([1, 2, 3]));
    db.close();
    const r = await loadSnapshot('smith-50', 'RhTest1', {dir, root, online: async () => false});
    expect(r.checkpointReplaced).toBe(true);
    expect(readFileSync(join(root, 'server/engine/data/players/main/rhtest1.sav'))).toEqual(Buffer.from(smith()));
    const check = new Database(join(root, 'server/engine/data/market.sqlite'));
    expect(Buffer.from(check.query<{save: Uint8Array}, [string]>('SELECT save FROM accounts WHERE owner=?').get('rhtest1')!.save)).toEqual(Buffer.from(smith()));
    check.close();
});

test('load refuses an online account, a newer save version and a bad account name', async () => {
    const dir = tmp('savelib-');
    addEntry({name: 'smith-50', bytes: smith(), source: {account: 'a', via: 'file', tick: null}, segment: 's', rsSdk: 'r'}, dir);
    await expect(loadSnapshot('smith-50', 'rhtest1', {dir, root: fakeRoot(), online: async () => true})).rejects.toThrow(/online/);
    await expect(loadSnapshot('smith-50', 'rhtest1', {dir, root: fakeRoot(1), online: async () => false})).rejects.toThrow(/save version/);
    await expect(loadSnapshot('smith-50', '../x', {dir, root: fakeRoot(), online: async () => false})).rejects.toThrow(/invalid practice account/);
    await expect(loadSnapshot('missing', 'rhtest1', {dir, root: fakeRoot(), online: async () => false})).rejects.toThrow(/no library save/);
    expect(replaceCheckpoint(join(tmp('none-'), 'market.sqlite'), 'x', smith())).toBe(false);
});

test('endpoint URLs are local only', () => {
    expect(endpointBase(8912)).toBe('http://127.0.0.1:8912');
    expect(() => endpointBase(8888, 'rs-sdk-demo.fly.dev')).toThrow(/local practice server/);
});

test('save endpoint: tick, online state and in-memory save without logout', async () => {
    let saves = 0;
    const world: SaveWorld = {currentTick: 77, logoutRequests: new Map([['leaving', {}]]),
        getPlayerByUsername: n => n === 'smith' ? {save: (checkpoint?: boolean) => { saves++; expect(checkpoint).toBe(false); return smith(); }} : undefined};
    const get = (path: string, method = 'GET') => handleSaveRequest(world, new Request(`http://127.0.0.1:8912${path}`, {method}));
    expect(await get('/tick').json()).toEqual({tick: 77});
    expect(await get('/online/Smith').json()).toEqual({tick: 77, online: true, pendingLogout: false});
    expect(await get('/online/leaving').json()).toEqual({tick: 77, online: false, pendingLogout: true});
    const r = get('/save/smith');
    expect(r.status).toBe(200);
    expect(r.headers.get('x-tick')).toBe('77');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(smith());
    expect(saves).toBe(1);
    expect(get('/save/nobody').status).toBe(404);
    expect(get('/save/bad..name').status).toBe(400);
    expect(get('/save/smith', 'POST').status).toBe(405);
    expect(get('/kick/smith').status).toBe(404);
});

test('rehearsal expectation checks skills, items by container and position', () => {
    const s = summarize(smith());
    expect(checkExpect(s, {skills: {Smithing: 50}, items: {2351: {min: 1, in: 'inventory'}, 440: {min: 202}}, position: {x: 3275, z: 3186, level: 0, radius: 1}}))
        .toEqual({'skill.Smithing>=50': true, 'item.2351.inventory': true, 'item.440.any': true, position: true});
    expect(checkExpect(s, {skills: {Magic: 2}, items: {2351: {min: 1, in: 'bank'}, 995: {max: 10}}, position: {x: 3200, z: 3186, level: 0, radius: 5}}))
        .toEqual({'skill.Magic>=2': false, 'item.2351.bank': false, 'item.995.any': false, position: false});
    expect(() => checkExpect(s, {skills: {Sailing: 1}})).toThrow(/unknown skill/);
});

test('tick window counts from first seen in world to first seen gone', () => {
    const w = new TickWindow();
    w.observe(10, false);
    expect(w.ticks).toBeNull();
    w.observe(12, true); w.observe(40, true); w.observe(55, false); w.observe(60, true); w.observe(70, false);
    expect([w.enter, w.leave, w.ticks]).toEqual([12, 55, 43]);
});

test('rehearsal bots are pointed at the local isolated engine', () => {
    const env = join(tmp('botenv-'), 'bot.env');
    writeFileSync(env, 'BOT_USERNAME=x\r\nSERVER=localhost\r\nPASSWORD=p\r\n');
    pointBotAt(env, 8910, 7791);
    const text = readFileSync(env, 'utf8');
    expect(text).toContain('SERVER=localhost:8910\n');
    expect(text).toContain('GATEWAY_URL=ws://localhost:7791');
    expect(text).not.toContain('\r');
});

test('every library segment uses the expectation schema and starts from a library save that exists', () => {
    const lib = readLibrary() as {entries: {name: string}[]; segments: import('../src/rehearse').Segment[]};
    const empty = summarize(smith());
    for (const seg of lib.segments) {
        expect(() => checkExpect(empty, seg.expect)).not.toThrow();
        if (seg.capture?.when) {
            expect(Object.keys(checkExpect(empty, seg.capture.when)).length).toBeGreaterThan(0);
        }
        if ('snapshot' in seg.start) expect(lib.entries.map(e => e.name)).toContain(seg.start.snapshot);
    }
    expect(() => checkExpect(empty, {skill: 'Magic', level: 8} as never)).toThrow(/unknown expectation keys/);
});

test('a named stack instance has its own pid file', () => {
    expect(basename(pidsFile())).toBe('pids.json');
    expect(basename(pidsFile('rehearse'))).toBe('pids-rehearse.json');
    expect(() => pidsFile('../x')).toThrow(/invalid stack instance/);
});
