// Travel edges (NPC transport, spells, jewellery, scripted gates, spirit trees/passages) and ship-deck disembark.
import type { Outcome } from '../act';
import type { BoatSession } from '../boat';
import { accountForSdk } from '../door-policy';
import { waitTicks } from '../ticks';
import { cheb, type WalkOptions, type Walker } from '../walk-leg';
import type { Leg } from '../world';

type TravelLeg = Extract<Leg, { kind: 'travel' }>;
type TravelEdge = TravelLeg['travel'];
type DirectBoat = BoatSession & { direct(a: unknown): Promise<unknown> };
type FailFn = (reason: 'rejected' | 'timeout' | 'precondition' | 'aborted', detail: string) => Outcome;

// Off a ship's deck by its gangplank: 'ground' when the account stood on a deck and now stands on level 0, 'none'
// when it was not on a deck (level 1 with a gangplank within DECK_REACH tiles), 'stuck' when the crossing failed.
export const DECK_REACH = 8;
export async function leaveDeck(s: Walker, stop: () => boolean = () => false): Promise<'none' | 'ground' | 'stuck'> {
    const p = s.sdk.getState()?.player, b = s as unknown as BoatSession;
    if (!p || p.level !== 1 || typeof b.sdk.findNearbyLoc !== 'function') return 'none';
    const { disembark, pickDisembarkPlank } = await import('../boat');
    const plank = pickDisembarkPlank(b, DECK_REACH);
    const near = !!plank && (plank.distance ?? Math.max(Math.abs((plank.x ?? 0) - p.worldX), Math.abs((plank.z ?? 0) - p.worldZ))) <= DECK_REACH;
    if (!near) return 'none';
    const off = await disembark(b, { stop });
    console.log(`WALK_DECK from=${p.worldX},${p.worldZ},${p.level} ${off.ok ? 'crossed' : 'stuck'} ${off.detail}`);
    return off.ok ? 'ground' : 'stuck';
}

async function answerTravelDialog(
    s: Walker,
    b: DirectBoat,
    choices: readonly string[],
    until: () => boolean,
    stop: () => boolean,
    ticks: number,
): Promise<void> {
    const norm = (x: string) => x.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    for (let i = 0; i < ticks && !until() && !stop(); i++) {
        const d = b.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            const opt = d.options.find(o => choices.some(c => norm(o.text) === norm(c)));
            await b.sdk.sendClickDialog(opt ? opt.index : 0);
        }
        await waitTicks(s, 1);
    }
}

