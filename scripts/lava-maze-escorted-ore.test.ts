import { expect, test } from 'bun:test';
import { corridorThreat, RosterEvidence, entryRosterReady, waitForRosterEntry, stageRelease, readEscortRoute, alignAtBank, type RosterPlayer } from './lava-maze-escorted-ore';
import type { PathDeps } from '../packages/core/src/walk';
import { filterFixtureRoster, hasEscortLogouts } from '../packages/practice/src/lava-maze-escorted-ore-proof';

const names = ['Escort', 'Miner'];
const roster = (x = 3060, z = 3883): RosterPlayer[] => [[1, names[0]!, x, z, 0, 75], [2, names[1]!, 3094, 3492, 0, 29]];

test('native title-cased fixture rows survive identity filtering without changing native fields', () => {
    const rows:RosterPlayer[] = [[1,'Lvax1ft00',3094,3492,0,75],[2,'Lvax1ft11',3094,3491,0,29],[3,'Foreign',3060,3883,0,100]];
    const filtered=filterFixtureRoster(rows,['lvax1ft00','lvax1ft11']);
    expect(filtered).toEqual(rows.slice(0,2));
    expect(filtered[0]).toBe(rows[0]);
    expect(filtered[1]).toBe(rows[1]);
});

const entryParticipants=()=>names.map((name,i)=>({name:name.toLowerCase(),player:{worldX:3094,worldZ:3492,level:0,combatLevel:i===0?75:29}}));
function entryClock(){
    let tick=0;const listeners=new Set<()=>void>();
    return {sdk:{getState:()=>({})},tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};},
        advance:()=>{tick++;for(const cb of listeners)cb();},listening:()=>listeners.size};
}

test('saved adjacent-only Native frames cannot admit; exact local state needs a matching frame',()=>{
    // Input rows from .practice/lava-maze-escorted-ore-1794180328012/success-roster.json.
    const frames=[60,70,80].map(k=>({k,p:[[1,'Lvax91r00',3094,3491,0,75],[2,'Lvax91r11',3094,3491,0,29]] as RosterPlayer[]}));
    const feed=new RosterEvidence();
    for(const f of frames.filter(f=>[60,70,80].includes(f.k))){
        feed.accept({t:'roster',...f},f.k);
        const participants=f.p.map(row=>({name:row[1].toLowerCase(),player:{worldX:row[2],worldZ:row[3],level:row[4],combatLevel:row[5]}}));
        expect(entryRosterReady(feed.fresh(f.k),participants)).toBe(false);
        participants.forEach(p=>p.player.worldZ=3492);
        expect(entryRosterReady(feed.fresh(f.k),participants)).toBe(false);
        const exact={tick:90,at:90,roster:f.p.map(row=>[row[0],row[1],3094,3492,0,row[5]] as RosterPlayer)};
        expect(entryRosterReady(exact,participants)).toBe(true);
    }
});

function bankWalker(move=true){
    const clock=entryClock(),position={x:3094,z:3491,level:0},clicks:number[][]=[];
    const walker:PathDeps={...clock,pos:()=>position,locs:()=>[],plan:(_level,_from,to)=>[to],interactLoc:()=>{},
        walk:(x,z)=>{clicks.push([x,z]);if(move){position.x=x;position.z=z;}}};
    return {clock,position,clicks,walker};
}

test('safe bank alignment confirms exact observed arrival, not dispatch alone',async()=>{
    const f=bankWalker(),result=alignAtBank(f.walker,()=>false);f.clock.advance();
    expect(await result).toBe(true);expect(f.position).toEqual({x:3094,z:3492,level:0});
    const stuck=bankWalker(false),pending=alignAtBank(stuck.walker,()=>false);
    for(let i=0;i<13;i++)stuck.clock.advance();
    expect(await pending).toBe(false);expect(stuck.position.z).toBe(3491);
});

