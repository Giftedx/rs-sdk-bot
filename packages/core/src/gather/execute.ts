// In-game gathering loop shared by scripts/quest-sweep.ts and scripts/gather-spawn.ts.
import { accountOf } from '../bot';
import type { Session } from '../inprocess';
import { componentId } from '../logout';
import { locsByDistance, spawnsByDistance } from '../spawn-index';
import { waitTicks, waitUntil } from '../ticks';
import { goTo } from '../walk';
import type { World } from '../world';
import { castsPerKill, killAttempts, magicKit, sharedDrops, type MagicKit } from './combat';
import {
    ARROWS,
    BOWS,
    BUCKET,
    BURN_SOURCES,
    CLUSTER,
    COMBINE_SOURCES,
    COW,
    FIRE_TICKS,
    KILL_SOURCES,
    LOC_SOURCES,
    MILK,
    MINE_SOURCES,
    NPC_SOURCES,
    PICKAXES,
    PICK_SOURCES,
    TINDERBOX,
    USE_SOURCES,
    count,
    cows,
    denseSpawns,
    killSpawns,
    nearest,
    type Gather,
    type Tile,
} from './sources';

type StepOutcome = 'wait' | 'continue' | 'break' | { error: string };
type GatherCtx = {
    s: Session;
    st: () => any;
    held: (id: number) => number;
    here: () => Tile;
    walk: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>;
    gathers: readonly Gather[];
    targets: ReadonlyMap<number, number>;
};

function gatherSources(g: Gather, here: Tile): Tile[] {
    return (
        g.how === 'milk' ? nearest(cows(), here)
            : g.how === 'loc' ? [LOC_SOURCES[g.id]!.tile]
            : g.how === 'kill' ? nearest((KILL_SOURCES[g.id]?.chance ?? 1) < 1 ? denseSpawns(killSpawns(g.id)) : killSpawns(g.id), here)
            : g.how === 'pick' ? locsByDistance(PICK_SOURCES[g.id]!.loc, here)
            : g.how === 'npc' ? [NPC_SOURCES[g.id]!.tile]
            : g.how === 'use' ? nearest(USE_SOURCES[g.id]!.tiles, here)
            : g.how === 'mine' ? nearest(MINE_SOURCES[g.id]!.tiles, here)
            : g.how === 'combine' || g.how === 'burn' ? [here]
            : spawnsByDistance(g.id, here)
    ).slice(0, 6);
}

async function stepMine(ctx: GatherCtx, g: Gather, at: Tile, before: number): Promise<StepOutcome> {
    const { s, st, held } = ctx;
    const src = MINE_SOURCES[g.id]!, inv = st()?.inventory ?? [];
    if (!PICKAXES.some(id => inv.some((i: any) => i.id === id) || s.sdk.getEquipment().some((i: any) => i.id === id))) {
        return { error: `${src.name} needs a pickaxe in the pack` };
    }
    // Doric's ores in their order: six clay and four copper (mine.dbrow rock_exp 50 and 175, at 25x) lift Mining 1 to 15,
    // the iron rocks' level, so the iron comes last and a short level is the plan's order, not a wait.
    const mining = s.sdk.getSkill('Mining')?.level ?? 1;
    if (mining < src.level) return { error: `${src.name} needs Mining ${src.level}, have ${mining}` };
    const rock = (st()?.nearbyLocs ?? [])
        .filter((l: any) => src.locs.includes(l.id) && (l.optionsWithIndex ?? []).some((o: any) => /^mine$/i.test(o.text)))
        .sort((a: any, b: any) => a.distance - b.distance)[0];
    // A mined rock stands bare a while; the mine has several.
    if (!rock) {
        if (!await waitUntil(s, () => (st()?.nearbyLocs ?? []).some((l: any) => src.locs.includes(l.id)), { timeoutTicks: 60 })) return 'break';
        return 'continue';
    }
    await s.bot.interactLoc(rock, /^mine$/i);
    await waitUntil(s, () => held(g.id) > before, { timeoutTicks: 30 });
    console.log(`QUEST_SWEEP_MINE ${JSON.stringify({ item: g.id, at, held: held(g.id), target: ctx.targets.get(g.id) })}`);
    return 'wait';
}