async function travelNpcButtonLeg(
    s: Walker,
    b: DirectBoat,
    t: TravelEdge,
    run: Extract<TravelEdge['run'], { how: 'npc' }>,
    npc: any,
    start: number,
    stop: () => boolean,
    st: () => any,
    here: () => { x: number; z: number; level: number } | null,
    fail: FailFn,
): Promise<Outcome> {
    const client = s.client as { executeBotAction?: unknown } | undefined, executor = client?.executeBotAction, sdk = s.sdk;
    const first = st()?.player, life = first?.lifeId, respawns = first?.respawnCount ?? 0;
    const unsafe = () => stop() || s.client !== client || s.sdk !== sdk || client?.executeBotAction !== executor || typeof executor !== 'function'
        || !Number.isSafeInteger(life) || !st()?.player || st().player.isDead || st().player.lifeId !== life || (st().player.respawnCount ?? 0) !== respawns;
    const button = run.button!.component, namespace = button.split(':')[0]!;
    if (!/^[a-z0-9_]+:[a-z0-9_]+$/.test(button)) return fail('precondition', 'invalid native travel button');
    let main: number, component: number;
    const { componentId } = await import('../logout');
    try { main = componentId(namespace); component = componentId(button); } catch { return fail('precondition', 'unknown native travel interface/button'); }
    const mapOpen = () => st()?.modalInterface === main || st()?.interface?.isOpen === true && st()?.interface?.interfaceId === main;
    const landed = () => { const p = here(); return !!p && p.level === t.to.level && Math.max(Math.abs(p.x - t.to.x), Math.abs(p.z - t.to.z)) <= 1; };
    if (unsafe()) return fail('aborted', 'original travel input owner/life unavailable');
    try {
        await b.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: run.op, reason: 'SDK' });
        const answered = new Set<string>();
        const norm = (v: string) => v.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
        for (let i = 0; i < 60 && !mapOpen() && !unsafe(); i++) {
            const d = b.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const key = 'pageId' in d && typeof d.pageId === 'string' ? d.pageId : JSON.stringify(d);
                if (!answered.has(key)) {
                    const option = d.options.find(o => run.options.some(c => norm(o.text) === norm(c)));
                    if (!option && (d.options.length > 1 || d.options.length === 1 && !/continue/i.test(d.options[0]!.text))) return fail('precondition', 'unmapped native travel dialogue');
                    if (unsafe()) return fail('aborted', 'travel owner changed before dialogue');
                    answered.add(key);
                    await b.direct({ type: 'clickDialogOption', optionIndex: option?.index ?? d.options[0]?.index ?? 0, reason: 'SDK' });
                }
            }
            if (unsafe()) return fail('aborted', 'travel owner changed after dialogue');
            await waitTicks(s, 1);
        }
        if (unsafe()) return fail('aborted', 'travel owner changed before button');
        if (!mapOpen()) return fail('precondition', 'expected native travel interface unobserved');
        // This dispatch is not retried: an absent acknowledgement cannot prove non-payment.
        const sent = await b.direct({ type: 'clickComponent', componentId: component, reason: 'SDK' });
        if ((sent as { success?: boolean } | undefined)?.success !== true) return fail('rejected', 'native travel button outcome uncertain');
        for (let i = 0; i < 12 && !landed() && !unsafe(); i++) await waitTicks(s, 1);
        if (unsafe()) return fail('aborted', 'travel owner/life changed during landing');
        return landed() ? { ok: true, ticks: s.tick() - start } : fail('timeout', 'native travel button landing unobserved');
    } catch (error) { return fail(stop() ? 'aborted' : 'rejected', `native travel outcome uncertain: ${String(error)}`); }
}

async function travelGateLeg(
    s: Walker,
    b: DirectBoat,
    t: TravelEdge,
    run: Extract<TravelEdge['run'], { how: 'gate' }>,
    choices: readonly string[],
    start: number,
    stop: () => boolean,
    st: () => any,
    here: () => { x: number; z: number; level: number } | null,
    fail: FailFn,
): Promise<Outcome> {
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
        await answerTravelDialog(s, b, choices, () => { if (dialogOpen()) { talked = true; shut = 0; } else if (talked) shut++; return across() || shut >= 3; }, stop, 40);
        if (!across()) await waitTicks(s, 3);
    }
    for (let i = 0; i < 3 && !through() && !stop(); i++) { await b.direct({ type: 'walkTo', x: t.to.x, z: t.to.z, running: true, reason: 'SDK' }); await waitTicks(s, 4); }
    return through() ? { ok: true, ticks: s.tick() - start } : fail('timeout', `not through ${run.loc} (at ${JSON.stringify(here())})`);
}

