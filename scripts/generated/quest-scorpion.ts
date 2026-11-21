// PROOF 3/3 on practice: 937, 910, 942 ticks; the dusty key chain is in the run, research/quest-plan.md 1o.
// Scorpion Catcher from preset quest_scorpion (beside Thormac, top of the Sorcerer's Tower), at the planner's state
// for the scorpion row (tick 53,715, every skill 99). Reward: 66,250 Strength (x25: 165,625), 1 QP
// (quest_scorpcatcher.rs2:55-60). Paths below are under vendor/rs-sdk/server/content/scripts/.
// Varp %scorpcatcher (76): 1 Thormac gives the cage (areas/area_seers/scripts/thormac.rs2:47-56); 2 a Seer's looking
// glass (areas/area_seers/scripts/seer.rs2:56-68), which the Taverley dungeon secret wall needs
// (quest_scorpcatcher.rs2:45-53). The three cage catches have no stage check (quest_scorpcatcher.rs2:14-39): scorpion
// A behind the wall (2877,9796), B in the Barbarian Outpost (2552,3570), C upstairs in the Monastery (3058,3488,1),
// whose ladder needs the order (Prayer 31, areas/monastery/scripts/prayer_guild.rs2:5-40). Peksa and the Seer's
// later hints are not needed. Thormac with the full cage queues the completion.
import { openQuest, fightForDrop } from './quest-lib';
import { componentId } from '../../packages/core/src/logout';
import { establishBarcrawlGate, runBarcrawl } from './quest-barcrawl';
import { waitUntil } from '../../packages/core/src/ticks';

const THORMAC = { x: 2702, z: 3405 };
const SEER = { x: 2702, z: 3475 };
const SCORP_B = { x: 2552, z: 3570 };
const TAV_LADDER = { x: 2884, z: 3397 };                    // ladder_cellar_inside_down (1759), maps/m45_53.jm2
const WALL = { id: 2117, x: 2875, z: 9799 };                 // scorpionwall, south wall of the tile
const SCORP_A = { x: 2877, z: 9796 };
const ABBOT = { x: 3058, z: 3484 };
const MON_LADDER = { x: 3057, z: 3483 };                     // monasteryladder (2641)
const SCORP_C = { x: 3058, z: 3488 };
// Sorcerer's Tower ladders (maps/m42_53.jm2): 0 -> 1 at 2701,3408; 1 -> 2 at 2704,3403; 2 -> 3 at 2699,3405.
const TOWER = [{ x: 2701, z: 3408 }, { x: 2704, z: 3403 }, { x: 2699, z: 3405 }];
const CAGE = { empty: 456, a: 457, ab: 458, ac: 459, b: 460, bc: 461, c: 462, full: 463 };
const CAGES = Object.values(CAGE);
const NPC = { a: 385, b: 386, c: 387, jailer: 201 };
const ITEM = { jailKey: 1591, dusty: 1590 };
const JAILER = { x: 2933, z: 9693 };                         // spawn, maps/m45_151.jm2
const JAIL_DOOR = { id: 2631, x: 2931, z: 9690 };            // Velrak's cell door, south wall of the tile
const VELRAK = { x: 2931, z: 9685 };
const GATE = { id: 2623, x: 2924, z: 9803 };                 // deepdungeondoor, west wall of the tile, maps/m45_153.jm2

// anti_poison.rs2 grants protection even without poison and replaces the bottle in its original inventory slot.
const ANTIPOISON_NEXT: Readonly<Record<number, number>> = {2448:181,181:183,183:185,185:229,2446:175,175:177,177:179,179:229};
type PoisonIO = {
    onTick(cb:()=>void):()=>void;
    poisoned():number;
    inventory():readonly {id:number;slot:number;count:number}[];
    use(slot:number):Promise<unknown>;
    wait(ok:()=>boolean,ticks:number):Promise<boolean>;
    log(row:{item:number;next:number;slot:number;observed:boolean}):void;
};
export function watchScorpionPoison(io:PoisonIO) {
    let seen=0,stopped=false,failure:string|undefined,pending:Promise<void>|undefined;
    const cure=async()=>{
        const pot=io.inventory().find(i=>i.count>0&&ANTIPOISON_NEXT[i.id]!==undefined);
        if(!pot)throw Error('Scorpion missing usable antipoison dose');
        const next=ANTIPOISON_NEXT[pot.id]!;
        const changed=()=>io.inventory().some(i=>i.slot===pot.slot&&i.id===next&&i.count===pot.count);
        for(let attempt=0;attempt<3&&!stopped;attempt++){
            // A dropped click can repeat only while this same bottle remains in its observed slot.
            if(!io.inventory().some(i=>i.slot===pot.slot&&i.id===pot.id&&i.count===pot.count))break;
            await io.use(pot.slot);
            if(await io.wait(changed,5)){
                io.log({item:pot.id,next,slot:pot.slot,observed:true});return;
            }
        }
        throw Error(`Scorpion antipoison dose change unobserved ${pot.id}->${next}`);
    };
    const dose=()=>{
        if(!stopped&&!failure&&!pending)pending=cure().catch(error=>{failure=String(error);}).finally(()=>{pending=undefined;});
        return pending;
    };
    const off=io.onTick(()=>{
        if(stopped||failure||pending||io.poisoned()<=seen)return;
        seen=io.poisoned();
        void dose();
    });
    return {protect:async()=>{await dose();if(failure)throw Error(failure);},failure:()=>failure,pending:async()=>{await pending;},stop:async()=>{stopped=true;off();await pending;}};
}

