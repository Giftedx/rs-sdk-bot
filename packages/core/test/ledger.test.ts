import { test, expect } from 'bun:test';
import { classifyTick, summarize } from '../src/ledger';

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
    expect(s.counts).toEqual({ xp: 2, move: 1, anim: 0, dialog: 0, stun: 0, idle: 6 });
    expect(s.idlePct).toBeCloseTo(66.7, 1);
    expect(s.longestIdle[0]).toEqual({ start: 101, length: 3, at: '1,0' });
    expect(s.longestIdle[1]).toEqual({ start: 107, length: 2, at: '7,0' });
});

test('an idle tick inside the 8 ticks after a stun message counts as stun, not idle', async () => {
    const { classifyTick: c } = await import('../src/ledger');
    expect(c(st({}), st({}), true)).toBe('stun');
    expect(c(st({}), st({ xp: 5 }), true)).toBe('xp');
    expect(c(st({}), st({}), false)).toBe('idle');
});
