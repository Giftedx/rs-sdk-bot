import { FREE_FLOOR_GB } from '../core/src/memory';

// Snapshot evidence only. Pack contents and courier manifests never inflate bank totals.
// Advisory evidence from a completed trip. This does not declare a route optimal
// or stop an account merely because an expensive route may have valuable loot.
export function productionReview(b: any): string[] {
    const result=String(b.result??'');
    if(b.practice||!/^ok\b/.test(result)||!Number.isFinite(b.tick)||b.tick<100)return [];
    if(!/\bmode=(?:cow|draynor-oak)\b/.test(result)&&!(/\bpicks=\d+\b/.test(result)&&/\bfinalBankConfirmed=/.test(result)))return [];
    const warnings:string[]=[];
    const move=Number(b.ledger?.move);
    if(Number.isFinite(move)&&move>=0&&move<=b.tick&&move/b.tick>0.55)
        warnings.push(`Last batch: ${Math.round(move/b.tick*100)}% of ticks moving; review bank and route`);
    if(/\bmode=cow\b/.test(result)&&!/\btargetLevel=\d+\b/.test(result)){
        const kills=Number(result.match(/\bcreditedKills=(\d+)\b/)?.[1]);
        const workingSlots=Array.isArray(b.inventory)?b.inventory.length:NaN;
        const slots=kills*3+workingSlots;
        if(kills>0&&Number.isFinite(slots)&&slots<21)
            warnings.push(`Last cow batch used about ${slots}/28 pack slots; review batch size`);
    }
    return warnings;
}
export function collectionState(bots: any[], ownedNames: string[], cargo: any[], transfers: any[], now: number) {
    const owned = new Set(ownedNames.map(n => n.toLowerCase()));
    const accounts = bots.filter(b => !b.practice && owned.has(b.name.toLowerCase()));
    const items = new Map<string, { name: string; count: number; identified: boolean }>();
    const normalize = (name: string) => String(name).replace(/\s*\(noted\)\s*$/i, '').trim();
    const knownIds = new Map<string, number>();
    for (const b of accounts) for (const i of b.bank ?? []) if (i && Number.isInteger(i.baseId ?? i.id)) knownIds.set(normalize(i.name).toLowerCase(), i.baseId ?? i.id);
    let missingIds = 0;
    for (const b of accounts) for (const i of b.bank ?? []) {
        if (!i || !(i.count > 0)) continue;
        // Name-only snapshots may contain noted aliases. Collapse these for the estimate,
        // but never call that an exact item-ID count.
        const name = normalize(i.name);
        const identified = Number.isInteger(i.baseId ?? i.id);
        if (!identified) missingIds++;
        const id = i.baseId ?? i.id ?? knownIds.get(name.toLowerCase());
        const key = id != null ? `id:${id}` : `name:${name.toLowerCase()}`;
        const row = items.get(key) ?? { name, count: 0, identified };
        row.count += i.count;
        items.set(key, row);
    }
    const banks = accounts.map(b => ({ name: b.name, at: b.bankAt ?? null,
        state: !Array.isArray(b.bank) || !b.bankAt ? 'unknown' : now - b.bankAt > 300_000 ? 'stale' : 'recent',
        kinds: Array.isArray(b.bank) ? b.bank.filter((i: any) => i?.count > 0).length : null }));
    const pending = cargo.filter(c => owned.has(String(c.name).toLowerCase()) && Array.isArray(c.items) && c.items.some((i: any) => i.count > 0))
        .map(c => ({ ...c, stale: !c.at || now - c.at > 300_000 }));
    const confirmed = transfers.filter(t => owned.has(String(t.from).toLowerCase()) && owned.has(String(t.to).toLowerCase()));
    return { distinct: items.size, missingIds, banks, items: [...items.values()].sort((a, b) => b.count - a.count), pending,
        transfers: confirmed.slice(-12).reverse(), transferCount: confirmed.length,
        excludedTransfers: transfers.length - confirmed.length };
}

