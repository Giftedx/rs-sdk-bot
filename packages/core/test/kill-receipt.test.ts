import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { amendKillReceipt, killDomain, killMessage, killReceiptProof, readKillReceipts, writeKillReceipt, type KillInput } from '../src/kill-receipt';

const LIVE = 'rs-sdk-demo.fly.dev', NOW = 1_800_000_000_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fresh = () => { const root = mkdtempSync(join(tmpdir(), 'kill-receipt-')); roots.push(root); return root; };
const kill = (patch: Partial<KillInput> = {}): KillInput => ({
    session: { server: LIVE, attemptId: '1800000000000-0000000001-0000000001' }, account: 'Porksword', victim: 'Goondelf', tick: 730,
    tile: { x: 3078, z: 3640, level: 0 }, wilderness: 16, multi: true, message: 'You have defeated Goondelf.', victimCombat: 90, victimTile: { x: 3079, z: 3640 },
    kit: { worn: [{ slot: 3, id: 1215, name: 'Dragon dagger' }], switches: { magic: [1401], ranged: [861], melee: [1215] } },
    fight: { ticks: 41, dealt: 99, taken: 30, eaten: 2, specs: 1 }, ...patch,
});
const owned = new Set(['porksword', 'moneyshot']);
const read = (root: string) => readKillReceipts({ root, server: LIVE, owned, now: NOW });
const at = (ms: number) => ({ now: () => ms });

test('a live kill of a player that is not an own account is credited', () => {
    const root = fresh(), { file, receipt } = writeKillReceipt(kill(), { root, ...at(NOW - 5000) });
    expect(receipt).toMatchObject({ schema: 'player-kill/1', domain: 'live', practice: false, server: LIVE, account: 'Porksword', victim: 'Goondelf', tick: 730, wilderness: 16, multi: true, loot: null, feed: null });
    expect(file.replaceAll('\\', '/')).toContain(`/live/${LIVE}/porksword/${receipt.id}.json`);
    const verdicts = read(root);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ credited: true, reason: null });
    expect(verdicts[0]!.receipt?.kit.worn[0]?.name).toBe('Dragon dagger');
});

test('a practice receipt goes to the practice tree and the reader never sees it', () => {
    const root = fresh();
    for (const session of [{ server: 'localhost:43594' }, { server: '127.0.0.1:8888' }, null, undefined, { server: 'bad server name' }]) {
        const { file, receipt } = writeKillReceipt(kill({ session }), { root, ...at(NOW - 5000) });
        expect(receipt.domain).toBe('practice');
        expect(receipt.practice).toBe(true);
        expect(file.replaceAll('\\', '/')).toContain('/practice/');
    }
    expect(existsSync(join(root, 'live'))).toBe(false);
    expect(read(root)).toEqual([]);
    expect(killDomain({ server: LIVE })).toBe('live');
    expect(killDomain({ server: 'localhost' })).toBe('practice');
    expect(killDomain(null)).toBe('practice');
});

test('a practice receipt that is copied into the live tree is refused', () => {
    const root = fresh(), { file, receipt } = writeKillReceipt(kill({ session: { server: 'localhost:43594' } }), { root, ...at(NOW - 5000) });
    const planted = join(root, 'live', LIVE, 'porksword', `${receipt.id}.json`);
    mkdirSync(dirname(planted), { recursive: true });
    cpSync(file, planted);
    expect(read(root)).toMatchObject([{ credited: false, reason: 'practice receipt' }]);
    // The same file with only its marks changed still names the practice server.
    writeFileSync(planted, JSON.stringify({ ...receipt, domain: 'live', practice: false }));
    expect(read(root)).toMatchObject([{ credited: false, reason: 'other server' }]);
});

