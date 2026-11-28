import { expect, test } from 'bun:test';
import { BAIT_3PLUS1_OPTIONS, BAIT_3PLUS1_SWITCHES, buildTeamSideOptions, createTeamFocus, cureAfterEscape, pickEnemy, preferUnheldTargets, resolveTeamKit, shouldStopOnDying, shouldStopUnseen, team } from '../src/pvp/pk-team';
import { assessZeroRiskKit, getObjNames, itemCostOf, RING_OF_RECOIL_ID } from '../src/pvp/fight';
import { bait3Plus1Fixture, benchCases, GANG_STACK, teamBait3Plus1Pass } from '../../../scripts/measure/aio-bench-cases';

test('pickEnemy: pair takes its own enemy while in view, else the lowest bar; near the nearest', () => {
    const live = [{ f: 'a', p: { distance: 1 }, h: 0.9 }, { f: 'b', p: { distance: 3 }, h: 0.2 }, { f: 'c', p: { distance: 2 }, h: 0.5 }];
    const health = (x: { h: number }) => x.h;
    expect(pickEnemy(live, 'c', 'pair', health)?.f).toBe('c');
    expect(pickEnemy(live, 'd', 'pair', health)?.f).toBe('b');
    expect(pickEnemy(live, 'c', 'low', health)?.f).toBe('b');
    expect(pickEnemy(live, 'c', 'near', health)?.f).toBe('a');
    expect(pickEnemy([], 'c', 'pair', health)).toBeUndefined();
});