export function operationState(b: any, now: number) {
    if (b.reserved) return 'reserved';
    const recent = b.at && b.at<=now && now - b.at < 3_600_000;
    const result = String(b.result ?? '');
    if (recent && (b.hp?.now === 0 || /\bdied=true\b|\bdied\s/.test(result))) return 'died';
    if (/^paused:|\brelease-paused\b/i.test(String(b.planJob?.state??'')) || recent && /\bstop[- ]file\b/i.test(result)) return 'paused';
    if (/\bblocked\b/i.test(String(b.planJob?.state??''))) return 'blocked';
    if (recent && result && !/^ok\b/.test(result)) return 'failed';
    if (recent && /\b(blocked|error|fail|failed|stuck)\b/i.test(String(b.phase ?? ''))) return 'blocked';
    if (!result && b.processActive && (!b.at || now - b.at > 20_000)) return 'active-stale';
    if (!b.at || now - b.at > 20_000) return b.inWorld && !result ? 'unobserved' : 'offline';
    if (b.result) return 'ended';
    return 'observed';
}

export function effectiveJob(status: any, job: any, fresh: boolean) {
    if (!fresh || status.result) return job;
    const goal = String(status.goal || job?.goal || 'Current goal unknown');
    if (job?.enabled && goal === job.goal) return job;
    return { ...(job ?? {}), account: status.name, enabled: true, state: 'manual', role: status.role,
        goal, script: /\.ts$/.test(goal) ? goal : '', note: 'Current goal from fresh status. Historical swarm configuration may differ.' };
}

const PRODUCTION_SCRIPTS = new Set([
    'gather-ore.ts', 'gather-yews.ts', 'gather-flax.ts', 'gather-fish.ts', 'gather-combat.ts',
    'collect-wool.ts', 'cook-stock.ts', 'cook-food.ts', 'spin-bowstrings.ts', 'smelt-bars.ts',
    'fletch-arrows.ts', 'craft-jewelry.ts', 'brew-potions.ts', 'shop-buyer.ts',
    'note-courier.ts', 'supply-holder.ts', 'fishcook.ts', 'foodcourier.ts', 'banker.ts',
]);
export const productionGoal = (goal: string, script = '') =>
    /collect|process|cook|gather|supply|cargo|courier|spin|smelt|fletch|craft|bank|brew|shop-buyer/i.test(goal)
    || PRODUCTION_SCRIPTS.has(script.split(/[\\/]/).pop() ?? '');

export const isLoopback = (address: string) => /^(127\.|::1$|::ffff:127\.)/.test(address);

// Bounded supplier evidence is explicit. RESULT ok may mean a safe partial stop,
// and a ready buffer may require no new purchases at all.
export function boundedOperation(status: any) {
    const text = String(status.result || status.phase || '');
    const counters: Record<string, number> = {};
    // Bounded fletching reports made/banked/planned item units. A generic
    // banked= elsewhere may be coins, so do not relabel every script's metrics.
    const outputFields = /\bmode=(?:headless|steel)(?=\s|$)/.test(text) ? ['made','banked','planned','xpGain'] : [];
    for (const field of ['boughtTotal','bankedTotal','spentTotal','coinsLeft','coinReserve','maxSpend','maxItems','noBuyTicks','noBuyLimit',...outputFields]) {
        const match = text.match(new RegExp(`\\b${field}=([0-9]+)(?=\\s|$)`));
        if (match) counters[field] = Number(match[1]);
    }
    const target = String(status.result || '').match(/\btargetMet=(true|false|[01])(?=\s|$)/);
    const targetMet = target ? target[1] === '1' || target[1] === 'true' : null;
    const stop = String(status.result || '').match(/\bstop=([^\s]+)/)?.[1] ?? null;
    return { counters, targetMet, stop, visible: Object.keys(counters).length > 0 || targetMet !== null,
        label: targetMet === true ? (counters.boughtTotal === 0 ? 'Buffer ready · no new purchases' : 'Stock target met')
            : targetMet === false ? (stop === 'stock-wait' ? 'Partial stock · waiting offline' : 'Partial stock · target unmet')
            : 'Target fulfillment unreported' };
}

export function accountJobRows(jobs:any):any[]{
 if(!Array.isArray(jobs))return [];
 return jobs.flatMap(job=>{
  if(!job||typeof job!=='object')return [];
  const names=[job.account,...(Array.isArray(job.accounts)?job.accounts:[])].filter((n:any)=>typeof n==='string'&&/^[A-Za-z0-9_ -]{1,12}$/.test(n));
  const seen=new Set<string>();return names.filter((name:string)=>{const key=name.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;}).map((account:string)=>({...job,account}));
 });
}

