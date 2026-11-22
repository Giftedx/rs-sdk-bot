import {
    claimPile, LOOT_RULES, LURE_PAUSE, lureGuard, lootRisk, lootRoom, pileKey, pileValue,
    releasePile, unitValue, worthIt, type Ground, type LootRules,
} from '../loot';
import {
    LOOT_TICKS, RETURN_TICKS, SCRIPT_LOOT_TICKS, SKIP_DONE, SKIP_RISK,
    cheb, continueDialog, countOf, invOf, meOf,
    type JobSpec, type LootWatchOptions, type WatcherContext,
} from './model';

/** Create the ground-item pickup scanner, keep-list tracker, and bank deposit handler. */
export function createLootScanner(ctx: WatcherContext, lootOpt: LootWatchOptions) {
    const rules: LootRules = lootOpt.rules ?? LOOT_RULES;
    const skipPiles = new Map<string, number>();
    const riskSaid = new Set<string>();
    const lure = lureGuard(rules);
    const reserved = (id: number) => (lootOpt.reserved?.()[id] ?? 0) > 0;
    const keepOrReserve = (id: number) => ctx.kept.has(id) || reserved(id);
    const objStackable = (id: number) => {
        const d = (ctx.session.client as any)?.objType?.(id);
        return typeof d?.stackable === 'boolean' ? d : undefined;
    };

    const lootJob = (g: Ground, key: string): JobSpec => {
        const tables = lootOpt.tables, begin = ctx.tick(), p0 = meOf(ctx.state()), origin = p0 ? { x: p0.x, z: p0.z } : null;
        const before = countOf(invOf(ctx.state()), g.id);
        let at = -99, dropAt = -99, tries = 0, back = -1;
        const end = (why: string, extra = '') => {
            releasePile(key, lootOpt.name);
            skipPiles.set(key, ctx.tick() + SKIP_DONE);
            ctx.say('loot', why, `id=${g.id}${extra} ticks=${ctx.tick() - begin}`);
            const p = meOf(ctx.state());
            if (origin && p && cheb(p, origin) > 1) { back = ctx.tick(); at = -99; return false; }
            return true;
        };
        return {
            name: 'loot', hold: true,
            tick() {
                const st = ctx.state(), now = ctx.tick(), p = meOf(st);
                if (!p) return true;
                if (back >= 0) {
                    if (!origin || cheb(p, origin) <= 1) { ctx.say('loot', 'returned', `ticks=${now - begin}`); return true; }
                    if (now - back > RETURN_TICKS) { ctx.say('loot', 'return-timeout'); return true; }
                    if (ctx.canSend() && now - at >= 4) { ctx.send({ type: 'walkTo', x: origin.x, z: origin.z, running: true }); at = now; }
                    return false;
                }
                const inv = invOf(st);
                const got = countOf(inv, g.id) - before;
                if (got > 0) {
                    ctx.kept.set(g.id, (ctx.kept.get(g.id) ?? 0) + got);
                    if (lure.picked(now)) ctx.say('loot', 'lure-pause', `ticks=${LURE_PAUSE}`);
                    return end('pickup', ` n=${got} value=${unitValue(g.id, tables) * got}`);
                }
                if (st?.dialog?.isOpen) { continueDialog(st, ctx.canSend, ctx.send); return false; }
                const here = (st?.groundItems ?? []).find((x: any) => x.id === g.id && x.x === g.x && x.z === g.z);
                if (!here) return end('gone');
                if (now - begin > LOOT_TICKS) return end('timeout');
                const risk = lootRisk(st, here, ctx.danger(), ctx.fleetNames, rules);
                if (risk) return end(`abort-${risk}`);
                if (!ctx.canSend()) return false;
                const room = lootRoom(inv, here, tables, keepOrReserve, objStackable);
                if (room === null) return end('full');
                if (room !== 'ok') {
                    if (now - dropAt >= 2) {
                        const i = inv.find(x => x.slot === room);
                        if (i) ctx.ownDrops.set(`${p.x},${p.z},${i.id}`, now);
                        ctx.send({ type: 'dropItem', slot: room });
                        dropAt = now;
                    }
                    return false;
                }
                if (now - at >= 4) {
                    if (++tries > 4) return end('failed');
                    ctx.send({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id });
                    at = now;
                }
                return false;
            },
        };
    };

    const lootBankJob = (): JobSpec => {
        const begin = ctx.tick();
        let at = -99;
        return {
            name: 'loot-bank', hold: true,
            tick() {
                const st = ctx.state(), now = ctx.tick();
                if (!st?.bank?.isOpen) return true;
                const item = invOf(st).find(i => (ctx.kept.get(i.id) ?? 0) > 0);
                if (!item) return true;
                if (now - begin > 20) { ctx.say('loot', 'bank-timeout'); return true; }
                if (ctx.canSend() && now - at >= 2) {
                    ctx.send({ type: 'bankDeposit', slot: item.slot, amount: Math.min(item.count ?? 1, ctx.kept.get(item.id)!) });
                    at = now;
                }
                return false;
            },
        };
    };

    const scanLoot = () => {
        const st = ctx.state(), p = meOf(st);
        if (!p) return;
        const now = ctx.tick(), pack = invOf(st);
        // The keep list follows the pack: a deposit, a wield or a meal takes the item off it.
        for (const [id, k] of ctx.kept) {
            const n = countOf(pack, id);
            if (n >= k) continue;
            ctx.say('loot', st?.bank?.isOpen ? 'banked' : 'left-pack', `id=${id} n=${k - n}`);
            if (n > 0) ctx.kept.set(id, n);
            else { ctx.kept.delete(id); ctx.refusals.delete(id); }
        }
        for (const [k, t] of ctx.ownDrops) if (now - t > 300) ctx.ownDrops.delete(k);
        for (const [k, t] of skipPiles) if (t < now) skipPiles.delete(k);
        if (st?.bank?.isOpen) { if (pack.some(i => ctx.kept.has(i.id))) ctx.want('loot-bank', lootBankJob()); return; }
        if (ctx.hasActiveJob() || [...ctx.jobs.keys()].some(k => k.startsWith('loot:'))) return;
        if (st?.dialog?.isOpen || st?.shop?.isOpen || st?.trade?.isOpen || st?.ge || st?.modalOpen) return;
        if (now - ctx.scriptPickupAt() <= SCRIPT_LOOT_TICKS) return;
        const tables = lootOpt.tables;
        const piles = ((st?.groundItems ?? []) as Ground[])
            .filter(g => worthIt(g, tables, rules))
            .sort((a, b) => pileValue(b, tables) - pileValue(a, tables) || a.distance - b.distance);
        for (const g of piles) {
            const key = pileKey(p.level, g);
            if (skipPiles.has(key) || ctx.ownDrops.has(`${g.x},${g.z},${g.id}`)) continue;
            const risk = lure.allow(now, p, g) ?? lootRisk(st, g, ctx.danger(), ctx.fleetNames, rules);
            if (risk) {
                skipPiles.set(key, now + SKIP_RISK);
                if (!riskSaid.has(key)) { riskSaid.add(key); ctx.say('loot', `skip-${risk}`, `id=${g.id} value=${pileValue(g, tables)} d=${g.distance}`); }
                continue;
            }
            if (lootRoom(pack, g, tables, keepOrReserve, objStackable) === null) {
                skipPiles.set(key, now + SKIP_DONE);
                ctx.say('loot', 'skip-full', `id=${g.id} value=${pileValue(g, tables)}`);
                continue;
            }
            if (!claimPile(key, lootOpt.name)) continue;
            ctx.say('loot', 'seen', `id=${g.id} n=${g.count} value=${pileValue(g, tables)} d=${g.distance}`);
            ctx.want(`loot:${key}`, lootJob(g, key));
            return;
        }
    };

    return { scanLoot };
}
