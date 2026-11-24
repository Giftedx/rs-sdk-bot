import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    checkAllRev289Parity,
    checkCoreAndKnowledgeCodeParity,
    checkDashboardAssetsParity,
    checkKnowledgeParity,
    checkPlannerRouterPracticeParity,
    checkPrayersList,
    checkQuestReqs,
    checkScriptsParity,
    checkSkillsList,
    checkSpellsList,
    findScriptParityIssues,
    loadRev289Baseline,
    runRev289Parity,
    validateItemIds,
} from './check-rev289-parity';

const repoRoot = resolve(import.meta.dir, '..');
const baseline = loadRev289Baseline(repoRoot);

test('loadRev289Baseline parses authoritative Lost City Jan 17, 2005 counts', () => {
    expect(baseline.maxObjId).toBe(4088);
    expect(baseline.objById.size).toBe(4089);
    expect(baseline.maxNpcId).toBe(1596);
    expect(baseline.npcById.size).toBe(1597);
    expect(baseline.maxLocId).toBe(5116);
    expect(baseline.locById.size).toBe(5117);
    expect(baseline.skills.size).toBe(19);
    expect(baseline.prayers.size).toBe(15);
    expect(baseline.spells.size).toBe(52);
    expect(baseline.skills.has('slayer')).toBe(false);
    expect(baseline.prayers.has('smite')).toBe(false);
    expect(baseline.spells.has('teleblock')).toBe(false);
});

test('knowledge/ passes strict Rev 289 parity', () => {
    expect(checkKnowledgeParity(repoRoot, baseline)).toEqual([]);
}, 20_000);

test('packages/dashboard/client-assets/ passes strict Rev 289 parity', () => {
    expect(checkDashboardAssetsParity(repoRoot, baseline)).toEqual([]);
}, 20_000);

test('owned scripts/, core, knowledge code, planner, router, and practice pass strict Rev 289 parity', () => {
    expect(checkAllRev289Parity(repoRoot, { includeCrossWorker: false })).toEqual([]);
}, 20_000);

