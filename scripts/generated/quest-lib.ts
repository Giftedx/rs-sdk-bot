// Shared helpers for the short-quest scripts (scripts/generated/quest-*.ts). The helpers are the ones proved in
// dwarfcannon.ts and waterfall.ts: walkPath first (it opens doors; SDK collision treats doors as open), clicks sent
// again when the server drops them inside a p_delay, one dialog page per tick, MILESTONE / WARN lines, a death check.
import { openBot, finish } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { sessionWalker, walkPath, type PathPoint } from '../../packages/core/src/walk';
import { componentId } from '../../packages/core/src/logout';

export interface Loc { id: number; x: number; z: number }
export const LUMBRIDGE = { x: 3222, z: 3218 };
export const SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];

// lumbridgeOk: the script teleports to Lumbridge, so a jump there is not a death (respawn and life id still count).
export async function openQuest(opts: { cap?: number; eatAt?: number; food?: number[]; trace?: boolean; lumbridgeOk?: boolean } = {}) {
    const CAP = opts.cap ?? 3000;
    const EAT_AT = opts.eatAt ?? 40;
    const FOOD = opts.food ?? [379];
    const TRACE = opts.trace ?? process.env.Q_TRACE === '1';
    const s: Session = await openBot(process.argv[2]!);
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
    const dialogOpen = (): boolean => !!s.sdk.getDialog()?.isOpen;
    // Dialog text seen so far: getDialog().text is often empty and recentDialogs keeps few pages, so every tick's page
    // text (text plus allComponents[].text) is kept here (last 400 pages).
    const pages: string[] = [];
    let lastPage = '';
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
    let eatCool = 0;
    const off = s.onTick(() => {
        const p = pos();
        const h = hp();
        if (h > 0 && h < stats.hpMin) {
            stats.hpMin = h;
            if (h <= 50) console.log(`WARN hp ${h} at ${T()} ${p?.worldX},${p?.worldZ},${p?.level}`);
        }
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
        if (eatCool > 0) eatCool--;
        if (h > 0 && h <= EAT_AT && eatCool === 0) {
            const food = inv().find(i => FOOD.includes(i.id));
            if (food) { stats.eats++; eatCool = 3; void s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' }); }
        }
    });

    const detail = (): string => {
        const p = pos();
        const msgs = (st()?.gameMessages ?? []).filter((m: any) => m.type === 0).slice(-4).map((m: any) => m.text).join(' / ');
        return `at=${p?.worldX},${p?.worldZ},${p?.level} ticks=${T()} hpMin=${stats.hpMin} eats=${stats.eats} walkTicks=${stats.walkTicks} retries=${stats.retries} died=${stats.died} milestones=${[...done].join(',')} jumps=${jumps.join(';')} msgs=${msgs}`;
    };
    const gains = (): string => SKILLS.map(k => [k, xp(k) - xp0[k]!] as const).filter(([, g]) => g > 0).map(([k, g]) => `${k.toLowerCase()}=${g}`).join(',');
    const fail = async (why: string): Promise<never> => { off(); return finish([s], false, `${why} xp=${gains()} ${detail()}`); };
    const guard = async (label: string): Promise<void> => {
        if (stats.died) await fail(`died during ${label}`);
        if (T() > CAP) await fail(`tick cap during ${label}`);
    };
    const end = async (ok: boolean, extra = ''): Promise<never> => { off(); return finish([s], ok && !stats.died, `${extra} xp=${gains()} ${detail()}`); };

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
            await waitUntil(s, () => ok() || stats.died, { timeoutTicks: ticks });
            if (ok()) return;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
        }
        await guard(label);
        if (!ok()) await fail(`step ${label}`);
    };

    // One dialog page per tick: the first option matching a pattern, else "continue". Stops when ok() holds.
    const converse = async (pats: RegExp[], ok: () => boolean, maxTicks: number): Promise<boolean> => {
        for (let i = 0; i < maxTicks && !stats.died; i++) {
            if (ok()) return true;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = (d.options ?? []).find((o: any) => pats.some(re => re.test(o.text)));
                if ((d.options ?? []).some((o: any) => !/click here to continue/i.test(o.text)) && !opt) console.log(`WARN no option match: ${(d.options ?? []).map((o: any) => o.text).join(' | ')}`);
                void s.sdk.sendClickDialog(opt ? opt.index : 0);
            }
            await waitTicks(s, 1);
        }
        return ok();
    };

    const walker = await sessionWalker(s as any);
    // A locked door the SDK plans through (collision treats doors as open) becomes a wall for this session.
    const blockDoor = (level: number, x: number, z: number): boolean => !!(s.sdk as any).blockDoorTemporarily?.(level, x, z, 3_600_000);
    const walk = async (label: string, pts: PathPoint[]): Promise<void> => {
        const goal = pts[pts.length - 1]!;
        const tol = goal.tol ?? 2;
        for (let i = 0; i < 3 && !near(goal.x, goal.z, tol); i++) {
            await guard(label);
            if (i > 0) stats.retries++;
            const r = await walkPath(walker, i === 0 ? pts : [goal], { stop: () => stats.died || T() > CAP });
            stats.walkTicks += r.ticks;
            if (!r.ok && !near(goal.x, goal.z, tol)) await s.bot.walkTo(goal.x, goal.z, tol, { timeout: 400_000 } as any);
        }
        if (!near(goal.x, goal.z, tol + 1)) await fail(`walk ${label}`);
    };

    // Talk until ok(); then wait until the dialog closes (3 shut ticks). The NPC list covers about 15 tiles, so the
    // bot walks toward `home` first when the NPC is not in it.
    const talk = async (label: string, re: RegExp, pats: RegExp[], ok: () => boolean, home: { x: number; z: number }, maxTicks = 60, stopOpen = false): Promise<void> => {
        for (let i = 0; i < 3; i++) {
            await guard(label);
            if (i > 0) stats.retries++;
            if (!npc(re)) await waitUntil(s, () => !!npc(re), { timeoutTicks: 3 });
            if (!npc(re)) await walk(`${label} approach`, [{ x: home.x, z: home.z, tol: 5 }]);
            const n = npc(re);
            if (!n) await fail(`${label}: no npc ${re}`);
            for (let k = 0; k < 8 && !dialogOpen() && !stats.died; k++) {
                const tr: any = await talkTo(npc(re) ?? n);
                if (tr && tr.success === false) console.log(`WARN talk ${label}: ${tr.reason ?? ""} ${tr.message ?? ""}`);
                let at0 = '', still = 0;
                for (let w = 0; w < 25 && !dialogOpen() && !stats.died; w++) {
                    await waitTicks(s, 1);
                    const at = `${pos()?.worldX},${pos()?.worldZ}`;
                    still = at === at0 ? still + 1 : 0;
                    at0 = at;
                    if (still >= 3) break;
                }
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
    const teleport = async (label: string, comp: string, x: number, z: number): Promise<void> => {
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
        s, st, pos, inv, hp, xp, cnt, has, slot, cheb, near, lvl, dialogOpen, sawText, msgCount, T, stats, milestone,
        blockDoor, guard, fail, end, gains, detail, opLoc, locs, findLoc, locAt, opIndex, npc, talkTo, useOnLoc, useOnNpc, useOnItem,
        step, converse, walk, talk, climb, teleport, openDoor, shutAt, dash, waitTicks: (n: number) => waitTicks(s, n),
        waitUntil: (f: () => boolean, ticks: number) => waitUntil(s, () => f() || stats.died, { timeoutTicks: ticks }),
    };
}
