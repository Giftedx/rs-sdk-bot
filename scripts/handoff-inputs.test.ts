import { expect, test } from 'bun:test';
import { handoffCommands, parseHandoff, runHandoff, type HandoffChild, type HandoffDeps } from './handoff-inputs';

function fixture(mode='ok') {
    const c=parseHandoff(['Pocketrocket','Ballspinner','153:Flax','--notes','--keep=knife|trout|salmon','--bank-x=2725','--bank-z=3493','--request-ms=1000','--timeout-ms=2000','--grace-ms=1000']);
    let now=1000, request:any=mode==='stale'?{at:100,items:c.items}:undefined;
    const events:string[]=[], stops:string[]=[], children=new Map<string,{code:number|null;text:string}>();
    let started=0, transferAt=0;
    const d:HandoffDeps={server:'localhost:8888',owned:new Set(['pocketrocket','ballspinner']),now:()=>now,
        pause:async ms=>{
            now+=ms;
            if(children.has('receiver')&&!request&&mode!=='missing'&&mode!=='early') request={at:now,items:mode==='wrong'?[{name:'Flax',count:152}]:c.items};
            if(mode==='early'&&children.has('receiver'))children.get('receiver')!.code=1;
            if(transferAt&&now-transferAt>=400&&mode!=='timeout') {
                children.set('receiver',{code:0,text:`START 2725 3493 0\nRESULT ok got ${mode==='zero'?'0':'153'} Flax`});
                children.set('donor',{code:0,text:'START 2725 3493 0\nMILESTONE paid Ballspinner 153 Flax\nRESULT ok waiting offline for owned cargo trades=0'});
            }
            for(const name of stops) {const role=name==='Ballspinner'?'receiver':'donor';const p=children.get(role);if(p)p.code=1;}
        },
        status:name=>({name,server:'localhost:8888',at:now,started:mode==='old-session'?1:started,
            result:!children.has('receiver')||name==='Pocketrocket'?(mode==='active'?'':'ok old'):'',pos:{x:2725,z:3493,level:0}}),
        request:()=>request,otherRequests:()=>mode==='other'?['Other.json']:[],stopped:()=>false,
        spawn:role=>{events.push(role);if(role==='receiver')started=now;else{expect(request?.items).toEqual(c.items);expect(request.at).toBeGreaterThanOrEqual(started);transferAt=now;}
            const p={code:role==='donor'&&mode==='early-donor'?0:null,text:role==='donor'&&mode==='early-donor'?'RESULT ok waiting offline for owned cargo':'START 2725 3493 0'} as {code:number|null;text:string};children.set(role,p);
            return {code:()=>children.get(role)!.code,output:()=>children.get(role)!.text} satisfies HandoffChild;},
        stop:name=>{stops.push(name);events.push('stop:'+name);}
    };
    return{c,d,events,stops};
}
test('one receiver starts, fresh authenticated exact request then starts donor; exact receipt and payout required',async()=>{
    const f=fixture();const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(true);expect(r.phase).toBe('done');expect(f.events).toEqual(['receiver','donor']);expect(f.stops).toEqual([]);
});
test('unowned, fresh active and preexisting stop accounts never launch or stop a child',async()=>{
    const f=fixture();f.d.owned=new Set(['ballspinner']);expect((await runHandoff(f.c,f.d)).reason).toContain('not authenticated');expect(f.events).toEqual([]);
    const g=fixture('active');expect((await runHandoff(g.c,g.d)).reason).toContain('account active');expect(g.events).toEqual([]);
    const h=fixture();h.d.stopped=()=>true;expect((await runHandoff(h.c,h.d)).reason).toContain('existing stop');expect(h.events).toEqual([]);
});
test('stale or wrong requests cannot start donor, and cleanup only stops this receiver',async()=>{
    for(const mode of ['stale','wrong','missing','old-session']){const f=fixture(mode);const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(f.events.filter(e=>e==='donor')).toEqual([]);expect(f.stops).toEqual(['Ballspinner']);expect(r.cleanupPending).toEqual([]);}
});
test('early receiver exit and malformed request terminate without donor or login retries',async()=>{
    const f=fixture('early');expect((await runHandoff(f.c,f.d)).reason).toContain('receiver exited before donor');expect(f.events).toEqual(['receiver']);
    const g=fixture();let read=0;g.d.request=()=>{if(++read>1)throw new Error('malformed JSON');return undefined;};
    expect((await runHandoff(g.c,g.d)).reason).toContain('malformed');expect(g.events).toEqual(['receiver','stop:Ballspinner']);
});
test('bounded transfer timeout gracefully stops both own children once; no retry',async()=>{
    const f=fixture('timeout');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('handoff timeout');expect(f.events.slice(0,2)).toEqual(['receiver','donor']);expect(f.stops).toEqual(['Ballspinner','Pocketrocket']);expect(r.cleanupPending).toEqual([]);
});
test('successful exits alone cannot claim actual exact transfer',async()=>{
    const f=fixture('zero');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('exact receipt not proved');
});
test('another pending payout never launches children; donor becoming active during receiver startup is preserved',async()=>{
    const f=fixture('other');expect((await runHandoff(f.c,f.d)).reason).toContain('other payout');expect(f.events).toEqual([]);
    const g=fixture();const status=g.d.status;g.d.status=n=>{const s=status(n);if(g.events.length&&n==='Pocketrocket')s.result='';return s;};
    expect((await runHandoff(g.c,g.d)).reason).toContain('became active');expect(g.events).toEqual(['receiver','stop:Ballspinner']);
});
test('CLI validates bounds, protected overlap and structured arguments without shell expansion',()=>{
    const c=parseHandoff(['Pocketrocket','Ballspinner','153:Flax','--notes','--keep=knife|bread','--bank-x=2725','--bank-z=3493']);
    const cmd=handoffCommands(c,'F:/repo');expect(cmd.receiver.slice(-3)).toEqual(['Ballspinner','153:Flax','--banker=Pocketrocket']);expect(cmd.env).toMatchObject({PAYOUT_NOTES:'1',ON_DEMAND:'1',COURIERS:'',KEEP:'knife|bread',BANK_X:'2725'});
    for(const args of [['Main','Ballspinner','1:Flax'],['Pocketrocket','Pocketrocket','1:Flax'],['../x','Ballspinner','1:Flax'],['Pocketrocket','Ballspinner','0:Flax'],['Pocketrocket','Ballspinner','1:Flax','--keep=flax'],['Pocketrocket','Ballspinner','1:Flax','--bank-x=NaN'],['Pocketrocket','Ballspinner','1:Flax','--whatever=1']])expect(()=>parseHandoff(args)).toThrow();
});
test('fresh file cannot authenticate an unrelated session or future timestamp',async()=>{
    const f=fixture();const spawn=f.d.spawn;f.d.spawn=role=>({...spawn(role),goal:'my child'});
    expect((await runHandoff(f.c,f.d)).ok).toBe(false);expect(f.events.includes('donor')).toBe(false);
    const g=fixture();g.d.request=()=>({at:999_999,items:g.c.items});
    expect((await runHandoff(g.c,g.d)).ok).toBe(false);expect(g.events.includes('donor')).toBe(false);
});
test('failed graceful cleanup remains an explicit failure, and never retries or deletes state',async()=>{
    const f=fixture('missing');f.d.stop=()=>{throw new Error('different job active; refuse stop');};
    const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('stop failed');expect(r.cleanupPending).toEqual(['Ballspinner']);expect(f.events).toEqual(['receiver']);
});
test('donor exiting cleanly without payout stops the receiver at once instead of burning its wait',async()=>{
    const f=fixture('early-donor');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('donor exited without exact payout');expect(f.stops).toEqual(['Ballspinner']);expect(r.elapsedMs).toBeLessThan(f.c.timeoutMs);
});
