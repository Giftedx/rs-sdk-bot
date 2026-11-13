import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import { atTile, checked, levelIs, type Outcome } from './act';
import { waitTicks } from './ticks';
import { watchTickStream } from './tick-stream';
import type { TickSource } from './ticks';
import { blockedDoorsNear,installDoorPolicy,transportAllowed,interactionApproach,canonicalTransportLeg, type Account, type Door, type Leg, type Tile, type World, ROUTE_BUDGET_MS,type DoorBlock } from './world';
import {accountForSdk,withDoorPolicy} from './door-policy';
import {guardWalk} from './danger';
import {disembark,type BoatSession} from './boat';
import {componentId} from './logout';
import {clientReach} from './reach';
import {planTripOffThread} from './route-plan';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {bankStock,planTrip,takeItems,type TripPlan} from './trip';
import {travelAllowed} from './travel';
import {refreshGuildEvidence} from './guild-observation';

export interface Walker extends TickSource {
    client?:unknown;
    sdk: TickSource['sdk'] & { blockDoorTemporarily?(level: number, x: number, z: number, ttlMs?: number): boolean };
    bot: {
        walkTo(x: number, z: number, tolerance?: number): Promise<unknown>;
        interactLoc(target: unknown, option?: number | string | RegExp): Promise<unknown>;
        openDoor?(target?: unknown): Promise<unknown>;
    };
}

// planBudgetMs bounds the route search (world.ts ROUTE_BUDGET_MS when absent); a search over budget is 'no route (budget)'.
export interface WalkOptions { maxRetriesPerLeg?: number; legTimeoutTicks?: number; signal?: AbortSignal; planBudgetMs?: number }

const cheb = (a: Tile, b: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - b.worldX), Math.abs(a.z - b.worldZ));

// Runs route legs in order. Each leg is a checked action; a leg is retried from wherever the bot really is,
// so a non-exact arrival (Review Focus 4) just becomes the next leg's start.
export async function walkRoute(s: Walker, legs: Leg[], opts: WalkOptions = {}): Promise<Outcome> {
    const start = s.tick();
    return cancellable(opts, async (_wrap, signal) => {
        try { return await walkRouteInner(s, legs, { ...opts, signal }); }
        catch (error) {
            if (signal.aborted) return { ok: false, reason: 'aborted', detail: String(signal.reason ?? 'aborted'), ticks: s.tick() - start };
            throw error;
        }
    });
}

async function walkRouteInner(s: Walker, legs: Leg[], opts: WalkOptions): Promise<Outcome> {
    const retries = opts.maxRetriesPerLeg ?? 3;
    let total = 0;
    for (const leg of legs) {
        let last: Outcome | null = null;
        for (let attempt = 0; attempt < retries; attempt++) {
            last = leg.kind === 'walk' ? await (farWalk(s, leg.to) ? walkFar(s, leg.to, opts, leg.tolerance ?? 2) : walkLeg(s, leg.to, opts, leg.tolerance ?? 2))
                : leg.kind === 'travel' ? await travelLeg(s, leg, opts) : await climbLeg(s, leg, opts);
            total += last.ticks;
            if (last.ok || last.reason === 'aborted' || leg.kind === 'travel' && leg.travel.run.how === 'npc' && leg.travel.run.button) break;
            // Right after a climb the server refuses movement until the arrival delay ends (seen live: 3 quick
            // retries all refused within 11 ticks). Wait a little longer before each retry.
            if (last.reason === 'rejected') await waitTicks(s, 2 * (attempt + 1));
            // rs-sdk's pathfinder treats every door as open, so a walk can stop behind a shut one and the
            // client then refuses the climb with "Can't reach". Open the shut door nearest the stair and retry.
            if (leg.kind === 'transport' && last.reason === 'rejected' && /reach/i.test(last.detail)) {
                await openNearestDoor(s, leg.at);
                // walkTo opens doors on its own route, which covers a shut door outside the 8-tile search.
                await s.bot.walkTo(leg.at.x, leg.at.z, 1);
            }
        }
        if (!last!.ok) return { ...last!, ticks: total };
    }
    return { ok: true, ticks: total };
}

