import { expect, test } from 'bun:test';
import { childEnv, combatEndMet } from './combat-end-probe';

test('the probe passes only a RESULT fail line that holds the expected end word', () => {
    const died = 'RESULT fail ticks=80 kills=1 looted=0 bankTrips=0 walkTicks=0 hp=20 maximum=5 died=true endTicks=21 logout=confirmed';
    expect(combatEndMet('died=true', died)).toBe(true);
    expect(combatEndMet('fled=true', died)).toBe(false);
    expect(combatEndMet('-', 'RESULT fail Error: Dusty key (1590) required')).toBe(true);
    expect(combatEndMet('died=true', 'RESULT ok ticks=80 died=true')).toBe(false);
    expect(combatEndMet('capped=true', 'RESULT fail Error: combat bank return unavailable')).toBe(false);
    expect(combatEndMet('died=true', 'RESULT fail ticks=80 notdied=true')).toBe(false);
});

test('KEY=value arguments go into the child environment; other arguments do not', () => {
    const env = childEnv(['giant', '1500', 'FLEE_GUARD=1', 'MAX_KILLS=5', 'lower=x'], { FLEE_GUARD: '0', HOME: 'h' });
    expect(env.FLEE_GUARD).toBe('1');
    expect(env.MAX_KILLS).toBe('5');
    expect(env.HOME).toBe('h');
    expect(env.lower).toBeUndefined();
    expect(env.giant).toBeUndefined();
});
