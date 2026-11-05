import { test, expect } from 'bun:test';
import { domainOf } from '../../knowledge/src/actions';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { named, questScript, questJournalNames, questStages, itemsHeld, skillBands, domainStages, firedActions, sideSnapshots, fleetSkills, practicePasses, ownedNames } from '../src/coverage';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { questDefinitions } from '../../core/src/quest-status';
import { scoreboardSummary, fleetLeads } from '../src/coordinator-planner';

test('content paths map to one domain each', () => {
    expect(domainOf('skill_combat/scripts/x.rs2')).toBe('skill/combat');
    expect(domainOf('quests/quest_tree/scripts/x.rs2')).toBe('quest/tree');
    expect(domainOf('areas/area_varrock/scripts/x.rs2')).toBe('area/varrock');
    expect(domainOf('minigames/game_trawler/scripts/x.rs2')).toBe('minigame/trawler');
    expect(domainOf('macro events/scripts/x.rs2')).toBe('system/macro_events');
});

test('named needs a debug name or a 5+ letter display name in our source', () => {
    const text = 'await q.talk(/^father aereck$/i); oploc khazzacklowwall';
    expect(named({ domain: 'x', trigger: 'opnpc1', subject: 'father_aereck_2', name: 'Father Aereck', src: '' }, text)).toBe(true);
    expect(named({ domain: 'x', trigger: 'oploc1', subject: 'khazzacklowwall', src: '' }, text)).toBe(true);
    expect(named({ domain: 'x', trigger: 'oploc1', subject: 'door1', name: 'Door', src: '' }, 'door')).toBe(false);
    expect(domainStages([{ domain: 'a', trigger: 'oploc1', subject: 'khazzacklowwall', src: '' }, { domain: 'a', trigger: 'oploc1', subject: 'zzzz', src: '' }], text)).toEqual([{ domain: 'a', actions: 2, named: 1, fired: 0, share: 50 }]);
});

test('firedActions reads script names and drops torn lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    expect(firedActions(join(dir, 'missing.log')).size).toBe(0);
    const file = join(dir, 'action-trace.log');
    writeFileSync(file, '[opnpc1,cook]\r\n[oploc1,_door]\n[opnpc1,cook]\n[if_button,quest_journal:com_1]\n[oploc1,to\ncooks_proc\n');
    expect([...firedActions(file)].sort()).toEqual(['if_button,quest_journal:com_1', 'opnpc1,cook', 'oploc1,_door'].sort());
});

test('domainStages counts an action as fired only on its exact trigger and subject', () => {
    const fired = new Set(['opnpc1,cook', 'oploc1,_door', 'proc,cook', 'opnpc3,other']);
    const rows = domainStages([
        { domain: 'q', trigger: 'opnpc1', subject: 'cook', src: '' },
        { domain: 'q', trigger: 'opnpc2', subject: 'cook', src: '' },
        { domain: 'r', trigger: 'oploc1', subject: '_door', src: '' },
    ], '', fired);
    expect(rows.find(d => d.domain === 'q')).toMatchObject({ actions: 2, fired: 1 });
    expect(rows.find(d => d.domain === 'r')).toMatchObject({ actions: 1, fired: 1 });
});

test('quest folders map to our script names', () => {
    expect(questScript('quest_tree')).toBe('quest-tree.ts');
    expect(questScript('quest_troll_love')).toBe('quest-trolllove.ts');
    expect(questScript('quest_mcannon')).toBe('dwarfcannon.ts');
    expect(questScript('quest_elemental_workshop')).toBe('quest-elemental.ts');
});

