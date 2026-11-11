import { expect, test } from 'bun:test';
import { StyleArms } from './pk-read';

test('StyleArms starts on avoid and stays there while its attacks are not guarded', () => {
    const arms = new StyleArms();
    expect(arms.pick(() => 0.5)).toBe('avoid');
    for (let i = 0; i < 10; i++) arms.record('avoid', false);
    expect(arms.pick(() => 0.5)).toBe('avoid');
});

test('StyleArms moves to into when avoid meets the overhead, and back when into does', () => {
    const arms = new StyleArms();
    for (let i = 0; i < 4; i++) arms.record('avoid', true);
    expect(arms.pick(() => 0.5)).toBe('into');
    for (let i = 0; i < 8; i++) arms.record('into', true);
    for (let i = 0; i < 3; i++) arms.record('avoid', false);
    expect(arms.pick(() => 0.5)).toBe('avoid');
});

test('StyleArms tries the other way on one draw in ten', () => {
    const arms = new StyleArms();
    expect(arms.pick(() => 0.05)).toBe('into');
});
