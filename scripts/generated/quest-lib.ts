// Shared helpers for the short-quest scripts (scripts/generated/quest-*.ts). The helpers are the ones proved in
// dwarfcannon.ts and waterfall.ts: walkPath first (it opens doors; SDK collision treats doors as open), clicks sent
// again when the server drops them inside a p_delay, one dialog page per tick, MILESTONE / WARN lines, a death check.
import { openBot, finish, getWorld, accountOf } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { startQuestSustain, selectQuestFood, questFoodDefinitions } from '../quest-sustain';
import { walkQuestCorridor } from '../quest-walk';
import { sessionWalker, walkPath, goTo, type PathPoint } from '../../packages/core/src/walk';
import { componentId } from '../../packages/core/src/logout';
import { ClientProt } from '../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { castable } from '../teleport-runes';
import { needs, reservedEdible } from '../quest-sweep';
import { PRESETS } from '../../packages/practice/src/presets';
// Root interface ids of every interface interface_chat/scripts/chat.rs2 sets text on, from content/pack/interface.pack.
const CHAT_NAMES = /^(chat[1-4]|npcchat[1-4]|message[1-5]|multi[2-5]|multiobj[2-4]|multiobj3_close|objbox[1-4]|doubleobjbox|inter_213|skill_multi[2-5])$/;
const CHAT_ROOTS = new Set(readFileSync(join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk', 'server', 'content', 'pack', 'interface.pack'), 'utf8')
    .split(/\r?\n/).map(l => l.split('=')).filter(([, n]) => n && CHAT_NAMES.test(n.trim())).map(([id]) => Number(id)));
const RESUME = ClientProt.RESUME_PAUSEBUTTON;
export let bursts = 0;
export let recorded = 0;
// Q_BURST=1: blind dialogue bursts (research/quest-plan.md "Dialogue burst"); off by default.
const BURST = process.env.Q_BURST === '1';
if (BURST) process.on('exit', () => console.log(`NOTE bursts=${bursts} recorded=${recorded} Q_BURST=1`));

export interface Loc { id: number; x: number; z: number }
export const LUMBRIDGE = { x: 3222, z: 3218 };
export const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];

