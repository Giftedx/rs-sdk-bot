// Rune Mysteries runner supporting arbitrary start locations (e.g. Lumbridge courtyard or Varrock).
// Reward: 1 QP, air talisman. Unlocks Aubury teleport for Rune Essence mining.
// Server truth: areas/area_lumbridge/scripts/duke_horacio.rs2, areas/area_wizard_tower/scripts/sedridor.rs2,
// areas/area_varrock/scripts/aubury.rs2.
import { openQuest } from './quest-lib';
import type {Session} from '../../packages/core/src/inprocess';
import {walkRuneMysteries,runeMysteriesStartProblem,exitRuneTower,runeMysteriesDecision,sedridorOutcome,nearestBankTile,RUNE_MYSTERIES_ITEMS} from '../rune-mysteries-route';
import travel from '../../packages/planner/src/haggis-travel.json';
import {waitUntil} from '../../packages/core/src/ticks';
import {questFlags} from '../../packages/core/src/quest-status';

const DUKE = { x: 3212, z: 3220 };                        // level 1
const SEDRIDOR = { x: 3103, z: 9571 };                    // Wizards' Tower basement
const LADDER_TOP = { id: 2147, x: 3104, z: 3162 };        // wizards_tower_laddertop (maps/m48_49.jm2)
const LADDER_UP = { id: 2148, x: 3103, z: 9576 };
const AUBURY = { x: 3253, z: 3402 };
const ITEM = { talisman: 1438, pack: 290, notes: 291 };   // research_notes is named "Notes"

