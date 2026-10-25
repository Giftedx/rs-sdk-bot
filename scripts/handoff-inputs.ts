// One owned handoff, with the request observed BEFORE starting the on-demand donor.
// bun scripts/handoff-inputs.ts <donor> <receiver> 153:Flax --notes --keep='food|tool' --bank-x=2725 --bank-z=3493
// Both jobs must already be paused externally. Existing stop files are never cleared.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { assertServerAllowed, serverFromEnv } from '../packages/core/src/bot';

type Item = { name: string; count: number };
export type Handoff = { donor: string; receiver: string; items: Item[]; notes: boolean; keep?: string;
    x: number; z: number; requestMs: number; timeoutMs: number; graceMs: number };
const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
export function parseHandoff(args: string[]): Handoff {
    const [donor, receiver, ...rest] = args;
    if (!donor || !receiver || ![donor,receiver].every(n => n.trim() === n && ACCOUNT.test(n) && !/^(main|haggis)$/i.test(n)) || donor.toLowerCase() === receiver.toLowerCase())
        throw new Error('two distinct non-reserved account names required');
    const cfg: Handoff = { donor, receiver, items: [], notes: false, x: 2654, z: 3283, requestMs: 30_000, timeoutMs: 240_000, graceMs: 45_000 };
    const seen = new Set<string>();
    for (const arg of rest) {
        if (!arg.startsWith('--')) {
            const m = arg.match(/^(\d+):(.+)$/);
            const count = Number(m?.[1]), name = m?.[2]?.trim();
            if (!name || /[\r\n\0]/.test(name) || name.length > 80 || !Number.isSafeInteger(count) || count < 1) throw new Error('invalid handoff item/count');
            if (cfg.items.some(i => i.name.toLowerCase() === name.toLowerCase())) throw new Error('duplicate handoff item');
            cfg.items.push({ name, count }); continue;
        }
        const [key, ...value] = arg.split('=');
        if (seen.has(key!)) throw new Error('duplicate handoff option'); seen.add(key!);
        const v = value.join('=');
        if (key === '--notes' && !value.length) cfg.notes = true;
        else if (key === '--keep' && v && v.length <= 300) { new RegExp(v, 'i'); cfg.keep = v; }
        else if (['--bank-x','--bank-z','--request-ms','--timeout-ms','--grace-ms'].includes(key!) && /^\d+$/.test(v)) {
            const fields: Record<string,'x'|'z'|'requestMs'|'timeoutMs'|'graceMs'> = { '--bank-x': 'x', '--bank-z': 'z', '--request-ms': 'requestMs', '--timeout-ms': 'timeoutMs', '--grace-ms': 'graceMs' };
            const field = fields[key!]!;
            cfg[field] = Number(v);
        } else throw new Error(`unknown/invalid handoff option ${key}`);
    }
    if (!cfg.items.length || ![cfg.x,cfg.z].every(n => Number.isSafeInteger(n) && n > 0 && n < 16384)
        || !Number.isSafeInteger(cfg.requestMs) || cfg.requestMs < 1000 || cfg.requestMs > 60_000
        || !Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < cfg.requestMs || cfg.timeoutMs > 600_000
        || !Number.isSafeInteger(cfg.graceMs) || cfg.graceMs < 1000 || cfg.graceMs > 60_000) throw new Error('invalid handoff bounds/items');
    if (cfg.keep && cfg.items.some(i => new RegExp(cfg.keep!, 'i').test(i.name))) throw new Error('requested item overlaps protected KEEP');
    return cfg;
}

export type HandoffChild = { code(): number | null; output(): string; goal?: string };
type Request = { at: number; items: unknown };
export type HandoffDeps = {
    server: string; owned: ReadonlySet<string>; now(): number; pause(ms: number): Promise<void>;
    status(name: string): any; request(): Request | undefined; otherRequests(): string[]; stopped(name: string): boolean;
    spawn(role: 'receiver' | 'donor'): HandoffChild; stop(name: string): void; log?(line: string): void;
};
function sameItems(raw: unknown, want: Item[]): boolean {
    return Array.isArray(raw) && raw.length === want.length && want.every(i => raw.filter(w => w && typeof w.name === 'string'
        && w.name.toLowerCase() === i.name.toLowerCase() && w.count === i.count).length === 1);
}
function active(s: any, name: string, server: string, now: number) {
    if (!s) return false;
    if (s.name?.toLowerCase() !== name.toLowerCase() || s.server?.toLowerCase() !== server.toLowerCase() || !Number.isFinite(s.at)) throw new Error(`invalid status identity for ${name}`);
    return !s.result && now - s.at < 30_000; // A future timestamp also fails closed.
}
const result = (c: HandoffChild) => c.output().split(/\r?\n/).filter(l => l.startsWith('RESULT ')).pop() ?? '';

