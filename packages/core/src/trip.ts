// A trip may stop at a bank first: an account with its coins in the bank cannot pay a boat until it takes
// fares out. planTrip compares the direct route with "walk to a bank, take what the route needs, go on" for
// the nearest banks, and keeps the cheaper. It takes coins for fares and the runes, jewellery and passes the
// route after the bank uses.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalServer } from './localserver';
import { practiceRoot, simStatusDir, statusReadDirs } from './practice-paths';
import { staffCovers } from './travel';
import type { Account, Leg, RouteOptions, Tile, World } from './world';
import { executionContext, withExecutionDeadline } from '../../../vendor/rs-sdk/sdk/execution-context';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
export const BANK_STOP_COST = 10; // estimate in ticks: open the bank, withdraw, close
export const TRIP_COINS = 1000;   // the most coins a plan counts on taking for fares
const DIRECT_GOOD_ENOUGH = 150;   // a direct route this cheap is not compared with bank stops
// The fare float: coins a bank stop leaves in the pack for the fares of later walks. Workers bank the whole pack, and
// an account that stands on the Lumbridge side with no coins walks round the Al Kharid toll fence (307 ticks against
// 125 through the gate): no bank on that side gives it the 10 coins. An account whose bank holds FARE_FLOAT_AFFORD
// keeps FARE_FLOAT; a poorer one takes the fares of the route twice (there and back).
export const FARE_FLOAT = 300, FARE_FLOAT_AFFORD = 3000;
export function fareFloatTake(held: number, bankCoins: number, fares: number): number {
    const want = bankCoins >= FARE_FLOAT_AFFORD ? Math.max(FARE_FLOAT, 2 * fares) : 2 * fares;
    return Math.max(0, Math.min(bankCoins, want - held));
}
const cheb = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

export type BankStock = { coins: number; items?: Record<string, number> };
export type TripPlan = { cost: number; legs: Leg[]; bank?: { at: Tile; coins: number; items: Record<string, number>; then: Leg[] } };
const BANK_ITEM_CAP = 100; // runes or passes a plan may count on taking from the bank

// Items the legs use up or need in the pack: spell runes, one charged jewellery item, consumed passes. A rune that a
// `worn` staff gives is not one of them: the route search counted on the staff (travel.ts travelAllowed), and a bank
// stop for that rune fails when the bank holds none.
export function itemsFor(legs: Leg[], counts: Record<string, number>, worn?: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of legs) {
        if (l.kind !== 'travel') continue;
        for (const r of l.travel.runes) if (!staffCovers(r.item, worn)) out[r.item] = (out[r.item] ?? 0) + r.count;
        for (const n of l.travel.needs) if ('held' in n) out[n.held] = Math.max(out[n.held] ?? 0, n.count);
        if (l.travel.run.how === 'rub') { const j = l.travel.run.items.find(i => (counts[i] ?? 0) > 0); if (j) out[j] = Math.max(out[j] ?? 0, 1); }
    }
    return out;
}

// The bank stand tiles packages/planner/src/haggis-travel.json lists (each walked to live by quest-sweep).
let bankRecordsCache: Array<Tile & { site?: string }> | undefined;
let banks: Tile[] | undefined;
export function knownBankRecords(): Array<Tile & { site?: string }> {
    return bankRecordsCache ??= Object.values((JSON.parse(readFileSync(join(repoRoot, 'packages', 'planner', 'src', 'haggis-travel.json'), 'utf8')) as { banks: Record<string, Tile & { site?: string }> }).banks);
}
export function knownBanks(): Tile[] {
    return banks ??= knownBankRecords().map(b => ({ x: b.x, z: b.z, level: b.level }));
}

