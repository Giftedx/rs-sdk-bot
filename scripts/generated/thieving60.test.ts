import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The script logs in at import, so these checks read its source.
const source = readFileSync('scripts/generated/thieving60.ts', 'utf8');

test('a start on Karamja resumes at Brimhaven, not with Lumbridge men across the sea', () => {
    // Live: run 1 ended "walk to Brimhaven ... at=2854,3178,0"; run 2 restarted there and sent about 400
    // "PATHFINDING FAILED ... (3222, 3218) is unreachable" walks until a Scorpion killed the bot.
    const body = /const onKaramja = \(p[^)]*\) =>\s*([^;]+);/.exec(source)?.[1];
    expect(body).toBeDefined();
    const onKaramja = new Function('p', `return ${body};`) as (p: unknown) => boolean;
    expect(onKaramja({ worldX: 2854, worldZ: 3178, level: 0 })).toBe(true);
    expect(onKaramja({ worldX: 2956, worldZ: 3143, level: 1 })).toBe(true);
    expect(onKaramja({ worldX: 3029, worldZ: 3217, level: 0 })).toBe(false);
    expect(onKaramja({ worldX: 2654, worldZ: 3304, level: 0 })).toBe(false);
    expect(onKaramja({ worldX: 3222, worldZ: 3218, level: 0 })).toBe(false);
    // Brimhaven dock is Karamja; Rimmington, north of Musa Point on the mainland, is not.
    expect(onKaramja({ worldX: 2774, worldZ: 3228, level: 0 })).toBe(true);
    expect(onKaramja({ worldX: 2957, worldZ: 3214, level: 0 })).toBe(false);
    expect(source).toContain('!inArdougne && !karamjaStart && coins() < 60');
    expect(source).toContain('if (karamjaStart) {');
});

test('the Brimhaven leg uses the shared walker, a spot with no path ends the run, and the boat leg needs Hitpoints', () => {
    expect(source).not.toContain('[2850, 3175, 5]');
    expect(source).toContain('approach(s, { ...BRIMHAVEN_DOCK, level: 0 }');
    expect(source).toContain('const moved = await s.bot.walkTo(t.spot.x, t.spot.z, 3);');
    expect(source).toMatch(/!moved\.success && \/\^no path to\/i\.test\(moved\.message/);
    expect(source).toContain('while (hp() < boatHp() && !died && left() > 0) await rest();');
});
