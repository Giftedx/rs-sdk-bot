import { existsSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, unlinkSync,statSync,mkdirSync,lstatSync,readdirSync,symlinkSync,cpSync,rmSync } from 'node:fs';
import { join, resolve,basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { freemem,tmpdir } from 'node:os';
import { applyPreset } from './presets';
import { runBotName } from './prove';
import { startStack, PROOF_TICK_MS, type StackOptions } from './stack';
import { canBind } from './ports';
import { deliveryLockDir, practiceDir, rsSdkRoot } from './paths';
import { killTree } from '../../core/src/proc';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
import { readPracticeSave, waitPracticeSave } from './fleet-player-save';
import { exactCoinDelta } from '../../../scripts/coin-courier';
import {prepareReplayRoot,removeReplayRoot} from './replay-root';

const files = ['scripts/coin-courier.ts', 'scripts/coin-courier.test.ts', 'packages/practice/src/coin-courier-proof.ts', 'packages/practice/src/replay-root.ts'];
const root = resolve(import.meta.dir, '../../..');
export const coinProofSource = (base=root) => createHash('sha256').update(files.map(p => p + '\0' + readFileSync(join(base, p), 'utf8')).join('\0')).digest('hex');
const source=coinProofSource;

// Source copies give import.meta.dir a private authority root. Only SDK code/content is shared;
// generated profiles, ownership, leases, lifecycle records and vault paths belong to this fixture.
export function prepareCoinProofRoot(sourceRoot:string,parent:string):string{
    const scratch=prepareReplayRoot(sourceRoot,parent);
    writeFileSync(join(scratch,'.coin-proof-root.json'),JSON.stringify({root:resolve(scratch)}));
    try{
        const vendor=join(scratch,'vendor');
        if(!lstatSync(vendor).isSymbolicLink())throw Error('coin proof expected replay vendor link');
        unlinkSync(vendor);mkdirSync(join(vendor,'rs-sdk','bots'),{recursive:true});
        const sdk=join(sourceRoot,'vendor','rs-sdk'),privateSdk=join(vendor,'rs-sdk');
        for(const dir of ['sdk','server','node_modules'])if(existsSync(join(sdk,dir)))
            symlinkSync(join(sdk,dir),join(privateSdk,dir),process.platform==='win32'?'junction':'dir');
        for(const file of ['package.json','tsconfig.json','bunfig.toml'])if(existsSync(join(sdk,file)))copyFileSync(join(sdk,file),join(privateSdk,file));
        copyFileSync(join(sdk,'bots/create-bot.ts'),join(privateSdk,'bots/create-bot.ts'));
        const template=join(sdk,'bots/_template'),templateEnv=join(template,'bot.env');
        if(existsSync(templateEnv)&&!/^PASSWORD=\{\{PASSWORD\}\}\r?$/m.test(readFileSync(templateEnv,'utf8')))throw Error('coin proof template must contain only placeholder credentials');
        cpSync(template,join(privateSdk,'bots/_template'),{recursive:true});
        const plan=JSON.parse(readFileSync(join(scratch,'swarm.json'),'utf8'));
        writeFileSync(join(scratch,'swarm.json'),JSON.stringify({...plan,jobs:[]}));
        mkdirSync(join(scratch,'.practice/coordinator'),{recursive:true});
        writeFileSync(join(scratch,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[]}));
        mkdirSync(join(scratch,'fleet'),{recursive:true});writeFileSync(join(scratch,'fleet/owners.json'),JSON.stringify({accounts:{}}));
        if(coinProofSource(scratch)!==coinProofSource(sourceRoot))throw Error('coin proof source copy differs');
        return scratch;
    }catch(error){if(!removeCoinProofRoot(scratch))throw Error('coin proof setup failed; scratch cleanup incomplete: '+scratch,{cause:error});throw error;}
}

export function removeCoinProofRoot(scratch:string):boolean{
    const base=resolve(scratch),marker=join(base,'.coin-proof-root.json');
    if(!basename(base).startsWith('replay-root-')||!existsSync(marker)||JSON.parse(readFileSync(marker,'utf8')).root!==base)return false;
    const vendor=join(base,'vendor');
    if(existsSync(vendor)){
        if(lstatSync(vendor).isSymbolicLink())unlinkSync(vendor);
        else{
            const sdk=join(vendor,'rs-sdk');
            if(existsSync(sdk))for(const entry of readdirSync(sdk)){
                const path=join(sdk,entry);if(lstatSync(path).isSymbolicLink())unlinkSync(path);
            }
            rmSync(vendor,{recursive:true,force:true});
        }
    }
    return removeReplayRoot(base);
}