export function planTrip(world: World, from: Tile, to: Tile, acct: Account, stock: BankStock | undefined, bankTiles: Tile[] = knownBanks(), nearest = 3, routeOpts?: RouteOptions): TripPlan | null {
    const direct = world.route(from, to, acct, routeOpts);
    let best: TripPlan | null = direct.ok ? { cost: direct.cost, legs: direct.legs } : null;
    const held = acct.coins ?? 0, take = Math.min(stock?.coins ?? 0, Math.max(0, TRIP_COINS - held));
    const banked = Object.entries(stock?.items ?? {}).filter(([, n]) => n > 0);
    if ((take <= 0 && !banked.length) || (best && best.cost <= DIRECT_GOOD_ENOUGH)) return best;
    const counts = { ...acct.counts };
    for (const [i, n] of banked) counts[i] = (counts[i] ?? 0) + Math.min(n, BANK_ITEM_CAP);
    const richer: Account = { ...acct, coins: held + take, counts, items: [...new Set([...acct.items, ...banked.map(([i]) => i)])] };
    // With no fare coins to take and no travel or key door that the bank's items open, a bank stop gives the same routes
    // as the direct search plus a detour, so it is never cheaper. Each bank search costs a full route search (about 10 s
    // from Varrock West to Port Sarim; the 3 banks made the plan 40 s against 11 s direct, with the same cost).
    // This holds when the direct search found no route as well: the banks cannot open one, so the bank searches would
    // only run until the route budget ends (819 WALK_NO_ROUTE lines, each after up to 45 s).
    if (take <= 0 && world.routeGain && !world.routeGain(acct, richer)) return best;
    const candidates=[...bankTiles].filter(b=>b.level===from.level).sort((a,b)=>cheb(a,from)-cheb(b,from)).slice(0,8),initial=Math.min(candidates.length,Math.max(0,Math.floor(nearest)));
    let bankRouteFound=false;
    for (let index=0;index<candidates.length;index++) {
        if(index===initial&&bankRouteFound||routeOpts?.deadline!==undefined&&performance.now()>=routeOpts.deadline)break;
        const bank=candidates[index]!;
        const there = world.route(from, bank, acct, routeOpts);
        if (!there.ok || (best && there.cost + BANK_STOP_COST >= best.cost)) continue;
        if(routeOpts?.deadline!==undefined&&performance.now()>=routeOpts.deadline)break;
        const on = world.route(bank, to, richer, routeOpts);
        if (!on.ok) continue;
        bankRouteFound=true;
        const cost = there.cost + BANK_STOP_COST + on.cost;
        if (!best || cost < best.cost) {
            const want = itemsFor(on.legs, counts, acct.worn), items: Record<string, number> = {};
            for (const [i, n] of Object.entries(want)) { const short = n - (acct.counts?.[i] ?? 0); if (short > 0) items[i] = short; }
            // Fares for the legs after the bank, twice over for the way back, within what the bank holds.
            const fares = on.legs.reduce((n, l) => n + (l.kind === 'travel' ? l.travel.coins : 0), 0);
            best = { cost, legs: there.legs, bank: { at: bank, coins: Math.min(take, fares > 0 ? fareFloatTake(held, stock?.coins ?? 0, fares) : 0), items, then: on.legs } };
        }
    }
    return best;
}

// The last bank snapshot the status file holds (packages/core/src/status.ts writes it when a bank is open).
export function bankStock(name: string, opts: { server?: string; base?: string } = {}): BankStock | undefined {
    const base = opts.base ?? repoRoot;
    const dirs = opts.server && isLocalServer(opts.server)
        ? [simStatusDir(base), join(practiceRoot(base), 'status')]
        : statusReadDirs(base);
    for (const dir of dirs) {
        try {
            const st = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as { server?: string; bank?: { id: number; count: number }[] };
            if (opts.server && st.server && (isLocalServer(opts.server) ? st.server !== opts.server : isLocalServer(st.server))) continue;
            if (!Array.isArray(st.bank)) return undefined;
            const items: Record<string, number> = {};
            let coins = 0;
            for (const i of st.bank) {
                if (i.id === 995) { coins += i.count; continue; }
                const n = itemName(i.id);
                if (n) items[n] = (items[n] ?? 0) + i.count;
            }
            return { coins, items };
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
            return undefined;
        }
    }
    return undefined;
}

let names: Map<number, string> | undefined, ids: Map<string, number> | undefined;
function ensureItems(): void {
    if (names && ids) return;
    const raw = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'items.json'), 'utf8')) as { id: number; debugname: string }[];
    names = new Map();
    ids = new Map();
    for (const i of raw) {
        names.set(i.id, i.debugname);
        ids.set(i.debugname, i.id);
    }
}
export const itemName = (id: number) => { ensureItems(); return names!.get(id); };
export const itemIdOf = (name: string) => { ensureItems(); return ids!.get(name); };