async function stepBurn(ctx: GatherCtx, g: Gather, before: number): Promise<StepOutcome> {
    const { s, st, held, here, walk } = ctx;
    const target = ctx.targets.get(g.id)!;
    const src = BURN_SOURCES[g.id]!, inv = st()?.inventory ?? [], tinder = inv.find((i: any) => i.id === TINDERBOX), logs = inv.find((i: any) => i.id === src.logs);
    if (!tinder || !logs) return { error: `${src.name} needs ${TINDERBOX} and ${src.logs} in the pack` };
    if (src.uses && !inv.some((i: any) => i.id === src.uses)) return { error: `${src.name} needs ${src.uses} in the pack` };
    const fireAt = here(), logsHeld = held(src.logs);
    await s.direct({ type: 'useItemOnItem', sourceSlot: tinder.slot, targetSlot: logs.slot, reason: 'SDK' });
    // The server swings the tinderbox again every four ticks until the fire catches; logs still held after 30 ticks mean
    // the tile takes no fire, and the next try stands two tiles west.
    if (!await waitUntil(s, () => held(src.logs) < logsHeld, { timeoutTicks: 30 })) {
        console.log(`QUEST_SWEEP_BURN ${JSON.stringify({ item: g.id, at: fireAt, lit: false })}`);
        await walk({ x: fireAt.x - 2, z: fireAt.z, level: fireAt.level });
        return 'continue';
    }
    const lit = s.tick();
    if (src.uses) {
        // The fire stands on the tile the logs were lit on; the item goes on it as soon as the loc shows. The logs leave the
        // pack when the first strike starts, and each strike lights with stat_random(firemaking, 64, 512) every four ticks
        // (skill_firemaking/scripts/firemaking.rs2): at Firemaking 1 a quarter of strikes catch, so the fire gets twenty.
        const fire = () => (st()?.nearbyLocs ?? []).find((l: any) => /^fire$/i.test(l.name) && Math.max(Math.abs(l.x - fireAt.x), Math.abs(l.z - fireAt.z)) <= 1);
        if (!await waitUntil(s, () => !!fire(), { timeoutTicks: 80 })) {
            console.log(`QUEST_SWEEP_BURN ${JSON.stringify({ item: g.id, at: fireAt, lit: true, fire: false })}`);
            return 'continue';
        }
        const item = (st()?.inventory ?? []).find((i: any) => i.id === src.uses);
        const r: any = await s.bot.useItemOnLoc(item, fire());
        await waitUntil(s, () => held(g.id) > before, { timeoutTicks: 15 });
        console.log(`QUEST_SWEEP_BURN ${JSON.stringify({ item: g.id, at: fireAt, lit: true, used: src.uses, ok: r?.success, held: held(g.id), target })}`);
        return 'continue';
    }
    const ashes = () => (st()?.groundItems ?? []).filter((i: any) => i.id === g.id && i.distance <= 4).sort((a: any, b: any) => a.distance - b.distance)[0];
    if (!await waitUntil(s, () => !!ashes(), { timeoutTicks: FIRE_TICKS + 20 })) {
        console.log(`QUEST_SWEEP_BURN ${JSON.stringify({ item: g.id, at: fireAt, lit: true, ashes: false, ticks: s.tick() - lit })}`);
        return 'continue';
    }
    await s.bot.pickupItem(ashes());
    await waitUntil(s, () => held(g.id) > before, { timeoutTicks: 15 });
    console.log(`QUEST_SWEEP_BURN ${JSON.stringify({ item: g.id, at: fireAt, lit: true, ashes: true, ticks: s.tick() - lit, held: held(g.id), target })}`);
    return 'wait';
}