test('squadTarget takes the lowest bar of the targets in view, not a skipped one', async () => {
    const { squadTarget } = await import('../src/pvp/squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 2 }, { name: 'Ligma', index: 2, distance: 5 }, { name: 'Bystander', index: 3, distance: 1 }];
    const bars: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
    const targets = new Set(['goondelf', 'ligma', 'sugma']);
    expect(squadTarget(view, targets, p => bars[p.index]!)?.name).toBe('Ligma');
    expect(squadTarget(view, targets, p => bars[p.index]!, new Set(['ligma']))?.name).toBe('Goondelf');
    expect(squadTarget([view[2]!], targets, p => bars[p.index]!)).toBeUndefined();
});

test('meetTile: the nearest multi-way tile by the targets, under the depth limit', async () => {
    const { meetTile } = await import('../src/pvp/squad');
    const multi = (x: number, z: number) => x <= 3071 && x >= 3064 && z >= 3624 && z <= 3663;
    expect(meetTile([{ x: 3078, z: 3640 }, { x: 3080, z: 3642 }], 20, 24, multi)).toEqual({ x: 3071, z: 3641 });
    expect(meetTile([{ x: 3066, z: 3640 }], 20, 24, multi)).toEqual({ x: 3066, z: 3640 });
    expect(meetTile([{ x: 3078, z: 3640 }], 10, 24, multi)).toBeNull();
    expect(meetTile([], 20, 24, multi)).toBeNull();
});

test('marchRoute: a step each `step` tiles on the line, the goal last', async () => {
    const { marchRoute } = await import('../src/pvp/squad');
    expect(marchRoute({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 50)).toEqual([{ x: 3085, z: 3547 }, { x: 3076, z: 3593 }, { x: 3067, z: 3640 }]);
    expect(marchRoute({ x: 0, z: 0 }, { x: 3, z: 0 }, 12)).toEqual([{ x: 3, z: 0 }]);
});

test('multiEntry: the nearest multi-way tile toward the post', async () => {
    const { multiEntry } = await import('../src/pvp/squad');
    const multi = (x: number, z: number) => x <= 3071 && x >= 3040 && z >= 3600;
    expect(multiEntry({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 150, multi)).toEqual({ x: 3071, z: 3600 });
    expect(multiEntry({ x: 3066, z: 3620 }, { x: 3067, z: 3640 }, 150, multi)).toBeNull();
});

test('multiEntry takes the multi-way area connected to the post, not a nearer one', async () => {
    const { multiEntry, marchPlan } = await import('../src/pvp/squad');
    // Two areas: the post's (x 3040 to 3071, z 3600 and up) and a nearer one east (x 3130 to 3140, z 3530 to 3550).
    const multi = (x: number, z: number) => (x <= 3071 && x >= 3040 && z >= 3600) || (x >= 3130 && x <= 3140 && z >= 3530 && z <= 3550);
    expect(multiEntry({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 150, multi)).toEqual({ x: 3071, z: 3600 });
    // The real map: the post area starts at z 3600 and its tile nearest the Edgeville bank is the corner (the east zone is no entry).
    expect(multiEntry({ x: 3094, z: 3497 }, { x: 3067, z: 3640 })).toEqual({ x: 3071, z: 3600 });
    // From outside the Wilderness the march goes along the edge to the entry's x, then north to the area, then to the post.
    const plan = marchPlan({ x: 3094, z: 3497 }, { x: 3067, z: 3640 }, 12);
    expect(plan.every(s => s.x <= 3094 && s.x >= 3067)).toBe(true);
    expect(plan.find(s => s.z >= 3519 && s.z <= 3525)?.x).toBe(3071);
    expect(plan[plan.length - 1]).toEqual({ x: 3067, z: 3640 });
});

test('a pull may run 20 ticks and half a tick a tile of the distance', async () => {
    const { pullTicks, pullDistance, PULL_RANGE } = await import('../src/pvp/squad');
    expect(pullTicks(0)).toBe(20);
    expect(pullTicks(66)).toBe(53);
    expect(pullTicks(PULL_RANGE)).toBe(60);
    expect(pullTicks(500)).toBe(60);
    expect(pullDistance({ worldX: 3107, worldZ: 3574 }, { x: 3067, z: 3640 })).toBe(66);
    expect(PULL_RANGE).toBeGreaterThan(66);
});

test('the march waits for a member that holds, and not for a dropped, tripping or finished one', async () => {
    const { marchClose } = await import('../src/pvp/squad');
    const post = { x: 3071, z: 3519 }, near = { x: 3072, z: 3520 }, bank = { x: 3094, z: 3492 };
    const members = [{ name: 'a', at: near }, { name: 'b', at: bank }, { name: 'c', at: undefined }];
    expect(marchClose(members, post, new Set())).toBe(false);
    expect(marchClose(members, post, new Set(['b']))).toBe(true);
    expect(marchClose(members, post, new Set(['a']))).toBe(false);
    // The member that is outside the Wilderness is waited for like any other (the first walkers went in alone).
    expect(marchClose([{ name: 'a', at: near }, { name: 'b', at: bank }], { x: 3071, z: 3560 }, new Set())).toBe(false);
});

test('marchLegs: the edge, the entry of the connected area and the post', async () => {
    const { marchLegs } = await import('../src/pvp/squad');
    expect(marchLegs({ x: 3093, z: 3503 }, { x: 3067, z: 3640 })).toEqual([{ x: 3071, z: 3519 }, { x: 3071, z: 3600 }, { x: 3067, z: 3640 }]);
    // From inside the Wilderness there is no edge leg; a post that is not multi-way has no entry.
    expect(marchLegs({ x: 3090, z: 3560 }, { x: 3067, z: 3640 })).toEqual([{ x: 3071, z: 3600 }, { x: 3067, z: 3640 }]);
    expect(marchLegs({ x: 3093, z: 3503 }, { x: 3090, z: 3560 })).toEqual([{ x: 3090, z: 3560 }]);
});

test('an idle member keeps its prayer on near a target of the squad or after damage, and switches it off otherwise', async () => {
    const { keepPrayer } = await import('../src/pvp/squad');
    const targets = new Set(['goondelf', 'ligma']);
    const near = [{ name: 'Goondelf', distance: 5 }], far = [{ name: 'Goondelf', distance: 20 }], other = [{ name: 'Steve301', distance: 2 }];
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: -100 })).toBe(true);
    expect(keepPrayer({ view: far, targets, now: 100, damagedAt: -100 })).toBe(false);
    expect(keepPrayer({ view: other, targets, now: 100, damagedAt: -100 })).toBe(false);
    expect(keepPrayer({ view: [], targets, now: 100, damagedAt: 91 })).toBe(true);
    expect(keepPrayer({ view: [], targets, now: 100, damagedAt: 89 })).toBe(false);
});

test('an idle member turns off every active prayer but Protect Item while the survival helper keeps it on', async () => {
    const { idlePrayersOff } = await import('../src/pvp/squad');
    const { PRAYER } = await import('../src/pvp/fight');
    const active: boolean[] = [];
    active[PRAYER.item] = true;
    active[PRAYER.melee] = true;
    active[PRAYER.steelSkin] = true;
    const all = active.flatMap((on, i) => (on ? [i] : []));
    expect(idlePrayersOff(active, false)).toEqual(all);
    expect(idlePrayersOff(active, true)).toEqual(all.filter(i => i !== PRAYER.item));
    // Protect Item alone: no input, so the hold does not toggle it against the helper.
    const itemOnly: boolean[] = [];
    itemOnly[PRAYER.item] = true;
    expect(idlePrayersOff(itemOnly, true)).toEqual([]);
    expect(idlePrayersOff(itemOnly, false)).toEqual([PRAYER.item]);
});

test('squadTarget leaves out a target the game will not let it attack', async () => {
    const { squadTarget } = await import('../src/pvp/squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 3, z: 3515, combatLevel: 126 }, { name: 'Ligma', index: 2, distance: 5, z: 3640, combatLevel: 125 }];
    const bar: Record<number, number> = { 1: 0.2, 2: 0.9 };
    expect(squadTarget(view, new Set(['goondelf', 'ligma']), p => bar[p.index]!, new Set(), { z: 3640, combatLevel: 126 })?.name).toBe('Ligma');
});

test('shouldStopUnseen keeps waiting when enemies are in view under refusal cooldown', () => {
    expect(shouldStopUnseen(true, 101, 100)).toBe(false);
    expect(shouldStopUnseen(false, 100, 100)).toBe(false);
    expect(shouldStopUnseen(false, 101, 100)).toBe(true);
});

test('keepPrayer stays off under the start floor of Prayer, and the memory gate asks for the floor, one GiB for the process and a tenth of a GiB a bot', async () => {
    const { keepPrayer, squadMemoryGate } = await import('../src/pvp/squad');
    const targets = new Set(['goondelf']), near = [{ name: 'Goondelf', distance: 3 }];
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: -100, points: 80, base: 99 })).toBe(true);
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: -100, points: 70, base: 99 })).toBe(false);
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: 95, points: 30, base: 99 })).toBe(false);
    expect(squadMemoryGate(5.4, 4)).toEqual({ ok: true, needGB: 5.4 });
    expect(squadMemoryGate(5.3, 4)).toEqual({ ok: false, needGB: 5.4 });
    expect(squadMemoryGate(7.4, 24)).toEqual({ ok: true, needGB: 7.4 });
    expect(squadMemoryGate(4.1, 4).ok).toBe(false);
});

