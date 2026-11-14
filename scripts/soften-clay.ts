// Bounded clay processing at Varrock's public fountain. No purchases or trades.
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyLoc } from '../vendor/rs-sdk/sdk/types';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
const CLAY = 434, SOFT = 1761, BUCKET = 1925, WATER = 1929;
const BANK = { x: 3185, z: 3436 }, FOUNTAIN = { x: 3190, z: 3468 };
export function planSoftClay(raw: number, maximum: number, reserve: number) { return Math.max(0, Math.min(maximum, raw - reserve)); }
// water_sources.rs2 fills one bucket; pottery.rs2:44 consumes1clay+1water and returns1emptybucket. No XP is awarded for softening.
export async function softenOne(s: Session, fountain: NearbyLoc, over: () => boolean) {
    const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const before = { raw: held(CLAY), soft: held(SOFT), bucket: held(BUCKET) + held(WATER) };
    if (!before.raw || !before.bucket || over()) return false;
    if (!held(WATER)) {
        const bucket = s.sdk.getInventory().find(i => i.id === BUCKET)!;
        await s.sdk.sendUseItemOnLoc(bucket.slot, fountain.x, fountain.z, fountain.id);
        await waitUntil(s, () => held(WATER) > 0 || over(), { timeoutTicks: 5 });
    }
    if (!held(WATER) || over()) return false;
    const clay = s.sdk.getInventory().find(i => i.id === CLAY)!, water = s.sdk.getInventory().find(i => i.id === WATER)!;
    await s.sdk.sendUseItemOnItem(clay.slot, water.slot);
    await waitUntil(s, () => held(SOFT) > before.soft || over(), { timeoutTicks: 5 });
    const made = held(SOFT) - before.soft, used = before.raw - held(CLAY);
    if (made || used) {
        if (made !== 1 || used !== 1 || held(BUCKET) + held(WATER) !== before.bucket || !held(BUCKET)) throw new Error('soft clay input/output/bucket accounting mismatch');
        return true;
    }
    return false;
}
export async function runSoftenClay(s: Session, options: { cap: number; maximum: number; reserve: number }) {
    if (![options.cap, options.maximum, options.reserve].every(Number.isSafeInteger) || options.cap <= 0 || options.maximum <= 0 || options.reserve < 0) throw new Error('invalid soft clay cap/maximum/reserve');
    const start = s.tick(), inv = () => s.sdk.getInventory();
    let ended = false, died = false, hpMin = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const player = s.sdk.getState()?.player; void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => { const p = s.sdk.getState()?.player; hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin); if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > (player?.respawnCount ?? 0) || player?.lifeId !== undefined && (p?.lifeId ?? player.lifeId) !== player.lifeId) died = true; });
    const over = () => ended || died || s.tick() - start >= options.cap;
    const walk = async (x: number, z: number) => { const r = await walkPath(await sessionWalker(s), [{ x, z, tol: 1 }], { maxTicks: 250, stop: () => ended || died }); if (!r.ok) throw new Error(`soft clay route: ${r.detail}`); };
    const open = async () => { if (!(await s.bot.openBank()).success) throw new Error('soft clay bank failed'); await waitTicks(s, 1); };
    const deposit = async () => { for (const id of new Set(inv().filter(i => i.id === CLAY || i.id === SOFT).map(i => i.id))) await s.bot.depositItem(inv().find(i => i.id === id)!, -1); await waitTicks(s, 1); };
    const bankCount = (id: number) => (s.sdk.getState()?.bank?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const assets = () => { const counts = new Map<number, number>(); for (const i of [...inv(), ...(s.sdk.getState()?.bank?.items ?? [])]) counts.set(i.id, (counts.get(i.id) ?? 0) + i.count); return counts; };
    let made = 0, banked = 0, planned = 0, output0 = 0, failure = '', stop = 'input-insufficient';
    let initial = new Map<number, number>();
    try {
        await open(); await deposit(); initial = assets(); output0 = bankCount(SOFT);
        planned = planSoftClay(bankCount(CLAY), options.maximum, options.reserve);
        if (planned && !over()) {
            if (!held(BUCKET) && !held(WATER)) await s.bot.withdrawItem(/^bucket$/i, 1, { asNote: false });
            if (!held(BUCKET) && !held(WATER)) throw new Error('no soft clay progress: owned bucket missing');
            await s.bot.withdrawItem(/^clay$/i, planned, { asNote: false });
            if (held(CLAY) !== planned) throw new Error('no soft clay progress: incomplete clay withdrawal');
            await s.bot.closeBank(); await walk(FOUNTAIN.x, FOUNTAIN.z);
            let misses = 0;
            while (made < planned && !over()) {
                if (s.sdk.getDialog()?.isOpen || s.sdk.getState()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                const fountain = s.sdk.getState()?.nearbyLocs.find(l => l.id === 879 && l.x === FOUNTAIN.x && l.z === FOUNTAIN.z && l.level === 0);
                if (!fountain) throw new Error('no soft clay progress: public fountain not observed');
                if (await softenOne(s, fountain, over)) { made++; misses = 0; }
                else if (++misses >= 3) throw new Error('no soft clay progress: three failed conversions');
            }
            stop = made === options.maximum ? 'max-make' : over() ? 'cap' : 'input-insufficient';
        }
    } catch (e) { failure = String(e); }
    finally {
        if (!ended && !died) { try { await walk(BANK.x, BANK.z); await open(); await deposit(); banked = Math.max(0, bankCount(SOFT) - output0); } catch (e) { failure ||= String(e); } }
        off();
    }
    const final = assets(), protectedIds = [...initial].filter(([id]) => ![CLAY, SOFT, BUCKET, WATER].includes(id));
    const bucketTotal = (final.get(BUCKET) ?? 0) + (final.get(WATER) ?? 0), originalBuckets = (initial.get(BUCKET) ?? 0) + (initial.get(WATER) ?? 0);
    const preserved = !!initial.size && protectedIds.every(([id, n]) => (final.get(id) ?? 0) >= n) && bucketTotal === originalBuckets;
    const reserveMet = bankCount(CLAY) >= options.reserve;
    if (!preserved || made !== banked || held(CLAY) || held(SOFT) || !reserveMet) failure ||= 'soft clay final bank/assets proof failed';
    const r = { ok: !failure && !died && !ended, ticks: s.tick() - start, made, banked, planned, rawBank: bankCount(CLAY), softBank: bankCount(SOFT), bucketTotal, preserved, reserveMet, targetMet: !failure && !died && !ended && preserved && reserveMet && made === options.maximum && banked === made, stop, hpMin, died, failure: failure || '-' };
    console.log(`SOFT_CLAY_BANK ${JSON.stringify(r)}`); return r;
}
if (import.meta.main) {
    const s = await openBot(process.argv[2]!);
    try { const r = await runSoftenClay(s, { cap: Number(process.env.CAP ?? 500), maximum: Number(process.env.MAX_MAKE ?? 20), reserve: Number(process.env.RAW_RESERVE ?? 0) }); await finish([s], r.ok, `softClay ${Object.entries(r).map(([k,v]) => `${k}=${v}`).join(' ')}`); }
    catch (e) { await finish([s], false, String(e)); }
}