// One travel edge (travel.ts): talk to the NPC and answer its dialogue, cast the spell, rub the jewellery or
// operate the lever or tree; then cross the gangplank when the edge lands on a ship deck. Ok when the player
// stands within 8 tiles of the edge's arrival tile.
async function travelLeg(s: Walker, leg: Extract<Leg, { kind: 'travel' }>, opts: WalkOptions): Promise<Outcome> {
    const start = s.tick(), t = leg.travel, run = t.run, b = s as unknown as BoatSession & { direct(a: unknown): Promise<unknown> };
    const stop = () => opts.signal?.aborted === true, st = () => s.sdk.getState() as any;
    const here = () => { const p = st()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
    const arrived = () => { const p = st()?.player; return !!p && p.level === t.to.level && cheb(t.to, p) <= 8; };
    const fail = (reason: 'rejected' | 'timeout' | 'precondition' | 'aborted', detail: string): Outcome => ({ ok: false, reason: stop() ? 'aborted' : reason, detail: `${t.name}: ${detail}`, ticks: s.tick() - start });
    const choices = run.how === 'npc' ? run.options : run.how === 'gate' ? run.choices : run.how === 'rub' || run.how === 'loc' ? (run.option ? [run.option] : []) : [];
    const answer = async (until: () => boolean, ticks: number) => {
        for (let i = 0; i < ticks && !until() && !stop(); i++) {
            const d = b.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const norm = (x: string) => x.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
                const opt = d.options.find(o => choices.some(c => norm(o.text) === norm(c)));
                await b.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
    };
    const onDeck = () => here()?.level === 1;
    if (run.how === 'npc') {
        const npc = (st()?.nearbyNpcs ?? []).filter((n: any) => n.name?.toLowerCase() === run.npc.toLowerCase()).sort((x: any, y: any) => (x.distance ?? 0) - (y.distance ?? 0))[0];
        if (!npc) return fail('precondition', `no ${run.npc} in sight`);
        if (run.button) {
            const client = s.client as { executeBotAction?: unknown } | undefined, executor = client?.executeBotAction, sdk = s.sdk;
            const first = st()?.player, life = first?.lifeId, respawns = first?.respawnCount ?? 0;
            const unsafe = () => stop() || s.client !== client || s.sdk !== sdk || client?.executeBotAction !== executor || typeof executor !== 'function'
                || !Number.isSafeInteger(life) || !st()?.player || st().player.isDead || st().player.lifeId !== life || (st().player.respawnCount ?? 0) !== respawns;
            const button = run.button.component, namespace = button.split(':')[0]!;
            if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(button)) return fail('precondition', 'invalid native travel button');
            let main: number, component: number;
            try { main = componentId(namespace); component = componentId(button); } catch { return fail('precondition', 'unknown native travel interface/button'); }
            const mapOpen = () => st()?.modalInterface === main || st()?.interface?.isOpen === true && st()?.interface?.interfaceId === main;
            const landed = () => { const p = here(); return !!p && p.level === t.to.level && Math.max(Math.abs(p.x-t.to.x),Math.abs(p.z-t.to.z)) <= 1; };
            if (unsafe()) return fail('aborted', 'original travel input owner/life unavailable');
            try {
                await b.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: run.op, reason: 'SDK' });
                const answered = new Set<string>();
                for (let i=0;i<60&&!mapOpen()&&!unsafe();i++) {
                    const d = b.sdk.getDialog();
                    if (d?.isOpen && !d.isWaiting) {
                        const key = 'pageId' in d && typeof d.pageId === 'string' ? d.pageId : JSON.stringify(d), norm = (v:string)=>v.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g,'');
                        if (!answered.has(key)) {
                            const option = d.options.find(o=>run.options.some(c=>norm(o.text)===norm(c)));
                            if (!option && (d.options.length>1 || d.options.length===1 && !/continue/i.test(d.options[0]!.text))) return fail('precondition','unmapped native travel dialogue');
                            if (unsafe()) return fail('aborted','travel owner changed before dialogue');
                            answered.add(key);
                            await b.direct({type:'clickDialogOption',optionIndex:option?.index??d.options[0]?.index??0,reason:'SDK'});
                        }
                    }
                    if (unsafe()) return fail('aborted','travel owner changed after dialogue');
                    await waitTicks(s,1);
                }
                if (unsafe()) return fail('aborted','travel owner changed before button');
                if (!mapOpen()) return fail('precondition','expected native travel interface unobserved');
                // This dispatch is not retried: an absent acknowledgement cannot prove non-payment.
                const sent = await b.direct({type:'clickComponent',componentId:component,reason:'SDK'});
                if ((sent as {success?:boolean}|undefined)?.success !== true) return fail('rejected','native travel button outcome uncertain');
                for(let i=0;i<12&&!landed()&&!unsafe();i++)await waitTicks(s,1);
                if(unsafe())return fail('aborted','travel owner/life changed during landing');
                return landed()?{ok:true,ticks:s.tick()-start}:fail('timeout','native travel button landing unobserved');
            } catch(error) { return fail(stop()?'aborted':'rejected',`native travel outcome uncertain: ${String(error)}`); }
        }
        await b.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: run.op, reason: 'SDK' });
        await answer(() => arrived() || (!!run.deck && onDeck()), 60);
        if (run.deck && onDeck()) { const off = await disembark(b, { stop }); if (!off.ok) return fail('timeout', off.detail); }
    } else if (run.how === 'spell') {
        // The plan admitted the spell on the account as it stood when the route was planned; a cast on the way can have
        // spent the runes since, and the server refuses a short cast with a message the walker does not read.
        if (!travelAllowed(t, accountForSdk(s.sdk))) return fail('precondition', `cannot cast now (needs ${t.runes.map(r => `${r.count} ${r.item}`).join(', ')})`);
        await b.direct({ type: 'clickComponent', componentId: componentId(run.component), reason: 'SDK' });
        await answer(arrived, 12);
    } else if (run.how === 'rub') {
        const ids = new Set(run.items.map(itemId).filter((i): i is number => i !== undefined));
        const item = (st()?.inventory ?? []).find((i: any) => ids.has(i.id));
        if (!item) return fail('precondition', 'no charged item in the pack');
        await b.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: 4, reason: 'SDK' });
        await answer(arrived, 20);
    } else if (run.how === 'gate') {
        // A scripted gate: click its action, answer the dialogue, then step to the far tile while it stands open. The gate
        // loc stands up to two tiles from the recorded entrance tile (gnome_areagate 190 at 2459,3383; the record names
        // its south entrance, 2461,3382). Femi's box dialogue at that gate (femi.rs2) ends with the player still outside
        // and the gate shut; the next click opens it, so the click repeats while the player is not through.
        const want = run.action.toLowerCase(), near = (l: any) => l.level === run.at.level && Math.max(Math.abs(l.x - run.at.x), Math.abs(l.z - run.at.z)) <= 2;
        const gateOf = () => (st()?.nearbyLocs ?? []).filter((l: any) => near(l) && l.name?.toLowerCase() === run.loc.toLowerCase() && (l.optionsWithIndex ?? []).some((o: any) => o.text?.toLowerCase() === want))
            .sort((x: any, y: any) => cheb(run.at, { worldX: x.x, worldZ: x.z }) - cheb(run.at, { worldX: y.x, worldZ: y.z }))[0];
        const through = () => { const p = here(); return !!p && p.level === t.to.level && cheb(t.to, { worldX: p.x, worldZ: p.z }) <= 1; };
        // Across: nearer the far side than the near side (the Stronghold gate force-moves the player to 2461,3385, two
        // tiles from the far tile 2459,3385); another click from there would open the gate back out.
        const across = () => { const p = here(); return !!p && p.level === t.to.level && (!t.from || cheb(t.to, { worldX: p.x, worldZ: p.z }) < cheb(t.from, { worldX: p.x, worldZ: p.z })); };
        const dialogOpen = () => b.sdk.getDialog()?.isOpen === true;
        for (let i = 0; i < 3 && !across() && !stop(); i++) {
            const gate = gateOf();
            if (!gate) return fail('precondition', `no ${run.loc} with ${run.action} at ${run.at.x},${run.at.z}`);
            const op = gate.optionsWithIndex.find((o: any) => o.text?.toLowerCase() === want).opIndex;
            await b.direct({ type: 'interactLoc', x: gate.x, z: gate.z, locId: gate.id, optionIndex: op, reason: 'SDK' });
            // Until the player is through, or a dialogue that opened has stayed shut three ticks (Femi's box cutscene
            // closes its chat between its animations).
            let talked = false, shut = 0;
            await answer(() => { if (dialogOpen()) { talked = true; shut = 0; } else if (talked) shut++; return across() || shut >= 3; }, 40);
            if (!across()) await waitTicks(s, 3);
        }
        for (let i = 0; i < 3 && !through() && !stop(); i++) { await b.direct({ type: 'walkTo', x: t.to.x, z: t.to.z, running: true, reason: 'SDK' }); await waitTicks(s, 4); }
        return through() ? { ok: true, ticks: s.tick() - start } : fail('timeout', `not through ${run.loc} (at ${JSON.stringify(here())})`);
    } else {
        const name = run.loc.includes('spirit') ? /spirit tree/i : /lever|door/i, at = run.at;
        const loc = (st()?.nearbyLocs ?? []).filter((l: any) => at && run.id !== undefined ? l.id === run.id && l.x === at.x && l.z === at.z && l.level === at.level : name.test(l.name ?? ''))
            .sort((x: any, y: any) => (x.distance ?? 0) - (y.distance ?? 0))[0];
        if (!loc) return fail('precondition', `no ${run.loc} in sight`);
        await b.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: run.op, reason: 'SDK' });
        // A short passage on one floor (the Grand Tree door moves the player two tiles) ends on its landing: within 8
        // tiles of it the player already stood, on the wrong side.
        const short = !!t.from && t.from.level === t.to.level && cheb(t.from, { worldX: t.to.x, worldZ: t.to.z }) <= 8;
        const landed = () => { const p = here(); return !!p && p.level === t.to.level && cheb(t.to, { worldX: p.x, worldZ: p.z }) <= 1; };
        await answer(short ? landed : arrived, 20);
        if (short && !landed()) return fail('timeout', `not through ${run.loc} to ${t.to.x},${t.to.z} (at ${JSON.stringify(here())})`);
    }
    return arrived() ? { ok: true, ticks: s.tick() - start } : fail('timeout', `not at ${t.to.x},${t.to.z},${t.to.level} (at ${JSON.stringify(here())})`);
}

