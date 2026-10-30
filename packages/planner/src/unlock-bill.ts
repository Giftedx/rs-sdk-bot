// What each live account needs to train every skill with the best method its level allows, and where to get it.
// For each account and skill: the best usable rung of knowledge/ladders.json (highest known XP per tick, else XP
// per action, else unlock level: an estimate where no rate is measured), what blocks it now (a quest not done, a
// required item, a tool tier from knowledge/skill-tools.json, consumed inputs), and the next rung up. Each missing
// item names its sources: the account's own bank, another owned account, a shop, the GE. A rung counts only when
// every item it uses is obtainable: held by an owned account, sold by a shop, offered on the GE, or made by another
// rung some owned account can do. A quest gate does not remove a rung; it is a blocker to clear.
// Usage: bun packages/planner/src/unlock-bill.ts   writes .practice/coordinator/unlock-bill.json
// GE prices (https://rs-sdk-demo.fly.dev/api/market/items/<id>, 2 per second) are kept in
// .practice/coordinator/market-prices.json and read again after PRICE_TTL_MS.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { liveHelperStatuses } from './supply-bill';

const root = resolve(import.meta.dir, '../../..');
export type Rung = { id: string; skill: string; level: number; label: string; kind: string; xpPerAction: number | null; xpPerTick: number | null;
    inputs: { id: number; debugname: string; name: string; count: number | null }[]; requires: { id: number; debugname: string; name: string }[];
    quest: { name: string } | null; worker: string | null; workers?: string[] };
export type Tool = { skill: string; kind?: string; rung?: string; items: string[]; level: number; mode?: string };
export type Blocker = { kind: 'quest' | 'item' | 'tool' | 'input'; name: string; item?: string; have: number; sources: string[] };
export type SkillRow = { account: string; skill: string; level: number; best: { id: string; label: string; level: number; worker: boolean } | null;
    blockers: Blocker[]; next: { id: string; label: string; level: number } | null };

// Rank estimate: XP per action, then unlock level. Only 6 rungs have a measured XP per tick, too few to rank by.
const score = (r: Rung) => (r.xpPerAction ?? 0) + r.level / 1000;

// Holdings by item debugname for one account (pack, worn and last seen bank) and for every other owned account.
export function holdings(statuses: readonly any[], idToName: Map<number, string>) {
    const per = new Map<string, Map<string, number>>();
    for (const s of statuses) {
        const m = new Map<string, number>();
        for (const r of [...(s.inventory ?? []), ...(s.equipment ?? []), ...(s.bank ?? [])]) {
            const n = idToName.get(r.baseId ?? r.id);
            if (n) m.set(n, (m.get(n) ?? 0) + (r.count ?? 0));
        }
        per.set(s.name, m);
    }
    return per;
}

export function questDone(status: any, quest: string): boolean {
    const q = (status.quests ?? []).find((x: any) => String(x.name).toLowerCase() === quest.toLowerCase());
    return q?.state === 'complete';
}

// The best usable rung for one skill at `level`, the blockers for it, and the next rung above.
export function skillRow(account: string, status: any, skill: string, level: number, rungs: readonly Rung[], tools: readonly Tool[],
    own: Map<string, Map<string, number>>, shopsFor: (item: string) => string[], obtainable: (item: string) => boolean = () => true,
    geSells: (item: string) => boolean = () => true, makers: (item: string) => string[] = () => []): SkillRow {
    const mine = own.get(account) ?? new Map<string, number>();
    const elsewhere = (item: string) => [...own].filter(([a, m]) => a !== account && (m.get(item) ?? 0) > 0).map(([a, m]) => `${a} ${m.get(item)}`).slice(0, 3);
    const sources = (item: string) => [...((mine.get(item) ?? 0) > 0 ? ['own bank'] : []), ...elsewhere(item), ...shopsFor(item).map(s => `shop ${s}`), ...(geSells(item) ? ['GE'] : []), ...makers(item)];
    const usable = rungs.filter(r => r.level <= level && [...r.inputs, ...r.requires].every(i => obtainable(i.debugname))).sort((a, b) => score(b) - score(a));
    const best = usable[0] ?? null, blockers: Blocker[] = [];
    if (best) {
        if (best.quest && !questDone(status, best.quest.name)) blockers.push({ kind: 'quest', name: best.quest.name, have: 0, sources: [] });
        for (const q of best.requires) if ((mine.get(q.debugname) ?? 0) < 1) blockers.push({ kind: 'item', name: q.name, item: q.debugname, have: 0, sources: sources(q.debugname) });
        // The best tool tier this level allows, for this rung's kind or id.
        const fits = tools.filter(t => t.skill === skill && t.level <= level && (t.rung === best.id || t.kind === best.kind || (!t.rung && !t.kind)));
        const top = fits.sort((a, b) => b.level - a.level)[0];
        if (top && !top.items.some(i => (mine.get(i) ?? 0) > 0)) blockers.push({ kind: 'tool', name: top.items[0]!, item: top.items[0], have: 0, sources: sources(top.items[0]!) });
        for (const i of best.inputs) { const have = mine.get(i.debugname) ?? 0; if (have < 1) blockers.push({ kind: 'input', name: i.name, item: i.debugname, have, sources: sources(i.debugname) }); }
    }
    const next = rungs.filter(r => r.level > level).sort((a, b) => a.level - b.level || score(b) - score(a))[0] ?? null;
    return { account, skill, level,
        best: best && { id: best.id, label: best.label, level: best.level, worker: !!(best.worker || best.workers?.length) },
        blockers, next: next && { id: next.id, label: next.label, level: next.level } };
}

