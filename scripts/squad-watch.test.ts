import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventLine, newWatch, readLine, readStatuses, statusView, summary, supplies, tail, type Config, type StatusView } from './squad-watch';

const cfg: Config = { noKillMs: 20 * 60_000, quietMs: 4 * 60_000, lowHp: 30, repeat: false }, T0 = 1_800_000_000_000;
// (3067, 3640) is the squad's post at Wilderness level 16; (3094, 3491) is the Edgeville bank.
const POST = { x: 3067, z: 3640 }, BANK = { x: 3094, z: 3491 };
const KIT = [{ id: 1215, name: 'Dragon dagger', count: 1, slot: 3 }, { id: 1113, name: 'Rune chainbody', count: 1, slot: 4 }, { id: 1079, name: 'Rune platelegs', count: 1, slot: 7 }, { id: 884, name: 'Iron arrow', count: 280, slot: 13 }];
const PACK = [{ id: 385, name: 'Shark', count: 1 }, { id: 385, name: 'Shark', count: 1 }, { id: 563, name: 'Law rune', count: 2 }, { id: 556, name: 'Air rune', count: 10 }, { id: 175, name: 'Antipoison(3)', count: 1 }];
const view = (name: string, o: Partial<StatusView> = {}): StatusView => ({ name, at: T0, hp: 99, maxHp: 99, ...POST, magic: 99, inventory: PACK, equipment: KIT, ...o });
const feed = (lines: string[], repeat = false) => { const w = newWatch(T0); for (const line of lines) { const e = readLine(w, line, T0, { repeat }); if (e) return { w, e }; } return { w, e: null }; };

describe('log lines', () => {
    test('kills and fallbacks are counted and end nothing', () => {
        const { w, e } = feed(['[A] PK kill Sugma after 41 ticks', '[B] PK kill Ligma after 60 ticks', '[A] PK kill Sugma after 30 ticks', '[A] SQUAD coordinated fallback (teleport) hp=40 enemies=3 allies=1', 'SQUAD march to 3067,3640 in 3 steps']);
        expect(e).toBeNull();
        expect([w.kills, w.fallbacks, [...w.killsBy]]).toEqual([3, 1, [['Sugma', 2], ['Ligma', 1]]]);
    });
    test('a death line names the account', () => {
        expect(feed(['[A] PK kill Sugma after 41 ticks', '[B] SQUAD died']).e).toEqual({ kind: 'death', account: 'B', detail: 'SQUAD died' });
        expect(feed(['[B] PK died to Goondelf after 88 ticks']).e?.kind).toBe('death');
        expect(feed(['[B] SQUAD died on a bank trip']).e?.kind).toBe('death');
    });
    test('a fight line with no tag, or with the tag of an account that is not watched, counts for nothing', () => {
        const w = newWatch(T0), watched = { repeat: false, accounts: new Set(['a', 'b']) };
        for (const line of ['PK died to A after 45 ticks', 'PK kill A after 45 ticks', '[Gang1] PK kill A after 45 ticks', '[Gang1] PK died to B after 9 ticks']) expect(readLine(w, line, T0, watched)).toBeNull();
        expect([w.kills, w.deaths]).toEqual([0, 0]);
        expect(readLine(w, '[B] PK kill Gang1 after 30 ticks', T0, watched)).toBeNull();
        expect(readLine(w, '[A] PK died to Gang1 after 45 ticks', T0, watched)).toMatchObject({ kind: 'death', account: 'A' });
        expect([w.kills, w.deaths]).toEqual([1, 1]);
    });
    test('a RESULT ok with a death is a death, and one with none ends the watch', () => {
        expect(feed(['RESULT ok squad accounts=4 kills=5 died=1 taken=800 trips=2 picked={}']).e).toMatchObject({ kind: 'death', account: '-' });
        expect(feed(['RESULT ok squad accounts=4 kills=5 died=0 taken=300 trips=2 picked={}']).e).toMatchObject({ kind: 'ended' });
        expect(feed(['RESULT ok squad accounts=4 kills=5 died=0 taken=300 trips=2 picked={}'], true).e).toBeNull();
        expect(feed(['RESULT ok squad accounts=4 kills=5 died=2 taken=300 trips=2 picked={}'], true).e?.kind).toBe('death');
    });
    test('a fail RESULT, a bank trip fault, a drop and an unconfirmed logout each end the watch', () => {
        expect(feed(['RESULT fail squad accounts=4 kills=0 died=0 taken=0 trips=0 picked={} stranded=A']).e).toMatchObject({ kind: 'fail-result' });
        expect(feed(['[C] SQUAD bank trip: bank lacks trip requirements [{"id":2446,"unit":"doses","required":4,"available":3,"reason":"units"}]']).e).toMatchObject({ kind: 'bank-trip', account: 'C' });
        expect(feed(['[C] SQUAD no trips left']).e).toEqual({ kind: 'bank-trip', account: 'C', detail: 'no trips left' });
        expect(feed(['[D] SQUAD session ended: tick stream stalled: no new game tick for 30000ms']).e).toMatchObject({ kind: 'session-dropped', account: 'D' });
        expect(feed(['LOGOUT logged-out logged-out logged-out logged-out']).e).toBeNull();
        expect(feed(['LOGOUT logged-out disconnected logged-out logged-out']).e).toEqual({ kind: 'logout-unconfirmed', account: '-', detail: 'logged-out disconnected logged-out logged-out' });
    });
    test('the supervisor end is an event unless it is done', () => {
        expect(feed(['SUPERVISE end done after 1 runs']).e).toBeNull();
        expect(feed(['SUPERVISE end blocked after 2 runs']).e).toEqual({ kind: 'supervisor-end', account: '-', detail: 'blocked after 2 runs' });
    });
});

