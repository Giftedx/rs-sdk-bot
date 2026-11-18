// Readiness of the gang squad's accounts (scripts/pk-squad.ts), from the status files only: it logs in no account.
// For each account it gives the kit that the account can wear and carry from its own stock (worn, pack and bank),
// each missing piece with the nearest owned account that holds a spare one, and a verdict. scripts/pk-squad.ts takes
// its pack from what an account holds at login (scripts/pk-gang.ts packOf) and asks for the same pack again at each
// bank trip (bankTrip), so an account must hold the whole kit before the squad starts.
// The rule gang-chain-bind is the bench kit live-walker-iron-rune-chain-bind (scripts/pk-kits.ts) with each piece
// widened to its class, and the checks are the faults of the live pilots (research/pvp-fight-loop.md):
//   body and leg armour (an account with no leg armour died), a melee weapon with a special attack or a rune blade,
//   a bow with arrows that it can fire, the runes of an escape teleport that the account can cast (pk-squad.ts
//   squadEscapeSpell: an account clicked Camelot Teleport with no law runes), the runes of Bind, an antipoison
//   (poison did 139 of 455 damage), sharks for a full pack, a bank read of a stated age, and a place the walker leaves.
// Usage: bun scripts/squad-ready.ts [<account> ...] [--root <checkout>] [--max-age <hours>] [--json]
//          [--loadouts <dir>] [--orders <dir>]
//   No account named: every account of this fleet side with 99 in the seven combat skills.
//   --root      the checkout whose .practice/status, .practice/market-all.json and fleet owners the tool reads
//               (default: the main checkout of this repository).
//   --loadouts  writes <account>.json for each account that holds its kit: the input of the kit step,
//               `bun scripts/aio-logistics.ts <account> loadout <file>` at the bank the file names.
//   --orders    writes one fleet order file for each transfer of the plan into <dir>, for review. The tool refuses the
//               fleet's own orders folder; `bun scripts/fleet-order.ts`, which the plan prints, places an order.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BANK_MEETS } from './coin-courier';
import { makeOrder, writeFleetOrder } from './fleet-order';
import { castableFreeze, defaultSpec, ITEMS, wildernessLevel } from './pk';
import { packOf } from './pk-gang';
import { kitItems } from './pk-kits';
import { kitFrom } from './pk-roam';
import { SQUAD_OPTS, SQUAD_POST, squadEscapeSpell } from './pk-squad';
import { PROFILES } from './shop-buyer';

export type Item = { id: number; name: string; count: number };
export type Worn = Item & { slot: number };
export type Account = { name: string; at: number; bankAt: number | null; pos: { x: number; z: number; level: number }; levels: Readonly<Record<string, number>>; quests: ReadonlySet<string>;
    worn: Worn[]; pack: Item[]; bank: Item[]; side?: string; reservation?: string };
export type Gear = { id: number; name: string; slot: string; tier?: number; special?: { pvp?: boolean }; requires?: { skills?: Record<string, number>; quest?: string };
    bonuses: Record<string, number>; tradeable?: boolean };
export type Rule = { name: string; benchKit: string; maxBankAgeHours: number; maxDonorBankAgeHours: number; minArrows: number };
export const RULES: Readonly<Record<string, Rule>> = {
    'gang-chain-bind': { name: 'gang-chain-bind', benchKit: 'live-walker-iron-rune-chain-bind', maxBankAgeHours: 6, maxDonorBankAgeHours: 168, minArrows: 100 },
};

const SLOT: Readonly<Record<string, number>> = { hat: 0, back: 1, front: 2, righthand: 3, torso: 4, lefthand: 5, legs: 7, hands: 9, feet: 10, ring: 12, quiver: 13 };
const COMBAT = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Prayer', 'Hitpoints'] as const;
const MELEE_BLADE = /dagger|scimitar|longsword|sword|mace|battleaxe|warhammer|spear|halberd/i, BOW = /bow$/i, CROSSBOW = /crossbow/i;
const FOOD_ID = ITEMS.shark as number, PACK_SLOTS = 27;
const armour = (g: Gear) => (g.bonuses.stabDefence ?? 0) + (g.bonuses.slashDefence ?? 0) + (g.bonuses.crushDefence ?? 0);
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
// West Ardougne behind its wall (x 2558): the city doors stay shut until Biohazard is complete, and the walker has no
// route across the wall (packages/planner/src/autopilot.ts inWestArdougne).
export const inWestArdougne = (p: { x: number; z: number }) => p.x >= 2496 && p.x <= 2557 && p.z >= 3264 && p.z <= 3335;