let itemIds: Map<string, number> | undefined;
function itemId(debugname: string): number | undefined {
    itemIds ??= new Map((JSON.parse(readFileSync(join(resolve(import.meta.dir, '..', '..', '..'), 'knowledge', 'items.json'), 'utf8')) as { id: number; debugname: string }[]).map(i => [i.debugname, i.id]));
    return itemIds.get(debugname);
}

async function openNearestDoor(s: Walker, near: Tile): Promise<void> {
    const doors = (s.sdk.getState()?.nearbyLocs ?? [])
        .filter((l: any) => l.level === near.level && (l.options ?? []).some((o: string) => /^open$/i.test(o)))
        .map((l: any) => ({ l, d: Math.max(Math.abs(l.x - near.x), Math.abs(l.z - near.z)) }))
        .filter((x: { d: number }) => x.d <= 8)
        .sort((a: { d: number }, b: { d: number }) => a.d - b.d);
    if (doors.length > 0 && s.bot.openDoor) await s.bot.openDoor(doors[0].l);
}

// Runs one leg's bot.* call inside its own SDK execution context (sdk/execution-context.ts). The context's
// signal fires when the leg's outcome is decided or the caller aborts (reflex), so a long bot.walkTo stops
// instead of fighting the flee walk.
async function cancellable(opts: WalkOptions, leg: (send: (f: () => Promise<unknown>) => () => Promise<unknown>, signal: AbortSignal) => Promise<Outcome>): Promise<Outcome> {
    const ac = new AbortController();
    const parent = executionContext.getStore();
    const parents = [...new Set([opts.signal, parent?.signal].filter((s): s is AbortSignal => !!s))];
    const listeners = parents.map(signal => {
        const abort = () => ac.abort(signal.reason ?? 'aborted');
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        return () => signal.removeEventListener('abort', abort);
    });
    const wrap = (f: () => Promise<unknown>) => () => executionContext.run({ ...parent, signal: ac.signal }, f).catch(e => ({ success: false, message: String(e) }));
    try {
        return await executionContext.run({ ...parent, signal: ac.signal }, () => leg(wrap, ac.signal));
    } finally {
        for (const off of listeners) off();
        if (!ac.signal.aborted) ac.abort('leg done');
    }
}

// A long walk leg (a world-graph region can span hundreds of tiles) goes through walkPath: one findLongPath plan,
// then 20-tile client clicks. bot.walkTo re-queries a 500-waypoint path every step, which used 183 s of CPU on an
// Ardougne-to-Varrock leg and froze the session ('walk to 2897,3428,0: no effect in 100 ticks').
export const FAR_WALK_TILES = 30;
function farWalk(s: Walker, to: Tile): boolean {
    const p = s.sdk.getState()?.player;
    return !!p && p.level === to.level && cheb(to, p) > FAR_WALK_TILES && typeof (s as { direct?: unknown }).direct === 'function';
}
async function walkFar(s: Walker, to: Tile, opts: WalkOptions, tolerance: number): Promise<Outcome> {
    const start = s.tick(), p = s.sdk.getState()?.player, budget = Math.max(opts.legTimeoutTicks ?? 0, p ? cheb(to, p) * 3 + 60 : 600);
    const deps = await sessionWalker(s as unknown as Parameters<typeof sessionWalker>[0]);
    const r = await walkPath(deps, [{ x: to.x, z: to.z, tol: tolerance }], { maxTicks: budget, signal: opts.signal });
    return r.ok ? { ok: true, ticks: s.tick() - start }
        : { ok: false, reason: opts.signal?.aborted ? 'aborted' : 'timeout', detail: `far walk to ${to.x},${to.z},${to.level}: ${r.detail ?? 'not arrived'}`, ticks: s.tick() - start };
}

function walkLeg(s: Walker, to: Tile, opts: WalkOptions,tolerance:number): Promise<Outcome> {
    return cancellable(opts, (wrap, signal) => walkLegInner(s, to, { ...opts, signal }, wrap,tolerance));
}

function walkLegInner(s: Walker, to: Tile, opts: WalkOptions, wrap: (f: () => Promise<unknown>) => () => Promise<unknown>,tolerance:number): Promise<Outcome> {
    const p = s.sdk.getState()?.player;
    // A long walk keeps running inside walkTo, so the budget grows with distance.
    const budget = opts.legTimeoutTicks ?? (p ? cheb(to, p) * 2 + 30 : 60);
    return checked(s, {
        name: `walk to ${to.x},${to.z},${to.level}`,
        pre: st => (st?.player?.level === to.level ? null : `on level ${st?.player?.level}, leg is on level ${to.level}`),
        send: wrap(() => s.bot.walkTo(to.x, to.z, tolerance)),
        rejectOnFeedback: false,
        effect: atTile(to.x, to.z, to.level, tolerance),
        timeoutTicks: budget,
        signal: opts.signal,
    });
}