test('resolveTeamKit resolves gang-bait-3plus1 switches and options cleanly without mutating pk-kits', () => {
    const bait = resolveTeamKit('gang-bait-3plus1');
    expect(bait.switches).toEqual(BAIT_3PLUS1_SWITCHES);
    expect(bait.options).toEqual(BAIT_3PLUS1_OPTIONS);
    expect(bait.switches.ranged).toEqual([861, 2503]);
    expect(bait.switches.melee).toEqual([1231, 2503]);
    expect(bait.options.comboFood).toBe(true);
    expect(bait.options.zeroDrainFlick).toBe(true);
    expect(bait.options.protectItem).toBe(true);
    expect(bait.options.freeze).toBe('flee');

    const skull = resolveTeamKit('ganker-dds-skull');
    expect(skull.switches.melee).toEqual([1231]);
});

test('bait3Plus1Fixture satisfies strict zero-risk 3+1 death protection with Ring of recoil and BiS switches', () => {
    const names = getObjNames();
    const cfg = bait3Plus1Fixture(GANG_STACK.x + 2, GANG_STACK.z);
    const units = [...(cfg.equipment ?? []), ...(cfg.inventory ?? [])];
    const risk = assessZeroRiskKit(units, { cost: itemCostOf, nameOf: id => names.get(id), requireProtectItem: true });
    expect(risk.ok).toBe(true);
    expect(risk.riskedWeapons4).toEqual([]);
    expect(risk.riskedValuableGear4).toEqual([]);
    expect(risk.kept4).toEqual([1231, 2503, 2497, 861]);
    expect(cfg.equipment?.some(e => e.id === RING_OF_RECOIL_ID && e.slot === 12)).toBe(true);
    expect(cfg.equipment?.some(e => e.id === 2412 && e.slot === 1)).toBe(true);
    expect(cfg.equipment?.some(e => e.id === 1727 && e.slot === 2)).toBe(true);
    expect(cfg.equipment?.some(e => e.id === 1495 && e.slot === 9)).toBe(true);
    expect(cfg.equipment?.some(e => e.id === 3105 && e.slot === 10)).toBe(true);
    expect(cfg.inventory?.some(i => i.id === 577)).toBe(true);
    expect(cfg.inventory?.filter(i => i.id === 3144).length).toBe(4);
    expect(cfg.inventory?.length).toBeLessThanOrEqual(27);
    expect(cfg.varps?.[172]).toBe(1);
    expect(cfg.varps?.[78]).toBeUndefined();
});