export const maxed = (a: Account) => COMBAT.every(s => (a.levels[s.toLowerCase()] ?? 1) >= 99);
// Everything an account owns, by item id.
export function holdings(a: Account): Map<number, Item> {
    const out = new Map<number, Item>();
    for (const i of [...a.worn, ...a.pack, ...a.bank]) out.set(i.id, { id: i.id, name: i.name, count: (out.get(i.id)?.count ?? 0) + i.count });
    return out;
}
export function wearable(g: Gear, a: Account): boolean {
    return Object.entries(g.requires?.skills ?? {}).every(([skill, level]) => (a.levels[skill.toLowerCase()] ?? 1) >= level)
        && (!g.requires?.quest || a.quests.has(g.requires.quest.toLowerCase()));
}

// A piece that the account lacks. `accept` says which item of a donor fills it for this account; `blocking`: the
// verdict is "not ready" without it. `id`: the item to buy when no account has a spare one (the bench kit's piece
// for a class of items).
export type Need = { what: string; count: number; blocking: boolean; id?: number; accept: (item: Item) => boolean };
export type Pick = { account: string; ready: boolean; reasons: string[]; notes: string[]; worn: Worn[]; carried: Item[]; food: number; foodSlots: number; foodHeld: number;
    styles: string[]; special: string | null; escape: string | null; freeze: string | null; needs: Need[]; pack: ReturnType<typeof packOf> };

const SPELL_NAME: Readonly<Record<number, string>> = { 1174: 'Camelot Teleport', 1164: 'Varrock Teleport' };

