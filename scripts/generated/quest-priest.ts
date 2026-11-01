// The Restless Ghost from preset quest_priest (Lumbridge church beside Father Aereck; every skill 99; Lumbridge
// teleport runes from a helper). Reward: 1 QP, 1,125 Prayer XP before 25x (quest_priest.rs2:94-98).
// Varp %prieststart: 0 -> 1 Aereck, 2 Urhney (amulet of ghostspeak), 3 the ghost (amulet worn), 4 skull taken,
// 5 skull in the coffin (queued completion).
// Server truth: areas/area_lumbridge/scripts/father_aereck.rs2:40-50, father_urhney.rs2:30-57,
// quests/quest_priest/scripts/restless_ghost.rs2, quest_priest.rs2.
import { openQuest } from './quest-lib';
import {waitUntil} from '../../packages/core/src/ticks';
import {leaveGhostBasement} from '../ghost-basement-exit';
import {readSkullResume,validateSkullResume,SKULL_WAIT_TICKS} from '../ghost-skull-entry';

const AERECK = { x: 3244, z: 3206 };
const URHNEY = { x: 3235, z: 3153 };
const COFFIN = { x: 3249, z: 3192 };                      // shutghostcoffin 2145, open: restless_ghost_altar
const GHOST = { x: 3249, z: 3194 };                       // npc_add(0_50_49_49_58, ghostx)
const LADDER_TOP = { id: 2147, x: 3104, z: 3162 };
const LADDER_UP = { x: 3103, z: 9576 };
const SKULL_AT = { x: 3120, z: 9567 };                    // obj 553 in maps/m48_149.jm2 (0 48 31)
const ITEM = { amulet: 552, skull: 553 };

