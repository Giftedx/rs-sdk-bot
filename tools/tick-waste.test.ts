import { expect, test } from 'bun:test';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLineTimestamp, familyOf, fareWaste, idleReasons, liveTickOffenders, parseTickWasteArgs, scriptFamilyOf, tickWaste, tickWasteByAccount, wasteShare } from './tick-waste';

test('fare detours sum the planner and walkPath extra ticks per account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fare-waste-'));
    writeFileSync(join(dir, 'host-Toller.log'), [
        'WALK_DETOUR {"from":{"x":3222,"z":3218,"level":0},"cost":307,"paidCost":125,"extra":182}',
        '  | WALK_FARE_FAIL {"crossing":"Al Kharid toll gate","fare":10,"coins":0}',
        '  | WALK_DETOUR {"crossing":"Al Kharid toll gate","throughTiles":60,"roundTiles":250}',
        'WALK_DETOUR {cut',
    ].join('\n'));
    expect(fareWaste(dir).get('Toller')).toEqual({ detours: 3, extra: 372, fareFails: 1 });
});

const ledger = 'LEDGER ticks=1000 move=100 anim=0 dialog=0 stun=0 idle=900';
const marker = (id: string) => 'SWARM_JOB ' + id.repeat(64);
function report(lines: string[], latest = false) {
    const dir = mkdtempSync(join(tmpdir(), 'tick-waste-'));
    writeFileSync(join(dir, 'account.log'), lines.join('\n') + '\n');
    return tickWaste(dir, { latest });
}

test('--latest counts each family only on the release of its newest run', () => {
    const run = (release: string | null, idle: number) => [marker('a'), ...(release ? ['START 1 2 0', `RELEASE ${release}`] : ['START 1 2 0']),
        `LEDGER ticks=1000 move=0 anim=0 dialog=0 stun=0 idle=${idle}`, 'RESULT fail feathers=2000 gained=0 kills=0 idle=0 ticks=2'];
    const lines = [...run(null, 900), ...run('aaaaaaaaaaaa', 800), ...run('bbbbbbbbbbbb', 100), ...run('bbbbbbbbbbbb', 300)];
    expect(report(lines).get('gather-feathers')?.idle).toBe(2100);
    expect(report(lines, true).get('gather-feathers')).toMatchObject({ runs: 2, idle: 400, release: 'bbbbbbbbbbbb' });
    expect(wasteShare(report(lines, true))['gather-feathers']).toBe(0.2);
    expect(wasteShare(report(lines))['gather-feathers']).toBe(0.525);
    // A run from before RELEASE lines in a new job is `unknown`, not the release of the job before it.
    expect(report([...run('cccccccccccc', 50), ...run(null, 70)], true).get('gather-feathers')).toMatchObject({ runs: 1, idle: 70, release: 'unknown' });
});

test('tick waste leaves a ledger unattributed if only the next job has a result', () => {
    const agg = report([marker('a'), ledger, marker('b'), 'RESULT ok coinsGained=10']);
    expect(agg.get('?')?.ticks).toBe(1000);
    expect(wasteShare(agg, 1).goldfarm).toBeUndefined();
});

test('the same job and legacy hosted output retain their existing family attribution', () => {
    for (const prefix of [[marker('a')], []]) {
        const agg = report([...prefix, '[Worker] ' + ledger, 'noise', '| [Worker] RESULT ok coinsGained=10']);
        expect(agg.get('goldfarm')).toEqual({runs:1,ticks:1000,idle:900,move:100,anim:0,stun:0,dialog:0,standStill:900,maxStandStill:0,idleBy:{}});
    }
});

test('idle reasons of the LEDGER lines add up by family', () => {
    expect(idleReasons('LEDGER ticks=9 idle=5 longestIdle=3@t1(1,2) idleBy=combat:3,after:walkTo:2')).toEqual({combat: 3, 'after:walkTo': 2});
    expect(idleReasons(ledger)).toEqual({});
    const agg = report([marker('a'), ledger + ' idleBy=combat:600,bank:300', 'RESULT ok coinsGained=1', marker('b'), ledger + ' idleBy=combat:100', 'RESULT ok coinsGained=2']);
    expect(agg.get('goldfarm')?.idleBy).toEqual({combat: 700, bank: 300});
    expect(agg.get('goldfarm')?.standStill).toBe(1100);
});

