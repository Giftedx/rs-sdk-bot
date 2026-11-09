import { questFlags } from './quest-status';
import { waitUntil, waitTicks } from './ticks';
import type { Session } from './inprocess';

export interface GuildActorFacts {
    varps: Record<string, number>;
    questStages: Record<string, number>;
    unlocks: string[];
    castlewarsTeam?: 0 | 1;
}
export interface GuildRefreshResult extends GuildActorFacts { admission?: { legendsEntry: 'crossed'|'refused'|'unknown' } }
const evidence = new WeakMap<object, { stages: Record<string,number>; unlocks: Set<string> }>();
const clean = (v: unknown) => String(v ?? '').replace(/@[^@]{3}@/g, '').replace(/<[^>]*>/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
function saved(client: object) {
    let value = evidence.get(client);
    if (!value) { value = { stages: {}, unlocks: new Set() }; evidence.set(client, value); }
    return value;
}

// The returned stages are observed lower bounds, never exact private varp values.
// Sources: pinned quest journals, questlist IF_SETCOLOUR and CW team overlays.
export function guildActorFacts(client: any, state?: any): GuildActorFacts {
    const facts: GuildActorFacts = { varps: {}, questStages: {}, unlocks: [] };
    if (!client || client.ingame !== true) return facts;
    const prior = saved(client);
    facts.questStages = { ...prior.stages };
    facts.unlocks = [...prior.unlocks];
    // varServ is only written by incoming VARP packets; client.var includes local writes.
    const qp = client.varServ?.[101];
    if (Number.isInteger(qp) && qp > 0) facts.varps.qp = qp;
    for (const q of questFlags(client) ?? []) {
        // Green is completion, not an exact private stage. The native map is the final glider admission.
        if (q.id === 7361 && q.state === 'complete' && client.membersAccount === 1 && state?.inGame !== false) facts.unlocks.push('grandtree-glider');
        const key = q.id === 7363 ? 'heroquest' : q.id === 7366 ? 'legendsquest' : q.id === 7356 ? 'mcannon' : undefined;
        if (!key) continue;
        const bound = q.state === 'complete' ? (key === 'heroquest' ? 15 : key === 'legendsquest' ? 75 : 11)
            : q.state === 'started' ? 1 : 0;
        if (bound) facts.questStages[key] = Math.max(facts.questStages[key] ?? 0, bound);
    }
    const p = state?.player;
    const x = p?.worldX, z = p?.worldZ;
    const inGame = Number.isInteger(p?.level) && p.level >= 0 && p.level <= 3 && x >= 2368 && x <= 2431
        && ((z >= 3072 && z <= 3135) || (p.level === 0 && z >= 9472 && z <= 9535));
    const waiting = p?.level === 0 && z >= 9472 && ((x <= 2393 && z <= 9497) || (x >= 2408 && z >= 9512));
    if (inGame && !waiting && client.mainOverlayId === 11146) facts.castlewarsTeam = 0;
    if (inGame && !waiting && client.mainOverlayId === 11344) facts.castlewarsTeam = 1;
    return facts;
}

export function journalGuildStage(title: string, body: string): { key: string; lowerBound: number } | null {
    title = clean(title); body = clean(body);
    if (title === 'Dwarf Cannon') {
        if (/The Commander has asked me to check up on his guards at the watchtower to the South of his camp\./.test(body)
            || /I went to the watchtower where I found some dwarf remains\./.test(body)) return { key: 'mcannon', lowerBound: 2 };
        // These later pages independently establish that the guarded tower step passed.
        if (/I gave the remains to the Commander\.|I found the Goblin's base\. Next I need to find the Dwarf child\.|I have rescued the dwarf child|fix the multicannon|fixed the broken multicannon|Nulodion the Cannon Engineer|I've spoken to Nulodion, He gave me an ammo mould and notes,|buy a multicannon/.test(body)) return { key: 'mcannon', lowerBound: 2 };
    }
    if (title === 'The Legends Quest' && (/Radimus asked me to join him inside the Legends Guild to discuss my reward\./.test(body)
        || /The gilded totem pole is on display in the Legends Guild/.test(body))) return { key: 'legendsquest', lowerBound: 50 };
    return null;
}

// Only an explicitly requested journal is opened. A closed -> fresh open transition
// is mandatory: retained component text from a previous journal cannot grant entry.
export async function refreshGuildEvidence(s: Session, requested: string[]): Promise<GuildRefreshResult> {
    const c: any = s.client;
    let admission: GuildRefreshResult['admission'];
    if (!c || c.ingame !== true) return {...guildActorFacts(c, s.sdk.getState()),...(requested.includes('legends-entry')?{admission:{legendsEntry:'unknown' as const}}:{})};
    for (const key of requested) {
        if (key === 'legends-entry') {
            admission={legendsEntry:await refreshLegendsEntry(s, c)};
            continue;
        }
        if (key === 'prayer-guild') {
            await refreshPrayer(s, c);
            continue;
        }
        const button = key === 'mcannon' || key === 'dwarf-tower' ? 7356 : key === 'legendsquest' ? 7366 : undefined;
        if (button === undefined) continue;
        if (s.sdk.getDialog()?.isOpen || ![-1,8134].includes(c.mainModalId)) continue;
        if (c.mainModalId !== -1) {
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            if (!await waitUntil(s, () => c.mainModalId === -1, { timeoutTicks: 5 })) continue;
        }
        await s.direct({ type: 'clickComponent', componentId: button, reason: 'SDK' });
        const expected = button === 7356 ? 'Dwarf Cannon' : 'The Legends Quest';
        if (!await waitUntil(s, () => c.mainModalId === 8134 && clean(c.ifType(8144)?.text) === expected, { timeoutTicks: 8 })) continue;
        const body = Array.from({length:50}, (_,i) => c.ifType(8145+i+(i > 0 ? 1 : 0))?.text ?? '').join(' ');
        const found = journalGuildStage(clean(c.ifType(8144)?.text), body);
        if (found) {
            saved(c).stages[found.key] = Math.max(saved(c).stages[found.key] ?? 0, found.lowerBound);
            if (found.key === 'mcannon') saved(c).unlocks.add('dwarf-tower');
        }
        await s.direct({ type: 'closeModal', reason: 'SDK' });
        await waitUntil(s, () => c.mainModalId === -1, { timeoutTicks: 5 });
    }
    return {...guildActorFacts(c, s.sdk.getState()),...(admission?{admission}:{})};
}

// Quest zero has a real first-entry dialogue. The server alone decides its five
// quest/107-QP prerequisites. Its opened gate changes position, not quest stage.
async function refreshLegendsEntry(s: Session, c: any): Promise<'crossed'|'refused'|'unknown'> {
    if (c.mainModalId !== -1 || s.sdk.getDialog()?.isOpen) return 'unknown';
    const st = s.sdk.getState(), p = st?.player;
    if (p?.level !== 0 || p.worldX < 2725 || p.worldX > 2732 || p.worldZ < 3344 || p.worldZ > 3349) return 'unknown';
    const gate = st?.nearbyLocs?.find((l:any) => [2391,2392].includes(l.id) && l.level === 0 && l.distance <= 6
        && [2728,2729].includes(l.x) && l.z === 3349);
    if (!gate) return 'unknown';
    const sent:any = await s.direct({type:'interactLoc',x:gate.x,z:gate.z,locId:gate.id,optionIndex:1,reason:'SDK'});
    if (sent?.success !== true) return 'unknown';
    const choices = ['What is this place?','Can I go on the quest?',"Yes, I'd like to talk to Grand Vizier Erkle."];
    let next = 0;
    const deadline = s.tick()+60;
    while (s.tick() < deadline && c.ingame === true) {
        const now = s.sdk.getState()?.player;
        if (now?.level === 0 && now.worldX >= 2728 && now.worldX <= 2729 && now.worldZ >= 3350 && now.worldZ <= 3351) return 'crossed';
        const d:any = s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            const text=clean([d.text,...(d.allComponents??[]).map((v:any)=>v.text)].join(' '));
            if(next===2&&(/I'm very sorry but you need to complete more quests before you can go on this quest\./.test(text)
                ||/Well, you've completed the required quests\. However, you also need to have 107 Quest points\./.test(text)))return 'refused';
            const page=JSON.stringify([d.pageId,d.text,d.options,d.allComponents]);
            const options = d.options ?? [];
            const pick = options.find((o:any) => clean(o.text) === choices[next]);
            const menu = options.some((o:any) => !/click here to continue/i.test(o.text));
            // Refusal/other menu never becomes a guessed option zero.
            if (menu && !pick) return 'unknown';
            const reply = await s.sdk.sendClickDialog(pick?.index ?? 0);
            if (!reply.success) return 'unknown';
            if (pick) next++;
            const remaining=deadline-s.tick();
            if(remaining<=0)return 'unknown';
            // Choice buttons can retain the old ready menu for several ticks.
            // Its lack of the NEXT choice is not a server refusal. Wait for a
            // genuinely published page (or the final crossing) before reading it.
            const changed=await waitUntil(s,()=>{
                const p=s.sdk.getState()?.player,newPage:any=s.sdk.getDialog();
                return !!p&&p.level===0&&p.worldX>=2728&&p.worldX<=2729&&p.worldZ>=3350&&p.worldZ<=3351
                    ||newPage?.isOpen&&!newPage.isWaiting&&JSON.stringify([newPage.pageId,newPage.text,newPage.options,newPage.allComponents])!==page;
            },{timeoutTicks:Math.min(8,remaining)});
            if(!changed)return 'unknown';
        }
        await waitTicks(s,1);
    }
    // No cached unlock: even an eligibility acknowledgement cannot authorize a
    // later gate crossing. The caller re-reads its actual position and actor.
    return 'unknown';
}

async function refreshPrayer(s: Session, c: any): Promise<void> {
    if (saved(c).unlocks.has('prayer-guild') || c.mainModalId !== -1 || s.sdk.getDialog()?.isOpen) return;
    const st = s.sdk.getState(), p = st?.player;
    const ladder = st?.nearbyLocs?.find((l:any) => l.id === 2641 && l.level === 0 && l.distance <= 5
        && ((l.x === 3046 || l.x === 3057) && l.z === 3483));
    if (!ladder || p?.level !== 0) return;
    const sent: any = await s.direct({type:'interactLoc',x:ladder.x,z:ladder.z,locId:2641,optionIndex:1,reason:'SDK'});
    if (sent?.success !== true) return;
    let selected = false, askedHow = false, mode: 'ladder'|'abbot' = 'ladder', idleSince=s.tick();
    const deadline = s.tick()+80;
    while (s.tick() < deadline && c.ingame === true) {
        const now = s.sdk.getState()?.player;
        if (now?.level === 1 && now.worldZ === 3483 && Math.abs(now.worldX-ladder.x) <= 1) {
            saved(c).unlocks.add('prayer-guild'); return;
        }
        const d: any = s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            const text = clean([d.text, ...(d.allComponents ?? []).map((v:any)=>v.text)].join(' '));
            if (mode === 'ladder' && /You'll need to talk to Abbot Langley about that\. He's usually to be found walking the halls of the monastery\./.test(text)) {
                const reply=await s.sdk.sendClickDialog(0);
                if(!reply.success||!await waitUntil(s,()=>!s.sdk.getDialog()?.isOpen,{timeoutTicks:Math.min(8,deadline-s.tick())}))return;
                const abbot=s.sdk.getState()?.nearbyNpcs.find(n=>n.id===801&&n.distance<=16);
                if(!abbot||s.sdk.getState()?.player?.level!==0)return;
                // Reuse the core's bounded/cancellable ordinary walk. Re-find
                // this server index afterwards, as BotActions.talkTo does.
                if(abbot.distance>2){
                    const {walkRoute}=await import('./walk');
                    const budget=Math.min(30,deadline-s.tick());if(budget<=0)return;
                    const walked=await walkRoute(s,[{kind:'walk',to:{x:abbot.x,z:abbot.z,level:0},tolerance:2}],{maxRetriesPerLeg:1,legTimeoutTicks:budget});
                    if(!walked.ok)return;
                }
                const current=s.sdk.getState()?.nearbyNpcs.find(n=>n.id===801&&n.index===abbot.index);
                if(!current||current.reachable===false||s.sdk.getState()?.player?.level!==0||s.tick()>=deadline)return;
                const talk:any=await s.direct({type:'interactNpc',npcIndex:current.index,optionIndex:1,reason:'SDK'});
                if(talk?.success!==true)return;
                mode='abbot';idleSince=s.tick();continue;
            }
            const accepted=selected&&/Ok, I see you are someone suitable for our order\. You may join\./.test(text);
            const refused=selected&&/No\. I am sorry, but I feel you are not devout enough\./.test(text);
            if(accepted||refused){
                if(accepted)saved(c).unlocks.add('prayer-guild');
                await s.sdk.sendClickDialog(0);
                await waitUntil(s,()=>!s.sdk.getDialog()?.isOpen,{timeoutTicks:Math.min(8,Math.max(1,deadline-s.tick()))});
                return;
            }
            const options = d.options ?? [];
            const join = !selected&&options.find((o:any) => clean(o.text) === 'Well can I join your order?');
            const how = mode==='abbot'&&!askedHow&&options.find((o:any)=>clean(o.text)==='How do I get further into the monastery?');
            const pick=join||how;
            if(options.some((o:any)=>!/click here to continue/i.test(o.text))&&!pick)return;
            const page=JSON.stringify([d.pageId,d.text,d.options,d.allComponents]);
            const reply=await s.sdk.sendClickDialog(pick?.index??0);if(!reply.success)return;
            if(join)selected=true;if(how)askedHow=true;
            const remaining=deadline-s.tick();if(remaining<=0)return;
            if(!await waitUntil(s,()=>{const next:any=s.sdk.getDialog();return !next?.isOpen||!next.isWaiting&&JSON.stringify([next.pageId,next.text,next.options,next.allComponents])!==page;},{timeoutTicks:Math.min(8,remaining)}))return;
            idleSince=s.tick();
        } else if(!d?.isOpen&&s.tick()-idleSince>=12)return;
        if(s.tick()<deadline)await waitTicks(s,1);
    }
}
