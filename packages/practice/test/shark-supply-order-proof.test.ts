import {test,expect,afterAll} from 'bun:test';
import {sharkSaveChecks,sharkChildChecks,sharkResult,diagnosticRecovery,ordinaryEntry,decodeSharkSave,recomputeSharks,verifySharks,sharkProofSources,treeHashes,PRACTICE_SERVER} from '../src/shark-supply-order-proof';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,statSync,unlinkSync,cpSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {beginSessionAttempt,accountDir,lifecycleOwner} from '../../core/src/session-lifecycle';
import {createHash} from 'node:crypto';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

function save(){return {version:9,position:{x:2809,z:3441,level:0},skills:Array.from({length:21},(_,index)=>({index,rawExperience:1000,xp:100,level:75})),vars:{134:1},inventories:{93:[],94:[{slot:3,id:1275,count:1}],95:[{slot:0,id:995,count:5408},{slot:1,id:329,count:312},{slot:2,id:385,count:5}]}};}
function valid(){const before=save(),after=structuredClone(before);after.inventories[95][0]!.count=5403;after.inventories[95][1]!.count=308;after.inventories[95][2]!.count=30;
    after.inventories[95].push({slot:3,id:311,count:1},{slot:4,id:387,count:2});after.skills[7]!.rawExperience++;after.skills[10]!.rawExperience++;
    const result={ok:true,target:25,consumer:'high-HP endgame combat staging',caught:27,cooked:25,burnt:2,banked:25,coinsSpent:5,toolBought:1,consumed:{329:4},died:false,hpMin:43,damage:0};return {before,after,result};}
test('independent saved proof requires net new banked output, XP and exact paid inputs',()=>{
    const {before,after,result}=valid();expect(Object.values(sharkSaveChecks(before,after,result,25,true)).every(Boolean)).toBe(true);
    after.inventories[95][2]!.count=5;expect(sharkSaveChecks(before,after,result,25,true).output).toBe(false);
});
test('starting sharks, uncounted burns/food/coins, lost kit and death cannot pass',()=>{
    {const {before,after,result}=valid();result.burnt=0;expect(sharkSaveChecks(before,after,result,25,true).fish).toBe(false);}
    {const {before,after,result}=valid();result.consumed[329]=0;expect(sharkSaveChecks(before,after,result,25,true).food).toBe(false);}
    {const {before,after,result}=valid();result.coinsSpent=0;expect(sharkSaveChecks(before,after,result,25,true).paid).toBe(false);}
    {const {before,after,result}=valid();after.inventories[94]=[];expect(sharkSaveChecks(before,after,result,25,true).equipment).toBe(false);}
    {const {before,after,result}=valid();result.died=true;expect(sharkSaveChecks(before,after,result,25,true).health).toBe(false);}
});
test('installed child proof binds success, single logout and timeout separately',()=>{
    expect(Object.values(sharkChildChecks(0,false,'RESULT ok target\nLOGOUT logged-out\n',true)).every(Boolean)).toBe(true);
    expect(sharkChildChecks(0,true,'RESULT ok target\nLOGOUT logged-out\n',true).exit).toBe(false);
    expect(sharkChildChecks(0,false,'RESULT ok target\n',true).logout).toBe(false);
    expect(sharkChildChecks(0,false,'RESULT ok target\nLOGOUT logged-out\nLOGOUT logged-out\n',true).logout).toBe(false);
    expect(sharkResult('SHARK_ORDER_RESULT {"ok":false}\nSHARK_ORDER_RESULT {"ok":true}')).toEqual({ok:true});
});

test('two retained raw sharks reconcile a failed target3 but never cooked delivery',()=>{
    const before=save(),after=structuredClone(before);
    // The recorded resume boundary: owned harpoon, four salmon eaten, no cash
    // spend, two new raw383 in the bank and no cooked385/burnt387 increment.
    before.inventories[95].push({slot:3,id:311,count:1});
    after.inventories[95].push({slot:3,id:311,count:1},{slot:4,id:383,count:2});
    after.inventories[95][1]!.count=308;
    after.skills[10]!.rawExperience+=55000;
    const r={ok:false,target:3,consumer:'high-HP endgame combat staging',caught:2,cooked:0,burnt:0,banked:0,
        coinsSpent:0,toolBought:0,consumed:{329:4},died:false,hpMin:43,damage:0,recovery:'banked',failure:'Error: shark fishing no progress'};
    expect(Object.values(sharkSaveChecks(before,after,r,3,false)).every(Boolean)).toBe(true);
    const claimed={...r,ok:true,cooked:3,banked:3};
    const checks=sharkSaveChecks(before,after,claimed,3,true);
    expect(checks.output).toBe(false);expect(checks.fish).toBe(false);expect(checks.cooking).toBe(false);
    const log='SHARK_ORDER_RESULT '+JSON.stringify(r)+'\nLOGOUT logged-out\nRESULT fail newBankedSharks=0\n';
    expect(sharkChildChecks(1,false,log,true).exit).toBe(false);
    expect(sharkChildChecks(1,false,log,true).result).toBe(false);
    expect(sharkChildChecks(1,false,log,false).logout).toBe(true);
});