test('pinned journal names cover all journal quests, excluding the barcrawl miniquest', () => {
    const names = questJournalNames();
    const folders = readdirSync(resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content/scripts/quests')).filter(f => f.startsWith('quest_'));
    expect(folders.filter(folder => !names.has(folder))).toEqual(['quest_barcrawl']);
    expect([...names.keys()].sort()).toEqual(folders.filter(folder => folder !== 'quest_barcrawl').sort());
    expect([...names.values()].sort()).toEqual(questDefinitions().map(q => q.name).sort());
    expect(names.get('quest_blackknight')).toBe("Black Knight's Fortress");
    expect(names.get('quest_runemysteries')).toBe('Rune Mysteries Quest');
});

test('live completion outranks practice and scripts without promoting incomplete or unknown quests', () => {
    const names = questJournalNames();
    const folders = ['quest_cook', 'quest_runemysteries', 'quest_blackknight', 'quest_doric', 'quest_imp', 'quest_tree'];
    const quests = folders.map(folder => ({ folder, varp: folder, name: names.get(folder), questPoints: 1 }));
    const statuses = [{ quests: [
        { name: "Cook's Assistant", state: 'complete' },
        { name: 'Rune Mysteries Quest', state: 'complete' },
        { name: "Black Knight's Fortress", state: 'complete' },
        { name: "Doric's Quest", state: 'started' },
        { name: 'Imp Catcher', state: 'unknown' },
    ] }];
    const result = questStages(statuses, new Set(['quest_cook', 'quest_doric']), new Set(['quest_runemysteries', 'quest_imp']), quests);
    expect(result.folders.map(q => q.stage)).toEqual(['live', 'live', 'live', 'practice', 'named', 'none']);
    const summary = scoreboardSummary({ quests: result, skills: [], domains: [] });
    expect(summary.quests.practice).toEqual(['doric']);
    expect(summary.quests.named).toEqual(['imp']);
    expect(summary.quests.none).toEqual(['tree']);
    expect(summary.quests.liveComplete).toHaveLength(3);
});

test('practice passes come from every results log and need a finished quest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'practice-'));
    const rows = (...r: unknown[]) => r.map(x => JSON.stringify(x)).join('\n') + '\n{"cut';
    writeFileSync(join(dir, 'results.jsonl'), rows(
        { goal: 'quest-cook', ok: true, text: 'ok qp=1 xp=cooking=300' },
        { goal: 'waterfall', ok: true, text: 'ok attackXp=9' },
        { goal: 'quest-mm', ok: true, text: 'ok stage=70 (stages 80-160 not scripted)' },
        { goal: 'quest-tree', ok: true, text: 'ok stopped at 40' },
        { goal: 'quest-imp', ok: true, text: 'ok qp=0 xp=' },
        { goal: 'quest-doric', ok: false, text: 'fail Error: x' },
        { goal: 'ball', ok: true, text: 'ok' }));
    mkdirSync(join(dir, 'sweep'));
    writeFileSync(join(dir, 'sweep', 'results.jsonl'), rows({ quest: 'ball', ok: true, result: 'RESULT ok qp=4' }, { quest: 'quest-rj.ts', ok: true, result: 'RESULT ok qp=5' }, { quest: 'mm', ok: true, result: 'RESULT ok stage=70' }));
    const byScript = new Map(['quest_cook', 'quest_waterfall', 'quest_mm', 'quest_tree', 'quest_imp', 'quest_doric', 'quest_ball', 'quest_romeojuliet'].map(f => [questScript(f), f]));
    expect([...practicePasses(dir, byScript)].sort()).toEqual(['quest_ball', 'quest_cook', 'quest_romeojuliet', 'quest_waterfall']);
    expect(practicePasses(join(dir, 'missing'), byScript).size).toBe(0);
});

test('a side snapshot carries quests only when the side shared them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-quests-'));
    const acct = (name: string, extra = {}) => ({ name, server: 'rs-sdk-demo.fly.dev', at: 1_800_000_000_000, skills: [], ...extra });
    writeFileSync(join(dir, 'claude-cloud.json'), JSON.stringify({ side: 'claude-cloud', accounts: [acct('Kilt', { quests: ["Cook's Assistant"] }), acct('Haggis', { quests: ['Dragon Slayer'] }), acct('Old')] }));
    const { accounts } = sideSnapshots(dir, 'local', 1_800_000_000_000);
    expect(accounts.map(a => [a.name, a.quests])).toEqual([['Kilt', ["Cook's Assistant"]], ['Old', undefined]]);
    const quests = [{ folder: 'quest_cook', varp: 'cookquest', name: "Cook's Assistant", questPoints: 1 }];
    const local = questStages([], new Set(), new Set(), quests), shared = questStages(accounts.map(a => ({ quests: (a.quests ?? []).map(name => ({ name, state: 'complete' })) })), new Set(), new Set(), quests);
    expect(local.folders[0]!.stage).toBe('none');
    expect(shared.folders[0]!.stage).toBe('live');
    expect(shared.liveComplete).toEqual(["Cook's Assistant"]);
});

test('an unmapped journal label cannot imply a folder completion', () => {
    const result = questStages([{ quests: [{ name: 'quest_cook', state: 'complete' }] }], new Set(), new Set(),
        [{ folder: 'quest_cook', varp: 'cookquest', name: "Cook's Assistant", questPoints: 1 }]);
    expect(result.folders[0]!.stage).toBe('none');
});