// The kit of one account under the rule, from its own stock, with the pieces that it lacks.
export function pickKit(a: Account, gear: ReadonlyMap<number, Gear>, rule: Rule, now: number, kit = kitItems(rule.benchKit), nameOf: (id: number) => string | undefined = () => undefined, post = SQUAD_POST): Pick {
    const own = holdings(a), needs: Need[] = [], reasons: string[] = [], notes: string[] = [];
    const benchPiece = (test: (g: Gear) => boolean) => [...kit.equipment, ...kit.inventory].map(i => gear.get(i.id)).find(g => !!g && test(g))?.id;
    const owned = [...own.values()].filter(i => i.count > 0), g = (i: Item) => gear.get(i.id);
    const canWear = (i: Item) => { const row = g(i); return !!row && wearable(row, a); };
    const benchWorn = new Map(kit.equipment.map(e => [e.slot, gear.get(e.id)] as const));
    const worn: Worn[] = [];
    const wear = (i: Item | undefined, slot: number, count = 1) => { if (i) worn.push({ id: i.id, name: i.name, count, slot }); };
    // Armour: the piece of each slot with the most melee defence that the account can wear. Body and legs must reach
    // half the defence of the bench kit's piece (green dragonhide chaps and mithril platelegs are under it).
    for (const [slot, required] of [['hat', false], ['torso', true], ['legs', true], ['lefthand', false]] as const) {
        const bench = benchWorn.get(SLOT[slot]!), floor = required && bench ? Math.ceil(armour(bench) / 2) : 1;
        const fits = (i: Item, who: (i: Item) => boolean) => { const row = g(i); return !!row && row.slot === slot && armour(row) >= floor && (slot !== 'lefthand' || /shield$/i.test(row.name)) && who(i); };
        const best = owned.filter(i => fits(i, canWear)).sort((x, y) => armour(g(y)!) - armour(g(x)!))[0];
        wear(best, SLOT[slot]!);
        if (!best && required) needs.push({ what: `${slot === 'torso' ? 'body' : 'leg'} armour (melee defence ${floor} or more)`, count: 1, blocking: true, ...(bench ? { id: bench.id } : {}), accept: i => fits(i, canWear) && g(i)!.tradeable !== false });
        else if (bench && (!best || armour(g(best)!) < armour(bench))) {
            notes.push(best ? `${best.name} is weaker than the bench kit's ${bench.name}` : `no ${bench.name} or other ${slot} piece`);
            needs.push({ what: bench.name, count: 1, blocking: false, id: bench.id, accept: i => fits(i, canWear) && armour(g(i)!) >= armour(bench) && g(i)!.tradeable !== false });
        }
    }
    // Amulet: a charged glory, else the piece with the most strength.
    const amulet = owned.filter(i => g(i)?.slot === 'front' && canWear(i)).sort((x, y) => Number(/glory\([1-4]\)/i.test(y.name)) - Number(/glory\([1-4]\)/i.test(x.name)) || (g(y)!.bonuses.strength ?? 0) - (g(x)!.bonuses.strength ?? 0))[0];
    wear(amulet, SLOT.front!);
    if (!amulet) notes.push('no amulet');
    // Melee weapon: a dragon dagger first (the gang-hunter profile's special), then the other special weapons, then a
    // rune blade, each by its strength bonus.
    const blade = (i: Item) => { const row = g(i); return !!row && row.slot === 'righthand' && MELEE_BLADE.test(row.name) && !BOW.test(row.name) && !/staff/i.test(row.name) && (!!row.special?.pvp || /^rune /i.test(row.name)); };
    const rank = (i: Item) => (/^dragon dagger/i.test(i.name) ? 2000 : g(i)!.special?.pvp ? 1000 : 0) + (g(i)!.bonuses.strength ?? 0);
    const weapon = owned.filter(i => blade(i) && canWear(i)).sort((x, y) => rank(y) - rank(x))[0];
    wear(weapon, SLOT.righthand!);
    if (!weapon) needs.push({ what: 'melee weapon with a special attack or a rune blade', count: 1, blocking: true, ...(benchWorn.get(SLOT.righthand!) ? { id: benchWorn.get(SLOT.righthand!)!.id } : {}), accept: i => blade(i) && canWear(i) && g(i)!.tradeable !== false });
    // Bow and arrows: the bow with the most ranged attack, and the cheapest arrows that it fires (tier at or under the
    // bow's tier) with the bench kit's count, else the largest stack.
    const isBow = (i: Item) => { const row = g(i); return !!row && row.slot === 'righthand' && row.tier !== undefined && BOW.test(row.name) && !CROSSBOW.test(row.name); };
    const bow = owned.filter(i => isBow(i) && canWear(i)).sort((x, y) => (g(y)!.bonuses.rangeAttack ?? 0) - (g(x)!.bonuses.rangeAttack ?? 0))[0];
    const wantArrows = kit.equipment.find(e => e.slot === 13)?.count ?? 300, bowTier = bow ? g(bow)!.tier! : 1;
    const fires = (i: Item, tier: number) => { const row = g(i); return !!row && row.slot === 'quiver' && /arrow$/i.test(row.name) && (row.tier ?? 99) <= tier; };
    const stacks = owned.filter(i => fires(i, bowTier)).sort((x, y) => (g(x)!.tier ?? 0) - (g(y)!.tier ?? 0));
    const benchBow = benchPiece(row => BOW.test(row.name)), benchArrow = kit.equipment.find(e => e.slot === 13)?.id;
    // Arrows as strong as the bench kit's first: the first live pilot shot bronze arrows on two accounts.
    const strength = (i: Item) => g(i)!.bonuses.rangeStrength ?? 0, benchStrength = benchArrow !== undefined ? gear.get(benchArrow)?.bonuses.rangeStrength ?? 0 : 0;
    const largest = (rows: readonly Item[]) => [...rows].sort((x, y) => y.count - x.count)[0], strong = stacks.filter(i => strength(i) >= benchStrength);
    const arrows = strong.find(i => i.count >= wantArrows) ?? ((largest(strong)?.count ?? 0) >= rule.minArrows ? largest(strong) : undefined) ?? stacks.find(i => i.count >= wantArrows) ?? largest(stacks);
    const unstrung = owned.find(i => !g(i) && BOW.test(i.name) && !CROSSBOW.test(i.name));
    if (unstrung && (!bow || (benchBow !== undefined && (g(bow)!.bonuses.rangeAttack ?? 0) < (gear.get(benchBow)!.bonuses.rangeAttack ?? 0)))) notes.push(`holds an unstrung ${unstrung.name} (item ${unstrung.id}): it fires nothing until a Fletching account strings it`);
    if (bow && benchBow !== undefined && (g(bow)!.bonuses.rangeAttack ?? 0) < (gear.get(benchBow)!.bonuses.rangeAttack ?? 0)) {
        notes.push(`${bow.name} is weaker than the bench kit's ${gear.get(benchBow)!.name}`);
        needs.push({ what: gear.get(benchBow)!.name, count: 1, blocking: false, id: benchBow, accept: i => i.id === benchBow });
    }
    if (!bow) needs.push({ what: 'bow', count: 1, blocking: true, ...(benchBow !== undefined ? { id: benchBow } : {}), accept: i => isBow(i) && canWear(i) && g(i)!.tradeable !== false });
    if (arrows) wear(arrows, SLOT.quiver!, Math.min(arrows.count, wantArrows));
    const arrowsHeld = arrows ? Math.min(arrows.count, wantArrows) : 0;
    // Under the least count: one whole stack of any kind that the bow fires. Over it: more of the kind held.
    if (arrowsHeld < rule.minArrows) needs.push({ what: `arrows that a ${bow?.name ?? 'bow'} fires`, count: wantArrows, blocking: true, ...(benchArrow !== undefined ? { id: benchArrow } : {}), accept: i => fires(i, bowTier) });
    else if (strength(arrows!) < benchStrength) {
        notes.push(`${arrows!.name} is weaker than the bench kit's ${gear.get(benchArrow!)!.name}`);
        needs.push({ what: gear.get(benchArrow!)!.name, count: wantArrows, blocking: false, id: benchArrow!, accept: i => fires(i, bowTier) && strength(i) >= benchStrength });
    } else if (arrowsHeld < wantArrows) needs.push({ what: arrows!.name, count: wantArrows - arrowsHeld, blocking: false, id: arrows!.id, accept: i => i.id === arrows!.id });
    // The pack: the bow, an antipoison and each supply of the bench kit at its count, then sharks in every slot left.
    const carried: Item[] = [];
    if (bow) carried.push({ id: bow.id, name: bow.name, count: 1 });
    const antipoisons = ITEMS.antipoison as readonly number[], isAntipoison = (i: Item) => antipoisons.includes(i.id);
    const antipoison = owned.filter(isAntipoison).sort((x, y) => antipoisons.indexOf(x.id) % 4 - antipoisons.indexOf(y.id) % 4)[0];
    if (antipoison) carried.push({ id: antipoison.id, name: antipoison.name, count: 1 });
    else needs.push({ what: 'antipoison', count: 1, blocking: true, ...(kit.inventory.find(i => antipoisons.includes(i.id)) ? { id: kit.inventory.find(i => antipoisons.includes(i.id))!.id } : {}), accept: isAntipoison });
    const supplies = kit.inventory.filter(i => i.id !== FOOD_ID && !antipoisons.includes(i.id) && !gear.has(i.id));
    const short = new Map<number, number>();
    for (const s of supplies) {
        const have = own.get(s.id), take = Math.min(have?.count ?? 0, s.count);
        if (take > 0) carried.push({ id: s.id, name: have!.name, count: take });
        if (take < s.count) short.set(s.id, s.count - take);
    }
    const wornIds = worn.map(w => w.id), magic = a.levels.magic ?? 1;
    const escapeSpell = squadEscapeSpell(post.z, carried, wornIds, magic), freezeSpell = castableFreeze(Math.min(magic, SQUAD_OPTS.freezeMagicCap), carried);
    const freezeRunes: readonly number[] = [ITEMS.earthRune, ITEMS.waterRune, ITEMS.natureRune];
    for (const s of supplies) {
        const n = short.get(s.id);
        if (!n) continue;
        const blocking = freezeRunes.includes(s.id) ? freezeSpell === null : escapeSpell === null;
        needs.push({ what: own.get(s.id)?.name ?? nameOf(s.id) ?? `item ${s.id}`, id: s.id, count: n, blocking, accept: i => i.id === s.id });
    }
    const foodSlots = PACK_SLOTS - carried.length, foodHeld = own.get(FOOD_ID)?.count ?? 0, food = Math.min(foodHeld, foodSlots);
    if (foodHeld < foodSlots) needs.push({ what: 'Shark', id: FOOD_ID, count: foodSlots - foodHeld, blocking: true, accept: i => i.id === FOOD_ID });
    // The fight kit, the pack of a bank trip, the escape and the freeze, each from the code that the squad runs.
    // The special of the fight kit: the melee weapon's, else the bow's (scripts/pk.ts defaultSpec).
    const fight = kitFrom(worn, carried), special = defaultSpec(fight)?.style ?? null;
    const eat = [{ text: 'Eat' }], none: { text: string }[] = [];
    const pack = packOf([...carried.map(c => ({ id: c.id, count: c.count, optionsWithIndex: none })), ...Array.from({ length: food }, () => ({ id: FOOD_ID, count: 1, optionsWithIndex: eat }))], worn);
    for (const n of needs) if (n.blocking) reasons.push(`no ${n.what}${n.count > 1 ? ` (${n.count} short)` : ''}`);
    if (!fight.melee?.length && weapon) reasons.push('the fight kit holds no melee weapon');
    if (escapeSpell === null && !reasons.some(r => /Law rune|Air rune/.test(r))) reasons.push(`no escape teleport that Magic ${magic} can cast with the runes held`);
    if (freezeSpell === null && !reasons.some(r => /Earth rune|Water rune|Nature rune/.test(r))) reasons.push('no Bind cast with the runes held');
    const ageHours = a.bankAt === null ? Infinity : (now - a.bankAt) / 3_600_000;
    if (ageHours > rule.maxBankAgeHours) reasons.push(a.bankAt === null ? 'no bank read' : `bank read ${ageHours.toFixed(1)} h old (limit ${rule.maxBankAgeHours} h)`);
    if (inWestArdougne(a.pos)) reasons.push('stands inside West Ardougne, which the walker cannot leave');
    if (wildernessLevel(a.pos.z) > 0) reasons.push(`stands in the Wilderness at level ${wildernessLevel(a.pos.z)}`);
    if (!maxed(a)) notes.push(`not 99 in ${COMBAT.filter(s => (a.levels[s.toLowerCase()] ?? 1) < 99).join(', ')}`);
    return { account: a.name, ready: reasons.length === 0, reasons, notes, worn, carried, food, foodSlots, foodHeld, styles: Object.keys(fight), special,
        escape: escapeSpell === null ? null : SPELL_NAME[escapeSpell] ?? `spell ${escapeSpell}`, freeze: freezeSpell === null ? null : 'Bind', needs, pack };
}

