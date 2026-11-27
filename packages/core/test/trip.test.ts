import { expect, test } from 'bun:test';
import { itemsFor, planTrip, takeItems } from '../src/trip';
import { createWorld, type PathLength } from '../src/world';
import { loadTravel, staffCovers, travelAllowed, type Travel } from '../src/travel';

const boat: Travel = { id: 'b', kind: 'boat', name: 'A to B', from: { x: 0, z: 0, level: 0 }, to: { x: 1000, z: 0, level: 0 }, coins: 30, needs: [], runes: [], run: { how: 'npc', npc: 'Captain', op: 1, options: [], deck: true }, cost: 40 };
const pathLength: PathLength = (a, b, _bl, tol) => { const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)); return d <= 50 ? Math.max(0, d - tol) : null; };
const world = createWorld({ transports: [], doors: [], travel: [boat], pathLength });
const from = { x: 10, z: 0, level: 0 }, to = { x: 1010, z: 0, level: 0 }, bank = { x: 20, z: 5, level: 0 };
const poor = { skills: {}, varps: {}, items: [], coins: 0 };

test('an account with coins only in the bank stops at the bank, then sails', () => {
    const p = planTrip(world, from, to, poor, { coins: 5000 }, [bank])!;
    expect(p.bank?.at).toEqual(bank);
    // The standing fare float (trip.ts FARE_FLOAT): the bank holds FARE_FLOAT_AFFORD or more. The 30-coin fare twice
    // is the floor for a poorer bank.
    expect(p.bank?.coins).toBe(300);
    expect(planTrip(world, from, to, poor, { coins: 100 }, [bank])!.bank?.coins).toBe(60);
    expect(p.bank?.then.map(l => l.kind)).toEqual(['walk', 'travel', 'walk']);
});

test('no bank coins and no fare held gives no trip', () => {
    expect(planTrip(world, from, to, poor, { coins: 0 }, [bank])).toBeNull();
    expect(planTrip(world, from, to, poor, undefined, [bank])).toBeNull();
});

test('an account holding fares goes direct', () => {
    const p = planTrip(world, from, to, { ...poor, coins: 500 }, { coins: 5000 }, [bank])!;
    expect(p.bank).toBeUndefined();
    expect(p.legs.map(l => l.kind)).toEqual(['walk', 'travel', 'walk']);
});

test('a teleport leaves from the route start when the account holds its runes', () => {
    const spell: Travel = { id: 's', kind: 'spell', name: 'Far teleport', from: null, to: { x: 2000, z: 0, level: 0 }, coins: 0, needs: [{ skill: 'magic', level: 25 }],
        runes: [{ item: 'lawrune', count: 1 }], run: { how: 'spell', component: 'magic:far' }, cost: 5 };
    const w = createWorld({ transports: [], doors: [], travel: [spell], pathLength });
    const goal = { x: 2010, z: 0, level: 0 };
    expect(w.route(from, goal, { ...poor, skills: { magic: 25 }, counts: {} }).ok).toBe(false);
    expect(w.route(from, goal, { ...poor, skills: { magic: 24 }, counts: { lawrune: 1 } }).ok).toBe(false);
    const r = w.route(from, goal, { ...poor, skills: { magic: 25 }, counts: { lawrune: 1 } });
    expect(r.ok && r.legs.map(l => l.kind)).toEqual(['travel', 'walk']);
});

test('a bank stop takes no rune that the worn staff gives', () => {
    loadTravel('');
    const spell: Travel = { id: 'f', kind: 'spell', name: 'Fire teleport', from: null, to: { x: 2000, z: 0, level: 0 }, coins: 0, needs: [],
        runes: [{ item: 'lawrune', count: 1 }, { item: 'firerune', count: 1 }], run: { how: 'spell', component: 'magic:fire' }, cost: 5 };
    const legs = [{ kind: 'travel', travel: spell }] as any;
    expect(staffCovers('firerune', ['staff_of_fire'])).toBe(true);
    expect(staffCovers('firerune', undefined)).toBe(false);
    // The route check needs no fire rune held under the staff, so the bank stop must not take one.
    const worn = { ...poor, worn: ['staff_of_fire'], counts: { lawrune: 1 } };
    expect(travelAllowed(spell, worn)).toBe(true);
    expect(itemsFor(legs, {}, ['staff_of_fire'])).toEqual({ lawrune: 1 });
    expect(itemsFor(legs, {})).toEqual({ lawrune: 1, firerune: 1 });
});