test('fishing diagnostic accepts only an observed bounded failure with reconciled cleanup, never as delivery',()=>{
    const before=save(),after=structuredClone(before);
    after.inventories[95].push({slot:3,id:311,count:1},{slot:4,id:383,count:24});after.inventories[95][0]!.count=5403;after.inventories[95][1]!.count=308;after.skills[10]!.rawExperience+=660000;
    const r={ok:false,target:25,consumer:'high-HP endgame combat staging',caught:24,cooked:0,burnt:0,banked:0,coinsSpent:5,toolBought:1,consumed:{329:4},died:false,hpMin:43,damage:0,failure:'Error: shark fishing no progress'};
    const log='SHARK_ORDER_RESULT '+JSON.stringify(r)+'\nLOGOUT logged-out\nRESULT fail newBankedSharks=0\n';
    const ok=diagnosticRecovery(before,after,r,{code:1,timedOut:false},log,true);
    expect(ok.ok).toBe(true);expect(ok.product.output).toBe(true);
    expect(diagnosticRecovery(before,after,r,{code:1,timedOut:true},log,true).required.exit).toBe(false);
    expect(diagnosticRecovery(before,after,r,{code:1,timedOut:false},log,false).ok).toBe(false);
    expect(diagnosticRecovery(before,after,r,{code:1,timedOut:false},log.replace('LOGOUT logged-out\n',''),true).required.logout).toBe(false);
    const carried=structuredClone(after);(carried.inventories as any)[93]=[{slot:0,id:383,count:1}];
    expect(diagnosticRecovery(before,carried,r,{code:1,timedOut:false},log,true).required.pack).toBe(false);
    expect(diagnosticRecovery(before,after,{...r,died:true},{code:1,timedOut:false},log,true).required.health).toBe(false);
    expect(diagnosticRecovery(before,after,null,{code:1,timedOut:false},log,true).required.result).toBe(false);
});
test('fishing diagnostic input must be the recorded ordinary entry state',()=>{
    const s=save();s.position={x:2618,z:3332,level:0};s.skills[3]!.level=43;s.skills[7]!.level=99;s.skills[10]!.level=99;s.inventories[95].push({slot:3,id:333,count:560});
    expect(ordinaryEntry(s)).toBe(true);
    const tool=structuredClone(s);tool.inventories[95].push({slot:4,id:311,count:1});expect(ordinaryEntry(tool)).toBe(false);
    const moved=structuredClone(s);moved.position.x=2809;expect(ordinaryEntry(moved)).toBe(false);
});

