import { test, expect } from 'bun:test';
import { classifyTick, idleWhy, isStandingStillReason, ledgerScriptId, setLedgerPhase, summarize, startLedger, formatLedger, stalled, DIALOG_TICKS, type TickRow, type TickKind, type StandStillStreak } from '../src/ledger';

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
    let standStill = 0;
    let maxStandStill: StandStillStreak | null = null;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.kind !== 'idle' || !isStandingStillReason(r.why ?? 'none')) continue;
        let j = i;
        while (j + 1 < rows.length && rows[j + 1]!.kind === 'idle' && isStandingStillReason(rows[j + 1]!.why ?? 'none')) j++;
        const len = j - i + 1;
        standStill += len;
        const cand: StandStillStreak = { start: r.tick, length: len, at: r.at, why: rows[j]!.why ?? 'none' };
        if (!maxStandStill || cand.length > maxStandStill.length || (cand.length === maxStandStill.length && cand.start < maxStandStill.start)) {
            maxStandStill = cand;
        }
        i = j;
    }
    const why = new Map<string, number>();
    for (const r of rows) if (r.kind === 'idle') why.set(r.why ?? 'none', (why.get(r.why ?? 'none') ?? 0) + 1);
    const idleBy = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
    return {
        ticks: rows.length,
        counts,
        idlePct: rows.length ? (100 * counts.idle) / rows.length : 0,
        standStill,
        standStillPct: rows.length ? (100 * standStill) / rows.length : 0,
        maxStandStill,
        longestIdle: streaks.slice(0, 5),
        xpGain,
        idleBy,
    };
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
    expect(s.standStill).toBe(2);
    expect(s.standStillPct).toBeCloseTo(40, 1);
    expect(s.maxStandStill).toEqual({ start: 4, length: 2, at: '0,0', why: 'none' });
    expect(formatLedger(s)).toMatch(/ longestIdle=2@t1\(0,0\),2@t4\(0,0\) idleBy=combat:2,after:walkTo:1,none:1 standStill=2 standStillPct=40\.0 maxStandStill=2@t4\(0,0\)$/);
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