test('--strict mode passes with zero errors and zero warnings on the repo and fails when cross-worker holes exist', () => {
    const strictLive = runRev289Parity({ repoRoot, strict: true });
    expect(strictLive.ownedIssues).toEqual([]);
    expect(strictLive.crossIssues).toEqual([]);
    expect(strictLive.passed).toBe(true);

    // Simulate both open cross-worker warnings failing --strict and cleared strict parity passing on a temp fixture.
    const tmp = mkdtempSync(join(tmpdir(), 'rev289-strict-'));
    try {
        mkdirSync(join(tmp, 'scripts'), { recursive: true });
        writeFileSync(join(tmp, 'scripts', 'clean.ts'), `const SHARK = { id: 385, count: 1 };\nexport const XP = Math.pow(2, 10 / 10);\n`);
        const ownedOnly = checkScriptsParity(tmp, baseline, { includeCrossWorker: true, crossWorkerFiles: new Set() });
        expect(ownedOnly).toEqual([]);

        writeFileSync(join(tmp, 'scripts', 'gather-essence.ts'), `const PURE_ESSENCE = 7936;\n`);
        const crossOnly = checkScriptsParity(tmp, baseline, { includeCrossWorker: false, crossWorkerFiles: new Set(['scripts/gather-essence.ts']) });
        expect(crossOnly).toEqual([]);
        const strictCrossIssues = checkScriptsParity(tmp, baseline, { includeCrossWorker: true, crossWorkerFiles: new Set(['scripts/gather-essence.ts']) })
            .filter(i => i.scope === 'cross-worker');
        expect(strictCrossIssues.length).toBeGreaterThan(0);

        const flaggedWhenCleared = checkScriptsParity(tmp, baseline, { includeCrossWorker: true, crossWorkerFiles: new Set() });
        expect(flaggedWhenCleared.map(i => i.scope)).toEqual(['scripts']);

        writeFileSync(join(tmp, 'scripts', 'gather-essence.ts'), `const RUNE_ESSENCE = { id: 1436, count: 28 };\n`);
        const cleanAfterFix = checkScriptsParity(tmp, baseline, { includeCrossWorker: true, crossWorkerFiles: new Set() });
        expect(cleanAfterFix).toEqual([]);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}, 20_000);

test('detectors catch post-rev-289 items, skills, prayers, spells, and OSRS quest leaks while preserving native Market/GE', () => {
    expect(checkSkillsList(['Attack', 'Runecraft', 'Slayer', 'Farming', 'Sailing'], baseline, 'x.ts', 'scripts').map(i => i.detail)).toEqual([
        'non-rev-289 skill "Slayer"',
        'non-rev-289 skill "Farming"',
        'non-rev-289 skill "Sailing"',
    ]);
    expect(checkPrayersList(['Protect from Melee', 'Smite', 'Piety', 'Rigour'], baseline, 'x.ts', 'scripts').map(i => i.detail)).toEqual([
        'non-rev-289 prayer "Smite"',
        'non-rev-289 prayer "Piety"',
        'non-rev-289 prayer "Rigour"',
    ]);
    expect(checkSpellsList(['High Level Alchemy', 'Teleblock', 'Home Teleport', 'Ice Barrage'], baseline, 'x.ts', 'scripts').map(i => i.detail)).toEqual([
        'non-rev-289 spell "Teleblock"',
        'non-rev-289 spell "Home Teleport"',
        'non-rev-289 spell "Ice Barrage"',
    ]);
    expect(validateItemIds([
        { id: 385, name: 'Shark' },
        { id: 7936, name: 'Pure essence' },
        { id: 13204, name: 'Platinum token' },
    ], baseline, 'x.ts', 'scripts').map(i => i.detail)).toEqual([
        'non-rev-289 item ID 7936 ("Pure essence")',
        'non-rev-289 item ID 13204 ("Platinum token")',
    ]);
    expect(checkQuestReqs({
        'Priest in Peril': { q: [['Rune Mysteries Quest', 0]] },
        'Horror from the Deep': { s: [['Prayer', 50, 2]] },
        'Recipe for Disaster': { q: [['Desert Treasure', 0]] },
    }, baseline, 'quest-reqs.json', 'client-assets').length).toBe(4);

    // Market/GE references are valid in rs-sdk and must not trigger parity issues.
    const geText = `// Grand Exchange seller via MarketClient\nconst COINS = 995;\nconst SHARK = 385;\n`;
    expect(findScriptParityIssues('scripts/ge-ok.ts', geText, baseline)).toEqual([]);

    const badScript = `const PURE_ESSENCE = 7936;\nconst skill = 'Slayer';\nconst spell = 'Teleblock';\nconst prayer = 'Smite';\nconst mine = 'Mine pure essence';\nconst protectSet = new Set([995, 13204]);\nconst hasPe = sum(before, 7936);\n`;
    expect(findScriptParityIssues('scripts/bad.ts', badScript, baseline).length).toBe(7);

    // Negative comments explaining rev-289 absences must remain allowed.
    expect(findScriptParityIssues('scripts/ok.ts', `// No Pure essence (7936) or Teleblock in rev 289\n`, baseline)).toEqual([]);

    // Explicitly detects post-289 bank-sort keywords in packages/workers/src/logistics/stage.ts.
    expect(findScriptParityIssues('packages/workers/src/logistics/stage.ts', `const p = ['chestplate'];`, baseline).length).toBe(1);

    // Catches structured item/npc/loc IDs, OSRS 2^(L/7) XP curves, and Wave 3B banned phrases (e.g. 75-Def dragonfire shield, salve (e)).
    expect(findScriptParityIssues('scripts/bad-dfs.ts', `const shield = [/^dragonfire shield$/i, 75];\nconst ammy = 'salve amulet (e)';\nconst x = { id: 11283, count: 1 };\nconst npc = { npcId: 9999 };\nconst loc = { locId: 9999 };\nconst xp = Math.pow(2, level / 7);\n`, baseline).length).toBe(6);
    expect(findScriptParityIssues('packages/core/src/ok.ts', `const anti = { id: 1540, count: 1, name: 'dragonfire shield' };\nconst salve = { id: 4081, count: 1, name: 'salve amulet' };\nconst fl = 2 ** (level / 10);\nconst absent = ['Lunar Isle', 'Port Phasmatys'];\n`, baseline, 'core')).toEqual([]);
});

test('checkCoreAndKnowledgeCodeParity audits all unified worker families under packages/workers/src/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rev289-workers-'));
    try {
        mkdirSync(join(tmp, 'packages', 'workers', 'src', 'combat'), { recursive: true });
        writeFileSync(join(tmp, 'packages', 'workers', 'src', 'combat', 'sample.ts'), `const PURE_ESSENCE = 7936;\n`);
        const issues = checkCoreAndKnowledgeCodeParity(tmp, baseline);
        expect(issues.some(i => i.file.includes('packages/workers/src/combat/sample.ts'))).toBe(true);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