// A world whose direct route costs 400 and whose route from the bank costs 50 only with a law rune.
function countingWorld() {
    const calls: string[] = [];
    const law = (a: { counts?: Record<string, number> }) => a.counts?.lawrune ?? 0;
    const w = {
        route: (a: { x: number }, b: { x: number }, acct: { counts?: Record<string, number> }) => {
            calls.push(`${a.x}>${b.x}`);
            const cost = a.x === from.x && b.x === to.x ? 400 : b.x === bank.x ? 5 : law(acct) > 0 ? 50 : 400;
            return { ok: true as const, legs: [], cost };
        },
        blockedDoors: () => [],
        routeGain: (a: { counts?: Record<string, number> }, b: { counts?: Record<string, number> }) => law(a) === 0 && law(b) > 0,
    };
    return { w, calls };
}

test('a bank that opens no travel or door and adds no fare coins is not searched', () => {
    const { w, calls } = countingWorld();
    const p = planTrip(w as any, from, to, { ...poor, coins: 5000 }, { coins: 9000, items: { bronzeaxe: 1, airrune: 500 } }, [bank])!;
    expect(p.cost).toBe(400);
    expect(p.bank).toBeUndefined();
    expect(calls).toEqual([`${from.x}>${to.x}`]);
});

test('a bank that opens a travel is still searched, and its stop wins when cheaper', () => {
    const { w, calls } = countingWorld();
    const p = planTrip(w as any, from, to, { ...poor, coins: 5000 }, { coins: 9000, items: { lawrune: 3 } }, [bank])!;
    expect(calls.length).toBe(3);
    expect(p.bank?.at).toEqual(bank);
    expect(p.cost).toBe(5 + 10 + 50);
});

test('a fourth known bank is considered when the nearest three cannot reach a funded route',()=>{
    const candidates=[11,12,13,14,15].map(x=>({x,z:0,level:0})),calls:number[]=[];
    const w={route:(a:typeof from,b:typeof to)=>{if(b.x===to.x)return a.x===14?{ok:true,cost:20,legs:[]}:{ok:false};calls.push(b.x);return b.x===14?{ok:true,cost:5,legs:[]}:{ok:false};}};
    const p=planTrip(w as any,from,to,poor,{coins:100},candidates);
    expect(p?.bank?.at).toEqual(candidates[3]);
    expect(calls).toEqual([11,12,13,14,15]);
});

test('a successful nearest bank keeps the search in its initial bank group',()=>{
    const candidates=[11,12,13,14].map(x=>({x,z:0,level:0})),calls:number[]=[];
    const w={route:(a:typeof from,b:typeof to)=>{if(b.x===to.x)return a.x===from.x?{ok:false}:{ok:true,cost:20,legs:[]};calls.push(b.x);return {ok:true,cost:5,legs:[]};}};
    expect(planTrip(w as any,from,to,poor,{coins:100},candidates)?.bank).toBeDefined();
    expect(calls).toEqual([11,12,13]);
});

test('no direct route and no gain from the bank stock: no bank is searched',()=>{
    const calls:number[]=[];
    const w={route:(_a:typeof from,b:typeof to)=>{calls.push(b.x);return {ok:false};},routeGain:()=>false};
    expect(planTrip(w as any,from,to,poor,{coins:0,items:{bronzeaxe:1}},[bank])).toBeNull();
    expect(calls).toEqual([to.x]);
    // With a gain the banks are still searched.
    const g={...w,routeGain:()=>true};calls.length=0;
    expect(planTrip(g as any,from,to,poor,{coins:0,items:{bronzeaxe:1}},[bank])).toBeNull();
    expect(calls).toEqual([to.x,bank.x]);
});

