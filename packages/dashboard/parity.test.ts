import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { settingNames, RUNELITE_SHA } from './tools/runelite-features';

// Every sidebar plugin, game tab and HUD part has a row in research/runelite-parity.md, and every row names a
// part that exists: a new part cannot ship without its RuneLite comparison, and a removed one leaves no stale row.
const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
const shell = read('./client-shell.js'), ops = read('./operations.js'), page = read('./index.html');
const doc = read('../../research/runelite-parity.md');
const ids = (src: string, name: RegExp) => [...(src.match(name)?.[1] ?? '').matchAll(/\['([a-z-]+)'/g)].map(m => m[1]!);

const plugins = new Set([...ids(shell, /const plugins=\[(.*?)\];/), ...Object.keys(Function(`return ${ops.match(/const pluginNames=(\{.*?\});/)![1]}`)())]);
const tabs = new Set([...ids(shell, /const tabs=\[(.*?)\];/), 'logout']);
// HUD parts with the code that draws each, so the list follows the page.
const HUD: Record<string, [string, string]> = {
    orbs: [shell, 'game-orbs'], 'xp-drops': [shell, 'xp-drops'], 'xp-globes': [shell, 'xp-globes'], minimap: [shell, 'game-minimap'],
    places: [shell, 'game-places'], overlay: [shell, 'game-overlay'], infoboxes: [shell, 'game-infoboxes'], chat: [shell, 'game-chat'],
    idle: [shell, 'function idleNotifier'], notify: [shell, 'function desktopNotify'], 'bank-window': [shell, 'game-bank'],
    'context-menu': [shell, 'game-context'], 'name-tags': [page, 'Tile indicator (RuneLite)'], '3d': [page, 'id="rsw"'], screens: [shell, 'game-loading'],
};
const parts = doc.slice(doc.indexOf('## Parts'), doc.indexOf('## Not used'));
const rows = new Map([...parts.matchAll(/^\| `([a-z0-9-]+)` \| ([^|]+) \| (copy|adapt|reject|own) \|/gm)].map(m => [m[1]!, { source: m[2]!.trim(), decision: m[3]! }]));

test('the parity record pins the same RuneLite commit as the feature tool', () => {
    expect(doc).toContain(RUNELITE_SHA);
});
test('every sidebar plugin, game tab and HUD part has a parity row with a decision', () => {
    for (const [id, [src, marker]] of Object.entries(HUD)) expect(src.includes(marker), `HUD part ${id} is drawn by "${marker}"`).toBe(true);
    const missing = [...plugins, ...tabs, ...Object.keys(HUD)].filter(id => !rows.has(id));
    expect(missing).toEqual([]);
});
test('every parity row names a part the dashboard has', () => {
    const known = new Set([...plugins, ...tabs, ...Object.keys(HUD)]);
    expect([...rows.keys()].filter(id => !known.has(id))).toEqual([]);
});
test('the feature tool reads RuneLite setting names', () => {
    expect(settingNames('@ConfigItem(keyName = "a", name = "Show XP/hr", description = "x")\n@ConfigItem(name = "Hide maxed skills")')).toEqual(['Show XP/hr', 'Hide maxed skills']);
});
