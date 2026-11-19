import { test, expect } from 'bun:test';
import { classifyTick, idleWhy, summarize, startLedger, formatLedger, stalled, type TickRow, type TickKind } from '../src/ledger';

// The summary as it was computed over every row: the reference for the counters.
function summarizeAllRows(rows: TickRow[], xpGain = 0) {
    const counts: Record<TickKind, number> = { xp: 0, inventory: 0, move: 0, anim: 0, dialog: 0, stun: 0, idle: 0 };
    for (const r of rows) counts[r.kind]++;
    const streaks: { start: number; length: number; at: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.kind !== 'idle') continue;
        let j = i;
        while (j + 1 < rows.length && rows[j + 1]!.kind === 'idle') j++;
        streaks.push({ start: rows[i]!.tick, length: j - i + 1, at: rows[i]!.at });
        i = j;
    }
    streaks.sort((x, y) => y.length - x.length || x.start - y.start);
    const why = new Map<string, number>();
    for (const r of rows) if (r.kind === 'idle') why.set(r.why ?? 'none', (why.get(r.why ?? 'none') ?? 0) + 1);
    const idleBy = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
    return { ticks: rows.length, counts, idlePct: rows.length ? (100 * counts.idle) / rows.length : 0, longestIdle: streaks.slice(0, 5), xpGain, idleBy };
}

test('the counters give the same summary as a pass over every row, for random runs', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const kinds: TickKind[] = ['xp', 'inventory', 'move', 'anim', 'dialog', 'stun', 'idle', 'idle', 'idle', 'idle'];
    const reasons = ['combat', 'hurt', 'bank', 'shop', 'window', 'none', 'after:walkTo', 'after:interactLoc', 'after:a', 'after:b'];
    for (let run = 0; run < 200; run++) {
        const n = Math.floor(rnd() * 400), rows: TickRow[] = [];
        for (let i = 0; i < n; i++) {
            const kind = kinds[Math.floor(rnd() * kinds.length)]!;
            rows.push({ tick: 1000 + i, kind, at: `${i},0`, ...(kind === 'idle' && rnd() < 0.9 ? { why: reasons[Math.floor(rnd() * reasons.length)]! } : {}) });
        }
        expect(summarize(rows, 7)).toEqual(summarizeAllRows(rows, 7));
    }
    // Ties on length keep the earliest start, and a run that ends in an open streak counts it.
    const tie = ['idle', 'idle', 'move', 'idle', 'idle', 'move', 'idle', 'idle', 'move', 'idle', 'idle', 'idle'].map((kind, i) => ({ tick: i, kind: kind as TickKind, at: `${i},0` }));
    expect(summarize(tie).longestIdle).toEqual(summarizeAllRows(tie).longestIdle);
});

test('a ledger holds a bounded number of rows, and its summary, counts and stall check match the full run', () => {
    let t = 0, x = 0, mode = 0;
    const cbs: (() => void)[] = [];
    let state: any = { tick: 0, player: { worldX: 0, worldZ: 0, level: 0, animId: -1, combat: { inCombat: false, lastDamageTick: -1 } }, skills: [], dialog: { isOpen: false } };
    const keep = 50;
    const led = startLedger({ sdk: { getState: () => state }, onTick: cb => { cbs.push(cb); return () => {}; }, tick: () => t }, () => null, keep);
    const all: TickRow[] = [];
    let maxHeld = 0;
    for (let i = 0; i < 1000; i++) {
        t++; mode = Math.floor(i / 7) % 3;
        if (mode === 0) x++; // a move tick
        state = { ...state, tick: t, player: { ...state.player, worldX: x, animId: mode === 1 ? 881 : -1 } };
        for (const cb of cbs) cb();
        maxHeld = Math.max(maxHeld, led.rows.length);
        all.push(led.rows.at(-1)!);
        // The window of the stall check is inside the held rows at each tick.
        const w = 30;
        expect(stalled(led.rows, w)).toBe(stalled(all, w));
    }
    expect(maxHeld).toBeLessThan(2 * keep);
    expect(led.rows.slice(-keep).map(r => r.tick)).toEqual(all.slice(-keep).map(r => r.tick));
    expect(led.counts()).toEqual(Object.fromEntries(Object.entries(summarizeAllRows(all).counts).filter(([, n]) => n > 0)));
    expect(led.stop()).toEqual(summarizeAllRows(all));
});

