// Practice duel for the player fight loop (scripts/pk.ts): a tribrid fights a dummy that only auto-retaliates with a
// dragon dagger, both at Wilderness level 5 north of Edgeville with 99 combat stats, rune armour and Lost City done.
// Practice server only: it creates two fresh bots with generated saves.
// Usage: bun scripts/measure/pk-duel.ts <label>. Environment:
//   FREEZE=1          cast a freeze whenever the dummy is free
//   READ=0            ignore the dummy's overhead prayer when choosing a style
//   SPEC=1            dragon dagger special at the dummy's health fraction SPEC_BELOW (default 0.5); full energy at start
//   DUMMY_PRAY=magic|ranged|melee   the dummy holds that protect prayer
//   DUMMY_FOOD=n      sharks for the dummy (default 0)
//   A_FOOD=n          sharks for the tribrid (default 18); ESCAPE_AT=hp rubs the carried glory once out of food
//   NO_GLORY=1        no glory carried; ESCAPE_SPELL=<component id> teleports instead (Varrock runes carried)
// Prints one `DUEL <label> <outcome> <result json>` line.
import { createBot } from '../../packages/practice/src/bots';
import { applyPreset } from '../../packages/practice/src/presets';
import { openBot, settle } from '../../packages/core/src/bot';
import { fightPlayer, ITEMS, PRAYER, type Kit, type Style } from '../pk';

const label = process.argv[2] ?? 'a', env = process.env;
const token = Math.random().toString(36).slice(2, 6);
const A = `pka${label}${token}`.slice(0, 12), B = `pkd${label}${token}`.slice(0, 12);
const ID = { mysticFireStaff: 1401, magicShortbow: 861, runeArrow: 892, dragonDaggerP: 1231, runeKiteshield: 1201 };
const max = { Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99, Prayer: 99, Hitpoints: 99 };
const lostCity = { 147: 6 }; // %zanaris complete: dragon weapons wield (levelrequire.rs2:156)
// Rune full helm, cape of legends, glory, rune platebody, rune platelegs, ranger boots.
const armour = [[1163, 0], [1052, 1], [1712, 2], [1127, 4], [1079, 7], [2577, 10]].map(([id, slot]) => ({ id: id!, count: 1, slot: slot! }));
const melee = [{ id: ID.dragonDaggerP, count: 1, slot: 3 }, { id: ID.runeKiteshield, count: 1, slot: 5 }];
const items = (pairs: number[][]) => pairs.map(([id, count]) => ({ id: id!, count: count! }));
const sharks = (n: number) => Array.from({ length: n }, () => [ITEMS.shark, 1]);
await createBot(A); await createBot(B);
// DUEL_Z puts both at another latitude, e.g. 3800 for Wilderness level 36 (beyond the glory's 30).
const z = Number(env.DUEL_Z ?? 3555);
await applyPreset(A, { position: { x: 3094, z, level: 0 }, skills: max, varps: { ...lostCity, 300: 1000 },
    equipment: [...armour, ...melee, { id: ID.runeArrow, count: 300, slot: 13 }],
    // Staff, bow, air/blood runes for Fire Wave, earth/water/nature for the freezes, 2 prayer potions, a glory, sharks.
    inventory: items([[ID.mysticFireStaff, 1], [ID.magicShortbow, 1], [ITEMS.airRune, 500], [ITEMS.bloodRune, 100], [ITEMS.earthRune, 200],
        [ITEMS.waterRune, 200], [ITEMS.natureRune, 100], [2434, 1], [2434, 1], ...(env.NO_GLORY === '1' ? [[ITEMS.lawRune, 2], [ITEMS.fireRune, 2]] : [[1712, 1]]),
        ...sharks(Number(env.A_FOOD ?? 18))]) });
await applyPreset(B, { position: { x: 3096, z, level: 0 }, skills: max, varps: lostCity,
    equipment: [...armour, ...melee], inventory: items(sharks(Number(env.DUMMY_FOOD ?? 0))) });
const a = await openBot(A), b = await openBot(B);
const pray = { magic: PRAYER.magic, ranged: PRAYER.missiles, melee: PRAYER.melee }[env.DUMMY_PRAY ?? ''];
if (pray !== undefined) { await b.sdk.sendTogglePrayer(pray); await new Promise(r => setTimeout(r, 1200)); console.log(`dummy prayer ${pray} active=${b.sdk.isPrayerActive(pray)}`); }
const kit: Kit = { magic: [ID.mysticFireStaff], ranged: [ID.magicShortbow], melee: [ID.dragonDaggerP, ID.runeKiteshield] };
const r = await fightPlayer(a, B, {
    kit, cap: 900, freeze: env.FREEZE === '1', readOverheads: env.READ !== '0', rotation: (env.ROTATION ?? 'magic,ranged,melee').split(',') as Style[],
    escapeAt: env.ESCAPE_AT ? Number(env.ESCAPE_AT) : undefined, escapeSpell: env.ESCAPE_SPELL ? Number(env.ESCAPE_SPELL) : undefined,
    spec: env.SPEC === '1' ? { kit: [ID.dragonDaggerP, ID.runeKiteshield], bar: 'combat_stabsword:specbar', cost: 250, below: Number(env.SPEC_BELOW ?? 0.5) } : undefined,
    log: l => console.log(`[${A}] ${l}`),
});
const hp = (s: typeof a) => s.sdk.getState()?.player?.hp;
console.log(`DUEL ${label} ${r.outcome} ${JSON.stringify(r)} hpA=${hp(a)} hpB=${hp(b)}`);
await settle([a, b], true, r.outcome);
process.exit(0);
