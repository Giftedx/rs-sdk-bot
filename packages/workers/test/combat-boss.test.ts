import { beforeAll, describe, expect, test } from 'bun:test';
import {
    BLACK_ALTAR,
    BLACK_DRAGON,
    BLACK_ENTRY,
    BLACK_KIT,
    BLACK_PRAYER,
    BLUE_KIT,
    DRAGONFIRE_SHIELD_ID,
    GREEN_DRAGON_ID,
    GREEN_DRAGON_SPOT,
    KBD_KIT,
    PROTECT_MAGIC,
    SAFE_SOUTH_TILE,
    TELEPORT_RUNES,
    TELEPORT_TRIES,
    TELEPORT_WAIT,
    blackKit,
    blackPrayerShort,
    canShoot,
    combatAssetIssues,
    combatKitTotals,
    combatTeleportAllowed,
    combatTrip,
    footprintDistance,
    inKbdLair,
    inVarrockSquare,
    insideLegacyTrawler,
    kbdEntryFailure,
    kbdKillCredit,
    kbdRetreatReason,
    leaveKbdEntrancePit,
    runKbdOne,
    runTrawlerSupport,
    selectGreenDragon,
    selectKbdTarget,
    swTile,
    trawlerAssetsReconcile,
    trawlerCatchRows,
    trawlerEffect,
    trawlerInterruption,
    trawlerNetWindow,
    underground,
    validateCombatKit,
    wildDragonEscapeAction,
    wildDragonEscapeKeep,
    wildDragonPreflight,
    wildDragonRetreatReason,
    wildDragonThreat,
    wildDragonWalkHalt,
    type TrawlerDriver,
} from '../src/combat';
import { type Session } from '../../../packages/core/src/inprocess';
import { loadPathfinding } from '../../../packages/core/src/pathcache';
import { ITEMS, wildernessLevel } from '../../../scripts/pk';
import { initPathfinding } from '../../../vendor/rs-sdk/sdk/pathfinding';
import { type BotWorldState } from '../../../vendor/rs-sdk/sdk/types';
import * as rsmod from '../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import { CollisionType } from '../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder';

