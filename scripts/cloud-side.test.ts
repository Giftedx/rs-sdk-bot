import { describe, expect, test } from 'bun:test';
import { DEFAULT_WATCH_MINUTES, MAX_RESTARTS_PER_HOUR, daemonCommand, endStopWrites, mayRestart, newPlan, ownerStop, parseOptions, sessionPrompt } from './cloud-side';
import { SWARM_STOP, clearSwarmStop } from './swarm';
import * as cloudSide from './cloud-side';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('cloud side bootstrap', () => {
    test('recovery requires an explicit finite watch and manages only the owning swarm',()=>{
        expect(()=>parseOptions(['--side','cloud','--recover','scope.json'],{})).toThrow('explicit watch');
        expect(parseOptions(['--side','cloud','--recover','scope.json','--watch-minutes','15','--stop-at-end'],{}).recover).toBe('scope.json');
        expect(cloudSide.managedCommands(true,'cloud.json')).toEqual({swarm:['scripts/swarm.ts','cloud.json']});
        expect(cloudSide.managedCommands(false,'cloud.json',true)).toEqual({swarm:['scripts/swarm.ts','cloud.json']});
        expect(()=>parseOptions(['--side','cloud','--inspect','scope.json','--recover','scope.json','--watch-minutes','3','--stop-at-end'],{})).toThrow('one manifest');
        expect(cloudSide.managedCommands(false,'cloud.json')).toEqual({swarm:['scripts/swarm.ts','cloud.json'],'fleet-agent':['scripts/fleet-agent.ts']});
    });
    test('bounded shutdown cannot remove its fence while either owning controller is alive',()=>{
        expect(cloudSide.boundedStopSettled(false,false)).toBe(true);
        for(const [swarm,coordinator] of [[true,false],[false,true],[true,true]])expect(cloudSide.boundedStopSettled(swarm!,coordinator!)).toBe(false);
    });
    test('options: the side comes from the flag or FLEET_SIDE, never local', () => {
        expect(parseOptions([], { FLEET_SIDE: 'claude-cloud' })).toEqual({ side: 'claude-cloud', watchMinutes: DEFAULT_WATCH_MINUTES, capacity: 4, stopAtEnd: false, setupOnly: false });
        expect(parseOptions(['--side', 'cloud', '--watch-minutes', '50', '--stop-at-end', '--capacity', '8'], {})).toMatchObject({ side: 'cloud', watchMinutes: 50, capacity: 8, stopAtEnd: true });
        expect(() => parseOptions([], {})).toThrow('cloud fleet side');
        expect(() => parseOptions(['--side', 'local'], {})).toThrow('cloud fleet side');
        expect(() => parseOptions(['--side', 'cloud', '--watch-minutes', '0'], {})).toThrow('watch-minutes');
    });

    test('a healthy launched session runs the existing side command', () => {
        const claude = sessionPrompt('claude', 'claude-cloud');
        expect(claude).toContain('bun scripts/cloud-side.ts --side claude-cloud --watch-minutes 110');
        expect(claude).toContain('run_in_background');
        expect(claude).toContain('RESULT stop');
        const codex = sessionPrompt('codex', 'cloud');
        expect(codex).toContain('bun scripts/cloud-side.ts --side cloud --watch-minutes 50 --stop-at-end');
        expect(codex).not.toContain('run_in_background');
        // A cached image of an older commit, and a setup PATH that does not reach the agent, cannot stop it.
        expect(codex).toContain('git checkout -q --detach origin/master');
        expect(codex).toContain('/workspace/.tools/bun/node_modules/.bin');
        expect(() => sessionPrompt('claude', 'local')).toThrow();
    });

    test.each(['claude', 'codex'] as const)('a failed %s bootstrap permits bounded diagnosis and a checked repair', kind => {
        const prompt = sessionPrompt(kind, kind === 'codex' ? 'cloud' : 'claude-cloud');
        expect(prompt).toContain('On RESULT fail or a nonzero exit');
        expect(prompt).toContain('Read the exact .practice/cloud-side/');
        expect(prompt).toContain('run.log and the failed setup step');
        expect(prompt).toContain('Do not repeat a failed command unchanged');
        expect(prompt).toContain('existing setup repair and its focused check');
        expect(prompt).toContain('resume only the same cloud-side command');
        expect(prompt).toContain('fresh evidence, classify the SDK changes and verify a recovery copy');
        expect(prompt).toContain('owner pauses, account leases, protected clocks and host limits');
        expect(prompt).toContain('report the cause, evidence path and retained diagnostic');
        expect(prompt).toContain('no alternate bots or controllers, new accounts, protected logins, paid APIs or quota resets');
        expect(prompt).not.toContain('Do not read files or logs');
        expect(prompt).not.toContain('do not investigate failures');
    });

    test('a setup mismatch stays visible and retained when later output fills the tail', () => {
        const retained: string[] = [];
        const stdout = 'worktree-setup: submodule: present\nworktree-setup: SDK patch: MISMATCH: keep the existing vendor edits\n'
            + 'later install output\n'.repeat(1500) + 'worktree-setup: NOT ready\n';
        const result = cloudSide.worktreeSetupResult({ status: 1, stdout, stderr: '' }, line => retained.push(line), {});
        expect(result).toEqual({ ok: false, detail: 'exit=1; SDK patch: MISMATCH' });
        expect(retained).toHaveLength(1);
        expect(retained[0]).toContain('SDK patch: MISMATCH');
        expect(retained[0]).toContain('worktree-setup: NOT ready');
        expect(retained[0]).toContain('[truncated]');
        expect(retained[0]!.length).toBeLessThanOrEqual(8300);
    });

    test('retained setup diagnostics redact secrets while stdout names only failed steps', () => {
        const retained: string[] = [];
        const stdout = 'worktree-setup: SDK packages: FAILED: bun install\nFLEET_SEED=seed-value\nAuthorization: Bearer token-value\n';
        const stderr = 'https://user:password@registry.invalid/package GITHUB_TOKEN=another-token secret-from-env\n{"token":"json-token","password":"json-pass"}\n';
        const result = cloudSide.worktreeSetupResult({ status: 1, stdout, stderr }, line => retained.push(line), { FLEET_VAULT_KEY: 'secret-from-env' });
        expect(result).toEqual({ ok: false, detail: 'exit=1; SDK packages: FAILED' });
        for (const secret of ['seed-value', 'token-value', 'user:password', 'another-token', 'secret-from-env', 'json-token', 'json-pass']) {
            expect(retained.join('\n')).not.toContain(secret);
            expect(result.detail).not.toContain(secret);
        }
        expect(retained[0]).toContain('[redacted]');
    });

    test('an unclassified setup error retains its evidence and a healthy setup stays quiet', () => {
        const retained: string[] = [];
        const failed = cloudSide.worktreeSetupResult({ status: null, stdout: null, stderr: 'error: module missing' }, line => retained.push(line), {});
        expect(failed).toEqual({ ok: false, detail: 'exit=spawn-failed; failed step unknown; inspect retained setup output' });
        expect(retained[0]).toContain('error: module missing');
        expect(cloudSide.worktreeSetupResult({ status: 0, stdout: 'ready', stderr: '' }, line => retained.push(line), {})).toEqual({ ok: true, detail: '' });
        expect(retained[1]).toBe('$ bun tools/worktree-setup.ts -> 0');
    });

    test('daemons and restarts', () => {
        expect(daemonCommand('swarm', 'p.json')).toEqual(['scripts/swarm.ts', 'p.json']);
        expect(daemonCommand('fleet-agent', 'p.json')).toEqual(['scripts/fleet-agent.ts']);
        expect(cloudSide.daemonSpawnArgs(daemonCommand('swarm', 'p.json'), ['--nonce=n1'])).toEqual(['--smol', 'scripts/swarm.ts', 'p.json', '--nonce=n1']);
        const env = cloudSide.cloudSideEnv('cloud', false, {});
        expect(env.FLEET_SIDE).toBe('cloud');
        expect(env.DEMO_OK).toBe('1');
        expect(env.BUN_JSC_forceMiniVMMode).toBe('1');
        expect(env.BUN_JSC_useDFGJIT).toBe('0');
        const now = 10 * 60 * 60_000, recent = Array.from({ length: MAX_RESTARTS_PER_HOUR }, (_, i) => now - i * 60_000);
        expect(mayRestart(recent, now)).toBe(false);
        expect(mayRestart(recent.map(t => t - 60 * 60_000), now)).toBe(true);
        expect(newPlan(6)).toEqual({ maxBots: 4, minFreeGB: 4, fleetCapacity: 6, jobs: [] });
    });

    test('an owner\'s stop file holds the side and is never replaced at the end of a watch', () => {
        expect(ownerStop(undefined)).toBe(false);
        expect(ownerStop(SWARM_STOP.all)).toBe(false);
        expect(ownerStop('owner: pause for the quest')).toBe(true);
        expect(endStopWrites(undefined)).toBe(true);
        expect(endStopWrites(SWARM_STOP.all)).toBe(true);
        expect(endStopWrites('owner: pause for the quest')).toBe(false);
    });
    test('a watch with unknown normal owners reports failure even when it leaves daemons running',()=>{
        expect(cloudSide.watchResult({normalOwnershipError:'normal live owner command unknown'})).toBe('fail');
        expect(cloudSide.watchResult({normalOwnershipError:null})).toBe('ok');
        expect(cloudSide.watchResult({ownerStopped:true})).toBe('stop');
    });
});