test('owned names come from the verified-login registry, never the main account; a machine without one owns none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owned-'));
    expect(ownedNames(join(dir, 'owned-accounts.json'))).toEqual(new Set());
    writeFileSync(join(dir, 'owned-accounts.json'), JSON.stringify({ Haggis: { server: 'rs-sdk-demo.fly.dev', at: 1 }, undermykilt: { server: 'rs-sdk-demo.fly.dev', at: 1 } }));
    expect(ownedNames(join(dir, 'owned-accounts.json'))).toEqual(new Set(['undermykilt']));
});

test('items and skill bands come from owned live statuses', () => {
    const statuses = [{ skills: [{ name: 'Magic', level: 55 }], bank: [{ baseId: 554, count: 30 }], inventory: [{ id: 1351 }] }];
    expect(itemsHeld(statuses, [{ id: 554, tradeable: true }, { id: 1351 }, { id: 9 }])).toEqual({ items: 3, held: 2, tradeable: 1, tradeableHeld: 1 });
    const magic = skillBands(statuses).find(s => s.skill === 'Magic')!;
    expect(magic.bands.map(b => b.stage)).toEqual(['live', 'live-partial', 'none']);
});

const NOW = 1_800_000_000_000, HOUR = 3_600_000, SERVER = 'rs-sdk-demo.fly.dev';
function snapshotDir() {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-snap-'));
    const acct = (name: string, at: number, magic: number) => ({ name, server: SERVER, at, skills: [{ name: 'Magic', level: magic }, { name: 'Ranged', level: 20 }] });
    writeFileSync(join(dir, 'claude-cloud.json'), JSON.stringify({ side: 'claude-cloud', at: NOW, accounts: [acct('TheFullMonty', NOW - HOUR, 52), acct('Haggis', NOW, 90)] }));
    writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ side: 'cloud', at: NOW, accounts: [acct('OldBoy', NOW - 30 * HOUR, 70)] }));
    writeFileSync(join(dir, 'local.json'), JSON.stringify({ side: 'local', at: NOW, accounts: [acct('Shaftmaker', NOW, 80)] }));
    return dir;
}

test('a fresh cloud snapshot raises the fleet best of a skill', () => {
    const shared = sideSnapshots(snapshotDir(), 'local', NOW);
    const magic = fleetSkills([{ name: 'Shaftmaker', skills: [{ name: 'Magic', level: 37 }, { name: 'Ranged', level: 63 }] }], shared.accounts, 'local').find(s => s.skill === 'Magic')!;
    expect(magic).toMatchObject({ best: 52, account: 'TheFullMonty', side: 'claude-cloud' });
    expect(magic.bySide.local).toEqual({ level: 37, account: 'Shaftmaker' });
    const leads = fleetLeads(fleetSkills([{ name: 'Shaftmaker', skills: [{ name: 'Magic', level: 37 }, { name: 'Ranged', level: 63 }] }], shared.accounts, 'local'), 'local');
    expect(leads.find(l => l.skill === 'Magic')!.otherSideLeads).toBe(true);
    expect(leads.find(l => l.skill === 'Ranged')).toMatchObject({ side: 'local', otherSideLeads: false });
});

test("a stale snapshot and this side's own snapshot are ignored", () => {
    const shared = sideSnapshots(snapshotDir(), 'local', NOW);
    expect(shared.stale).toEqual(['cloud:OldBoy']);
    expect(shared.accounts.map(a => a.name)).toEqual(['TheFullMonty']);
    expect(sideSnapshots(snapshotDir(), 'local', NOW, 48 * HOUR).accounts.map(a => a.name).sort()).toEqual(['OldBoy', 'TheFullMonty']);
});

test('Haggis is left out of shared fleet output', () => {
    const shared = sideSnapshots(snapshotDir(), 'local', NOW);
    const rows = fleetSkills([{ name: 'Haggis', skills: [{ name: 'Ranged', level: 99 }] }], shared.accounts, 'local');
    expect(JSON.stringify(rows)).not.toContain('Haggis');
    expect(rows.find(s => s.skill === 'Magic')!.best).toBe(52);
    expect(rows.find(s => s.skill === 'Ranged')).toMatchObject({ best: 20, side: 'claude-cloud' });
    const summary = scoreboardSummary({ quests: { liveComplete: [], folders: [] }, skills: [], domains: [], fleetSkills: rows, fleet: { side: 'local' } });
    expect(JSON.stringify(summary)).not.toContain('Haggis');
});