test('the reader refuses each receipt that is not a live kill of a stranger by an own account', () => {
    const cases: [string, Partial<KillInput>, number?][] = [
        ['killer is not an own account', { account: 'Stranger' }],
        ['victim is an own account', { victim: 'Moneyshot', message: 'You have defeated Moneyshot.' }],
        ['victim is an own account', { victim: 'porksword', message: 'You have defeated porksword.' }],
        ['not in the Wilderness', { wilderness: 0 }],
        ['server message is not a kill of the victim', { message: 'You have defeated Someone Else.' }],
        ['server message is not a kill of the victim', { message: 'Oh dear, you are dead!' }],
        ['time is not in the past', {}, NOW + 60_000],
        ['tile', { tile: { x: 3078, z: 3640.5, level: 0 } }],
    ];
    for (const [reason, patch, time] of cases) {
        const root = fresh();
        writeKillReceipt(kill(patch), { root, ...at(time ?? NOW - 5000) });
        expect(read(root)).toMatchObject([{ credited: false, reason }]);
    }
    // A receipt of a different live server is in a different folder. Moved into the folder of this server, it is refused.
    const root = fresh(), other = writeKillReceipt(kill({ session: { server: 'other.example.org' } }), { root, ...at(NOW - 5000) });
    expect(read(root)).toEqual([]);
    const moved = join(root, 'live', LIVE, 'porksword', `${other.receipt.id}.json`);
    mkdirSync(dirname(moved), { recursive: true });
    cpSync(other.file, moved);
    expect(read(root)).toMatchObject([{ credited: false, reason: 'other server' }]);
    // A file in the folder of a different account, a file with a different name and a file that is not JSON.
    const wrongFolder = join(root, 'live', LIVE, 'moneyshot', `${other.receipt.id}.json`);
    mkdirSync(dirname(wrongFolder), { recursive: true });
    writeFileSync(wrongFolder, JSON.stringify({ ...other.receipt, server: LIVE }));
    writeFileSync(join(dirname(wrongFolder), '1800000000000-0000000001-0000000009.json'), JSON.stringify({ ...other.receipt, server: LIVE, account: 'Moneyshot' }));
    writeFileSync(join(dirname(wrongFolder), 'broken.json'), '{');
    expect(read(root).map(v => v.reason).sort()).toEqual(['account does not match the folder', 'id does not match the file', 'other server', 'unreadable']);
});

test('loot and the feed match are added to the same file', () => {
    const root = fresh(), { file } = writeKillReceipt(kill(), { root, ...at(NOW - 5000) });
    amendKillReceipt(file, { loot: [{ id: 385, name: 'shark', count: 3 }, { id: 995, count: 100 }] }, () => NOW - 4000);
    amendKillReceipt(file, { loot: [{ id: 385, count: 2 }, { id: 1, count: 0 }] }, () => NOW - 3000);
    const receipt = amendKillReceipt(file, { feed: { matched: true, feedTick: 9001, deltaMs: 400, source: 'world feed' } });
    expect(receipt.loot).toEqual([{ id: 385, name: 'shark', count: 5 }, { id: 995, count: 100 }]);
    expect(receipt.lootAt).toBe(NOW - 3000);
    expect(JSON.parse(readFileSync(file, 'utf8')).feed).toEqual({ matched: true, feedTick: 9001, deltaMs: 400, source: 'world feed' });
    expect(read(root)).toMatchObject([{ credited: true }]);
    // A pickup that took nothing leaves an empty list, which is not the null of "no pickup ran".
    const second = writeKillReceipt(kill({ victim: 'Ligma', message: 'Ligma falls before your might.' }), { root, ...at(NOW - 2000) });
    expect(amendKillReceipt(second.file, { loot: [] }).loot).toEqual([]);
});

test('the proof text counts the receipts of a run from the disk', () => {
    const root = fresh();
    const practice = writeKillReceipt(kill({ session: { server: 'localhost:43594' } }), { root, ...at(NOW - 5000) }).file;
    const live = writeKillReceipt(kill(), { root, ...at(NOW - 4000) }).file;
    expect(killReceiptProof([])).toBe('killReceipts=0 receiptDomain=none feedMatched=0');
    expect(killReceiptProof([practice, join(root, 'missing.json')])).toBe('killReceipts=1 receiptDomain=practice feedMatched=0');
    expect(killReceiptProof([live])).toBe('killReceipts=1 receiptDomain=live feedMatched=0');
    amendKillReceipt(live, { feed: { matched: true, feedTick: 9001, deltaMs: 0, source: 'world feed' } });
    amendKillReceipt(practice, { feed: { matched: false, reason: 'the feed is not available' } });
    expect(killReceiptProof([practice, live])).toBe('killReceipts=2 receiptDomain=mixed feedMatched=1');
});

test('an identity that is not valid writes nothing', () => {
    const root = fresh();
    expect(() => writeKillReceipt(kill({ account: '../escape' }), { root })).toThrow('invalid kill receipt identity');
    expect(() => writeKillReceipt(kill({ victim: ' ' }), { root })).toThrow('invalid kill receipt identity');
    expect(existsSync(join(root, 'live'))).toBe(false);
    expect(killMessage('Goondelf has won a free ticket to Lumbridge.', 'goondelf')).toBe(true);
});