// lumbridgeOk: the script teleports to Lumbridge, so a jump there is not a death (respawn and life id still count).
// name: the account (default process.argv[2]). others: more sessions of a two-account quest (quest-arrav.ts); fail()
// and end() log them out too.
export async function openQuest(opts: { session?: Session; stop?:()=>boolean; cap?: number; eatAt?: number; food?: number[]; reservedFood?: Readonly<Record<number,number>>|(()=>Readonly<Record<number,number>>); trace?: boolean; lumbridgeOk?: boolean; name?: string; others?: () => Session[] } = {}) {
    const CAP = opts.cap ?? 3000;
    const EAT_AT = opts.eatAt ?? 40;
    // Without a list of its own a quest eats anything that heals: a live account carries swordfish, cake slices or
    // trout, not the lobsters a preset does. quest-sweep marks the preset's edible ingredients on the session
    // (questReserved), and a script's reservedFood adds its own; neither is eaten.
    const FOOD = opts.food ?? [...questFoodDefinitions().keys()];
    const TRACE = opts.trace ?? process.env.Q_TRACE === '1';
    // quest-sweep.ts stages items and travel in its own login, then hands that session over here.
    const s: Session = opts.session ?? (globalThis as { QUEST_SESSION?: Session }).QUEST_SESSION ?? await openBot(opts.name ?? process.argv[2]!);
    // quest-sweep's handoff waits for this before another bot in the same process may hand over its session.
    (globalThis as { QUEST_SESSION_TAKEN?: () => void }).QUEST_SESSION_TAKEN?.();
    await waitTicks(s, 3);
    const st = (): any => s.sdk.getState();
    const pos = (): any => st()?.player;
    const inv = (): any[] => st()?.inventory ?? [];
    const hp = (): number => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp = (k: string): number => s.sdk.getSkillXp(k) ?? 0;
    const cnt = (id: number): number => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const has = (id: number): boolean => cnt(id) > 0;
    const slot = (id: number): number | undefined => inv().find(i => i.id === id)?.slot;
    const cheb = (x: number, z: number): number => { const p = pos(); return p ? Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) : 999; };
    const near = (x: number, z: number, r: number): boolean => cheb(x, z) <= r;
    const lvl = (): number => pos()?.level ?? -1;
    // Q_BURST: a page whose text arrived after the last answer still waits for one, even before the SDK state shows
    // it open (the recorder reads packets, the SDK state lags a tick). A step must not end while a page waits: walking
    // away closes it and the server never runs the code after the pause (quest_tree.rs2:23-24 sets the varp there).
    let textSeq = 0, answeredSeq = 0, textAt = -1;
    const pagePending = (): boolean => BURST && textSeq > answeredSeq && s.tick() - textAt <= 5;
    const dialogOpen = (): boolean => !!s.sdk.getDialog()?.isOpen || pagePending();
    // Dialog text seen so far: getDialog().text is often empty and recentDialogs keeps few pages, so every tick's page
    // text (text plus allComponents[].text) is kept here (last 400 pages).
    const pages: string[] = [];
    let lastPage = '';
    // Q_BURST: a burst skips pages, so the tick read above never sees them. Every IF_SETTEXT passes through
    // ifMutable and then sets .text (lite/protocol/incoming.ts IF_SETTEXT), so a text setter on each component it
    // returns records every page text the client receives, rendered or not. Only the chat interfaces count (CHAT_ROOTS):
    // other interfaces' text (side panels) once matched a step check that the dialogue had not reached. The server sets
    // a page's text before IF_OPENCHAT (chat.rs2 chatnpc_page), so chatModalId cannot tell them apart.
    const lite: any = (s as any).client;
    if (BURST && lite && typeof lite.ifMutable === 'function') {
        const before = lite.ifMutable;
        // Any dialogue answer, also a script's own sendClickDialog (quest-tree.ts ballista), answers the pages so far.
        const click = s.sdk.sendClickDialog.bind(s.sdk);
        (s.sdk as any).sendClickDialog = async (option?: number) => { const seq = textSeq; const r: any = await click(option); if (r?.success) answeredSeq = Math.max(answeredSeq, seq); return r; };
        lite.ifMutable = function (id: number) {
            const com: any = before.call(this, id);
            if (com && !com.__pageText) {
                let v = com.text;
                Object.defineProperty(com, 'text', { configurable: true, enumerable: true, get: () => v, set: (x: any) => { v = x; if (typeof x === 'string' && x && CHAT_ROOTS.has(com.layerId)) { pages.push(x); if (pages.length > 400) pages.shift(); recorded++; textSeq++; textAt = s.tick(); } } });
                com.__pageText = true;
            }
            return com;
        };
    }
    const pageText = (): string => {
        const d: any = s.sdk.getDialog();
        if (!d?.isOpen) return '';
        return [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' ');
    };
    const sawText = (re: RegExp): boolean => {
        const now = pageText();
        if (now && re.test(now)) return true;
        if (pages.some(p => re.test(p))) return true;
        return (st()?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
    };
    const msgCount = (re: RegExp): number => (st()?.gameMessages ?? []).filter((m: any) => m.type === 0 && re.test(m.text)).length;

    // Auto retaliate off (controls:com_3), so a hit never turns a walk or a loc click into a fight.
    await s.direct({ type: 'clickComponent', componentId: 151, reason: 'SDK' });
    const xp0: Record<string, number> = Object.fromEntries(SKILLS.map(k => [k, xp(k)]));
    const p0 = pos();
    const life0 = p0?.lifeId;
    const respawn0 = p0?.respawnCount ?? 0;
    const t0 = s.tick();
    const T = (): number => s.tick() - t0;
    const stats = { died: false, hpMin: hp(), eats: 0, walkTicks: 0, retries: 0 };
    let last = p0;
    const jumps: string[] = [];
    let lastTrace = '';
    const done = new Set<string>();
    const milestone = (step: string | number): void => {
        const k = String(step);
        if (done.has(k)) return;
        done.add(k);
        console.log(`MILESTONE ${k} ${T()}`);
    };
    const sustain = startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,direct:async action=>{
        const reply=await s.direct(action);
        if(!reply||typeof reply!=='object'||!('success' in reply)||typeof reply.success!=='boolean')throw Error('quest consume reply unknown');
        return{success:reply.success,message:'message' in reply?String(reply.message):undefined};
    }},{food:FOOD,eatAt:EAT_AT,reserved:()=>reservedNow(),onConsumed:()=>{stats.eats++;}});
    let lastHp = hp();
    const off = s.onTick(() => {
        const p = pos();
        const h = hp();
        if (h > 0 && h < stats.hpMin) {
            stats.hpMin = h;
            if (h <= 50) console.log(`WARN hp ${h} at ${T()} ${p?.worldX},${p?.worldZ},${p?.level}`);
        }
        if (h > 0 && h < lastHp) lastHitAt = T();
        lastHp = h;
        if (h > 0 && h <= RETREAT_AT && !retreating && !foodLeft()) { retreating = true; console.log(`WARN retreat: hp ${h} of ${maxHp()}, no food, at ${T()}`); }
        if (p?.isDead || (p && p.respawnCount > respawn0) || (p && life0 !== undefined && p.lifeId !== life0)) stats.died = true;
        if (p && last && Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)) > 20) {
            jumps.push(`${T()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (!opts.lumbridgeOk && Math.max(Math.abs(p.worldX - LUMBRIDGE.x), Math.abs(p.worldZ - LUMBRIDGE.z)) <= 15 && T() > 5) stats.died = true;
        }
        if (p) last = p;
        if (TRACE) {
            const d: any = s.sdk.getDialog();
            const m = (st()?.gameMessages ?? []).filter((x: any) => x.type === 0).slice(-1)[0]?.text ?? '';
            const rd = { tick: pages.length, text: [lastPage] };
            const line = `rd=${rd ? rd.tick + ":" + (rd.text ?? []).join(" ").slice(0, 40) : "-"} ${p?.worldX},${p?.worldZ},${p?.level} dlg=${d?.isOpen ? (d.isWaiting ? 'wait' : 'open') : '-'} txt=${(d?.text ?? '').slice(0, 50)} opts=${(d?.options ?? []).map((o: any) => o.text).join('|')} msg=${m}`;
            if (line !== lastTrace) { console.log(`TRACE ${T()} ${line}`); lastTrace = line; }
        }
        const pt = pageText();
        if (pt && pt !== lastPage) { pages.push(pt); if (pages.length > 400) pages.shift(); lastPage = pt; }
    });

    const detail = (): string => {
        const p = pos();
        const msgs = (st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-4).map((m: any) => m.text).join(' / ');
        return `at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${T()} hpMin=${stats.hpMin} eats=${stats.eats} walkTicks=${stats.walkTicks} retries=${stats.retries} died=${stats.died} milestones=${[...done].join(',')} jumps=${jumps.join(';')} msgs=${msgs}`;
    };
    const gains = (): string => SKILLS.map(k => [k, xp(k) - xp0[k]!] as const).filter(([, g]) => g > 0).map(([k, g]) => `${k.toLowerCase()}=${g}`).join(',');
    const all = (): Session[] => [s, ...(opts.others?.() ?? []).filter(o => o !== s)];
    const dispose = async () => { await sustain.settle(); off(); };
    const fail = async (why: string): Promise<never> => { await dispose(); const message=`${why} ${sustain.failure()??''} xp=${gains()} ${detail()}`; if(opts.session)throw Error(message); return finish(all(), false, message); };
    // A fight the account cannot win ends the quest before it ends the account: at the hitpoint floor (a quarter of the
    // base level, at least 5) with no food left to eat, the bot walks RETREAT_TILES away from whatever hits it, waits for
    // the server's 16 ticks after combat (logout.rs2 p_preventlogout), and the run fails with the retreat. Demon Slayer on
    // an 81-hitpoint, Attack 6 account went from 81 to 0 over 300 ticks at Delrith with no food and no such rule.
    const maxHp = (): number => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const RETREAT_AT = Math.max(5, Math.ceil(maxHp() * 0.25)), RETREAT_TILES = 30, COMBAT_LOGOUT_TICKS = 17;
    // A quest started on its own (bun scripts/generated/quest-<name>.ts <account>) reserves its preset's edible
    // ingredients itself (Black Knight's Fortress' cabbage): quest-sweep's handover marks the same on the session.
    const scriptQuest = basename(process.argv[1] ?? '').match(/^quest-([a-z0-9]+)\.ts$/)?.[1];
    const presetReserved: Readonly<Record<number, number>> = scriptQuest && PRESETS[`quest_${scriptQuest}`] ? reservedEdible(needs(PRESETS[`quest_${scriptQuest}`]!)) : {};
    const reservedNow = (): Readonly<Record<number, number>> => ({ ...presetReserved, ...((s as { questReserved?: Record<number, number> }).questReserved ?? {}), ...((typeof opts.reservedFood === 'function' ? opts.reservedFood() : opts.reservedFood) ?? {}) });
    // Food is what the eater would eat: the quest's food list and its later forms, beyond the reserved counts. A shrimp in
    // the pack of a lobster-only quest is not food and does not hold the retreat back.
    const foodLeft = (): boolean => !!selectQuestFood(st(), { food: FOOD, eatAt: Number.MAX_SAFE_INTEGER, reserved: reservedNow() });
    let retreating = false, lastHitAt = -1;
    const retreat = async (label: string): Promise<never> => {
        const p = pos(), npcs: any[] = st()?.nearbyNpcs ?? [];
        const foe = npcs.filter(n => n.combatTargetType === 'player' || n.inCombat).sort((a, b) => a.distance - b.distance)[0] ?? npcs.sort((a, b) => a.distance - b.distance)[0];
        let dx = foe ? Math.sign(p.worldX - foe.x) : 1, dz = foe ? Math.sign(p.worldZ - foe.z) : 0;
        if (!dx && !dz) dx = 1;
        const to = { x: p.worldX + dx * RETREAT_TILES, z: p.worldZ + dz * RETREAT_TILES };
        console.log(`RETREAT hp ${hp()} of ${maxHp()} at ${T()} ${p.worldX},${p.worldZ},${p.level} foe=${foe ? `${foe.name}@${foe.x},${foe.z}` : '-'} to=${to.x},${to.z}`);
        for (let i = 0; i < 3 && !stats.died; i++) {
            await s.direct({ type: 'walkTo', x: to.x, z: to.z, running: true, reason: 'SDK' });
            if (await waitUntil(s, () => stats.died || (!pos()?.combat?.inCombat && T() - lastHitAt > COMBAT_LOGOUT_TICKS), { timeoutTicks: 40 })) break;
        }
        return fail(`retreat during ${label}: hp ${hp()} of ${maxHp()}, no food`);
    };
    const guard = async (label: string): Promise<void> => {
        if(opts.stop?.())await fail(`stopped during ${label}`);
        if (stats.died) await fail(`died during ${label}`);
        if (retreating) await retreat(label);
        if (sustain.failure()) await fail(`${sustain.failure()} during ${label}`);
        if (T() > CAP) await fail(`tick cap during ${label}`);
    };
    const end = async (ok: boolean, extra = ''): Promise<never> => { await sustain.settle(); off(); return finish(all(), ok && !stats.died && !sustain.failure(), `${extra} ${sustain.failure()??''} xp=${gains()} ${detail()}`); };

    const opLoc = (l: Loc, op = 1) => s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' });
    const locs = (): any[] => st()?.nearbyLocs ?? [];
    const findLoc = (pred: (l: any) => boolean): any => locs().filter(pred).sort((a: any, b: any) => a.distance - b.distance)[0];
    const locAt = (x: number, z: number, re?: RegExp): any => findLoc(l => l.x === x && l.z === z && (!re || re.test(l.name)));
    const opIndex = (l: any, re: RegExp): number => l?.optionsWithIndex?.find((o: any) => re.test(o.text))?.opIndex ?? 1;
    const npc = (re: RegExp): any => (st()?.nearbyNpcs ?? []).filter((n: any) => re.test(n.name)).sort((a: any, b: any) => a.distance - b.distance)[0];
    const talkTo = (n: any) => s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /talk/i.test(o.text))?.opIndex ?? 1, reason: 'SDK' });
    const useOnLoc = (item: number, l: Loc) => s.direct({ type: 'useItemOnLoc', itemSlot: slot(item)!, x: l.x, z: l.z, locId: l.id, reason: 'SDK' });
    const useOnNpc = (item: number, n: any) => s.direct({ type: 'useItemOnNpc', itemSlot: slot(item)!, npcIndex: n.index, reason: 'SDK' });
    const useOnItem = (a: number, b: number) => s.direct({ type: 'useItemOnItem', sourceSlot: slot(a)!, targetSlot: slot(b)!, reason: 'SDK' });

    // Sends, then waits up to `ticks` for `ok`; retries. A stray dialog page is clicked through between tries.
    const step = async (label: string, send: () => unknown, ok: () => boolean, ticks = 20, tries = 3): Promise<void> => {
        for (let i = 0; i < tries; i++) {
            await guard(label);
            if (ok()) return;
            if (i > 0) stats.retries++;
            await send();
            await waitUntil(s, () => ok() || stats.died || retreating || !!sustain.failure(), { timeoutTicks: ticks });
            await guard(label);
            if (ok()) return;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
        }
        await guard(label);
        if (!ok()) await fail(`step ${label}`);
    };

    // One dialog page per tick: the first option matching a pattern, else "continue". Stops when ok() holds.
    const converse = async (pats: RegExp[], ok: () => boolean, maxTicks: number): Promise<boolean> => {
        const deadline=s.tick()+maxTicks;
        while (s.tick()<deadline && !stats.died) {
            await guard('dialogue');
            if (ok()) return true;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = (d.options ?? []).find((o: any) => pats.some(re => re.test(o.text)));
                if ((d.options ?? []).some((o: any) => !/click here to continue/i.test(o.text)) && !opt) console.log(`WARN no option match: ${(d.options ?? []).map((o: any) => o.text).join(' | ')}`);
                const beforeClick=s.tick();
                // Q_BURST=1 sends 5 blind continues on a page with no choice (the USER_EVENT cap).
                // ResumePauseButtonHandler.ts refuses a continue while a choice is pending, so a choice is never skipped.
                const choice=(d.options ?? []).some((o: any) => !/click here to continue/i.test(o.text));
                const c:any=(s as any).client;
                if(BURST&&!opt&&!choice&&c&&c.chatModalId!==-1){
                    for(let k=0;k<5;k++){c.writeOpcode(RESUME);c.out.p2(c.chatModalId);}
                    c.flush?.();bursts++;answeredSeq=textSeq;
                    await waitTicks(s,1);continue;
                }
                const reply=await s.sdk.sendClickDialog(opt ? opt.index : 0);
                if(!reply.success)await fail(`dialogue click refused: ${reply.message}`);
                if(s.tick()!==beforeClick)continue;
            }
            await waitTicks(s, 1);
        }
        return ok();
    };

    const walker = await sessionWalker(s as any);
    // A locked door the SDK plans through (collision treats doors as open) becomes a wall for this session.
    const blockDoor = (level: number, x: number, z: number): boolean => !!(s.sdk as any).blockDoorTemporarily?.(level, x, z, 3_600_000);
    // log: walkPath's input and re-plan lines and each attempt's result, for a walk under diagnosis.
    const walk = async (label: string, pts: PathPoint[], log?: (line: string) => void): Promise<void> => {
        await guard(label);
        const result=await walkQuestCorridor({tick:()=>s.tick(),stop:()=>stats.died||retreating||!!sustain.failure(),
            near:(point,tolerance)=>near(point.x,point.z,tolerance),walk:(points,options)=>walkPath(walker,points,log?{...options,log}:options),
            onAttempt:(attempt,result)=>{stats.walkTicks+=result.ticks;if(attempt>0)stats.retries++;log?.(`attempt ${attempt} ${JSON.stringify(result)}`);},
        },pts,t0+CAP);
        await guard(label);
        if(!result.ok)await fail(`walk ${label}: ${result.detail}`);
    };

    // Talk until ok(); then wait until the dialog closes (3 shut ticks). The NPC list covers about 15 tiles, so the
    // bot walks toward `home` first when the NPC is not in it.
    // The shut door or gate closest to an unreachable target, within 10 tiles of it.
    const openDoorNear = async (target: { x: number; z: number }, label: string): Promise<void> => {
        const d = locs().filter((l: any) => /door|gate/i.test(l.name ?? '') && Math.max(Math.abs(l.x - target.x), Math.abs(l.z - target.z)) <= 10
            && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)))
            .sort((a: any, b: any) => Math.max(Math.abs(a.x - target.x), Math.abs(a.z - target.z)) - Math.max(Math.abs(b.x - target.x), Math.abs(b.z - target.z)))[0];
        if (!d) return;
        console.log(`NOTE ${label}: opening ${d.name} at ${d.x},${d.z}`);
        await opLoc(d, opIndex(d, /^open$/i));
        await waitTicks(s, 3);
    };
    const talk = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, home: { x: number; z: number }, maxTicks = 60, stopOpen = false): Promise<void> => {
        for (let i = 0; i < 3; i++) {
            await guard(label);
            if (i > 0) stats.retries++;
            if (!npc(re)) await waitUntil(s, () => !!npc(re), { timeoutTicks: 3 });
            if (!npc(re)) await walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 5 }]);
            const n = npc(re);
            if (!n) await fail(`${label}: no npc ${re}`);
            for (let k = 0; k < 8 && !dialogOpen() && !stats.died; k++) {
                await guard(label);
                const blocked0 = msgCount(/can't reach that/i);
                const tr: any = await talkTo(npc(re) ?? n);
                if (tr && tr.success === false) console.log(`WARN talk ${label}: ${tr.reason ?? ""} ${tr.message ?? ""}`);
                let at0 = '', still = 0;
                for (let w = 0; w < 25 && !dialogOpen() && !stats.died; w++) {
                    await waitTicks(s, 1);
                    await guard(label);
                    const at = `${pos()?.worldX},${pos()?.worldZ}`;
                    still = at === at0 ? still + 1 : 0;
                    at0 = at;
                    if (still >= 3) break;
                }
                // On the live server a player can shut a door that is open on a fresh practice server.
                // The client sends nothing for a target with no route, so no message comes back; the reachable flag says the same.
                if (!dialogOpen() && (msgCount(/can't reach that/i) > blocked0 || npc(re)?.reachable === false)) await openDoorNear(npc(re) ?? n, label);
            }
            if (!dialogOpen()) { const m: any = npc(re); const p = pos(); console.log(`WARN talk ${label} no dialog: npc ${m?.x},${m?.z} d=${m?.distance} me ${p?.worldX},${p?.worldZ} op=${JSON.stringify(st()?.opFeedback ?? {})}`); }
            let shut = 0;
            await converse(pats, () => { shut = dialogOpen() ? 0 : shut + 1; return (ok() && (stopOpen || !dialogOpen())) || shut >= 3; }, maxTicks);
            if (ok()) return;
        }
        await fail(`talk ${label}`);
    };

    // A loc click that moves the bot (ladder, stairs, door): retried until arrived().
    const climb = async (label: string, find: () => any, re: RegExp, arrived: () => boolean, tries = 4): Promise<void> => {
        await step(label, () => {
            const k = find();
            if (!k) return waitTicks(s, 1);
            return opLoc(k, opIndex(k, re));
        }, arrived, 15, tries);
    };
    // Every rune the spell costs, or a worn staff for it, and the spell's Magic level (scripts/teleport-runes.ts); short
    // of any, the bot walks to the same spot instead. Monk's Friend leaves 8 law runes beside 1 air: Lumbridge still
    // needs 3 air, and Magic 31, which UnderMyKilt and TrouserSnake (Magic 1) lack.
    const magic = (): number => s.sdk.getState()?.skills?.find((k: any) => k.name === 'Magic')?.level ?? 1;
    const canCast = (comp: string): boolean => castable(comp, cnt, s.sdk.getEquipment().map((i: any) => i.id), magic());
    const teleport = async (label: string, comp: string, x: number, z: number): Promise<void> => {
        if (!canCast(comp)) {
            // The world router first: it knows the ladders and doors between an upstairs end (the Black Knights' Fortress's
            // first floor, 3029,3505) and the ground, which a one-floor corridor and a Climb-down loc in view do not.
            const routed = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { legTimeoutTicks: 150, planBudgetMs: 15_000 });
            console.log(`QUEST_TELEPORT_WALK ${JSON.stringify({ label, to: { x, z }, ok: routed.ok, reason: routed.ok ? undefined : routed.reason, at: pos() && { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } })}`);
            if (routed.ok && near(x, z, 6)) return;
            // walkPath keeps to one floor: from upstairs (Juliet's room, 3158,3425,1) take the nearest way down first.
            for (let i = 0; i < 3 && lvl() > 0; i++) {
                const from = lvl();
                const down = findLoc(l => l.distance <= 20 && (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text)));
                if (!down) await fail(`${label}: no way down from level ${from}`);
                // bot.interactLoc opens a shut door on the way to the stairs.
                await s.bot.interactLoc(down, down.optionsWithIndex.find((o: any) => /climb-down/i.test(o.text)).opIndex);
                await waitUntil(s, () => lvl() < from, { timeoutTicks: 30 });
            }
            await walk(`${label} (walk, no law rune)`, [{ x, z, tol: 4 }]); return;
        }
        await step(label, () => s.direct({ type: 'clickComponent', componentId: componentId(comp), reason: 'SDK' }), () => near(x, z, 6), 8, 3);
    };
    // Opens the shut door on tile (x, z) on the bot's level; nothing if it is open. walkPath does not see every
    // door (a diagonal door, a door the SDK plan never crosses), so a quest names its doors by tile.
    const shutAt = (x: number, z: number): any => findLoc(l => l.x === x && l.z === z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text)));
    const openDoor = async (label: string, x: number, z: number): Promise<void> => {
        if (!shutAt(x, z)) return;
        await step(label, () => { const d = shutAt(x, z); return d ? opLoc(d, opIndex(d, /^open$/i)) : undefined; }, () => !shutAt(x, z), 12, 4);
    };
    // Client-routed walk click (the client routes round walls but not through shut doors), retried until near.
    const dash = async (label: string, x: number, z: number, tol = 1, ticks = 30): Promise<void> => {
        const t1 = T();
        await step(label, () => s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' }), () => near(x, z, tol), ticks, 3);
        stats.walkTicks += T() - t1;
    };

    return {
        s, st, pos, inv, hp, xp, cnt, has, slot, cheb, near, lvl, dialogOpen, sawText, msgCount, T, stats, milestone, dispose,
        blockDoor, guard, fail, end, gains, detail, opLoc, locs, findLoc, locAt, opIndex, npc, talkTo, useOnLoc, useOnNpc, useOnItem,
        step, converse, walk, talk, climb, teleport, canCast, openDoor, shutAt, dash,
        waitTicks: async (n: number) => { const until=s.tick()+n;if(n>0)await waitUntil(s,()=>s.tick()>=until||stats.died||retreating||T()>CAP,{timeoutTicks:n,signal:sustain.aborted});await guard('wait'); },
        waitUntil: async (f: () => boolean, ticks: number) => {const reached=await waitUntil(s, () => f() || stats.died||retreating||T()>CAP, { timeoutTicks: ticks,signal:sustain.aborted });await guard('wait condition');return reached;},
    };
}
