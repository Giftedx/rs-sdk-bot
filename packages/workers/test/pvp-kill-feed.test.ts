import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fightPlayer, packGain, recordKillLoot } from '../src/pvp/fight';
import { checkKillFeed, feedDeath, killFeed, KillFeed, settleKillFeed } from '../src/pvp/pk-kill-feed';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const line = (o: unknown) => JSON.stringify(o);
// Slot 7 is the victim. Animation 836 is a death (content pack/seq.pack, scripts/measure/pk-rival-feed.ts SEQ).
const roster = line({ t: 'roster', k: 100, p: [[7, 'Iron Pker', 3079, 3640, 0, 90], [8, 'Other', 3080, 3640, 0, 80]] });
// The appearance block of a feed record with only a name and a combat level (pk-rival-feed.ts decodeAppearance).
const appearance = (name: string, combat: number) => {
    let v = 0n; for (const c of name) v = v * 37n + BigInt(' abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(c));
    const bytes = [0, 0, ...new Array(12 + 5 + 14).fill(0), ...Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * (7 - i))) & 0xffn)), combat];
    return btoa(String.fromCharCode(...bytes));
};
const death = (k: number, at: number | undefined, slot = 7) => line({ t: 'tick', k, ...(at === undefined ? {} : { at }), p: [{ i: slot, an: [836, 0] }] });

test('the feed death of the victim near the kill is the match', () => {
    const lines = [line({ t: 'hello', tick: 100, tickMs: 400, at: 1_000_000 }), roster, line({ t: 'tick', k: 104, at: 1_001_600, p: [{ i: 7, an: [829, 0] }] }), death(105, 1_002_000)];
    expect(feedDeath(lines, 'iron_pker', 1_002_300)).toEqual({ matched: true, feedTick: 105, deltaMs: -300, source: 'world feed' });
    expect(feedDeath(lines, 'Iron Pker', 1_002_300, { source: 'trace.jsonl' })).toMatchObject({ matched: true, source: 'trace.jsonl' });
});

test('a death of a different player, a death outside the window and a feed with no time are no match', () => {
    const hello = line({ t: 'hello', tick: 100, tickMs: 400, at: 1_000_000 });
    expect(feedDeath([hello, roster, death(105, 1_002_000, 8)], 'Iron Pker', 1_002_000)).toMatchObject({ matched: false, reason: 'no death of Iron Pker within 6000 ms in the feed' });
    expect(feedDeath([hello, roster, death(105, 1_002_000)], 'Iron Pker', 1_020_000)).toMatchObject({ matched: false });
    expect(feedDeath([roster, death(105, undefined)], 'Iron Pker', 1_002_000)).toEqual({ matched: false, reason: 'the feed lines carry no time', source: 'world feed' });
});

test('a tick with no time of its own takes its time from the hello line and the tick length', () => {
    const hello = line({ t: 'hello', tick: 100, tickMs: 400, at: 1_000_000 });
    expect(feedDeath([hello, roster, death(110, undefined)], 'Iron Pker', 1_004_100)).toEqual({ matched: true, feedTick: 110, deltaMs: -100, source: 'world feed' });
    // With no tick length the time of the tick is unknown, so the death is no match.
    expect(feedDeath([line({ t: 'hello', tick: 100, at: 1_000_000 }), roster, death(110, undefined)], 'Iron Pker', 1_004_100)).toMatchObject({ matched: false });
});

test('the feed is off for a practice engine unless KILL_FEED=1 turns it on, and KILL_FEED=0 turns it off', () => {
    expect(killFeed('localhost:43594', {})).toBeNull();
    expect(killFeed(undefined, { KILL_FEED: '1' })).toBeNull();
    expect(killFeed('rs-sdk-demo.fly.dev', { KILL_FEED: '0' })).toBeNull();
});

test('a watch keeps timed lines and gives the match to the receipt', async () => {
    // Port 9 has no listener: the socket fails and the watch works from the lines that the test gives it.
    const watch = new KillFeed('127.0.0.1:9');
    expect(watch.match('Iron Pker', 5000)).toMatchObject({ matched: false, reason: 'the feed is not available' });
    watch.accept(line({ t: 'hello', tick: 100, tickMs: 400 }), 1000);
    watch.accept(line({ t: 'tick', k: 101, p: [{ i: 7, f: 1, x: 3079, z: 3640, ap: appearance('iron pker', 90) }, { i: 8, f: 1, x: 3080, z: 3640, ap: appearance('other', 80) }] }), 1400);
    watch.accept(death(102, undefined, 8), 1800);
    expect(watch.match('Iron Pker', 2300)).toMatchObject({ matched: false, reason: 'no death of Iron Pker within 6000 ms in the feed' });
    watch.accept(death(103, undefined), 2200);
    // A death of a slot that has no name (first seen before the watch) is no match for a name.
    watch.accept(death(103, undefined, 9), 2200);
    let got: unknown;
    checkKillFeed(watch, 'iron_pker', 2300, m => { got = m; }, 0);
    await settleKillFeed();
    expect(got).toEqual({ matched: true, feedTick: 103, deltaMs: -100, source: 'ws://127.0.0.1:9/worldfeed' });
    expect(watch.match('Iron Pker', 60_000)).toMatchObject({ matched: false });
    // A slot that leaves the view loses its name: the next player in that slot is a different player.
    watch.accept(line({ t: 'tick', k: 104, rp: [7] }), 2600);
    watch.accept(death(105, undefined), 3000);
    expect(watch.match('Iron Pker', 3000, 500)).toMatchObject({ matched: false });
    watch.close();
});