async function stepUse(ctx: GatherCtx, g: Gather, at: Tile, before: number): Promise<StepOutcome> {
    const { s, st, held } = ctx;
    const src = USE_SOURCES[g.id]!, loc = () => (st()?.nearbyLocs ?? []).find((l: any) => l.x === at.x && l.z === at.z && src.option.test((l.optionsWithIndex ?? []).map((o: any) => o.text).join('|')));
    const l0 = loc();
    if (!l0) return 'break';
    for (const id of src.uses) {
        const item = (st()?.inventory ?? []).find((i: any) => i.id === id);
        if (!item) return { error: `${src.name} needs ${id} in the pack` };
        const r: any = await s.bot.useItemOnLoc(item, l0);
        if (!r?.success) {
            console.log(`QUEST_SWEEP_USE ${JSON.stringify({ item: g.id, use: id, at, message: r?.message })}`);
            await waitTicks(s, 2);
            continue;
        }
        // Each use answers with message boxes; they are clicked away before the next use.
        for (let t = 0; t < 12; t++) {
            await waitTicks(s, 1);
            const dlg: any = s.sdk.getDialog();
            if (dlg?.isOpen && !dlg.isWaiting) await s.sdk.sendClickDialog(0);
            else if (t >= 3) break;
        }
    }
    await waitUntil(s, () => held(g.id) > before, { timeoutTicks: 10 });
    console.log(`QUEST_SWEEP_USE ${JSON.stringify({ item: g.id, at, held: held(g.id), target: ctx.targets.get(g.id) })}`);
    return 'wait';
}

async function stepCombine(ctx: GatherCtx, g: Gather): Promise<StepOutcome> {
    const { s, st, held } = ctx;
    const [a, b] = COMBINE_SOURCES[g.id]!, inv = st()?.inventory ?? [], ia = inv.find((i: any) => i.id === a), ib = inv.find((i: any) => i.id === b);
    if (!ia || !ib) return { error: `combining ${g.id} needs ${a} and ${b} in the pack` };
    const before = held(g.id);
    await s.direct({ type: 'useItemOnItem', sourceSlot: ia.slot, targetSlot: ib.slot, reason: 'SDK' });
    // A recipe that opens a message box first (the doogle leaves on the sardine, quest_fluffs.rs2 opheldu) hands the
    // item over only once the box is continued; the dyes hand theirs over at once.
    for (let t = 0; t < 12 && held(g.id) <= before; t++) {
        await waitTicks(s, 1);
        const dlg: any = s.sdk.getDialog();
        if (dlg?.isOpen && !dlg.isWaiting) await s.sdk.sendClickDialog(0);
    }
    return 'wait';
}