test('bank fallback tries at most eight same-plane banks',()=>{
    const candidates=[...Array.from({length:10},(_,i)=>({x:11+i,z:0,level:0})),{x:10,z:0,level:1}],calls:number[]=[];
    const w={route:(_a:typeof from,b:typeof to)=>{if(b.x!==to.x)calls.push(b.x);return {ok:false};}};
    expect(planTrip(w as any,from,to,poor,{coins:100},candidates)).toBeNull();
    expect(calls).toEqual([11,12,13,14,15,16,17,18]);
});

test('an exhausted route deadline prevents another bank fallback search',()=>{
    const candidates=[11,12,13,14].map(x=>({x,z:0,level:0})),calls:number[]=[],options={deadline:performance.now()+60_000};
    const w={route:(_a:typeof from,b:typeof to)=>{if(b.x!==to.x){calls.push(b.x);if(b.x===13)options.deadline=-1;}return {ok:false};}};
    expect(planTrip(w as any,from,to,poor,{coins:100},candidates,3,options)).toBeNull();
    expect(calls).toEqual([11,12,13]);
});

test('routeGain is true only when the second account may take a travel or pass a key door that the first may not', () => {
    const spell: Travel = { id: 's', kind: 'spell', name: 'Far teleport', from: null, to: { x: 2000, z: 0, level: 0 }, coins: 0, needs: [{ skill: 'magic', level: 25 }],
        runes: [{ item: 'lawrune', count: 1 }, { item: 'airrune', count: 3 }], run: { how: 'spell', component: 'magic:far' }, cost: 5 };
    const w = createWorld({ transports: [], doors: [{ id: 1, loc: 'door', x: 5, z: 5, level: 0, kind: 'key', need: { item: 'elenakey' }, trigger: '', src: '' }], travel: [spell], pathLength });
    const mage = { ...poor, skills: { magic: 25 }, counts: { airrune: 3 } };
    // Air runes without a law rune open nothing.
    expect(w.routeGain!(mage, { ...mage, counts: { airrune: 500 } })).toBe(false);
    expect(w.routeGain!(mage, { ...mage, counts: { airrune: 3, lawrune: 1 } })).toBe(true);
    // A law rune does not help below the spell's Magic level.
    expect(w.routeGain!({ ...mage, skills: { magic: 1 } }, { ...mage, skills: { magic: 1 }, counts: { airrune: 3, lawrune: 1 } })).toBe(false);
    expect(w.routeGain!(poor, { ...poor, items: ['elenakey'] })).toBe(true);
    expect(w.routeGain!(poor, poor)).toBe(false);
});

function withdrawalFixture(stock: number, received: number, delay = 0, mode='normal') {
    let tick = 0, held = 7, pending = false, closed = false,open=false,generation=0;
    const row = { id: 995, count: stock };
    const requests: number[] = [];
    const s = {
        tick: () => tick,
        bankObservation:()=>mode==='missing-observation'||!open?null:{generation,items:row.count>0?[row]:[]},
        sdk: { getState: () => ({ inventory: [{ id: 995, count: held }], bank: { isOpen:open,items: [row] } }) },
        bot: {
            openBank: async () => {open=true;generation++;return { success: true };},
            withdrawItem: async (_row: unknown, amount: number) => {
                requests.push(amount);
                if(mode!=='no-debit')row.count -= amount;
                if(mode!=='stale-generation')generation++;
                if (delay) pending = true; else held += received;
                if(mode==='lost-ack')throw Error('lost withdrawal reply');
                return { success: true };
            },
            closeBank: async () => { closed = true;open=false; },
        },
    };
    const wait = async () => {
        tick++;
        if (pending && tick >= delay) { held += received; pending = false; }
    };
    return { s, wait, requests, held: () => held, closed: () => closed };
}