export async function runHandoff(c: Handoff, d: HandoffDeps) {
    const children: { name: string; child: HandoffChild }[] = [];
    let phase = 'preflight', ok = false, reason = '', cleanupPending: string[] = [];
    const start = d.now();
    try {
        for (const n of [c.donor,c.receiver]) {
            if (!d.owned.has(n.toLowerCase())) throw new Error(`not authenticated owned: ${n}`);
            if (d.stopped(n)) throw new Error(`existing stop file: ${n}; clear manually after review`);
            if (active(d.status(n), n, d.server, d.now())) throw new Error(`account active: ${n}; pause its job externally`);
        }
        if (d.otherRequests().length) throw new Error('other payout requests pending; donor must serve only this handoff');
        const previous = d.request()?.at ?? -1;
        phase = 'request'; const receiverStarted = d.now();
        const receiver = d.spawn('receiver'); children.push({ name: c.receiver, child: receiver });
        d.log?.('HANDOFF phase=request receiver started');
        while (true) {
            if (receiver.code() !== null) throw new Error(`receiver exited before donor: ${result(receiver) || receiver.code()}`);
            if (d.stopped(c.receiver) || d.stopped(c.donor)) throw new Error('stop file during request phase');
            const req = d.request(), status = d.status(c.receiver);
            if (req && req.at >= receiverStarted && req.at > previous && req.at <= d.now()+1) {
                if (!sameItems(req.items,c.items)) throw new Error('fresh request does not match exact handoff items');
                if (/^START /m.test(receiver.output()) && status?.name?.toLowerCase() === c.receiver.toLowerCase()
                    && status.server?.toLowerCase() === d.server.toLowerCase() && status.started >= receiverStarted && status.at >= receiverStarted && status.at <= d.now() && !status.result
                    && (!receiver.goal || status.goal === receiver.goal)
                    && status.pos?.level === 0 && Math.max(Math.abs(status.pos.x-c.x),Math.abs(status.pos.z-c.z)) <= 8) break;
            }
            if (d.now()-receiverStarted >= c.requestMs || d.now()-start >= c.timeoutMs) throw new Error('fresh authenticated exact request timeout');
            await d.pause(200);
        }
        // No await between the final liveness/idle check and donor spawn.
        if (receiver.code() !== null || active(d.status(c.donor),c.donor,d.server,d.now())) throw new Error('receiver ended or donor became active');
        if (d.otherRequests().length) throw new Error('another payout request appeared before donor start');
        phase = 'transfer';
        const donor = d.spawn('donor'); children.push({ name: c.donor, child: donor });
        d.log?.('HANDOFF phase=transfer fresh exact request verified; donor started');
        const expected = c.items.map(i => `${i.count} ${i.name}`).join(', ');
        const receiptOk = () => receiver.code() === 0 && result(receiver).toLowerCase() === `RESULT ok got ${expected}`.toLowerCase();
        const paid = `MILESTONE paid ${c.receiver} ${expected}`.toLowerCase();
        const payoutOk = () => donor.code() === 0 && /^RESULT ok /.test(result(donor)) && donor.output().split(/\r?\n/).some(l => l.toLowerCase() === paid);
        while (receiver.code() === null || donor.code() === null) {
            if (receiver.code() !== null && !receiptOk()) throw new Error(`receiver exact receipt not proved: ${result(receiver)}`);
            if (donor.code() !== null && !payoutOk()) throw new Error(`donor exited without exact payout: ${result(donor)}`);
            if (d.now()-start >= c.timeoutMs) throw new Error('handoff timeout');
            if (d.stopped(c.receiver) || d.stopped(c.donor)) throw new Error('stop file during transfer');
            await d.pause(200);
        }
        if (!receiptOk()) throw new Error(`receiver exact receipt not proved: ${result(receiver)}`);
        if (!payoutOk()) throw new Error('donor exact payout not proved');
        ok = true; phase = 'done'; reason = `received ${expected}`;
    } catch (e) { reason = String(e); }
    finally {
        const running = children.filter(c => c.child.code() === null);
        for (const c of running) { try { d.stop(c.name); } catch (e) { ok=false;reason+=`; stop failed ${c.name}: ${String(e)}`; } }
        const until = d.now()+c.graceMs;
        while (running.some(c => c.child.code() === null) && d.now()<until) await d.pause(200);
        cleanupPending = running.filter(c => c.child.code() === null).map(c => c.name);
        if (cleanupPending.length) { ok = false; reason += '; graceful stop pending: '+cleanupPending.join(', '); }
    }
    return { ok, phase, reason, cleanupPending, elapsedMs: d.now()-start };
}

