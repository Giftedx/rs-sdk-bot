// Pure world-feed appearance decoder and rival fight digest (read-only trace parser).
const BASE37 = ' abcdefghijklmnopqrstuvwxyz0123456789';

function decodeAppearanceRaw(b64: string): { name: string; combat: number; worn: { slot: number; obj: number }[]; head: number } | null {
    const b = Buffer.from(b64, 'base64');
    if (b.length < 2) return null;
    const head = b[1]!;
    let p = 2;
    const worn: { slot: number; obj: number }[] = [];
    const u1 = () => b[p++]!;
    const u2 = () => (b[p++]! << 8) | b[p++]!;
    for (let slot = 0; slot < 12; slot++) {
        if (p >= b.length) return null;
        if (b[p] === 0) {
            p++;
            continue;
        }
        const v = u2();
        if (v === 0xffff) {
            p += 2;
            break;
        }
        if (v >= 0x200) worn.push({ slot, obj: v - 0x200 });
    }
    p += 5 + 14;
    if (p + 9 > b.length) return null;
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(u1());
    let name = '';
    while (v > 0n) {
        name = BASE37[Number(v % 37n)] + name;
        v /= 37n;
    }
    return { name, combat: u1(), worn, head };
}

/** Decodes a server player_info base64 appearance block into name, combat level, and worn objects. */
export function decodeAppearance(b64: string): { name: string; combat: number; worn: { slot: number; obj: number }[] } | null {
    const raw = decodeAppearanceRaw(b64);
    return raw ? { name: raw.name, combat: raw.combat, worn: raw.worn } : null;
}

/** Feed sequence IDs for dagger attacks, eats, and player death animations. */
export const SEQ = { lunge: 376, hack: 377, puncture: 1062, eat: 829, death: 836 } as const;

const HEAD = { skull: 1, melee: 8, ranged: 16, magic: 32 } as const;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DZ = [1, 1, 1, 0, 0, -1, -1, -1];
const wild = (z: number) => (z >= 3520 && z < 3968 ? Math.floor((z - 3520) / 8) + 1 : 0);

export type Fight = {
    by: string;
    target: string;
    targetCombat?: number;
    wild: number;
    start: number;
    end: number;
    order: string;
    open: number[];
    prayed: number[];
    eatAt: number[];
    hpLow: number;
    targetWorn: string[];
    ended: 'target died' | 'attacker died' | 'target left' | 'stopped';
};

export type Digest = {
    fights: Fight[];
    intervals: Record<string, number>;
    prayers: { tick: number; name: string; on: 'melee' | 'ranged' | 'magic' | 'off'; near?: string }[];
    deaths: { tick: number; name: string }[];
};

type Seen = { name: string; x: number; z: number; combat?: number; worn: string[]; head: number; fe?: number; hp?: number; lastAttack?: number; region?: number };