test('a bank stop reports the whole route fare shortage before taking any coins', async () => {
    const f = withdrawalFixture(20, 20);
    expect(await takeItems(f.s, 100, {}, f.wait)).toMatchObject({ ok: false, shortfalls:{995:80} });
    expect(f.requests).toEqual([]);
    expect(f.held()).toBe(7);
    expect(f.closed()).toBe(true);
});

test('a bank row emptied in place does not confirm a withdrawal before the pack receives it', async () => {
    const f = withdrawalFixture(100, 100, 3);
    expect(await takeItems(f.s, 100, {}, f.wait)).toEqual({ ok: true, detail: 'took 995x100' });
    expect(f.s.tick()).toBe(3);
    expect(f.held()).toBe(107);
    expect(f.closed()).toBe(true);
});

test('a bank debit with only partial pack credit cannot satisfy a bank stop', async () => {
    const f = withdrawalFixture(100, 60);
    expect(await takeItems(f.s, 100, {}, f.wait)).toMatchObject({ ok: false, unknown:true });
    expect(f.s.tick()).toBe(5);
});

test('a bank debit without pack credit cannot satisfy a bank stop', async () => {
    const f = withdrawalFixture(100, 0);
    expect(await takeItems(f.s, 100, {}, f.wait)).toMatchObject({ ok: false, unknown:true });
    expect(f.s.tick()).toBe(5);
});

test('a missing travel item holds the route before its full fare is withdrawn', async () => {
    const f = withdrawalFixture(100, 100);
    expect(await takeItems(f.s, 100, { lawrune: 1 }, f.wait)).toMatchObject({ ok: false,shortfalls:{563:1} });
    expect(f.requests).toEqual([]);
    expect(f.closed()).toBe(true);
});

test('an observed empty bank is a known shortage without an empty-bank polling delay',async()=>{
    const f=withdrawalFixture(0,0);
    expect(await takeItems(f.s,10,{lawrune:2},f.wait)).toMatchObject({ok:false,shortfalls:{995:10,563:2}});
    expect(f.s.tick()).toBe(0);
    expect(f.requests).toEqual([]);
});

test('a cached bank row without a current bank observation cannot authorize withdrawal',async()=>{
    const f=withdrawalFixture(100,100,0,'missing-observation');
    expect(await takeItems(f.s,100,{},f.wait)).toMatchObject({ok:false,unknown:true});
    expect(f.requests).toEqual([]);
    expect(f.s.tick()).toBe(10);
    expect(f.closed()).toBe(true);
});

test('pack gain alone and an unchanged bank generation cannot confirm a route withdrawal',async()=>{
    for(const mode of['no-debit','stale-generation']){const f=withdrawalFixture(100,100,0,mode);
        expect(await takeItems(f.s,100,{},f.wait)).toMatchObject({ok:false,unknown:true});
        expect(f.requests).toEqual([100]);
        expect(f.closed()).toBe(true);
    }
});

test('a lost withdrawal reply reconciles a paid route supply without repeating the action',async()=>{
    const f=withdrawalFixture(100,100,0,'lost-ack');
    expect(await takeItems(f.s,100,{},f.wait)).toEqual({ok:true,detail:'took 995x100'});
    expect(f.requests).toEqual([100]);
    expect(f.closed()).toBe(true);
});

test('a caller stop prevents the bank stop from starting a withdrawal',async()=>{
    const f=withdrawalFixture(100,100);
    expect(await takeItems(f.s,100,{},f.wait,{stop:()=>true})).toMatchObject({ok:false});
    expect(f.requests).toEqual([]);
});

test('an expired bank-stop deadline ends observation polling without dispatching a withdrawal',async()=>{
    const f=withdrawalFixture(100,100,0,'missing-observation'),options={deadline:performance.now()+60_000};
    const wait=async()=>{await f.wait();options.deadline=-1;};
    expect(await takeItems(f.s,100,{},wait,options)).toMatchObject({ok:false,unknown:true});
    expect(f.s.tick()).toBe(1);
    expect(f.requests).toEqual([]);
    expect(f.closed()).toBe(true);
});
