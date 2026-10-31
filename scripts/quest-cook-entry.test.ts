import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { completeCook } from './generated/quest-cook';
import { executeHetty } from './generated/quest-hetty';
import { parseJm2 } from '../packages/knowledge/src/jm2';

function fixture(x = 3092, z = 3243) {
    const player = { worldX: x, worldZ: z, level: 0 };
    let state: 'unknown' | 'not started' | 'started' | 'complete' = 'not started';
    let packReady = true, moves = true, consumes = true, completes = true, doorOpened = false;
    const pack = new Map([[1944, 1], [1927, 1], [1933, 1]]);
    const calls: string[] = [], routes: { x: number; z: number; tol?: number }[][] = [];
    const waits: number[] = [];
    const io: Parameters<typeof completeCook>[0] = {
        pos: () => player, lvl: () => player.level,
        near: (x, z, r) => Math.max(Math.abs(player.worldX - x), Math.abs(player.worldZ - z)) <= r,
        questState: () => state, packReady: () => packReady,
        cnt: id => pack.get(id) ?? 0,
        waitUntil: async (pred, ticks) => { waits.push(ticks); return pred(); },
        walk: async (label, points) => {
            calls.push(label); routes.push(points);
            if (label === 'cook kitchen entry' && !doorOpened) throw Error('closed kitchen door');
            if (moves) { const last = points.at(-1)!; player.worldX = last.x; player.worldZ = last.z; }
        },
        openDoor: async (label, x, z) => {
            calls.push(label);
            expect([x, z]).toEqual([3207, 3217]);
            expect([player.worldX, player.worldZ]).toEqual([3207, 3218]);
            doorOpened = true;
        },
        talk: async (label, _npc, _options, observed) => {
            calls.push(label);
            // The retained failure tile sees the cook across the north wall but cannot talk to him.
            if (player.worldZ >= 3217) throw Error('cook unreachable across kitchen wall');
            if (label === 'cook 1') state = 'started';
            else {
                if (consumes) for (const id of pack.keys()) pack.set(id, 0);
                if (completes) state = 'complete';
            }
            if (!observed()) throw Error('talk effect unobserved');
        },
        converse: async (_options, observed) => observed(), dialogOpen: () => false,
        milestone: step => { calls.push('milestone ' + step); },
    };
    return { io, player, calls, routes, waits, pack,
        state: (value: typeof state) => { state = value; },
        ready: (value: boolean) => { packReady = value; },
        moves: (value: boolean) => { moves = value; },
        consumes: (value: boolean) => { consumes = value; },
        completes: (value: boolean) => { completes = value; },
    };
}

test('actual gathered endpoint uses the northern corridor then crosses the kitchen door before talking', async () => {
    const f = fixture();
    expect((await completeCook(f.io)).ok).toBe(true);
    expect(f.routes[0]).toContainEqual({ x: 3140, z: 3270, tol: 2 });
    expect(f.calls.slice(0, 5)).toEqual(['cook northern approach', 'cook kitchen door approach',
        'cook kitchen north door', 'cook kitchen entry', 'cook 1']);
    expect(f.routes.at(-1)).toEqual([{ x: 3207, z: 3216, tol: 0 }, { x: 3208, z: 3214, tol: 0 }]);
    expect([...f.pack.values()]).toEqual([0, 0, 0]);
});

test('visible cook at the retained failure tile still requires a door crossing', async () => {
    const f = fixture(3209, 3218);
    await completeCook(f.io);
    expect(f.calls.slice(0, 4)).toEqual(['cook kitchen door approach', 'cook kitchen north door', 'cook kitchen entry', 'cook 1']);
});

test('pinned kitchen has a north wall and a door at the chosen crossing', () => {
    const map = parseJm2('m50_50.jm2', readFileSync(new URL('../vendor/rs-sdk/server/content/maps/m50_50.jm2', import.meta.url), 'utf8'));
    expect(map.locs.some(l => l.level === 0 && l.x === 3207 && l.z === 3217 && l.id === 1536 && l.shape === 0 && l.angle === 1)).toBe(true);
    expect(map.locs.some(l => l.level === 0 && l.x === 3209 && l.z === 3217 && l.id === 1911 && l.shape === 0)).toBe(true);
});

