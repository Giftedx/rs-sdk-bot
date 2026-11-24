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
import { createWorld, rsPathLength } from '../src/world';
import { loadDanger } from '../src/randomevents';
import { hostedEntrySource } from '../src/host';
import { magicKit, rangedKit, denseSpawns, killSpawns } from '../src/gather';
import { classifyTick, startLedger } from '../src/ledger';
import { safeCandidates } from '../src/combat-end';

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

test('loadDanger disk cache matches uncached parse and recovers from corrupt or stale cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'danger-cache-'));
    try {
        const cacheFile = join(dir, 'danger-v1.json');
        const uncached = loadDanger('');
        const first = loadDanger(cacheFile);
        const second = loadDanger(cacheFile);
        expect(first).toEqual(uncached);
        expect(second).toEqual(uncached);
        writeFileSync(cacheFile, '{corrupt json');
        expect(loadDanger(cacheFile)).toEqual(uncached);
        const broken = JSON.parse(readFileSync(cacheFile, 'utf8'));
        broken.pack = 'stale';
        writeFileSync(cacheFile, JSON.stringify(broken));
        expect(loadDanger(cacheFile)).toEqual(uncached);
        const brokenDir = JSON.parse(readFileSync(cacheFile, 'utf8'));
        brokenDir.dirs[0][1] = 'stale';
        writeFileSync(cacheFile, JSON.stringify(brokenDir));
        expect(loadDanger(cacheFile)).toEqual(uncached);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('hostedEntrySource template cache substitutes per-bot ids accurately', () => {
    const src = `import { openBot } from '../packages/core/src/bot';
const label = "import.meta.main";
if (import.meta.main) {
    console.log(process.argv[2], label);
    void openBot('a');
}
`;
    const scriptDir = join(process.cwd(), 'scripts');
    const a = hostedEntrySource(src, 'bot-alpha', scriptDir);
    const b = hostedEntrySource(src, "bot'beta\\1", scriptDir);
    expect(a).toContain('globalThis.__rsBotHost.get("bot-alpha")');
    expect(a).toContain('hostbot=bot-alpha');
    expect(a).not.toContain('bot-beta');
    expect(b).toContain('globalThis.__rsBotHost.get("bot\'beta\\\\1")');
    expect(b).toContain("hostbot=bot\\'beta\\\\1");
    expect(b).not.toContain('bot-alpha');
    expect(a).toContain('"import.meta.main"');
});

test('createWorld routes multi-hop and repeated waypoint goals consistently with cached lower bounds', () => {
    const t1 = {
        locName: 'stairs1',
        option: 'op1',
        from: { x: 100, z: 100, level: 0 },
        to: { x: 200, z: 200, level: 1 },
        exact: true,
        src: 'a',
        toSrc: 'b',
        handler: 'h',
    };
    const t2 = {
        locName: 'stairs2',
        option: 'op1',
        from: { x: 210, z: 200, level: 1 },
        to: { x: 300, z: 300, level: 2 },
        exact: true,
        src: 'c',
        toSrc: 'd',
        handler: 'h',
    };
    const flat = (from: { x: number; z: number; level: number }, to: { x: number; z: number; level: number }) =>
        (from.level === to.level ? Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z)) : null);
    const w = createWorld({ transports: [t1, t2], doors: [], pathLength: flat });
    const acct = { skills: {}, varps: {}, items: [] };
    const r1 = w.route({ x: 95, z: 100, level: 0 }, t2.to, acct);
    const r2 = w.route({ x: 90, z: 100, level: 0 }, t2.to, acct);
    const rDyn = w.route({ x: 95, z: 100, level: 0 }, { x: 305, z: 300, level: 2 }, acct);
    expect(r1).toMatchObject({ ok: true, cost: 5 + 3 + 10 + 3 });
    expect(r2).toMatchObject({ ok: true, cost: 10 + 3 + 10 + 3 });
    expect(rDyn).toMatchObject({ ok: true, cost: 5 + 3 + 10 + 3 + 5 });
});

test('ledger startLedger and classifyTick preserve inventory and stun parity with reused state objects', () => {
    const callbacks = new Set<() => void>();
    let tick = 0;
    const inv = [{ id: 314, count: 10 }];
    const skills = [{ name: 'Attack', experience: 100 }];
    const player = { worldX: 3200, worldZ: 3200, level: 0, animId: -1, combat: { lastDamageTick: -1 } };
    const state: any = { tick: 0, player, skills, inventory: inv, gameMessages: [], combatEvents: [] };
    const ledger = startLedger({
        sdk: { getState: () => state },
        onTick: cb => { callbacks.add(cb); return () => callbacks.delete(cb); },
        tick: () => tick,
    }, () => 'walkTo');

    // Reorder / split stack in-place: total count unchanged -> idle.
    tick = 1; state.tick = 1;
    inv.length = 0;
    inv.push({ id: 314, count: 4 }, { id: 314, count: 6 });
    for (const cb of callbacks) cb();

    // Actual count change -> inventory.
    tick = 2; state.tick = 2;
    inv[1]!.count = 7;
    for (const cb of callbacks) cb();

    // Stun message -> stun.
    tick = 3; state.tick = 3;
    state.gameMessages = [{ tick: 3, text: 'You have been stunned!' }];
    for (const cb of callbacks) cb();

    const summary = ledger.stop();
    expect(summary.counts).toMatchObject({ idle: 1, inventory: 1, stun: 1 });
    expect(classifyTick({ inventory: [{ id: 314, count: 10 }, null] }, { inventory: [null, { id: 314, count: 4 }, { id: 314, count: 6 }] })).toBe('idle');
    expect(classifyTick({ inventory: [{ id: 314, count: 10 }] }, { inventory: [{ id: 314, count: 11 }] })).toBe('inventory');
});

test('gather kits, spawn clustering, and combat-end safeCandidates preserve selection invariants', () => {
    const staffOwned = [{ id: 558, count: 6 }, { id: 556, count: 12 }, { id: 554, count: 18 }, { id: 1387, count: 1 }];
    expect(magicKit(staffOwned, 13, 6)).toEqual({
        staff: 1387,
        component: 'magic:fire_strike',
        level: 13,
        maxhit: 8,
        runes: { 558: 1, 556: 2 },
    });
    expect(rangedKit([{ id: 841, count: 1 }, { id: 882, count: 10 }, { id: 884, count: 15 }])).toEqual({
        bow: 841,
        arrows: 884,
    });
    const goblins = killSpawns(288);
    expect(goblins.length).toBeGreaterThan(10);
    expect(denseSpawns(goblins).length).toBeGreaterThan(0);

    const sq = [{ x: 3200, z: 3200, r: 4, name: 'guard' }];
    const cands = safeCandidates({ x: 3200, z: 3200, level: 0 }, sq, 10);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every(c => Math.max(Math.abs(c.x - 3200), Math.abs(c.z - 3200)) > 4)).toBe(true);
});