const q = await openQuest({ cap: 1500, lumbridgeOk: true });
try {
    let questDone = false;
    const off = q.s.onTick(() => { if (q.msgCount(/quest complete/i) > 0) questDone = true; });
    const inBasement = () => (q.pos()?.worldZ ?? 0) > 9000;
    const ghostState = () => q.sawText(/try and get the skull back/i);

    const openCoffin = async (label: string): Promise<void> => {
        await q.walk(`${label} shed`, [{ x: 3246, z: 3193, tol: 1 }]);
        await q.openDoor(`${label} shed door`, 3247, 3193);
        const shut = () => q.findLoc(l => l.x === COFFIN.x && l.z === COFFIN.z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)));
        const open = () => q.findLoc(l => l.x === COFFIN.x && l.z === COFFIN.z && (l.optionsWithIndex ?? []).some((o: any) => /^close$/i.test(o.text)));
        await q.step(`${label} coffin`, () => { const c = shut(); return c ? q.opLoc(c, q.opIndex(c, /^open$/i)) : q.waitTicks(1); }, () => !!open(), 10, 4);
    };
    const resume=process.env.GHOST_ENTRY;
    if(resume&&resume!=='skull-pickup')throw Error('unsupported GHOST_ENTRY');
    if(resume){
        if(!process.env.GHOST_PRIOR_RUN)throw Error('skull resume needs GHOST_PRIOR_RUN');
        const proof=readSkullResume(process.env.GHOST_PRIOR_RUN),p=q.pos();
        validateSkullResume(proof.prior,proof.log,proof.logout,{name:process.argv[2]!,x:p?.worldX??-1,z:p?.worldZ??-1,level:p?.level??-1,inventory:q.s.sdk.getInventory(),equipment:q.s.sdk.getEquipment()});
        q.milestone(3);
    }else{
    // 1. Aereck: "I'm looking for a quest!" sets 1.
    await q.talk('aereck', /^father aereck$/i, [/looking for a quest/i], () => q.sawText(/father urhney is an expert/i), AERECK);
    q.milestone(1);

    // 2. Urhney's hut in the swamp (door loc_1530 at 3234,3156, north wall): "Father Aereck sent me to talk to you.",
    // "He's got a ghost haunting his graveyard." gives the amulet (2). The church door is loc_1533 at 3238,3210.
    await q.openDoor('church door', 3238, 3210);
    await q.walk('to urhney', [{ x: 3234, z: 3157, tol: 1 }]);
    await q.openDoor('urhney door', 3234, 3156);
    await q.talk('urhney', /^father urhney$/i, [/father aereck sent me/i, /got a ghost haunting/i], () => q.has(ITEM.amulet), URHNEY);
    q.milestone(2);
    await q.step('wear amulet', () => q.s.direct({ type: 'useInventoryItem', slot: q.slot(ITEM.amulet)!, optionIndex: 2, reason: 'SDK' }), () => !q.has(ITEM.amulet), 3, 3);

    // 3. The graveyard shed (door loc_1530 at 3247,3193): open the coffin, which spawns the ghost; talk with the amulet
    // worn: "Yep, now tell me what the problem is." sets 3 (restless_ghost.rs2:16-29, 130-139).
    await openCoffin('ghost');
    await q.talk('ghost', /^restless ghost$/i, [/yep, now tell me what the problem is/i], ghostState, GHOST, 60);
    q.milestone(3);

    // 4. The skull in the Wizards' Tower basement: tower doors, ladder, the basement corridor door (loc_1530 at
    // 3111,9559). Taking it spawns a skeleton (quest_priest.rs2:68-80); the bot leaves it.
    await q.walk('tower', [{ x: 3109, z: 3167, tol: 1 }]);
    await q.openDoor('tower north door', 3109, 3166);
    await q.dash('tower hall', 3108, 3164, 1);
    await q.openDoor('tower inner door', 3107, 3162);
    await q.climb('ladder down', () => q.locAt(LADDER_TOP.x, LADDER_TOP.z) ?? LADDER_TOP, /climb-down/i, inBasement);
    await q.dash('corridor', 3109, 9560, 1);
    await q.openDoor('skull door', 3111, 9559);
    await q.walk('to skull', [{ x: SKULL_AT.x, z: SKULL_AT.z, tol: 1 }]);
    }
    const skullOnGround = (): any => (q.st()?.groundItems ?? []).find((g: any) => g.id === ITEM.skull);
    if(!await q.waitUntil(()=>!!skullOnGround(),SKULL_WAIT_TICKS))throw Error('shared skull unavailable within '+SKULL_WAIT_TICKS+' ticks');
    await q.step('take skull', () => { const g = skullOnGround(); return g ? q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }) : q.waitTicks(1); }, () => q.has(ITEM.skull), 10, 5);
    q.milestone(4);

    // 5. Lumbridge teleport, the coffin again (it shuts after 300 ticks, quest_priest.rs2:14), the skull on the open
    // coffin queues the completion (:53-65).
    if(q.cnt(563)<1)await leaveGhostBasement({pos:q.pos,openDoor:q.openDoor,dash:q.dash,
        waitForLadder:()=>waitUntil(q.s,()=>!!q.locAt(LADDER_UP.x,LADDER_UP.z),{timeoutTicks:15}),
        climbLadder:()=>q.climb('skull ladder up',()=>q.locAt(LADDER_UP.x,LADDER_UP.z),/climb-up|climb/i,()=>!inBasement()),
        waitForLanding:()=>waitUntil(q.s,()=>!!q.locAt(LADDER_TOP.x,LADDER_TOP.z),{timeoutTicks:15})});
    await q.teleport('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
    await openCoffin('skull');
    const altar = () => q.findLoc(l => l.x === COFFIN.x && l.z === COFFIN.z && (l.optionsWithIndex ?? []).some((o: any) => /^close$/i.test(o.text)));
    await q.step('skull in coffin', () => { const a = altar(); return a ? q.useOnLoc(ITEM.skull, a) : q.waitTicks(1); }, () => !q.has(ITEM.skull), 10, 4);
    await q.converse([], () => questDone && !q.dialogOpen(), 20);
    q.milestone(5);
    off();
    await q.end(questDone, 'qp=1');
} catch (e) { await q.fail(String(e)); }
