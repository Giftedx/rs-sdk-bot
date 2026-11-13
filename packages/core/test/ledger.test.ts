import { test, expect } from 'bun:test';
import { classifyTick, idleWhy, summarize, startLedger, formatLedger } from '../src/ledger';

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