const st = (o: { x?: number; xp?: number; anim?: number; dialog?: boolean }) => ({
    player: { worldX: o.x ?? 0, worldZ: 0, level: 0, animId: o.anim ?? -1 },
    skills: [{ name: 'Thieving', experience: o.xp ?? 0 }],
    dialog: { isOpen: !!o.dialog },
});

test('a tick is classified by what changed: xp beats move beats anim beats dialog; nothing is idle', () => {
    expect(classifyTick(st({}), st({ xp: 10 }))).toBe('xp');
    expect(classifyTick(st({}), st({ x: 1 }))).toBe('move');
    expect(classifyTick(st({}), st({ anim: 881 }))).toBe('anim');
    expect(classifyTick(st({}), st({ dialog: true }))).toBe('dialog');
    expect(classifyTick(st({}), st({}))).toBe('idle');
});

test('summarize counts each kind and lists the longest idle streaks with their start tick', () => {
    const kinds = ['xp', 'idle', 'idle', 'idle', 'move', 'idle', 'xp', 'idle', 'idle'] as const;
    const s = summarize(kinds.map((k, i) => ({ tick: 100 + i, kind: k, at: `${i},0` })));
    expect(s.counts).toEqual({ xp: 2, inventory: 0, move: 1, anim: 0, dialog: 0, stun: 0, idle: 6 });
    expect(s.idlePct).toBeCloseTo(66.7, 1);
    expect(s.longestIdle[0]).toEqual({ start: 101, length: 3, at: '1,0' });
    expect(s.longestIdle[1]).toEqual({ start: 107, length: 2, at: '7,0' });
});

test('an idle tick has a reason: a fight, an open window, or the last script action', () => {
    expect(idleWhy({ fight: true, bank: true }, 'walkTo')).toBe('combat');
    expect(idleWhy({ bank: true }, 'walkTo')).toBe('bank');
    expect(idleWhy({ shop: true }, null)).toBe('shop');
    expect(idleWhy({ window: true }, null)).toBe('window');
    expect(idleWhy({}, 'interactNpc')).toBe('after:interactNpc');
    expect(idleWhy({}, null)).toBe('none');
    const s = summarize([
        { tick: 1, kind: 'idle', at: '0,0', why: 'combat' }, { tick: 2, kind: 'idle', at: '0,0', why: 'combat' },
        { tick: 3, kind: 'xp', at: '0,0' }, { tick: 4, kind: 'idle', at: '0,0', why: 'after:walkTo' }, { tick: 5, kind: 'idle', at: '0,0' },
    ]);
    expect(s.idleBy).toEqual([['combat', 2], ['after:walkTo', 1], ['none', 1]]);
    expect(formatLedger(s)).toMatch(/ longestIdle=2@t1\(0,0\),2@t4\(0,0\) idleBy=combat:2,after:walkTo:1,none:1$/);
});

test('startLedger names each idle tick from the state and the last action', () => {
    let t = 0, last: string | null = null;
    const cbs: (() => void)[] = [];
    let state: any = { tick: 0, player: { worldX: 1, worldZ: 1, level: 0, animId: -1, combat: { inCombat: false, lastDamageTick: -1 } }, skills: [], dialog: { isOpen: false } };
    const led = startLedger({ sdk: { getState: () => state }, onTick: cb => { cbs.push(cb); return () => {}; }, tick: () => t }, () => last);
    const step = () => { t++; state = { ...state, tick: t }; for (const cb of cbs) cb(); };
    last = 'interactLoc'; step();
    // A target alone (a pickpocket click) is no fight.
    state = { ...state, player: { ...state.player, combat: { inCombat: true, lastDamageTick: -1 } } }; step();
    // A failed pickpocket: damage taken, none dealt.
    state = { ...state, player: { ...state.player, combat: { inCombat: true, lastDamageTick: t + 1 } } }; step();
    // A hit the player dealt (a miss is damage 0).
    state = { ...state, combatEvents: [{ type: 'damage_dealt', tick: t + 1, damage: 0 }] }; step();
    state = { ...state, combatEvents: [], player: { ...state.player, combat: { inCombat: false, lastDamageTick: -1 } }, bank: { isOpen: true } }; step();
    expect(led.rows.map(r => r.why)).toEqual(['after:interactLoc', 'after:interactLoc', 'hurt', 'combat', 'bank']);
});