test('safe positioning refuses owner, life and budget gates without leaving Edgeville',async()=>{
    for(const gate of ['owner','life','budget','local-area']){
        const f=bankWalker(false);
        if(gate==='local-area')f.position.level=1;
        expect(await alignAtBank(f.walker,()=>gate!=='local-area')).toBe(false);
        expect(f.clicks).toEqual([]);expect(f.position.x).toBe(3094);expect(f.position.z).toBe(3491);
    }
    const f=bankWalker(false);let refused=false;
    const result=alignAtBank(f.walker,()=>refused);const count=f.clicks.length;
    refused=true;f.clock.advance();
    expect(await result).toBe(false);
    f.clock.advance();expect(f.clicks.length).toBe(count);expect(f.position.z).toBe(3491);
});
test('entry wait stays pending through startup frames, then accepts the first matching frame', async()=>{
    const clock=entryClock(),feed=new RosterEvidence();let moved=false;
    const result=waitForRosterEntry(clock,()=>feed.fresh(clock.tick()*100),entryParticipants,()=>!!feed.failure).then(ok=>{moved=ok;return ok;});
    for(const [i,rows] of [[],roster()].entries()){
        feed.accept({t:'roster',k:(i+1)*10,p:rows},clock.tick()*100);clock.advance();await Promise.resolve();
        expect(moved).toBe(false);expect(clock.listening()).toBe(1);
    }
    feed.accept({t:'roster',k:30,p:roster(3094,3492)},clock.tick()*100);clock.advance();
    expect(await result).toBe(true);expect(moved).toBe(true);expect(clock.tick()).toBe(3);expect(clock.listening()).toBe(0);
});
test('entry consumes one 40-tick budget when participants never appear', async()=>{
    const clock=entryClock(),feed=new RosterEvidence();feed.accept({t:'roster',k:10,p:[]},0);
    const result=waitForRosterEntry(clock,()=>feed.fresh(clock.tick()*100),entryParticipants,()=>!!feed.failure);
    for(let i=0;i<39;i++)clock.advance();
    expect(clock.listening()).toBe(1);clock.advance();
    expect(await result).toBe(false);expect(clock.tick()).toBe(40);expect(clock.listening()).toBe(0);
});
test('entry refuses malformed feed, a threat, or an owner or account gate without waiting for participants',async()=>{
    for(const kind of ['malformed','threat','hold','death','budget']){
        const clock=entryClock(),feed=new RosterEvidence();let gate=false;
        const refused=()=>gate||!!feed.failure||!!corridorThreat(feed.fresh(clock.tick()*100)?.roster??[],new Set(names.map(n=>n.toLowerCase())),[[3060,3883]],75);
        const result=waitForRosterEntry(clock,()=>feed.fresh(clock.tick()*100),entryParticipants,refused);
        feed.accept({t:'roster',k:10,p:kind==='malformed'?[[1,'Bad',1]]:kind==='threat'?[[3,'Enemy',3060,3883,0,100]]:[]},0);
        gate=['hold','death','budget'].includes(kind);clock.advance();
        expect(await result).toBe(false);expect(clock.tick()).toBe(1);expect(clock.listening()).toBe(0);
    }
});
test('empty and previous entry frames cannot release movement; the first matching frame can', () => {
    const feed=new RosterEvidence(), participants=entryParticipants();
    expect(entryRosterReady(feed.fresh(0),participants)).toBe(false);
    for(const [i,rows] of [[],roster(),roster(3094,3492).slice(0,1),
        roster(3094,3492).map(p=>[...p.slice(0,4),1,p[5]] as RosterPlayer),
        roster(3094,3492).map(p=>[...p.slice(0,5),100] as RosterPlayer)].entries()){
        feed.accept({t:'roster',k:(i+1)*10,p:rows},i*100);
        expect(entryRosterReady(feed.fresh(i*100),participants)).toBe(false);
        expect(feed.failure).toBeUndefined();
    }
    feed.accept({t:'roster',k:60,p:roster(3094,3492)},500);
    expect(entryRosterReady(feed.fresh(500),participants)).toBe(true);
    expect(entryRosterReady(feed.fresh(10500),participants)).toBe(false);
});