/** Extracts fight timelines, prayer transitions, and deaths for `names` from feed lines. */
export function digest(lines: Iterable<string>, names: ReadonlySet<string>, objName: (id: number) => string = id => String(id)): Digest {
    const bySlot = new Map<number, Seen>();
    const byName = new Map<string, Seen>();
    const open = new Map<string, Fight>();
    const out: Digest = { fights: [], intervals: {}, prayers: [], deaths: [] };
    const protect = (head: number) => (head & HEAD.melee ? 'melee' : head & HEAD.ranged ? 'ranged' : head & HEAD.magic ? 'magic' : 'off');
    const close = (name: string, ended: Fight['ended']) => {
        const f = open.get(name);
        if (f) {
            f.ended = ended;
            out.fights.push(f);
            open.delete(name);
        }
    };
    const rowBySlot = new Map<number, any>();
    for (const raw of lines) {
        if (!raw) continue;
        let m: any;
        try {
            m = JSON.parse(raw);
        } catch {
            continue;
        }
        if (m.t === 'hello') {
            for (const [slot, e] of bySlot) if (e.region === m.r) { bySlot.delete(slot); if (byName.get(e.name) === e) byName.delete(e.name); }
            continue;
        }
        if (m.t === 'roster') {
            for (const p of m.p ?? []) {
                const e = bySlot.get(p[0]);
                const name = String(p[1]).toLowerCase();
                if (!e || e.name !== name) {
                    const entry: Seen = { name, x: p[2], z: p[3], combat: p[5], worn: [], head: 0 };
                    bySlot.set(p[0], entry);
                    byName.set(name, entry);
                } else {
                    e.x = p[2];
                    e.z = p[3];
                    e.combat = p[5];
                }
            }
            continue;
        }
        if (m.t !== 'tick') continue;
        const players = m.p ?? [];
        const attacks: { by: Seen; spec: boolean }[] = [];
        for (let idx = 0; idx < players.length; idx++) {
            const r = players[idx]!;
            let e = bySlot.get(r.i);
            const a = typeof r.ap === 'string' ? decodeAppearanceRaw(r.ap) : null;
            if (r.f || !e) {
                const name = a?.name ?? e?.name ?? `slot${r.i}`;
                e = { name, x: r.x ?? e?.x ?? 0, z: r.z ?? e?.z ?? 0, combat: a?.combat ?? e?.combat, worn: e?.worn ?? [], head: e?.head ?? 0 };
                bySlot.set(r.i, e);
                byName.set(name, e);
            }
            if (r.x !== undefined) {
                e.x = r.x;
                e.z = r.z;
            } else if (r.m) {
                for (let mi = 0; mi < r.m.length; mi++) {
                    const d = r.m[mi]!;
                    e.x += DX[d] ?? 0;
                    e.z += DZ[d] ?? 0;
                }
            }
            e.region = m.r;
            if (r.fe !== undefined) e.fe = r.fe;
            if (a) {
                const head = a.head;
                if (a.name && a.name !== e.name) {
                    if (byName.get(e.name) === e) byName.delete(e.name);
                    e.name = a.name;
                    byName.set(a.name, e);
                }
                if (names.has(e.name) && protect(head) !== protect(e.head)) {
                    let other = e.fe !== undefined && e.fe >= 32768 ? bySlot.get(e.fe - 32768) : undefined;
                    if (!other) {
                        for (const o of bySlot.values()) {
                            if (o.fe !== undefined && o.fe >= 32768 && bySlot.get(o.fe - 32768) === e) { other = o; break; }
                        }
                    }
                    out.prayers.push({ tick: m.k, name: e.name, on: protect(head), ...(other?.worn.length ? { near: `${other.name}: ${other.worn.join(',')}` } : other ? { near: other.name } : {}) });
                }
                e.worn = a.worn.map(w => objName(w.obj));
                e.head = head;
                e.combat = a.combat;
            }
            if (r.hp) e.hp = r.hp[0];
            if (!r.an) continue;
            if (r.an[0] === SEQ.death) {
                if (names.has(e.name)) {
                    out.deaths.push({ tick: m.k, name: e.name });
                    close(e.name, 'attacker died');
                }
                for (const [name, f] of open) if (f.target === e.name) close(name, 'target died');
            }
            if (!names.has(e.name)) continue;
            const f = open.get(e.name);
            if (r.an[0] === SEQ.eat && f) {
                f.order += 'E';
                f.eatAt.push(e.hp ?? -1);
            }
            if (r.an[0] === SEQ.lunge || r.an[0] === SEQ.hack || r.an[0] === SEQ.puncture) {
                attacks.push({ by: e, spec: r.an[0] === SEQ.puncture });
            }
        }
        if (attacks.length) {
            rowBySlot.clear();
            for (let idx = 0; idx < players.length; idx++) rowBySlot.set(players[idx]!.i, players[idx]);
            for (let ai = 0; ai < attacks.length; ai++) {
                const { by, spec } = attacks[ai]!;
                const targetSlot = by.fe !== undefined && by.fe >= 32768 ? by.fe - 32768 : -1;
                const target = targetSlot >= 0 ? bySlot.get(targetSlot) : undefined;
                if (by.lastAttack !== undefined && m.k - by.lastAttack <= 12) out.intervals[m.k - by.lastAttack] = (out.intervals[m.k - by.lastAttack] ?? 0) + 1;
                by.lastAttack = m.k;
                if (!target) continue;
                let f = open.get(by.name);
                if (f && (f.target !== target.name || m.k - f.end > 40)) {
                    close(by.name, 'stopped');
                    f = undefined;
                }
                if (!f) {
                    f = { by: by.name, target: target.name, targetCombat: target.combat, wild: wild(target.z), start: m.k, end: m.k, order: '', open: [], prayed: [], eatAt: [], hpLow: by.hp ?? 99, targetWorn: [...target.worn], ended: 'stopped' };
                    open.set(by.name, f);
                }
                f.end = m.k;
                f.order += spec ? 'S' : 'L';
                const rec = rowBySlot.get(targetSlot);
                for (const h of rec?.hm ?? []) if (h[1] !== 2) (target.head & HEAD.melee ? f.prayed : f.open).push(h[0]);
            }
        }
        for (const [name, f] of open) {
            const e = byName.get(name);
            if (e?.hp !== undefined) f.hpLow = Math.min(f.hpLow, e.hp);
            if (m.k - f.end > 40) close(name, 'stopped');
        }
        for (const slot of m.rp ?? []) {
            const gone = bySlot.get(slot);
            if (gone) for (const [name, f] of open) if (f.target === gone.name) close(name, 'target left');
        }
    }
    for (const name of [...open.keys()]) close(name, 'stopped');
    return out;
}