describe('status files', () => {
    test('HP lost between two reads and a bank trip are counted', () => {
        const w = newWatch(T0);
        expect(readStatuses(w, [view('A'), view('B')], T0, cfg)).toBeNull();
        expect(readStatuses(w, [view('A', { hp: 60 }), view('B', { hp: 90 })], T0 + 5000, cfg)).toBeNull();
        expect(readStatuses(w, [view('A', { hp: 80, ...BANK }), view('B', { hp: 70 })], T0 + 10_000, cfg)).toBeNull();
        expect([w.hpLost, w.trips, w.deaths]).toEqual([39 + 9 + 20, 1, 0]);
    });
    test('an account at the Lumbridge spawn after the Wilderness died', () => {
        const w = newWatch(T0);
        readStatuses(w, [view('A')], T0, cfg);
        expect(readStatuses(w, [view('A', { x: 3222, z: 3219, hp: 99 })], T0 + 5000, cfg)).toEqual({ kind: 'death', account: 'A', detail: 'stands at 3222,3219 after Wilderness level 16' });
        expect([w.deaths, w.trips]).toEqual([1, 0]);
    });
    test('low HP with no food and no escape is danger; food, an escape or a glory is not', () => {
        const low = { hp: 22, inventory: [{ id: 556, name: 'Air rune', count: 10 }] };
        expect(readStatuses(newWatch(T0), [view('A', low)], T0, cfg)).toEqual({ kind: 'in-danger', account: 'A', detail: 'HP 22 at Wilderness level 16 with no food and no escape teleport' });
        expect(readStatuses(newWatch(T0), [view('A', { hp: 22 })], T0, cfg)).toBeNull();
        expect(readStatuses(newWatch(T0), [view('A', { hp: 22, inventory: [{ id: 563, name: 'Law rune', count: 1 }, { id: 556, name: 'Air rune', count: 5 }] })], T0, cfg)).toBeNull();
        expect(readStatuses(newWatch(T0), [view('A', { ...low, equipment: [...KIT, { id: 1712, name: 'Amulet of glory(4)', count: 1, slot: 2 }] })], T0, cfg)).toBeNull();
        expect(readStatuses(newWatch(T0), [view('A', { ...low, ...BANK })], T0, cfg)).toBeNull();
    });
    test('an account that walks in with no leg armour or no food is named', () => {
        const w = newWatch(T0);
        readStatuses(w, [view('A', BANK), view('B', BANK)], T0, cfg);
        expect(readStatuses(w, [view('A'), view('B', { ...POST, equipment: KIT.filter(e => e.slot !== 7), inventory: [] })], T0 + 5000, cfg)).toEqual({ kind: 'kit-missing', account: 'B', detail: 'walked into the Wilderness with no leg armour, no food' });
    });
    test('no kill for the limit, and a quiet log with stale status files', () => {
        const w = newWatch(T0);
        expect(readStatuses(w, [view('A', { at: T0 + 19 * 60_000 })], T0 + 19 * 60_000, cfg)).toBeNull();
        expect(readStatuses(w, [view('A', { at: T0 + 21 * 60_000 })], T0 + 21 * 60_000, cfg)).toEqual({ kind: 'no-kill', account: '-', detail: 'no kill for 21 minutes' });
        const quiet = newWatch(T0);
        readLine(quiet, '[A] PK kill Sugma after 41 ticks', T0 + 60_000, cfg);
        expect(readStatuses(quiet, [view('A', { at: T0 + 60_000 })], T0 + 3 * 60_000, cfg)).toBeNull();
        expect(readStatuses(quiet, [view('A', { at: T0 + 60_000 })], T0 + 6 * 60_000, cfg)).toEqual({ kind: 'process-gone', account: '-', detail: 'no log line and no status write for 5 minutes' });
    });
    test('the summary and the event line', () => {
        const w = newWatch(T0);
        readLine(w, '[A] PK kill Sugma after 41 ticks', T0, cfg);
        readStatuses(w, [view('A'), view('B')], T0, cfg);
        readStatuses(w, [view('A', { hp: 64 }), view('B')], T0 + 5000, cfg);
        const views = [view('A', { hp: 64 }), view('B')];
        expect(supplies(views)).toBe('A:2/280/2/1 B:2/280/2/1');
        expect(summary(w, views, T0 + 10 * 60_000)).toBe('SQUAD_WATCH ok minutes=10 kills=1 (Sugma 1) deaths=0 hpLostSampled=35 hpPerKill=35 trips=0 fallbacks=0 hp=A:64 B:99 food/arrows/law/antipoison=A:2/280/2/1 B:2/280/2/1');
        expect(eventLine(w, { kind: 'death', account: 'B', detail: 'SQUAD died' })).toBe('SQUAD_WATCH event=death account=B detail="SQUAD died" kills=1 deaths=0 trips=0');
    });
    test('a status file becomes a view, with a noted item as its plain item', () => {
        const s = statusView({ name: 'A', at: 7, hp: { now: 50, max: 99 }, pos: { x: 3067, z: 3640, level: 0 }, skills: [{ name: 'Magic', level: 80 }], inventory: [{ id: 386, baseId: 385, name: 'Shark', count: 5, slot: 0 }], equipment: [{ slot: 4, id: 1113, baseId: 1113, name: 'Rune chainbody', count: 1 }] })!;
        expect([s.hp, s.magic, s.inventory, s.equipment[0]!.slot]).toEqual([50, 80, [{ id: 385, name: 'Shark', count: 5 }], 4]);
        expect(statusView({ name: 'A' })).toBeNull();
    });
});

test('tail returns whole new lines and keeps a line with no line end for the next read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'squad-watch-')), file = join(dir, 'squad.log');
    try {
        expect(tail(file, 0)).toEqual({ lines: [], offset: 0 });
        writeFileSync(file, 'one\ntwo\nthr');
        const first = tail(file, 0);
        expect(first).toEqual({ lines: ['one', 'two'], offset: 8 });
        appendFileSync(file, 'ee\r\nfour\n');
        expect(tail(file, first.offset)).toEqual({ lines: ['three', 'four'], offset: 20 });
        writeFileSync(file, 'new\n');
        expect(tail(file, 20)).toEqual({ lines: ['new'], offset: 4 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