export async function runRuneMysteries(s:Session,options:{cap?:number;stop?:()=>boolean;food?:number[];eatAt?:number}={}) {
const q = await openQuest({ session:s, cap:options.cap??4000, stop:options.stop, food:options.food??[379], eatAt:options.eatAt??40, lumbridgeOk: true });
try {
    const questState=()=>questFlags((q.s as any).client)?.find(f=>f.name==='Rune Mysteries Quest')?.state??'unknown';
    await waitUntil(q.s,()=>questState()!=='unknown',{timeoutTicks:15});
    let decision=runeMysteriesDecision(questState(),q.inv().filter(i=>i.count>0).map(i=>i.id));
    if(decision==='observe')throw Error('Rune Mysteries journal unknown; cannot infer quest stage from talisman');
    const problem=runeMysteriesStartProblem(q.pos()?.combatLevel);
    if(problem&&decision!=='complete')throw Error(problem);
    const questDone=()=>questState()==='complete';
    const levelIs = (lv: number) => () => q.lvl() === lv;
    const inBasement = () => (q.pos()?.worldZ ?? 0) > 9000;
    const sed = /^sedridor$/i;
    const stairs = (re: RegExp) => () => q.findLoc(l => /stair/i.test(l.name) && Math.max(Math.abs(l.x - 3205), Math.abs(l.z - 3209)) <= 4 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));

    const leaveSedridor = async (label: string): Promise<void> => {
        if (inBasement()) {
            await q.openDoor(`${label} basement door exit`, 3108, 9570);
            await q.dash(`${label} to ladder up`, 3104, 9576, 1);
            await q.climb(`${label} ladder up`, () => q.locAt(LADDER_UP.x, LADDER_UP.z) ?? LADDER_UP, /climb-up|climb/i, () => !inBasement());
        }
        const p=q.pos();
        if(p?.level===0&&p.worldX>=3103&&p.worldX<=3111&&p.worldZ>=3160&&p.worldZ<=3166)
            await exitRuneTower({waitForLanding:()=>waitUntil(q.s,()=>!!q.locAt(LADDER_TOP.x,LADDER_TOP.z),{timeoutTicks:15}),openDoor:q.openDoor,dash:q.dash},label);
    };

    const tryTeleport = async (label: string, comp: string, x: number, z: number) => {
        await leaveSedridor(label);
        await walkRuneMysteries(q.pos(), { x, z, tol: 2 }, point=>q.walk(`walk fallback ${label}`, [point]));
    };

    if(decision==='complete'){
        await leaveSedridor('resume complete');
        if(q.pos()?.worldZ>9000)throw Error('Rune Mysteries completed basement exit unobserved');
        return {ok:true,alreadyComplete:true,reward:q.has(ITEM.talisman),eats:q.stats.eats};
    }

    // 3. The Wizards' Tower: north door (loc 1536 at 3109,3166), inner door (3107,3162, diagonal), ladder down, the basement door.
    const toSedridor = async (label: string): Promise<void> => {
        if(inBasement()){
            await q.openDoor(`${label} resumed basement door`,3108,9570);
            return;
        }
        await walkRuneMysteries(q.pos(), { x: 3109, z: 3167, tol: 1 }, point=>q.walk(`${label} tower`, [point]));
        await q.openDoor(`${label} north door`, 3109, 3166);
        await q.dash(`${label} hall`, 3108, 3164, 1);
        await q.openDoor(`${label} inner door`, 3107, 3162);
        await q.climb(`${label} ladder down`, () => q.locAt(LADDER_TOP.x, LADDER_TOP.z) ?? LADDER_TOP, /climb-down/i, inBasement);
        // The basement door: loc_1530 at 3108,9570 (west wall, maps/m48_149.jm2). Shut, the talk click is rejected.
        await q.dash(`${label} corridor`, 3108, 9570, 0);
        await q.openDoor(`${label} basement door`, 3108, 9570);
    };

    // 0. Started with no quest item: Sedridor's branch names the stage (sedridor.rs2). He takes the talisman and gives
    // the package (stages 1 to 2), re-issues a lost package (3), or sends the bot to Aubury for the notes (4, 5); with
    // the talisman lost he asks for it, and the Duke re-issues it (duke_horacio.rs2 duke_rune_mysteries_in_progress).
    let needTalisman = decision==='duke', toAubury = false;
    if (decision==='sedridor') {
        // quest-sweep stages the quest in the Duke's room (castle level 1); the tower walk needs a surface start.
        if (q.lvl() === 1) {
            await q.openDoor('recover duke door leave', 3207, 3222);
            await q.walk('recover to stairs', [{ x: 3206, z: 3210, tol: 1 }]);
            await q.climb('recover castle stairs down', stairs(/climb-down/i), /climb-down/i, levelIs(0));
        }
        // A quest item in the bank counts as held for the server (obj_gettotal): Sedridor and the Duke then re-issue
        // nothing and Sedridor sends the bot "to get them from the bank". Take the quest's items out first.
        const bank = nearestBankTile({ x: q.pos()?.worldX ?? 0, z: q.pos()?.worldZ ?? 0 }, Object.values((travel as unknown as { banks: Record<string, { x: number; z: number; level: number }> }).banks));
        await q.walk('recover to bank', [{ x: bank.x, z: bank.z, tol: 3 }]);
        const opened: any = await q.s.bot.openBank();
        if (!opened?.success) throw Error('Rune Mysteries recovery: bank did not open');
        await q.waitUntil(() => (q.st()?.bank?.items?.length ?? 0) > 0, 10);
        const rows = (): any[] => q.st()?.bank?.items ?? [];
        for (const id of RUNE_MYSTERIES_ITEMS) {
            const row = rows().find((i: any) => i.id === id);
            if (!row || q.has(id)) continue;
            await q.s.bot.withdrawItem(row, 1);
            const got = await q.waitUntil(() => q.has(id), 10);
            console.log(`NOTE rune mysteries recovery: withdrew ${id} ${got ? 'ok' : 'unobserved'}`);
        }
        await q.s.bot.closeBank();
        decision = runeMysteriesDecision(questState(), q.inv().filter(i => i.count > 0).map(i => i.id));
        console.log(`NOTE rune mysteries recovery: after the bank ${decision}`);
    }
    if (decision==='sedridor') {
        await toSedridor('recover');
        const outcome = () => sedridorOutcome(q.has(ITEM.pack), q.sawText);
        await q.talk('sedridor recover', sed, [/looking for the head wizard/i, /ok, here you are/i, /yes, certainly/i], () => outcome() !== 'unknown', SEDRIDOR, 120);
        const next = outcome();
        console.log(`NOTE rune mysteries recovery: sedridor says ${next}`);
        if (next === 'unknown' || next === 'bank') throw Error(`Rune Mysteries recovery: Sedridor named ${next === 'bank' ? 'a banked item the bank trip did not find' : 'no stage'}`);
        if (next === 'aubury') toAubury = true;
        if (next === 'duke') { needTalisman = true; await leaveSedridor('recover talisman'); }
        q.milestone('recover');
    }

    // 1. The Duke: "Have you any quests for me?", "Sure, no problem." gives the air talisman (duke_horacio.rs2:22-36).
    if (needTalisman) {
        if (q.lvl() === 0) {
            await walkRuneMysteries(q.pos(), { x: 3205, z: 3209, tol: 2 }, point=>q.walk('to castle stairs up', [point]));
            await q.climb('castle stairs up', stairs(/climb-up|climb/i), /climb-up|climb/i, levelIs(1));
        }
        if (q.lvl() === 1) {
            await q.walk('to duke door', [{ x: 3207, z: 3221, tol: 1 }]);
            await q.openDoor('duke door enter', 3207, 3222);
            await q.walk('into duke room', [{ x: 3210, z: 3221, tol: 1 }]);
            await q.talk('duke', /^duke horacio$/i, [/any quests for me/i, /sure, no problem/i], () => q.has(ITEM.talisman), DUKE);
            q.milestone(1);
        }
    }

    // 2. Down the castle: the Duke's door (loc 1536 at 3207,3222, level 1), the stairs at 3204,3207 (dragon row).
    if (q.lvl() === 1) {
        await q.openDoor('duke door leave', 3207, 3222);
        await q.walk('to stairs', [{ x: 3206, z: 3210, tol: 1 }]);
        await q.climb('castle stairs down', stairs(/climb-down/i), /climb-down/i, levelIs(0));
        q.milestone('castle');
    }

    if (q.has(ITEM.talisman) && !q.has(ITEM.pack) && !q.has(ITEM.notes)) {
        await toSedridor('sed 1');
        q.milestone('basement');

        // 4. Sedridor: "I'm looking for the head wizard.", "Ok, here you are.", "Yes, certainly." gives the package (2, 3).
        await q.talk('sedridor 1', sed, [/looking for the head wizard/i, /ok, here you are/i, /yes, certainly/i], () => q.has(ITEM.pack), SEDRIDOR, 120);
        q.milestone(3);
    }

    if (q.has(ITEM.pack)||toAubury) {
        // 5. Aubury's shop in Varrock
        await tryTeleport('varrock teleport', 'magic:varrock_teleport', 3212, 3424);
        await q.walk('to aubury', [{ x: 3253, z: 3398, tol: 1 }]);
        await q.openDoor('aubury door', 3253, 3399);
        if(q.has(ITEM.pack)){
            await q.talk('aubury 1', /^aubury$/i, [/sent here with a package/i], () => !q.has(ITEM.pack), AUBURY, 60);
            q.milestone(4);
        }
        await q.talk('aubury 2', /^aubury$/i, [], () => q.has(ITEM.notes), AUBURY, 60);
        if(!q.has(ITEM.notes))throw Error('Rune Mysteries notes unobserved; inspect bank or missing package/talisman stage');
        q.milestone(5);
    }

    if (q.has(ITEM.notes)) {
        // 6. Lumbridge teleport/walk, the tower again, Sedridor takes the notes and queues completion.
        if(q.lvl()===0&&q.near(AUBURY.x,AUBURY.z,10))await q.openDoor('aubury door exit', 3253, 3399);
        await tryTeleport('lumbridge teleport', 'magic:lumbridge_teleport', 3221, 3218);
        await toSedridor('sed 2');
        await q.talk('sedridor 2', sed, [], questDone, SEDRIDOR, 200, true);
        await q.converse([], () => !q.dialogOpen(), 10);
        q.milestone(6);
    }

    if(!await waitUntil(q.s,questDone,{timeoutTicks:15}))throw Error('Rune Mysteries completion unobserved; talisman is not completion proof');
    // Leave the basement and head to Varrock East Bank so Shaftsinker is ready for essence mining
    await leaveSedridor('finish');
    await tryTeleport('varrock finish', 'magic:varrock_teleport', 3212, 3424);
    await q.walk('varrock bank finish', [{ x: 3253, z: 3420, tol: 2 }]);

    if(!q.has(ITEM.talisman))throw Error('Rune Mysteries reward missing: recover earned air talisman from Sedridor');
    return {ok:questDone()&&!q.stats.died,alreadyComplete:false,reward:q.has(ITEM.talisman),eats:q.stats.eats};
} catch(error){
    return {ok:false,alreadyComplete:false,reward:q.has(ITEM.talisman),eats:q.stats.eats,failure:String(error),detail:q.detail()};
} finally {await q.dispose();}
}

// Run directly, or imported by scripts/quest-sweep.ts with its session in globalThis.QUEST_SESSION.
const handed=(globalThis as {QUEST_SESSION?:Session}).QUEST_SESSION;
if(import.meta.main||handed){
 const {openBot,finish}=await import('../../packages/core/src/bot');
 const s=handed??await openBot(process.argv[2]!);
 try{const result=await runRuneMysteries(s);await finish([s],result.ok,JSON.stringify(result));}
 catch(error){await finish([s],false,String(error));}
}