test('malformed entry evidence cannot recover and missing local state cannot release', () => {
    const feed=new RosterEvidence();
    feed.accept({t:'roster',k:10,p:[[1,'Bad',1]]},0);
    feed.accept({t:'roster',k:20,p:roster(3094,3492)},100);
    expect(entryRosterReady(feed.fresh(100),entryParticipants())).toBe(false);
    const valid=new RosterEvidence();valid.accept({t:'roster',k:10,p:roster(3094,3492)},0);
    expect(entryRosterReady(valid.fresh(0),[{name:'Escort',player:undefined},entryParticipants()[1]!])).toBe(false);
});

test('proof requires both logout results in the shared settle format', () => {
    expect(hasEscortLogouts('LOGOUT logged-out logged-out\r\n')).toBe(true);
    for(const log of ['LOGOUT logged-out\n','LOGOUT logged-out timeout\n','LOGOUT logged-out logged-out logged-out\n'])expect(hasEscortLogouts(log)).toBe(false);
});
test('route retains the measured endpoints and all 40 multi transit tiles', () => {
    const r = readEscortRoute();
    expect(r.out.p[0]).toEqual([3094, 3492]);
    expect(r.out.p.at(-1)).toEqual([3060, 3883]);
    expect(r.back.p[0]).toEqual([3060, 3883]);
    expect(r.back.p.at(-1)).toEqual([3094, 3492]);
    expect(r.multiTiles).toBe(40);
});
test('full corridor checks the two combat brackets separately', () => {
    const own = new Set(names.map(n => n.toLowerCase()));
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 0, 100]], own, [[3060, 3883]], 75)).toBeDefined();
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 0, 100]], own, [[3060, 3883]], 29)).toBeUndefined();
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 0, 3]], own, [[3060, 3883]], 29)).toBeDefined();
    expect(corridorThreat([[3, 'Enemy', 3060, 3883, 1, 75]], own, [[3060, 3883]], 75)).toBeUndefined();
    expect(corridorThreat([[3, 'Enemy', 3094, 3492, 0, 75]], own, [[3060, 3883]], 75)).toBeUndefined();
});
test('three distinct consecutive frames are required and polling cannot add frames', () => {
    const feed = new RosterEvidence();
    const release = stageRelease(names[0]!, names[1]!);
    feed.accept({t:'roster', k:10, p:roster()}, 100);
    expect(release(feed.fresh(100), true)).toBe(false);
    expect(release(feed.fresh(101), true)).toBe(false);
    feed.accept({t:'roster', k:20, p:roster()}, 200);
    expect(release(feed.fresh(200), true)).toBe(false);
    feed.accept({t:'roster', k:30, p:roster()}, 300);
    expect(release(feed.fresh(300), true)).toBe(true);
    expect(feed.fresh(10300)).toBeUndefined();
});

test('adjacent miner roster rows cannot release even with a ready local observation',()=>{
    const release=stageRelease(names[0]!,names[1]!);
    for(const tick of [10,20,30]){
        const rows=roster();rows[1]![3]=3491;
        expect(release({tick,at:tick,roster:rows},true)).toBe(false);
    }
    for(const tick of [40,50])expect(release({tick,at:tick,roster:roster()},true)).toBe(false);
    expect(release({tick:60,at:60,roster:roster()},true)).toBe(true);
});
test('gaps and malformed frames latch refusal for the whole trip', () => {
    for (const next of [{t:'roster',k:30,p:roster()}, {t:'roster',k:20,p:[[1,'Bad',1]]}]) {
        const feed = new RosterEvidence();
        feed.accept({t:'roster',k:10,p:roster()}, 100);
        feed.accept(next, 200);
        feed.accept({t:'roster',k:40,p:roster()}, 300);
        expect(feed.fresh(300)).toBeUndefined();
        expect(feed.failure).toBeDefined();
    }
});
test('release resets if the escort moves, miner leaves Edgeville, or roster is stale', () => {
    for (const interrupt of ['escort','miner','stale']) {
        const feed = new RosterEvidence(), release = stageRelease(names[0]!, names[1]!);
        for (const k of [10,20]) { feed.accept({t:'roster',k,p:roster()}, k); expect(release(feed.fresh(k),true)).toBe(false); }
        feed.accept({t:'roster',k:30,p:interrupt==='escort'?roster(3061):roster()},30);
        expect(release(interrupt==='stale'?undefined:feed.fresh(30),interrupt!=='miner')).toBe(false);
    }
});