test('an idle tick inside the 8 ticks after a stun message counts as stun, not idle', async () => {
    const { classifyTick: c } = await import('../src/ledger');
    expect(c(st({}), st({}), true)).toBe('stun');
    expect(c(st({}), st({ xp: 5 }), true)).toBe('xp');
    expect(c(st({}), st({}), false)).toBe('idle');
});

test('shopping and bank movement are observed inventory changes, not idle or new production', () => {
    const before = {...st({}), inventory:[{id:995,count:100}]};
    const bought = {...st({}), inventory:[{id:995,count:90},{id:314,count:10}]};
    expect(classifyTick(before,bought)).toBe('inventory');
    expect(classifyTick(bought,{...st({}),inventory:[{id:995,count:90}]})).toBe('inventory');
    expect(classifyTick(before,{...bought,skills:[{experience:10}]})).toBe('xp');
    expect(classifyTick(before,{...bought,dialog:{isOpen:true}})).toBe('inventory');
});
test('unknown, empty and reordered inventory snapshots do not fake activity', () => {
    expect(classifyTick({},{})).toBe('idle');
    expect(classifyTick({inventory:[]},{inventory:[]})).toBe('idle');
    expect(classifyTick({}, {inventory:[{id:314,count:10}]})).toBe('idle');
    expect(classifyTick({inventory:[{id:314,count:10}]},{})).toBe('idle');
    expect(classifyTick({inventory:[{id:314,count:10},null]}, {inventory:[null,{id:314,count:4},{id:314,count:6}]})).toBe('idle');
});
test('startLedger copies reused inventory objects and reports inventory separately', () => {
    const state={...st({}),inventory:[{id:995,count:100}]};
    let callback=()=>{}, tick=0;
    const led=startLedger({sdk:{getState:()=>state},tick:()=>tick,onTick:cb=>{callback=cb;return()=>{};}});
    state.inventory[0]!.count=90;tick++;callback();
    tick++;callback();
    const result=led.stop();
    expect(led.rows.map(r=>r.kind)).toEqual(['inventory','idle']);
    expect(result.counts.inventory).toBe(1);
    expect(result.idlePct).toBe(50);
    expect(formatLedger(result)).toContain('inventory=1');
});

test('a session is stalled after a window with no xp, item change or dialog', async () => {
    const { stalled } = await import('../src/ledger');
    const row = (kind: any, tick: number) => ({ tick, kind, at: '0,0' });
    const walking = Array.from({ length: 900 }, (_, i) => row(i % 2 ? 'move' : 'idle', i));
    expect(stalled(walking, 900)).toBe(true);
    expect(stalled([...walking.slice(1), row('inventory', 901)], 900)).toBe(false);
    expect(stalled([...walking.slice(0, 450), row('dialog', 450), ...walking.slice(451)], 900)).toBe(false);
    expect(stalled(walking.slice(0, 899), 900)).toBe(false);
    expect(stalled(walking, 0)).toBe(false);
    // A journey is progress: a walk that ends 20 tiles or more from where the window began; pacing within 19 tiles is not.
    const journey = Array.from({ length: 900 }, (_, i) => ({ tick: i, kind: (i % 2 ? 'move' : 'idle') as any, at: `${3013 - Math.floor(i / 4)},3207` }));
    expect(stalled(journey, 900)).toBe(false);
    const pacing = Array.from({ length: 900 }, (_, i) => ({ tick: i, kind: 'move' as any, at: `${3013 + (i % 19)},3207` }));
    expect(stalled(pacing, 900)).toBe(true);
});
