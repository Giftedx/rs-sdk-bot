import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAIN_FOOD } from '../src/eat-guard';
import { questFoodDefinitions } from '../src/sustain';

// These tests read the pinned server content. They fail when a content change makes a plain food item unsafe for the
// eat guard: a new effect, a new option, or a quest that takes the item in a script with no hold on the guard.
const root = resolve(import.meta.dir, '../../..');
const content = join(root, 'vendor/rs-sdk/server/content');
const names = new Map<number, string>();
for (const l of readFileSync(join(content, 'pack/obj.pack'), 'utf8').split(/\r?\n/)) { const m = l.match(/^(\d+)=(.+)$/); if (m) names.set(Number(m[1]), m[2]!); }
const walk = (dir: string, ext: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p); }
    return out;
};
const plain = PLAIN_FOOD.map(id => names.get(id)!);

test('each plain food item heals and has no other form or effect', () => {
    expect(new Set(PLAIN_FOOD).size).toBe(PLAIN_FOOD.length);
    const rows = readFileSync(join(content, 'scripts/player/configs/consumption/consume_normal.dbrow'), 'utf8').split(/\r?\n\s*\r?\n/);
    for (const id of PLAIN_FOOD) {
        const name = names.get(id);
        expect(name, `item ${id}`).toBeString();
        const def = questFoodDefinitions().get(id);
        expect(def?.heal, name).toBeGreaterThan(0);
        expect(def?.next, name).toBeUndefined();
        // The row of the item changes Hitpoints and no other stat.
        const row = rows.find(r => r.split(/\r?\n/).includes(`data=consumable,${name}`));
        expect(row, name).toBeString();
        const effects = row!.split(/\r?\n/).filter(l => /^data=(stat_|healenergy)/.test(l));
        expect(effects, name).toEqual([`data=stat_heal,hitpoints,${def!.heal},0`]);
    }
});

test('each plain food item has Eat as its first option and no second option', () => {
    const blocks = new Map<string, string>();
    for (const f of walk(join(content, 'scripts'), '.obj')) {
        for (const b of readFileSync(f, 'utf8').split(/\r?\n(?=\[)/)) { const m = b.match(/^\[([^\]]+)\]/); if (m) blocks.set(m[1]!, b); }
    }
    for (const name of plain) {
        const options = (blocks.get(name) ?? '').split(/\r?\n/).filter(l => /^iop\d=/.test(l));
        expect(options, name).toEqual(['iop1=Eat']);
    }
});

// A quest script that takes a plain food item from the inventory makes that item a quest item for its session.
const QUEST_TAKES: Record<string, { items: string[]; script: string }> = {
    quest_crest: { items: ['bass', 'salmon', 'shrimp', 'swordfish', 'tuna'], script: 'scripts/generated/quest-crest.ts' },
    quest_death: { items: ['trout'], script: 'scripts/generated/quest-death.ts' },
};

test('the quests that take plain food from the inventory are the known ones, and their scripts open with the quest library', () => {
    const quests = join(content, 'scripts/quests');
    const taken = new Map<string, Set<string>>();
    for (const f of walk(quests, '.rs2')) {
        const quest = relative(quests, f).split(sep)[0]!.replace(/\.rs2$/, '');
        for (const m of readFileSync(f, 'utf8').matchAll(/inv_(?:del|total)\(\s*inv\s*,\s*([a-z0-9_+]+)/g)) {
            if (plain.includes(m[1]!)) (taken.get(quest) ?? taken.set(quest, new Set()).get(quest)!).add(m[1]!);
        }
    }
    expect(Object.fromEntries([...taken].map(([q, items]) => [q, [...items].sort()]))).toEqual(Object.fromEntries(Object.entries(QUEST_TAKES).map(([q, v]) => [q, v.items])));
    for (const { script } of Object.values(QUEST_TAKES)) {
        expect(existsSync(join(root, script)), script).toBe(true);
        expect(readFileSync(join(root, script), 'utf8'), script).toMatch(/\bopenQuest\(/);
    }
});

test('each quest script in scripts/generated opens with the quest library or holds the guard itself', () => {
    const dir = join(root, 'scripts/generated');
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'quest-lib.ts')) {
        const text = readFileSync(join(dir, f), 'utf8');
        if (!/\bopenBot\(|\bopenQuest\(/.test(text)) continue;
        if (/^quest-/.test(f)) expect(/\bopenQuest\(|holdSessionEater\(/.test(text), f).toBe(true);
    }
    for (const f of ['scripts/generated/waterfall.ts', 'scripts/generated/dwarfcannon.ts', 'scripts/quest-sweep.ts', 'scripts/quest-order.ts', 'scripts/quest-items-order.ts', 'scripts/quest-cook-job.ts']) {
        expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/holdSessionEater\(s\.sdk\)/);
    }
});

test('openQuest holds the eat guard of its session and does not release it', () => {
    const url = (p: string) => JSON.stringify(pathToFileURL(resolve(root, p)).href);
    const code = `import assert from 'node:assert/strict';
 const { registerSessionEater } = await import(${url('packages/core/src/sustain.ts')});
 const { openQuest } = await import(${url('scripts/generated/quest-lib.ts')});
 let tick = 0, holds = 0, releases = 0; const callbacks = new Set();
 const s = { name: 'Main', tick: () => tick, ended: new Promise(() => {}), onTick: cb => { callbacks.add(cb); return () => callbacks.delete(cb); },
  sdk: { getState: () => ({ player: { lifeId: 1, respawnCount: 0, worldX: 3222, worldZ: 3218, level: 0 }, inventory: [], recentDialogs: [], gameMessages: [] }), getInventory: () => [], getDialog: () => ({ isOpen: false }), getSkill: () => ({ level: 99, baseLevel: 99 }), getSkillXp: () => 0 },
  direct: async () => { throw Error('first-direct'); } };
 registerSessionEater(s.sdk, () => { holds++; return { ateAt: -Infinity, release: () => { releases++; } }; });
 const timer = setInterval(() => { tick++; for (const cb of callbacks) cb(); }, 1);
 try { await assert.rejects(openQuest({ session: s }), /first-direct/); assert.equal(holds, 1); assert.equal(releases, 0); console.log('QUEST_HOLDS_EAT_GUARD'); } finally { clearInterval(timer); }
 process.exit(0);`;
    const result = Bun.spawnSync(['bun', '-e', code], { cwd: root, env: { ...process.env, Q_BURST: '0' }, stdout: 'pipe', stderr: 'pipe', timeout: 30000, windowsHide: true });
    if (result.exitCode !== 0) throw Error(result.stderr.toString() || result.stdout.toString());
    expect(result.stdout.toString()).toContain('QUEST_HOLDS_EAT_GUARD');
});