export type Move = { from: string; to: string; id: number; item: string; count: number; blocking: boolean; distance: number; donorBankAgeHours: number; reserved: boolean };
export type Gap = { account: string; what: string; id?: number; count: number; blocking: boolean };
export type Plan = { picks: Pick[]; moves: Move[]; gaps: Gap[] };

// The staging plan: each need of each candidate, in the order given, from the nearest account with a spare piece.
// Spare: the bank of an account that is no candidate (its worn items and its pack are in use), and the gear that a
// candidate holds over its own kit (a candidate keeps its food, runes and arrows for its own bank trips). One piece
// goes to one account. A donor that covers the whole need comes first, then the nearest; a wanted supply that no one
// donor covers stays a gap, so that the plan holds few trades.
export function stagingPlan(candidates: readonly Account[], fleet: readonly Account[], gear: ReadonlyMap<number, Gear>, rule: Rule, now: number, kit = kitItems(rule.benchKit), nameOf: (id: number) => string | undefined = () => undefined): Plan {
    const picks = candidates.map(a => pickKit(a, gear, rule, now, kit, nameOf)), byName = new Map(picks.map(p => [p.account.toLowerCase(), p]));
    const spare = new Map<string, Map<number, Item>>();
    for (const a of fleet) {
        // No donor with an old bank read, and none that cannot walk to a meeting.
        if (a.bankAt === null || (now - a.bankAt) / 3_600_000 > rule.maxDonorBankAgeHours || inWestArdougne(a.pos) || wildernessLevel(a.pos.z) > 0) continue;
        const pick = byName.get(a.name.toLowerCase()), stock = new Map<number, Item>();
        for (const i of pick ? [...holdings(a).values()].filter(i => gear.has(i.id) && gear.get(i.id)!.slot !== 'quiver') : a.bank) stock.set(i.id, { id: i.id, name: i.name, count: (stock.get(i.id)?.count ?? 0) + i.count });
        if (pick) {
            const used = (id: number, n: number) => { const row = stock.get(id); if (row) row.count -= n; };
            for (const w of pick.worn) used(w.id, w.count);
            for (const c of pick.carried) used(c.id, c.count);
        }
        spare.set(a.name, stock);
    }
    const moves: Move[] = [], gaps: Gap[] = [];
    for (const [pass, blocking] of [[0, true], [1, false]] as const) for (const pick of picks) {
        void pass;
        const me = candidates.find(a => a.name === pick.account)!;
        for (const need of pick.needs.filter(n => n.blocking === blocking)) {
            let left = need.count;
            const donors = fleet.filter(d => d.name !== me.name && spare.has(d.name)).map(d => ({ d, rows: [...spare.get(d.name)!.values()].filter(i => i.count > 0 && need.accept(i)) }))
                .filter(x => x.rows.length);
            const total = (rows: readonly Item[]) => rows.reduce((n, r) => n + r.count, 0), covers = (rows: readonly Item[]) => total(rows) >= need.count;
            donors.sort((x, y) => Number(covers(y.rows)) - Number(covers(x.rows)) || (covers(x.rows) ? cheb(x.d.pos, me.pos) - cheb(y.d.pos, me.pos) : total(y.rows) - total(x.rows)));
            if (!blocking && donors[0] && !covers(donors[0].rows)) donors.length = 0;
            for (const { d, rows } of donors) {
                // Armour, a weapon and a bow: the best piece that the donor can spare. A supply: its stack.
                for (const row of rows.sort((x, y) => (gear.has(y.id) ? armour(gear.get(y.id)!) + (gear.get(y.id)!.bonuses.strength ?? 0) + (gear.get(y.id)!.bonuses.rangeAttack ?? 0) : y.count) - (gear.has(x.id) ? armour(gear.get(x.id)!) + (gear.get(x.id)!.bonuses.strength ?? 0) + (gear.get(x.id)!.bonuses.rangeAttack ?? 0) : x.count))) {
                    if (left <= 0) break;
                    const n = Math.min(left, row.count);
                    row.count -= n; left -= n;
                    moves.push({ from: d.name, to: me.name, id: row.id, item: row.name, count: n, blocking, distance: cheb(d.pos, me.pos), donorBankAgeHours: (now - d.bankAt!) / 3_600_000, reserved: !!d.reservation });
                }
                if (left <= 0) break;
            }
            if (left > 0) gaps.push({ account: me.name, what: need.what, ...(need.id !== undefined ? { id: need.id } : {}), count: left, blocking });
        }
    }
    return { picks, moves, gaps };
}