function climbLeg(s: Walker, leg: Extract<Leg, { kind: 'transport' }>, opts: WalkOptions): Promise<Outcome> {
    const canonical=canonicalTransportLeg(leg);
    if(!canonical)return Promise.resolve({ok:false,reason:'precondition',detail:'legacy transport destination does not match its canonical physical route',ticks:0});
    return cancellable(opts, (wrap, signal) => climbLegInner(s, canonical, { ...opts, signal }, wrap));
}

function climbLegInner(s: Walker, leg: Extract<Leg, { kind: 'transport' }>, opts: WalkOptions, wrap: (f: () => Promise<unknown>) => () => Promise<unknown>): Promise<Outcome> {
    const findLoc = (st: any) => (st?.nearbyLocs ?? []).find((l: any) => l.x === leg.at.x && l.z === leg.at.z && l.level === leg.at.level&&(!leg.interaction||l.id===leg.interaction.id));
    const arrive = atTile(leg.to.x, leg.to.z, leg.to.level, leg.exact ? 0 : 3);
    const onLevel = levelIs(leg.to.level);
    return checked(s, {
        name: `${leg.loc} ${leg.option} at ${leg.at.x},${leg.at.z},${leg.at.level}`,
        pre: st => leg.interaction&&st?.player?.level!==leg.at.level?'transport is on another plane':!transportAllowed(leg,accountForSdk(s.sdk))?'transport prerequisites not observed':leg.entry&&(st?.player?.worldX!==leg.entry.x||st?.player?.worldZ!==leg.entry.z||st?.player?.level!==leg.entry.level)?'not at required transport entry':(findLoc(st) ? null : `no loc at ${leg.at.x},${leg.at.z},${leg.at.level}`),
        send: wrap(async () => {
            const op=Number(leg.option.replace(/^op/, ''));
            let reply:unknown;
            if(leg.interaction&&!leg.entry){
                const endpoint=await interactionApproach(s.sdk,leg.at,leg.interaction);
                if(opts.signal?.aborted)return {success:false,message:'transport approach cancelled'};
                if(!endpoint)return {success:false,message:'no operable transport approach'};
                const atEndpoint=()=>{const p=s.sdk.getState()?.player;return p?.level===endpoint.level&&p.worldX===endpoint.x&&p.worldZ===endpoint.z;};
                if(!atEndpoint()){
                    const moved=await walkLeg(s,endpoint,opts,0);
                    if(!moved.ok)return {success:false,message:`transport approach failed: ${moved.detail??moved.reason}`};
                }
                if(opts.signal?.aborted)return {success:false,message:'transport approach cancelled'};
                const fresh=await interactionApproach(s.sdk,leg.at,leg.interaction),state=s.sdk.getState(),p=state?.player;
                if(opts.signal?.aborted)return {success:false,message:'transport approach cancelled'};
                if(!fresh||!p||p.level!==fresh.level||p.worldX!==fresh.x||p.worldZ!==fresh.z||!findLoc(state)||!transportAllowed(leg,accountForSdk(s.sdk)))return {success:false,message:'transport approach or prerequisites changed'};
                const send=(s.sdk as any).sendInteractLoc;
                if(typeof send!=='function')return {success:false,message:'geometry transport dispatch unavailable'};
                // BotActions pre-walks toward the anchor when its distance>2,
                // which can leave the only allowed face of a large staircase.
                reply=await send.call(s.sdk,leg.at.x,leg.at.z,leg.interaction.id,op);
            }else reply=await s.bot.interactLoc(findLoc(s.sdk.getState()),op);
            const r=reply as {success?:boolean;reason?:string;message?:string}|null;
            // The SDK's idle grace can end before a stair transition is published.
            // Its generic map-flag rejection has the same ambiguity. Neither proves refusal.
            const pending=r?.success===false && (
                (r.reason==='timeout' && /^(Nothing happened|Timed out) interacting with /i.test(r.message??'')) ||
                (r.reason==='rejected' && /^Server discarded the interaction with /i.test(r.message??'')));
            return pending ? undefined : reply;
        }),
        // Arrival also clears the map flag. Only the requested floor AND landing prove this leg.
        rejectOnFeedback: false,
        effect: (b, n) => leg.landing ? !!n?.player&&n.player.level===leg.landing.level&&n.player.worldX>=leg.landing.minX&&n.player.worldX<=leg.landing.maxX&&n.player.worldZ>=leg.landing.minZ&&n.player.worldZ<=leg.landing.maxZ : onLevel(b, n) && arrive(b, n),
        // interactLoc first walks round to a usable side of the loc (24 ticks measured for a 2x2 staircase).
        timeoutTicks: opts.legTimeoutTicks ?? 60,
        signal: opts.signal,
    });
}

// Off a ship's deck by its gangplank: 'ground' when the account stood on a deck and now stands on level 0, 'none'
// when it was not on a deck (level 1 with a gangplank within DECK_REACH tiles), 'stuck' when the crossing failed.
export const DECK_REACH = 3;
export async function leaveDeck(s: Walker, stop: () => boolean = () => false): Promise<'none' | 'ground' | 'stuck'> {
    const p = s.sdk.getState()?.player, b = s as unknown as BoatSession;
    if (!p || p.level !== 1 || typeof b.sdk.findNearbyLoc !== 'function') return 'none';
    const plank = b.sdk.findNearbyLoc(/^gangplank$/i) as { x?: number; z?: number; distance?: number } | null | undefined;
    const near = !!plank && (plank.distance ?? Math.max(Math.abs((plank.x ?? 0) - p.worldX), Math.abs((plank.z ?? 0) - p.worldZ))) <= DECK_REACH;
    if (!near) return 'none';
    const off = await disembark(b, { stop });
    console.log(`WALK_DECK from=${p.worldX},${p.worldZ},${p.level} ${off.ok ? 'crossed' : 'stuck'} ${off.detail}`);
    return off.ok ? 'ground' : 'stuck';
}