type CatchQuest = Pick<Awaited<ReturnType<typeof openQuest>>, 'st' | 'has' | 'waitUntil' | 'walk' | 'dash' | 'step' | 'useOnNpc' | 'waitTicks' | 'milestone' | 'findLoc' | 'opLoc' | 'opIndex'>;

export async function catchScorpion(q: CatchQuest, k: 'a' | 'b' | 'c', at: { x: number; z: number }): Promise<void> {
    const cage = (): number | undefined => CAGES.find(id => q.has(id));
    const caught = (): boolean => {
        const c = cage();
        if (c === CAGE.full) return true;
        if (k === 'a') return c === CAGE.a || c === CAGE.ab || c === CAGE.ac;
        if (k === 'b') return c === CAGE.b || c === CAGE.ab || c === CAGE.bc;
        return c === CAGE.c || c === CAGE.ac || c === CAGE.bc;
    };
    const npc = (): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === NPC[k]).sort((a: any, b: any) => a.distance - b.distance)[0];
    if (!npc()) await q.waitUntil(() => !!npc(), 10);
    if (!npc()) await q.walk(`to scorpion ${k}`, [{ x: at.x, z: at.z, tol: 3 }]);
    await q.step(`catch ${k}`, async () => {
        if (k === 'c' && (!npc() || npc().reachable === false)) {
            // maps/m47_54.jm2: the clear aisle is north of the rotated bedroom door.
            await q.dash('scorpion c bedroom aisle', SCORP_C.x, SCORP_C.z, 0, 8);
            const n = npc();
            // At 3059,3486, bigtable2 blocks the north face. The open door blocks the west face.
            // Close it from inside the room to release that face (doors/scripts/door_procs.rs2).
            if (n?.reachable === false && n.x === 3059 && n.z === 3486) {
                const opened = () => q.findLoc(l => l.id === 1531 && l.x === 3058 && l.z === 3486 && (l.optionsWithIndex ?? []).some((o: any) => /^close$/i.test(o.text)));
                if (opened()) await q.step('scorpion c bedroom door close', () => {
                    const d = opened();
                    return d ? q.opLoc(d, q.opIndex(d, /^close$/i)) : q.waitTicks(1);
                }, () => !!q.findLoc(l => l.id === 1530 && l.x === 3058 && l.z === 3485 && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text))), 8, 2);
            }
            await q.waitUntil(() => { const fresh = npc(); return !!fresh && fresh.reachable !== false; }, 5);
        }
        // Re-read both the NPC and cage after movement or a door change.
        const n = npc(), c = cage();
        return n && c && (k !== 'c' || n.reachable !== false) ? q.useOnNpc(c, n) : q.waitTicks(1);
    }, caught, 15, 5);
    q.milestone(`scorpion ${k}`);
}