// The bank of BANK_MEETS (scripts/coin-courier.ts) nearest to a tile: where a fleet order for that account meets.
export function meetNear(pos: { x: number; z: number }): { bank: string; x: number; z: number } {
    const rows = BANK_MEETS.map(r => ({ bank: r.bank, x: r.tiles[0]![0], z: r.tiles[0]![1] }));
    return rows.sort((a, b) => cheb(a, pos) - cheb(b, pos))[0]!;
}
// One fleet order command for each donor and receiver pair: `bun scripts/fleet-order.ts <from> <to> <count> <item>`
// with `--with` for each further line, to run when the pause is lifted (an order's window starts at its writing).
export function orderCommands(moves: readonly Move[], posOf: (name: string) => { x: number; z: number }): { from: string; to: string; meet: string; lines: { item: string; count: number }[]; command: string }[] {
    const pairs = new Map<string, Move[]>();
    for (const m of moves) pairs.set(`${m.from}>${m.to}`, [...(pairs.get(`${m.from}>${m.to}`) ?? []), m]);
    return [...pairs.values()].map(rows => {
        const lines = [...rows.reduce((acc, m) => acc.set(m.item, (acc.get(m.item) ?? 0) + m.count), new Map<string, number>())].map(([item, count]) => ({ item, count }));
        const first = lines[0]!, meet = meetNear(posOf(rows[0]!.to)).bank;
        return { from: rows[0]!.from, to: rows[0]!.to, meet, lines,
            command: `MEET=${meet} TAKER_WAITS=1 bun scripts/fleet-order.ts ${rows[0]!.from} ${rows[0]!.to} ${first.count} ${first.item}${lines.slice(1).map(l => ` --with "${l.count} ${l.item}"`).join('')}` };
    });
}

