import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renameRetry, writeAtomicFile } from './atomic-file';
export { renameRetry };
import { NAMES } from './names';
import type { BankObservation } from './session-types';
import { questFlags, questDefinitions, type QuestFlag } from './quest-status';
import {guildActorFacts} from './guild-facts';
import {equipmentObserved} from './container-observation';
import {readLogoutProof} from './session-lifecycle';
import {observedDoorStates} from './door-policy';
import {lifecycleRootForRead, statusDirForServer} from './practice-paths';

// Live status for the dashboard (packages/dashboard): live bots write .practice/live/status/<name>.json
// and practice bots write .practice/sim/status/<name>.json every few ticks.
// Role: env BOT_ROLE, else the names list the account comes from. Goal: env BOT_GOAL, else the script file.
// Phase: the last "MILESTONE <name>" line the script printed. The bank is kept from the last time it was open.

let baseIds: Map<number, number> | undefined;
function baseId(id: number): number {
    if (!baseIds) {
        baseIds = new Map();
        const text = readFileSync(join(resolve(import.meta.dir, '../../..'), 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8');
        const rows: [number, string][] = [];
        const names = new Map<string, number>();
        let pos = 0;
        while (pos < text.length) {
            let end = text.indexOf('\n', pos);
            if (end < 0) end = text.length;
            const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
            const eq = text.indexOf('=', pos);
            if (eq > pos && eq < lineEnd) {
                const parsedId = Number(text.slice(pos, eq));
                if (Number.isInteger(parsedId) && parsedId >= 0) {
                    const name = text.slice(eq + 1, lineEnd);
                    rows.push([parsedId, name]);
                    names.set(name, parsedId);
                }
            }
            pos = end + 1;
        }
        for (const [rowId, name] of rows) baseIds.set(rowId, name.startsWith('cert_') ? names.get(name.slice(5)) ?? rowId : rowId);
    }
    return baseIds.get(id) ?? id;
}

// This is the current SDK observation, never a reconstruction from bank stock
// or a prior session. Missing/invalid data is unknown; an explicit [] stays [].
function equipmentStatus(raw: unknown) {
    if (!Array.isArray(raw)) return null;
    for (let k = 0; k < raw.length; k++) {
        const i = raw[k];
        if (!i || !Number.isSafeInteger(i.slot) || i.slot < 0
            || !Number.isSafeInteger(i.id) || i.id < 0 || typeof i.name !== 'string' || i.name.trim().length === 0
            || !Number.isSafeInteger(i.count) || i.count <= 0) return null;
    }
    return raw.map(i => ({ slot: i.slot, id: i.id, baseId: baseId(i.id), name: i.name, count: i.count }));
}

let roleMap: Map<string, string> | undefined;
export function roleOf(name: string): string {
    if (process.env.BOT_ROLE) return process.env.BOT_ROLE;
    if (!roleMap) {
        roleMap = new Map();
        for (const [role, list] of Object.entries(NAMES)) {
            for (const n of list as readonly string[]) roleMap.set(n.toLowerCase(), role);
        }
    }
    return roleMap.get(name.toLowerCase()) ?? 'test';
}

let patched = false;
type StatusLines = { line: string; result: string; counters: Record<string, number>; attributed: boolean };
// Each login owns its lines. Hosted actors use attributed logs; standalone actors receive console.log while active.
const perBot = new Map<string, StatusLines>();
const activeLines = new Set<StatusLines>();
const emptyLines = (attributed: boolean): StatusLines => ({ line: '', result: '', counters: {}, attributed });

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
function updateLines(e: StatusLines, line: string): void {
    if (line.startsWith('MILESTONE ')) e.line = line.slice(10);
    if (line.startsWith('RESULT ')) { e.result = line.slice(7, 300); e.counters=resultCounters(line.slice(7)); }
}
export function noteStatusLine(name: string, line: string): void {
    const key = name.toLowerCase(), e = perBot.get(key) ?? emptyLines(true);
    e.attributed = true;
    updateLines(e, line);
    perBot.set(key, e);
}
function captureMilestones() {
    if (patched) return;
    patched = true;
    const orig = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        for (const e of activeLines) if (!e.attributed) updateLines(e, line);
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
    let directWrapper: ((a: { type: string }) => unknown) | undefined;
    const origDirect = sess.direct;
    if (typeof origDirect === 'function') {
        const bound = origDirect.bind(sess);
        directWrapper = (a: { type: string }) => { note(a?.type); return bound(a); };
        sess.direct = directWrapper;
    }
    let sendWrapper: ((msg: { type: string; action?: { type: string } }) => unknown) | undefined;
    const origSend = sdk.send;
    if (typeof origSend === 'function') {
        const bound = origSend.bind(sdk);
        sendWrapper = (msg: { type: string; action?: { type: string } }) => { if (msg?.type === 'sdk_action') note(msg.action?.type); return bound(msg); };
        sdk.send = sendWrapper;
    }
    const xpNow = () => {
        const skills = s.sdk.getState()?.skills;
        if (!skills) return 0;
        let total = 0;
        for (let i = 0; i < skills.length; i++) total += skills[i]?.experience ?? 0;
        return total;
    };
    let lastXp = xpNow();
    let pending = '';
    let strip = '';
    const combos = new Map<string, { n: number; xp: number }>();
    const off = s.onTick(() => {
        const xp = xpNow();
        if (pending) { const c = combos.get(pending)!; c.xp += Math.max(0, xp - lastXp); }
        lastXp = xp;
        strip = (strip + String(Math.min(9, sent.length))).slice(-300);
        // The action set sent during the tick that just ended; its XP shows up on the next tick.
        if (sent.length === 0) pending = 'none';
        else if (sent.length === 1) pending = sent[0]!;
        else if (sent.length === 2) pending = sent[0] === sent[1] ? sent[0]! : sent[0]! < sent[1]! ? `${sent[0]}+${sent[1]}` : `${sent[1]}+${sent[0]}`;
        else pending = [...new Set(sent)].sort().join('+');
        const c = combos.get(pending) ?? { n: 0, xp: 0 };
        c.n++; combos.set(pending, c);
        sent.length = 0;
    });
    return {
        summary: () => ({
            strip,
            combos: [...combos].sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([k, v]) => ({ k, n: v.n, xp: v.xp })),
        }),
        stop: () => {
            off();
            if (directWrapper && sess.direct === directWrapper) sess.direct = origDirect;
            if (sendWrapper && sdk.send === sendWrapper) sdk.send = origSend;
        },
    };
}

export function startStatus(s: { name: string; client?: unknown; sdk: { getState(): any }; onTick(cb: () => void): () => void; tick(): number; bankObservation?(): BankObservation | null; progression?:{decision():any;method?():string|null;binding?():{boundMethod:string|null;source:string|null;consumer:unknown}} }, server: string, ledgerCounts?: () => Record<string, number>, timeline?: () => string, opts: { dir?: string; lifecycleRoot?: string } = {}) {
    captureMilestones();
    const key = s.name.toLowerCase(), lines = emptyLines(perBot.get(key)?.attributed ?? false);
    perBot.set(key, lines);
    const statusDir = opts.dir ?? statusDirForServer(server);
    mkdirSync(statusDir, { recursive: true });
    const file = join(statusDir, `${s.name}.json`);
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
    let observedEquipment: string | null = null;
    let lastEquipRows: { slot: number; id: number; baseId: number; name: string; count: number }[] | null = null;
    let lastEquipValid = false;
    const sameRawEquipment = (prev: readonly { slot: number; id: number; name: string; count: number }[] | null, raw: unknown): boolean => {
        if (!prev || !Array.isArray(raw) || prev.length !== raw.length) return false;
        for (let k = 0; k < prev.length; k++) {
            const a = prev[k]!, b = raw[k];
            if (!b || a.slot !== b.slot || a.id !== b.id || a.count !== b.count || a.name !== b.name) return false;
        }
        return true;
    };
    const trackInGameEquipment = (raw: unknown) => {
        const current = !!s.client && typeof s.client === 'object' && equipmentObserved(s.client);
        const inGame = (s.client as { ingame?: unknown } | undefined)?.ingame;
        if (inGame !== true) return;
        if (!current) {
            lastEquipRows = null;
            lastEquipValid = false;
            observedEquipment = null;
            return;
        }
        if (lastEquipValid && sameRawEquipment(lastEquipRows, raw)) return;
        lastEquipRows = equipmentStatus(raw);
        lastEquipValid = lastEquipRows !== null;
        observedEquipment = null;
    };
    const savedEquipmentReady = (raw: unknown) => {
        const rows = equipmentStatus(raw), current = !!s.client && typeof s.client === 'object' && equipmentObserved(s.client);
        const inGame = (s.client as {ingame?:unknown}|undefined)?.ingame;
        if (inGame === true) {
            lastEquipRows = rows;
            lastEquipValid = current && rows !== null;
            observedEquipment = lastEquipValid ? JSON.stringify(rows) : null;
            return lastEquipValid;
        }
        if (current) return rows !== null;
        if (observedEquipment === null && lastEquipValid && lastEquipRows !== null) {
            observedEquipment = JSON.stringify(lastEquipRows);
        }
        // Logout clears live container readiness. Retain only this session's actual matching saved kit.
        if (inGame !== false || observedEquipment === null || rows === null || JSON.stringify(rows) !== observedEquipment) return false;
        const proof = readLogoutProof(s.name, server, { root: opts.lifecycleRoot ?? lifecycleRootForRead(server) });
        return proof.state === 'confirmed' && proof.attemptId === (s as {lifecycle?:{attemptId?:unknown}}).lifecycle?.attemptId;
    };
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
    const bot = (s as any).bot;
    const restoredBotMethods: Array<() => void> = [];
    for (const method of ['closeBank', 'closeInterface']) if (typeof bot?.[method] === 'function') {
        const original = bot[method], bound = original.bind(bot);
        const wrapped = (...args: unknown[]) => { observeBank(); return bound(...args); };
        bot[method] = wrapped;
        restoredBotMethods.push(() => { if (bot[method] === wrapped) bot[method] = original; });
    }
    const write = () => {
        // A late callback or repeated stop from an earlier login cannot replace this account's current row.
        if (perBot.get(key) !== lines) return;
        const st = s.sdk.getState();
        observeBank();
        const p = st?.player;
        const hp = (st?.skills ?? []).find((k: any) => k.name === 'Hitpoints');
        const doc = {
            name: s.name, server, role: roleOf(s.name), goal: process.env.BOT_GOAL ?? process.argv[1]?.split(/[\\/]/).pop() ?? '',
            phase: lines.line, result: lines.result, at: Date.now(), started, tick: s.tick(), workRevision: process.env.WORKER_RELEASE ?? null, workEntry: process.env.WORKER_ENTRY || null,
            coordinatorRunId: process.env.FLEET_RUN_ID ?? process.env.COORDINATOR_RUN_ID ?? null,
            // The producer's lifecycle attempt for this exact session (session-lifecycle.ts); null when absent.
            sessionAttemptId: (s as { lifecycle?: { attemptId?: unknown } }).lifecycle?.attemptId ?? null,
            pos: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
            hp: hp ? { now: hp.level, max: hp.baseLevel } : null,
            // Run energy in percent, as the game's Run orb shows it.
            runEnergy: p ? p.runEnergy : null,
            combat: p?.combatLevel ?? null,
            // Progress uses base level; stat() route gates use the independently
            // observed current value (including drains/boosts), never a guess.
            skills: (st?.skills ?? []).map((k: any) => ({ name: k.name, level: k.baseLevel, currentLevel:k.level, xp: k.experience })),
            guildFacts: guildActorFacts(s.client, st),
            doorStates: s.client && typeof s.client === 'object' && (s.client as {ingame?:unknown}).ingame !== true ? {} : observedDoorStates(st),
            inventory: (st?.inventory ?? []).map((i: any) => ({ id:i.id,baseId:baseId(i.id),name: i.name, count: i.count,
                ...(Number.isSafeInteger(i.slot)&&i.slot>=0&&i.slot<28?{slot:i.slot}:{}) })),
            // What this account sees on the floor, its own private drops too, as [x, z, level, id, count]: the
            // dashboard's 3D view draws them, because the world feed never sends a private obj.
            ground: groundStatus(st?.groundItems, p?.level),
            equipment: equipmentStatus(st?.equipment),
            equipmentObserved: savedEquipmentReady(st?.equipment),
            // Passive journal observations only. Older running sessions remain untouched.
            quests, questsAt,
            bank, bankAt, ledger: ledgerCounts?.() ?? null,
            // Last 300 ticks: x XP, v observed inventory change (not net output), m move, a anim, d dialog, s stun, i idle.
            timeline: timeline?.() ?? '',
            // Inputs sent per tick (last 300 ticks, one digit each) and the top action sets with the XP they gained.
            inputs: inputs.summary(),
            // Every key=value counter from the last RESULT line (shopTicks, walkTicks, stuns, eaten, ...).
            counters: lines.counters,
            progression:(()=>{const d=s.progression?.decision(),executing=s.progression?.method?.(),binding=s.progression?.binding?.();return d?{...binding,state:d.state,selected:d.selected,executing:executing??null,expectedTicks:d.expectedTicks,basis:d.basis,reason:d.reason,followUps:d.followUps,stateFingerprint:d.stateFingerprint}:executing?{...binding,executing}:null;})(),
            progressionCrowding:st?.nearbyPlayers?.length??0,
            progressionContext:{style:st?.combatStyle??null,prayers:st?.prayers?.activePrayers??null},
            env: { target: process.env.TARGET ?? null, cap: process.env.CAP ?? null },
        };
        // The fleet controller reads this file regularly during a live run, and on Windows that read can block the
        // rename for a moment; the final write carries the RESULT that live acceptance needs.
        try { writeAtomicFile(file, JSON.stringify(doc)); } catch { /* the dashboard is optional */ }
    };
    observeQuests();
    write();
    let n = 0;
    // A lockstep practice world runs ticks as fast as its bots answer, and no dashboard follows a bench account tick
    // by tick: there the file is written every 100 ticks, not every 5 (the write was 10% of a 16-account bench run).
    const every = process.env.SIM_LOCKSTEP === '1' ? 100 : 5;
    const questEvery = Math.min(every, 20);
    const off = s.onTick(() => {
        observeBank();
        trackInGameEquipment(s.sdk.getState()?.equipment);
        if (++n % questEvery === 0 || !quests) observeQuests();
        if (n % every === 0) write();
    });
    // The row is also written on the clock, for the session's whole life: a session whose tick stream has frozen (a
    // hung quest script, a stalled client) otherwise stops refreshing `at`, and the release gate (worker-release.ts
    // assertCompatibleWorkers) then reads an unfinished row older than 30 s as an unknown peer and refuses every other
    // login on the side. The row's `tick` still shows the stall.
    const beat = setInterval(write, statusHeartbeatMs());
    activeLines.add(lines);
    return { stop: () => { clearInterval(beat); write(); off(); inputs.stop(); for (const restore of restoredBotMethods) restore(); activeLines.delete(lines); } };
}
export const GROUND_STATUS_MAX = 50;
// The SDK lists the ground items of the player's own level, nearest first.
export function groundStatus(items: unknown, level: unknown): [number, number, number, number, number][] {
    if (!Array.isArray(items) || !Number.isInteger(level)) return [];
    const out: [number, number, number, number, number][] = [];
    for (let k = 0; k < items.length; k++) {
        if (out.length >= GROUND_STATUS_MAX) break;
        const i = items[k] as any;
        if (!i) continue;
        const x = i.x, z = i.z, id = i.id, count = i.count;
        if (Number.isSafeInteger(x) && Number.isSafeInteger(z) && Number.isSafeInteger(id) && id >= 0 && Number.isSafeInteger(count) && count >= 1) {
            out.push([x, z, level as number, id, count]);
        }
    }
    return out;
}
export const statusHeartbeatMs =() => Math.max(20, Number(process.env.STATUS_HEARTBEAT_MS ?? 5_000));
