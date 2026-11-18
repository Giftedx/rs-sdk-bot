// Fidelity of the bench clones of the dagger gang: a recorded live meeting against the same matchup on the bench,
// measure by measure with the error of each (research/gang-clones.md, "Fidelity").
//   bun scripts/measure/pk-gang-fidelity.ts live <trace.jsonl> <our account>     the measures of the live meeting
//   bun scripts/measure/pk-gang-fidelity.ts table <trace.jsonl> <our account> <bench output> [...]
//     the same beside the mean of the `GANG {json}` lines of the bench outputs (scripts/pk-gang.ts), as a table
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeAppearance } from './pk-rival-feed';

const GANG = ['goondelf', 'ligma', 'sugma'];
const ATTACKS = new Set([376, 377, 1062]), SPECIAL = 1062, EAT = 829, DEATH = 836;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1], DZ = [1, 1, 1, 0, 0, -1, -1, -1];
const protect = (head: number) => (head & 8 ? 'melee' : head & 16 ? 'ranged' : head & 32 ? 'magic' : 'off');
const styleOf = (weapon: string) => (/bow|knife|dart|javelin|thrownaxe/.test(weapon) ? 'ranged' : /staff|wand/.test(weapon) ? 'magic' : 'melee');

export type Meeting = {
    ticks: number; kills: number; ourDeaths: number;
    // Hitpoints that our account lost, by the source of the splat.
    hpLost: number; byAttack: number; bySpecial: number; byPoison: number; ourEats: number; ourAttacks: number; ourAttacksOnTheRightPrayer: number;
    gangAttacks: number; gangSpecials: number; gangEats: number; gangEatsEach: Record<string, number>; damageOnGang: number;
};
// The meeting of `ours` with the gang in the lines of a trace: from the first attack of a gang account on it to the
// last one. A gap of `GAP` ticks with no gang attack on it ends a meeting; the result is the meeting with the most gang
// attacks. `obj` names a worn object and `seq` an animation.
const GAP = 300;
export function liveMeeting(lines: Iterable<string>, ours: string, obj: (id: number) => string, seq: (id: number) => string = id => String(id)): Meeting {
    type E = { slot: number; name: string; x: number; z: number; head: number; weapon: string; fe?: number };
    const by = new Map<number, E>(), isGang = (n: string) => GANG.includes(n);
    const fresh = (): Meeting => ({ ticks: 0, kills: 0, ourDeaths: 0, hpLost: 0, byAttack: 0, bySpecial: 0, byPoison: 0, ourEats: 0, ourAttacks: 0, ourAttacksOnTheRightPrayer: 0, gangAttacks: 0, gangSpecials: 0, gangEats: 0, gangEatsEach: {}, damageOnGang: 0 });
    const done: Meeting[] = [];
    let m: Meeting = { ticks: 0, kills: 0, ourDeaths: 0, hpLost: 0, byAttack: 0, bySpecial: 0, byPoison: 0, ourEats: 0, ourAttacks: 0, ourAttacksOnTheRightPrayer: 0, gangAttacks: 0, gangSpecials: 0, gangEats: 0, gangEatsEach: {}, damageOnGang: 0 };
    let first = -1, last = -1;
    // What the window holds after its last gang attack is cut at the end: counts since that attack.
    let tail = { ourEats: 0, ourAttacks: 0, right: 0, gangEats: {} as Record<string, number>, onGang: 0, kills: 0 };
    const commit = () => { m.ourEats += tail.ourEats; m.ourAttacks += tail.ourAttacks; m.ourAttacksOnTheRightPrayer += tail.right; m.damageOnGang += tail.onGang; m.kills += tail.kills;
        for (const [n, c] of Object.entries(tail.gangEats)) { m.gangEats += c; m.gangEatsEach[n] = (m.gangEatsEach[n] ?? 0) + c; }
        tail = { ourEats: 0, ourAttacks: 0, right: 0, gangEats: {}, onGang: 0, kills: 0 }; };
    for (const raw of lines) {
        if (!raw) continue; let msg: any; try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.t === 'roster') { for (const p of msg.p ?? []) { const n = String(p[1]).toLowerCase(), e = by.get(p[0]); if (!e || e.name !== n) by.set(p[0], { slot: p[0], name: n, x: p[2], z: p[3], head: 0, weapon: '' }); } continue; }
        if (msg.t !== 'tick') continue;
        const k: number = msg.k, seen: { e: E; r: any }[] = [];
        for (const r of msg.p ?? []) {
            let e = by.get(r.i); const a = typeof r.ap === 'string' ? decodeAppearance(r.ap) : null;
            if (r.f || !e) { e = { slot: r.i, name: a?.name ?? e?.name ?? `slot${r.i}`, x: r.x ?? e?.x ?? 0, z: r.z ?? e?.z ?? 0, head: e?.head ?? 0, weapon: e?.weapon ?? '' }; by.set(r.i, e); }
            if (r.x !== undefined) { e.x = r.x; e.z = r.z; } else for (const d of r.m ?? []) { e.x += DX[d] ?? 0; e.z += DZ[d] ?? 0; }
            if (a) { if (a.name) e.name = a.name; e.head = Uint8Array.from(atob(r.ap), c => c.charCodeAt(0))[1] ?? 0; e.weapon = obj(a.worn.find(w => w.slot === 3)?.obj ?? -1); }
            if (r.fe !== undefined) e.fe = r.fe;
            seen.push({ e, r });
        }
        const us = seen.find(o => o.e.name === ours), target = (e: E) => (e.fe !== undefined && e.fe >= 32768 ? by.get(e.fe - 32768) : undefined);
        // The gang attacks on our account in this tick, and whether one of them is a special.
        const hits = seen.filter(o => isGang(o.e.name) && ATTACKS.has(o.r.an?.[0]) && target(o.e)?.name === ours);
        if (hits.length && first >= 0 && k - last > GAP) { m.kills += tail.kills; m.damageOnGang += tail.onGang; m.ticks = last - first; done.push(m); m = fresh(); first = -1; tail = { ourEats: 0, ourAttacks: 0, right: 0, gangEats: {}, onGang: 0, kills: 0 }; }
        if (hits.length) { if (first < 0) first = k; last = k; commit(); m.gangAttacks += hits.length; m.gangSpecials += hits.filter(o => o.r.an[0] === SPECIAL).length; }
        if (first < 0) continue;
        if (us?.r.hm) for (const h of us.r.hm as number[][]) { m.hpLost += h[0]!; if (h[1] === 2) m.byPoison += h[0]!; else if (hits.some(o => o.r.an[0] === SPECIAL)) m.bySpecial += h[0]!; else m.byAttack += h[0]!; }
        for (const { e, r } of seen) {
            const an: number | undefined = r.an?.[0];
            if (e.name === ours) {
                if (an === EAT) tail.ourEats++;
                if (an === DEATH) m.ourDeaths++;
                const t = target(e);
                if (an !== undefined && an >= 0 && an !== EAT && an !== DEATH && t && isGang(t.name) && !/block|ready|walk|defend/.test(seq(an))) { tail.ourAttacks++; if (protect(t.head) === styleOf(e.weapon)) tail.right++; }
            } else if (isGang(e.name)) {
                if (an === EAT) tail.gangEats[e.name] = (tail.gangEats[e.name] ?? 0) + 1;
                if (an === DEATH) tail.kills++;
                if (r.hm) for (const h of r.hm as number[][]) tail.onGang += h[0]!;
            }
        }
    }
    // A kill and the damage of the tick of the last attack count; the eats after it do not.
    m.kills += tail.kills; m.damageOnGang += tail.onGang;
    m.ticks = first < 0 ? 0 : last - first;
    done.push(m);
    return done.sort((a, b) => b.gangAttacks - a.gangAttacks)[0]!;
}
// The mean of each measure over the `GANG {json}` lines of bench outputs.
export function benchMeetings(texts: readonly string[]): { n: number; mean: Partial<Meeting>; each: Partial<Meeting>[] } {
    const each: Partial<Meeting>[] = [];
    for (const text of texts) for (const line of text.split(/\r?\n/)) {
        const i = line.indexOf('GANG {'); if (i < 0) continue;
        let g: any; try { g = JSON.parse(line.slice(i + 5)); } catch { continue; }
        const gang = (g.gang ?? []) as any[], fights = (g.fights ?? []) as any[], atk = (f: any) => (f.attacks?.melee ?? 0) + (f.attacks?.ranged ?? 0) + (f.attacks?.magic ?? 0);
        each.push({ ticks: g.ticks, kills: g.kills, ourDeaths: g.end === 'died' ? 1 : 0, hpLost: g.taken, ourEats: g.eaten, ourAttacks: fights.reduce((a, f) => a + atk(f), 0),
            gangAttacks: gang.reduce((a, f) => a + atk(f), 0), gangSpecials: gang.reduce((a, f) => a + (f.specs ?? 0), 0), gangEats: gang.reduce((a, f) => a + (f.eaten ?? 0), 0), damageOnGang: fights.reduce((a, f) => a + (f.dealt ?? 0), 0) });
    }
    const mean: Partial<Meeting> = {};
    for (const key of ['ticks', 'kills', 'ourDeaths', 'hpLost', 'ourEats', 'ourAttacks', 'gangAttacks', 'gangSpecials', 'gangEats', 'damageOnGang'] as const) if (each.length) mean[key] = Math.round((10 * each.reduce((a, e) => a + (e[key] ?? 0), 0)) / each.length) / 10;
    return { n: each.length, mean, each };
}
// One row a measure: the live value, the bench mean and the error of the bench in percent of the live value.
export function fidelityRows(live: Meeting, bench: Partial<Meeting>): { measure: string; live: number; bench: number | null; errorPercent: number | null }[] {
    const per = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined || !b ? undefined : Math.round((10 * a) / b) / 10);
    const rows: [string, number | undefined, number | undefined][] = [
        ['kills', live.kills, bench.kills], ['our deaths', live.ourDeaths, bench.ourDeaths], ['meeting ticks', live.ticks, bench.ticks], ['Hitpoints lost', live.hpLost, bench.hpLost], ['sharks eaten by ours', live.ourEats, bench.ourEats],
        ['Hitpoints lost a kill', per(live.hpLost, live.kills), per(bench.hpLost, bench.kills)], ['ticks a kill', per(live.ticks, live.kills), per(bench.ticks, bench.kills)],
        ['Hitpoints lost a gang attack', per(live.hpLost, live.gangAttacks), per(bench.hpLost, bench.gangAttacks)], ['gang attacks', live.gangAttacks, bench.gangAttacks], ['gang specials in 100 attacks', per(100 * live.gangSpecials, live.gangAttacks), per(100 * (bench.gangSpecials ?? 0), bench.gangAttacks)],
        ['gang eats', live.gangEats, bench.gangEats], ['damage on the gang', live.damageOnGang, bench.damageOnGang], ['damage on the gang an attack of ours', per(live.damageOnGang, live.ourAttacks), per(bench.damageOnGang, bench.ourAttacks)],
        ['our attacks on the right prayer in 100', per(100 * live.ourAttacksOnTheRightPrayer, live.ourAttacks), undefined], ['poison in 100 Hitpoints lost', per(100 * live.byPoison, live.hpLost), undefined], ['specials in 100 Hitpoints lost', per(100 * live.bySpecial, live.hpLost), undefined],
    ];
    return rows.filter(r => r[1] !== undefined).map(([measure, l, b]) => ({ measure, live: l!, bench: b ?? null, errorPercent: b === undefined || !l ? null : Math.round((100 * (b - l!)) / l!) }));
}

