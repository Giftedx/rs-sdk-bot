// Shared helpers for the short-quest scripts (scripts/generated/quest-*.ts). The helpers are the ones proved in
// dwarfcannon.ts and waterfall.ts: walkPath first (it opens doors; SDK collision treats doors as open), clicks sent
// again when the server drops them inside a p_delay, one dialog page per tick, MILESTONE / WARN lines, a death check.
import { openBot, finish, getWorld, accountOf } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { startQuestSustain, selectQuestFood, questFoodDefinitions, defaultEatAt } from '../quest-sustain';
import { holdSessionEater } from '../../packages/core/src/sustain';
import { walkQuestCorridor } from '../quest-walk';
import { sessionWalker, walkPath, goTo, type PathPoint } from '../../packages/core/src/walk';
import { componentId } from '../../packages/core/src/logout';
import { ClientProt } from '../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { castable } from '../teleport-runes';
import { needs, reservedEdible, walkFar } from '../quest-sweep';
import { magicKit, type MagicKit } from '../../packages/core/src/gather';
import { PRESETS } from '../../packages/practice/src/presets';
import { giantStyle } from '../gather-combat';
// Root interface ids of every interface interface_chat/scripts/chat.rs2 sets text on, from content/pack/interface.pack.
const CHAT_NAMES = /^(chat[1-4]|npcchat[1-4]|message[1-5]|multi[2-5]|multiobj[2-4]|multiobj3_close|objbox[1-4]|doubleobjbox|inter_213|skill_multi[2-5])$/;
const CHAT_ROOTS = new Set(readFileSync(join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk', 'server', 'content', 'pack', 'interface.pack'), 'utf8')
    .split(/\r?\n/).map(l => l.split('=')).filter(([, n]) => n && CHAT_NAMES.test(n.trim())).map(([id]) => Number(id)));
const RESUME = ClientProt.RESUME_PAUSEBUTTON;
// Magic level per spell: skill_magic/scripts/magic.rs2 refuses a cast while stat(magic) < levelrequired.
export const parseSpellLevels = (dbrow: string): Map<string, number> => {
    const levels = new Map<string, number>();
    for (const row of dbrow.split(/^\[/m)) {
        const spell = /^data=spell,\^(\w+)/m.exec(row)?.[1], level = /^data=levelrequired,(\d+)/m.exec(row)?.[1];
        if (spell && level) levels.set(spell, Number(level));
    }
    return levels;
};
const SPELL_LEVELS = parseSpellLevels(readFileSync(join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk', 'server', 'content', 'scripts', 'skill_magic', 'configs', 'magic_spells.dbrow'), 'utf8'));
// Why a teleport component cannot be cast (the caller walks instead), or undefined when it can. Every teleport here costs one law rune.
export const teleportRefusal = (comp: string, magic: number, laws: number, levels: ReadonlyMap<string, number> = SPELL_LEVELS): string | undefined => {
    const need = levels.get(comp.replace(/^magic:/, ''));
    if (need === undefined) return `no pinned level for ${comp}`;
    if (magic < need) return `Magic ${magic} < ${need}`;
    if (laws < 1) return 'no law rune';
    return undefined;
};
export let bursts = 0;
// A planned conversation token: 'R' continue, 'F' fence to the next tick, or a choice component id.
export type PlanToken = 'R' | 'F' | number;
// Choice components of the multi-option dialogs: CHOICE[4][0] is option 1 of a four-option page.
export const CHOICE: Readonly<Record<2 | 3 | 4 | 5, readonly number[]>> = { 2: [2461, 2462], 3: [2471, 2472, 2473], 4: [2482, 2483, 2484, 2485], 5: [2494, 2495, 2496, 2497, 2498] };
// Recorded plans: talk-plans.json holds, for a quest script and a talk label, the clicks that talk took in a passing
// run. `talk` sends them as its plan the first time the label runs. TALK_PLANS=off ignores the file. TALK_RECORD=<dir>
// writes the clicks of this run to <dir>/<quest>.json; `bun scripts/measure/talk-plans.ts` moves them into the file.
// The quest script in use: the sweep runs a quest script inside its own process and names it in QUEST_SCRIPT_ID.
const questId = (): string => (globalThis as { QUEST_SCRIPT_ID?: string }).QUEST_SCRIPT_ID ?? basename(process.argv[1] ?? '', '.ts');
const PLAN_FILE = join(import.meta.dir, 'talk-plans.json');
const TALK_PLANS: Record<string, Record<string, PlanToken[]>> = process.env.TALK_PLANS !== 'off' && existsSync(PLAN_FILE) ? JSON.parse(readFileSync(PLAN_FILE, 'utf8')) : {};
const TALK_RECORD = process.env.TALK_RECORD;
const recordedPlans: Record<string, PlanToken[]> = {};
if (TALK_RECORD) process.on('exit', () => { try { mkdirSync(TALK_RECORD, { recursive: true }); writeFileSync(join(TALK_RECORD, `${questId()}.json`), JSON.stringify(recordedPlans)); } catch { /* a record is optional */ } });
export let recorded = 0;
// Q_BURST=1: blind dialogue bursts (research/quest-plan.md "Dialogue burst"); off by default.
const BURST = process.env.Q_BURST === '1';
if (BURST) process.on('exit', () => console.log(`NOTE bursts=${bursts} recorded=${recorded} Q_BURST=1`));

export interface Loc { id: number; x: number; z: number }
export const LUMBRIDGE = { x: 3222, z: 3218 };
// Ticks after a teleport click within which a landing by Lumbridge is the spell's, not a respawn.
export const TELEPORT_TICKS = 10;
export const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];

// lumbridgeOk: the script teleports to Lumbridge, so a jump there is not a death (respawn and life id still count).
// name: the account (default process.argv[2]). others: more sessions of a two-account quest (quest-arrav.ts); fail()
// and end() log them out too.
export async function openQuest(opts: { session?: Session; stop?:()=>boolean; cap?: number; eatAt?: number; food?: number[]; reservedFood?: Readonly<Record<number,number>>|(()=>Readonly<Record<number,number>>); trace?: boolean; lumbridgeOk?: boolean; name?: string; others?: () => Session[]; resend?: boolean } = {}) {
    const CAP = opts.cap ?? 3000;
    const EAT_AT = opts.eatAt ?? defaultEatAt;
    // Without a list of its own a quest eats anything that heals: a live account carries swordfish, cake slices or
    // trout, not the lobsters a preset does. quest-sweep marks the preset's edible ingredients on the session
    // (questReserved), and a script's reservedFood adds its own; neither is eaten.
    const FOOD = opts.food ?? [...questFoodDefinitions().keys()];
    const TRACE = opts.trace ?? process.env.Q_TRACE === '1';
    // quest-sweep.ts stages items and travel in its own login, then hands that session over here.
    const handoff = globalThis as { QUEST_SESSION?: Session; QUEST_SESSION_TAKEN?: () => void };
    const offered = handoff.QUEST_SESSION;
    const matching = offered && (!opts.name || offered.name.toLowerCase() === opts.name.toLowerCase());
    const s: Session = opts.session ?? (matching ? offered : undefined) ?? await openBot(opts.name ?? process.argv[2]!);
    // A quest session has no eat guard (packages/core/src/eat-guard.ts): a fish can be a quest item here. Only the
    // quest sustain below eats, with the reserve rules of the quest. The hold has no release.
    holdSessionEater(s.sdk);
    // quest-sweep's handoff waits for this before another bot in the same process may hand over its session.
    if (s === offered) handoff.QUEST_SESSION_TAKEN?.();
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
    // The tick of the last teleport click or routed walk: a jump that lands by Lumbridge within TELEPORT_TICKS of it,
    // or during a routed walk, is the Lumbridge teleport (the router casts the teleports the account can), not a
    // respawn. A death shows as isDead, a respawn count or a new life id.
    let lastCastAt = -TELEPORT_TICKS, routing = false;
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
    // An eat that the game dropped is sent again, twice at most (sustain.ts dropRetries).
    }},{food:FOOD,eatAt:EAT_AT,reserved:()=>reservedNow(),dropRetries:2,onConsumed:()=>{stats.eats++;}});
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
        if (h > 0 && h <= RETREAT_AT && !retreating && !lowHpPlanned && !foodLeft()) { retreating = true; console.log(`WARN retreat: hp ${h} of ${maxHp()}, no food, at ${T()}`); }
        if (p?.isDead || (p && p.respawnCount > respawn0) || (p && life0 !== undefined && p.lifeId !== life0)) stats.died = true;
        if (p && last && Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)) > 20) {
            jumps.push(`${T()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            if (!opts.lumbridgeOk && Math.max(Math.abs(p.worldX - LUMBRIDGE.x), Math.abs(p.worldZ - LUMBRIDGE.z)) <= 15 && T() > 5 && T() - lastCastAt > TELEPORT_TICKS && !routing) stats.died = true;
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
    // A step whose content takes the bot to low hitpoints with no harm (Koschei in The Fremennik Trials ends at 0 hp
    // and the trial passes) switches the retreat off for its length.
    let lowHpPlanned = false;
    const planLowHp = (on: boolean): void => { lowHpPlanned = on; };
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
    // One attack click, with no wait. bot.attack waits for the fight to start, and after a click that the engine
    // refuses (a knockback or a placement holds the player for a tick) it waited about 110 ticks while the bot stood
    // idle. A fight loop calls this again every few ticks.
    const attack = (n: any) => s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
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
            // The engine refuses an action sent while it holds the player (the tick after a gate, a placement, a
            // knockback) and sends no message. opFeedback counts the refusal. Without this the step waited its whole
            // bound: the trace showed 10 to 15 lost ticks each time. The step waits 2 ticks for an effect, because an
            // accepted action that stops the walk raises the count too, and then sends again, at most 4 times.
            // `resend: false` in openQuest keeps one send for each try: ikov, tree and grandtree are slower with it.
            const fast = opts.resend !== false;
            const rejected = () => (s.sdk.getState() as any)?.opFeedback?.opRejectedCount ?? 0;
            const until = () => ok() || stats.died || retreating || !!sustain.failure();
            const sentAt = s.tick();
            for (let quick = 0; ; quick++) {
                const r0 = rejected();
                await send();
                await waitUntil(s, () => until() || (fast && rejected() > r0), { timeoutTicks: Math.max(1, ticks - (s.tick() - sentAt)) });
                if (!fast || until() || rejected() <= r0 || quick >= 4 || s.tick() - sentAt >= ticks) break;
                await waitUntil(s, until, { timeoutTicks: 2 });
                if (until()) break;
            }
            await guard(label);
            if (ok()) return;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
        }
        await guard(label);
        if (!ok()) await fail(`step ${label}`);
    };

    // The clicks of the talk under record, or null.
    let recording: PlanToken[] | null = null;
    const plannedLabels = new Set<string>();
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
                if(!reply.success){if(s.tick()-planSentAt<=8){await waitTicks(s,1);continue;}await fail(`dialogue click refused: ${reply.message}`);}
                // A choice records its component; a choice with no component ends the record for this talk.
                if(recording){const clicked=choice?(opt??d.options[0])?.componentId:'R';if(clicked===undefined)recording=null;else recording.push(clicked);}
                if(s.tick()!==beforeClick)continue;
            }
            await waitTicks(s, 1);
        }
        return ok();
    };

    // A planned conversation, adapted from TestingPurposes/rs-stun-toolkit q-lib.ts `talk` (MIT). The whole token list
    // leaves in one write on the tick the first page shows: 'R' continues a page, a number clicks that choice
    // component (CHOICE below), and 'F' pads with CHAT_SETMODE, a counted packet with no game effect, to the next
    // multiple of five. The engine reads five user events a tick and carries the rest to the next tick in order, so a
    // fence puts the token after it on a later tick. A continue sent to a choice page is refused, never applied.
    // Returns the number of ticks the plan needs to drain.
    // While a plan drains, the SDK can show a page that the plan has answered: a refused click then is not a fault.
    let planSentAt = -100;
    const sendPlan = (plan: readonly PlanToken[]): number => {
        const c: any = (s as any).client;
        let n = 0;
        for (const t of plan) {
            if (t === 'R') { c.writeOpcode(RESUME); c.out.p2(c.chatModalId !== -1 ? c.chatModalId : 0); n++; }
            else if (t === 'F') { while (n % 5 !== 0) { c.writeOpcode(ClientProt.CHAT_SETMODE); c.out.p1(0); c.out.p1(0); c.out.p1(0); n++; } }
            else { c.writeOpcode(ClientProt.IF_BUTTON); c.out.p2(t); n++; }
        }
        c.flush?.();
        bursts++;
        answeredSeq = textSeq;
        planSentAt = s.tick();
        return Math.ceil(n / 5);
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
    const talk = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, home: { x: number; z: number }, maxTicks = 60, stopOpen = false, plan?: readonly PlanToken[]): Promise<void> => {
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
            // The plan goes out once, on the first open page; converse() answers whatever it leaves. A label uses its
            // recorded plan the first time it runs: a later talk with the same label can be at another stage.
            const first = i === 0 && !plannedLabels.has(label);
            plannedLabels.add(label);
            const planned = first ? plan ?? TALK_PLANS[questId()]?.[label] : undefined;
            if (planned && dialogOpen()) await waitTicks(s, sendPlan(planned));
            recording = TALK_RECORD && first && !planned ? [] : null;
            let shut = 0;
            await converse(pats, () => { shut = dialogOpen() ? 0 : shut + 1; return (ok() && (stopOpen || !dialogOpen())) || shut >= 3; }, maxTicks);
            if (ok()) { if (recording?.length) recordedPlans[label] = recording; recording = null; return; }
            recording = null;
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
            // The sweep's far walk first: hub to hub by the known banks, the Ardougne boats for a target east of the
            // mountain, and the world router for the last leg, which knows the ladders and doors between an upstairs end
            // (the Black Knights' Fortress's first floor, 3029,3505) and the ground. One routed walk from the Barbarian
            // Outpost to Falador (410 tiles) ran out its plan budget. The router casts the teleports the account can
            // (Lumbridge Teleport on the way to Varrock), so a landing by Lumbridge during the walk is not a respawn.
            // A death, the retreat threshold, a sustain failure or the tick cap abort the walk between and inside its
            // legs, and guard() then acts on them as after any walk.
            await guard(label);
            let routed: { ok: boolean; reason?: string };
            routing = true;
            const ac = new AbortController();
            const stopOff = s.onTick(() => { if (stats.died || retreating || sustain.failure() || T() > CAP) ac.abort('quest guard'); });
            try { routed = await walkFar(s, await getWorld(), { x, z, level: 0 }, 150, { signal: ac.signal }); }
            finally { stopOff(); routing = false; lastCastAt = T(); }
            console.log(`QUEST_TELEPORT_WALK ${JSON.stringify({ label, to: { x, z }, ok: routed.ok, reason: routed.ok ? undefined : routed.reason, at: pos() && { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level } })}`);
            await guard(label);
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
            const refusal = teleportRefusal(comp, magic(), cnt(563)) ?? 'short of a rune';
            await walk(`${label} (walk, ${refusal})`, [{ x, z, tol: 4 }]); return;
        }
        const xp0 = s.sdk.getState()?.skills?.find((k: any) => k.name === 'Magic')?.experience ?? 0;
        await step(label, () => { lastCastAt = T(); return s.direct({ type: 'clickComponent', componentId: componentId(comp), reason: 'SDK' }); }, () => near(x, z, 6), 8, 3);
        // The landing names the spell the click cast: a Magic XP gain with the player elsewhere is another teleport's.
        const xp1 = s.sdk.getState()?.skills?.find((k: any) => k.name === 'Magic')?.experience ?? 0;
        console.log(`QUEST_TELEPORT ${JSON.stringify({ label, comp, component: componentId(comp), to: { x, z }, at: pos() && { x: pos()!.worldX, z: pos()!.worldZ, level: pos()!.level }, magicXp: xp1 - xp0 })}`);
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

    // A bow account wields the bow and the arrows in its pack before a fight the quest script runs itself (Prince Ali's
    // jail guard, Hazeel Cult's Alomone): at a low Attack its hands cut nothing down. The sweep brings them as
    // QUEST_ARROWS; a pack without them wields nothing and the fight goes on as it stands.
    const BOWS = [841, 839, 843, 845], ARROWS = [884, 886, 882];
    const wieldBow = async (): Promise<void> => {
        const worn = () => s.sdk.getEquipment().map((i: any) => i.id);
        for (const ids of [BOWS, ARROWS]) {
            if (ids.some(id => worn().includes(id))) continue;
            const item: any = (st()?.inventory ?? []).find((i: any) => ids.includes(i.id));
            if (!item) return;
            await s.bot.equipItem(item);
            await waitUntil(s, () => worn().includes(item.id), { timeoutTicks: 5 });
        }
    };
    // One blow at an NPC in a fight the quest script runs itself, with the kit the account fights with: a bow in the pack
    // or worn is wielded and the Attack option clicked; without one, a strike spell the pack's runes allow is cast at the
    // cast rate (five ticks, player_magic.rs2) with the staff wielded; with neither, the Attack option alone. The sweep
    // brings the bow and QUEST_ARROWS, or the staff and QUEST_CASTS' runes, for a Ranged-over-Attack or Magic-over-Attack
    // account. A ranged or melee blow repeats on its own; a cast does not, so the caller calls again each few ticks.
    let lastStrikeAt = -Infinity;
    const strikeKit = (): MagicKit | null => {
        const magic = st()?.skills?.find((k: any) => k.name === 'Magic')?.baseLevel ?? 1;
        return magicKit([...(st()?.inventory ?? []), ...s.sdk.getEquipment()].map((i: any) => ({ id: i.id, count: i.count })), magic, 1);
    };
    const attackNpc = async (n: any): Promise<void> => {
        const worn = () => s.sdk.getEquipment().map((i: any) => i.id);
        const hasBow = BOWS.some(id => worn().includes(id) || (st()?.inventory ?? []).some((i: any) => i.id === id));
        const kit = hasBow ? null : strikeKit();
        if (kit) {
            if (kit.staff !== undefined && !worn().includes(kit.staff)) { const staff = (st()?.inventory ?? []).find((i: any) => i.id === kit.staff); if (staff) { await s.bot.equipItem(staff); await waitUntil(s, () => worn().includes(kit.staff!), { timeoutTicks: 5 }); } }
            if (T() - lastStrikeAt < 5) return;
            lastStrikeAt = T();
            await s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: componentId(kit.component), reason: 'SDK' });
            return;
        }
        if (hasBow) await wieldBow();
        await s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: n.optionsWithIndex?.find((o: any) => /attack/i.test(o.text))?.opIndex ?? 2, reason: 'SDK' });
    };
    // Before a melee fight of an account whose build has a level cap (a Defence 1 account): the style of the wielded
    // weapon, or of the bare hands, that gives its XP to Strength and Hitpoints only (giantStyle). The engine keeps one
    // style index for every weapon tab, so a fight needs this call after each change of the weapon. A tab with no such
    // style, or one the client does not know, fails the quest before the first hit.
    // The same for any one skill: `styleOnly(label, 'Ranged')` sets the bow style that trains only Ranged (rapid), so a
    // fight gives no Defence XP from the long range style.
    const styleOnly = async (label: string, skill: string): Promise<void> => {
        const tab = () => st()?.combatStyle;
        const wielded = (): string => s.sdk.getEquipment().find((i: any) => i.slot === 3)?.name || 'Unarmed';
        await waitUntil(s, () => !!tab()?.known && tab()?.weaponName === wielded(), { timeoutTicks: 10 });
        let style: ReturnType<typeof giantStyle>;
        try {
            if (tab()?.weaponName !== wielded()) throw Error(`combat tab shows ${tab()?.weaponName}, wielded ${wielded()}`);
            style = giantStyle(tab(), skill);
        } catch (e) { return fail(`${label}: no ${skill}-only style: ${e instanceof Error ? e.message : String(e)}`); }
        const set = () => { const c = tab(); return !!c?.known && c.currentStyle === style.index && c.weaponName === style.weapon; };
        if (!set()) await s.sdk.sendSetCombatStyle(style.index);
        if (!await waitUntil(s, set, { timeoutTicks: 10 })) await fail(`${label}: style ${style.name} of ${style.weapon} unobserved`);
        console.log(`STYLE ${label} ${style.weapon} ${style.index} ${style.name} ${T()}`);
    };
    const strengthStyle = (label: string): Promise<void> => styleOnly(label, 'Strength');
    return {
        s, st, pos, inv, hp, xp, cnt, has, slot, cheb, near, lvl, dialogOpen, sawText, msgCount, T, stats, milestone, dispose, strengthStyle, styleOnly,
        blockDoor, guard, planLowHp, fail, end, gains, detail, opLoc, locs, findLoc, locAt, opIndex, npc, talkTo, attack, useOnLoc, useOnNpc, useOnItem,
        step, converse, walk, talk, climb, teleport, canCast, openDoor, shutAt, dash, wieldBow, attackNpc,
        waitTicks: async (n: number) => { const until=s.tick()+n;if(n>0)await waitUntil(s,()=>s.tick()>=until||stats.died||retreating||T()>CAP,{timeoutTicks:n,signal:sustain.aborted});await guard('wait'); },
        waitUntil: async (f: () => boolean, ticks: number) => {const reached=await waitUntil(s, () => f() || stats.died||retreating||T()>CAP, { timeoutTicks: ticks,signal:sustain.aborted });await guard('wait condition');return reached;},
    };
}