// Missing items across accounts, most-needed first: an item one account lacks and another holds is a transfer.
export function shoppingList(rows: readonly SkillRow[]) {
    const m = new Map<string, { item: string; accounts: string[]; kinds: Set<string>; sources: string[] }>();
    for (const r of rows) for (const b of r.blockers) {
        if (!b.item) continue;
        const e = m.get(b.item) ?? { item: b.item, accounts: [], kinds: new Set(), sources: b.sources };
        if (!e.accounts.includes(r.account)) e.accounts.push(r.account);
        e.kinds.add(b.kind); m.set(b.item, e);
    }
    return [...m.values()].map(e => ({ item: e.item, accounts: e.accounts, kinds: [...e.kinds], sources: e.sources.filter(s => s !== 'own bank') }))
        .sort((a, b) => b.accounts.length - a.accounts.length);
}

export type Prices = Record<string, { at: number; ask: number | null; bid: number | null; sell: number }>;
export function buildUnlockBill(statuses: readonly any[], base = root, prices: Prices = {}) {
    const items = JSON.parse(readFileSync(join(base, 'knowledge/items.json'), 'utf8')) as { id: number; debugname: string; name: string }[];
    const idToName = new Map(items.map(i => [i.id, i.debugname]));
    const ladders = (JSON.parse(readFileSync(join(base, 'knowledge/ladders.json'), 'utf8')) as { ladders: Record<string, Rung[]> }).ladders;
    const toolsFile = join(base, 'knowledge/skill-tools.json');
    const tools: Tool[] = existsSync(toolsFile) ? toolRecords(JSON.parse(readFileSync(toolsFile, 'utf8'))) : [];
    const shops = JSON.parse(readFileSync(join(base, 'knowledge/shops.json'), 'utf8')) as { inv: string; stock: { item: string }[] }[];
    const shopIndex = new Map<string, string[]>();
    // Skill-guide lists and quest-only stores are not shops a bot can buy from.
    for (const s of shops) if (!/^skill_guide|^tbwt|quest/i.test(s.inv)) for (const st of s.stock) shopIndex.set(st.item, [...(shopIndex.get(st.item) ?? []), s.inv]);
    const own = holdings(statuses, idToName), rows: SkillRow[] = [];
    const held = (item: string) => [...own.values()].some(m => (m.get(item) ?? 0) > 0);
    const geSells = (item: string) => (prices[item]?.sell ?? 0) > 0;
    // Fleet best level per skill: a rung makes its outputs when some owned account has its level.
    const top = new Map<string, number>();
    for (const s of statuses) for (const k of s.skills ?? []) { const n = String(k.name).toLowerCase(); top.set(n, Math.max(top.get(n) ?? 0, k.level ?? 0)); }
    const makes = new Map<string, Rung[]>();
    for (const list of Object.values(ladders)) for (const r of list) for (const o of (r as any).outputs ?? []) if (o?.debugname) makes.set(o.debugname, [...(makes.get(o.debugname) ?? []), r]);
    const memo = new Map<string, boolean>();
    const obtainable = (item: string, depth = 0): boolean => {
        if (memo.has(item)) return memo.get(item)!;
        let ok = held(item) || (shopIndex.get(item)?.length ?? 0) > 0 || geSells(item);
        if (!ok && depth < 3) ok = (makes.get(item) ?? []).some(r => r.level <= (top.get(r.skill) ?? 0) && [...r.inputs, ...r.requires].every(i => i.debugname !== item && obtainable(i.debugname, depth + 1)));
        if (depth === 0) memo.set(item, ok);
        return ok;
    };
    const makers = (item: string) => (makes.get(item) ?? []).filter(r => r.level <= (top.get(r.skill) ?? 0)).slice(0, 2).map(r => `make ${r.id}`);
    for (const s of statuses) {
        if (!Array.isArray(s.skills)) continue;
        for (const k of s.skills) {
            const skill = String(k.name).toLowerCase(), rungs = ladders[skill];
            if (!rungs?.length || !Number.isInteger(k.level)) continue;
            rows.push(skillRow(s.name, s, skill, k.level, rungs, tools, own, i => (shopIndex.get(i) ?? []).slice(0, 2), i => obtainable(i), geSells, makers));
        }
    }
    return { rows, shopping: shoppingList(rows), toolsKnown: tools.length };
}