async function travelLocLeg(
    s: Walker,
    b: DirectBoat,
    t: TravelEdge,
    run: Extract<TravelEdge['run'], { how: 'loc' }>,
    choices: readonly string[],
    start: number,
    stop: () => boolean,
    st: () => any,
    here: () => { x: number; z: number; level: number } | null,
    arrived: () => boolean,
    fail: FailFn,
): Promise<Outcome> {
    // Spirit trees by kind: the Gnome Stronghold's and the village's are named ent and stronghold_ent (teleports.json).
    const name = run.loc.includes('spirit') || t.kind === 'spirit_tree' ? /spirit tree/i : /lever|door/i, at = run.at;
    const loc = (st()?.nearbyLocs ?? []).filter((l: any) => at && run.id !== undefined ? l.id === run.id && l.x === at.x && l.z === at.z && l.level === at.level : name.test(l.name ?? ''))
        .sort((x: any, y: any) => (x.distance ?? 0) - (y.distance ?? 0))[0]
        // The lite client sends an op for a loc it does not list (lite/actions.ts interactLoc); the server finds it.
        ?? (run.unlisted && at && run.id !== undefined ? { id: run.id, x: at.x, z: at.z } : undefined);
    if (!loc) return fail('precondition', `no ${run.loc} in sight`);
    // A short passage on one floor (the Grand Tree door moves the player two tiles) ends on its landing: within 8
    // tiles of it the player already stood, on the wrong side.
    const short = !!t.from && t.from.level === t.to.level && cheb(t.from, { worldX: t.to.x, worldZ: t.to.z }) <= 8;
    const railing = t.kind === 'passage' && run.loc === 'mcgruborlooserailing' && run.id === 51 ? run.at : undefined;
    // A failed Agility roll that still crosses ends on its own tile (the river log washes the player 8 tiles down).
    const slipped = () => { const p = here(); return !!p && (t.slips ?? []).some(k => k.level === p.level && k.x === p.x && k.z === p.z); };
    // mcgrubors_wood.rs2 squeezes onto x=loc.x going in and x<loc.x going out. The railing tile is still inside;
    // accepting it on exit lets the next movement cancel the pending squeeze before it crosses.
    // A landing next to the start (gnomevillage_fence.rs2 squeezes 1 tile, from 2515,3160 onto the railing tile
    // 2515,3161) counts only on it: within 1 tile of it the player still stands on the start.
    const reach = t.from ? Math.max(0, Math.min(1, cheb(t.to, { worldX: t.from.x, worldZ: t.from.z }) - 1)) : 1;
    const landed = () => {
        const p = here();
        return (!!p && p.level === t.to.level && cheb(t.to, { worldX: p.x, worldZ: p.z }) <= reach
            && (!railing || (t.to.x < railing.x ? p.x < railing.x : p.x >= railing.x))) || slipped();
    };
    if (stop()) return fail('aborted', 'stopped before location travel');
    if (railing && landed()) return { ok: true, ticks: s.tick() - start };
    if (t.slipDamage) {
        // A slip must leave the player alive: refuse at a hitpoint level the slip's damage would take to 0.
        const hp = st()?.skills?.find((k: { name?: string }) => k.name === 'Hitpoints')?.level;
        if (typeof hp !== 'number') return fail('precondition', `hitpoints not observed before ${run.loc}`);
        const damage = Math.floor(hp * t.slipDamage.percent / 100) + t.slipDamage.plus;
        if (hp <= damage) return fail('precondition', `a slip on ${run.loc} deals ${damage} at ${hp} hitpoints`);
    }
    await b.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: run.op, reason: 'SDK' });
    // The river log's slip takes about 12 ticks from the click (shortcuts.rs2:65-89).
    await answerTravelDialog(s, b, choices, short ? landed : () => arrived() || slipped(), stop, t.slips?.length ? 40 : 20);
    if (short && !landed()) return fail('timeout', `not through ${run.loc} to ${t.to.x},${t.to.z} (at ${JSON.stringify(here())})`);
    return arrived() || slipped() ? { ok: true, ticks: s.tick() - start } : fail('timeout', `not at ${t.to.x},${t.to.z},${t.to.level} (at ${JSON.stringify(here())})`);
}

