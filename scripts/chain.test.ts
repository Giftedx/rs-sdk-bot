import { expect, test } from 'bun:test';
import { parseStep } from './chain';
import { lastResult } from '../packages/core/src/run-child';

test('a chain step splits into script, arguments and its own environment', () => {
    expect(parseStep('scripts/cook-food.ts 2000 lobster CAP=2000')).toEqual({ script: 'scripts/cook-food.ts', args: ['2000', 'lobster'], env: { CAP: '2000' } });
    expect(() => parseStep('rm -rf /')).toThrow();
});

test('the last RESULT line wins; none is a failure', () => {
    expect(lastResult('RESULT fail a\nlog\nRESULT ok b\n')).toBe('RESULT ok b');
    expect(lastResult('no result here')).toBe('RESULT fail no result');
});