const normalFixture=async(run:(base:string,write:(path:string,value:unknown)=>void)=>Promise<void>|void)=>{
    const base=mkdtempSync(join(tmpdir(),'cloud-normal-'));
    const write=(path:string,value:unknown)=>{const file=join(base,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
    try{await run(base,write);}finally{if(dirname(base)===tmpdir())rmSync(base,{recursive:true,force:true,maxRetries:5});}
};
describe('normal cloud swarm ownership',()=>{
    test('new plan setup initializes empty cloud plan under live lock without autopilot/coordinator keys',async()=>{
        await normalFixture(async(base)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json');
            await cloudSide.prepareNormalPlan(base,plan,4,'claude-cloud');
            const next=JSON.parse(readFileSync(plan,'utf8'));
            expect(next).toEqual({maxBots:4,minFreeGB:4,fleetCapacity:4,jobs:[]});
            expect(existsSync(join(base,'.practice/live/plan-write-lock.json'))).toBe(false);
        });
    });
    test('locked normal plan setup preserves existing owner jobs without legacy coordinator settings',async()=>{
        await normalFixture(async(base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json');
            const original={maxBots:7,minFreeGB:6,jobs:[{account:'Unsheathed',enabled:false,role:'inspect',repeat:false}],custom:{preserve:true}};
            write('.practice/cloud-handoff/swarm.json',original);
            await cloudSide.prepareNormalPlan(base,plan,4);
            expect(JSON.parse(readFileSync(plan,'utf8'))).toEqual(original);
            expect(existsSync(join(base,'.practice/live/plan-write-lock.json'))).toBe(false);
        });
    });
    test('normal plan setup preserves an owner pause and refuses a bounded-mode plan',async()=>{
        await normalFixture(async(base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json'),original={maxBots:4,minFreeGB:4,jobs:[]};
            write('.practice/cloud-handoff/swarm.json',original);write('.practice/stop-coordinator','owner: preserve this pause');
            await expect(cloudSide.prepareNormalPlan(base,plan,4)).rejects.toThrow('paused');
            expect(readFileSync(join(base,'.practice/stop-coordinator'),'utf8')).toBe('owner: preserve this pause');
            expect(JSON.parse(readFileSync(plan,'utf8'))).toEqual(original);
        });
        await normalFixture(async(base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json'),original={maxBots:4,minFreeGB:4,jobs:[]};
            write('.practice/cloud-handoff/swarm.json',original);write('.practice/stop-swarm','owner: keep stopped');
            await expect(cloudSide.prepareNormalPlan(base,plan,4)).rejects.toThrow('paused');
            expect(JSON.parse(readFileSync(plan,'utf8'))).toEqual(original);
        });
        await normalFixture(async(base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json'),original={maxBots:4,minFreeGB:4,jobs:[],boundedRecovery:{targets:[]}};
            write('.practice/cloud-handoff/swarm.json',original);
            await expect(cloudSide.prepareNormalPlan(base,plan,4)).rejects.toThrow('bounded');
            expect(JSON.parse(readFileSync(plan,'utf8'))).toEqual(original);
        });
    });
    test('normal watcher adopts an exact live swarm owner and its reload successor instead of launching another',async()=>{
        await normalFixture((base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json');
            write('.practice/live/swarm-owner.json',{pid:11,nonce:'old-owner',at:100,plan:resolve(plan),side:'cloud',successor:{pid:12,nonce:'reload-owner'}});
            const view=cloudSide.observeNormalOwners(base,plan,'cloud',{}, {alive:pid=>[11,12].includes(pid),command:pid=>`${join(base,'scripts/swarm.ts')} ${plan} --nonce ${pid===11?'old-owner':'reload-owner'}`,groups:()=>[],processes:()=>[11,12]});
            expect(view.known).toBe(true);expect(view.swarm).toBe(12);expect(view.settled).toBe(false);
        });
    });
    test('a live unowned standalone swarm refuses normal migration without taking it over',async()=>{
        await normalFixture((base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json');write('.practice/swarm-state.json',{controllerPid:44});
            const view=cloudSide.observeNormalOwners(base,plan,'cloud',{swarm:{pid:44,started:1,restarts:[]}},{alive:pid=>pid===44,command:()=>`${join(base,'scripts/swarm.ts')} ${plan}`,groups:()=>[],processes:()=>[44]});
            expect(view.known).toBe(false);expect(view.settled).toBe(false);expect(view.reason).toContain('unowned swarm');
        });
    });
    test('normal drain tracks swarm runs, fleet-agent and child groups while keeping unresolved build locks fenced',async()=>{
        await normalFixture((base,write)=>{
            const plan=join(base,'.practice/cloud-handoff/swarm.json');
            write('.practice/live/swarm-owner.json',{pid:11,nonce:'owner',at:100,plan:resolve(plan),side:'cloud'});
            write('.practice/swarm-runs.json',[{pid:21,accounts:['Unsheathed']}]);
            const dependencies={alive:(pid:number)=>pid===21,command:()=>null,groups:()=>[22],processes:()=>[]};
            const live=cloudSide.observeNormalOwners(base,plan,'cloud',{},dependencies);
            expect(live.known).toBe(true);expect(live.settled).toBe(false);expect(live.active).toContain(21);expect(live.active).toContain(22);
            const drained=cloudSide.observeNormalOwners(base,plan,'cloud',{}, {alive:()=>false,command:()=>null,groups:()=>[],processes:()=>[]});
            expect(drained.known).toBe(true);expect(drained.settled).toBe(true);
            write('.practice/live/build-lock.json',{holder:'other'});
            const locked=cloudSide.observeNormalOwners(base,plan,'cloud',{}, {alive:()=>false,command:()=>null,groups:()=>[],processes:()=>[]});
            expect(locked.known).toBe(false);expect(locked.settled).toBe(false);
            expect(cloudSide.watchResult({normalOwnershipError:locked.reason})).toBe('fail');
        });
    });
    test('watch shutdown preserves an existing owner fleet pause',async()=>{
        await normalFixture(async(base,write)=>{
            write('.practice/stop-FullLoad','owner: keep this account paused');
            expect(await cloudSide.prepareNormalStop(base)).toBe(true);
            expect(readFileSync(join(base,'.practice/stop-FullLoad'),'utf8')).toBe('owner: keep this account paused');
            expect(readFileSync(join(base,'.practice/stop-swarm'),'utf8')).toBe(SWARM_STOP.all);
            write('.practice/stop-swarm','owner: preserve whole fleet pause');
            expect(await cloudSide.prepareNormalStop(base)).toBe(false);
            expect(readFileSync(join(base,'.practice/stop-swarm'),'utf8')).toBe('owner: preserve whole fleet pause');
        });
    });
    test('two system watch drains leave resumable stops while owner pauses remain owner pauses',async()=>{
        await normalFixture(async(base,write)=>{
            write('.practice/stop-FullLoad','owner: account stays paused');
            for(let cycle=0;cycle<2;cycle++){
                expect(await cloudSide.prepareNormalStop(base)).toBe(true);
                expect(readFileSync(join(base,'.practice/stop-swarm'),'utf8')).toBe(SWARM_STOP.all);
                write('.practice/stop-Unsheathed',SWARM_STOP.all);
                expect(clearSwarmStop(join(base,'.practice/stop-Unsheathed'))).toBe(true);
                expect(clearSwarmStop(join(base,'.practice/stop-swarm'))).toBe(true);
                expect(readFileSync(join(base,'.practice/stop-FullLoad'),'utf8')).toBe('owner: account stays paused');
            }
            write('.practice/stop-Unsheathed','owner: hold Unsheathed');
            expect(clearSwarmStop(join(base,'.practice/stop-Unsheathed'))).toBe(false);
            expect(readFileSync(join(base,'.practice/stop-Unsheathed'),'utf8')).toBe('owner: hold Unsheathed');
        });
    });
});