test('structured script= fields on LEDGER and RELEASE classify without guessing from RESULT', () => {
    const lines = [
        marker('a'),
        'RELEASE aaaaaaaaaaaa script=aio-logistics:walk-to',
        'LEDGER ticks=500 xp=0 inventory=0 move=250 anim=0 dialog=0 stun=0 idle=250 idlePct=50.0 xpGain=0 longestIdle=40@t10(3200,3200) idleBy=after:walkTo:250 standStill=250 standStillPct=50.0 maxStandStill=40@t10(3200,3200) script=aio-logistics:walk-to bot=Mover',
        'RESULT fail Error: stuck',
    ];
    const agg = report(lines);
    expect(agg.get('walk-to')).toMatchObject({ runs: 1, ticks: 500, standStill: 250, maxStandStill: 40 });
    expect(scriptFamilyOf('aio-skiller:gather/yews')).toBe('gather-yews');
    expect(scriptFamilyOf('aio-skiller:rune-bank-craft')).toBe('rune-bank-craft');
});

test('widened lookahead and expanded SIG patterns collapse legacy ? and other:* buckets', () => {
    const padding = Array.from({ length: 15 }, (_, i) => `EVENT noise ${i}`);
    const agg = report([
        marker('a'),
        'LEDGER ticks=200 move=50 anim=0 dialog=0 stun=0 idle=150 idleBy=after:interactNpc:150 bot=Fighter',
        ...padding,
        'RESULT ok mode=giant kills=12',
    ]);
    expect(agg.get('combat')?.ticks).toBe(200);
    expect(familyOf('ticks=500 kills=20 looted=10')).toBe('combat');
    expect(familyOf('mode=smith {"ok":true}')).toBe('smelt');
    expect(familyOf('{"ok":true,"magicXp":500,"product":2552}')).toBe('enchant');
    expect(familyOf('{"ok":true,"phase":"settled","foodUsed":0}')).toBe('ge-market');
    expect(familyOf('{"ok":true,"recipe":"identify:guam"}')).toBe('bank-artisan');
    expect(familyOf('alch level=55 high=10')).toBe('alch');
    expect(familyOf('walk-to {"ok":true}')).toBe('walk-to');
    expect(familyOf('travel to varrock failed: no route')).toBe('travel');
    expect(familyOf('transferred 500')).toBe('fleet-trade');
    expect(familyOf('banked_karambwanji=200')).toBe('gather-fish');
    expect(familyOf('inspection ok')).toBe('bank-logistics');
    expect(familyOf('PK run {"kills":1}')).toBe('pk-squad');
    expect(familyOf('shop-to-bid coins 1000')).toBe('shop-buyer');
    expect(familyOf('agility-order gnome')).toBe('agility');
    expect(familyOf('magic-order fire_strike')).toBe('magic');
});

test('--since-hours filters old log files and tickWasteByAccount aggregates per bot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tick-waste-hours-'));
    const now = 1_700_000_000_000;
    const oldFile = join(dir, 'OldBot.log');
    const newFile = join(dir, 'NewBot.log');
    writeFileSync(oldFile, `${ledger} standStill=900 maxStandStill=50@t1(0,0) script=goldfarm bot=OldBot\n`);
    writeFileSync(newFile, `${ledger} standStill=400 maxStandStill=30@t1(0,0) script=goldfarm bot=NewBot\n`);
    const oldSec = (now - 10 * 3_600_000) / 1000;
    const newSec = (now - 1 * 3_600_000) / 1000;
    utimesSync(oldFile, oldSec, oldSec);
    utimesSync(newFile, newSec, newSec);

    const recent = tickWaste(dir, { sinceHours: 4, now });
    expect(recent.get('goldfarm')?.runs).toBe(1);
    expect(recent.get('goldfarm')?.standStill).toBe(400);

    const accts = tickWasteByAccount(dir, { sinceHours: 4, now });
    expect(accts.has('OldBot')).toBe(false);
    expect(accts.get('NewBot')).toMatchObject({ runs: 1, ticks: 1000, standStill: 400, maxStandStill: 30, families: ['goldfarm'] });
    expect(parseTickWasteArgs(['--latest', '--since-hours', '6', '500', '--by-account'])).toEqual({ latest: true, sinceHours: 6, minTicks: 500, byAccount: true });
});

