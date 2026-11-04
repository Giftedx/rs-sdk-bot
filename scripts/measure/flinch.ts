// Flinch 2-tick gathering benchmark. Usage: bun scripts/measure/flinch.ts <bot> [ticks=300]
// Env: TARGET = loc name regex (default ^oak$), ATTACKER = NPC name regex (default ^barbarian$), PHASE_TRIES (default 8).
// Presets: flinch_oak_15, flinch_oak_45 (Barbarian Village oak, multiway zone; shortbow, pot, bucket, food).
//
// Mechanism (code-read):
// - An NPC melee hit (also a miss) queues playerhit_n_retaliate with delay 0 (npc_combat_melee.rs2:28-48); the
//   queue runs the same tick (Player.ts processQueue, delay <= 0). With auto-retaliate on and busy2 = false, and
//   %action_delay < map_clock, it sets %action_delay = map_clock + attackrate/2 - (1 on rapid)
//   (auto_retaliate.rs2:7-25). Shortbow attackrate is the default 4 (combat.param:76-78), so rapid gives clock + 1.
// - busy2 = hasInteraction() or hasWaypoints() (PlayerOps.ts BUSY2). The woodcut script re-ops after every roll
//   (woodcut.rs2:101, :160), so on the hit tick the bot must first clear the interaction. An OpHeldU packet does
//   that (clearPendingAction) before the queue runs; pot on bucket has no script and does not touch %action_delay.
// - A tree click on hit tick + 1 sees %action_delay = map_clock and rolls at once (woodcut.rs2:55, :97).
// - Two NPCs with a 4-tick attack, 2 ticks out of phase, give one roll every 2 ticks. Single-way zones allow only one
//   attacker (npc_combat.rs2:382-390), so this needs a multiway zone (maps/multiway.csv).
//
// Each tick: if the previous tick had an NPC hit on us, click the tree; else send pot-on-bucket (clear).
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const [bot, tArg] = process.argv.slice(2);
const CAP = Number(tArg ?? 300);
const TARGET = new RegExp(process.env.TARGET ?? '^oak$', 'i');
const ATTACKER = new RegExp(process.env.ATTACKER ?? '^barbarian$', 'i');
const PHASE_TRIES = Number(process.env.PHASE_TRIES ?? 8);
// RES=fish: click a fishing spot option OPT (default harpoon) in place of a tree. AGGRO=1: the attackers are
// aggressive, so do not punch them, only wait for their hits. PRAY=1: turn on Protect from Melee (prayer 14).
const RES = process.env.RES ?? 'wc';
const OPT = new RegExp(`^${process.env.OPT ?? 'harpoon'}$`, 'i');
const DROP = new RegExp(process.env.DROP ?? (RES === 'fish' ? '^raw (shark|tuna|swordfish|lobster|mackerel|cod|bass)$' : '^oak logs$'), 'i');
const SKILL = RES === 'fish' ? 'Fishing' : 'Woodcutting';
const s = await openBot(bot!);
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState()!;
    const tStart = s.tick();
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name));
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const hp0 = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
    // Hit log: tick -> source npc indexes. Filled from combatEvents (damage_taken from an npc), deduplicated.
    const hits = new Map<number, Set<number>>();
    const seen = new Set<string>();
    let lastHitTick = -1;
    let dmg = 0;
    s.onTick(() => {
        for (const e of (st().combatEvents ?? []) as any[]) {
            if (e.type !== 'damage_taken' || e.sourceType !== 'npc') continue;
            const k = `${e.observationId ?? ''}:${e.tick}:${e.sourceIndex}:${e.damage}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const t = s.tick();
            if (!hits.has(t)) hits.set(t, new Set());
            hits.get(t)!.add(e.sourceIndex);
            lastHitTick = t;
            dmg += e.damage;
        }
    });
    const attackers = () => (st().nearbyNpcs ?? []).filter((n: any) => ATTACKER.test(n.name) && n.optionsWithIndex?.some((o: any) => /attack/i.test(o.text))).sort((a: any, b: any) => a.distance - b.distance);
    const attackOp = (n: any) => n.optionsWithIndex.find((o: any) => /attack/i.test(o.text))!.opIndex;
    // 1. Unarmed, punch two attackers so both fight back (multiway zone).
    const targets: number[] = [];
    // Try up to 5 candidates until 2 distinct NPCs have hit us (a candidate that never fights back is skipped).
    const hitters = () => new Set([...hits.values()].flatMap(v => [...v]));
    if (process.env.AGGRO === '1') await waitUntil(s, () => hitters().size >= 2, { timeoutTicks: 60 });
    for (const n of process.env.AGGRO === '1' ? [] : attackers().slice(0, 5)) {
        if (hitters().size >= 2) break;
        if (hitters().has(n.index)) continue;
        await s.direct({ type: 'interactNpc', npcIndex: n.index, optionIndex: attackOp(n), reason: 'SDK' });
        const ok = await waitUntil(s, () => [...hits.values()].some(v => v.has(n.index)), { timeoutTicks: 20 });
        console.log(`WARN punch ${n.index} ${n.name} dist=${n.distance} foughtBack=${ok}`);
        if (ok) targets.push(n.index);
    }
    // 2. Wield the shortbow (no arrows) and pick Rapid (style index 1 on the bow tab).
    const bow = slotOf(/^shortbow$/i);
    if (bow) {
        const wield = bow.optionsWithIndex?.find((o: any) => /wield/i.test(o.text))?.opIndex ?? 2;
        await s.direct({ type: 'useInventoryItem', slot: bow.slot, optionIndex: wield, reason: 'SDK' });
        await waitTicks(s, 2);
    }
    await s.direct({ type: 'setCombatStyle', style: 1, reason: 'SDK' });
    if (process.env.PRAY === '1') await s.direct({ type: 'togglePrayer', prayerIndex: 14, reason: 'SDK' });
    const pray0 = s.sdk.getSkill('Prayer')?.level ?? 0;
    await waitTicks(s, 2);
    const cs = st().combatStyle;
    console.log(`WARN style=${cs?.currentStyle} weapon=${cs?.weaponName} autoRetaliate=${st().autoRetaliateEnabled} attackers=${targets.join(',')}`);
    // Stand next to the tree; the attackers follow.
    const spot = () => (st().nearbyNpcs ?? []).filter((n: any) => /fishing spot/i.test(n.name) && n.optionsWithIndex?.some((o: any) => OPT.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
    const tr0 = RES === 'fish' ? spot() : (st().nearbyLocs ?? []).filter((l: any) => TARGET.test(l.name)).sort((a: any, b: any) => a.distance - b.distance)[0];
    if (tr0 && tr0.distance > 1) { await s.bot.walkTo(tr0.x, tr0.z, 1); await waitTicks(s, 2); }
    // 3. Phase check: hits from the two attackers should be 2 ticks apart (mod 4).
    const phase = () => {
        const per = new Map<number, number[]>();
        for (const [t, v] of hits) for (const i of v) { if (!per.has(i)) per.set(i, []); per.get(i)!.push(t); }
        const lists = [...per.values()].filter(a => a.length >= 2);
        if (lists.length < 2) return -1;
        // Attack period from the first attacker's last two hits (4 for attackrate 4; barbarians are 5).
        const a = lists[0]!, b = lists[1]!;
        period = a[a.length - 1]! - a[a.length - 2]!;
        return period > 0 ? (((a[a.length - 1]! - b[b.length - 1]!) % period) + period) % period : -1;
    };
    let period = 4;
    // Good phase: hits never on adjacent ticks, so each hit tick + 1 is free for the click.
    const goodPhase = (p: number) => p >= 2 && p <= period - 2;
    let tries = 0;
    for (; tries < PHASE_TRIES; tries++) {
        const since = s.tick();
        await waitTicks(s, 9);
        const recent = [...hits.entries()].filter(([t]) => t > since);
        const p = phase();
        console.log(`WARN phase try ${tries} offset=${p} period=${period} hitTicks=${recent.map(([t, v]) => `${t - tStart}:${[...v].join('/')}`).join(' ')}`);
        if (goodPhase(p)) break;
        // Perturb: one step away and back, so one attacker re-paths and its attack timer shifts.
        const me = st().player!;
        await s.direct({ type: 'walkTo', x: me.worldX + (tries % 2 ? 1 : -1), z: me.worldZ, reason: 'SDK' });
        await waitTicks(s, 2);
        await s.direct({ type: 'walkTo', x: me.worldX, z: me.worldZ, reason: 'SDK' });
        await waitTicks(s, 2);
    }
    const setupTicks = s.tick() - tStart;
    // 4. Main loop, one input per tick, reactive to the hit seen last tick.
    const tree = () => (st().nearbyLocs ?? []).filter((l: any) => TARGET.test(l.name) && l.optionsWithIndex.some((o: any) => /chop/i.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
    const xp = () => s.sdk.getSkillXp(SKILL) ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    let clicks = 0, clears = 0, eats = 0, drops = 0, hitTicks0 = hits.size;
    await new Promise<void>(resolve => {
        const off = s.onTick(() => {
            const now = s.tick();
            if (now - t0 >= CAP) { off(); resolve(); return; }
            if (hp() > 0 && hp() < Math.max(5, Math.floor(hp0 / 3))) {
                const food = slotOf(/^(lobster|shrimps|trout|salmon|shark|cooked karambwan)$/i);
                if (food) { void s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' }); eats++; return; }
            }
            if (lastHitTick === now && RES === 'fish') {
                const sp = spot();
                if (sp) {
                    const op = sp.optionsWithIndex.find((o: any) => OPT.test(o.text))!.opIndex;
                    void s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: op, reason: 'SDK' });
                    clicks++;
                    return;
                }
            }
            if (lastHitTick === now && RES !== 'fish') {
                const t = tree();
                if (t) {
                    const chop = t.optionsWithIndex.find((o: any) => /chop/i.test(o.text))!.opIndex;
                    void s.direct({ type: 'interactLoc', x: t.x, z: t.z, locId: t.id, optionIndex: chop, reason: 'SDK' });
                    clicks++;
                    return;
                }
            }
            if ((s.sdk.getInventory()?.length ?? 0) >= 27) {
                const lg = slotOf(DROP);
                if (lg) { void s.direct({ type: 'dropItem', slot: lg.slot, reason: 'SDK' }); drops++; return; }
            }
            const pot = slotOf(/^pot$/i), bucket = slotOf(/^bucket$/i);
            if (pot && bucket) { void s.direct({ type: 'useItemOnItem', sourceSlot: pot.slot, targetSlot: bucket.slot, reason: 'SDK' }); clears++; }
        });
        void s.ended.then(() => { off(); resolve(); });
    });
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    const hitN = hits.size - hitTicks0;
    console.log(`RATE ${SKILL.toLowerCase()} ${gained} ${ticks}`);
    await finish([s], gained > 0, `mode=flinch res=${RES} xp0=${xp0} gained=${gained} ticks=${ticks} perTick=${(gained / ticks).toFixed(1)} setupTicks=${setupTicks} phaseTries=${tries} period=${period} attackers=${targets.length} hitTicks=${hitN} clicks=${clicks} clears=${clears} drops=${drops} eats=${eats} dmgTaken=${dmg} hp=${hp()}/${hp0} kept=${countItems(s, DROP)} prayer=${s.sdk.getSkill('Prayer')?.level ?? 0}/${pray0} lvl=${s.sdk.getSkill(SKILL)?.baseLevel}`);
} catch (e) { await finish([s], false, String(e)); }