type BankObservation={generation:number;items:{id:number;count:number}[]};
type BankSession = { tick(): number; sdk: { getState(): any }; bankObservation?():BankObservation|null; bot: { openBank(): Promise<{ success: boolean; message?: string }>; withdrawItem(row: unknown, count: number): Promise<unknown>; closeBank(): Promise<unknown> } };
type BankTakeResult={ok:boolean;detail:string;shortfalls?:Record<number,number>;unknown?:boolean};
function countRowsById(rows: readonly { id: number; count: number }[] | undefined, id: number): number {
    if (!rows) return 0;
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.id === id) total += row.count;
    }
    return total;
}
// Takes the whole route supply only after a current bank observation funds every line. Each withdrawal needs paired
// bank debit and pack credit in a newer bank generation; an unresolved action is never sent again here.
export async function takeItems(s: BankSession, coins: number, want: Record<string, number>, waitTicks: (n: number) => Promise<unknown>, options:{stop?:()=>boolean;deadline?:number;keepOpen?:boolean}={}): Promise<BankTakeResult> {
    const held = (id: number) => countRowsById(s.sdk.getState()?.inventory, id);
    const list = [...(coins > 0 ? [[995, coins] as const] : []), ...Object.entries(want).map(([n, c]) => [itemIdOf(n), c] as const)];
    if (list.some(([id]) => id === undefined)) return { ok: false, detail: `unknown item in ${JSON.stringify(want)}` };
    if(!Number.isSafeInteger(coins)||coins<0||list.some(([,n])=>!Number.isSafeInteger(n)||n<1))return {ok:false,detail:'invalid bank route supply count'};
    const required=new Map<number,number>();for(const[id,n]of list as [number,number][])required.set(id,(required.get(id)??0)+n);
    const stopped=()=>options.stop?.()||executionContext.getStore()?.signal.aborted||options.deadline!==undefined&&performance.now()>=options.deadline;
    const current=()=>s.sdk.getState()?.bank?.isOpen?s.bankObservation?.()??null:null;
    const stored=(observation:BankObservation,id:number)=>countRowsById(observation.items,id);
    return withExecutionDeadline(Math.max(0,(options.deadline??performance.now()+30_000)-performance.now()),async()=>{
        let opening=false,dispatched=false,result:BankTakeResult;
        const perform=async():Promise<BankTakeResult>=>{
            if(stopped())return {ok:false,detail:'bank stop stopped'};
            const prior=s.bankObservation?.(),alreadyCurrent=current(),wasCurrent=!!alreadyCurrent,generation=prior?.generation??-1;
            opening=true;
            if(!wasCurrent){
                const opened=await s.bot.openBank();
                if(!opened.success)return {ok:false,detail:`bank did not open: ${opened.message??''}`};
            }
            const fresh=()=>{const observation=current();return observation&&(wasCurrent||observation.generation>generation)?observation:null;};
            for(let i=0;i<10&&!fresh()&&!stopped();i++)await waitTicks(1);
            const observation=fresh();if(!observation||stopped())return {ok:false,detail:'bank observation unavailable',unknown:true};
            const obsCounts=new Map<number,number>();
            for(let i=0;i<observation.items.length;i++){const row=observation.items[i]!;obsCounts.set(row.id,(obsCounts.get(row.id)??0)+row.count);}
            const shortfalls:Record<number,number>={};
            for(const[id,n]of required){const short=n-(obsCounts.get(id)??0);if(short>0)shortfalls[id]=short;}
            if(Object.keys(shortfalls).length)return {ok:false,detail:'withdraw short '+JSON.stringify(shortfalls),shortfalls};
            // The SDK resolves exact bank slots from its own snapshot. Index rows once before the first dispatch.
            const bankRows=new Map<number,any>();
            const rawBankItems:any[]=s.sdk.getState()?.bank?.items??[];
            for(let i=0;i<rawBankItems.length;i++){const row=rawBankItems[i];if(row&&!bankRows.has(row.id))bankRows.set(row.id,row);}
            for(const id of required.keys())if(!bankRows.has(id))return {ok:false,detail:'bank withdrawal rows unavailable',unknown:true};
            for(const[id,n]of required){
                if(stopped())return {ok:false,detail:'bank stop stopped'};
                const liveItems:any[]=s.sdk.getState()?.bank?.items??[];
                let row=bankRows.get(id);
                if(!row||!liveItems.includes(row))row=liveItems.find((i:any)=>i.id===id);
                const before=current();
                if(!row||!before)return {ok:false,detail:'bank observation unavailable before withdrawal',unknown:true};
                const packBefore=held(id),bankBefore=stored(before,id),beforeGeneration=before.generation;
                if(bankBefore<n)return {ok:false,detail:'bank stock changed before withdrawal '+id,shortfalls:{[id]:n-bankBefore}};
                dispatched=true;try{await s.bot.withdrawItem(row,n);}catch{/* Reconcile a dispatch whose reply was lost. */}
                const matched=()=>{const after=current();return !!after&&after.generation>beforeGeneration&&held(id)===packBefore+n&&stored(after,id)===bankBefore-n;};
                for(let i=0;i<5&&!matched()&&!stopped();i++)await waitTicks(1);
                if(!matched())return {ok:false,detail:`withdraw outcome unknown ${id}:${held(id)-packBefore}/${n}`,unknown:true};
            }
            return {ok:true,detail:`took ${[...required].map(([id,n])=>`${id}x${n}`).join(',')}`};
        };
        try{result=await perform();}catch(error){result={ok:false,detail:'bank stop '+String(error),unknown:dispatched||opening};}
        if(opening&&!options.keepOpen)try{await s.bot.closeBank();}catch(error){result={...result,ok:false,detail:result.detail+'; bank close '+String(error),unknown:true};}
        return result;
    },()=>({ok:false,detail:'bank stop deadline',unknown:true}));
}
