import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marketQuotes, shopLots } from '../src/market-cache';
import { commandLine, processStartTimes } from '../src/proc';
import { ThreatBook, decideAdapt, type Member, type Sighting } from '../src/pvp-threat';
import { decodeAppearance, digest, model } from '../src/rival-feed';
import { loadTravel } from '../src/travel';
import { loadPathfinding } from '../src/pathcache';
import { rsPathLength } from '../src/world';

test('loadTravel cache matches cold parse and recovers cleanly from corrupt cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'travel-cache-'));
    try {
        const cacheFile = join(dir, 'travel-v1.json');
        const uncached = loadTravel('');
        const first = loadTravel(cacheFile);
        const second = loadTravel(cacheFile);
        expect(first).toEqual(uncached);
        expect(second).toEqual(uncached);
        writeFileSync(cacheFile, '{corrupt json');
        expect(loadTravel(cacheFile)).toEqual(uncached);
        const broken = JSON.parse(readFileSync(cacheFile, 'utf8'));
        broken.stamps[0][1] = 'stale';
        writeFileSync(cacheFile, JSON.stringify(broken));
        expect(loadTravel(cacheFile)).toEqual(uncached);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('dead PIDs skip PowerShell lookups in commandLine and processStartTimes', () => {
    const deadPid = 2_147_483_000;
    const t0 = performance.now();
    expect(commandLine(deadPid)).toBeNull();
    const starts = processStartTimes([deadPid]);
    expect(starts === null || starts.size === 0).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
});

test('marketQuotes and shopLots preserve exact filtering and sorting semantics', () => {
    const now = 1_700_000_000_000;
    const raw = {
        at: now - 1000,
        items: {
            '314': { name: 'Feather', price: 3, bid: 4, ask: 5, trades: 10, base: 2, want: 5000, sell: 100 },
            '999': { name: 'NullBid', price: 1, bid: null, ask: 10, trades: 1, base: 5, want: 10, sell: 2 },
            '998': { name: 'ZeroBid', price: 1, bid: 0, ask: 10, trades: 1, base: 5, want: 10, sell: 2 },
            badKey: { name: 'Skip', price: 1, bid: 1, ask: 1, trades: 1, sell: 1 },
        },
    };
    const quotes = marketQuotes(raw, now);
    expect(quotes).toEqual({
        314: { at: now - 1000, ask: 5, bid: 4, sell: 100, trades: 10 },
        999: { at: now - 1000, ask: 10, bid: null, sell: 2, trades: 1 },
    });
    const lots = shopLots(
        raw.items as any,
        {
            shopA: { items: [{ re: /feather/i }] },
            shopB: { items: [{ re: /bad/i }] },
        },
        (_profiles, qs) => qs.filter(q => q.bid !== null).map(q => ({
            profile: q.id === 314 ? 'shopA' : 'shopB',
            id: q.id,
            name: q.name,
            bid: q.bid!,
            want: q.buyQuantity,
            margin: q.bid! - q.basePrice,
        })),
        (_items, qs) => qs.reduce((sum, q) => sum + (q.bid ?? 0) * q.buyQuantity, 0),
        1000,
    );
    expect(lots).toEqual([
        { profile: 'shopA', value: 20_000, items: [{ id: 314, name: 'Feather', bid: 4, want: 5000, margin: 2 }] },
    ]);
});

test('rival-feed decodeAppearance, digest, and model preserve prayer, attack, eat, and death tracking', () => {
    const buf = Buffer.alloc(42);
    buf[1] = 8; // melee protect headicon
    let v = 0n;
    for (const ch of 'rival') v = v * 37n + BigInt(' abcdefghijklmnopqrstuvwxyz0123456789'.indexOf(ch));
    for (let i = 7; i >= 0; i--) { buf[33 + i] = Number(v & 0xffn); v >>= 8n; }
    buf[41] = 95;
    const ap = buf.toString('base64');
    expect(decodeAppearance(ap)).toEqual({ name: 'rival', combat: 95, worn: [] });
    expect(decodeAppearance('AA')).toBeNull();

    const lines = [
        JSON.stringify({ t: 'roster', k: 1, p: [[1, 'Rival', 3100, 3600, 0, 95], [2, 'Victim', 3101, 3600, 0, 90]] }),
        JSON.stringify({ t: 'tick', k: 2, r: 1, p: [{ i: 1, x: 3100, z: 3600, fe: 32768 + 2, ap, an: [376], hp: [40] }, { i: 2, x: 3101, z: 3600, hm: [[12, 1]] }] }),
        JSON.stringify({ t: 'tick', k: 5, r: 1, p: [{ i: 1, m: [1], fe: 32768 + 2, an: [829], hp: [55] }] }),
        JSON.stringify({ t: 'tick', k: 6, r: 1, p: [{ i: 1, m: [1], fe: 32768 + 2, an: [1062], hp: [55] }] }),
        JSON.stringify({ t: 'tick', k: 7, r: 1, p: [{ i: 2, an: [836] }] }),
    ];
    const d = digest(lines, new Set(['rival']));
    expect(d.prayers).toEqual([{ tick: 2, name: 'rival', on: 'melee', near: 'victim' }]);
    const m = model(d);
    expect(m).toMatchObject({
        fights: 1,
        attacks: 2,
        specials: 1,
        firstSpecialAfterAttacks: [1],
        eatAt: [55],
        hpLow: 40,
        maxHitOpen: 12,
        hitsOpen: 1,
        prayers: 1,
        ends: { 'target died': 1 },
    });
});

test('pvp-threat ThreatBook and decideAdapt pick nearest member and nearest covering threat without sort regressions', () => {
    const members: Member[] = [
        { name: 'Far', x: 3000, z: 3600, combat: 90, prayer: 50, prayerLevel: 60 },
        { name: 'Near', x: 3010, z: 3600, combat: 120, prayer: 50, prayerLevel: 60 },
    ];
    const book = new ThreatBook({
        friends: new Set(),
        weaponStyle: id => (id === 1 ? 'magic' : 'melee'),
        attackStyle: anim => (anim === 10 ? 'magic' : null),
        multiAt: () => false,
        wildAt: () => 15,
    });
    const sightings: Sighting[] = [
        { name: 'MageFar', combat: 115, x: 3014, z: 3600, inView: true, worn: { weapon: 1 }, anim: 10 },
        { name: 'MageNear', combat: 115, x: 3011, z: 3600, inView: true, worn: { weapon: 2 } },
    ];
    const records = book.observe(1, members, sightings);
    expect(records[0]!.nearest).toEqual({ member: 'Near', dist: 4 });
    expect(records[1]!.nearest).toEqual({ member: 'Near', dist: 1 });
    const classes = records.map(r => ({
        record: r,
        style: r.lastAttack?.style ?? r.weaponStyle,
        cover: r.lastAttack?.style ?? r.weaponStyle,
        by: (r.lastAttack ? 'attack' : 'weapon') as 'attack' | 'weapon',
        canHit: ['Near'],
        dangerous: true,
    }));
    const actions = decideAdapt(classes, members, { outclasses: (me, them) => them.combat > me.combat });
    expect(actions).toEqual([{ kind: 'protect', member: 'Near', style: 'melee', reason: 'MageNear melee by weapon, 1 tiles' }]);
});

test('world pathLength.measurePrechecked matches measure and invalidates interaction areas on door policy change', async () => {
    await loadPathfinding();
    const pl = await rsPathLength();
    const stairs = {
        id: 1738,
        shape: 10,
        angle: 0,
        width: 2,
        height: 2,
        blockAccessFlags: 0,
        src: 'maps/m50_50.jm2:6229',
        configSrc: 'scripts/ladders+stairs/configs/stairs.loc:82',
    };
    const pairs: [{ x: number; z: number; level: number }, { x: number; z: number; level: number }, number, typeof stairs | undefined][] = [
        [{ x: 3222, z: 3218, level: 0 }, { x: 3224, z: 3245, level: 0 }, 1, undefined],
        [{ x: 3222, z: 3218, level: 0 }, { x: 3204, z: 3229, level: 0 }, 2, stairs],
        [{ x: 3222, z: 3218, level: 0 }, { x: 2809, z: 3441, level: 0 }, 0, undefined],
    ];
    for (const [from, to, tol, interaction] of pairs) {
        expect(pl.measurePrechecked!(from, to, [], tol, interaction)).toBe(pl(from, to, [], tol, interaction));
    }
    const door = { x: 3207, z: 3222, level: 0 };
    expect(pl({ x: 3222, z: 3218, level: 0 }, { x: 3204, z: 3229, level: 0 }, [door], 2, stairs)).toBe(
        pl.measurePrechecked!({ x: 3222, z: 3218, level: 0 }, { x: 3204, z: 3229, level: 0 }, [door], 2, stairs),
    );
}, 120_000);