test('the fight loop writes one receipt at the kill and the pickup adds its loot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-kill-')); roots.push(root);
    let tick = 10;
    const state: any = {
        player: { worldX: 3094, worldZ: 3555, level: 0, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1 },
        skills: [{ name: 'Magic', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
        prayers: { prayerPoints: 99, activePrayers: new Array(20).fill(false) },
        inventory: [{ slot: 0, id: 385, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }],
        equipment: [{ slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 110, x: 3095, z: 3555, distance: 1 }],
        combatEvents: [], gameMessages: [{ observationId: 9, tick: 11, type: 0, text: "It's all over for Dummy." }],
    };
    const session: any = {
        name: 'Killer', client: { var: {}, players: [] }, tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => { setTimeout(() => { tick++; cb(); }, 0); return () => {}; },
        sdk: { getState: () => state, sendWalk: () => {} },
    };
    const logs: string[] = [];
    const res = await fightPlayer(session, 'dummy', { kit: { magic: [1401], melee: [1231] }, killReceiptRoot: root, log: l => logs.push(l) });
    expect(res.outcome).toBe('kill');
    expect(res.receipt?.replaceAll('\\', '/')).toContain('/practice/no-session/killer/');
    const receipt = JSON.parse(readFileSync(res.receipt!, 'utf8'));
    expect(receipt).toMatchObject({
        schema: 'player-kill/1', account: 'Killer', victim: 'Dummy', domain: 'practice', practice: true, tick: 11, tile: { x: 3094, z: 3555, level: 0 },
        wilderness: 5, multi: false, message: "It's all over for Dummy.", victimCombat: 110, victimTile: { x: 3095, z: 3555 }, loot: null, feed: null,
        kit: { worn: [{ slot: 3, id: 1401, name: 'Mystic fire staff' }], switches: { magic: [1401], ranged: [], melee: [1231] } },
    });
    expect(logs.some(l => /^PK kill receipt practice \d{13}-\d+-\d+ wilderness 5 single$/.test(l))).toBe(true);
    recordKillLoot(res, packGain([{ id: 385, count: 1 }], [{ id: 385, count: 1 }, { id: 1215, count: 1 }, { id: 995, count: 250 }]), new Map([[1215, 'dragon_dagger']]));
    expect(JSON.parse(readFileSync(res.receipt!, 'utf8')).loot).toEqual([{ id: 995, count: 250 }, { id: 1215, name: 'dragon_dagger', count: 1 }]);
    // A fight with no receipt changes no file.
    recordKillLoot({}, { 995: 1 });
});

test('the pack gain counts only what the pack got', () => {
    expect(packGain([{ id: 385, count: 1 }, { id: 385, count: 1 }, { id: 560, count: 100 }], [{ id: 385, count: 1 }, { id: 560, count: 140 }, { id: 4151, count: 1 }])).toEqual({ 560: 40, 4151: 1 });
    expect(packGain([], [])).toEqual({});
});

// A process that opened a feed ends by itself once settleKillFeed has closed the socket, and stays alive while the socket is open.
// The server is in this test process, so it stays up while the child ends or does not.
async function feedProcess(settle: boolean): Promise<{ exited: boolean; ms: number }> {
    const server = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response('no'); }, websocket: { message() {}, open() {} } });
    const code = `
        import { killFeed, settleKillFeed } from ${JSON.stringify(resolve(import.meta.dir, '../src/pvp/pk-kill-feed.ts'))};
        const feed = killFeed('127.0.0.1:' + ${server.port}, { KILL_FEED: '1' })!;
        for (let i = 0; i < 100 && feed.state !== 'open'; i++) await new Promise(r => setTimeout(r, 50));
        if (feed.state !== 'open') { console.log('NOT_OPEN'); process.exit(3); }
        ${settle ? 'await settleKillFeed();' : ''}
        console.log('MAIN_DONE');
    `;
    const start = Date.now(), child = Bun.spawn(['bun', '-e', code], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    try {
        const exited = await Promise.race([child.exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 6000))]);
        if (!exited) child.kill();
        return { exited, ms: Date.now() - start };
    } finally { server.stop(true); }
}

test('a process with an open kill feed exits after the run settles, and stays alive without it', async () => {
    expect((await feedProcess(true)).exited).toBe(true);
    expect((await feedProcess(false)).exited).toBe(false);
}, 30_000);

test('a settle of the bot framework runs the shutdown tasks that the feed registers', async () => {
    const { shutdownTasks, runShutdownTasks } = await import('../../core/src/shutdown');
    let ran = 0;
    const task = async () => { ran++; };
    shutdownTasks.add(task);
    await runShutdownTasks();
    expect(ran).toBe(1);
    shutdownTasks.delete(task);
    shutdownTasks.add(async () => { throw new Error('one task fails'); });
    await runShutdownTasks();
    shutdownTasks.clear();
});