export function assertCoinReserveRefusal(code:number,output:string):void{
    if(code!==0&&output.includes('coin donor bank reserve short')&&output.includes('COIN_RESULT {"ok":false')&&output.includes('LOGOUT logged-out logged-out'))return;
    throw Error('reserve refusal did not reach the expected bank check (exit '+code+'): '+output.trim());
}
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
const unchangedRefusal = (before:Save,after:Save) => JSON.stringify(before.inventories)===JSON.stringify(after.inventories)
    && JSON.stringify(before.skills)===JSON.stringify(after.skills);

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
export function coinChildConfiguration(args:string[],env:Record<string,string>,p:ProofEndpoints,inherited:NodeJS.ProcessEnv=process.env,workerRoot=root){
    return{cmd:['bun',...args],cwd:workerRoot,windowsHide:true,
        env:{...inherited,...env,...p.env,GATEWAY_URL:p.gateway,DEMO_OK:'',RANDOM_EVENTS:'0',
            FLEET_SIDE:'local',FLEET_DIR:join(workerRoot,'fleet'),SWARM_PLAN:join(workerRoot,'swarm.json'),CLOUD_WATCH_ID:'',FLEET_VAULT_KEY:'',FLEET_SEED:'',COORDINATOR_RUN_ID:'',STANDING:'0',SWARM_LEASE_HOLDER:'',WORKER_RELEASE:'',BOT_GOAL:'practice coin courier'}};
}
type RegistrationDeps={
    readEnv?:(path:string)=>string;
    connect?:typeof import('../../core/src/inprocess').connectInProcess;
    ready?:typeof import('../../core/src/bot').awaitBotReady;
    wait?:typeof import('../../core/src/ticks').waitTicks;
    settle?:typeof import('../../core/src/bot').settle;
};
// Registration only authenticates a seeded profile. It has no productive worker
// intent; connectInProcess retains login, ownership and lifecycle enforcement.
export async function registerCoinProofAccount(name:string,p:ProofEndpoints,deps:RegistrationDeps={}){
    if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('invalid practice name');
    const owned=coinProofEndpoints(p.ports,p.instance);
    if(p.server!==owned.server||p.gateway!==owned.gateway)throw Error('owned practice endpoints required');
    const text=(deps.readEnv??(file=>readFileSync(file,'utf8')))(join(rsSdkRoot(),'bots',name,'bot.env'));
    const lines=text.split(/\r?\n/),values=(key:string)=>lines.filter(line=>line.startsWith(key+'='));
    if(values('SERVER').length!==1||values('SERVER')[0]!=='SERVER='+p.server||values('GATEWAY_URL').length!==1||values('GATEWAY_URL')[0]!=='GATEWAY_URL='+p.gateway)throw Error('owned practice account required');
    const password=values('PASSWORD').length===1?values('PASSWORD')[0]!.slice('PASSWORD='.length).trim():'';
    if(!password)throw Error('practice profile password required');
    const connect=deps.connect??(await import('../../core/src/inprocess')).connectInProcess;
    const ready=deps.ready??(await import('../../core/src/bot')).awaitBotReady;
    const wait=deps.wait??(await import('../../core/src/ticks')).waitTicks;
    const settle=deps.settle??(await import('../../core/src/bot')).settle;
    const session=await connect({name,password,server:p.server});
    try{await ready(session,console.log);await wait(session,3);}
    catch(error){await settle([session],false,'practice registration failed');throw error;}
    if(!await settle([session],true,'practice ownership registered'))throw Error('practice registration logout failed');
}
export function coinRegistrationArgs(name:string,p:ProofEndpoints){
    if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('invalid practice name');
    return['--eval',`import {registerCoinProofAccount} from './packages/practice/src/coin-courier-proof';
await registerCoinProofAccount(${JSON.stringify(name)},${JSON.stringify(p)});process.exit(0);`];
}