// Where a missing item comes from when no account has a spare one: the shop-buyer profile whose shop stocks it
// (knowledge/shops.json through `shops`), then the Grand Exchange ask of .practice/market-all.json.
export type Shop = { inv: string; stock: { item: string; count: number }[] };
export const PROFILE_SHOP: Readonly<Record<string, string>> = { jiminua: 'junglestore', lowe: 'archeryshop', catherby_arrows: 'archeryshop2', aubury: 'runeshop', magic_guild: 'magicguildshop', scavvo: 'runiteshop', jukat: 'dragonswordshop' };
export function shopSource(name: string, debugname: string, shops: readonly Shop[], profiles: Readonly<Record<string, { items: { re: RegExp }[]; need?: { skill: string; level: number } }>> = PROFILES): string | null {
    const out: string[] = [];
    for (const shop of shops) {
        const row = shop.stock.find(s => s.item === debugname && s.count > 0);
        if (!row) continue;
        const profile = Object.entries(PROFILE_SHOP).find(([key, inv]) => inv === shop.inv && profiles[key]?.items.some(i => i.re.test(name)))?.[0];
        out.push(profile ? `shop-buyer profile ${profile} (${shop.inv}, shelf ${row.count}${profiles[profile]!.need ? `, ${profiles[profile]!.need!.skill} ${profiles[profile]!.need!.level}` : ''})` : `${shop.inv} stocks ${row.count}: no shop-buyer profile line`);
    }
    return out.length ? out.sort((a, b) => Number(b.startsWith('shop-buyer')) - Number(a.startsWith('shop-buyer'))).slice(0, 2).join('; ') : null;
}

// The input of scripts/microbot-owned-loadout.ts for an account that holds its kit: the bank tile, the worn pieces
// and the pack. The script needs the account within 3 tiles of the bank tile.
export function loadoutOf(pick: Pick, bank: { x: number; z: number }): { bank: { x: number; z: number; level: number }; pack: { id: number; count: number }[]; wear: { id: number; count: number; slot: number }[]; cap: number; maximumMoves: number } {
    return { bank: { ...bank, level: 0 }, pack: [...pick.carried.map(c => ({ id: c.id, count: c.count })), ...(pick.food ? [{ id: FOOD_ID, count: pick.food }] : [])],
        wear: pick.worn.map(w => ({ id: w.id, count: w.count, slot: w.slot })), cap: 600, maximumMoves: 128 };
}