// knowledge/skill-tools.json records, read loosely: any record with a skill, a level and one or more item names.
export function toolRecords(file: any): Tool[] {
    const list: any[] = Array.isArray(file) ? file : Array.isArray(file?.tools) ? file.tools : Array.isArray(file?.records) ? file.records : [];
    return list.flatMap(r => {
        const items = (Array.isArray(r.items) ? r.items : [r.item ?? r.debugname]).map((x: any) => typeof x === 'string' ? x : x?.debugname).filter((x: any) => typeof x === 'string');
        const level = Number(r.level ?? r.minLevel ?? r.skillLevel);
        return typeof r.skill === 'string' && items.length && Number.isFinite(level) ? [{ skill: r.skill.toLowerCase(), kind: r.kind ?? r.appliesTo, rung: r.rung, items, level, mode: r.mode }] : [];
    });
}

export const PRICE_TTL_MS = 6 * 3600_000;
// GE prices for every item the ladders use, from the saved file where fresh, else from the market API.
export async function marketPrices(base = root, now = Date.now()): Promise<Prices> {
    const file = join(base, '.practice/coordinator/market-prices.json');
    let saved: Prices = {};
    try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
    const items = JSON.parse(readFileSync(join(base, 'knowledge/items.json'), 'utf8')) as { id: number; debugname: string }[];
    const ladders = (JSON.parse(readFileSync(join(base, 'knowledge/ladders.json'), 'utf8')) as { ladders: Record<string, Rung[]> }).ladders;
    const names = new Set<string>();
    for (const list of Object.values(ladders)) for (const r of list) for (const i of [...r.inputs, ...r.requires]) names.add(i.debugname);
    for (const n of names) {
        if (saved[n] && now - saved[n]!.at < PRICE_TTL_MS) continue;
        const id = items.find(i => i.debugname === n)?.id;
        if (id === undefined) continue;
        try {
            const r = await (await fetch(`https://rs-sdk-demo.fly.dev/api/market/items/${id}`, { signal: AbortSignal.timeout(10000) })).json() as any;
            saved[n] = { at: now, ask: r.ask ?? null, bid: r.bid ?? null, sell: r.sellQuantity ?? 0 };
        } catch { /* unpriced */ }
        await Bun.sleep(550);
    }
    mkdirSync(join(base, '.practice/coordinator'), { recursive: true });
    writeFileSync(file, JSON.stringify(saved));
    return saved;
}

if (import.meta.main) {
    const prices = await marketPrices();
    const bill = buildUnlockBill(liveHelperStatuses(), root, prices);
    const dir = join(root, '.practice/coordinator'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unlock-bill.json'), JSON.stringify({ at: Date.now(), toolsKnown: bill.toolsKnown, shopping: bill.shopping, rows: bill.rows }, null, 1) + '\n');
    const blocked = bill.rows.filter(r => r.blockers.length);
    console.log(`Accounts ${new Set(bill.rows.map(r => r.account)).size}, skill rows ${bill.rows.length}, blocked ${blocked.length}, tool records ${bill.toolsKnown}\n`);
    console.log('| Item | Accounts | Needed as | Sources | GE ask |\n|---|---|---|---|---|');
    for (const s of bill.shopping.slice(0, 30)) console.log(`| ${s.item} | ${s.accounts.length} | ${s.kinds.join(',')} | ${s.sources.slice(0, 3).join('; ')} | ${prices[s.item]?.ask ?? '-'} |`);
}