test('extra:team-{24,25}v49-gang-bait-3plus1-x1 bench cases wire 49 skulled Protect-Item enemies and strict flags', () => {
    const cases = benchCases();
    for (const size of [24, 25] as const) {
        const key = `extra:team-${size}v49-gang-bait-3plus1-x1`;
        const c = cases.find(x => x.key === key);
        expect(c).toBeDefined();
        expect(c!.companions?.length).toBe(size + 49 - 1);
        expect(c!.presetConfig?.varps?.[78]).toBeUndefined();
        expect(c!.presetConfig?.equipment?.some(e => e.id === RING_OF_RECOIL_ID)).toBe(true);
        const sideACompanions = c!.companions!.slice(0, size - 1);
        const sideBCompanions = c!.companions!.slice(size - 1);
        expect(sideACompanions.length).toBe(size - 1);
        expect(sideBCompanions.length).toBe(49);
        for (const a of sideACompanions) {
            expect(a.presetConfig?.varps?.[78]).toBeUndefined();
            expect(a.presetConfig?.equipment?.some(e => e.id === RING_OF_RECOIL_ID)).toBe(true);
        }
        for (const b of sideBCompanions) {
            expect(b.presetConfig?.varps?.[78]).toBe(2000);
            expect(b.presetConfig?.equipment?.some(e => e.id === 1231)).toBe(true);
        }
        const args = c!.scriptArgs ?? [];
        expect(args).toContain(`SPAR_TEAM=${size}`);
        expect(args).toContain('SPAR_TEAM_B=49');
        expect(args).toContain('SPAR_KITS=gang-bait-3plus1:ganker-dds-skull');
        expect(args).toContain('SPAR_B_OPTS={"protectItem":true}');
        expect(args).toContain('NEVER_SKULL=1');
        expect(args).toContain('SPAR_PICKUP=1');
        expect(args).toContain('SPAR_PICKUP_RADIUS=4');
        expect(args).toContain('SQUAD_DAGGER=1');
        expect(args).toContain('STALL_TICKS=3000');
    }
});

test('teamBait3Plus1Pass enforces win, zero deaths, zero skulls, enemy kills, and looted enemy weapons', () => {
    const good = 'RESULT ok team groups=1 size=24 wins=1 losses=0 draws=0 ticks=1450 a=gang-hunter b=ganker-live standing=24-0 diedA=0 diedB=49 takenA=3200 picked=60 weapons=42 skulledA=0';
    expect(teamBait3Plus1Pass(good)).toBe(true);
    expect(teamBait3Plus1Pass(good.replace('skulledA=0', 'skulledA=1'))).toBe(false);
    expect(teamBait3Plus1Pass(`PK NEVER_SKULL VIOLATION: ownSkull=1\n${good}`)).toBe(false);
    expect(teamBait3Plus1Pass(good.replace('diedA=0', 'diedA=1'))).toBe(false);
    expect(teamBait3Plus1Pass(good.replace('wins=1', 'wins=0'))).toBe(false);
    expect(teamBait3Plus1Pass(good.replace('weapons=42', 'weapons=0'))).toBe(false);
    expect(teamBait3Plus1Pass(good.replace('diedB=49', 'diedB=5'))).toBe(false);
    expect(teamBait3Plus1Pass(good.replace('RESULT ok', 'RESULT fail'))).toBe(false);
});

test('pickEnemy prioritizes prayer-drained targets ahead of lower-HP non-drained targets', () => {
    const focus = createTeamFocus();
    const live = [
        { f: 'ganker1', p: { distance: 1 }, h: 0.25 },
        { f: 'ganker2', p: { distance: 2 }, h: 0.85 },
    ];
    const picked = pickEnemy(live, undefined as string | undefined, 'low', x => x.h, {
        focus,
        memberName: 'ours1',
        nameOf: x => x.f,
        drained: x => x.f === 'ganker2',
    });
    expect(picked?.f).toBe('ganker2');
});