if (import.meta.main || (globalThis as { QUEST_SESSION?: unknown }).QUEST_SESSION) {
// The eater handles wounds. Antipoison cures the dungeon's poison, which Protect from Melee cannot prevent.
let poison:ReturnType<typeof watchScorpionPoison>|undefined;
const q = await openQuest({ cap: Number(process.env.CAP ?? 2500), eatAt: 50, lumbridgeOk: false, stop:()=>!!poison?.failure(), burst: true });
poison=watchScorpionPoison({
    onTick:cb=>q.s.onTick(cb),poisoned:()=>q.msgCount(/you have been poisoned/i),inventory:()=>q.st()?.inventory??[],
    use:slot=>q.s.direct({type:'useInventoryItem',slot,optionIndex:1,reason:'SDK'}),
    wait:(ok,ticks)=>waitUntil(q.s,ok,{timeoutTicks:ticks}),log:row=>console.log(`SCORP_ANTIPOISON ${JSON.stringify(row)}`),
});
void q.s.ended.then(()=>poison!.stop());
try {
    if(!q.st()?.inventory?.some((i:any)=>i.count>0&&ANTIPOISON_NEXT[i.id]!==undefined))throw Error('Scorpion missing usable antipoison dose');
    const FROM = Number(process.env.SC_FROM ?? 0);   // 2: debug preset quest_scorpion_s2 (outside the outpost, stage 2, empty cage); 3: quest_scorpion_s3 (Taverley dungeon ladder, cage with B)
    let questDone = false;
    const offDone = q.s.onTick(() => { if (q.msgCount(/quest complete|completed the\s+scorpion catcher/i) > 0) questDone = true; });
    const npcId = (id: number): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const catchScorp = (k: 'a' | 'b' | 'c', at: { x: number; z: number }) => catchScorpion(q, k, at);
    const ladderAt = (at: { x: number; z: number }, re: RegExp) => () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));

    if (FROM < 2) {
        // 1. Thormac: "What do you need assistance with?", "What's in it for me?", "Ok, I will do it then." (the cage
        // comes with the start; the "how would I catch them" branch adds a 4-tick delay, thormac.rs2:29-38).
        await q.talk('thormac 1', /^thormac$/i, [/what do you need assistance/i, /what's in it for me/i, /ok, i will do it/i], () => q.has(CAGE.empty), THORMAC, 40);
        q.milestone(1);

        // Down the tower.
        for (let lv = 3; lv >= 1; lv--) {
            const at = TOWER[lv - 1]!;
            await q.climb(`tower down ${lv}`, ladderAt(at, /climb-down/i), /climb-down/i, () => q.lvl() === lv - 1);
        }

        // 2. A Seer: "I need to locate some scorpions."; the looking glass sets stage 2.
        // Four Seers spawn (2702,3475; 2714,3471; 2716,3485; 2705,3473 upstairs). The nearest can be the upstairs one, which
        // a Talk-to cannot reach (first test run), so the bot talks to the nearest with reachable set.
        await q.walk('to seer', [{ x: SEER.x, z: SEER.z - 2, tol: 4 }]);
        const seers = (): any[] => (q.st()?.nearbyNpcs ?? []).filter((n: any) => /^seer$/i.test(n.name)).sort((a: any, b: any) => a.distance - b.distance);
        console.log(`NOTE seers: ${seers().map((n: any) => `${n.x},${n.z} d=${n.distance} r=${n.reachable}`).join('; ')}`);
        for (let i = 0; i < 3 && !q.sawText(/try and get you some information on the others/i); i++) {
            await q.guard('seer');
            let n = seers().find((x: any) => x.reachable !== false);
            // All in shut houses: walkPath to the nearest one opens its door.
            if (!n && seers()[0]) { const t = seers()[0]; await q.walk('to seer house', [{ x: t.x, z: t.z, tol: 1 }]); n = seers()[0]; }
            if (!n) await q.fail('no seer');
            await q.talkTo(n);
            await q.waitUntil(() => q.dialogOpen(), 25);
            await q.converse([/i need to locate some scorpions/i], () => q.sawText(/try and get you some information on the others/i) && !q.dialogOpen(), 60);
        }
        if (!q.sawText(/try and get you some information on the others/i)) await q.fail('seer');
        q.milestone(2);
    }

    // B: the Barbarian Outpost. The gate (barbariangater/l, east wall of 2545,3569-3570, maps/m39_55.jm2) opens once
    // %barcrawl (77) is 2, Alfred Grimhand's Barcrawl (scripts/generated/quest-barcrawl.ts, the barcrawl row); before
    // that a Barbarian guard within 5 tiles talks instead (areas/area_barbarian_outpost/scripts/outpost_gate.rs2:1-5).
    // The gate moves the bot through (outpost_gate.rs2:7-11).
    // The yard between the gate and the hut door 2551,3569-3570. The land east of the hut is also x >= 2546, and it has no way in.
    const inOutpost = () => { const x = q.pos()?.worldX ?? 0; return x >= 2546 && x <= 2552; };
    if (FROM < 3) {
        if (!inOutpost()) {
            await q.walk('to outpost gate', [{ x: 2544, z: 3569, tol: 1 }]);
            // The gate takes the player through, or the guard talks (Barcrawl not done). The guard's talk stays open
            // for the Barcrawl, whose first step is that talk.
            const tryGate = async (): Promise<boolean> => {
                for (let i = 0; i < 4 && !inOutpost() && !q.dialogOpen(); i++) {
                    const g = q.findLoc(l => /gate/i.test(l.name) && l.x === 2545 && (l.z === 3569 || l.z === 3570) && (l.optionsWithIndex ?? []).length > 0);
                    if (g) await q.opLoc(g, 1);
                    await q.waitUntil(() => inOutpost() || q.dialogOpen(), 8);
                }
                return inOutpost();
            };
            await establishBarcrawlGate(tryGate, async () => { await runBarcrawl(q); });
        }
        await q.openDoor('hut door', 2551, 3570);
        await q.openDoor('hut door 2', 2551, 3569);
        await q.dash('to scorpion b', SCORP_B.x, SCORP_B.z, 3, 12);
        await catchScorp('b', SCORP_B);
        // Out by the same gate: the world router holds it shut (its opening is Barcrawl's, which the client cannot see),
        // so a walk planned from inside the yard finds no way out.
        await q.openDoor('hut door out', 2551, 3570);
        await q.dash('to outpost gate inside', 2546, 3569, 1, 12);
        await q.step('outpost gate out', () => { const g = q.findLoc(l => /gate/i.test(l.name) && l.x === 2545 && (l.z === 3569 || l.z === 3570) && (l.optionsWithIndex ?? []).length > 0); return g ? q.opLoc(g, 1) : q.waitTicks(1); }, () => !inOutpost(), 8, 4);
    }

    // Protect from Melee (sdk PRAYER_INDICES 14): the dungeon's poison scorpions and the black demons (level 172, aggressive
    // to every player) beside the wall corridor all hit with melee.
    const PFM = 14, prayers = (): any => q.st()?.prayers, pfmOn = (): boolean => !!prayers()?.activePrayers?.[PFM], points = (): number => prayers()?.prayerPoints ?? 0;
    const setPfm = async (on: boolean): Promise<void> => {
        if (pfmOn() === on || (on && points() <= 0)) return;
        await q.step(`protect from melee ${on ? 'on' : 'off'}`, () => q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }), () => pfmOn() === on, 3, 3);
    };
    // A: Falador Teleport, the Taverley dungeon ladder, the dusty key, the secret wall.
    if (FROM < 3) {
        await q.teleport('falador teleport 1', 'magic:falador_teleport', 2965, 3378);
        await q.walk('to taverley ladder', [{ x: TAV_LADDER.x, z: TAV_LADDER.z + 1, tol: 1 }]);
    }
    // Protect before the descent or, for SC_FROM=3, before leaving the dungeon landing.
    await poison.protect();
    if (FROM < 3) {
        await q.climb('taverley ladder', ladderAt(TAV_LADDER, /climb-down/i), /climb-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
    }
    // Poison scorpions roam the dungeon between the ladder and the jail and their sting poisons for hundreds of ticks; the
    // black demons beside the wall corridor hit for most of a ranger's hitpoints. Protect from Melee drains a point every
    // five ticks, so Prayer 74 buys 370 ticks of cover for a dungeon pass of over 700: the prayer is held only while a
    // scorpion or demon stands within seven tiles (released once none is within ten) and the points last.
    let praying = false;
    const threatWithin = (r: number): boolean => (q.st()?.nearbyNpcs ?? []).some((n: any) => /demon|scorpion/i.test(n.name ?? '') && n.distance <= r);
    const releasePrayer = q.s.onTick(() => {
        if (praying || (q.pos()?.worldZ ?? 0) < 9000) return;
        const want = pfmOn() ? threatWithin(10) : threatWithin(7) && points() > 0;
        if (want === pfmOn()) return;
        praying = true;
        q.s.direct({ type: 'togglePrayer', prayerIndex: PFM, reason: 'SDK' }).catch(() => undefined).finally(() => { praying = false; });
    });
    // The corridor north of the secret wall is walled off from the ladder (wall on x 2880/2881); the only way in is
    // the dusty key gate (deepdungeondoor 2623, west wall of 2924,9803). From its east side it gives "This gate is
    // locked." (areas/area_taverly/dungeon/scripts/jail_doors.rs2:31, test run t5) unless the dusty key is used on
    // it. Velrak gives the dusty key (untradeable) once his cell door (dungeonjail 2631, south wall of 2931,9690) is
    // opened with the jail key, which the Jailer always drops (drop tables/scripts/jailer.rs2:10, 100 ticks on the
    // ground). The corridor side of a door is "entering" (doors/scripts/door_procs.rs2:77-88): only that side needs
    // the key; the door moves the player through (open_and_close_doors.rs2:43-62).
    q.blockDoor(0, GATE.x, GATE.z);
    const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
    const pickup = (g: any) => q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' });
    if (!q.has(ITEM.dusty)) {
        await q.walk('to jailer', [{ x: JAILER.x - 3, z: JAILER.z - 1, tol: 3 }]);
        // The Jailer (level 47, 47 hitpoints) dies to the kit the account fights with: a low-Attack ranger's bow or a
        // mage's strikes (the sweep brings the bow and QUEST_ARROWS, or the staff and QUEST_CASTS), or a melee account's
        // weapon. fightForDrop chooses the usable method each tick: an empty quiver turns the fight to the strike runes.
        const skill = (name: string): number => q.st()?.skills?.find((k: any) => k.name === name)?.baseLevel ?? 1;
        const worn = (): any[] => q.s.sdk.getEquipment();
        const jailer = await fightForDrop({
            tick: () => q.s.tick(), worn, pack: () => q.st()?.inventory ?? [], ranged: () => skill('Ranged'), magic: () => skill('Magic'),
            target: () => npcId(NPC.jailer), engaged: n => q.pos()?.targetIndex === n.index,
            drop: () => ground(ITEM.jailKey), held: () => q.has(ITEM.jailKey),
            equip: async item => {
                const equipped = await q.s.bot.equipItem(item as any);
                if (!equipped.success) throw Error(`jailer equip ${item.id} rejected: ${equipped.message ?? 'equip failed'}`);
                if (!await q.waitUntil(() => worn().some((i: any) => i.id === item.id && i.count > 0), 5)) throw Error(`jailer equipment not observed: ${item.id}`);
            },
            attack: async n => { await q.s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: (n as any).optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' }); },
            cast: async (n, component) => { await q.s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: componentId(component), reason: 'SDK' }); },
            pickup: async g => { await pickup(g); },
            wait: async () => { await q.guard('jailer'); await q.waitTicks(1); },
        }, 150);
        console.log(`SCORP_JAILER ${JSON.stringify(jailer)}`);
        if (!jailer.ok || !q.has(ITEM.jailKey)) await q.fail(`jail key: ${jailer.detail ?? 'not held'}`);
        q.milestone('jail key');
        const inCell = () => (q.pos()?.worldZ ?? 9999) < JAIL_DOOR.z;
        await q.step('cell door', () => q.useOnLoc(ITEM.jailKey, JAIL_DOOR), inCell, 15, 4);
        await q.talk('velrak', /^velrak/i, [/know anywhere good to explore/i, /yes please/i], () => q.has(ITEM.dusty), VELRAK, 40);
        q.milestone('dusty key');
        await q.step('leave cell', () => q.opLoc(JAIL_DOOR, 1), () => !inCell(), 15, 4);
    }
    const pastGate = () => (q.pos()?.worldX ?? 0) < GATE.x && Math.abs((q.pos()?.worldZ ?? 0) - GATE.z) < 30;
    await q.walk('to dusty gate', [{ x: GATE.x + 1, z: GATE.z, tol: 1 }]);
    await q.step('dusty gate', () => q.useOnLoc(ITEM.dusty, GATE), pastGate, 15, 4);
    q.milestone('gate');
    // Black Demon spawns near 2860,9776 close the only corridor (x 2877-2879, z 9769-9788) to the danger guard
    // (packages/core/src/danger.ts), so planned walks pace in the dragon room. Client-routed clicks do not use that guard.
    await q.dash('to south cave', 2894, 9776, 2, 30);
    await q.dash('to wall corridor', 2877, 9788, 2, 34);
    await q.dash('to wall', WALL.x, WALL.z, 1, 24);
    await q.step('secret wall', () => q.opLoc(WALL, 1), () => (q.pos()?.worldZ ?? 9999) < WALL.z, 10, 4);
    await catchScorp('a', SCORP_A);
    // With the runes and the level, the Falador teleport is cast in the cave right after scorpion A: the walk back to
    // the ladder took about 150 ticks. An account that cannot cast it walks out as before.
    if (!q.canCast('magic:falador_teleport')) {
        // Back out the way in: the router holds the dusty gate shut (q.blockDoor), so a Magic 1 account's walk to Falador
        // starts above ground. The gate's west side is the leaving side and opens without the key (door_procs.rs2:77-88).
        await q.step('secret wall back', () => q.opLoc(WALL, 1), () => (q.pos()?.worldZ ?? 0) >= WALL.z, 10, 4);
        await q.dash('to wall corridor back', 2877, 9788, 2, 24);
        await q.dash('to south cave back', 2894, 9776, 2, 34);
        await q.walk('to dusty gate inside', [{ x: GATE.x - 1, z: GATE.z, tol: 1 }]);
        await q.step('dusty gate out', () => q.opLoc(GATE, 1), () => !pastGate(), 15, 4);
        // The way back to the ladder is the way in from it, leg by leg: the room west of the east corridor (x 2922-2934,
        // z 9756-9763), the corridor's north-east bend (2951,9793), the north passage (2937,9825), then the landing. Each
        // leg is short enough that the planner's shortest route is the way in; from the bend a one-leg route to the landing
        // runs back through the dusty gate, which the door policy opens for a holder of the key and the client finds
        // locked, so its clicks beyond the gate are rejected. Protect from Melee blocks damage, but poison still needs a dose.
        const trace = (label: string) => (line: string) => console.log(`SCORP_WALK ${label}: ${line}`);
        for (const leg of [
            { label: 'to east corridor', to: { x: 2936, z: 9777, tol: 2 } },
            { label: 'to north-east bend', to: { x: 2951, z: 9793, tol: 2 } },
            { label: 'to north passage', to: { x: 2937, z: 9825, tol: 2 } },
            { label: 'to dungeon ladder', to: { x: TAV_LADDER.x + 1, z: TAV_LADDER.z + 6400, tol: 1 } },
        ]) await q.walk(leg.label, [leg.to], trace(leg.label));
        await q.climb('dungeon ladder up', ladderAt({ x: TAV_LADDER.x + 1, z: TAV_LADDER.z + 6400 }, /climb-up/i), /climb-up/i, () => (q.pos()?.worldZ ?? 9999) < 9000);
    }
    releasePrayer();
    await setPfm(false);

    // C: Falador Teleport, the Monastery; the ladder asks to join the order, then climbs.
    await q.teleport('falador teleport 2', 'magic:falador_teleport', 2965, 3378);
    await q.walk('to monastery', [{ x: MON_LADDER.x, z: MON_LADDER.z + 1, tol: 1 }]);
    for (let i = 0; i < 3 && q.lvl() !== 1; i++) {
        await q.guard('monastery ladder');
        const l = ladderAt(MON_LADDER, /climb-up/i)();
        if (l) await q.opLoc(l, q.opIndex(l, /climb-up/i));
        await q.waitUntil(() => q.dialogOpen() || q.lvl() === 1, 12);
        await q.converse([/well can i join your order/i], () => q.lvl() === 1 || (!q.dialogOpen() && q.sawText(/you may join/i)), 30);
    }
    if (q.lvl() !== 1) await q.fail('monastery upstairs');
    // Scorpion C is in the bedroom behind a door (loc_1530, north wall of 3058,3485, maps/m47_54.jm2); the client
    // finds no route to it while the door is shut (test run a1).
    await q.openDoor('bedroom door', 3058, 3485);
    await catchScorp('c', SCORP_C);
    if (!q.has(CAGE.full)) await q.fail('cage not full');

    // Camelot Teleport, up the tower, Thormac.
    await q.teleport('camelot teleport', 'magic:camelot_teleport', 2757, 3478);
    await q.walk('to tower', [{ x: TOWER[0]!.x, z: TOWER[0]!.z - 1, tol: 1 }]);
    for (let lv = 0; lv <= 2; lv++) {
        const at = TOWER[lv]!;
        if (lv > 0) await q.walk(`tower ${lv}`, [{ x: at.x, z: at.z, tol: 1 }]);
        await q.climb(`tower up ${lv}`, ladderAt(at, /climb-up/i), /climb-up/i, () => q.lvl() === lv + 1);
    }
    await q.talk('thormac 2', /^thormac$/i, [], () => questDone, THORMAC, 40);
    await q.waitUntil(() => questDone, 10);
    q.milestone('complete');
    offDone();
    await poison.stop();
    if(poison.failure())throw Error(poison.failure());
    await q.end(questDone, `qp=1 questMsg=${questDone}`);

} catch (e) { await poison.stop();await q.fail(poison.failure()??String(e)); }
}
