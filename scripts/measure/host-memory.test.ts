import { expect, test } from 'bun:test';
import { hostNames, lastLines, parseOptions, separateNames, seriesAt, summarize } from './host-memory';

test('the options read the bot, the worker, the env pairs, the limits and the worker args after --', () => {
    expect(parseOptions(['Bot', 'scripts/x.ts', '--env', 'A=1', '--env', 'B=two=2', '--max-s', '100', '--stagger-ms', '500', '--', '300', 'druid'])).toEqual({
        bot: 'Bot', worker: 'scripts/x.ts', env: { A: '1', B: 'two=2' }, maxS: 100, staggerMs: 500, args: ['300', 'druid'] });
    expect(parseOptions(['Bot', 'scripts/x.ts']).args).toEqual([]);
    expect(() => parseOptions(['Bot'])).toThrow('usage');
    expect(() => parseOptions(['Bot', 'x', '--env', 'novalue'])).toThrow('KEY=value');
    expect(() => parseOptions(['Bot', 'x', '--what'])).toThrow('unknown option');
    expect(() => parseOptions(['Bot', 'x', '--max-s', 'soon'])).toThrow('numbers');
});

test('the two conditions use different accounts, four each', () => {
    expect(hostNames('Bot')).toEqual(['Bot', 'Botb', 'Botc', 'Botd']);
    expect(separateNames('Bot')).toEqual(['Bote', 'Botf', 'Botg', 'Both']);
});

test('the summary sums the processes, takes the peak of the sum and a steady mean after the first 30 s', () => {
    const samples = [{ at: 1000, rss: [102400, 102400] }, { at: 31_000, rss: [204800, 102400] }, { at: 32_000, rss: [204800, 204800] }];
    expect(summarize(samples)).toEqual({ samples: 3, meanMB: 300, peakSumMB: 400, steadyMeanMB: 350 });
    expect(summarize([])).toEqual({ samples: 0, meanMB: 0, peakSumMB: 0, steadyMeanMB: 0 });
});

test('the last lines of an output are the non-empty ones, joined and cut', () => {
    expect(lastLines('a\n\nb\r\nc\nd\n', 3)).toBe('b | c | d');
    expect(lastLines('x'.repeat(300), 1)).toBe('x'.repeat(200));
    expect(lastLines('', 3)).toBe('');
});

test('the series takes the last sample at or before each second', () => {
    const samples = [{ at: 1000, rss: [102400] }, { at: 6000, rss: [204800] }, { at: 12_000, rss: [307200] }];
    expect(seriesAt(samples, [0, 5, 6, 11, 20])).toEqual([undefined, 100, 200, 200, 300]);
});
