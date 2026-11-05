import {chickenTrainingProfile} from './train-chickens';
import {LUMBRIDGE_TO_DRAYNOR} from './courier-route';
import type {PathPoint} from '../packages/core/src/walk';
import type {QuestFlag} from '../packages/core/src/quest-status';

export function runeMysteriesDecision(state:QuestFlag['state'],items:readonly number[]){
    if(state==='complete')return 'complete';
    if(state==='unknown')return 'observe';
    if(state==='not started')return 'duke';
    if(items.includes(291))return 'notes';
    if(items.includes(290))return 'package';
    if(items.includes(1438))return 'talisman';
    // Started with none of the quest items: the journal shows one colour for stages 1 to 5, so only Sedridor's own
    // branch (sedridor.rs2) names the stage: he takes a talisman, re-issues a lost package, or sends the bot on.
    return 'sedridor';
}

// The next step after Sedridor's stage branch, from the page text seen (sedridor.rs2):
// stage 1 without the talisman: "Come back again when you have found it." (the Duke re-issues it, duke_horacio.rs2);
// stage 4, or stage 5 without the notes: "speak to him again" / "speak to Aubury once more" (Aubury gives or re-issues them);
// stage 2 or 3: the package is in the pack when the talk ends.
export type SedridorOutcome='package'|'duke'|'aubury'|'unknown';
export function sedridorOutcome(hasPackage:boolean,sawText:(re:RegExp)=>boolean):SedridorOutcome{
    if(hasPackage)return 'package';
    if(sawText(/speak to him again|speak to aubury once more/i))return 'aubury';
    if(sawText(/come back again when you have found it/i))return 'duke';
    return 'unknown';
}

// Any combat level may start: below 13 the walk skips the guarded corridors (walkRuneMysteries).
export function runeMysteriesStartProblem(_combat:number|undefined):string|null {
    return null;
}

// Reuse the starter-training corridors. Straight lines from Draynor cross
// the jail, and the south-east Varrock approach crosses the wizard circle.
export function runeMysteriesWalk(from:{worldX:number;worldZ:number;level:number}|null|undefined,to:PathPoint):PathPoint[] {
    if(!from)throw Error('Rune Mysteries prerequisite: position unknown');
    if(from.level!==0||from.worldZ>4000)throw Error('Rune Mysteries prerequisite: known surface start required');
    // 3088,3320 is a tree tile. The real training walk passed beside it;
    // an exact quest step otherwise waits200 ticks against that tree.
    const draynor=chickenTrainingProfile('draynor').route.map(p=>p.x===3088&&p.z===3320?{x:3089,z:3320,tol:1}:p);
    const varrock=chickenTrainingProfile('varrock').route;
    if(to.x===3109&&to.z===3167){
        // The direct Lumbridge approach crosses bears at3176,3223 and3159,3233.
        // Reuse the courier's lane north of that forest and the jail guards.
        const approach=from.worldX>=3200?LUMBRIDGE_TO_DRAYNOR.map(([x,z])=>({x,z,tol:0})):[];
        // 3092,3210 is blocked. Exact walkable points keep SDK detours out of
        // the dark wizards' spawn+wander+hunt bounds west of the bank.
        const north=approach.length||from.worldZ>=3230?[{x:3096,z:3230,tol:0}]:[];
        return [...approach,...north,{x:3097,z:3212,tol:0},to];
    }
    const lumbridge=to.x>=3200&&to.z<3300;
    if(lumbridge&&from.worldZ>=3330)
        return [...varrock,{x:3226,z:3250,tol:0},to];
    if(lumbridge&&from.worldX<3150&&from.worldZ>=3200)
        return [...draynor.slice(1),{x:3226,z:3250,tol:0},to];
    if(to.z>=3380&&from.worldZ<3330){
        // The direct tower-to-Draynor leg crosses the dark wizards at3107,3233
        // on SDK's shortest path. Leave through the same bank-side lane used
        // on arrival before taking the north corridor.
        const tower=from.worldX<3150&&from.worldZ<3212
            ?[{x:3097,z:3212,tol:0},{x:3096,z:3230,tol:0},{x:3092,z:3243,tol:0}]:[];
        return [...tower,...(from.worldX<3150?draynor.slice(1):varrock.slice(-1)),...varrock.slice(1,-1).reverse(),to];
    }
    return [to];
}

export async function walkRuneMysteries(from:Parameters<typeof runeMysteriesWalk>[0]&{combatLevel?:number},to:PathPoint,step:(point:PathPoint)=>Promise<unknown>):Promise<void> {
    // Below combat 13 the corridors pass guards that attack: walk straight to the target, and the shared walker's
    // plan closes the ground of monsters that would kill this account (packages/core/src/danger.ts).
    if((from?.combatLevel??0)<13){await step(to);return;}
    // The shared quest walker retries its final point directly on a failed
    // path. Give it one corridor point at a time so retries cannot skip one.
    for(const point of runeMysteriesWalk(from,to))await step(point);
}

export async function exitRuneTower(io:{waitForLanding:()=>Promise<boolean>;openDoor:(label:string,x:number,z:number)=>Promise<void>;dash:(label:string,x:number,z:number,tol:number)=>Promise<void>},label='tower exit'):Promise<void> {
    if(!await io.waitForLanding())throw Error('Rune Mysteries prerequisite: tower landing objects unobserved');
    await io.openDoor(`${label} inner door`,3107,3162);
    await io.dash(`${label} hall`,3108,3164,1);
    await io.openDoor(`${label} north door`,3109,3166);
    await io.dash(`${label} outside`,3109,3167,0);
}
