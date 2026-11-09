import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {sha} from '../src/launch-evidence';
import {missionSignature} from '../src/session-admission';
import {beginSessionAttempt} from '../src/session-lifecycle';
import {assertSpecialistLogin, specialistTokenPath} from '../src/specialist-launch';

const parent=resolve(tmpdir()), account='Shaftshooter', server='rs-sdk-demo.fly.dev', runId='task-specialist-proof';
const source='a'.repeat(64), script='scripts/specialist.ts';

function withFixture(check:(f:ReturnType<typeof fixture>)=>void, issuedAt?:number) {
    const f=fixture(issuedAt);
    try{check(f);}finally{if(/^rsbot-specialist-login-[^/\\]+$/.test(relative(parent,f.base)))rmSync(f.base,{recursive:true,force:true});}
}
function fixture(start=Date.now()-10_000){
    const base=mkdtempSync(join(parent,'rsbot-specialist-login-'));
    const file=(path:string,data:unknown)=>{
        const target=join(base,path), bytes=JSON.stringify(data);
        mkdirSync(dirname(target),{recursive:true});
        writeFileSync(target,bytes);
        return{path,sha256:sha(bytes)};
    };
    const job={account,script,enabled:true,coordinatorOwner:'coordinator',env:{COORDINATOR_RUN_ID:runId}};
    const mission=sha(missionSignature(job));
    file('swarm.json',{maxBots:17,jobs:[]});
    const jobs=(enabled:boolean)=>file('.practice/coordinator/jobs.json',{jobs:[{...job,enabled}]});
    jobs(true);
    const runDir='.practice/coordinator/runs/'+runId;
    file(runDir+'/owner.json',{runId,pid:process.pid});
    const plan=file('.practice/specialist-launch/shaftshooter.json',{requirements:[]});
    const hiscores=file('.practice/specialist-launch/hiscores.json',{takenAt:start});
    const token={version:2,account:account.toLowerCase(),runId,source,mission,at:start,expiresAt:start+600_000,
        runUntil:start+900_000,bindings:[plan,hiscores]};
    const tokenRef=file(specialistTokenPath(account),token);
    const env={COORDINATOR_RUN_ID:runId,WORKER_RELEASE:source,SWARM_MISSION_HASH:mission};
    const active=(pid:number,marker:string)=>pid===process.pid&&marker===runId;
    const authorize=(at=Date.now(),overrides:Partial<typeof env>={},alive=active)=>assertSpecialistLogin(base,account,at,{...env,...overrides},server,alive);
    const attempt=(authorization={ticket:tokenRef.sha256,mission})=>
        beginSessionAttempt({account,server},{root:join(base,'.practice/session-lifecycle'),
            owner:{pid:process.pid,coordinatorRunId:runId,workerRelease:source,script,role:'ranged',participants:null,specialistAuthorization:authorization}});
    return{base,file,jobs,runDir,token,tokenRef,hiscores,authorize,attempt,start};
}

test('first login expires on schedule, but a proved relog uses the same finite original ticket',()=>withFixture(f=>{
    const {start}=f;
    expect(f.authorize()).toBe(f.tokenRef.sha256);
    expect(()=>f.authorize(undefined,{},()=>false)).toThrow('no longer active');
    expect(()=>f.authorize(start+600_000)).toThrow('first-login authorization expired');
    const first=f.attempt();
    first.record('connected');
    first.record('ready');
    first.record('ended','logged-out');
    expect(f.authorize(start+700_000)).toBe(f.tokenRef.sha256);
    f.file(f.hiscores.path,{takenAt:start+700_000});
    expect(f.authorize(start+700_001)).toBe(f.tokenRef.sha256);
    expect(()=>f.authorize(start+900_000)).toThrow('expired');
    expect(()=>f.authorize(start+700_000,{WORKER_RELEASE:'b'.repeat(64)})).toThrow('mismatched');
    expect(()=>f.authorize(start+700_000,{SWARM_MISSION_HASH:'b'.repeat(64)})).toThrow('mismatched');
    expect(()=>f.authorize(start+700_000,{COORDINATOR_RUN_ID:'other-run'})).toThrow('mismatched');
    expect(()=>f.authorize(start+700_000,{},()=>false)).toThrow('no longer active');
    f.file(f.runDir+'/receipt.json',{runId});
    expect(()=>f.authorize(start+700_000)).toThrow('no longer active');
}));

test('a late older logout cannot clear a newer attempt or a lost connection',()=>withFixture(f=>{
    const {start}=f;
    const first=f.attempt();
    first.record('ready');
    first.record('ended','logged-out');
    const newer=f.attempt();
    first.record('closed');
    expect(()=>f.authorize(start+710_000)).toThrow('confirmed server logout');
    newer.record('ready');
    newer.record('ended','disconnected');
    newer.record('closed');
    expect(()=>f.authorize(start+710_000)).toThrow('confirmed server logout');
}));

test('a logout needs the exact original ticket and proof of readiness',()=>withFixture(f=>{
    const {start}=f;
    const attempt=f.attempt();
    attempt.record('ended','logged-out');
    attempt.record('ready');
    expect(()=>f.authorize(start+710_000)).toThrow('another attempt or mission');
    const changed=f.attempt({ticket:'c'.repeat(64),mission:f.token.mission});
    changed.record('ready');
    changed.record('ended','logged-out');
    expect(()=>f.authorize(start+710_000)).toThrow('another attempt or mission');
}));

test('owner pause, disabled job and terminal result refuse an otherwise valid relog',()=>withFixture(f=>{
    const {start}=f;
    const first=f.attempt();
    first.record('ready');
    first.record('ended','logged-out');
    const resume=()=>f.authorize(start+710_000);
    expect(resume()).toBe(f.tokenRef.sha256);
    f.jobs(false);
    expect(resume).toThrow('mission is no longer active');
    f.jobs(true);
    f.file('.practice/status/Shaftshooter.json',{server,coordinatorRunId:runId,result:'ok 99'});
    expect(resume).toThrow('terminal result');
    f.file('.practice/stop-Shaftshooter','owner pause');
    expect(resume).toThrow('owner paused');
}));

test('a first attempt outside the ten-minute ticket cannot create continuation authority',()=>withFixture(f=>{
    const late=f.attempt();
    late.record('ready');
    late.record('ended','logged-out');
    expect(()=>f.authorize(f.start+710_000)).toThrow('no attempt from the first-login window');
},Date.now()-700_000));