export async function goTo(s: Walker, world: World, to: Tile, acct: Account, opts: WalkOptions = {}): Promise<Outcome> {
    const started=s.tick();
    let legendsEntry:'crossed'|'refused'|'unknown'|undefined;
    await installDoorPolicy(s.sdk,s.client);
    if(s.client){
        const before=s.sdk.getState()?.player;
        const requests: string[]=[];
        const legendsTarget=to.x>=2725&&to.x<=2748&&to.z>=3350&&to.z<=3385;
        if(before&&Math.abs(before.worldX-2570)<=8&&Math.abs(before.worldZ-3441)<=8&&to.level>before.level&&Math.abs(to.x-2570)<=8&&Math.abs(to.z-3441)<=8)requests.push('dwarf-tower');
        if(before&&before.level===0&&before.worldX>=3041&&before.worldX<=3062&&Math.abs(before.worldZ-3483)<=5&&to.level===1&&to.x>=3040&&to.x<=3063&&to.z>=3465&&to.z<=3488)requests.push('prayer-guild');
        if(before&&legendsTarget&&Math.abs(before.worldX-2728)<=30&&Math.abs(before.worldZ-3373)<=30)requests.push('legendsquest');
        if(before&&legendsTarget&&before.level===0&&before.worldX>=2725&&before.worldX<=2732&&before.worldZ>=3344&&before.worldZ<=3349)requests.push('legends-entry');
        if(requests.length){const fresh=await refreshGuildEvidence(s as any,requests as any);if(requests.includes('legends-entry'))legendsEntry=fresh.admission?.legendsEntry??'unknown';}
        acct=accountForSdk(s.sdk);
    }
    // A ferry lands on its ship's deck, level 1, and the walk crosses the gangplank next (travelLeg). A session cut
    // between the two starts its next walk on the deck, and no route leaves a deck (live: an account stood on the
    // Brimhaven deck at 2775,3234,1 until it was moved by hand; practice: "no route" at tick 0 from that tile). So a
    // walk that starts on level 1 beside a gangplank crosses it first.
    if (await leaveDeck(s, () => opts.signal?.aborted === true) === 'stuck') return { ok: false, reason: 'precondition', detail: 'on a ship deck and the gangplank did not take the account off', ticks: s.tick() - started };
    // The prayer probe may itself climb. Capture start and actor after it returns.
    const p = s.sdk.getState()?.player;
    if (!p) return { ok: false, reason: 'precondition', detail: 'no player state', ticks: 0 };
    const from = { x: p.worldX, z: p.worldZ, level: p.level };
    // A guarded first entry has already asked the server. A refusal cannot
    // become a global portal search, and missing publication is still unknown.
    const observedInside=from.level===0&&from.x>=2728&&from.x<=2729&&from.z>=3350&&from.z<=3351;
    if(!observedInside&&legendsEntry==='refused')return {ok:false,reason:'precondition',detail:'Legends Guild guard refused first entry',ticks:s.tick()-started};
    if(!observedInside&&legendsEntry==='unknown'&&(acct.questStages?.legendsquest??0)<1)return {ok:false,reason:'precondition',detail:'Legends Guild first entry was not observed',ticks:s.tick()-started};
    // A session with a bank snapshot may stop at a bank for fares first (trip.ts).
    const name=(s as {name?:string}).name,banker=s as unknown as Parameters<typeof takeItems>[0];
    const stock=name&&typeof (banker.bot as {openBank?:unknown}).openBank==='function'?bankStock(name):undefined;
    const budgetMs=opts.planBudgetMs??ROUTE_BUDGET_MS,planStart=performance.now(),deadline=planStart+budgetMs;
    let why='';
    const r = world.offThread?await planTripOffThread(from,to,acct,stock,budgetMs)
        :stock?planTrip(world,from,to,acct,stock,undefined,undefined,{deadline})
        :(()=>{const d=world.route(from,to,acct,{deadline});if(!d.ok)why=d.reason;return d.ok?{cost:d.cost,legs:d.legs} as TripPlan:null;})();
    if (!r) {
        // What the failed search started from: a live "no route" names only its target otherwise.
        console.log(`WALK_NO_ROUTE ${JSON.stringify({ from, to, ms: Math.round(performance.now() - planStart), budgetMs, bank: !!stock, coins: acct.coins ?? 0 })}`);
        return { ok: false, reason: 'precondition', detail: `no route${why==='budget'?` (search over ${budgetMs} ms)`:''} to ${to.x},${to.z},${to.level}`, ticks: 0 };
    }
    // Actor prerequisites are synchronous query masks, not long-lived refusal
    // walls: gear/stat changes and allowed exits must be re-evaluated.
    let first = await walkRoute(s, r.legs, opts);
    // A spell leg that failed (the runes gone, a cast the server did not take) is not tried again: the route is planned
    // once more for the account without its law runes, so the walk goes by foot and boat from where it stands.
    if (!first.ok && first.reason !== 'aborted' && r.legs.some(l => l.kind === 'travel' && l.travel.kind === 'spell')) {
        // A trip with a bank stop ends its first legs at the bank, so the replan heads there and the stop still follows.
        const q = s.sdk.getState()?.player, at = q ? { x: q.worldX, z: q.worldZ, level: q.level } : from, goal = r.bank?.at ?? to, grounded = withoutSpells(acct);
        const d = world.offThread ? await planTripOffThread(at, goal, grounded, undefined, budgetMs)
            : (() => { const x = world.route(at, goal, grounded, { deadline: performance.now() + budgetMs }); return x.ok ? { cost: x.cost, legs: x.legs } as TripPlan : null; })();
        console.log(`WALK_REPLAN_NO_SPELLS ${JSON.stringify({ from: at, to: goal, failed: first.detail, ok: !!d })}`);
        if (d) first = await walkRoute(s, d.legs, opts);
    }
    if (!first.ok || !r.bank) return first;
    const took = await takeItems(banker, r.bank.coins, r.bank.items, n => waitTicks(s, n));
    if (!took.ok) return { ok: false, reason: 'precondition', detail: `bank stop at ${r.bank.at.x},${r.bank.at.z}: ${took.detail}`, ticks: s.tick() - started };
    const rest = await walkRoute(s, r.bank.then, opts);
    return rest.ok ? { ok: true, ticks: s.tick() - started } : rest;
}

// The account with no law rune: no teleport spell is castable, so a route planned for it keeps to the ground.
export const withoutSpells = (a: Account): Account => ({ ...a, items: a.items.filter(i => i !== 'lawrune'), counts: { ...a.counts, lawrune: 0 } });

// ---- walkPath: walk through points the way a player clicks ahead on the minimap ----
// bot.walkTo clicks each path corner and waits until the bot is within 2 tiles of it. The bot then takes 1 step
// or none in that tick, and at a door it waits for the open, then 1 more tick (research/walking.md). walkPath
// decides on every tick: it clicks `look` tiles ahead along a precomputed path before the last click runs out,
// opens a shut door on the path with one loc click and clicks past it on the tick it opens, and clicks again
// after 1 tick with no step. It sends at most one input per tick.