test('a session is stalled after a window with no xp, item change or new dialog', async () => {
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

// A ledger on a fake session. `at(t)` gives the dialog, xp, x and inventory of tick t.
function dialogRun(ticks: number, at: (t: number) => { dialog?: any; xp?: number; x?: number; inv?: number }, window = 900) {
    let t = 0;
    const cbs: (() => void)[] = [];
    const stateOf = (tick: number) => {
        const o = at(tick);
        return {
            tick, player: { worldX: 2817 + (o.x ?? 0), worldZ: 3443, level: 0, animId: -1, combat: { inCombat: false, lastDamageTick: -1 } },
            skills: [{ name: 'Cooking', experience: o.xp ?? 0 }], inventory: [{ id: 379, count: o.inv ?? 27 }],
            dialog: o.dialog ?? { isOpen: false, options: [], isWaiting: false },
        };
    };
    let state: any = stateOf(0);
    const led = startLedger({ sdk: { getState: () => state }, onTick: cb => { cbs.push(cb); return () => {}; }, tick: () => t }, () => null, window);
    const stalls: boolean[] = [];
    for (let i = 0; i < ticks; i++) {
        t++;
        state = stateOf(t);
        for (const cb of cbs) cb();
        stalls.push(stalled(led.rows, window));
    }
    return { rows: led.rows, stalls };
}
// The server message box that a cook step at Cooking 30 gets every 10 ticks when it uses lobsters (level 40) on a
// range: the same words each time, with a new pageId each time (the MineYourBiz aio-skiller tick record).
const levelBox = (t: number) => ({
    isOpen: true, isWaiting: false, pageId: `s:${Math.floor(t / 10)}`,
    options: [{ index: 1, text: 'Click here to continue', componentId: 358, buttonType: 6 }],
    allComponents: [{ id: 357, text: 'You need a Cooking level of 40 to cook lobsters.' }],
});
// One page of an NPC talk: new words every 3 ticks.
const talkPage = (t: number) => ({
    isOpen: true, isWaiting: false, pageId: `q:${Math.floor(t / 3)}`,
    options: [{ index: 1, text: 'Click here to continue' }],
    allComponents: [{ id: 241, text: `Line ${Math.floor(t / 3)} of the quest talk.` }],
});

test('a dialog that shows the same words for the whole window is a stall, even with a new pageId on each send', () => {
    const { rows, stalls } = dialogRun(1300, t => ({ dialog: levelBox(t) }));
    expect(rows.every(r => r.kind === 'dialog')).toBe(true);
    // The first DIALOG_TICKS ticks of the same words count as progress, so the stall comes DIALOG_TICKS + 900 ticks in.
    expect(DIALOG_TICKS).toBe(300);
    expect(stalls.indexOf(true)).toBe(DIALOG_TICKS + 900 - 1);
    expect(stalls.slice(DIALOG_TICKS + 900 - 1).every(Boolean)).toBe(true);
    // A dialog that closes for a tick and opens again with the same words keeps its count.
    const blink = dialogRun(1300, t => ({ dialog: t % 10 === 0 ? undefined : levelBox(t) }));
    expect(blink.stalls.indexOf(true)).toBeGreaterThan(0);
    expect(blink.stalls.at(-1)).toBe(true);
});

test('the same dialog beside xp, an item change or a long walk is not a stall', () => {
    expect(dialogRun(1300, t => ({ dialog: levelBox(t), xp: Math.floor(t / 400) * 30 })).stalls.some(Boolean)).toBe(false);
    expect(dialogRun(1300, t => ({ dialog: levelBox(t), inv: 27 - Math.floor(t / 400) })).stalls.some(Boolean)).toBe(false);
    // A walk of FAR_WALK tiles or more inside each window, one tile every 30 ticks.
    expect(dialogRun(1300, t => ({ dialog: levelBox(t), x: Math.floor(t / 30) })).stalls.some(Boolean)).toBe(false);
});

test('a short dialog and a long talk with new words on each page are not a stall', () => {
    // DIALOG_TICKS ticks of the same words, then 600 ticks of nothing: the dialog ticks still count.
    const short = dialogRun(900, t => ({ dialog: t <= DIALOG_TICKS ? levelBox(t) : undefined }));
    expect(short.stalls.some(Boolean)).toBe(false);
    // A quest talk longer than the window: each page has new words.
    expect(dialogRun(2000, t => ({ dialog: talkPage(t) })).stalls.some(Boolean)).toBe(false);
    // Hand-built rows with no dialogTicks count as a new dialog.
    const row = (kind: any, tick: number) => ({ tick, kind, at: '0,0' });
    expect(stalled(Array.from({ length: 900 }, (_, i) => row('dialog', i)), 900)).toBe(false);
});

test('startLedger intercepts direct and sdk.send actions without randomEvents and restores wrappers on stop', () => {
    let t = 0;
    const cbs: (() => void)[] = [];
    const state: any = { tick: 0, player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1, combat: { lastDamageTick: -1 } }, skills: [], dialog: { isOpen: false } };
    const origDirect = () => ({ success: true });
    const origSend = () => {};
    const sess: any = {
        direct: origDirect,
        sdk: { getState: () => state, send: origSend },
        onTick: (cb: () => void) => { cbs.push(cb); return () => {}; },
        tick: () => t,
    };
    const led = startLedger(sess, () => null, 100, { script: 'aio-skiller:rune-bank-craft' });
    const step = () => { t++; state.tick = t; for (const cb of cbs) cb(); };

    // Pre-action phase attribution avoids mystery `none`.
    setLedgerPhase(sess, 'route-plan');
    step();
    setLedgerPhase(sess, null);

    // sdk.send action is attributed even with no randomEvents gate.
    sess.sdk.send({ type: 'sdk_action', action: { type: 'walkTo', x: 3205, z: 3205 } });
    step();

    // togglePrayer does not overwrite the real script action.
    sess.direct({ type: 'togglePrayer', prayerIndex: 1 });
    step();

    // direct action updates lastAction; random-event reason tags as random-event.
    sess.direct({ type: 'interactLoc', x: 3202, z: 3169 });
    step();
    sess.direct({ type: 'walkTo', reason: 'random-event' });
    step();

    const snap = led.snapshot();
    expect(snap.script).toBe('aio-skiller:rune-bank-craft');
    expect(snap.standStill).toBe(5);
    expect(snap.currentStandStill).toBe(5);
    expect(snap.currentStandStillWhy).toBe('after:random-event');
    expect(snap.lastAction).toBe('random-event');
    expect(led.rows.map(r => r.why)).toEqual(['route-plan', 'after:walkTo', 'after:walkTo', 'after:interactLoc', 'after:random-event']);

    const sum = led.stop();
    expect(sess.direct).toBe(origDirect);
    expect(sess.sdk.send).toBe(origSend);
    expect(formatLedger(sum)).toContain('standStill=5 standStillPct=100.0 maxStandStill=5@t1(3200,3200) script=aio-skiller:rune-bank-craft');
});

test('startLedger live snapshot tracks dialog, open window, move streaks, and excludes combat from standing-still', () => {
    let t = 0;
    const cbs: (() => void)[] = [];
    const state: any = { tick: 0, player: { worldX: 3200, worldZ: 3200, level: 0, animId: -1, combat: { lastDamageTick: -1 } }, skills: [], dialog: { isOpen: false }, bank: { isOpen: false }, combatEvents: [] };
    const sess: any = { sdk: { getState: () => state }, onTick: (cb: () => void) => { cbs.push(cb); return () => {}; }, tick: () => t };
    const led = startLedger(sess, () => 'interactNpc', 50);
    const step = () => { t++; state.tick = t; for (const cb of cbs) cb(); };

    // 3 ticks in active combat: idle, NOT standing still.
    state.combatEvents = [{ type: 'damage_dealt', tick: 1 }];
    step(); step(); step();
    expect(led.snapshot().idle).toBe(3);
    expect(led.snapshot().standStill).toBe(0);
    expect(led.snapshot().currentStandStill).toBe(0);

    // 2 ticks standing at open bank.
    state.combatEvents = [];
    state.bank = { isOpen: true };
    step(); step();
    expect(led.snapshot().currentWindowTicks).toBe(2);
    expect(led.snapshot().currentWindowKind).toBe('bank');
    expect(led.snapshot().currentStandStill).toBe(2);

    // 3 ticks with open dialog.
    state.bank = { isOpen: false };
    state.dialog = { isOpen: true, text: 'Continue?' };
    step(); step(); step();
    expect(led.snapshot().currentDialogTicks).toBe(3);
    expect(led.snapshot().maxDialogTicks).toBe(3);
    expect(led.snapshot().currentWindowTicks).toBe(0);

    // 2 move ticks without xp/inventory.
    state.dialog = { isOpen: false };
    state.player.worldX++; step();
    state.player.worldX++; step();
    expect(led.snapshot().currentMoveStreak).toBe(2);
    expect(led.snapshot().maxMoveStreak).toBe(2);
    led.stop();
});

test('ledgerScriptId formats multi-dispatch AIO and standalone scripts cleanly', () => {
    expect(ledgerScriptId('scripts/aio-skiller.ts', ['Worker', 'gather', 'yews'], 'Worker')).toBe('aio-skiller:gather/yews');
    expect(ledgerScriptId('scripts/aio-logistics.ts', ['BotA', 'walk-to', '3200', '3200', '0'], 'BotA')).toBe('aio-logistics:walk-to');
    expect(ledgerScriptId('scripts/goldfarm.ts', ['Dipstick'], 'Dipstick')).toBe('goldfarm');
    expect(ledgerScriptId('', [])).toBeNull();
});
