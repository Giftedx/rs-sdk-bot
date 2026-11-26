import { expect, test } from 'bun:test';
import { questRefusalMet } from './quest-refusal-probe';

test('the probe passes only the named refusal of the expected quest', () => {
    const refused = "RESULT fail quest-sweep imp refused: Imp Catcher journal is started and quest-imp.ts has no resume stage";
    expect(questRefusalMet('imp', 'journal is started', refused)).toBe(true);
    expect(questRefusalMet('squire', 'journal is started', refused)).toBe(false);
    expect(questRefusalMet('imp', 'needs 32 quest points', refused)).toBe(false);
    expect(questRefusalMet('imp', 'journal is started', 'RESULT fail talk wizard 1  xp= ticks=27')).toBe(false);
    expect(questRefusalMet('imp', 'journal is started', 'RESULT ok qp=1')).toBe(false);
});
