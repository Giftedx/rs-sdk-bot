import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The script logs in at import, so these checks read its source.
const source = readFileSync('scripts/generated/woodcutting.ts', 'utf8');

test('a far start moves with the danger-aware walker, and the combat floor is checked before any Lumbridge step', () => {
    // Live: "START 2618 3332 0" (Ardougne), a plain walk toward Lumbridge over White Wolf Mountain, then
    // "DEATH at=2847,3498,0" to Wolves and White wolves on a level-3 account.
    const step0 = source.indexOf('// ---- Step 0:');
    const step1 = source.indexOf('// ---- Step 1:');
    const floor = source.indexOf('if (combat0 < site.minCombat)');
    const far = source.indexOf('cheb(LUMBRIDGE, start) > FAR_START && cheb(site.anchor, start) > FAR_START');
    const walker = source.indexOf('await approach(s, { ...to, level: 0 }');
    expect(floor).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(walker).toBeGreaterThan(far);
    expect(floor).toBeLessThan(step0);
    expect(walker).toBeLessThan(step0);
    expect(step0).toBeLessThan(step1);
});

test('the Lumbridge pickpocket step takes only reachable men', () => {
    expect(source).toContain("/^(man|woman)$/i.test(n.name) && n.reachable !== false");
});
