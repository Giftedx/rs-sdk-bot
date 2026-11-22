// Bench worker for the end step of a combat worker (packages/core/src/combat-end.ts): a trooper run that ends on the
// Gnome battlefield while a trooper still fights the account. The run is the real trooper trainer (runGiants with
// TROOPER_SITE, scripts/gather-combat.ts). The walk back to the bank is refused here, so the run ends on the field
// with a trooper on the account. The end step must then take the account off the troopers' ground and confirm the
// logout.
// Usage: bun scripts/measure/combat-end-case.ts <bot> [CAP ticks, default 260]
import { finish, openBot } from '../../packages/core/src/bot';
import { finishCombat } from '../../packages/core/src/combat-end';
import { TROOPER_SITE, runGiants } from '../../packages/workers/src/combat';
import { walkTargetPersist } from '../../packages/workers/src/logistics';

if (import.meta.main) {
    const [name, capArg] = process.argv.slice(2);
    if (!name) await finish([], false, 'usage: combat-end-case.ts <bot> [CAP ticks]');
    const cap = Number(capArg ?? 260);
    const s = await openBot(name!).catch(e => finish([], false, `login: ${String(e)}`));
    const at = () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ } : null; };
    const near = (t: { x: number; z: number }, tol: number) => { const p = at(); return !!p && Math.max(Math.abs(p.x - t.x), Math.abs(p.z - t.z)) <= tol; };
    let onField = false;
    try {
        const r = await runGiants(s, {
            cap, site: TROOPER_SITE, trainSkill: 'Attack', targetLevel: 99, food: 10,
            walk: async (x, z, tol) => {
                // The walk out to the camp is the real one. The walk back to the bank from the field is refused.
                if (onField && x === TROOPER_SITE.bank.x && z === TROOPER_SITE.bank.z) return false;
                const ok = (await walkTargetPersist(s, { x, z, level: 0 })).ok && near({ x, z }, tol);
                if (ok && x === TROOPER_SITE.spot.x && z === TROOPER_SITE.spot.z) onField = true;
                return ok;
            },
        });
        console.log(`COMBAT_END_CASE ${JSON.stringify({ stop: r.stop, failure: r.failure, creditedKills: r.creditedKills, at: at() })}`);
        // The trainer's retreat was refused on purpose, so its failure is the fixture and not the result. The worker
        // ends with ok=true: the settlement turns it into a failure (exit 1) when the logout is not confirmed, and the
        // bench harness takes only an exit code of 0 as a pass.
        await finishCombat(s, true, `mode=combat-end-case stop=${r.stop} creditedKills=${r.creditedKills} runFailure=${JSON.stringify(r.failure)}`);
    } catch (e) { await finishCombat(s, false, `mode=combat-end-case error=${JSON.stringify(String(e).slice(0, 160))}`); }
}