export function capacityState(sw: any, freeGB: number, now: number) {
    const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    const at = number(sw?.at), fresh = at !== null && now >= at && now-at < 30_000;
    const running = number(sw?.running), external = number(sw?.externalRunning), cap = number(sw?.maxBots);
    const pendingReserveGB = fresh ? number(sw?.pendingReserveGB) : null;
    // The floor of the swarm's own admission (scripts/swarm.ts admissionDecision): the larger of FREE_FLOOR_GB and the
    // plan's minFreeGB. The swarm writes that number as minFreeGB in its state file.
    const floorGB = sw ? Math.max(FREE_FLOOR_GB, number(sw.minFreeGB) ?? FREE_FLOOR_GB) : null;
    const free = number(freeGB);
    const queued = fresh && Array.isArray(sw?.jobs) ? new Set(accountJobRows(sw.jobs).filter((j: any) => j.enabled && typeof j.account === 'string'
        && /^(?:waiting: (?:maxBots$|projected |current mission still running$)|stopping; resume queued$|running; updated mission queued$)/.test(String(j.state)))
        .map((j: any) => j.account.toLowerCase())).size : null;
    return { at, fresh, active: fresh && running !== null && external !== null ? running+external : null, cap,
        queued, freeGB: free, floorGB, pendingReserveGB,
        headroomGB: free !== null && floorGB !== null && pendingReserveGB !== null ? free-floorGB-pendingReserveGB : null };
}

export type NativeProof = { kind: 'host-stop-cleanup'; outcome: 'proved'; level: 'local-native'; label: string;
    actor: string; at: number; snapshot: string; workerOutcome: 'fail'; goalMet: false; scope: string;
    source: { hostSha256: string; workerSha256: string; harnessSha256: string; matchesCurrent: boolean } };

// Reviewed native harness version. Later edits to production source do not erase
// this historical result; unknown harness contracts do not gain proof from ok:true.
export const HOST_STOP_SOURCE = {
    host:'2F5C1509181F25E239D6ED91E8213F3C33A430E21BE9DD56D2A809AB25ED6C82',
    worker:'458AEDDE6C5043A6F336656291FEE297340FAF328DEBD6ACF96667CF6B722368',
    harness:'7DF8D71668D702CE28CBE0100FF7FBF9949A9284A8DCED1BACC11DE80D1F6B30',
    fixture:'388C689E2362331AB06C4DE4FD45223DC7E973C1BA17207EDC561D7D81F74C51',
};

