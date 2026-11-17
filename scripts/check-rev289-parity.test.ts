import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
    checkAllRev289Parity,
    checkDashboardAssetsParity,
    checkKnowledgeParity,
    checkPrayersList,
    checkQuestReqs,
    checkScriptsParity,
    checkSkillsList,
    checkSpellsList,
    findScriptParityIssues,
    loadRev289Baseline,
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

test('knowledge/, packages/dashboard/client-assets/, and owned scripts/ pass strict Rev 289 parity', () => {
    expect(checkKnowledgeParity(repoRoot, baseline)).toEqual([]);
    expect(checkDashboardAssetsParity(repoRoot, baseline)).toEqual([]);
    expect(checkScriptsParity(repoRoot, baseline, { includeCrossWorker: false })).toEqual([]);
    expect(checkAllRev289Parity(repoRoot, { includeCrossWorker: false })).toEqual([]);
});

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
    }, baseline, 'quest-reqs.json', 'client-assets').length).toBe(2);

    // Market/GE references are valid in rs-sdk and must not trigger parity issues.
    const geText = `// Grand Exchange seller via MarketClient\nconst COINS = 995;\nconst SHARK = 385;\n`;
    expect(findScriptParityIssues('scripts/ge-ok.ts', geText, baseline)).toEqual([]);

    const badScript = `const PURE_ESSENCE = 7936;\nconst skill = 'Slayer';\nconst spell = 'Teleblock';\nconst prayer = 'Smite';\n`;
    expect(findScriptParityIssues('scripts/bad.ts', badScript, baseline).length).toBe(4);

    // Explicitly detects post-289 bank-sort keywords in microbot-bank-sort.ts.
    expect(findScriptParityIssues('scripts/microbot-bank-sort.ts', `const p = ['chestplate'];`, baseline).length).toBe(1);
});
