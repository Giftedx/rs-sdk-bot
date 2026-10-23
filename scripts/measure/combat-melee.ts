// Melee XP per tick at a multiway spot, with or without a dwarf cannon.
// Usage: CANNON=1 bun scripts/measure/combat-melee.ts <bot> [ticks=300]
// Env: TARGET = NPC name regex (default ^white knight$), STYLE = combat style index (default 1, aggressive on a
// scimitar: Strength XP), RELOAD = ticks between cannon top-ups (default 30), CANNON=1 to set up the cannon first.
// Presets: combat_wk_40, combat_wk_70, combat_wk_90 (Falador castle courtyard, multiway, maps/multiway.csv "falador")
// and the *_cannon variants (%mcannon varp 0 = 11 complete, cannon parts 6/8/10/12, cannonballs 2).
//
// Code facts (rev 289, CODE-READ):
// - Melee XP: 4 x base per damage to the style skill, 1.33 x base to Hitpoints (combat.rs2:143-167). At 25x that is
//   100 style XP and 33.25 Hitpoints XP per damage point, so damage = style XP / 100.
// - Cannon: [timer,cannon_rotate] turns one of 8 directions per tick and fires at most once per tick
//   (cannon_fire.rs2:1-91), 2 Ranged XP per damage (line 119), so cannon damage = Ranged XP / 50. Holds 30 balls.
// - Eating and item-on-loc clear the NPC interaction (OpHeld/OpLocU), so the bot re-attacks on the next tick.
// Prints RATE lines per skill and a RESULT line with damage per tick and the share of ticks in combat.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const [bot, tArg] = process.argv.slice(2);
const CAP = Number(tArg ?? 300);
const TARGET = new RegExp(process.env.TARGET ?? '^white knight$', 'i');
const STYLE = Number(process.env.STYLE ?? 1);
const CANNON = process.env.CANNON === '1';
const RELOAD = Number(process.env.RELOAD ?? 30);
// Cannon policy: NEAR = fight only NPCs within NEAR tiles of the cannon centre (default 10); TOPUP_ADJ=1 = a timed top-up
// waits until the bot stands next to the cannon (Chebyshev <= 2 from the centre) or is between targets.
const NEAR = Number(process.env.NEAR ?? 10);
const TOPUP_ADJ = process.env.TOPUP_ADJ === '1';
const FOOD = /^(lobster|swordfish|shark)$/i;
const s = await openBot(bot!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const st = () => s.sdk.getState()!;
    const me = () => st().player!;
    console.log(`START ${me().worldX} ${me().worldZ} ${me().level}`);
    const inv = () => s.sdk.getInventory() ?? [];
    const slotOf = (re: RegExp) => inv().find((i: any) => re.test(i.name)) as any;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const maxHp = s.sdk.getSkill('Hitpoints')?.baseLevel ?? 10;
    const xp = (k: string) => s.sdk.getSkillXp(k) ?? 0;
    const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
    const msgs: string[] = [];
    const seenMsg = new Set<string>();
    s.onTick(() => {
        for (const m of (st().gameMessages ?? []) as any[]) {
            const k = `${m.observationId ?? ''}:${m.tick}:${m.text}`;
            if (seenMsg.has(k)) continue;
            seenMsg.add(k);
            msgs.push(m.text);
        }
    });
    const sawMsg = (re: RegExp, from: number) => msgs.slice(from).some(t => re.test(t));
    await s.direct({ type: 'setCombatStyle', style: STYLE, reason: 'SDK' });
    await waitTicks(s, 2);
    const cs = st().combatStyle;
    console.log(`NOTE style=${cs?.currentStyle} weapon=${cs?.weaponName} autoRetaliate=${st().autoRetaliateEnabled} hp=${hp()}/${maxHp}`);

    // ---- Cannon setup (outside the measured window) ----
    let cannon: { x: number; z: number; id: number } | null = null;
    let setupTicks = 0;
    const findCannon = () => (st().nearbyLocs ?? []).filter((l: any) => /cannon/i.test(l.name)).sort((a: any, b: any) => a.distance - b.distance)[0] as any;
    if (CANNON) {
        const c0 = s.tick();
        const base = slotOf(/^cannon base$/i);
        if (!base) await finish([s], false, 'no cannon base in pack');
        const op = base.optionsWithIndex.find((o: any) => /set-?up/i.test(o.text))?.opIndex ?? 1;
        // A cannon left by an earlier run (decay 2,500 ticks, cannon.constant) blocks the spot: stand 6+ tiles away from it.
        const spots = [[0, 0], [8, 0], [-8, 4], [4, 8], [-6, -6], [10, 8]];
        const p0 = me();
        for (const [dx, dz] of spots) {
            const c = findCannon();
            const sx = p0.worldX + dx!, sz = p0.worldZ + dz!;
            if (!c || cheb({ x: c.x + 1, z: c.z + 1 }, { x: sx, z: sz }) >= 6) {
                if (dx || dz) { await s.bot.walkTo(sx, sz, 0); await waitTicks(s, 1); }
                break;
            }
        }
        let m0 = msgs.length;
        await s.direct({ type: 'useInventoryItem', slot: base.slot, optionIndex: op, reason: 'SDK' });
        await waitUntil(s, () => sawMsg(/place the cannon base|can't|cannot|isn't enough|won't be happy/i, m0), { timeoutTicks: 8 });
        if (!sawMsg(/place the cannon base/i, m0)) await finish([s], false, `cannon base not placed: ${msgs.slice(m0).join(' | ')}`);
        await waitTicks(s, 1);
        for (const part of [/^cannon stand$/i, /^cannon barrels$/i, /^cannon furnace$/i]) {
            const p = slotOf(part), l = findCannon();
            if (!p || !l) await finish([s], false, `missing ${part} or loc`);
            const name0 = l.name, id0 = l.id;
            await s.direct({ type: 'useItemOnLoc', itemSlot: p.slot, x: l.x, z: l.z, locId: l.id, reason: 'SDK' });
            await waitUntil(s, () => { const n = findCannon(); return !!n && n.id !== id0; }, { timeoutTicks: 8 });
            console.log(`NOTE cannon ${name0} -> ${findCannon()?.name} t=${s.tick() - c0}`);
        }
        const l = findCannon();
        const balls = slotOf(/^cannonball$/i);
        m0 = msgs.length;
        await s.direct({ type: 'useItemOnLoc', itemSlot: balls.slot, x: l.x, z: l.z, locId: l.id, reason: 'SDK' });
        await waitUntil(s, () => sawMsg(/load the cannon/i, m0), { timeoutTicks: 6 });
        const fire = l.optionsWithIndex.find((o: any) => /fire/i.test(o.text))?.opIndex ?? 1;
        await s.direct({ type: 'interactLoc', x: l.x, z: l.z, locId: l.id, optionIndex: fire, reason: 'SDK' });
        await waitTicks(s, 2);
        cannon = { x: l.x, z: l.z, id: l.id };
        setupTicks = s.tick() - c0;
        console.log(`NOTE cannon up at ${l.x},${l.z} id=${l.id} setupTicks=${setupTicks} msgs=${msgs.slice(-4).join(' | ')}`);
    }

    // ---- Measured window ----
    const skills = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged'];
    const x0: Record<string, number> = Object.fromEntries(skills.map(k => [k, xp(k)]));
    const t0 = s.tick();
    let inCombat = 0, attacks = 0, eats = 0, reloads = 0, refires = 0, kills = 0, idle = 0;
    let lastReload = t0, target = -1, ammoMsgAt = msgs.length, loadPending = -1, loadMsgAt = 0, needFire = false, firePending = -1;
    let dmgTaken = 0, lastStyleXp = xp('Attack') + xp('Strength') + xp('Defence'), lastGain = -99, attackAt = -99;
    const bad = new Map<number, number>();
    const seenHit = new Set<string>();
    await new Promise<void>(resolve => {
        const off = s.onTick(() => {
            const now = s.tick();
            if (now - t0 >= CAP || hp() <= 0) { off(); resolve(); return; }
            for (const e of (st().combatEvents ?? []) as any[]) {
                const k = `${e.observationId ?? ''}:${e.tick}:${e.type}:${e.sourceIndex}:${e.targetIndex}:${e.damage}`;
                if (seenHit.has(k)) continue;
                seenHit.add(k);
                if (e.type === 'damage_taken') dmgTaken += e.damage;
                if (e.type === 'kill') kills++;
            }
            const p = me();
            const npcs = (st().nearbyNpcs ?? []) as any[];
            const cur = npcs.find(n => n.index === target);
            // Fighting = our target is alive and style XP came in within the last 10 ticks (or the attack is under 10 ticks old).
            const sx = xp('Attack') + xp('Strength') + xp('Defence');
            if (sx > lastStyleXp) { lastStyleXp = sx; lastGain = now; }
            const fighting = !!cur && (cur.hp ?? 1) > 0 && (now - lastGain < 10 || now - attackAt < 10);
            if (!fighting && cur && now - attackAt >= 10 && now - lastGain >= 10) bad.set(target, now + 60);
            if (fighting) inCombat++;
            // 1. Eat below 40% (or 12 under max for low HP).
            if (hp() <= Math.max(Math.floor(maxHp * 0.4), Math.min(maxHp - 12, 8))) {
                const f = slotOf(FOOD);
                if (f) { void s.direct({ type: 'useInventoryItem', slot: f.slot, optionIndex: 1, reason: 'SDK' }); eats++; target = -1; return; }
            }
            // 2. Cannon (fixed handling): a load is pending until "You load the cannon" / "already full" or 8 ticks;
            //    no attack click in that time (an attack click replaces the walk to the cannon). After "out of ammo",
            //    Fire once the load lands.
            if (cannon) {
                if (loadPending >= 0) {
                    if (sawMsg(/load the cannon|already full/i, loadMsgAt) || now - loadPending >= 8) {
                        loadPending = -1;
                        if (needFire) { needFire = false; void s.direct({ type: 'interactLoc', x: cannon.x, z: cannon.z, locId: cannon.id, optionIndex: 1, reason: 'SDK' }); refires++; target = -1; firePending = now; return; }
                    } else return;
                }
                if (firePending >= 0 && now - firePending < 2) return;
                firePending = -1;
                const empty = sawMsg(/out of ammo/i, ammoMsgAt);
                const adj = cheb({ x: cannon.x + 1, z: cannon.z + 1 }, { x: p.worldX, z: p.worldZ }) <= 2;
                if (empty || (now - lastReload >= RELOAD && (!TOPUP_ADJ || adj || !fighting))) {
                    const balls = slotOf(/^cannonball$/i);
                    if (balls) {
                        if (empty) { needFire = true; ammoMsgAt = msgs.length; }
                        loadMsgAt = msgs.length; loadPending = now;
                        void s.direct({ type: 'useItemOnLoc', itemSlot: balls.slot, x: cannon.x, z: cannon.z, locId: cannon.id, reason: 'SDK' });
                        reloads++; lastReload = now; target = -1; return;
                    }
                }
            }
            if (fighting) return;
            // 3. Re-target: nearest live target (near the cannon when one is up). Multiway, so a knight already in
            //    combat with us is fine.
            const anchor = cannon ? { x: cannon.x + 1, z: cannon.z + 1 } : { x: p.worldX, z: p.worldZ };
            const cand = npcs
                .filter(n => TARGET.test(n.name) && (n.hp ?? 1) > 0 && !((bad.get(n.index) ?? 0) > now) && n.optionsWithIndex?.some((o: any) => /attack/i.test(o.text)) && cheb({ x: n.x, z: n.z }, anchor) <= (cannon ? NEAR : 20))
                .sort((a, b) => (a.reachable === false ? 1 : 0) - (b.reachable === false ? 1 : 0) || (b.targetIndex >= 0 ? 1 : 0) - (a.targetIndex >= 0 ? 1 : 0) || a.distance - b.distance)[0];
            if (!cand) {
                if (idle++ % 20 === 0) console.log('NOTE idle t=' + (now - t0) + ' at ' + p.worldX + ',' + p.worldZ + ' knights=' + npcs.filter(n => TARGET.test(n.name)).map(n => n.x + ',' + n.z + ':hp' + n.hp + ':r' + n.reachable + ':bad' + ((bad.get(n.index) ?? 0) > now)).join(' '));
                return;
            }
            const op = cand.optionsWithIndex.find((o: any) => /attack/i.test(o.text)).opIndex;
            void s.direct({ type: 'interactNpc', npcIndex: cand.index, optionIndex: op, reason: 'SDK' });
            target = cand.index; attacks++; attackAt = now;
        });
        void s.ended.then(() => { off(); resolve(); });
    });
    const ticks = s.tick() - t0;
    const g: Record<string, number> = Object.fromEntries(skills.map(k => [k, xp(k) - x0[k]!]));
    if (cannon) { await s.direct({ type: 'interactLoc', x: cannon.x, z: cannon.z, locId: cannon.id, optionIndex: 2, reason: 'SDK' }); await waitTicks(s, 6); }
    for (const k of skills) if (g[k]) console.log(`RATE ${k.toLowerCase()} ${g[k]} ${ticks}`);
    const style = g.Attack! + g.Strength! + g.Defence!;
    const meleeDmg = style / 100, cannonDmg = g.Ranged! / 50;
    const lvl = (k: string) => s.sdk.getSkill(k)?.baseLevel;
    await finish([s], style > 0 && hp() > 0,
        `cannon=${CANNON} ticks=${ticks} styleXp=${style} styleXpPerTick=${(style / ticks).toFixed(1)} hpXp=${g.Hitpoints} hpXpPerTick=${(g.Hitpoints! / ticks).toFixed(1)} ` +
        `rangedXp=${g.Ranged} rangedXpPerTick=${(g.Ranged! / ticks).toFixed(1)} meleeDmgPerTick=${(meleeDmg / ticks).toFixed(3)} cannonDmgPerTick=${(cannonDmg / ticks).toFixed(3)} ` +
        `inCombat=${inCombat} inCombatShare=${(inCombat / ticks).toFixed(3)} attacks=${attacks} kills=${kills} idle=${idle} eats=${eats} food=${countItems(s, FOOD)} dmgTaken=${dmgTaken} ` +
        `near=${NEAR} topupAdj=${TOPUP_ADJ} reload=${RELOAD} reloads=${reloads} refires=${refires} setupTicks=${setupTicks} balls=${countItems(s, /^cannonball$/i)} hp=${hp()}/${maxHp} lv=${lvl('Attack')}/${lvl('Strength')}/${lvl('Defence')}/${lvl('Hitpoints')}/${lvl('Ranged')}`);
} catch (e) { await finish([s], false, String(e)); }