/** Summarizes a `Digest` into rival behavior metrics for bench profiles. */
export function model(d: Digest) {
    let attacks = 0, specials = 0, hpLow: number | null = null;
    let maxHitOpen: number | null = null, maxHitPrayed: number | null = null;
    let hitsOpen = 0, hitsPrayed = 0;
    const firstSpecial: number[] = [];
    const eatAt: number[] = [];
    const ends: Record<string, number> = {};
    for (let i = 0; i < d.fights.length; i++) {
        const f = d.fights[i]!;
        let atk = 0, firstS = -1;
        for (let k = 0; k < f.order.length; k++) {
            const c = f.order[k]!;
            if (c === 'E') continue;
            if (c === 'S') { specials++; if (firstS < 0) firstS = atk; }
            atk++;
        }
        attacks += atk;
        if (firstS >= 0) firstSpecial.push(firstS);
        for (let k = 0; k < f.eatAt.length; k++) eatAt.push(f.eatAt[k]!);
        if (hpLow === null || f.hpLow < hpLow) hpLow = f.hpLow;
        hitsOpen += f.open.length;
        for (let k = 0; k < f.open.length; k++) {
            const h = f.open[k]!;
            if (maxHitOpen === null || h > maxHitOpen) maxHitOpen = h;
        }
        hitsPrayed += f.prayed.length;
        for (let k = 0; k < f.prayed.length; k++) {
            const h = f.prayed[k]!;
            if (maxHitPrayed === null || h > maxHitPrayed) maxHitPrayed = h;
        }
        ends[f.ended] = (ends[f.ended] ?? 0) + 1;
    }
    let prayers = 0;
    for (let i = 0; i < d.prayers.length; i++) if (d.prayers[i]!.on !== 'off') prayers++;
    return {
        fights: d.fights.length,
        attacks,
        intervals: d.intervals,
        specials,
        firstSpecialAfterAttacks: firstSpecial,
        eatAt,
        hpLow,
        maxHitOpen,
        hitsOpen,
        maxHitPrayed,
        hitsPrayed,
        prayers,
        deaths: d.deaths.length,
        ends,
    };
}
