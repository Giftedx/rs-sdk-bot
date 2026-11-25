// Bench: the escort hold and the route gate on one engine (packages/workers/src/pvp/escort.ts).
// - The squad (runPkSquadCli, ESCORT_HOLD=1) marches to the gang post, kills the gang clones and holds the post.
// - The walker (the first account) walks to the Ardougne lever and waits at the gate of pullArdougneLeverToWildy
//   (scripts/combat-quest-specialists.ts) until the escort state says that the gang is suppressed. Then it pulls the
//   lever, stands on the Keep post (3155, 3924) for ESCORT_WALK_TICKS ticks and writes the release file.
// Pass: the gate opened, the walker took no hit from a player and did not die, and the squad ended ok with no death.
// Usage: bun scripts/measure/pk-squad-escort.ts <walker> <squad ...> <gang ...> SQUAD_GANG=3 [KEY=value ...]
//   ESCORT_WALK_TICKS=300  ESCORT_WAIT_TICKS (the gate's limit)  ESCORT_STATE (default .practice/sim/escort/<walker>.json)
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const isKv = (a: string) => /^[A-Z_][A-Z0-9_]*=/.test(a);
// The values go into the environment before any module loads: STALL_TICKS is read once at load (packages/core/src/bot/rules.ts).
for (const a of argv.filter(isKv)) process.env[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
// The hold stands idle at the post and the walker waits at the lever by design: no stall check, the bench timeout bounds the run.
process.env.STALL_TICKS ??= '0';
const [walkerName, ...squadAndGang] = argv.filter(a => !isKv(a));
if (!walkerName || squadAndGang.length < 2) {
    console.log('RESULT fail usage: bun scripts/measure/pk-squad-escort.ts <walker> <squad ...> <gang ...> SQUAD_GANG=<n> [KEY=value ...]');
    process.exit(2);
}
const statePath = (process.env.ESCORT_STATE ||= join('.practice', 'sim', 'escort', `${walkerName.toLowerCase()}.json`));

const [{ openBot, finish, finishHooks }, { tickWaits }, { runPkSquadCli }, { KEEP_SPECIALIST_POST, pullArdougneLeverToWildy, walkWaypoints }, escort, { nextTick }] = await Promise.all([
    import('../../packages/core/src/bot'),
    import('../../packages/core/src/tick-stream'),
    import('../../packages/workers/src/pvp/squad'),
    import('../combat-quest-specialists'),
    import('../../packages/workers/src/pvp/escort'),
    import('../../packages/workers/src/pvp/fight'),
]);
const releasePath = escort.escortReleasePath(statePath);
rmSync(statePath, { force: true });

tickWaits.active++;
let walkerStop: string | undefined;
const walker = await openBot(walkerName, { continueAfterDeath: true, onStop: async (_s, detail) => { walkerStop ??= detail; } });
tickWaits.active--;

// The squad's finish() settles its accounts and reports here in place of an exit (packages/core/src/bot/settle.ts).
const squadNames = squadAndGang;
const squadEnd = new Promise<{ ok: boolean; detail: string }>(resolve => {
    finishHooks.set(squadNames[0]!.toLowerCase(), (ok, detail) => resolve({ ok, detail: typeof detail === 'function' ? detail(ok) : detail }));
    runPkSquadCli([...squadNames, ...argv.filter(isKv), 'ESCORT_HOLD=1'], process.env).then(
        code => resolve({ ok: false, detail: `squad returned ${code} with no finish` }),
        error => resolve({ ok: false, detail: `squad threw ${String(error).slice(0, 200)}` }));
});
let squadResult: { ok: boolean; detail: string } | undefined;
void squadEnd.then(r => { squadResult = r; });

// Every hit that the walker takes from a player, and its death (a new life, or the Lumbridge spawn).
const life0 = walker.sdk.getState()?.player?.lifeId;
let hits = 0, taken = 0, npcTaken = 0, died = false, seenEvent = -1, minHp = walker.sdk.getState()?.player?.hp ?? 0;
const offWatch = walker.onTick(() => {
    const st = walker.sdk.getState(), p = st?.player;
    for (const e of st?.combatEvents ?? []) {
        const id = e.observationId ?? e.tick;
        if (id <= seenEvent) continue;
        seenEvent = id;
        if (e.type !== 'damage_taken') continue;
        if (e.sourceType === 'other_player') { hits++; taken += e.damage ?? 0; } else if (e.sourceType === 'npc') npcTaken += e.damage ?? 0;
    }
    if (p) {
        minHp = Math.min(minHp, p.hp);
        if ((life0 !== undefined && p.lifeId !== life0) || Math.max(Math.abs(p.worldX - 3222), Math.abs(p.worldZ - 3218)) <= 40) died = true;
    }
});

const standTicks = Number(process.env.ESCORT_WALK_TICKS ?? 300);
const t0 = walker.tick();
let gate = 'not reached', enteredAt = -1, stood = 0, entered = '';
try {
    await pullArdougneLeverToWildy(walker, () => false);
    enteredAt = walker.tick() - t0;
    const at = escort.readEscortState(statePath) as { why?: string; tick?: number } | null;
    entered = at?.why ?? 'no state';
    gate = 'open';
    await walkWaypoints(walker, [{ ...KEEP_SPECIALIST_POST, tol: 0 }], 30, () => false, 'step to keep post');
    const from = walker.tick();
    while (walker.tick() - from < standTicks && !died) { if (!await nextTick(walker)) break; }
    stood = walker.tick() - from;
} catch (error) {
    gate = String(error instanceof Error ? error.message : error).replace(/\s+/g, '_').slice(0, 160);
}
escort.releaseEscort(releasePath);
// Ticks go on while the squad leaves the Wilderness and settles.
while (!squadResult && await nextTick(walker)) { /* the lockstep engine waits for this session */ }
const squad = await squadEnd;
offWatch();
const squadDied = Number(/\bdied=(\d+)/.exec(squad.detail)?.[1] ?? NaN);
const ok = gate === 'open' && stood >= standTicks && hits === 0 && !died && squad.ok && squadDied === 0 && walkerStop === undefined;
const p = walker.sdk.getState()?.player;
await finish([walker], ok, `escort gate=${gate} enteredAt=${enteredAt} stood=${stood} walkerHits=${hits} walkerTaken=${taken} walkerDied=${died} walkerNpcTaken=${npcTaken} walkerMinHp=${minHp} `
    + `walkerAt=${p?.worldX},${p?.worldZ}${walkerStop ? ` walkerStop=${walkerStop.replace(/\s+/g, '_')}` : ''} squadOk=${squad.ok} squadDied=${squadDied} entered="${entered}" | ${squad.detail}`);
