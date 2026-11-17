import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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
    'context-menu': [shell, 'game-context'], opponent: [shell, 'game-opponent'], 'name-tags': [page, 'Tile indicator (RuneLite)'], '3d': [page, 'id="rsw"'], wall: [shell, 'wall-chrome'], screens: [shell, 'game-loading'],
    'pvp-hud': [shell, 'game-pvp-hud'], 'title-diag': [shell, 'title-diag'], 'wild-overlay': [shell, 'wildernessHotspotsBox'],
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
test('client-assets contains only rev 289 skills, prayers and standard spells', () => {
    const files = readdirSync(new URL('./client-assets', import.meta.url)).filter(f => f.endsWith('.png'));
    const skills = new Set(['attack','defence','strength','hitpoints','ranged','prayer','magic','cooking','woodcutting','fletching','fishing','firemaking','crafting','smithing','mining','herblore','agility','thieving','runecraft','combat','overall']);
    const prayers = new Set(['thick-skin','burst-of-strength','clarity-of-thought','rock-skin','superhuman-strength','improved-reflexes','rapid-restore','rapid-heal','protect-item','steel-skin','ultimate-strength','incredible-reflexes','protect-from-magic','protect-from-missiles','protect-from-melee']);
    const spells = new Set(['wind-strike','water-strike','earth-strike','fire-strike','wind-bolt','water-bolt','earth-bolt','fire-bolt','wind-blast','water-blast','earth-blast','fire-blast','wind-wave','water-wave','earth-wave','fire-wave','bind','snare','entangle','confuse','weaken','curse','vulnerability','enfeeble','stun','crumble-undead','saradomin-strike','claws-of-guthix','flames-of-zamorak','iban-blast','enchant-level-1-jewellery','enchant-level-2-jewellery','enchant-level-3-jewellery','enchant-level-4-jewellery','enchant-level-5-jewellery','varrock-teleport','lumbridge-teleport','falador-teleport','camelot-teleport','ardougne-teleport','watchtower-teleport','trollheim-teleport','charge-air-orb','charge-water-orb','charge-earth-orb','charge-fire-orb','low-level-alchemy','high-level-alchemy','superheat-item','bones-to-bananas','telekinetic-grab','charge']);
    expect(files.filter(f => f.startsWith('skill-') && !skills.has(f.slice(6, -4)))).toEqual([]);
    expect(files.filter(f => f.startsWith('prayer-') && !prayers.has(f.slice(7, -4)))).toEqual([]);
    expect(files.filter(f => f.startsWith('spell-') && !spells.has(f.slice(6, -4)))).toEqual([]);
});
test('every spell, prayer and rail icon referenced by client-shell exists in client-assets', () => {
    const assets = new Set(readdirSync(new URL('./client-assets', import.meta.url)));
    const spellbook = JSON.parse(readFileSync(new URL('./client-assets/spellbook.json', import.meta.url), 'utf8'));
    const spellSlug = (n: string) => n.toLowerCase().replace(/\blvl-(\d+)\b/g, 'level-$1').replace(/\bjewelry\b/g, 'jewellery').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const utilMatch = shell.match(/const util=\[([\s\S]*?)\]\.map\(/);
    expect(utilMatch).toBeTruthy();
    const util: string[] = (Function(`return [${utilMatch![1]}]`)() as any[]).map((x: any) => String(x[0]));
    const allSpells = [...(spellbook.combat || []).map((x: any) => x[0]), ...util, ...(spellbook.spells || []).map((x: any) => x[0])];
    expect(new Set(allSpells).size).toBe(52);
    const spriteOnly = new Set(['charge-air-orb', 'fire-wave', 'vulnerability', 'enfeeble', 'stun']);
    for (const sp of allSpells) {
        const slug = spellSlug(sp);
        if (spriteOnly.has(slug)) expect(assets.has('magicon.png') && assets.has('magicoff.png')).toBe(true);
        else if (slug === 'entangle') expect(assets.has('magicon2.png') && assets.has('magicoff2.png')).toBe(true);
        else expect(assets.has(`spell-${slug}.png`), `missing client-assets/spell-${slug}.png`).toBe(true);
    }
    const prayers = ['thick-skin','burst-of-strength','clarity-of-thought','rock-skin','superhuman-strength','improved-reflexes','rapid-restore','rapid-heal','protect-item','steel-skin','ultimate-strength','incredible-reflexes','protect-from-magic','protect-from-missiles','protect-from-melee'];
    for (const p of prayers) expect(assets.has(`prayer-${p}.png`)).toBe(true);
    expect(assets.has('tab-equipment.png')).toBe(true);
    expect(assets.has('sideicons.png')).toBe(true);
});