test('team() under neverSkull refuses unprovoked attacks, disables auto-retaliate, and records skulled counts', async () => {
    const mkMock = (name: string, opts: { x: number; z: number; skull: boolean; autoRetaliate?: boolean }) => {
        let curTick = 0;
        const listeners = new Set<() => void>();
        const clicks: number[] = [];
        let autoRetaliateEnabled = opts.autoRetaliate ?? false;
        const session = {
            name,
            ended: new Promise<void>(() => {}),
            tick: () => curTick,
            onTick: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
            direct: async (cmd: { type: string; componentId?: number }) => {
                if (cmd.type === 'clickComponent' && cmd.componentId !== undefined) {
                    clicks.push(cmd.componentId);
                    autoRetaliateEnabled = false;
                }
                return { ok: true };
            },
            client: {
                localPlayer: { headicons: opts.skull ? 1 : 0 },
                players: [] as unknown[],
            },
            sdk: {
                getState: () => ({
                    player: { worldX: opts.x, worldZ: opts.z, level: 0, hp: 99, maxHp: 99, lifeId: 1, combatLevel: 126 },
                    nearbyPlayers: [],
                    gameMessages: [],
                    combatEvents: [],
                    inventory: [],
                    equipment: [],
                    skills: [{ name: 'Hitpoints', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                    prayers: { prayerPoints: 99, activePrayers: [] },
                    autoRetaliateEnabled,
                }),
                getInventory: () => [],
                sendWalk: () => {},
            },
            waitForCondition: async () => true,
            advance: () => {
                curTick++;
                for (const fn of [...listeners]) fn();
            },
            clicks,
        };
        return session;
    };

    const a1 = mkMock('BaitBot', { x: 3137, z: 3602, skull: false, autoRetaliate: true });
    const b1 = mkMock('SkulledGanker', { x: 3135, z: 3602, skull: true });
    let tickCount = 0;
    const timer = setInterval(() => {
        tickCount++;
        a1.advance();
        b1.advance();
        if (tickCount > 40) clearInterval(timer);
    }, 1);

    try {
        const res = await team(
            [a1 as never],
            [b1 as never],
            { kit: BAIT_3PLUS1_SWITCHES, neverSkull: true, protectItem: true },
            { kit: { melee: [1231] } },
            15,
            () => {},
            () => tickCount >= 26,
            { a: 'pair', b: 'pair' },
            5,
            new Set([1231]),
            3,
            { offReads: 6, holdBelow: 0.7, holdTicks: 300 },
        );
        expect(a1.clicks.length).toBeGreaterThanOrEqual(1);
        expect(res.attacks.a).toBe(0);
        expect(res.skulled.a).toBe(0);
        expect(res.skulled.b).toBe(1);
        expect(res.weapons).toBe(0);
    } finally {
        clearInterval(timer);
    }
});

test('buildTeamSideOptions applies gang-bait-3plus1 options above gang-hunter profile and below explicit SPAR_A_OPTS', () => {
    const base = buildTeamSideOptions({
        profileName: 'gang-hunter',
        kit: 'gang-bait-3plus1',
        cap: 3000,
        neverSkull: false,
    });
    expect(base.eatAt).toBe(62);
    expect(base.freeze).toBe('flee');
    expect(base.chase).toBe(false);
    expect(base.comboFood).toBe(true);
    expect(base.zeroDrainFlick).toBe(true);
    expect(base.protectItem).toBe(true);
    expect(base.rotation).toEqual(['ranged', 'melee']);
    expect(base.kit).toEqual(BAIT_3PLUS1_SWITCHES);

    const overridden = buildTeamSideOptions({
        profileName: 'gang-hunter',
        kit: 'gang-bait-3plus1',
        extraJson: '{"eatAt":72,"freeze":"low"}',
        cap: 3000,
        neverSkull: true,
    });
    expect(overridden.eatAt).toBe(72);
    expect(overridden.freeze).toBe('low');
    expect(overridden.neverSkull).toBe(true);
    expect(overridden.protectItem).toBe(true);
    expect(overridden.comboFood).toBe(true);
});

test('preferUnheldTargets picks open unheld enemies before low-HP held enemies and falls back when all are held', () => {
    const live = [
        { f: 'heldLow', p: { distance: 1 }, h: 0.2 },
        { f: 'openHigh', p: { distance: 2 }, h: 0.9 },
    ];
    const pool = preferUnheldTargets(live, x => x.f === 'heldLow');
    expect(pool.map(x => x.f)).toEqual(['openHigh']);
    expect(pickEnemy(pool, undefined as string | undefined, 'low', x => x.h)?.f).toBe('openHigh');
    const allHeld = preferUnheldTargets(live, () => true);
    expect(allHeld.map(x => x.f)).toEqual(['heldLow', 'openHigh']);
});

test('team() with SQUAD_DAGGER=1 and NEVER_SKULL=0 does not spin-loop when the sole enemy is held', async () => {
    const logs: string[] = [];
    let curTick = 0;
    const mk = (name: string, x: number, enemyName: string, enemyIdx: number, headicons: number, hp: number) => {
        const listeners = new Set<() => void>();
        const players: ({ headicons: number; appearance: number[]; health: number; totalHealth: number; spotanimId: number } | null)[] = [];
        players[enemyIdx] = { headicons, appearance: [], health: hp, totalHealth: 99, spotanimId: -1 };
        return {
            name,
            ended: new Promise<void>(() => {}),
            tick: () => curTick,
            onTick: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
            direct: async () => ({ ok: true }),
            client: { localPlayer: { headicons: 0 }, players },
            sdk: {
                getState: () => ({
                    player: { worldX: x, worldZ: 3602, level: 0, hp: 99, maxHp: 99, lifeId: 1, combatLevel: 126 },
                    nearbyPlayers: [{ name: enemyName, index: enemyIdx, x: x === 3137 ? 3135 : 3137, z: 3602, distance: 2, combatLevel: 126, inCombat: true, combatTargetType: 'player', combatTargetIndex: 0 }],
                    gameMessages: [],
                    combatEvents: [],
                    inventory: [],
                    equipment: [{ id: 1231, count: 1, slot: 3 }],
                    skills: [{ name: 'Hitpoints', level: 99, baseLevel: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                    prayers: { prayerPoints: 99, activePrayers: [] },
                    autoRetaliateEnabled: false,
                }),
                getInventory: () => [],
                sendWalk: () => {},
                sendInteractPlayer: () => {},
                sendTogglePrayer: () => {},
            },
            waitForCondition: async () => true,
            advance: () => { for (const fn of [...listeners]) fn(); },
        };
    };
    // Enemy is skulled (bit 0) + Protect from Melee (bit 1 -> headicons = 3) at 50/99 HP (<= 0.7 holdBelow).
    const a1 = mk('Ours1', 3137, 'Skulled1', 2, 3, 50);
    const b1 = mk('Skulled1', 3135, 'Ours1', 1, 0, 99);
    const timer = setInterval(() => {
        curTick++;
        a1.advance();
        b1.advance();
        if (curTick > 40) clearInterval(timer);
    }, 1);
    try {
        await team(
            [a1 as never],
            [b1 as never],
            { kit: { melee: [1231] }, neverSkull: false },
            { kit: { melee: [1231] } },
            15,
            l => logs.push(l),
            () => curTick >= 25,
            { a: 'pair', b: 'pair' },
            10,
            undefined,
            3,
            { offReads: 6, holdBelow: 0.7, holdTicks: 300 },
        );
        // Should enter fightPlayer once (not stop & re-enter every tick in a spin-loop).
        const stoppedLines = logs.filter(l => /\[Ours1\] PK stopped against Skulled1/.test(l));
        expect(stoppedLines.length).toBeLessThanOrEqual(1);
    } finally {
        clearInterval(timer);
    }
});

test('shouldStopOnDying stays false on Side A when pickup is active so kill messages trigger looting', () => {
    expect(shouldStopOnDying(true, 10, 'a', true)).toBe(false);
    expect(shouldStopOnDying(true, 10, 'a', false)).toBe(true);
    expect(shouldStopOnDying(true, 10, 'b', true)).toBe(true);
    expect(shouldStopOnDying(true, 1, 'a', false)).toBe(false);
    expect(shouldStopOnDying(false, 10, 'a', false)).toBe(false);
});

test('cureAfterEscape drinks carried antipoison after escaping to prevent post-escape poison deaths', async () => {
    const used: [number, number][] = [];
    const s = {
        sdk: {
            getInventory: () => [
                { id: 385, slot: 0, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
                { id: 2448, slot: 2, name: 'Super antipoison(4)', optionsWithIndex: [{ text: 'Drink', opIndex: 1 }] },
            ],
            sendUseItem: async (slot: number, opIndex: number) => { used.push([slot, opIndex]); },
        },
    };
    expect(await cureAfterEscape(s as never)).toBe(true);
    expect(used).toEqual([[2, 1]]);
    expect(await cureAfterEscape({ sdk: { getInventory: () => [] } } as never)).toBe(false);
});