export interface PathTile { x: number; z: number }
export interface PathPoint extends PathTile { tol?: number }
export interface PathLoc { x: number; z: number; id: number; name?: string; optionsWithIndex?: { text: string; opIndex: number }[] }
export interface PathDeps {
    tick?(): number | undefined;
    pos(): { x: number; z: number; level: number } | null;
    onTick(cb: () => void): () => void;
    ended?: Promise<unknown>;
    walk(x: number, z: number): unknown;
    interactLoc(loc: PathLoc, op: number): unknown;
    // Clicks the run button on (controls:com_5). Sent once, before the first walk click.
    runOn?(): unknown;
    locs(): PathLoc[];
    messages?(): readonly { text: string; tick: number; observationId?: number }[];
    blockDoor?(level: number, loc: PathTile): boolean;
    doorBlocked?(level: number, loc: PathTile): boolean;
    // Path corners from `from` to `to`, without `from` (the rs-sdk findLongPath format).
    plan(level: number, from: PathTile, to: PathTile): PathTile[];
    // Whether the client can walk from the bot's tile to `to` in its loaded scene (reach.ts); null when unknown.
    reach?(to: { x: number; z: number; level: number }, opts?: { adjacentOk?: boolean }): boolean | null;
}
export interface PathOptions {
    signal?: AbortSignal;
    idleMs?: number;        // monotonic deadline for a client that stops publishing game ticks
    look?: number;          // tiles ahead to click (default 20; the client routes inside its 104x104 scene)
    reclickAt?: number;     // click again when this many tiles of the last click remain (default 6: 3 ticks running)
    maxTicks?: number;      // tick budget (default: path tiles + 60)
    stop?: () => boolean;   // checked on every tick (death, abort)
    log?: (msg: string) => void;
}
// `next` is the index of the first point the bot has not passed yet: a retry can start from points.slice(next).
export interface PathResult { ok: boolean; ticks: number; still: number; clicks: number; repaths: number; doors: number; next: number; detail?: string }