export function handoffCommands(c: Handoff, root: string) {
    const env = { BANK_X: String(c.x), BANK_Z: String(c.z), KEEP: c.keep ?? '', PAYOUT_NOTES: c.notes ? '1' : '0', ON_DEMAND: '1', COURIERS: '' };
    return { env, receiver: [process.execPath, join(root,'scripts/take-from-banker.ts'),c.receiver,...c.items.map(i=>`${i.count}:${i.name}`),`--banker=${c.donor}`],
        donor: [process.execPath,join(root,'scripts/banker.ts'),c.donor] };
}

async function main() {
    const c = parseHandoff(process.argv.slice(2)), root = resolve(import.meta.dir,'..'), dir = join(root,'.practice');
    const server = (name: string) => serverFromEnv(readFileSync(join(root,'vendor/rs-sdk/bots',name,'bot.env'),'utf8'));
    const host = server(c.donor); if (host.toLowerCase() !== server(c.receiver).toLowerCase()) throw new Error('handoff accounts must use the same server');
    assertServerAllowed(host);
    const owned = ownedAccounts(host), reqDir = join(dir,'withdraw'), reqFile = join(reqDir,`${c.receiver}.json`);
    const commands = handoffCommands(c,root);
    const token = crypto.randomUUID(), goals = new Map<string,string>();
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    process.on('SIGINT',cancel); process.on('SIGTERM',cancel);
    const readStatus = (name: string) => { const file=join(dir,'status',`${name}.json`);return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined; };
    const readRequest = (): Request | undefined => {
        if (!existsSync(reqFile)) return;
        return { at: statSync(reqFile).mtimeMs, items: JSON.parse(readFileSync(reqFile,'utf8')).items };
    };
    const out = await runHandoff(c, { server: host, owned, now: Date.now, pause: ms=>Bun.sleep(ms),
        status: readStatus,
        request: readRequest, otherRequests:()=>existsSync(reqDir)?readdirSync(reqDir).filter(f=>f.endsWith('.json')&&f.toLowerCase()!==`${c.receiver}.json`.toLowerCase()):[],
        stopped: name=>cancelled || existsSync(join(dir,`stop-${name}`)),
        stop: name=>{
            const status=readStatus(name);
            if(status && !status.result && Date.now()-status.at<30_000 && status.goal!==goals.get(name)) throw new Error('a different active job owns this account; no stop sent');
            mkdirSync(dir,{recursive:true});const file=join(dir,`stop-${name}`);
            try { writeFileSync(file,'handoff bounded cleanup\n',{flag:'wx'}); } catch(e:any) { if(e.code!=='EEXIST')throw e; }
        },
        spawn: role=>{
            let output='', code:number|null=null, readFailed=false;const name=role==='receiver'?c.receiver:c.donor,goal=`handoff ${token} ${role}`;goals.set(name,goal);
            const proc=Bun.spawn(commands[role],{cwd:root,env:{...process.env,...commands.env,BOT_GOAL:goal},stdout:'pipe',stderr:'pipe'});
            const collect=async(stream:ReadableStream<Uint8Array>,label:string)=>{
                try { const decoder=new TextDecoder();for await(const chunk of stream){const text=decoder.decode(chunk,{stream:true});if(label==='out')output+=text;process.stdout.write(`[${role}:${label}] ${text}`);} }
                catch(e) { readFailed=true;output+=`\nWARN child ${label} output error ${String(e)}\n`; }
            };
            // A pipe error does not mean the game process exited. Keep it in the
            // running set so the timeout still sends its graceful stop file.
            void Promise.all([proc.exited,collect(proc.stdout,'out'),collect(proc.stderr,'err')]).then(([exit])=>{code=readFailed?1:exit;});
            return {code:()=>code,output:()=>output,goal};
        }, log:console.log });
    process.off('SIGINT',cancel); process.off('SIGTERM',cancel);
    console.log(`HANDOFF_RESULT ${JSON.stringify(out)}`);
    console.log(`RESULT ${out.ok?'ok':'fail no handoff progress:'} ${out.reason}`); process.exitCode=out.ok?0:1;
}
if(import.meta.main) main().catch(e=>{console.error(`HANDOFF_RESULT ${JSON.stringify({ok:false,phase:'preflight',reason:String(e)})}`);console.log(`RESULT fail no handoff progress: ${String(e)}`);process.exitCode=1;});
