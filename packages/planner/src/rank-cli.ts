import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { xpForLevel } from './curve';

// Ranks hiscore boards by what it would really take to win them, supply first (red-team finding H1).
// Usage: bun packages/planner/src/rank-cli.ts [snapshot=research/hiscores-2026-10-22.json]
// Inputs: the live hiscore snapshot, the per-skill best methods from research/xp-per-tick.md (estimates), measured
// overheads (research/crafting-board.md, research/levelup-cost.md), and the live GE market (read-only, 1 req/s).

const TUTORIAL = 10; // measured: fresh account to Lumbridge
const DIALOG_PER_LEVEL = 2.7; // measured: 40-42 ticks for 15 levels when the next action is blocked

interface Board {
    board: string;
    estTicks: number | null; // research/xp-per-tick.md "Est. ticks 1->99" (model, not measured)
    blockedActions: boolean; // the method needs bank/trade/loc actions between batches, so dialogs cost ticks
    input?: { query: string; xpPerUnit25x: number }; // top-tier input helpers must supply, XP per unit at 25x
    note: string;
}

// Rows from research/xp-per-tick.md; input XP per unit at 25x from the same table.
const BOARDS: Board[] = [
    { board: 'Cooking', estTicks: 25, blockedActions: false, input: { query: 'grapes', xpPerUnit25x: 2759 }, note: 'hand-made wine at 35 then bank ferment; login-timer route excluded (bug report)' },
    { board: 'Fletching', estTicks: 48, blockedActions: true, input: { query: 'rune dart tip', xpPerUnit25x: 470 }, note: 'arrows then darts, 5 actions/tick' },
    { board: 'Crafting', estTicks: 79, blockedActions: true, input: { query: 'uncut dragonstone', xpPerUnit25x: 3437 }, note: 'measured: 27 cuts in 7 ticks, trade resupply 12 ticks' },
    { board: 'Herblore', estTicks: 71, blockedActions: true, input: { query: 'torstol', xpPerUnit25x: 4375 }, note: 'finish potions 5/tick; zamorak brew from 78' },
    { board: 'Firemaking', estTicks: 693, blockedActions: true, input: { query: 'magic logs', xpPerUnit25x: 7595 }, note: 'log ladder, ~4 ticks/log' },
    { board: 'Prayer', estTicks: 1169, blockedActions: true, input: { query: 'dragon bones', xpPerUnit25x: 1800 }, note: 'bury, 2 ticks/bone' },
    { board: 'Smithing', estTicks: 913, blockedActions: true, input: { query: 'adamantite bar', xpPerUnit25x: 1562 }, note: 'platebodies, 5 bars each' },
    { board: 'Magic', estTicks: 1708, blockedActions: true, input: { query: 'cosmic rune', xpPerUnit25x: 1950 }, note: 'enchant jewellery; Charge needs Mage Arena' },
    { board: 'Runecraft', estTicks: 1256, blockedActions: true, input: { query: 'rune essence', xpPerUnit25x: 237 }, note: 'law altar, essence traded in' },
    { board: 'Thieving', estTicks: 2325, blockedActions: false, note: 'pickpocket ladder, no supply' },
    { board: 'Woodcutting', estTicks: 3852, blockedActions: false, note: 'power-chop, no supply' },
    { board: 'Fishing', estTicks: 3940, blockedActions: false, note: 'power-fish, no supply' },
    { board: 'Mining', estTicks: 3601, blockedActions: false, note: 'power-mine iron, no supply' },
    { board: 'Agility', estTicks: 6800, blockedActions: false, note: 'courses, no supply' },
    { board: 'Attack', estTicks: null, blockedActions: true, note: 'quest XP; quest time not measured' },
    { board: 'Strength', estTicks: null, blockedActions: true, note: 'quest XP; quest time not measured' },
    { board: 'Defence', estTicks: null, blockedActions: true, note: 'quest XP; quest time not measured' },
    { board: 'Ranged', estTicks: 1700, blockedActions: true, note: 'cannon; quest needed; not verified' },
    { board: 'Hitpoints', estTicks: null, blockedActions: true, note: 'combat or quest XP; not estimated' },
];

type Market = { name: string; bid: number | null; ask: number | null; buyQuantity: number; sellQuantity: number; lastPrice: number | null; volume: number };

async function market(query: string): Promise<Market | null> {
    const res = await fetch(`https://rs-sdk-demo.fly.dev/api/market/items?q=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { items: Market[] };
    return j.items.find(i => i.name.toLowerCase() === query.toLowerCase()) ?? j.items[0] ?? null;
}

const root = resolve(import.meta.dir, '..', '..', '..');
const snapFile = process.argv[2] ?? 'research/hiscores-2026-10-22.json';
const snap = JSON.parse(readFileSync(join(root, snapFile), 'utf8')) as { takenAt: string; boards: { board: string; rows: { name: string; ticks: number }[] }[] };
const unitsFor99 = (xpPerUnit: number) => Math.ceil(xpForLevel(99) / xpPerUnit);

const rows: string[] = [];
const scored: { board: string; margin: number | null; supply: string }[] = [];
for (const b of BOARDS) {
    const leader = snap.boards.find(x => x.board === b.board)?.rows[0];
    const dialogs = b.blockedActions ? Math.round(98 * DIALOG_PER_LEVEL) : 0;
    const ours = b.estTicks === null ? null : TUTORIAL + b.estTicks + dialogs;
    const margin = ours === null || !leader ? null : leader.ticks - ours;
    let supply = 'none needed';
    if (b.input) {
        const m = await market(b.input.query);
        await Bun.sleep(1000);
        const need = unitsFor99(b.input.xpPerUnit25x);
        supply = m
            ? `${m.name}: need ~${need}; sellers ${m.sellQuantity}, wanted ${m.buyQuantity}, bid ${m.bid ?? '-'}, ask ${m.ask ?? '-'}, last ${m.lastPrice ?? '-'}`
            : `${b.input.query}: no market data`;
    }
    scored.push({ board: b.board, margin, supply });
    rows.push(`| ${b.board} | ${leader ? `${leader.name} ${leader.ticks}` : '-'} | ${ours ?? 'not estimated'} | ${margin ?? '-'} | ${supply} | ${b.note} |`);
}

const out = [
    '# Board ranking (supply first)',
    '',
    `Generated by \`bun packages/planner/src/rank-cli.ts\` from ${snapFile} (taken ${snap.takenAt}) and the live GE market.`,
    '',
    `Our ticks = tutorial ${TUTORIAL} + method estimate (research/xp-per-tick.md, a model) + level-up dialogs`,
    `(${DIALOG_PER_LEVEL} ticks x 98 levels when the method needs blocked actions between batches; measured in research/levelup-cost.md).`,
    'Margin = leader ticks - our ticks. Positive means winnable on time alone. Supply decides whether it is winnable at all.',
    '',
    '| Board | #1 (ticks) | Our ticks | Margin | Supply (live GE) | Method |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Reading it',
    '- Only the Crafting numbers include measured cycle times; every other estimate is the research model.',
    '- "need" counts top-tier inputs only (lower tiers on the way up are extra).',
    '- Sellers 0 with many wanted means other operators are already buying that input.',
    '',
];
writeFileSync(join(root, 'research', 'board-ranking.md'), out.join('\n'));
for (const s of scored.sort((a, b) => (b.margin ?? -1e9) - (a.margin ?? -1e9))) console.log(`${s.board.padEnd(11)} margin ${String(s.margin ?? '-').padStart(6)} | ${s.supply}`);
