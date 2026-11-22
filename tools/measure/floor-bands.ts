// Best supply method per level band for each supply board, from rev 289 content, and the exact action counts
// from level 1 (or a start level) to 99 at the 25x rate. Base XP per action is in whole XP (content stores tenths).
// Usage: bun tools/measure/floor-bands.ts [skill]  prints the band table and the supply counts.
import {
    COOKING,
    CRAFTING,
    FIREMAKING,
    FLETCHING,
    HERBLORE,
    MAGIC,
    PRAYER,
    SMITHING,
    ladder,
    objId,
    odds,
    supplies,
    type Band,
} from '../../packages/practice/src/floor-bands';

export * from '../../packages/practice/src/floor-bands';

if (import.meta.main) {
    const all: Record<string, Band[]> = {
        fletching: FLETCHING,
        crafting: CRAFTING,
        herblore: HERBLORE,
        firemaking: FIREMAKING,
        prayer: PRAYER,
        smithing: SMITHING,
        magic: MAGIC,
        cooking: COOKING,
    };
    const want = process.argv[2];
    for (const [k, b] of Object.entries(all)) {
        if (want && want !== k) continue;
        const steps = ladder(b, k === 'magic' ? 7 : k === 'herblore' ? 3 : 1, 99, odds);
        console.log(`== ${k} (vendor/rs-sdk/server/content/scripts)`);
        for (const s of steps) console.log(`${s.from}-${s.to} ${s.band.name} xp=${s.band.xp} actions=${s.actions}`);
        const sup = supplies(steps);
        console.log('supplies ' + Object.entries(sup).map(([n, v]) => `${n}(${objId(n)})=${v}`).join(' '));
    }
}