describe('black-dragon-camp', () => {
// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts), which is more than the
// time limit of a test. The snapshot loader makes the same grid first, so the calls in the tests return at once.
beforeAll(async () => { await loadPathfinding(); }, 120_000);

const key = (x: number, z: number) => `${x},${z}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
// Every tile a mover of `size` reaches from `starts` by the engine's own step rule.
function reach(starts: { x: number; z: number }[], size: number): { x: number; z: number }[] {
    initPathfinding();
    const seen = new Set(starts.map(t => key(t.x, t.z))), queue = starts.map(t => [t.x, t.z] as [number, number]);
    while (queue.length) {
        const [x, z] = queue.shift()!;
        for (const [dx, dz] of DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx < 2790 || nx > 2880 || nz < 9780 || nz > 9860 || seen.has(key(nx, nz)) || !rsmod.canTravel(0, x, z, dx, dz, size, 0, CollisionType.NORMAL)) continue;
            seen.add(key(nx, nz)); queue.push([nx, nz]);
        }
    }
    return [...seen].map(k => k.split(',').map(Number)).map(([x, z]) => ({ x: x!, z: z! }));
}

test('the distance to a dragon is to its 4x4 footprint, zero under it', () => {
    const sw = { x: 2835, z: 9822 };
    expect(footprintDistance(sw, { x: 2835, z: 9820 })).toBe(2);
    expect(footprintDistance(sw, { x: 2836, z: 9823 })).toBe(0);
    expect(footprintDistance(sw, { x: 2839, z: 9826 })).toBe(1);
    expect(footprintDistance(sw, { x: 2830, z: 9829 })).toBe(5);
    // The route tile, not the render position, names the south-west tile.
    expect(swTile({ x: 2837, z: 9826, tileX: 2835, tileZ: 9824 })).toEqual({ x: 2835, z: 9824 });
    expect(swTile({ x: 2837, z: 9826 })).toEqual({ x: 2837, z: 9826 });
});

test('no black dragon can stand within a tile of the camp tile, and a player reaches the tile from the south', () => {
    const dragons = reach([...BLACK_DRAGON.spawns], BLACK_DRAGON.size), safe = BLACK_DRAGON.safe;
    // The cave holds a few dozen south-west positions; the corridor is none of them.
    expect(dragons.length).toBeGreaterThan(20);
    expect(dragons.length).toBeLessThan(60);
    expect(Math.min(...dragons.map(d => footprintDistance(d, safe)))).toBe(2);
    // The same holds for the rest of the corridor's south half, where the trip's walk may end.
    for (const x of [2834, 2835, 2836]) for (const z of [9818, 9819, 9820]) expect(Math.min(...dragons.map(d => footprintDistance(d, { x, z })))).toBeGreaterThanOrEqual(2);
    // The row north of the tile is beside dragon ground: the camp must never stand there.
    expect(Math.min(...dragons.map(d => footprintDistance(d, { x: safe.x, z: safe.z + 1 })))).toBe(1);
    // A player walks in from the poison spiders' side without crossing a tile a dragon can cover.
    const covered = new Set(dragons.flatMap(d => [0, 1, 2, 3].flatMap(i => [0, 1, 2, 3].map(j => key(d.x + i, d.z + j)))));
    const [last] = BLACK_ENTRY.slice(-1);
    const player = reach([{ x: last![0], z: last![1] }], 1);
    expect(player.some(t => t.x === safe.x && t.z === safe.z)).toBe(true);
    for (const [x, z] of BLACK_ENTRY) expect(covered.has(key(x, z))).toBe(false);
    expect(Math.abs(last![0] - safe.x)).toBeLessThanOrEqual(1);
    expect(last![1]).toBeLessThanOrEqual(safe.z - 1);
});

test('the camp shoots only a dragon whose south-west tile is in sight within five tiles', () => {
    const safe = BLACK_DRAGON.safe;
    // The dragon that spawns north of the corridor, and one parked at the corridor mouth.
    expect(canShoot(safe, { x: 2835, z: 9824 })).toBe(true);
    expect(canShoot(safe, { x: 2835, z: 9822 })).toBe(true);
    // Seven tiles west: a shot from there walked the account onto dragon ground on practice.
    expect(canShoot(safe, { x: 2828, z: 9824 })).toBe(false);
    expect(canShoot(safe, BLACK_DRAGON.spawns[0]!)).toBe(false);
    // Behind rock: no sight from the dungeon's entrance ladder, whatever the range.
    expect(canShoot({ x: 2884, z: 9797 }, { x: 2835, z: 9824 }, 80)).toBe(false);
});

test('the trip kit is a bow, arrows, the key, the escape runes and food, and asks Ranged 50', () => {
    expect(validateCombatKit(BLACK_KIT)).toEqual([{ skill: 'Ranged', level: 50 }]);
    expect(combatKitTotals(BLACK_KIT)).toEqual({ 861: 1, 888: 700, 1590: 1, 563: 1, 556: 3, 554: 1, 385: 6 });
    // The arrow is a choice: iron arrows by the thousand, and nothing that is not an arrow.
    expect(combatKitTotals(blackKit('iron_arrow', 1200))).toMatchObject({ 861: 1, 884: 1200 });
    expect(validateCombatKit(blackKit('iron_arrow', 1200))).toEqual([{ skill: 'Ranged', level: 50 }]);
    expect(() => blackKit('bolt', 700)).toThrow();
    expect(() => blackKit('iron_arrow', 50)).toThrow();
});

test('the trip prays at the Taverley altar when its prayer points would not last the camp', () => {
    // Spent on another job (live: Lost City's tree spirit), or part used by the last trip.
    expect(blackPrayerShort(0, 99)).toBe(true);
    expect(blackPrayerShort(BLACK_PRAYER - 1, 99)).toBe(true);
    expect(blackPrayerShort(BLACK_PRAYER, 99)).toBe(false);
    expect(blackPrayerShort(99, 99)).toBe(false);
    // An account whose Prayer level is under the threshold is full at its level.
    expect(blackPrayerShort(45, 45)).toBe(false);
    expect(blackPrayerShort(44, 45)).toBe(true);
    // The altar is above ground in Taverley, between the Falador west bank and the dungeon ladder.
    expect(BLACK_ALTAR).toEqual({ id: 410, x: 2925, z: 3483 });
});

test('the way home is the kit\'s Varrock teleport, tried for longer than one busy spell, and the fetch prays against fire', () => {
    // The runes a leaving account must hold are the trip kit's own: one cast.
    const kit = combatKitTotals(BLACK_KIT);
    for (const [id, n] of Object.entries(TELEPORT_RUNES)) expect(kit[Number(id)]).toBe(n);
    // Six clicks eight ticks apart: 48 ticks, against the 20 a single click waited live.
    expect(TELEPORT_TRIES * TELEPORT_WAIT).toBeGreaterThanOrEqual(40);
    expect(inVarrockSquare({ worldX: 3213, worldZ: 3422, level: 0 })).toBe(true);
    expect(inVarrockSquare({ worldX: 2835, worldZ: 9820, level: 0 })).toBe(false);
    expect(inVarrockSquare(null)).toBe(false);
    // The camp tile is underground, the banks are not.
    expect(underground({ worldZ: BLACK_DRAGON.safe.z })).toBe(true);
    expect(underground({ worldZ: 3436 })).toBe(false);
    expect(underground(undefined)).toBe(false);
    // Protect from Magic: dragon.rs2 caps a breath at 10 under `%prayer12`.
    expect(PROTECT_MAGIC).toBe(12);
});
});

describe('wild-dragons', () => {
const baseState = (over: Partial<any> = {}): any => ({
    player: { worldX: GREEN_DRAGON_SPOT.x, worldZ: GREEN_DRAGON_SPOT.z, level: 0, combatLevel: 90, lifeId: 1 },
    skills: [{ name: 'Hitpoints', level: 80, experience: 1000 }],
    equipment: [{ slot: 3, id: 1333, count: 1 }, { slot: 5, id: DRAGONFIRE_SHIELD_ID, count: 1 }],
    inventory: [{ id: 385, count: 1, slot: 0 }],
    nearbyNpcs: [],
    nearbyPlayers: [],
    groundItems: [],
    ...over,
});

test('wildDragonPreflight requires Dragonfire shield (1540), melee weapon, and food', () => {
    expect(wildDragonPreflight(baseState())).toBeNull();
    expect(wildDragonPreflight(baseState({ inventory: [] }), false)).toBeNull();
    expect(wildDragonPreflight(baseState({ equipment: [{ slot: 3, id: 1333, count: 1 }] }))).toContain('Dragonfire shield');
    expect(wildDragonPreflight(baseState({ equipment: [{ slot: 5, id: DRAGONFIRE_SHIELD_ID, count: 1 }] }))).toContain('melee weapon');
    expect(wildDragonPreflight(baseState({ inventory: [] }))).toContain('food');
});

test('wildDragonThreat ignores fleet accounts and out-of-range players, flags attackable PKers', () => {
    const ours = new Set(['ally']);
    expect(wildernessLevel(GREEN_DRAGON_SPOT.z)).toBeGreaterThanOrEqual(35);
    expect(wildDragonThreat(baseState({ nearbyPlayers: [{ name: 'Ally', combatLevel: 90, z: GREEN_DRAGON_SPOT.z }] }), ours)).toBeNull();
    expect(wildDragonThreat(baseState({ nearbyPlayers: [{ name: 'Lowbie', combatLevel: 10, z: GREEN_DRAGON_SPOT.z }] }), ours)).toBeNull();
    const pker: any = { kind: 'player', index: 1, name: 'Pker', combatLevel: 100, x: 3092, z: GREEN_DRAGON_SPOT.z, distance: 3 };
    expect(wildDragonThreat(baseState({ nearbyPlayers: [pker] }), ours)).toEqual(pker);
});

test('wildDragonRetreatReason triggers on PKer threat, low HP, full pack, or missing shield', () => {
    const ours = new Set<string>();
    expect(wildDragonRetreatReason(baseState(), { eatAt: 45, escapeAt: 30 }, ours)).toBeNull();
    expect(wildDragonRetreatReason(baseState({ nearbyPlayers: [{ name: 'Pker', combatLevel: 90, z: GREEN_DRAGON_SPOT.z }] }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('pker-threat');
    expect(wildDragonRetreatReason(baseState({ skills: [{ name: 'Hitpoints', level: 25 }] }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('low-hp');
    expect(wildDragonRetreatReason(baseState({ inventory: Array.from({ length: 28 }, (_, slot) => ({ id: 536, count: 1, slot })) }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('pack-full');
    expect(wildDragonRetreatReason(baseState({ equipment: [{ slot: 3, id: 1333, count: 1 }] }), { eatAt: 45, escapeAt: 30 }, ours)).toBe('shield-missing');
});

test('wildDragonWalkHalt stops a Wilderness walk for a player threat, low hitpoints or hitpoints to eat at', () => {
    const ours = new Set<string>(), o = { eatAt: 45, escapeAt: 30 };
    expect(wildDragonWalkHalt(baseState(), o, ours)).toBe(false);
    // A player who can attack on the way in (a death at wild 36 had 21 hits from one).
    expect(wildDragonWalkHalt(baseState({ nearbyPlayers: [{ name: 'Pker', combatLevel: 90, z: GREEN_DRAGON_SPOT.z }] }), o, ours)).toBe(true);
    expect(wildDragonWalkHalt(baseState({ skills: [{ name: 'Hitpoints', level: 25 }] }), o, ours)).toBe(true);
    expect(wildDragonWalkHalt(baseState({ skills: [{ name: 'Hitpoints', level: 40 }] }), o, ours)).toBe(true);
    // Outside the Wilderness the walk does not stop.
    const south = { worldX: SAFE_SOUTH_TILE.x, worldZ: SAFE_SOUTH_TILE.z, level: 0, combatLevel: 90, lifeId: 1 };
    expect(wildDragonWalkHalt(baseState({ player: south, skills: [{ name: 'Hitpoints', level: 25 }] }), o, ours)).toBe(false);
});


test('wildDragonEscapeAction runs south above level 30, uses glory below 30, and Varrock Teleport below 20', () => {
    expect(wildernessLevel(SAFE_SOUTH_TILE.z)).toBe(0);
    const withGlory = baseState({ inventory: [{ id: ITEMS.glory[0], count: 1, slot: 0 }] });
    expect(wildDragonEscapeAction(withGlory).kind).toBe('run');
    expect(wildDragonEscapeAction({ ...withGlory, player: { ...withGlory.player, worldZ: 3750 } }).kind).toBe('glory');
    const withTele = baseState({
        skills: [{ name: 'Hitpoints', level: 80 }, { name: 'Magic', level: 25 }],
        player: { worldX: 3092, worldZ: 3670, level: 0, combatLevel: 90 },
        inventory: [{ id: ITEMS.lawRune, name: 'Law rune', count: 1, slot: 0 }, { id: ITEMS.airRune, name: 'Air rune', count: 3, slot: 1 }, { id: ITEMS.fireRune, name: 'Fire rune', count: 1, slot: 2 }],
    });
    expect(wildDragonEscapeAction(withTele).kind).toBe('teleport');
    // Escape keep preserves food, glory(1..4), and staged tele runes while allowing unreserved law drops to bank.
    expect(wildDragonEscapeKeep({ id: ITEMS.glory[2] }, 0)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.airRune }, 0)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.fireRune }, 0)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.lawRune }, 1)).toBe(true);
    expect(wildDragonEscapeKeep({ id: ITEMS.lawRune }, 0)).toBe(false);
    expect(wildDragonEscapeKeep({ id: 536 }, 1)).toBe(false);
});

test('selectGreenDragon prefers a dragon targeting us, then nearest free reachable dragon', () => {
    const freeFar: any = { index: 1, id: GREEN_DRAGON_ID, distance: 8, hp: 75, reachable: true, inCombat: false, targetIndex: -1 };
    const freeNear: any = { index: 2, id: GREEN_DRAGON_ID, distance: 3, hp: 75, reachable: true, inCombat: false, targetIndex: -1 };
    const busyOther: any = { index: 3, id: GREEN_DRAGON_ID, distance: 1, hp: 75, reachable: true, inCombat: true, targetIndex: 32768 + 99 };
    const ours: any = { index: 4, id: GREEN_DRAGON_ID, distance: 5, hp: 75, reachable: true, inCombat: true, targetIndex: 32768 + 7 };
    expect(selectGreenDragon([freeFar, busyOther, freeNear], 7)?.index).toBe(2);
    expect(selectGreenDragon([freeFar, freeNear, ours], 7)?.index).toBe(4);
});
});

describe('microbot-combat-trip', () => {
test('every staged kit item exists in native pack and wield handlers have no quest gate',()=>{
 expect(validateCombatKit(BLUE_KIT)).toEqual([{skill:'Ranged',level:1}]);
 expect(validateCombatKit(KBD_KIT)).toEqual([{skill:'Attack',level:40},{skill:'Defence',level:40},{skill:'Defence',level:40}]);
 expect(()=>validateCombatKit([{id:4151,count:1,slot:3}])).toThrow('invalid native');
 expect(()=>validateCombatKit([{id:1127,native:'rune_platebody',count:1,slot:4}])).toThrow('unsupported');
 expect(()=>validateCombatKit([{id:838,native:'crossbow',count:1,slot:3}])).toThrow('invalid native');
});
test('finite combat kits reserve escape and refill from owned bank stock',()=>{
 const blue=combatKitTotals(BLUE_KIT),kbd=combatKitTotals(KBD_KIT);
 expect(blue[877]).toBe(500);expect(blue[1590]).toBe(1);expect(blue[385]).toBe(6);expect(kbd[385]).toBe(12);
 for(const kit of [blue,kbd]){expect(kit[563]).toBe(1);expect(kit[556]).toBe(3);expect(kit[554]).toBe(1);expect(kit[1540]).toBe(1);}
});
test('conservation rejects gear loss, missing dose containers and excess rune costs',()=>{
 const b={4151:1,2448:2,563:3,556:9,554:3},a={4151:1,2448:1,181:1,563:2,556:6,554:2},d={2448:-1,181:1,563:-1,556:-3,554:-1};
 expect(combatAssetIssues(b,a,d)).toEqual([]);
 expect(combatAssetIssues(b,{...a,4151:0},d).map(i=>i.id)).toContain(4151);
 expect(combatAssetIssues(b,{...a,181:0},d).map(i=>i.id)).toContain(181);
 expect(combatAssetIssues(b,{...a,563:1},d).map(i=>i.id)).toContain(563);
});
test('trip rejects unbounded limits before session access',async()=>{await expect(combatTrip({} as any,'kbd',async()=>({ok:true,failure:''}),{cap:Infinity,stop:()=>false})).rejects.toThrow('invalid');});

test('native high Wilderness pit exits by observed lever even after job stop',async()=>{
 let p={worldX:3067,worldZ:10253,level:0};const acts:number[]=[];
 expect(combatTeleportAllowed(p)).toBe(false);
 await leaveKbdEntrancePit({position:()=>p,locs:()=>[{id:1816,x:3067,z:10253,optionsWithIndex:[{text:'Pull',opIndex:1}]}],interact:async(_x,_z,id)=>{acts.push(id);p={worldX:2717,worldZ:9802,level:0};return true;},wait:async(test,ticks)=>{expect(ticks).toBe(20);return test();}});
 expect(acts).toEqual([1816]);expect(combatTeleportAllowed(p)).toBe(true);
});
test('unavailable pit lever falls back to observed climb-out, not blocked teleport',async()=>{
 let p={worldX:3069,worldZ:10255,level:0};const acts:number[]=[];
 await leaveKbdEntrancePit({position:()=>p,locs:()=>[{id:1766,x:3069,z:10256,optionsWithIndex:[{text:'Climb-up',opIndex:1}]}],interact:async(_x,_z,id)=>{acts.push(id);p={worldX:3017,worldZ:3849,level:0};return true;},wait:async test=>test()});
 expect(acts).toEqual([1766]);expect(combatTeleportAllowed(p)).toBe(false);
 expect(combatTeleportAllowed({worldX:3094,worldZ:3535,level:0})).toBe(true);
});


test('bank staging changes retaliation only after close and keeps fresh bank observations',async()=>{
 let stopped=false,withdrawals=0,dismissWhileBanked=0,gen=1;const clicks:number[]=[];
 const items=Object.entries(combatKitTotals(BLUE_KIT)).map(([id,count])=>({id:Number(id),count}));
 const current:any={player:{worldX:3185,worldZ:3436,level:0,lifeId:1,isDead:false},autoRetaliateEnabled:true,bank:{isOpen:true,items},prayers:{prayerLevel:99,prayerPoints:99,activePrayers:[]},nearbyLocs:[{id:2213,x:3186,z:3438,name:'Bank booth',distance:1,optionsWithIndex:[{text:'Bank',opIndex:1}]}]};
 let observation:any={generation:gen,items};
 const session:any={client:{},tick:()=>0,ended:new Promise(()=>{}),bankObservation:()=>observation,sdk:{getState:()=>current,getInventory:()=>[],getEquipment:()=>[],getSkill:()=>({level:99}),sendInteractLoc:async()=>{current.bank.isOpen=true;observation={generation:++gen,items};return{success:true};}},bot:{dismissBlockingUI:async()=>{if(current.bank.isOpen){dismissWhileBanked++;observation=null;}return{success:true};},closeBank:async()=>{current.bank.isOpen=false;observation=null;return{success:true};},withdrawItem:async()=>{withdrawals++;return{success:true};}},direct:async(action:any)=>{if(current.bank.isOpen)throw Error('combat component closes a valid bank observation');clicks.push(action.componentId);current.autoRetaliateEnabled=action.componentId===150;if(action.componentId===151)stopped=true;return{success:true};}};
 const result=await combatTrip(session,'blue',async()=>{throw Error('stopped actor must not fight');},{cap:100,stop:()=>stopped});
 expect(result.ok).toBe(false);expect(result.banked).toBe(true);expect(result.assets).toEqual([]);
 expect(withdrawals).toBe(0);expect(dismissWhileBanked).toBe(0);expect(clicks).toEqual([151,150]);expect(current.autoRetaliateEnabled).toBe(true);
});

test('extracted Blue entry preserves exact waypoints, key transition predicate and settle boundary',async()=>{const{blueDungeonEntry}=await import('../src/combat');let p={worldX:0,worldZ:0,level:0};const trace:any[]=[];await blueDungeonEntry({position:()=>p,walk:async(x,z)=>{trace.push([x,z]);p={...p,worldX:x,worldZ:z};},interact:async(id,x,z,arrived,key)=>{trace.push({id,x,z,key});expect(arrived()).toBe(false);p={...p,worldX:id===1759?2884:2923,worldZ:id===1759?9797:9803};expect(arrived()).toBe(true);},settle:async()=>{trace.push('settle3');}});expect(trace).toEqual([[2884,3397],{id:1759,x:2884,z:3397,key:undefined},[2886,9817],[2889,9831],[2910,9830],[2924,9803],{id:2623,x:2924,z:9803,key:1590},'settle3',[2904,9803],[2895,9792]]);});
});

describe('microbot-b-kbd', () => {
const state=()=>({player:{worldX:2717,worldZ:9802,level:0,lifeId:1},inventory:[{id:385,count:6},{id:2448,count:1},{id:2452,count:1},{id:2436,count:1},{id:2440,count:1},{id:2434,count:2},{id:563,count:1},{id:556,count:3},{id:554,count:1}],equipment:[{id:1540,slot:5},{id:1289,slot:3},{id:1113,slot:4},{id:1079,slot:7}],skills:[{name:'Hitpoints',level:80,baseLevel:80},{name:'Magic',level:25},{name:'Attack',level:70,experience:0},{name:'Defence',level:70,experience:0}],prayers:{prayerLevel:43,prayerPoints:80,activePrayers:[]},nearbyPlayers:[],nearbyNpcs:[{id:50,index:1,hp:240,maxHp:240,inCombat:false}]} as unknown as BotWorldState);
test('KBD staged prerequisites use exact shield, supplies and free dragon',()=>{
 const s=state();expect(inKbdLair(s)).toBe(true);expect(kbdEntryFailure(s)).toBeNull();
 s.equipment[0]!.id=1541;expect(kbdEntryFailure(s)).toContain('shield');
 s.equipment[0]!.id=1540;s.nearbyNpcs[0]!.hp=null;s.nearbyNpcs[0]!.maxHp=null;expect(kbdEntryFailure(s)).toBeNull();
 s.nearbyNpcs[0]!.hp=200;s.nearbyNpcs[0]!.maxHp=240;expect(kbdEntryFailure(s)).toContain('known damage');
 s.nearbyNpcs[0]!.hp=240;s.inventory=s.inventory.filter(i=>i.id!==563);expect(kbdEntryFailure(s)).toContain('runes');
});
test('KBD kill requires own XP, disappearance and both exact guaranteed drops',()=>{
 expect(kbdKillCredit(true,960,[1,1])).toBe(true);
 expect(kbdKillCredit(false,960,[1,1])).toBe(false);
 expect(kbdKillCredit(true,0,[1,1])).toBe(false);expect(kbdKillCredit(true,959,[1,1])).toBe(false);
 expect(kbdKillCredit(true,960,[0,1])).toBe(false);
 expect(kbdKillCredit(true,960,[2,1])).toBe(false);
});
test('KBD retreat thresholds protect cleanup margin and bounded immunity window',()=>{
 const s=state();expect(kbdRetreatReason(s,1,300)).toBeNull();
 expect(kbdRetreatReason(s,300,300)).toBe('combat cap');
 s.skills[0]!.level=34;expect(kbdRetreatReason(s,1,300)).toBe('low HP');
 s.skills[0]!.level=80;s.prayers.prayerPoints=9;expect(kbdRetreatReason(s,1,300)).toBe('low prayer');
});
function simulation(extraDrops:number[]=[],interrupt=false,missUntil=0){
 let current=state(),tick=0,busyUntil=0;const actions:string[]=[];
 current.groundItems=[];current.skills.find(k=>k.name==='Attack')!.experience=1000;current.skills.forEach(k=>k.experience??=0);
 current.inventory=current.inventory.map((i,slot)=>({...i,slot,optionsWithIndex:[{text:'Drink',opIndex:1}]}));
 current.nearbyNpcs[0]={...current.nearbyNpcs[0]!,x:2720,z:9805,tileX:2720,tileZ:9805,optionsWithIndex:[{text:'Attack',opIndex:2}]} as any;
 const change=(f:(s:BotWorldState)=>void)=>{current=structuredClone(current);f(current);};
 const s={tick:()=>tick,ended:new Promise(()=>{}),client:{objType:()=>({cost:1,stackable:false})},sdk:{sendPickup:async(x:number,z:number,id:number)=>{change(v=>{const item=v.groundItems.find(i=>i.id===id)!;v.inventory.push({...item,slot:v.inventory.length,optionsWithIndex:[]});v.groundItems=v.groundItems.filter(i=>i.id!==id);});return{success:true};},getState:()=>current,sendSetCombatStyle:async()=>{change(v=>{v.combatStyle={known:true,currentStyle:0,weaponName:'Rune sword',styles:[{index:0,damageType:'Stab',trainsSkills:['Attack']}]} as any;});return{success:true};},sendCloseModal:async()=>({success:true}),sendTogglePrayer:async()=>{change(v=>{v.prayers.activePrayers[14]=!v.prayers.activePrayers[14];});return{success:true};},sendInteractNpc:async()=>{actions.push('attack');return{success:true};}},direct:async(a:any)=>{
  if(a.type==='useInventoryItem'){if(tick<busyUntil)return{success:false};busyUntil=tick+3;change(v=>{const i=v.inventory.find(i=>i.slot===a.slot)!;const next:Record<number,number>={2448:181,2452:2454,2436:145,2440:157,2434:139,139:141,141:143,143:229,181:183,183:185,185:229,2454:2456,2456:2458,2458:229};if([2434,139,141,143].includes(i.id))v.prayers.prayerPoints+=25;i.id=next[i.id]!;});actions.push('potion');}
  else if(a.type==='clickComponent'){change(v=>{v.player!.worldX=3213;v.player!.worldZ=3424;v.inventory.find(i=>i.id===563)!.count--;});actions.push('teleport');}
  return{success:true};
 },bot:{pickupItem:async(item:any)=>{change(v=>{v.inventory.push({...item,slot:v.inventory.length,optionsWithIndex:[]});v.groundItems=v.groundItems.filter(i=>i.id!==item.id);});return{success:true};}}} as unknown as Session;
 return{s,actions,step:async()=>{tick++;if(missUntil&&actions.includes('attack')&&tick<missUntil){change(v=>{v.combatEvents=[{tick,type:'damage_dealt',damage:0,sourceType:'player',sourceIndex:-1,targetType:'npc',targetIndex:1}];});return;}if(interrupt&&actions.filter(a=>a==='attack').length===1){change(v=>{v.player!.combat={targetIndex:-1} as any;});return;}if(actions.includes('attack')&&current.nearbyNpcs.length)change(v=>{v.nearbyNpcs=[];v.skills.find(k=>k.name==='Attack')!.experience+=960;v.groundItems=[536,1747,...extraDrops].map(id=>({id,name:'drop',count:1,x:2720,z:9805,distance:1}));});},wait:async(test:()=>boolean)=>test(),set:change};
}
test('staged KBD respects native post-transform potion delay, collects and teleports',async()=>{
 const d=simulation();const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.credited).toBe(true);expect(r.looted).toBe(2);expect(r.escaped).toBe(true);expect(d.actions).toEqual(['potion','potion','potion','potion','attack','teleport']);
});
test('stop after admission still attempts bounded Varrock cleanup without attacking',async()=>{
 const d=simulation();const r=await runKbdOne(d.s,{cap:300,stop:()=>true,step:d.step,wait:d.wait});
 expect(r.ok).toBe(false);expect(r.escaped).toBe(true);expect(r.attacked).toBe(false);expect(d.actions).toEqual(['teleport']);
});

test('native KBD admission rejects foreign ownership and unsupported staged kit',()=>{
 const s=state();s.nearbyNpcs[0]!.inCombat=true;s.nearbyNpcs[0]!.targetIndex=32769;expect(selectKbdTarget(s,1)).toBeDefined();expect(selectKbdTarget(s,2)).toBeUndefined();
 s.nearbyNpcs[0]!.inCombat=false;s.equipment[1]!.id=4151;expect(kbdEntryFailure(s)).toContain('rune sword');s.equipment[1]!.id=1289;s.equipment[2]!.id=1127;expect(kbdEntryFailure(s)).toContain('chainbody');
});

test('KBD collects attributed rare loot with guaranteed drops',async()=>{
 const d=simulation([1149]);const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.drops).toEqual({536:1,1747:1,1149:1});
});

test('KBD resumes its owned living target after the attack action clears',async()=>{
 const d=simulation([],true);const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(d.actions.filter(a=>a==='attack').length).toBe(2);
});

test('observed zero-damage swings keep a bounded fight alive without granting kill credit',async()=>{
 const d=simulation([],false,130);const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.ticks).toBeGreaterThan(100);expect(r.credited).toBe(true);
});
});

describe('microbot-trawler-trip', () => {
test('native reward rows use owned component ids with one based item encoding',()=>{expect(trawlerCatchRows({linkObjType:Int32Array.from([0,390,392]),linkObjNumber:Int32Array.from([0,2,1])})).toEqual([{id:389,slot:1,count:2},{id:391,slot:2,count:1}]);expect(()=>trawlerCatchRows(undefined)).toThrow('owned');});

test('trip bank audit requires every owned reward and only declared repair costs',()=>{
 const initial=new Map([[1941,100],[954,10],[583,1],[995,1000]]),rewards={389:2,391:1};
 const final={1941:80,954:8,583:1,995:1000,389:2,391:1};
 expect(trawlerAssetsReconcile(initial,final,rewards,20,2)).toBe(true);
 expect(trawlerAssetsReconcile(initial,{...final,389:0},rewards,20,2)).toBe(false);
 expect(trawlerAssetsReconcile(initial,{1941:80,954:8,583:1,995:1000},rewards,20,2)).toBe(false);
 expect(trawlerAssetsReconcile(initial,{...final,995:999},rewards,20,2)).toBe(false);
 expect(trawlerAssetsReconcile(initial,{...final,954:7},rewards,20,2)).toBe(false);
});

test('only the native rip dialog and flood form explain a cancelled pending action',()=>{
 const a={player:{worldX:1886,worldZ:4824,level:0},dialog:{isOpen:false,isWaiting:false,options:[]}} as unknown as BotWorldState;
 expect(trawlerInterruption(a,{...a,dialog:{isOpen:true,isWaiting:false,options:[{index:1,text:'Click here to continue',componentId:362,buttonType:6}],allComponents:[{id:360,type:4,buttonType:0,option:'',text:'The net has ripped!'}]}})).toBe('net-rip');
 expect(trawlerInterruption(a,{...a,player:{...a.player!,worldX:2014}})).toBe('flood-form');
 expect(trawlerInterruption(a,{...a,dialog:{isOpen:true,isWaiting:false,options:[],text:'Another modal'}})).toBeNull();
 expect(trawlerInterruption(a,a)).toBeNull();
});

test('net excursions leave active leaks and high water to the hold crew',()=>{
 expect(trawlerNetWindow(true,7,0)).toBe(true);
 expect(trawlerNetWindow(true,7,1)).toBe(false);
 expect(trawlerNetWindow(true,10,0)).toBe(true);
 expect(trawlerNetWindow(true,11,0)).toBe(false);
 expect(trawlerNetWindow(true,20,0)).toBe(false);
 expect(trawlerNetWindow(true,38,0)).toBe(false);
 expect(trawlerNetWindow(true,60,3)).toBe(false);
 expect(trawlerNetWindow(false,0,0)).toBe(false);
});
});

describe('microbot-b-trawler', () => {
const state=(id=954,n=2,xp=100)=>({player:{worldX:1885,worldZ:4825,level:1,lifeId:1},inventory:[{id,count:n,slot:0,optionsWithIndex:[{text:'Bail-with',opIndex:1}]}],skills:[{name:'Crafting',level:50,experience:xp},{name:'Hitpoints',level:10}],nearbyLocs:[{id:2172,x:1880,z:4826,level:1,distance:1,optionsWithIndex:[{text:'Inspect',opIndex:1}]}],gameMessages:[]} as unknown as BotWorldState);
test('native support effects require exact supply debit and XP only for net',()=>{
 expect(insideLegacyTrawler(state())).toBe(true);expect(trawlerEffect(state(),state(),'net')).toBe(false);
 expect(trawlerEffect(state(),state(954,1,105),'net')).toBe(true);
 expect(()=>trawlerEffect(state(),state(954,1,100),'net')).toThrow('reconcile');
 expect(trawlerEffect(state(583,1),state(585,1),'bail','fill')).toBe(true);
 expect(trawlerEffect(state(585,1),state(583,1),'bail','empty')).toBe(true);
 expect(trawlerEffect(state(1941,10),state(1941,9),'leak')).toBe(true);
});
test('finite net support distinguishes fresh failed RNG roll and successful own repair',async()=>{
 let current=state(),tick=0,actions=0;
 const d:TrawlerDriver={state:()=>current,tick:()=>tick,stop:()=>false,item:async()=>true,object:async()=>{actions++;if(actions===1){current=structuredClone(current);current.gameMessages.push({type:0,text:'You fail to repair the net in the harsh conditions.',tick:1,observationId:1} as any);}else current=state(954,1,105);return true;},wait:async p=>p(),step:async()=>{tick++;}};
 expect(await runTrawlerSupport(d,{mode:'net',maximum:1,cap:50,maxAttempts:2})).toEqual({mode:'net',completed:1,attempts:2,ticks:1});
});
test('bailing cycles finish with same empty bucket and no XP claim',async()=>{
 let current=state(583,1),tick=0;
 current.player!.worldX=2017;current.player!.level=0;
 const d:TrawlerDriver={state:()=>current,tick:()=>tick,stop:()=>false,object:async()=>true,item:async()=>{current=structuredClone(current);const item=current.inventory[0]!;item.id=item.id===583?585:583;item.optionsWithIndex=[{text:item.id===583?'Bail-with':'Empty',opIndex:1}];return true;},wait:async p=>p(),step:async()=>{tick++;}};
 expect((await runTrawlerSupport(d,{mode:'bail',maximum:2,cap:50,maxAttempts:2})).completed).toBe(2);expect(current.inventory[0]!.id).toBe(583);
});
});

