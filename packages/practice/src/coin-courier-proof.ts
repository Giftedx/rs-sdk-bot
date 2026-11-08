import { existsSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { createBot } from './bots';
import { applyPreset } from './presets';
import { runBotName } from './prove';
import { startStack, PROOF_TICK_MS, type StackOptions } from './stack';
import { canBind } from './ports';
import { practiceDir, rsSdkRoot } from './paths';
import { killTree } from './proc';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
import { readPracticeSave, waitPracticeSave } from '../../../scripts/measure/fleet-player-save';
import { exactCoinDelta } from '../../../scripts/coin-courier';

const files = ['scripts/coin-courier.ts', 'scripts/coin-courier.test.ts', 'packages/practice/src/coin-courier-proof.ts'];
const root = resolve(import.meta.dir, '../../..');
const source = () => createHash('sha256').update(files.map(p => p + '\0' + readFileSync(join(root, p), 'utf8')).join('\0')).digest('hex');
type Save = ReturnType<typeof readPracticeSave>;
const count = (s: Save, container: number) => (s.inventories[container] ?? []).filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
const itemTotals = (items: { id: number; count: number }[]) => {
    const totals = new Map<number, number>();
    for (const item of items) if (item.id !== 995) totals.set(item.id, (totals.get(item.id) ?? 0) + item.count);
    return [...totals].sort((a, b) => a[0] - b[0]);
};
const retainedAssets = (before: Save, after: Save, donor: boolean) => {
    const containers = [93, 94, 95];
    const expected = containers.map(c => (before.inventories[c] ?? []).filter(it => it.id !== 995).map(it => ({ ...it })));
    // The full donor fixture declares exactly one talisman moved from pack to bank.
    if (donor) {
        expected[0] = expected[0]!.filter(it => it.id !== 1446);
        expected[2]!.push({ slot: -1, id: 1446, count: 1 });
    }
    return containers.every((c, i) => JSON.stringify(itemTotals(expected[i]!)) === JSON.stringify(itemTotals(after.inventories[c] ?? [])))
        && JSON.stringify(itemTotals(containers.flatMap(c => before.inventories[c] ?? [])))
            === JSON.stringify(itemTotals(containers.flatMap(c => after.inventories[c] ?? [])));
};

export function coinProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
    const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
    if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
        ||new Set(values).size!==4||!/^coin-[a-z0-9-]{1,25}$/.test(instance))throw Error('owned practice endpoints required');
    const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
    return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
        WEB_MANAGEMENT_PORT:String(ports.management),ENGINE_MANAGEMENT_URL:`http://127.0.0.1:${ports.management}`,NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof coinProofEndpoints>;