async function stepPick(ctx: GatherCtx, g: Gather): Promise<StepOutcome> {
    const { s, st } = ctx;
    const src = PICK_SOURCES[g.id]!, plant = (st()?.nearbyLocs ?? []).filter((l: any) => l.id === src.loc && (l.optionsWithIndex ?? []).some((o: any) => src.option.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
    // A picked plant stands again after 50 ticks; the field has several.
    if (!plant) {
        if (!await waitUntil(s, () => (st()?.nearbyLocs ?? []).some((l: any) => l.id === src.loc), { timeoutTicks: 60 })) return 'break';
        return 'continue';
    }
    await s.bot.interactLoc(plant, src.option);
    return 'wait';
}

async function stepNpc(ctx: GatherCtx, g: Gather, before: number): Promise<StepOutcome> {
    const { s, st, held } = ctx;
    const r = NPC_SOURCES[g.id]!, have = (id: number) => held(id);
    const short = r.needs.find(n => have(n.id) < n.count);
    if (short) return { error: `${r.name} needs ${short.count} of ${short.id} for ${g.id}, pack has ${have(short.id)}` };
    if (have(995) < r.coins) return { error: `${r.name} needs ${r.coins} coins for ${g.id}` };
    const npc = (st()?.nearbyNpcs ?? []).filter((n: any) => n.id === r.npc).sort((a: any, b: any) => a.distance - b.distance)[0];
    if (!npc) return { error: `${r.name} not in sight at ${r.tile.x},${r.tile.z}` };
    const talked: any = await s.bot.talkTo(npc);
    if (!talked?.success) return { error: `${r.name} did not talk: ${talked?.message ?? ''}` };
    // One dialogue page per tick: the next choice when its option shows, else continue, until the item arrives. The page
    // just clicked can stay on screen a tick before the server's next page arrives, so a page that repeats the one
    // clicked waits, a menu shown again (an earlier choice) is clicked again, and an option page that matches no
    // choice is a failure only when it stays five ticks.
    let next = 0, clicked = '', stale = 0;
    for (let t = 0; t < 60 && held(g.id) < before + r.yields; t++) {
        const dlg: any = s.sdk.getDialog();
        if (dlg?.isOpen && !dlg.isWaiting) {
            const opts: any[] = dlg.options ?? [], sig = opts.map(o => o.text).join(' | ');
            const idx = sig && sig === clicked ? undefined : [next, ...Array.from({ length: next }, (_, i) => next - 1 - i)].find(i => i < r.choices.length && opts.some(o => r.choices[i]!.test(o.text)));
            if (idx !== undefined) { await s.sdk.clickDialogByText(r.choices[idx]!); next = idx + 1; clicked = sig; stale = 0; }
            else if (opts.length && !opts.some(o => /click here to continue/i.test(o.text)) && next < r.choices.length) { if (++stale > 5) return { error: `${r.name}: no option for ${r.choices[next]} among ${sig}` }; }
            else { await s.sdk.sendClickDialog(0); clicked = ''; stale = 0; }
        }
        await waitTicks(s, 1);
    }
    console.log(`QUEST_SWEEP_NPC ${JSON.stringify({ item: g.id, npc: r.name, held: held(g.id), coins: have(995) })}`);
    return 'wait';
}

async function stepKill(ctx: GatherCtx, g: Gather, tally: { kills: number; drops: number; idle: number; fights: number }): Promise<StepOutcome> {
    const { s, st, held, here, gathers, targets } = ctx;
    // The nearest free one in sight; its drop lands on its tile when it dies, and another player's kill drops nothing for us.
    const ids = KILL_SOURCES[g.id]!.npcs, wanted = sharedDrops(gathers, g, held, targets), heldAll = () => wanted.reduce((n, id) => n + held(id), 0);
    const lying = () => (st()?.groundItems ?? []).filter((i: any) => wanted.includes(i.id) && i.distance <= 12).sort((a: any, b: any) => a.distance - b.distance);
    // A drop already on the ground (an earlier kill, another player's) is taken before the next fight, so the fight's
    // own wait ends only on a drop that was not there when it began.
    if (lying()[0]) {
        const was = heldAll();
        await s.bot.pickupItem(lying()[0]);
        await waitUntil(s, () => heldAll() > was, { timeoutTicks: 15 });
        return 'continue';
    }
    const npc = (st()?.nearbyNpcs ?? []).filter((n: any) => ids.includes(n.id) && !n.inCombat && n.distance <= 15).sort((a: any, b: any) => a.distance - b.distance)[0];
    // A source that has given a kill is worth its respawn (goblins return within about 50 ticks); one that shows no free
    // animal at all is left after 30.
    if (!npc) {
        const t0 = s.tick(), found = await waitUntil(s, () => (st()?.nearbyNpcs ?? []).some((n: any) => ids.includes(n.id) && !n.inCombat && n.distance <= 15), { timeoutTicks: tally.kills ? 100 : 30 });
        tally.idle += s.tick() - t0;
        if (!found) return 'break';
        return 'continue';
    }
    // A ranged kill wields the bow and the arrows from the pack first; without them in the pack the fight is not taken.
    if (g.kit === 'ranged') {
        const worn = () => s.sdk.getEquipment().map((i: any) => i.id);
        for (const ids2 of [BOWS, ARROWS]) {
            if (ids2.some(id => worn().includes(id))) continue;
            const item = (st()?.inventory ?? []).find((i: any) => ids2.includes(i.id));
            if (!item) return { error: `ranged kill of ${npc.name} needs ${ids2 === BOWS ? 'a bow' : 'arrows'} in the pack` };
            await s.bot.equipItem(item);
            await waitUntil(s, () => worn().includes(item.id), { timeoutTicks: 5 });
        }
    }
    // A magic kill wields the staff from the pack and casts the strongest strike the pack's runes allow at the target
    // every five ticks (the cast rate, player_magic.rs2) until it dies or drops; without the runes the fight is not taken.
    let spell: MagicKit | null = null;
    if (g.kit === 'magic') {
        const worn = () => s.sdk.getEquipment().map((i: any) => i.id);
        const magic = st()?.skills?.find((k: any) => k.name === 'Magic')?.baseLevel ?? 1;
        spell = magicKit([...(st()?.inventory ?? []), ...s.sdk.getEquipment()].map((i: any) => ({ id: i.id, count: i.count })), magic, Math.max(1, castsPerKill(g.id, 8)));
        if (!spell) return { error: `magic kill of ${npc.name} needs a strike spell's runes in the pack` };
        const staff = spell.staff === undefined ? undefined : (st()?.inventory ?? []).find((i: any) => i.id === spell!.staff);
        if (staff && !worn().includes(spell.staff!)) {
            await s.bot.equipItem(staff);
            await waitUntil(s, () => worn().includes(spell!.staff!), { timeoutTicks: 5 });
        }
    }
    const seen = new Map<string, number>();
    for (const i of lying()) seen.set(`${i.x},${i.z}`, (seen.get(`${i.x},${i.z}`) ?? 0) + 1);
    const cast = () => s.direct({ type: 'spellOnNpc', npcIndex: npc.index, spellComponent: componentId(spell!.component), reason: 'SDK' });
    const r: any = spell ? await cast() : await s.bot.attack(npc);
    if (!r?.success) { await waitTicks(s, 2); return 'continue'; }
    tally.fights++;
    const gone = () => !(st()?.nearbyNpcs ?? []).some((n: any) => n.index === npc.index);
    const drop = () => {
        const now = new Map<string, number>();
        for (const i of lying()) now.set(`${i.x},${i.z}`, (now.get(`${i.x},${i.z}`) ?? 0) + 1);
        return lying().find((i: any) => (now.get(`${i.x},${i.z}`) ?? 0) > (seen.get(`${i.x},${i.z}`) ?? 0));
    };
    // A fight that reaches the hitpoint floor is abandoned: the bot walks away and the sweep fails short of the item.
    const hp = () => st()?.skills?.find((k: any) => k.name === 'Hitpoints'), floor = Math.max(5, Math.ceil((hp()?.baseLevel ?? 10) * 0.25)), low = () => (hp()?.level ?? 99) <= floor;
    if (spell) {
        for (let t = 0; t < 30 && !(gone() || drop() || low()); t++) {
            await waitTicks(s, 5);
            if (!(gone() || drop() || low())) await cast();
        }
    } else {
        await waitUntil(s, () => gone() || !!drop() || low(), { timeoutTicks: 150 });
    }
    if (low()) {
        const p = here(), dx = Math.sign(p.x - npc.x) || 1, dz = Math.sign(p.z - npc.z);
        await s.direct({ type: 'walkTo', x: p.x + dx * 20, z: p.z + dz * 20, running: true, reason: 'SDK' });
        await waitUntil(s, () => !(st()?.player?.combat?.inCombat), { timeoutTicks: 40 });
        return { error: `kill of ${npc.name} abandoned at ${hp()?.level} of ${hp()?.baseLevel} hitpoints` };
    }
    // The drop lands as the animal dies; a kill without one (123 of 128 goblins) moves on after three ticks.
    if (gone()) tally.kills++;
    if (!await waitUntil(s, () => !!drop(), { timeoutTicks: 3 })) return 'continue';
    tally.drops++;
    const got = drop();
    await s.bot.pickupItem(got);
    console.log(`QUEST_SWEEP_KILL ${JSON.stringify({ item: g.id, drop: got.id, npc: npc.name, at: { x: npc.x, z: npc.z }, held: held(g.id) })}`);
    return 'wait';
}

async function stepMilk(ctx: GatherCtx, before: number): Promise<StepOutcome> {
    const { s, st, held } = ctx;
    if (!await waitUntil(s, () => (st()?.nearbyNpcs ?? []).some((n: any) => n.id === COW), { timeoutTicks: 20 })) return 'break';
    const cow = (st()?.nearbyNpcs ?? []).filter((n: any) => n.id === COW).sort((a: any, b: any) => a.distance - b.distance)[0];
    const bucket = (st()?.inventory ?? []).find((i: any) => i.id === BUCKET);
    if (!bucket) return { error: `milk needs an empty bucket (${BUCKET})` };
    const buckets = held(BUCKET);
    await s.bot.useItemOnNpc(bucket, cow);
    // The server exchanges one empty bucket for one milk. Wait for both observations before using another bucket.
    if (await waitUntil(s, () => held(MILK) === before + 1 && held(BUCKET) === buckets - 1, { timeoutTicks: 15 })) return 'continue';
    if (held(MILK) !== before || held(BUCKET) !== buckets) return { error: 'milk conversion unconfirmed: need one milk credit and one empty bucket debit' };
    return 'continue';
}

async function stepLoc(ctx: GatherCtx, g: Gather): Promise<StepOutcome> {
    const { s, st } = ctx;
    const src = LOC_SOURCES[g.id]!, ops = (l: any) => (l.optionsWithIndex ?? []).map((o: any) => o.text as string);
    const loc = () => (st()?.nearbyLocs ?? []).filter((l: any) => l.x === src.tile.x && l.z === src.tile.z).find((l: any) => ops(l).some((o: string) => src.open.test(o) || src.take.test(o)));
    const l0 = loc();
    if (!l0) return 'break';
    if (ops(l0).some((o: string) => src.open.test(o))) {
        await s.bot.interactLoc(l0, src.open);
        await waitUntil(s, () => !!loc() && ops(loc()).some((o: string) => src.take.test(o)), { timeoutTicks: 10 });
    }
    const l1 = loc();
    if (l1 && ops(l1).some((o: string) => src.take.test(o))) await s.bot.interactLoc(l1, src.take);
    return 'wait';
}

async function stepSpawn(ctx: GatherCtx, g: Gather): Promise<StepOutcome> {
    const { s, st } = ctx;
    // A taken item respawns at its tile; wait for it there.
    if (!await waitUntil(s, () => (st()?.groundItems ?? []).some((i: any) => i.id === g.id && i.distance <= 10), { timeoutTicks: 100 })) return 'break';
    const item = (st()?.groundItems ?? []).filter((i: any) => i.id === g.id).sort((a: any, b: any) => a.distance - b.distance)[0];
    await s.bot.pickupItem(item);
    return 'wait';
}

// Walk to each source, nearest first, and take the item until the pack holds the planned count. A ground spawn is
// waited on for its respawn; a source out of reach gives way to the next.
export async function gatherItems(
    s: Session,
    world: World,
    gathers: readonly Gather[],
    walk: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> = to => goTo(s, world, to, accountOf(s), { legTimeoutTicks: 100 }),
): Promise<string | null> {
    const st = () => s.sdk.getState() as any;
    const held = (id: number) => count((st()?.inventory ?? []).map((i: any) => ({ id: i.id, count: i.count })), id);
    const here = (): Tile => { const p = st()?.player; return { x: p?.worldX ?? 0, z: p?.worldZ ?? 0, level: p?.level ?? 0 }; };
    // Each gather's target is fixed before any runs: a bead taken during another colour's series counts toward its own.
    const targets = new Map(gathers.map(g => [g.id, held(g.id) + g.count]));
    const ctx: GatherCtx = { s, st, held, here, walk, gathers, targets };

    for (const g of gathers) {
        const target = targets.get(g.id)!, sources = gatherSources(g, here());
        // Spawns lie in clusters (three egg spawns within 4 tiles beyond White Wolf Mountain): one with no route rules out
        // the rest of its cluster, so the walk moves on to the next place rather than searching the same ground again.
        const unreachable: Tile[] = [];
        for (const at of sources) {
            if (held(g.id) >= target) break;
            if (unreachable.some(u => u.level === at.level && Math.max(Math.abs(u.x - at.x), Math.abs(u.z - at.z)) <= CLUSTER)) continue;
            const walked = await walk(at);
            console.log(`QUEST_SWEEP_GATHER_WALK ${JSON.stringify({ item: g.id, how: g.how, to: at, ok: walked.ok, detail: walked.detail })}`);
            if (!walked.ok) { unreachable.push(at); continue; }
            // A kill series at one source is summed when the source is left: kills, drops, and the ticks it stood with no free
            // animal in sight, so a run that ends short says whether the animals or the budget ran out.
            // A kill's attempt budget counts fights begun, not waits for a free animal or refused clicks; 400 rounds bound the rest.
            const tally = { kills: 0, drops: 0, idle: 0, fights: 0, start: s.tick() };
            // A swing at a rock misses as often as it hits at Mining 1, so a mine has four tries an ore.
            for (let tries = 0; tries < 400 && (g.how === 'kill' ? tally.fights < killAttempts(g.id, g.count) : tries < (g.how === 'mine' ? 4 * g.count : g.count) + 3) && held(g.id) < target; tries++) {
                const before = held(g.id);
                const outcome: StepOutcome =
                    g.how === 'mine' ? await stepMine(ctx, g, at, before)
                        : g.how === 'burn' ? await stepBurn(ctx, g, before)
                        : g.how === 'use' ? await stepUse(ctx, g, at, before)
                        : g.how === 'combine' ? await stepCombine(ctx, g)
                        : g.how === 'pick' ? await stepPick(ctx, g)
                        : g.how === 'npc' ? await stepNpc(ctx, g, before)
                        : g.how === 'kill' ? await stepKill(ctx, g, tally)
                        : g.how === 'milk' ? await stepMilk(ctx, before)
                        : g.how === 'loc' ? await stepLoc(ctx, g)
                        : await stepSpawn(ctx, g);
                if (typeof outcome === 'object') return outcome.error;
                if (outcome === 'break') break;
                if (outcome === 'continue') continue;
                await waitUntil(s, () => held(g.id) > before, { timeoutTicks: 15 });
            }
            if (g.how === 'kill') console.log(`QUEST_SWEEP_KILLS ${JSON.stringify({ item: g.id, at, fights: tally.fights, kills: tally.kills, drops: tally.drops, idle: tally.idle, ticks: s.tick() - tally.start, held: held(g.id), target })}`);
        }
        // The route search plans from the ground floor: come down from an upstairs source.
        for (let i = 0; i < 3 && here().level > 0; i++) {
            const lvl = here().level, down = (st()?.nearbyLocs ?? []).filter((l: any) => (l.optionsWithIndex ?? []).some((o: any) => /climb-down/i.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
            if (!down) break;
            await s.bot.interactLoc(down, /climb-down/i);
            await waitUntil(s, () => here().level < lvl, { timeoutTicks: 30 });
        }
        console.log(`QUEST_SWEEP_GATHER ${JSON.stringify({ item: g.id, how: g.how, count: g.count, held: held(g.id), target })}`);
        if (held(g.id) < target) return `gathered ${g.count - (target - held(g.id))} of ${g.count} item ${g.id} (${g.how})`;
    }
    return null;
}