test('liveTickOffenders reads live status tickStats and timeline fallbacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-offenders-'));
    const now = 1_700_000_000_000;
    writeFileSync(join(dir, 'StuckBot.json'), JSON.stringify({
        name: 'StuckBot', at: now - 2000, pos: { x: 3200, z: 3200, level: 0 },
        tickStats: { ticks: 200, standStillPct: 75, windowStandStillPct: 80, currentStandStill: 45, maxStandStill: 45, currentStandStillWhy: 'after:interactLoc', currentStandStillAt: '3200,3200', script: 'shop-buyer' },
    }));
    writeFileSync(join(dir, 'LegacyBot.json'), JSON.stringify({
        name: 'LegacyBot', at: now - 3000, goal: 'goldfarm.ts', timeline: 'xx' + 'i'.repeat(25), pos: { x: 3100, z: 3100, level: 0 },
    }));
    writeFileSync(join(dir, 'DoneBot.json'), JSON.stringify({ name: 'DoneBot', at: now - 1000, result: 'ok done', timeline: 'i'.repeat(50) }));
    const offenders = liveTickOffenders(dir, { now });
    expect(offenders.map(o => o.name)).toEqual(['StuckBot', 'LegacyBot']);
    expect(offenders[0]).toMatchObject({ currentStandStill: 45, why: 'after:interactLoc', script: 'shop-buyer' });
    expect(offenders[1]).toMatchObject({ currentStandStill: 25, script: 'goldfarm.ts' });
});

test('--since-hours filters per-run timestamps inside active log files and falls back to file mtime only when un-timestamped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tick-waste-per-run-'));
    const now = 1_795_776_000_000;
    const oldAt = now - 5 * 3_600_000;
    const recentAt = now - 15 * 60_000;
    const oldIso = new Date(oldAt).toISOString();
    const recentIso = new Date(recentAt).toISOString();

    expect(extractLineTimestamp(`LEDGER ticks=500 move=0 idle=500 at=${recentAt} bot=BotA`)).toBe(recentAt);
    expect(extractLineTimestamp(`START 3185 3436 0 ${oldIso}`)).toBe(oldAt);
    expect(extractLineTimestamp(`FLEET_RECEIPT {"at":${recentAt}}`)).toBe(recentAt);
    expect(extractLineTimestamp('LEDGER ticks=500 move=0 idle=500')).toBeNull();

    const activeFile = join(dir, 'ActiveBot.log');
    writeFileSync(activeFile, [
        marker('a'),
        `START 3185 3436 0`,
        `RELEASE aaaaaaaaaaaa script=goldfarm`,
        `${ledger} standStill=900 maxStandStill=90@t1(0,0) script=goldfarm at=${oldAt} bot=ActiveBot`,
        'RESULT ok coinsGained=10',
        marker('b'),
        `START 3185 3436 0 ${oldIso}`,
        `RELEASE aaaaaaaaaaaa script=goldfarm`,
        `${ledger} standStill=800 maxStandStill=80@t1(0,0) script=goldfarm bot=ActiveBot`,
        'RESULT ok coinsGained=20',
        marker('c'),
        `START 3185 3436 0`,
        `RELEASE bbbbbbbbbbbb script=goldfarm`,
        `${ledger} standStill=120 maxStandStill=12@t1(0,0) script=goldfarm at=${recentAt} bot=ActiveBot`,
        'RESULT ok coinsGained=30',
        marker('d'),
        `START 3185 3436 0`,
        `RELEASE bbbbbbbbbbbb script=aio-logistics:walk-to`,
        `${ledger} standStill=50 maxStandStill=5@t1(0,0) script=aio-logistics:walk-to bot=ActiveBot`,
        `FLEET_RECEIPT {"at":${recentAt}}`,
        'RESULT ok walk-to done',
    ].join('\n') + '\n');

    // Legacy file with no per-run timestamps falls back to file mtime.
    const legacyFile = join(dir, 'LegacyBot.log');
    writeFileSync(legacyFile, `${ledger} standStill=300 script=shop-buyer bot=LegacyBot\n`);
    const recentSec = (now - 10 * 60_000) / 1000;
    utimesSync(activeFile, recentSec, recentSec);
    utimesSync(legacyFile, recentSec, recentSec);

    const lastHour = tickWaste(dir, { sinceHours: 1, now });
    // Old runs (5h ago) inside ActiveBot.log are excluded despite ActiveBot.log having a recent mtime.
    expect(lastHour.get('goldfarm')).toMatchObject({ runs: 1, standStill: 120, maxStandStill: 12 });
    expect(lastHour.get('walk-to')).toMatchObject({ runs: 1, standStill: 50, maxStandStill: 5 });
    expect(lastHour.get('shop-buyer')).toMatchObject({ runs: 1, standStill: 300 });
    expect(tickWasteByAccount(dir, { sinceHours: 1, now }).get('ActiveBot')).toMatchObject({ runs: 2, standStill: 170 });

    // Expanding window to 6 hours includes the older timestamped runs too.
    expect(tickWaste(dir, { sinceHours: 6, now }).get('goldfarm')?.runs).toBe(3);
    expect(recentIso).toContain('T');
});