const root=resolve(import.meta.dir,'../../..');
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
// Independent fixture writer: full pinned v9 layout, including empty slots and tail.
function encode(s:ReturnType<typeof save>,version=9){
    const b=Buffer.alloc(20000);let at=0;
    const u1=(n:number)=>{b.writeUInt8(n,at++);},u2=(n:number)=>{b.writeUInt16BE(n,at);at+=2;},i4=(n:number)=>{b.writeInt32BE(n,at);at+=4;};
    u2(0x2004);u2(version);u2(s.position.x);u2(s.position.z);u1(s.position.level);at+=19;
    for(const skill of s.skills){i4(skill.rawExperience);u1(skill.level);}
    if(version===6){const count=Math.max(...Object.keys(s.vars).map(Number))+1;u2(count);for(let i=0;i<count;i++)i4((s.vars as Record<number,number>)[i]??0);}
    else {u2(Object.keys(s.vars).length);
        for(const [id,value] of Object.entries(s.vars)){u2(Number(id));const digits=[value&127];let n=value>>>7;while(n){digits.unshift((n&127)|128);n>>>=7;}digits.forEach(u1);}}
    const containers=Object.entries(s.inventories);u1(containers.length);
    for(const [type,items] of containers){u2(Number(type));const size=Math.max(0,...items.map(i=>i.slot+1));u2(size);
        for(let slot=0;slot<size;slot++){const item=items.find(i=>i.slot===slot);u2(item?item.id+1:0);if(item){u1(item.count>=255?255:item.count);if(item.count>=255)i4(item.count);}}}
    u1(0);u2(0);u1(0);at+=8;if(version===9){u2(0);at+=84;}
    b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,at))>>>0,at);return b.subarray(0,at+4);
}
let fixtureTemplate:string|undefined;
// Test-owned scratch, removed after the file's tests.
const parent=mkdtempSync(join(tmpdir(),'shark-proof-'));
afterAll(()=>rmSync(parent,{recursive:true,force:true}));
const lifeOwner={...lifecycleOwner({},['bun',join(root,'scripts/shark-supply.ts')]),pid:1};
// One producer attempt as the installed CLI leaves it after a confirmed logout.
function lifecycle(dir:string,name:string,copyFrom?:string){
    const life=join(dir,'lifecycle');if(copyFrom)cpSync(copyFrom,life,{recursive:true});
    const a=beginSessionAttempt({account:name,server:PRACTICE_SERVER},{root:life,owner:lifeOwner});
    for(const [k,d] of [['connected'],['ready','2618 3332 0'],['ended','logged-out'],['logout','logged-out'],['closed']] as const)a.record(k,d);
    writeFileSync(join(dir,'status.json'),JSON.stringify({name,server:PRACTICE_SERVER,sessionAttemptId:a.attemptId}));
    return {lifecycle:treeHashes(life),status:sha(join(dir,'status.json'))};
}
function fixture(){
    const directory=mkdtempSync(join(parent,'readonly-cli-')),receipts:any[]=[];
    if(fixtureTemplate){cpSync(fixtureTemplate,directory,{recursive:true});return directory;}
    const entry=save();entry.position={x:2618,z:3332,level:0};entry.skills[3]!.level=43;entry.skills[7]!.level=99;entry.skills[10]!.level=99;
    entry.inventories[95].push({slot:3,id:333,count:560},{slot:4,id:436,count:17});
    const budget=structuredClone(entry);budget.position={x:2809,z:3441,level:0};budget.inventories[95].push({slot:5,id:311,count:1});
    const budgetAfter=structuredClone(budget);budgetAfter.vars[134]++;
    const noStock=structuredClone(entry);noStock.inventories[95]=noStock.inventories[95].filter(i=>![329,333].includes(i.id));
    for(const id of ['entry','budget','resume','no-stock']){
        const before=structuredClone(id==='entry'?entry:id==='budget'?budget:id==='resume'?budgetAfter:noStock),after=structuredClone(before),target=id==='entry'?25:3;
        const success=id==='entry'||id==='resume';
        const r:any={ok:success,target,consumer:'high-HP endgame combat staging',caught:0,cooked:0,burnt:0,banked:0,coinsSpent:0,toolBought:0,consumed:{},died:false,hpMin:43,damage:0};
        after.vars[134]++;
        if(success){after.position={x:2809,z:3441,level:0};after.skills[7]!.rawExperience+=target*52500;after.skills[10]!.rawExperience+=target*27500;
            after.inventories[95].find(i=>i.id===385)!.count+=target;Object.assign(r,{caught:target,cooked:target,banked:target});
            if(id==='entry'){after.inventories[95].find(i=>i.id===995)!.count-=5;after.inventories[95].push({slot:5,id:311,count:1});r.coinsSpent=5;r.toolBought=1;}}
        else r.failure=id==='budget'?'Error: shark entry budget/health stop':'Error: missing owned travel food';
        const dir=join(directory,id);mkdirSync(dir);writeFileSync(join(dir,'before.sav'),encode(before));writeFileSync(join(dir,'after.sav'),encode(after));
        writeFileSync(join(dir,'worker.log'),'SHARK_ORDER_RESULT '+JSON.stringify(r)+'\nLOGOUT logged-out\nRESULT '+(success?'ok':'fail')+' finite\n');
        const name=id==='resume'?'flsharkfix2':`flsharkfix${receipts.length+1}`;
        const life=lifecycle(dir,name,id==='resume'?join(directory,'budget','lifecycle'):undefined);
        receipts.push({id,name,target,code:success?0:1,timedOut:false,persisted:true,before:sha(join(dir,'before.sav')),after:sha(join(dir,'after.sav')),log:sha(join(dir,'worker.log')),...life});
    }
    writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:sharkProofSources(),tickMs:150,xpRate:25,cases:receipts}));
    const report=recomputeSharks(directory);expect(report.ok).toBe(true);
    writeFileSync(join(directory,'consumer.json'),JSON.stringify(report));
    fixtureTemplate=mkdtempSync(join(parent,'readonly-template-'));cpSync(directory,fixtureTemplate,{recursive:true});return directory;
}
function snapshot(directory:string):unknown {
    return readdirSync(directory).sort().map(name=>{const path=join(directory,name);return [name,statSync(path).isDirectory()?snapshot(path):sha(path)];});
}
async function cliUnchanged(directory:string,ok:boolean){
    const before=snapshot(directory);
    let imported=false;try{imported=verifySharks(directory).ok;}catch{}
    expect(imported).toBe(ok);expect(snapshot(directory)).toEqual(before);
    const p=Bun.spawn(['bun','packages/practice/src/shark-supply-order-proof.ts','--verify'],{cwd:root,env:{...process.env,DELIVERY_DIR:directory},stdout:'pipe',stderr:'pipe',windowsHide:true});
    const timer=setTimeout(()=>p.kill(),10000);
    try{const [code]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);expect(code).toBe(ok?0:1);}
    finally{clearTimeout(timer);}
    expect(snapshot(directory)).toEqual(before);
}
test('actual verify CLI and imported verifier preserve every entry and hash on success',async()=>{
    const dir=fixture(),before=snapshot(dir);expect(verifySharks(dir).ok).toBe(true);expect(snapshot(dir)).toEqual(before);await cliUnchanged(dir,true);
});
test('actual verify CLI leaves false predicates, corrupt saves and missing artifacts unchanged',async()=>{
    for(const fault of ['predicate','published-failure','crc','truncated','substituted','missing-save','missing-log','missing-native','missing-report']){
        const dir=fixture(),savePath=join(dir,'entry/after.sav');
        if(fault==='predicate'||fault==='published-failure'){const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));meta.tickMs=300;writeFileSync(join(dir,'native.json'),JSON.stringify(meta));
            if(fault==='published-failure')writeFileSync(join(dir,'consumer.json'),JSON.stringify(recomputeSharks(dir)));}
        if(fault==='crc'){const b=readFileSync(savePath);b[5]^=1;writeFileSync(savePath,b);}
        if(fault==='truncated')writeFileSync(savePath,readFileSync(savePath).subarray(0,140));
        if(fault==='substituted')writeFileSync(savePath,readFileSync(join(dir,'entry/before.sav')));
        const missing:Record<string,string>={'missing-save':'entry/after.sav','missing-log':'entry/worker.log','missing-native':'native.json','missing-report':'consumer.json'};
        if(missing[fault])unlinkSync(join(dir,missing[fault]!));await cliUnchanged(dir,false);
    }
},30000);
test('actual verify CLI refuses false, substituted and malformed published claims without rewriting them',async()=>{
    for(const fault of ['ok','predicate','missing-predicate','extra-predicate','scope','consumer','substituted-report','future-time','malformed','null']){
        const dir=fixture(),path=join(dir,'consumer.json'),r=JSON.parse(readFileSync(path,'utf8'));
        if(fault==='ok')r.ok=false;if(fault==='predicate')r.checks['entry.output']=false;
        if(fault==='missing-predicate')delete r.checks['entry.output'];if(fault==='extra-predicate')r.checks.invented=true;
        if(fault==='scope')r.scope='live approved';if(fault==='consumer')r.nextConsumer='substitute';if(fault==='future-time')r.at=Date.now()+60000;
        if(fault==='substituted-report'){const other=fixture(),meta=JSON.parse(readFileSync(join(other,'native.json'),'utf8'));meta.at--;writeFileSync(join(other,'native.json'),JSON.stringify(meta));
            writeFileSync(path,JSON.stringify(recomputeSharks(other)));await cliUnchanged(dir,false);continue;}
        writeFileSync(path,fault==='malformed'?'{':fault==='null'?'null':JSON.stringify(r));await cliUnchanged(dir,false);
    }
},30000);
test('lifecycle proof needs the exact producer attempt, confirmed server logout and linked status for every case',async()=>{
    const ok=fixture(),checks=recomputeSharks(ok).checks;
    for(const id of ['entry','budget','resume','no-stock'])for(const k of ['lifecycleIdentity','lifecycleLogout','lifecycleOwner','lifecycleAttempts','lifecycleStatus','lifecycleHash'])expect(checks[`${id}.${k}`]).toBe(true);
    expect(checks.resumeLifecycle).toBe(true);
    const fail=(dir:string,key:string)=>{const r=recomputeSharks(dir);expect(r.ok).toBe(false);expect(r.checks[key]).toBe(false);};
    const attemptFile=(dir:string,name:string)=>{const d=join(accountDir(name,PRACTICE_SERVER,join(dir,'lifecycle')),'attempts');return join(d,readdirSync(d).sort().at(-1)!);};
    // Missing receipts: a LOGOUT line in the worker log is not lifecycle proof.
    {const dir=fixture();rmSync(join(dir,'entry/lifecycle'),{recursive:true});fail(dir,'entry.lifecycleLogout');}
    // Logout timeout with a disconnected end stays held.
    {const dir=fixture(),f=attemptFile(join(dir,'entry'),'flsharkfix1');writeFileSync(f,readFileSync(f,'utf8').replace(/"detail":"logged-out"/g,'"detail":"disconnected"'));fail(dir,'entry.lifecycleLogout');}
    // A later pre-START partial connection supersedes the logout, with the old status left in place.
    {const dir=fixture();beginSessionAttempt({account:'flsharkfix1',server:PRACTICE_SERVER},{root:join(dir,'entry/lifecycle'),owner:lifeOwner});fail(dir,'entry.lifecycleIdentity');}
    // Status from another attempt, and a crossed identity behind the case.
    {const dir=fixture();writeFileSync(join(dir,'entry/status.json'),JSON.stringify({name:'flsharkfix1',server:PRACTICE_SERVER,sessionAttemptId:'0000000000001-0000000001-0000000001'}));fail(dir,'entry.lifecycleStatus');}
    {const dir=fixture(),meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));meta.cases[0].name='flsharkfix4';writeFileSync(join(dir,'native.json'),JSON.stringify(meta));fail(dir,'entry.lifecycleIdentity');}
    // The resumed identity must keep the budget attempt byte for byte.
    {const dir=fixture(),d=join(accountDir('flsharkfix2',PRACTICE_SERVER,join(dir,'resume/lifecycle')),'attempts');rmSync(join(d,readdirSync(d).sort()[0]!));fail(dir,'resume.lifecycleAttempts');}
    // A receipt changed after the native run no longer matches its bound hash.
    {const dir=fixture(),f=attemptFile(join(dir,'no-stock'),'flsharkfix4');writeFileSync(f,readFileSync(f,'utf8').replace('"pid":1','"pid":2'));fail(dir,'no-stock.lifecycleHash');}
    const dir=fixture();rmSync(join(dir,'budget/status.json'));await cliUnchanged(dir,false);
},30000);
test('independent semantic decoder checks full pinned v9 slots, skills, varints and CRC',()=>{
    const dir=fixture(),path=join(dir,'entry/after.sav'),bytes=readFileSync(path);
    expect(decodeSharkSave(bytes).save).toEqual(readPracticeSave(path));
    expect(decodeSharkSave(bytes).save.inventories[94]).toEqual([{slot:3,id:1275,count:1}]);
    const bad=Buffer.from(bytes);bad[5]^=1;expect(()=>decodeSharkSave(bad)).toThrow('CRC');
    expect(()=>decodeSharkSave(bytes.subarray(0,100))).toThrow('truncated');
    // Valid CRC cannot hide a truncated semantic body.
    const cut=Buffer.from(bytes.subarray(0,bytes.length-12));cut.writeUInt32BE(Bun.hash.crc32(cut.subarray(0,-4))>>>0,cut.length-4);
    expect(()=>decodeSharkSave(cut)).toThrow('truncated');
    const substituted=readFileSync(join(dir,'entry/before.sav'));
    expect(decodeSharkSave(substituted).save).not.toEqual(readPracticeSave(path));
    const fixture6=join(dir,'fixture-v6.sav');writeFileSync(fixture6,encode(save(),6));
    expect(decodeSharkSave(readFileSync(fixture6)).save).toEqual(readPracticeSave(fixture6));
});