export function selectCoinProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
    for(let i=0;i<100;i++){
        const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
        if(Object.values(ports).every(bind))return coinProofEndpoints(ports,'coin-'+randomUUID().replaceAll('-','').slice(0,20));
    }
    throw Error('owned practice ports unavailable');
}
export function coinProofAccountEnv(text:string,p:ProofEndpoints){
    if(!/^SERVER=localhost:8888\r?$/m.test(text)||!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/m.test(text))throw Error('new practice account required');
    return text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`);
}
export async function startCoinProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
    const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
    try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:PROOF_TICK_MS,xpRate:25,readyTimeoutMs:60000});}
    finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
export function coinChildConfiguration(args:string[],env:Record<string,string>,p:ProofEndpoints,inherited:NodeJS.ProcessEnv=process.env){
    return{cmd:['bun',...args],cwd:resolve(import.meta.dir,'../../..'),windowsHide:true,
        env:{...inherited,...env,...p.env,GATEWAY_URL:p.gateway,DEMO_OK:'',RANDOM_EVENTS:'0'}};
}
// The shared registration CLI admits only default ports. Keep its session owner
// and tick wait, with the exact generated profile bound to this proof's endpoints.
export function coinRegistrationArgs(name:string,p:ProofEndpoints){
    if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('invalid practice name');
    return['--eval',`import {readFileSync} from 'node:fs';
import {openBot,finish} from './packages/core/src/bot';
import {waitTicks} from './packages/core/src/ticks';
const lines=readFileSync(${JSON.stringify(join(rsSdkRoot(),'bots',name,'bot.env'))},'utf8').split(/\\r?\\n/);
if(!lines.includes(${JSON.stringify('SERVER='+p.server)})||!lines.includes(${JSON.stringify('GATEWAY_URL='+p.gateway)}))throw Error('owned practice account required');
const session=await openBot(${JSON.stringify(name)});await waitTicks(session,3);await finish([session],true,'practice ownership registered');`];
}

export function verify(directory: string) {
    const meta = JSON.parse(readFileSync(join(directory, 'native.json'), 'utf8'));
    const before = [0, 1].map(i => readPracticeSave(join(directory, `before-${i}.sav`)));
    const after = [0, 1].map(i => readPracticeSave(join(directory, `after-${i}.sav`)));
    const log = readFileSync(join(directory, 'transfer.log'), 'utf8');
    const refusal = readFileSync(join(directory, 'refusal.log'), 'utf8') + readFileSync(join(directory, 'refusal.err'), 'utf8');
    const refused = [0, 1].map(i => readPracticeSave(join(directory, `refused-${i}.sav`)));
    const checks = {
        source: meta.source === source(),
        fullDonor: meta.amount === 45000 && count(before[0]!, 93) === 0 && before[0]!.inventories[93]?.length === 28
            && before[0]!.inventories[93]!.filter(i => i.id === 1436 && i.count === 1).length === 27
            && before[0]!.inventories[93]!.filter(i => i.id === 1446 && i.count === 1).length === 1,
        transfer: meta.code === 0 && log.includes('COIN_RESULT {"ok":true'),
        coins: exactCoinDelta(before.map(s => ({ bank: count(s, 95), pack: count(s, 93) })), after.map(s => ({ bank: count(s, 95), pack: count(s, 93) })), meta.amount),
        assets: before.every((s, i) => retainedAssets(s, after[i]!, i === 0)),
        health: before.every((s, i) => s.skills[3]!.level === after[i]!.skills[3]!.level),
        logout: log.includes('LOGOUT logged-out logged-out'),
        refusal: meta.refusalCode !== 0 && refusal.includes('coin bank funds short') && refusal.includes('COIN_RESULT {"ok":false') && refusal.includes('LOGOUT logged-out logged-out'),
        refusalAssets: after.every((s, i) => [93, 94, 95].every(c => JSON.stringify(s.inventories[c] ?? []) === JSON.stringify(refused[i]!.inventories[c] ?? [])) && s.skills[3]!.level === refused[i]!.skills[3]!.level),
    };
    const report = { ok: Object.values(checks).every(Boolean), checks, source: meta.source, scope: 'One native preset transfer; no live or repeat qualification' };
    writeFileSync(join(directory, 'consumer.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return report;
}

async function run(directory: string) {
    if (!existsSync(join(practiceDir(), 'delivery-native.lock'))) throw Error('practice turn required: run through delivery');
    if (freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) throw Error('practice startup headroom unavailable');
    const endpoints = selectCoinProofEndpoints();
    const lock = join(practiceDir(), 'delivery-practice.lock'), fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, task: 'coin-courier', directory }));
    let stack: Awaited<ReturnType<typeof startStack>> | undefined;
    const command = async (args: string[], label: string, env: Record<string, string> = {}) => {
        const child = Bun.spawn({ ...coinChildConfiguration(args, env, endpoints), windowsHide: true, stdout: Bun.file(join(directory, label + '.log')), stderr: Bun.file(join(directory, label + '.err')) });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, 240000);
        try { const code = await child.exited; return timedOut ? -1 : code; } finally { clearTimeout(timer); }
    };
    try {
        const revision = source(), amount = 45000, names = [runBotName('cgive', 1), runBotName('ctake', 1)], saves: string[] = [];
        stack = await startCoinProofStack(endpoints);
        for (const [i, name] of names.entries()) {
            if (existsSync(join(rsSdkRoot(), 'bots', name))) throw Error('practice name already exists');
            const account = await createBot(name);
            writeFileSync(account.envPath, coinProofAccountEnv(readFileSync(account.envPath, 'utf8'), endpoints));
            const inventory = i ? [{ id: 995, count: 7 }, { id: 1265, count: 1 }]
                : [{ id: 1446, count: 1 }, ...Array.from({ length: 27 }, () => ({ id: 1436, count: 1 }))];
            const path = await applyPreset(name, { position: { x: i ? 3184 : 3183, z: 3436, level: 0 }, skills: { Hitpoints: 15 }, inventory, bank: [{ id: 995, count: i ? 500 : 50000 }, { id: 2347, count: 1 }] });
            saves.push(path);
            if (await command(coinRegistrationArgs(name, endpoints), 'auth-' + i) !== 0) throw Error('practice registration failed');
            const entry = await waitPracticeSave(path, s => count(s, 95) === (i ? 500 : 50000) && count(s, 93) === (i ? 7 : 0)
                && (i !== 0 || s.inventories[93]?.length === 28));
            if (!entry.matched) throw Error('practice entry not retained');
            copyFileSync(path, join(directory, `before-${i}.sav`));
        }
        if (freemem() / 2 ** 30 < FREE_FLOOR_GB) throw Error('practice memory floor reached before transfer');
        const code = await command(['scripts/coin-courier.ts', ...names, String(amount)], 'transfer', { COIN_ORDER: 'proof-' + crypto.randomUUID() });
        for (const [i, path] of saves.entries()) {
            await waitPracticeSave(path, s => count(s, 95) === (i ? 500 + amount : 50000 - amount));
            copyFileSync(path, join(directory, `after-${i}.sav`));
        }
        const refusalCode = await command(['scripts/coin-courier.ts', ...names, '50001'], 'refusal', { COIN_ORDER: 'proof-' + crypto.randomUUID() });
        for (const [i, path] of saves.entries()) copyFileSync(path, join(directory, `refused-${i}.sav`));
        writeFileSync(join(directory, 'native.json'), JSON.stringify({ source: revision, amount, names, code, refusalCode, endpoints: { ports: endpoints.ports, instance: endpoints.instance }, server: endpoints.server }));
        return verify(directory);
    } finally {
        try { await stack?.stop(); } finally { closeSync(fd); unlinkSync(lock); }
    }
}
if (import.meta.main) {
    try {
        if (!process.env.DELIVERY_DIR) throw Error('run through coin-courier delivery harness');
        const directory = resolve(process.env.DELIVERY_DIR);
        process.exitCode = (process.argv[2] === '--verify' ? verify(directory) : await run(directory)).ok ? 0 : 1;
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