if (import.meta.main) {
    const [mode, trace, ours, ...outputs] = process.argv.slice(2);
    if ((mode !== 'live' && mode !== 'table') || !trace || !ours) { console.log('usage: bun scripts/measure/pk-gang-fidelity.ts live|table <trace.jsonl> <our account> [bench output ...]'); process.exit(2); }
    const pack = new Map(readFileSync(join(resolve(import.meta.dir, '..', '..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8').split(/\r?\n/).flatMap(l => { const x = l.match(/^(\d+)=(.+)$/); return x ? [[Number(x[1]), x[2]!] as const] : []; }));
    const seqs = new Map(readFileSync(join(resolve(import.meta.dir, '..', '..'), 'vendor/rs-sdk/server/content/pack/seq.pack'), 'utf8').split(/\r?\n/).flatMap(l => { const x = l.match(/^(\d+)=(.+)$/); return x ? [[Number(x[1]), x[2]!] as const] : []; }));
    const live = liveMeeting(readFileSync(trace, 'utf8').split('\n'), ours.toLowerCase(), id => pack.get(id) ?? '', id => seqs.get(id) ?? String(id));
    console.log(`LIVE ${JSON.stringify(live)}`);
    if (mode === 'table') {
        const bench = benchMeetings(outputs.map(f => readFileSync(f, 'utf8')));
        console.log(`BENCH ${JSON.stringify({ n: bench.n, mean: bench.mean })}`);
        console.log('| Measure | Live | Bench mean | Error |\n|---|---|---|---|');
        for (const r of fidelityRows(live, bench.mean)) console.log(`| ${r.measure} | ${r.live} | ${r.bench ?? 'no bench measure'} | ${r.errorPercent === null ? '-' : `${r.errorPercent > 0 ? '+' : ''}${r.errorPercent}%`} |`);
    }
}
