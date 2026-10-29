import {expect,test} from 'bun:test';
import {FLEET,toPlan,writeFleetPlan} from './fleet';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('fleet templates cannot replace current decisions; candidate export remains available',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-write-')),live=join(dir,'swarm.json'),candidate=join(dir,'candidate.json'),plan=toPlan([]);
 writeFleetPlan(live,plan,live);writeFileSync(live,'current decisions');
 expect(()=>writeFleetPlan(live,plan,live)).toThrow();expect(readFileSync(live,'utf8')).toBe('current decisions');
 writeFleetPlan(candidate,plan,live);expect(JSON.parse(readFileSync(candidate,'utf8'))).toEqual(plan);
});

test('grouping keeps the first member priority instead of letting later single jobs fill RAM first',()=>{
    const lead=FLEET.find(a=>a.name==='Pocketrocket')!,later=FLEET.find(a=>a.name==='Masterbaiter')!;
    const farmers=FLEET.filter(a=>a.hostGroup==='knights');
    const plan=toPlan([lead,farmers[0]!,later,farmers[1]!]);
    expect(plan.jobs.map(j=>j.host?j.accounts:j.account)).toEqual([lead.name,[farmers[0]!.name,farmers[1]!.name],later.name]);
});

test('the generated courier plan and both cook rendezvous settings share the same supply contract',()=>{
    const plan=toPlan(FLEET),courier=plan.jobs.find(j=>j.account==='Bigpackage')!;
    expect(courier.foodSourceAccounts).toEqual(['Masterbaiter','FishAndChips']);
    expect(courier.env?.FROM?.split(',')).toEqual(courier.foodSourceAccounts);
    const funder=plan.jobs.find(j=>j.account===courier.env?.FUND_FROM)!;
    expect(funder.enabled).toBe(true);
    expect(funder.env?.FUND_COURIER).toBe(courier.account);
    expect(plan.jobs.filter(j=>j.env?.FUND_COURIER)).toHaveLength(1);
    for(const name of courier.foodSourceAccounts!){
        const cook=plan.jobs.find(j=>j.account===name)!;
        expect(cook.enabled).toBe(true);
        expect(cook.env?.GIVE_TO).toBe(courier.account);
        expect(cook.env?.TARGETED_COLLECTION).toBe('1');
    }
});