// A status file (packages/core/src/status.ts) as an account. A noted item counts as its plain item.
export function accountOf(status: any, owner?: { side?: string; reservation?: string }): Account | null {
    if (!status || typeof status.name !== 'string' || !status.pos || !Array.isArray(status.skills)) return null;
    const items = (rows: any): Item[] => (Array.isArray(rows) ? rows : []).filter((i: any) => Number.isSafeInteger(i?.id) && typeof i.name === 'string' && i.count > 0).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count }));
    return { name: status.name, at: Number(status.at) || 0, bankAt: Number.isFinite(status.bankAt) ? status.bankAt : null, pos: { x: status.pos.x, z: status.pos.z, level: status.pos.level ?? 0 },
        levels: Object.fromEntries(status.skills.map((s: any) => [String(s.name).toLowerCase(), s.level])), quests: new Set((status.quests ?? []).filter((q: any) => q?.state === 'complete').map((q: any) => String(q.name).toLowerCase())),
        worn: (Array.isArray(status.equipment) ? status.equipment : []).filter((i: any) => Number.isSafeInteger(i?.id)).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count, slot: i.slot })),
        pack: items(status.inventory), bank: items(status.bank), ...(owner?.side ? { side: owner.side } : {}), ...(owner?.reservation ? { reservation: owner.reservation } : {}) };
}

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
export function report(plan: Plan, accounts: readonly Account[], rule: Rule, now: number, source: (gap: Gap) => string): string[] {
    const out: string[] = [], byName = new Map(accounts.map(a => [a.name, a]));
    for (const p of plan.picks) {
        const a = byName.get(p.account)!, slot = (n: number) => p.worn.find(w => w.slot === n);
        out.push(`${p.ready ? 'READY    ' : 'NOT READY'} ${p.account}  at ${a.pos.x},${a.pos.z}  bank read ${a.bankAt === null ? 'never' : hours(now - a.bankAt) + ' ago'}${a.reservation ? '  (coordinator reservation)' : ''}`);
        out.push(`  wears    ${[['helm', 0], ['body', 4], ['legs', 7], ['shield', 5], ['amulet', 2], ['weapon', 3]].map(([label, n]) => `${label} ${slot(n as number)?.name ?? '-'}`).join(' | ')} | quiver ${slot(13) ? `${slot(13)!.count} ${slot(13)!.name}` : '-'}`);
        out.push(`  carries  ${p.carried.map(c => (c.count > 1 ? `${c.count} ` : '') + c.name).join(', ') || '-'} | ${p.food} of ${p.foodSlots} sharks (holds ${p.foodHeld}: ${Math.floor(p.foodHeld / Math.max(1, p.foodSlots))} full packs)`);
        out.push(`  fights   ${p.styles.join('+') || 'no style'}${p.special ? ` with a ${p.special} special attack` : ''} | escape ${p.escape ?? 'none'} | freeze ${p.freeze ?? 'none'}`);
        for (const r of p.reasons) out.push(`  blocked  ${r}`);
        for (const n of p.notes) out.push(`  note     ${n}`);
        for (const m of plan.moves.filter(m => m.to === p.account)) out.push(`  ${m.blocking ? 'missing ' : 'wanted  '} ${m.count} ${m.item} <- ${m.from} (${m.distance} tiles, bank read ${m.donorBankAgeHours.toFixed(1)} h ago${m.reserved ? ', coordinator reservation' : ''})`);
        for (const gap of plan.gaps.filter(x => x.account === p.account)) out.push(`  ${gap.blocking ? 'missing ' : 'wanted  '} ${gap.count} ${gap.what} <- no owned spare: ${source(gap)}`);
    }
    out.push(`SQUAD_READY rule=${rule.name} ready=${plan.picks.filter(p => p.ready).map(p => p.account).join(',') || 'none'} notReady=${plan.picks.filter(p => !p.ready).map(p => p.account).join(',') || 'none'}`);
    return out;
}