export function verify(directory: string) {
    const meta = JSON.parse(readFileSync(join(directory, 'native.json'), 'utf8'));
    const before = [0, 1].map(i => readPracticeSave(join(directory, `before-${i}.sav`)));
    const after = [0, 1].map(i => readPracticeSave(join(directory, `after-${i}.sav`)));
    const log = readFileSync(join(directory, 'transfer.log'), 'utf8');
    const refusal = readFileSync(join(directory, 'refusal.log'), 'utf8') + readFileSync(join(directory, 'refusal.err'), 'utf8');
    const refused = [0, 1].map(i => readPracticeSave(join(directory, `refused-${i}.sav`)));
    const reserveRefusal=readFileSync(join(directory,'reserve-refusal.log'),'utf8')+readFileSync(join(directory,'reserve-refusal.err'),'utf8');
    const reserveRefused=[0,1].map(i=>readPracticeSave(join(directory,`reserve-refused-${i}.sav`)));
    const receiptLine=log.split(/\r?\n/).findLast(line=>line.startsWith('COIN_RECEIPT '));
    const receipt=receiptLine?JSON.parse(receiptLine.slice('COIN_RECEIPT '.length)):null;
    const checks = {
        source: meta.source === source()&&meta.workerSource===meta.source,
        fullDonor: meta.amount === 45000 && count(before[0]!, 93) === 0 && before[0]!.inventories[93]?.length === 28
            && before[0]!.inventories[93]!.filter(i => i.id === 1436 && i.count === 1).length === 27
            && before[0]!.inventories[93]!.filter(i => i.id === 1446 && i.count === 1).length === 1,
        transfer: meta.code === 0 && log.includes('COIN_RESULT {"ok":true'),
        coins: exactCoinDelta(before.map(s => ({ bank: count(s, 95), pack: count(s, 93) })), after.map(s => ({ bank: count(s, 95), pack: count(s, 93) })), meta.amount,meta.reserve),
        donorReserve:meta.reserve===5000&&receipt?.reserve===meta.reserve&&count(after[0]!,95)===meta.reserve,
        assets: before.every((s, i) => retainedAssets(s, after[i]!, i === 0)),
        health: before.every((s, i) => s.skills[3]!.level === after[i]!.skills[3]!.level),
        logout: log.includes('LOGOUT logged-out logged-out'),
        refusal: meta.refusalCode !== 0 && refusal.includes('coin bank funds short') && refusal.includes('COIN_RESULT {"ok":false') && refusal.includes('LOGOUT logged-out logged-out'),
        refusalAssets: after.every((s, i) => [93, 94, 95].every(c => JSON.stringify(s.inventories[c] ?? []) === JSON.stringify(refused[i]!.inventories[c] ?? [])) && s.skills[3]!.level === refused[i]!.skills[3]!.level),
        reserveRefusal:meta.reserveRefusal?.code!==0&&meta.reserveRefusal?.amount===meta.amount&&meta.reserveRefusal?.reserve===5001
            &&count(before[0]!,95)>=meta.reserveRefusal.amount&&count(before[0]!,95)-meta.reserveRefusal.amount<meta.reserveRefusal.reserve
            &&reserveRefusal.includes('coin donor bank reserve short')&&reserveRefusal.includes('COIN_RESULT {"ok":false')&&reserveRefusal.includes('LOGOUT logged-out logged-out'),
        reserveRefusalAssets:before.every((s,i)=>unchangedRefusal(s,reserveRefused[i]!)),
        reserveRefusalFreshSaves:meta.reserveRefusal?.savePublications?.length===2&&meta.reserveRefusal.savePublications.every((s:any)=>s.after>s.before&&s.after>=meta.reserveRefusal.startedAt),
        reserveRefusalBeforeMutation:meta.reserveRefusal?.journalCreated===false&&!reserveRefusal.includes('COIN_TRADE')&&!reserveRefusal.includes('COIN_RECEIPT'),
    };
    const report = { ok: Object.values(checks).every(Boolean), checks, source: meta.source, scope: 'One native preset transfer; no live or repeat qualification' };
    writeFileSync(join(directory, 'consumer.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return report;
}

async function run(directory: string) {
    if (!existsSync(join(deliveryLockDir(), 'delivery-native.lock'))) throw Error('practice turn required: run through delivery');
    if (freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) throw Error('practice startup headroom unavailable');
    const endpoints = selectCoinProofEndpoints();
    const lock = join(deliveryLockDir(), 'delivery-practice.lock'), fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, task: 'coin-courier', directory }));
    let stack: Awaited<ReturnType<typeof startStack>> | undefined;
    let workerRoot='';const revision=source();
    const command = async (args: string[], label: string, env: Record<string, string> = {}) => {
        if(!workerRoot||coinProofSource(workerRoot)!==revision)throw Error('coin proof worker source changed');
        const child = Bun.spawn({ ...coinChildConfiguration(args, env, endpoints,process.env,workerRoot), windowsHide: true, stdout: Bun.file(join(directory, label + '.log')), stderr: Bun.file(join(directory, label + '.err')) });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, 240000);
        try { const code = await child.exited; return timedOut ? -1 : code; } finally { clearTimeout(timer); }
    };
    try {
        workerRoot=prepareCoinProofRoot(root,tmpdir());
        const amount = 45000,reserve=5000, names = [runBotName('cgive', 1), runBotName('ctake', 1)], saves: string[] = [];
        stack = await startCoinProofStack(endpoints);
        for (const [i, name] of names.entries()) {
            if (existsSync(join(rsSdkRoot(), 'bots', name))) throw Error('practice name already exists');
            const create=['--eval',`import {readFileSync,writeFileSync} from 'node:fs';
import {createBot} from './packages/practice/src/bots';
import {coinProofAccountEnv} from './packages/practice/src/coin-courier-proof';
const account=await createBot(${JSON.stringify(name)});
writeFileSync(account.envPath,coinProofAccountEnv(readFileSync(account.envPath,'utf8'),${JSON.stringify(endpoints)}));`];
            if(await command(create,'profile-'+i)!==0)throw Error('private practice profile creation failed');
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
        // The full donor can afford the amount, but would be one coin below this reserve. Refuse before even
        // banking its talisman for a slot; retain raw saved inventories and every skill for independent verification.
        const priorSaveTimes=saves.map(path=>statSync(path).mtimeMs),reserveStartedAt=Date.now(),reserveOrder='proof-reserve-'+crypto.randomUUID();
        const reserveRefusalCode=await command(['scripts/coin-courier.ts',...names,String(amount),`--reserve=${reserve+1}`],'reserve-refusal',{COIN_ORDER:reserveOrder});
        const reserveOutput=readFileSync(join(directory,'reserve-refusal.log'),'utf8')+readFileSync(join(directory,'reserve-refusal.err'),'utf8');
        assertCoinReserveRefusal(reserveRefusalCode,reserveOutput);
        const reserveRefusal={code:reserveRefusalCode,amount,reserve:reserve+1,order:reserveOrder,startedAt:reserveStartedAt,savePublications:[] as {before:number;after:number}[],journalCreated:existsSync(join(workerRoot,'.practice/coin-courier',reserveOrder))};
        for(const [i,path]of saves.entries()){
            const initial=readPracticeSave(join(directory,`before-${i}.sav`));
            const saved=await waitPracticeSave(path,s=>statSync(path).mtimeMs>priorSaveTimes[i]!&&statSync(path).mtimeMs>=reserveStartedAt&&unchangedRefusal(initial,s));
            if(!saved.matched)throw Error(unchangedRefusal(initial,saved.save)?'reserve refusal fresh save publication unobserved':'reserve refusal mutated saved assets or skills');
            reserveRefusal.savePublications.push({before:priorSaveTimes[i]!,after:statSync(path).mtimeMs});
            copyFileSync(path,join(directory,`reserve-refused-${i}.sav`));
        }
        const code = await command(['scripts/coin-courier.ts', ...names, String(amount),`--reserve=${reserve}`], 'transfer', { COIN_ORDER: 'proof-' + crypto.randomUUID() });
        for (const [i, path] of saves.entries()) {
            await waitPracticeSave(path, s => count(s, 95) === (i ? 500 + amount : 50000 - amount));
            copyFileSync(path, join(directory, `after-${i}.sav`));
        }
        const refusalCode = await command(['scripts/coin-courier.ts', ...names, '50001'], 'refusal', { COIN_ORDER: 'proof-' + crypto.randomUUID() });
        for (const [i, path] of saves.entries()) copyFileSync(path, join(directory, `refused-${i}.sav`));
        writeFileSync(join(directory, 'native.json'), JSON.stringify({ source: revision,workerSource:coinProofSource(workerRoot), amount,reserve,reserveRefusal, names, code, refusalCode, endpoints: { ports: endpoints.ports, instance: endpoints.instance }, server: endpoints.server }));
        return verify(directory);
    } finally {
        try { await stack?.stop(); } finally {
            try{
                if(workerRoot){
                    // Retain authority and raw receipts, never the private profiles or vault.
                    try{
                        for(const path of ['coordinator','coin-courier','session-lifecycle','status','owned-accounts.json']){
                            const from=join(workerRoot,'.practice',path);if(!existsSync(from))continue;
                            mkdirSync(join(directory,'control'),{recursive:true});cpSync(from,join(directory,'control',path),{recursive:true});
                        }
                    }finally{if(!removeCoinProofRoot(workerRoot))throw Error('coin proof scratch cleanup incomplete: '+workerRoot);}
                }
            }finally{closeSync(fd);unlinkSync(lock);}
        }
    }
}
if (import.meta.main) {
    try {
        if (!process.env.DELIVERY_DIR) throw Error('run through coin-courier delivery harness');
        const directory = resolve(process.env.DELIVERY_DIR);
        process.exitCode = (process.argv[2] === '--verify' ? verify(directory) : await run(directory)).ok ? 0 : 1;
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