// One travel edge (travel.ts): talk to the NPC and answer its dialogue, cast the spell, rub the jewellery or
// operate the lever or tree; then cross the gangplank when the edge lands on a ship deck. Ok when the player
// stands within 8 tiles of the edge's arrival tile.
export async function travelLeg(s: Walker, leg: TravelLeg, opts: WalkOptions): Promise<Outcome> {
    const start = s.tick(), t = leg.travel, run = t.run, b = s as unknown as DirectBoat;
    const stop = () => opts.signal?.aborted === true, st = () => s.sdk.getState() as any;
    const here = () => { const p = st()?.player; return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null; };
    // An NPC that moves the player a few tiles on one floor (the Shantay Guard: 3303,3118 to 3304,3115) ends on its
    // landing, as a short location passage does: within 8 tiles of it the player already stands, on the wrong side.
    const shortNpc = run.how === 'npc' && !!t.from && t.from.level === t.to.level && cheb(t.from, { worldX: t.to.x, worldZ: t.to.z }) <= 8;
    const reach = shortNpc ? Math.max(0, Math.min(1, cheb(t.to, { worldX: t.from!.x, worldZ: t.from!.z }) - 1)) : 8;
    const arrived = () => { const p = st()?.player; return !!p && p.level === t.to.level && cheb(t.to, p) <= reach; };
    const fail: FailFn = (reason, detail) => ({ ok: false, reason: stop() ? 'aborted' : reason, detail: `${t.name}: ${detail}`, ticks: s.tick() - start });
    // A spirit tree with several destinations asks "Where can I go?" before its destination menu ([oploc1,stronghold_ent]
    // and [oploc1,ent]); a young spirit tree with one asks "Yes please." ([oploc1,loc_1317]; spirit_tree.rs2).
    const tree = t.kind === 'spirit_tree' ? (run.how === 'loc' && run.option ? ['Where can I go?'] : ['Yes please.']) : [];
    const choices = run.how === 'npc' ? run.options : run.how === 'gate' ? run.choices : run.how === 'rub' || run.how === 'loc' ? [...(run.option ? [run.option] : []), ...tree] : [];
    const onDeck = () => here()?.level === 1;
    if (run.how === 'npc') {
        const npc = (st()?.nearbyNpcs ?? []).filter((n: any) => n.name?.toLowerCase() === run.npc.toLowerCase()).sort((x: any, y: any) => (x.distance ?? 0) - (y.distance ?? 0))[0];
        if (!npc) return fail('precondition', `no ${run.npc} in sight`);
        if (run.button) return travelNpcButtonLeg(s, b, t, run, npc, start, stop, st, here, fail);
        await b.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: run.op, reason: 'SDK' });
        await answerTravelDialog(s, b, choices, () => arrived() || (!!run.deck && onDeck()), stop, 60);
        if (run.deck && onDeck()) { const { disembark } = await import('../boat'); const off = await disembark(b, { stop }); if (!off.ok) return fail('timeout', off.detail); }
    } else if (run.how === 'spell') {
        // The plan admitted the spell on the account as it stood when the route was planned; a cast on the way can have
        // spent the runes since, and the server refuses a short cast with a message the walker does not read.
        const [{ travelAllowed }, { componentId }] = await Promise.all([import('../travel'), import('../logout')]);
        if (!travelAllowed(t, accountForSdk(s.sdk))) return fail('precondition', `cannot cast now (needs ${t.runes.map(r => `${r.count} ${r.item}`).join(', ')})`);
        await b.direct({ type: 'clickComponent', componentId: componentId(run.component), reason: 'SDK' });
        await answerTravelDialog(s, b, choices, arrived, stop, 12);
    } else if (run.how === 'rub') {
        const { itemIdOf } = await import('../trip');
        const ids = new Set(run.items.map(itemIdOf).filter((i): i is number => i !== undefined));
        const item = (st()?.inventory ?? []).find((i: any) => ids.has(i.id));
        if (!item) return fail('precondition', 'no charged item in the pack');
        await b.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: 4, reason: 'SDK' });
        await answerTravelDialog(s, b, choices, arrived, stop, 20);
    } else if (run.how === 'gate') {
        return travelGateLeg(s, b, t, run, choices, start, stop, st, here, fail);
    } else {
        return travelLocLeg(s, b, t, run, choices, start, stop, st, here, arrived, fail);
    }
    return arrived() ? { ok: true, ticks: s.tick() - start } : fail('timeout', `not at ${t.to.x},${t.to.z},${t.to.level} (at ${JSON.stringify(here())})`);
}
