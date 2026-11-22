import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPinnedForm, loadNameSets, scanNames } from './check-rev289-names';

const sets = loadNameSets();

function scanText(text: string) {
    const dir = mkdtempSync(join(tmpdir(), 'names-'));
    try {
        const file = join(dir, 'sample.ts');
        writeFileSync(file, text);
        return scanNames({ sets, files: [file], allow: [] }).faults;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('rev289 name sweep', () => {
    test('the name sets read the content', () => {
        expect(sets.items.has('bronze axe')).toBe(true);
        expect(sets.npcs.has('cook')).toBe(true);
        expect(sets.quests.has("cook's assistant")).toBe(true);
        expect(sets.quests.has("hero's quest")).toBe(true);
        expect(sets.all.has('abyssal whip')).toBe(false);
    });

    test('pinned forms map to real names', () => {
        expect(isPinnedForm('studded chap', sets)).toBe(true);
        expect(isPinnedForm('mort myre fungus', sets)).toBe(true);
        expect(isPinnedForm('guam potion (unf)', sets)).toBe(true);
        expect(isPinnedForm('abyssal whip', sets)).toBe(false);
    });

    test('a game call with a name that the content lacks is a fault', () => {
        const faults = scanText(`bot.findInventoryItem('Abyssal whip');\nbot.findBankItem('Bronze axe');\nbot.findBankItem(/longbow \\(u\\)/i);`);
        expect(faults.map(f => `${f.kind}:${f.text}`)).toEqual(['osrs-only:Abyssal whip', 'osrs-only:longbow \\(u\\)']);
    });

    test('display names only: a debugname or an unstrung-bow pattern matches nothing', () => {
        // The content names an unstrung bow like the strung one, and "Bow string" has a space.
        expect(sets.all.has('unstrung oak longbow')).toBe(false);
        expect(sets.all.has('bow string')).toBe(true);
        expect(sets.all.has('guamvial')).toBe(false);
        const faults = scanText(`bot.withdrawItem(/^unstrung .*longbow$/i, 14);\nbot.withdrawItem(/bowstring/i, 14);\nbot.withdrawItem(/bow string/i, 14);`);
        expect(faults.map(f => f.text)).toEqual(['^unstrung .*longbow$', 'bowstring']);
    });

    test('the patterns of a local helper are checked', () => {
        const faults = scanText(`const findItem = (re: RegExp) => inv().find(i => re.test(i.name));\nfindItem(/headless arrow/i);\nfindItem(/bronze arrowtips/i);\nfindItem(/longbow \\(u\\)/i);`);
        expect(faults.map(f => f.text)).toEqual(['longbow \\(u\\)']);
    });

    test('a name table with a spelling mismatch or an unknown name is a fault', () => {
        const faults = scanText(`const T = ['Bronze axe', 'Iron axe', 'Steel axe', 'Heroes Guild helm', 'Dragon medium helm'];`);
        expect(faults.map(f => f.text).sort()).toEqual(['Dragon medium helm', 'Heroes Guild helm']);
    });

    test('an id beside a name must name that item', () => {
        const axe = [...sets.idNames.obj].find(([, names]) => names.includes('bronze axe'))![0];
        const shark = [...sets.idNames.obj].find(([, names]) => names.includes('shark'))![0];
        const faults = scanText(`const a = { id: ${axe}, name: 'Bronze axe' };\nconst b = { id: ${shark}, name: 'Bronze axe' };\nconst c = { itemId: 99999 };`);
        expect(faults.map(f => `${f.kind}:${f.text}`)).toEqual([`bad-id:${shark}`, 'bad-id:99999']);
    });

    test('a quest helper must talk to a real NPC', () => {
        const faults = scanText(`await q.talk('x', /^cook$/i, []);\nawait q.talk('y', /^zulrah$/i, []);`);
        expect(faults.map(f => f.text)).toEqual(['/^zulrah$/i']);
    });

    test('the label of a reconcileLoadout call is error text, not a name', () => {
        const faults = scanText(`await reconcileLoadout(s, { style: 'magic', pin: {}, label: 'alch stage' });
await other(s, { label: 'alch stage', a: 'Bronze axe', b: 'Shark', c: 'Rune scimitar' });`);
        expect(faults.filter(f => f.file.endsWith(':1'))).toEqual([]);
        expect(faults.some(f => f.file.endsWith(':2') && f.text === 'alch stage')).toBe(true);
    });

    test('scripts and packages hold no name that the revision-289 content lacks', () => {
        const scan = scanNames();
        expect(scan.namesChecked).toBeGreaterThan(500);
        expect(scan.faults).toEqual([]);
    }, 60_000);
});