// Deliberately one known native harness contract, not a generic *.json "ok" reader.
// Loader supplies hashes of the actual fixed source paths and the bounded fixture file.
export function hostStopNativeProof(status: any, evidence: { filename: string; snapshot: any; raw: string; at: number;
    hashes: { host: string; worker: string; harness: string; fixture: string } }): NativeProof | null {
    const {snapshot: s, raw, hashes} = evidence, actor = String(status?.name ?? '');
    if (!/^fl[a-z0-9]{1,20}$/i.test(actor) || !/^(?:localhost|127\.0\.0\.1):8888$/.test(String(status?.server))
        || s?.actor !== actor || evidence.filename !== `host-stop-${actor}-snapshot.json`
        || !Number.isFinite(evidence.at) || !Number.isFinite(status.at) || Math.abs(evidence.at-status.at)>120_000
        || (Number.isFinite(status.started) && evidence.at<status.started)
        || !/^fail mode=prayer\b/.test(String(status.result)) || !/(?:^|[\\/])host\.ts$/.test(String(status.goal))) return null;
    const sha = (v: unknown) => typeof v === 'string' && /^[A-F0-9]{64}$/.test(v);
    if (![s.hostSha256,s.prayerSha256,s.harnessSha256,s.sourceSnapshotSha256,...Object.values(hashes)].every(sha)
        || s.hostSha256!==HOST_STOP_SOURCE.host || s.prayerSha256!==HOST_STOP_SOURCE.worker || s.harnessSha256!==HOST_STOP_SOURCE.harness
        || s.sourceSnapshotSha256!==HOST_STOP_SOURCE.fixture || s.sourceSnapshotSha256!==hashes.fixture
        || !/^\.practice\/fleet-proof\/prayer-fl[a-z0-9]+-source\.json$/i.test(s.sourcePath)) return null;
    if (s.ok!==true || s.expectedWorkFailure!==true || s.code!==1 || s.timedOut!==false
        || !['cleanup','assets','equipment','skills','atBank','life'].every(k=>s[k]===true)) return null;
    const w=s.worker, debit=s.debit;
    if (!Number.isSafeInteger(debit) || debit<1 || debit>13 || w?.ok!==false || w.targetMet!==false || w.stop!=='stop-file'
        || w.buried!==debit || w.consumed!==debit || w.initialBones!==222 || w.boneBank!==222-debit || w.heldBones!==0
        || w.preserved!==true || w.died!==false || w.hpMin!==70 || !new RegExp(`\\bburied=${debit}(?=\\s|$)`).test(status.result)) return null;
    const count=(v:any,id:number)=>Array.isArray(v)?v.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0):NaN;
    const totals=(v:any):Map<number,number>|null=>{
        if(!Number.isSafeInteger(v?.version)||v.version<5||v.version>9||!v.inventories||!Array.isArray(v.skills)||v.skills.length!==21)return null;
        const m=new Map<number,number>();
        for(const items of Object.values(v.inventories)){
            if(!Array.isArray(items))return null;
            for(const i of items){if(!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<=0)return null;m.set(i.id,(m.get(i.id)??0)+i.count);}
        }
        return m;
    };
    const before=totals(s.initial), after=totals(s.final);
    if(!before||!after||[...new Set([...before.keys(),...after.keys()])].some(id=>(after.get(id)??0)!==(before.get(id)??0)-(id===526?debit:0))
        || count(s.initial.inventories[95],526)!==222 || count(s.final.inventories[95],526)!==222-debit || count(s.final.inventories[93],526)!==0
        || JSON.stringify(s.initial.inventories[94])!==JSON.stringify(s.final.inventories[94])
        || s.initial.skills[5]?.rawExperience!==0 || s.final.skills[5]?.rawExperience!==1125*debit
        || s.final.skills.some((v:any,i:number)=>i!==5&&(v.rawExperience!==s.initial.skills[i]?.rawExperience||v.level!==s.initial.skills[i]?.level))) return null;
    const p=s.final.position;
    if(!p||p.level!==0||![3283,3286].some(z=>Math.max(Math.abs(p.x-2656),Math.abs(p.z-z))<=1))return null;
    const jsonLine=(prefix:string)=>{try{return JSON.parse(raw.split(/\r?\n/).find(l=>l.startsWith(prefix))?.slice(prefix.length)??'null');}catch{return null;}};
    const request=jsonLine('HOST_STOP_REQUEST '), worker=jsonLine(`[${actor}] PRAYER_BANK `);
    const workResult=raw.split(/\r?\n/).find(l=>l.startsWith(`[${actor}] RESULT fail mode=prayer `))??'';
    if(!request||request.prayerXp<=0||request.heldBones<=0||JSON.stringify(request)!==JSON.stringify(s.request)
        || !worker || JSON.stringify(worker)!==JSON.stringify(w)
        || !raw.includes('HOST start bots=1 script=scripts/train-prayer.ts ')
        || !new RegExp(`\\bburied=${debit}(?=\\s|$)`).test(workResult)||!workResult.includes('targetMet=false')||!workResult.includes('stop=stop-file') || !raw.includes(`[${actor}] LOGOUT logged-out`)
        || !raw.includes('HOST done ok=0/1 ') || !raw.includes('PROOF_SKILLS_EXACT true')
        || !raw.includes('PROOF_SURVIVAL started=true died=false hpMin=70 finalHp=70'))return null;
    return {kind:'host-stop-cleanup',outcome:'proved',level:'local-native',label:'Stop cleanup proved · work stopped',actor,
        at:evidence.at,snapshot:evidence.filename,workerOutcome:'fail',goalMet:false,
        scope:'Single local actor; entry and owned-asset stop cleanup. No production-target, live, multi-actor or scaling claim.',
        source:{hostSha256:s.hostSha256,workerSha256:s.prayerSha256,harnessSha256:s.harnessSha256,
            matchesCurrent:s.hostSha256===hashes.host&&s.prayerSha256===hashes.worker&&s.harnessSha256===hashes.harness}};
}