if (import.meta.main) {
    const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const valued = new Set(['--root', '--max-age', '--loadouts', '--orders', '--rule']);
    const names = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
    // The main checkout holds the status files: a worktree's git directory is <main>/.git/worktrees/<name>.
    const here = resolve(import.meta.dir, '..');
    const mainOf = (dir: string) => { try { const m = readFileSync(join(dir, '.git'), 'utf8').match(/^gitdir: (.+?)[\\/]\.git[\\/]worktrees[\\/]/m); return m ? resolve(m[1]!) : dir; } catch { return dir; } };
    const root = resolve(flag('--root') ?? mainOf(here)), now = Date.now();
    const rule = { ...RULES[flag('--rule') ?? 'gang-chain-bind']!, ...(flag('--max-age') ? { maxBankAgeHours: Number(flag('--max-age')) } : {}) };
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    const gearRows = read(join(here, 'knowledge', 'gear.json')) as Gear[], gear = new Map(gearRows.map(r => [r.id, r]));
    const items = read(join(here, 'knowledge', 'items.json')) as { id: number; name: string; debugname: string }[];
    const shops = read(join(here, 'knowledge', 'shops.json')) as Shop[];
    const ownersFile = [join(root, '.practice', 'fleet-data', 'fleet', 'owners.json'), join(root, 'fleet', 'owners.json')].find(existsSync);
    const owners = new Map(Object.entries((ownersFile ? read(ownersFile).accounts : {}) as Record<string, { side: string; server: string; reservation?: string }>).map(([n, o]) => [n.toLowerCase(), o]));
    const side = process.env.FLEET_SIDE || 'local', server = 'rs-sdk-demo.fly.dev';
    const statusDir = join(root, '.practice', 'status');
    const fleet = readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => {
        try {
            const status = read(join(statusDir, f)), owner = owners.get(String(status?.name).toLowerCase());
            if (status?.server !== server || !owner || owner.side !== side || String(status.name).toLowerCase() === 'haggis') return [];
            const a = accountOf(status, owner);
            return a ? [a] : [];
        } catch { return []; }
    });
    // No account named: the maxed accounts, the one with the fewest blocking faults first.
    const nameOf = (id: number) => items.find(i => i.id === id)?.name;
    const blockers = (a: Account) => pickKit(a, gear, rule, now).reasons.length;
    const candidates = names.length ? names.map(n => fleet.find(a => a.name.toLowerCase() === n.toLowerCase()) ?? (() => { throw Error(`no status file of this side's account ${n} in ${statusDir}`); })())
        : fleet.filter(maxed).sort((x, y) => blockers(x) - blockers(y));
    const plan = stagingPlan(candidates, fleet, gear, rule, now, undefined, nameOf);
    let market: Record<string, { ask: number | null; sell: number }> = {};
    try { market = read(join(root, '.practice', 'market-all.json')).items; } catch { /* no market file: the plan names no price */ }
    const source = (gap: Gap) => {
        const row = gap.id !== undefined ? items.find(i => i.id === gap.id) : undefined, m = gap.id !== undefined ? market[String(gap.id)] : undefined;
        const shop = row ? shopSource(row.name, row.debugname, shops) : null;
        return [shop, m?.ask ? `Grand Exchange ask ${m.ask} each (${m.sell} on sale), ${gap.count * m.ask} for ${gap.count}` : row ? 'no Grand Exchange seller' : null].filter(Boolean).join('; ') || 'see the plan';
    };
    if (args.includes('--json')) console.log(JSON.stringify({ rule, now, picks: plan.picks.map(({ needs, ...p }) => ({ ...p, needs: needs.map(({ accept: _accept, ...n }) => n) })), moves: plan.moves, gaps: plan.gaps }, null, 1));
    else {
        console.log(`squad readiness: rule ${rule.name} (bench kit ${rule.benchKit}), status files ${statusDir}, ${fleet.length} accounts of side ${side}`);
        for (const line of report(plan, fleet, rule, now, source)) console.log(line);
        const posOf = (name: string) => fleet.find(a => a.name === name)!.pos, orders = orderCommands(plan.moves, posOf);
        if (orders.length) console.log('PLAN transfers (run each when the pause is lifted; both accounts must have no enabled job):');
        for (const o of orders) console.log(`  ${o.command}`);
    }
    const loadouts = flag('--loadouts');
    if (loadouts) {
        mkdirSync(loadouts, { recursive: true });
        for (const p of plan.picks.filter(p => p.ready)) {
            const a = fleet.find(x => x.name === p.account)!, bank = meetNear(a.pos);
            writeFileSync(join(loadouts, `${p.account}.json`), JSON.stringify(loadoutOf(p, bank), null, 1) + '\n');
            console.log(`LOADOUT ${join(loadouts, `${p.account}.json`)} at the ${bank.bank} bank (${cheb(bank, a.pos)} tiles from the account)`);
        }
    }
    const orderDir = flag('--orders');
    if (orderDir) {
        const fleetOrders = [join(root, '.practice', 'fleet-data', 'fleet', 'orders'), join(root, 'fleet', 'orders'), join(here, 'fleet', 'orders')].map(p => resolve(p).toLowerCase());
        if (fleetOrders.includes(resolve(orderDir).toLowerCase()) || /[\\/]fleet[\\/]orders$/i.test(resolve(orderDir))) throw Error('--orders refuses a fleet orders folder: scripts/fleet-order.ts places an order');
        const fleetOwners = new Map([...owners].map(([n, o]) => [n, { side: o.side, server: o.server }]));
        for (const o of orderCommands(plan.moves, name => fleet.find(a => a.name === name)!.pos)) {
            const meet = BANK_MEETS.find(r => r.bank === o.meet)!.meet;
            const order = { ...makeOrder(o.from, o.to, o.lines[0]!.count, o.lines[0]!.item, now, 15, 40, fleetOwners, meet, o.lines.slice(1)), takerWaits: true as const };
            console.log(`ORDER_FILE ${writeFleetOrder(orderDir, order)}`);
        }
    }
}
