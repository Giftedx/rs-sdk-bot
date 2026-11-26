import { expect, test } from 'bun:test';
import { questRefusalMet } from './quest-refusal-probe';

test('the probe passes only the named refusal of the expected quest', () => {
    const refused = "RESULT fail quest-sweep ball refused: Witch's House journal is started and quest-ball.ts has no resume stage";
    expect(questRefusalMet('ball', 'journal is started', refused)).toBe(true);
    expect(questRefusalMet('squire', 'journal is started', refused)).toBe(false);
    expect(questRefusalMet('ball', 'needs 32 quest points', refused)).toBe(false);
    expect(questRefusalMet('ball', 'journal is started', 'RESULT fail talk boy 1  xp= ticks=27')).toBe(false);
    expect(questRefusalMet('ball', 'journal is started', 'RESULT ok qp=1')).toBe(false);
});