const d8 = (a: PathTile, b: PathTile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
// Open chests and cupboards are not route edges. Legacy path adapters omit names;
// live SDK locations supply them. Preserve unnamed adapters' door contract.
const openOp = (l: PathLoc) => l.name && !/\b(?:doors?|gates?)\b/i.test(l.name)
    ? undefined : (l.optionsWithIndex ?? []).find(o => /^open$/i.test(o.text));

// Corners to single tiles. rs-sdk path segments are straight or diagonal, so a step by sign is exact for them.
export function expandPath(from: PathTile, corners: PathTile[]): PathTile[] {
    const out: PathTile[] = [];
    let cx = from.x, cz = from.z;
    for (const c of corners) {
        while (cx !== c.x || cz !== c.z) {
            cx += Math.sign(c.x - cx);
            cz += Math.sign(c.z - cz);
            out.push({ x: cx, z: cz });
        }
    }
    return out;
}

export function walkPath(deps: PathDeps, points: PathPoint[], opts: PathOptions = {}): Promise<PathResult> {
    const look = opts.look ?? 20;
    const reclickAt = opts.reclickAt ?? 6;
    const log = opts.log ?? (() => {});
    const res: PathResult = { ok: false, ticks: 0, still: 0, clicks: 0, repaths: 0, doors: 0, next: 0 };
    const signals = [...new Set([opts.signal, executionContext.getStore()?.signal].filter((signal): signal is AbortSignal => !!signal))];
    if (signals.some(signal => signal.aborted)) return Promise.resolve({ ...res, detail: 'stopped' });
    const start = deps.pos();
    const goal = points[points.length - 1];
    if (!start) return Promise.resolve({ ...res, detail: 'no position' });
    if (!goal) return Promise.resolve({ ...res, ok: true });
    const level = start.level;
    const goalTol = goal.tol ?? 2;
    const failedDoors = new Set<string>();
    const doorKey = (loc: PathTile) => `${level},${loc.x},${loc.z}`;
    const blockedDoor = (loc: PathTile) => failedDoors.has(doorKey(loc)) || deps.doorBlocked?.(level, loc) === true;
    const messageKey = (m: { text: string; tick: number; observationId?: number }) => `${m.observationId ?? m.tick}:${m.text}`;

    // Path tiles through every point in order. seg[i] is the index of the point that tile i leads to.
    let tiles: PathTile[] = [];
    let seg: number[] = [];
    const build = (from: PathTile, firstPoint: number) => {
        tiles = []; seg = [];
        let cur = from;
        for (let k = firstPoint; k < points.length; k++) {
            // rs-sdk's collision map can call the bot's own tile blocked (seen: 2774,3228 beside the Brimhaven
            // customs officer gives 0 waypoints). Then take the straight line: the client routes each click itself.
            const corners = deps.plan(level, cur, points[k]!);
            const t = expandPath(cur, corners.length ? corners : [points[k]!]);
            // A door coordinate anchors a wall edge, not a blocked floor tile.
            // Trust a nonempty edge-aware plan; only an unverified straight
            // fallback must reject a known blocked anchor.
            if (!corners.length && t.some(blockedDoor)) { tiles = []; seg = []; return; }
            for (const x of t) { tiles.push(x); seg.push(k); }
            if (t.length) cur = t[t.length - 1]!;
        }
    };
    build(start, 0);
    if (tiles.length === 0 && d8(start, goal) > goalTol) return Promise.resolve({ ...res, detail: `no path to ${goal.x},${goal.z}` });
    const maxTicks = opts.maxTicks ?? tiles.length + 60;

    let idx = -1;          // path tile nearest the bot
    let target = -1;       // path index of the last walk click
    let door: { loc: PathLoc; sentAt: number; messages: Set<string> } | null = null;
    const doorAttempts = new Map<string, number>();
    let last = { x: start.x, z: start.z };
    let still = 0;
    let ticks = 0;
    let ranOn = false;
    let sentThisTick = false;
    let movementEpoch = 0, rejectedWalks = 0, movementRepaths = 0;
    let rejectionReplan = false, rejectionReplanned = false;
    let walkReply: (reply: unknown, from: { x: number; z: number; level: number }, to: PathTile, epoch: number) => void = () => {};

    const shutDoorAt = (from: number, to: number): { l: PathLoc; i: number } | null => {
        const ahead = new Map<string, number>();
        for (let i = Math.max(0, from); i <= Math.min(tiles.length - 1, to); i++) ahead.set(`${tiles[i]!.x},${tiles[i]!.z}`, i);
        // A shut door on the tile the bot stands on blocks it as well, and the path's tiles leave that tile out. Live:
        // Doric's Quest ends on his doorway (door 1530 at 2952,3453), and every walk click out was refused.
        // It counts only when the client cannot reach the next path tile: the wall of a door is on one edge of its
        // tile, and a bot past that edge is not blocked. The Karamja shipyard gate (2438 at 2945,3041) puts the
        // player on the gate tile, inside the yard; an Open from there moves the player out again
        // (quest_grandtree.rs2 open_shipyard_gate), away from the foreman.
        const here = deps.pos();
        const hereKey = here && here.level === level && !ahead.has(`${here.x},${here.z}`) ? `${here.x},${here.z}` : null;
        if (hereKey) ahead.set(hereKey, Math.max(0, from));
        let hereBlocks: boolean | undefined;
        const blocksHere = (): boolean => {
            if (hereBlocks === undefined) {
                const next = tiles[Math.max(0, from)];
                hereBlocks = !next || deps.reach?.({ x: next.x, z: next.z, level }) !== true;
            }
            return hereBlocks;
        };
        let best: { l: PathLoc; i: number } | null = null;
        for (const l of deps.locs()) {
            const i = ahead.get(`${l.x},${l.z}`);
            if (i !== undefined && openOp(l) && !blockedDoor(l) && (!best || i < best.i) && (`${l.x},${l.z}` !== hereKey || blocksHere())) best = { l, i };
        }
        return best;
    };
    const shutDoorAhead = (from: number, to: number): PathLoc | null => shutDoorAt(from, to)?.l ?? null;
    const nearest = (p: PathTile): { i: number; d: number } => {
        let best = { i: Math.max(0, idx), d: Infinity };
        const hi = Math.min(tiles.length - 1, Math.max(0, idx) + look * 2);
        // A path that folds back past a shut door has later tiles as near as the door tile. A tie must not
        // cross the first shut door, or the door leaves the open lookahead and the client refuses the click.
        // A strictly nearer tile still crosses it: the door can shut again behind a bot that walked through.
        const door = shutDoorAt(idx, hi)?.i ?? Infinity;
        for (let i = Math.max(0, idx); i <= hi; i++) {
            const d = d8(tiles[i]!, p);
            if (d < best.d || (d === best.d && !(best.i <= door && i > door))) best = { i, d };   // a tie goes forward
        }
        return best;
    };
    const send = (what: string, f: () => unknown, reply?: (value: unknown) => void): boolean => {
        if (sentThisTick) return false;
        sentThisTick = true;
        try {
            const r = f() as { then?: unknown } | undefined;
            if (r && typeof r.then === 'function') Promise.resolve(r).then(value => reply?.(value), error => reply?.({ success: false, phase: 'dispatch', reason: 'exception', message: String(error) }));
            else reply?.(r);
        } catch (error) { reply?.({ success: false, phase: 'dispatch', reason: 'exception', message: String(error) }); }
        log(what);
        return true;
    };
    // The furthest tile within `span` the client can reach; a tile behind a closed door or out of the scene is
    // skipped (rs2b0t selectClickTarget). Without a reach probe, the tile `span` ahead.
    const clickIndex = (span: number): number => {
        const top = Math.min(tiles.length - 1, Math.max(0, idx) + span);
        if (!deps.reach) return top;
        for (let i = top; i > Math.max(0, idx); i--) if (deps.reach({ ...tiles[i]!, level }) !== false) return i;
        return top;
    };
    const clickAhead = (span: number) => {
        const i = clickIndex(span);
        const t = tiles[i]!;
        if (sentThisTick) return;
        const from = deps.pos();
        if (!from) return;
        const epoch = movementEpoch;
        res.clicks++; // Dispatch attempts, including an explicit client refusal.
        if (send(`walk ${t.x},${t.z}`, () => deps.walk(t.x, t.z), reply => walkReply(reply, from, t, epoch))) target = i;
    };
    const replan = (p: PathTile, why: string): boolean => {
        build(p, seg[Math.max(0, idx)] ?? 0);
        idx = -1; target = -1; res.repaths++;
        log(`re-plan: ${why}`);
        if (tiles.length === 0) return false;
        idx = nearest(p).i;
        return true;
    };

    return new Promise<PathResult>(resolve => {
        let done = false;
        const abortSubscriptions: (() => void)[] = [];
        const finish = (ok: boolean, detail?: string) => {
            if (done) return;
            done = true;
            off();
            for (const unsubscribe of abortSubscriptions) unsubscribe();
            resolve({ ...res, ok, ticks, next: ok ? points.length : (seg[Math.max(0, idx)] ?? 0), detail });
        };
        const failedDoor = (loc: PathLoc, why: string, p: PathTile) => {
            const attempts = doorAttempts.get(doorKey(loc)) ?? 0;
            const detail = `no progress: door ${loc.id}@${loc.x},${loc.z},${level} stayed closed after ${attempts} Open attempts at=${p.x},${p.z} goal=${goal.x},${goal.z}: ${why}`;
            failedDoors.add(doorKey(loc));
            const registered = deps.blockDoor?.(level, loc) === true;
            door = null;
            log(detail);
            if (!registered || !replan(p, detail)) return finish(false, detail);
            clickAhead(look);
        };
        walkReply = (value, from, to, epoch) => {
            const p = deps.pos();
            if (done || epoch !== movementEpoch || !p || p.level !== from.level || d8(p, from) !== 0) return;
            const reply = value as { success?: boolean; phase?: unknown; reason?: unknown; message?: unknown } | null | undefined;
            if (reply?.success !== false) return; // Undefined fakes and accepted dispatches remain movement-checked.
            // A slow reply may arrive after the normal still-path replan. That already spent this attempt.
            if (res.repaths > movementRepaths) { rejectionReplanned = true; rejectionReplan = false; }
            rejectedWalks++;
            const detail = `no progress: walk rejected ${rejectedWalks} times start=${start.x},${start.z},${level} at=${p.x},${p.z},${p.level} target=${to.x},${to.z} reply=${JSON.stringify({ phase: reply.phase, reason: reply.reason, message: reply.message })}`;
            log(detail);
            if (rejectedWalks >= 3) { finish(false, detail); return; }
            if (!rejectionReplanned) rejectionReplan = true;
        };
        const decide = () => {
            sentThisTick = false;
            const p = deps.pos();
            if (!p) return finish(false, 'no position');
            if (p.level !== level) return finish(false, `left level ${level}`);
            // Near the goal is arrival, unless the goal is out of reach and a closed door lies on the path: then
            // the door is opened first (a bot two tiles from an NPC, behind its house wall, cannot talk to it).
            if (d8(p, goal) <= goalTol && !(deps.reach?.({ x: goal.x, z: goal.z, level }, { adjacentOk: true }) === false && shutDoorAt(Math.max(0, idx), tiles.length - 1))) return finish(true);
            if (opts.stop?.()) return finish(false, 'stopped');
            if (ticks > maxTicks) return finish(false, `budget ${maxTicks} ticks at ${p.x},${p.z}`);
            const moved = p.x !== last.x || p.z !== last.z;
            if (moved) { movementEpoch++; rejectedWalks = 0; movementRepaths = res.repaths; rejectionReplan = false; rejectionReplanned = false; }
            last = { x: p.x, z: p.z };
            still = moved ? 0 : still + 1;
            if (ticks > 0 && !moved) res.still++;

            // The run button does not count as the tick's input: the server takes 5 per tick, and it goes first.
            if (!ranOn && deps.runOn) { ranOn = true; send('run on', () => deps.runOn!()); sentThisTick = false; }

            if (rejectionReplan) {
                rejectionReplan = false; rejectionReplanned = true;
                if (!replan(p, 'client walk rejection')) return finish(false, `no path from ${p.x},${p.z}`);
            }
            const n = nearest(p);
            if (n.d > 3) {
                // Off the planned path (the client routed round something): plan again from here.
                if (!replan(p, `off path by ${n.d}`)) return finish(false, `no path from ${p.x},${p.z}`);
            } else idx = n.i;

            // A door the bot asked to open: click past it on the tick it opens.
            if (door) {
                const d = door;
                const shutNow = deps.locs().some(l => l.x === d.loc.x && l.z === d.loc.z && l.id === d.loc.id && openOp(l));
                if (!shutNow) { door = null; doorAttempts.delete(doorKey(d.loc)); log('door open'); clickAhead(look); return; }
                const refusal = deps.messages?.().find(m => !d.messages.has(messageKey(m)) && /\b(?:door|gate).{0,32}\blocked\b|\b(?:cannot|can't) open\b/i.test(m.text));
                if (refusal) return failedDoor(d.loc, refusal.text, p);
                // Open may first walk to the door, then wait for a delayed server
                // action. Count unchanged ticks, not distance or accepted dispatches.
                if (still >= 6 && ticks - d.sentAt >= 6) {
                    if ((doorAttempts.get(doorKey(d.loc)) ?? 0) >= 3) return failedDoor(d.loc, 'no open effect observed', p);
                    door = null;
                } else return;
            }
            const shut = shutDoorAhead(idx, idx + look);
            if (shut) {
                const op = openOp(shut)!.opIndex;
                const baseline = new Set((deps.messages?.() ?? []).map(messageKey));
                if (send(`open ${shut.x},${shut.z} id${shut.id}`, () => deps.interactLoc(shut, op))) {
                    door = { loc: shut, sentAt: ticks, messages: baseline };
                    doorAttempts.set(doorKey(shut), (doorAttempts.get(doorKey(shut)) ?? 0) + 1);
                    res.doors++; target = -1;
                }
                return;
            }
            // No tile gained for 2 ticks: plan again from where the bot stands.
            if (still >= 2) {
                if (rejectedWalks === 0 && !replan(p, `still ${still}`)) return finish(false, `no path from ${p.x},${p.z}`);
                // Only doors on the planned leg are attempted. A nearby unrelated
                // Open option is not evidence that it blocks this route.
                clickAhead(still >= 3 ? Math.ceil(look / 2) : look);
                return;
            }
            if (still >= 1 || target < 0 || target - idx <= reclickAt) {
                // The last click already ends at the goal, and the bot is still moving toward it.
                if (target === tiles.length - 1 && still === 0) return;
                clickAhead(look);
            }
        };
        const off = watchTickStream(deps, () => { ticks++; decide(); }, error => finish(false, error.message), opts.idleMs);
        const onAbort = () => finish(false, 'stopped');
        for (const signal of signals) {
            if (signal.aborted) { onAbort(); break; }
            signal.addEventListener('abort', onAbort, { once: true });
            abortSubscriptions.push(() => signal.removeEventListener('abort', onAbort));
        }
        void deps.ended?.then(() => finish(false, 'session ended'));
        if (!done) decide();
    });
}

export function applyKnownDoorBlocks(sdk: any, level: number, from: PathTile, to: PathTile, doors?: readonly Door[]): DoorBlock[] {
    const account=accountForSdk(sdk);
    const blocked = blockedDoorsNear({ ...from, level }, { ...to, level }, account, doors);
    return blocked;
}

// PathDeps for an in-process session (packages/core/src/inprocess.ts). Inputs go straight to the client, not
// through the SDK action queue, so a click leaves on the tick it is decided.
export async function sessionWalker(s: { sdk: any; client?:unknown; onTick(cb: () => void): () => void; direct(a: { type: string; [k: string]: unknown }): Promise<unknown>; ended?: Promise<unknown> }): Promise<PathDeps> {
    const pf: any = await import('../../../vendor/rs-sdk/sdk/pathfinding');
    const grid=await import('../../../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    await installDoorPolicy(s.sdk,s.client);
    const pos = () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
    const reach = clientReach(s.client, pos);
    return {
        tick: () => s.sdk.getState()?.tick,
        pos,
        ...(reach ? { reach } : {}),
        onTick: cb => s.onTick(cb),
        ended: s.ended,
        walk: (x, z) => s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' }),
        interactLoc: (l, op) => s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: op, reason: 'SDK' }),
        runOn: () => s.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' }),
        locs: () => s.sdk.getState()?.nearbyLocs ?? [],
        messages: () => s.sdk.getState()?.gameMessages ?? [],
        blockDoor: (level, loc) => s.sdk.blockDoorTemporarily?.(level, loc.x, loc.z) === true,
        doorBlocked: (level, loc) => s.sdk.isDoorTemporarilyBlocked?.(level, loc.x, loc.z) === true,
        // The session's temporary door blocks (doors walkTo found locked) stay walls for this plan too.
        plan: (level, from, to) => {
            pf.initPathfinding();
            const blocks=applyKnownDoorBlocks(s.sdk, level, from, to).map(b=>b.whenAxis===undefined?{...b,...pf.getDoorAt(b.level,b.x,b.z)}:b);
            // Deadly hunters' ground stays closed too (danger.ts).
            return guardWalk(grid,accountForSdk(s.sdk),{...from,level},{...to,level},32,()=>withDoorPolicy(grid,blocks,()=>pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, s.sdk.temporaryDoorBlocks?.active?.() ?? [])));
        },
    };
}
