import { mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NAMES } from './names';
import type { BankObservation } from './inprocess';
import { questFlags, questDefinitions, type QuestFlag } from './quest-status';
import {guildActorFacts} from './guild-observation';
import {equipmentObserved} from './container-observation';
import {observedDoorStates} from './door-policy';

// Live status for the dashboard (packages/dashboard): every bot writes .practice/status/<name>.json every few ticks.
// Role: env BOT_ROLE, else the names list the account comes from. Goal: env BOT_GOAL, else the script file.
// Phase: the last "MILESTONE <name>" line the script printed. The bank is kept from the last time it was open.

const dir = join(resolve(import.meta.dir, '..', '..', '..'), '.practice', 'status');
let baseIds: Map<number, number> | undefined;
function baseId(id: number): number {
    if (!baseIds) {
        baseIds = new Map();
        const rows = readFileSync(join(resolve(import.meta.dir, '../../..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8').split(/\r?\n/).flatMap(l=>{ const m=l.match(/^(\d+)=(.+)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; });
        const names = new Map(rows.map(([id,name])=>[name,id]));
        for (const [id,name] of rows) baseIds.set(id,name.startsWith('cert_') ? names.get(name.slice(5)) ?? id : id);
    }
    return baseIds.get(id) ?? id;
}

// This is the current SDK observation, never a reconstruction from bank stock
// or a prior session. Missing/invalid data is unknown; an explicit [] stays [].
function equipmentStatus(raw: unknown) {
    if (!Array.isArray(raw) || !raw.every(i => i && Number.isSafeInteger(i.slot) && i.slot >= 0
        && Number.isSafeInteger(i.id) && i.id >= 0 && typeof i.name === 'string' && i.name.trim().length > 0
        && Number.isSafeInteger(i.count) && i.count > 0)) return null;
    return raw.map(i => ({ slot:i.slot, id:i.id, baseId:baseId(i.id), name:i.name, count:i.count }));
}

export function roleOf(name: string): string {
    if (process.env.BOT_ROLE) return process.env.BOT_ROLE;
    for (const [role, list] of Object.entries(NAMES)) if ((list as readonly string[]).some(n => n.toLowerCase() === name.toLowerCase())) return role;
    return 'test';
}

let lastLine = '';
let lastResult = '';
let lastCounters: Record<string, number> = {};
let patched = false;
// Per-bot MILESTONE and RESULT lines, for processes that run several bots (packages/core/src/host.ts). A bot with no
// entry here uses the process-wide lines above, as before.
const perBot = new Map<string, { line: string; result: string; counters: Record<string, number> }>();

// Read only complete top-level scalar tokens. Diagnostic JSON and quoted text
// may contain key=value strings; those are not worker counters. Keep parsing
// bounded separately from the short public result and retain the first flat key.
export function resultCounters(text: string): Record<string, number> {
    const prefix=text.slice(0,16*1024),bytes=Buffer.from(prefix),complete=prefix.length===text.length&&bytes.length<=16*1024;
    const bounded=bytes.subarray(0,16*1024).toString('utf8'),out:Record<string,number>={};
    let token='',depth=0,quote='',escape=false;
    const consume=()=>{const m=token.match(/^([A-Za-z]+)=(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)$/);if(m){const value=Number(m[2]);if(Number.isFinite(value)&&!Object.hasOwn(out,m[1]!))out[m[1]!]=value;}token='';};
    for(const char of bounded){
        if(quote){token+=char;if(escape)escape=false;else if(char==='\\')escape=true;else if(char===quote)quote='';continue;}
        if(char==='"'||char==="'"||char==='`'){quote=char;token+=char;continue;}
        if(char==='{'||char==='[')depth++;
        else if(char==='}'||char===']')depth=Math.max(0,depth-1);
        if(/\s/.test(char)&&depth===0)consume();else token+=char;
    }
    if(complete&&depth===0&&!quote)consume();
    return out;
}
export function renameRetry(from: string, to: string, rename: (a: string, b: string) => void = renameSync): void {
    for (let attempt = 0; ; attempt++) {
        try { rename(from, to); return; }
        catch (e) { if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
    }
}
export function noteStatusLine(name: string, line: string): void {
    const e = perBot.get(name) ?? { line: '', result: '', counters: {} };
    if (line.startsWith('MILESTONE ')) e.line = line.slice(10);
    if (line.startsWith('RESULT ')) { e.result = line.slice(7, 300); e.counters=resultCounters(line.slice(7)); }
    perBot.set(name, e);
}
function captureMilestones() {
    if (patched) return;
    patched = true;
    const orig = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        if (line.startsWith('MILESTONE ')) lastLine = line.slice(10);
        if (line.startsWith('RESULT ')) { lastResult = line.slice(7, 300); lastCounters=resultCounters(line.slice(7)); }
        orig(...args);
    };
}

// Inputs per tick (owner request #8): wraps the session's direct() and the SDK's send() (the in-process shim's
// action queue) to count the actions each tick sends, and credits the XP gained on the next tick to that action set.
// Waits are not inputs. Output: one digit per tick (0-9, last 300 ticks) and the most used action sets with XP/tick.
function recordInputs(s: { tick(): number; onTick(cb: () => void): () => void; sdk: { getState(): any } }) {
    const sent: string[] = [];
    const note = (type: unknown) => { if (typeof type === 'string' && type !== 'wait') sent.push(type); };
    const sess = s as any, sdk = s.sdk as any;
    if (typeof sess.direct === 'function') {
        const orig = sess.direct.bind(sess);
        sess.direct = (a: { type: string }) => { note(a?.type); return orig(a); };
    }
    if (typeof sdk.send === 'function') {
        const orig = sdk.send.bind(sdk);
        sdk.send = (msg: { type: string; action?: { type: string } }) => { if (msg?.type === 'sdk_action') note(msg.action?.type); return orig(msg); };
    }
    const xpNow = () => (s.sdk.getState()?.skills ?? []).reduce((n: number, k: any) => n + (k.experience ?? 0), 0);
    let lastXp = xpNow();
    let pending = '';
    let strip = '';
    const combos = new Map<string, { n: number; xp: number }>();
    s.onTick(() => {
        const xp = xpNow();
        if (pending) { const c = combos.get(pending)!; c.xp += Math.max(0, xp - lastXp); }
        lastXp = xp;
        strip = (strip + String(Math.min(9, sent.length))).slice(-300);
        // The action set sent during the tick that just ended; its XP shows up on the next tick.
        pending = sent.length ? [...new Set(sent)].sort().join('+') : 'none';
        const c = combos.get(pending) ?? { n: 0, xp: 0 };
        c.n++; combos.set(pending, c);
        sent.length = 0;
    });
    return () => ({
        strip,
        combos: [...combos].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([k, v]) => ({ k, n: v.n, xp: v.xp })),
    });
}

export function startStatus(s: { name: string; client?: unknown; sdk: { getState(): any }; onTick(cb: () => void): () => void; tick(): number; bankObservation?(): BankObservation | null }, server: string, ledgerCounts?: () => Record<string, number>, timeline?: () => string) {
    captureMilestones();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.name}.json`);
    let bank: { id: number; baseId: number; name: string; count: number }[] | null = null;
    let bankAt: number | null = null;
    const started = Date.now();
    let quests: QuestFlag[] | null = null;
    let questsAt: number | null = null;
    const observeQuests = () => {
        const observed = questFlags((s as any).client);
        if (observed?.some(q => q.state !== 'unknown')) {
            quests = observed; questsAt = Date.now();
        }
    };
    // Keep the last observation across logins, with its original age. Load only
    // bank/journal data from this account and server, never prior activity.
    try {
        const prior = JSON.parse(readFileSync(file, 'utf8'));
        const at = Object.hasOwn(prior, 'questsAt') ? prior.questsAt : prior.at;
        const definitions = new Map(questDefinitions().map(q => [q.id, q.name]));
        if (typeof prior.name === 'string' && prior.name.toLowerCase() === s.name.toLowerCase() && prior.server === server
            && Number.isFinite(at) && at > 0 && at <= started
            && Number.isFinite(prior.at) && prior.at >= at && prior.at <= started
            && Array.isArray(prior.quests) && prior.quests.length > 0
            && prior.quests.every((q: any) => q && definitions.get(q.id) === q.name
                && ['not started','started','complete','unknown'].includes(q.state))
            && new Set(prior.quests.map((q: any) => q.id)).size === prior.quests.length
            && prior.quests.some((q: any) => q.state !== 'unknown')) {
            quests = prior.quests; questsAt = at;
        }
        const validId = (id: unknown) => Number.isSafeInteger(id) && (id as number) >= 0;
        if (typeof prior.name === 'string' && prior.name.toLowerCase() === s.name.toLowerCase() && prior.server === server
            && Number.isFinite(prior.bankAt) && prior.bankAt > 0 && prior.bankAt <= started
            && Number.isFinite(prior.at) && prior.at >= prior.bankAt && prior.at <= started
            && Array.isArray(prior.bank) && prior.bank.every((i: any) => i && validId(i.id)
                && (i.baseId === undefined || validId(i.baseId)) && typeof i.name === 'string' && i.name.trim().length > 0
                && Number.isSafeInteger(i.count) && i.count > 0)) {
            bank = prior.bank.map((i: any) => ({ id:i.id, baseId:i.baseId ?? baseId(i.id), name:i.name, count:i.count }));
            bankAt = prior.bankAt;
        }
    } catch { /* missing or invalid prior observation remains unknown */ }
    const inputs = recordInputs(s);
    let lastBankGeneration = 0;
    const observeBank = () => {
        const observed = s.bankObservation?.();
        // An open modal with [] is not proof of an empty bank. Only a completed
        // bank inventory update advances this snapshot, including a real empty one.
        if (observed && observed.generation > lastBankGeneration) {
            bank = observed.items.map(i => ({ id:i.id, baseId:baseId(i.id), name:i.name, count:i.count }));
            bankAt = observed.at;
            lastBankGeneration = observed.generation;
        }
    };
    // A bank visit can finish between the five-tick writes. Capture it before close as well as each tick.
    const bot=(s as any).bot;
    for (const method of ['closeBank','closeInterface']) if (typeof bot?.[method]==='function') {
        const original=bot[method].bind(bot);
        bot[method]=(...args:unknown[])=>{ observeBank(); return original(...args); };
    }
    const write = () => {
        const st = s.sdk.getState();
        observeBank();
        const p = st?.player;
        const hp = (st?.skills ?? []).find((k: any) => k.name === 'Hitpoints');
        const own = perBot.get(s.name);
        const phaseNow = own ? own.line : lastLine;
        const resultNow = own ? own.result : lastResult;
        const doc = {
            name: s.name, server, role: roleOf(s.name), goal: process.env.BOT_GOAL ?? process.argv[1]?.split(/[\\/]/).pop() ?? '',
            phase: phaseNow, result: resultNow, at: Date.now(), started, tick: s.tick(), workRevision: process.env.WORKER_RELEASE ?? null, workEntry: process.env.WORKER_ENTRY || null,
            coordinatorRunId: process.env.COORDINATOR_RUN_ID ?? null,
            // The producer's lifecycle attempt for this exact session (session-lifecycle.ts); null when absent.
            sessionAttemptId: (s as { lifecycle?: { attemptId?: unknown } }).lifecycle?.attemptId ?? null,
            pos: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
            hp: hp ? { now: hp.level, max: hp.baseLevel } : null,
            combat: p?.combatLevel ?? null,
            // Progress uses base level; stat() route gates use the independently
            // observed current value (including drains/boosts), never a guess.
            skills: (st?.skills ?? []).map((k: any) => ({ name: k.name, level: k.baseLevel, currentLevel:k.level, xp: k.experience })),
            guildFacts: guildActorFacts(s.client, st),
            doorStates: s.client && typeof s.client === 'object' && (s.client as {ingame?:unknown}).ingame !== true ? {} : observedDoorStates(st),
            inventory: (st?.inventory ?? []).map((i: any) => ({ id:i.id,baseId:baseId(i.id),name: i.name, count: i.count })),
            equipment: equipmentStatus(st?.equipment),
            equipmentObserved: !!s.client&&typeof s.client==='object'&&equipmentObserved(s.client),
            // Passive journal observations only. Older running sessions remain untouched.
            quests, questsAt,
            bank, bankAt, ledger: ledgerCounts?.() ?? null,
            // Last 300 ticks: x XP, v observed inventory change (not net output), m move, a anim, d dialog, s stun, i idle.
            timeline: timeline?.() ?? '',
            // Inputs sent per tick (last 300 ticks, one digit each) and the top action sets with the XP they gained.
            inputs: inputs(),
            // Every key=value counter from the last RESULT line (shopTicks, walkTicks, stuns, eaten, ...).
            counters: own ? own.counters : lastCounters,
            env: { target: process.env.TARGET ?? null, cap: process.env.CAP ?? null },
        };
        // The coordinator reads this file every second during a live run, and on Windows that read can block the
        // rename for a moment; the final write carries the RESULT that live acceptance needs.
        try { writeFileSync(`${file}.tmp`, JSON.stringify(doc)); renameRetry(`${file}.tmp`, file); } catch { /* the dashboard is optional */ }
    };
    observeQuests();
    write();
    let n = 0;
    const off = s.onTick(() => { observeBank(); observeQuests(); if (++n % 5 === 0) write(); });
    return { stop: () => { write(); off(); } };
}
