// Spar: two of our own accounts fight each other in the Wilderness, each with scripts/pk.ts and its own profile. A
// profile is a named set of fight options, so a change to the fight loop is measured against an opponent that eats,
// prays, switches gear and uses its special. The score is for side A; the ladder (scripts/measure/pk-spar-ladder.ts)
// runs a challenger profile against a champion profile on several seeds and both sides.
// Practice only: openBot refuses a non-local server without DEMO_OK=1, and a spar kills one of the two accounts.
// Usage: bun scripts/pk-spar.ts <bot a> <bot b> [CAP ticks, default 900]. Environment: SPAR_A and SPAR_B name a
// profile (default base); SPAR_A_OPTS and SPAR_B_OPTS add fight options as JSON, e.g. {"eatAt":60}.
// Prints one `SPAR <json>` line. RESULT ok means that both sides attacked and the fight reached a kill or the cap.
import type { Session } from '../packages/core/src/inprocess';
import { defaultSpec, fightPlayer, type FightOptions, type FightResult, type Kit } from './pk';
import { TRIBRID_KIT } from './pk-hunt';

// `specBelow` moves the health fraction at which the kit's special fires.
export type Profile = Partial<Omit<FightOptions, 'kit' | 'log' | 'stop'>> & { specBelow?: number };
export const PROFILES: Readonly<Record<string, Profile>> = {
    base: {},
    freeze: { freeze: true },
    'no-read': { readOverheads: false },
    'no-spec': { spec: undefined },
    'spec-early': { specBelow: 0.8 },
    'spec-late': { specBelow: 0.35 },
    'eat-40': { eatAt: 40 },
    'eat-65': { eatAt: 65 },
    'melee-first': { rotation: ['melee', 'ranged', 'magic'] },
    'ranged-melee': { rotation: ['ranged', 'melee'] },
    'magic-ranged': { rotation: ['magic', 'ranged'] },
};

export function sparOptions(name: string, extraJson: string | undefined, kit: Kit, cap: number): FightOptions {
    const profile = PROFILES[name];
    if (!profile) throw Error(`pk-spar: unknown profile "${name}"; known: ${Object.keys(PROFILES).join(', ')}`);
    const extra = extraJson ? JSON.parse(extraJson) as Profile : {};
    const { specBelow, ...options } = { ...profile, ...extra };
    const merged: FightOptions = { kit, spec: defaultSpec(kit), cap, ...options };
    if (specBelow !== undefined && merged.spec) merged.spec = { ...merged.spec, below: specBelow };
    return merged;
}

export type SparResult = { winner: 'a' | 'b' | 'draw'; score: number; ticks: number; a: FightResult; b: FightResult };
// The score of side A: 100 for a kill, -100 for a death, plus the damage margin held inside +-99, so a win always
// scores above a draw and a draw above a loss. A draw is a fight that reached the cap, or one that killed both.
export function sparScore(a: FightResult, b: FightResult): SparResult {
    const aWon = a.outcome === 'kill' || b.outcome === 'died', bWon = b.outcome === 'kill' || a.outcome === 'died';
    const winner = aWon === bWon ? 'draw' : aWon ? 'a' : 'b';
    const margin = Math.max(-99, Math.min(99, a.dealt - b.dealt));
    return { winner, score: (winner === 'a' ? 100 : winner === 'b' ? -100 : 0) + margin, ticks: Math.max(a.ticks, b.ticks), a, b };
}
// A spar that measured something: both sides attacked, and the fight ended in a kill or at the cap.
export const sparValid = (r: SparResult) => [r.a, r.b].every(f => f.attacks.magic + f.attacks.ranged + f.attacks.melee > 0
    && ['kill', 'died', 'timeout'].includes(f.outcome));

export async function spar(a: Session, b: Session, optionsA: FightOptions, optionsB: FightOptions, log: (line: string) => void = l => console.log(l)): Promise<SparResult> {
    // The first side to end stops the other: a fight has one end.
    let over = false;
    const side = (s: Session, target: string, o: FightOptions) => fightPlayer(s, target, { ...o, stop: () => over, log: l => log(`[${s.name}] ${l}`) })
        .finally(() => { over = true; });
    const [ra, rb] = await Promise.all([side(a, b.name, optionsA), side(b, a.name, optionsB)]);
    return sparScore(ra, rb);
}

if (import.meta.main) {
    const [botA, botB, capArg] = process.argv.slice(2), env = process.env;
    if (!botA || !botB) { console.log('RESULT fail usage: bun scripts/pk-spar.ts <bot a> <bot b> [CAP ticks]'); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    const cap = Number(capArg ?? 900), nameA = env.SPAR_A ?? 'base', nameB = env.SPAR_B ?? 'base';
    const optionsA = sparOptions(nameA, env.SPAR_A_OPTS, TRIBRID_KIT, cap), optionsB = sparOptions(nameB, env.SPAR_B_OPTS, TRIBRID_KIT, cap);
    const a = await openBot(botA), b = await openBot(botB);
    const r = await spar(a, b, optionsA, optionsB);
    console.log(`SPAR ${JSON.stringify({ profiles: { a: nameA, b: nameB }, ...r })}`);
    await finish([a, b], sparValid(r), `spar winner=${r.winner} score=${r.score} ticks=${r.ticks} a=${nameA} b=${nameB} aOutcome=${r.a.outcome} bOutcome=${r.b.outcome} `
        + `aDealt=${r.a.dealt} bDealt=${r.b.dealt} aEaten=${r.a.eaten} bEaten=${r.b.eaten} aSpecs=${r.a.specs} bSpecs=${r.b.specs}`);
}