test('interior preset and started-quest resume do not repeat the start conversation', async () => {
    const f = fixture(3209, 3214); f.state('started');
    await completeCook(f.io);
    expect(f.routes).toHaveLength(0);
    expect(f.calls).toEqual(['cook 2', 'milestone 2']);
});

test('unknown entry, completed quest, missing inputs, surplus and wrong floor refuse before work', async () => {
    for (const setup of [
        (f: ReturnType<typeof fixture>) => f.state('unknown'),
        (f: ReturnType<typeof fixture>) => f.state('complete'),
        (f: ReturnType<typeof fixture>) => f.ready(false),
        (f: ReturnType<typeof fixture>) => { f.pack.delete(1944); },
        (f: ReturnType<typeof fixture>) => { f.pack.set(1944, 2); },
        (f: ReturnType<typeof fixture>) => { f.player.level = 1; },
    ]) {
        const f = fixture(); setup(f);
        await expect(completeCook(f.io)).rejects.toThrow();
        expect(f.calls).toEqual([]);
        expect(f.waits).toEqual([20]);
    }
});

test('walk dispatch without interior arrival cannot start dialogue', async () => {
    const f = fixture(3207, 3218); f.moves(false);
    await expect(completeCook(f.io)).rejects.toThrow('arrival unobserved');
    expect(f.calls.some(c => /^cook [12]$/.test(c))).toBe(false);
});

test('completion flag without consumption and consumption without completion both fail', async () => {
    for (const flagOnly of [true, false]) {
        const f = fixture(3209, 3214);
        if (flagOnly) f.consumes(false); else f.completes(false);
        await expect(completeCook(f.io)).rejects.toThrow(/unobserved/);
        expect(f.calls).not.toContain('milestone 2');
    }
});

test('entry wait accepts a delayed real observation within its supplied deadline', async () => {
    const f = fixture(3209, 3214); f.state('unknown');
    f.io.waitUntil = async (pred, ticks) => {
        if (pred()) return true;
        expect(ticks).toBe(20); f.state('not started');
        return pred();
    };
    expect((await completeCook(f.io)).ok).toBe(true);
});

test('door failure propagates and stops before entering or talking', async () => {
    const f = fixture(3209, 3218);
    f.io.openDoor = async () => { throw Error('door effect unobserved'); };
    await expect(completeCook(f.io)).rejects.toThrow('door effect unobserved');
    expect(f.calls).toEqual(['cook kitchen door approach']);
});

test('generated Hetty reuses owned tails, supports started entry and needs completion plus debits',async()=>{
 for(const mode of ['new','started','no-credit','no-debit']){
  let colour=mode==='started'?0xf8f800:0xf80000;
  const inv=new Map([[1957,2],[221,2],[2146,2],[300,2]]),calls:string[]=[];
  const q:any={s:{client:{ingame:true,ifType:()=>({colour})}},st:()=>({inventory:[...inv].map(([id,count])=>({id,count}))}),
   cnt:(id:number)=>inv.get(id)??0,has:(id:number)=>(inv.get(id)??0)>0,
   waitUntil:async(pred:()=>boolean)=>pred(),milestone:()=>{},openDoor:async()=>{},
   talk:async(label:string,_re:RegExp,_patterns:RegExp[],ok:()=>boolean)=>{
    calls.push(label);
    if(label==='hetty 1')colour=0xf8f800;
    else if(mode!=='no-debit')for(const id of inv.keys())inv.set(id,inv.get(id)!-1);
    if(!ok())throw Error('hand-in effect unobserved');
   },
   step:async(_label:string,_send:unknown,ok:()=>boolean)=>{if(mode!=='no-credit')colour=0x00f800;if(!ok())throw Error('completion unobserved');},
   converse:async()=>true,dialogOpen:()=>false,
   dash:async()=>{throw Error('owned tail must skip rat hunt');}};
  if(mode==='no-credit'||mode==='no-debit')await expect(executeHetty(q)).rejects.toThrow('unobserved');
  else {expect((await executeHetty(q)).ok).toBe(true);expect(calls).toEqual(mode==='new'?['hetty 1','hetty 2']:['hetty 2']);}
 }
});
