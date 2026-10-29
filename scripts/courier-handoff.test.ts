import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandoff, awaitCollectionOffer, collectHandoff, handoffCreditMatches, receiveHandoff, sendHandoff } from './courier-handoff';

for(const mode of ['new','legacy','stale','foreign','settled']) test(`collection preflight ${mode}`,async()=>{
    const root=mkdtempSync(join(tmpdir(),'offer-test-'));let tick=0,trades=0;
    const callbacks=new Set<()=>void>();
    const s:any={name:'Courier',tick:()=>tick,sdk:{getState:()=>({})},onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}};
    const timer=setInterval(()=>{tick++;if(tick===2&&mode!=='legacy')writeFileSync(join(root,'cook-courier.json'),JSON.stringify({token:'new',from:'Cook',to:'Courier',server:mode==='foreign'?'other':'practice',at:Date.now()-(mode==='stale'?130000:0),state:mode==='settled'?'settled':'prepared',expected:[{id:334,count:10}]}));for(const cb of [...callbacks])cb();},1);
    try{
        const run=awaitCollectionOffer(s,'Cook','practice',10,root).then(()=>{trades++;});
        if(mode==='new')await run;else await expect(run).rejects.toThrow('no trade accepted');
        expect(trades).toBe(mode==='new'?1:0);expect(tick).toBeLessThanOrEqual(11);
    }finally{clearInterval(timer);rmSync(root,{recursive:true,force:true});}
},2000);

const request = {token:'one',from:'Courier',to:'Farmer',server:'practice',at:100,state:'prepared' as const,expected:[{id:334,count:10}]};
const credit = {...request,at:120,before:[{id:334,count:5}],after:[{id:334,count:15}]};
const before=[{id:334,count:30}],after=[{id:334,count:20}];
test('handoff requires exact item deltas, identity, token, server and time on both sides',()=>{
    expect(handoffCreditMatches(request,credit,before,after,130)).toBe(true);
    for(const bad of [null,{...credit,token:'old'},{...credit,to:'Other'},{...credit,from:'Other'},
        {...credit,server:'live'},{...credit,at:99},{...credit,at:131},{...credit,after:credit.before},
        {...credit,after:[{id:330,count:15}]},{...credit,after:[{id:334,count:16}]},
        {...credit,before:undefined}]) expect(handoffCreditMatches(request,bad,before,after,130)).toBe(false);
    expect(handoffCreditMatches(request,credit,before,before,130)).toBe(false);
    expect(handoffCreditMatches(request,credit,before,[{id:334,count:21}],130)).toBe(false);
    expect(handoffCreditMatches(request,credit,before,after,120101)).toBe(false);
});

for(const mode of ['match','no-cook-debit','short-credit','lost-reply','no-transfer']) test(`cook collection ${mode}`,async()=>{
    const root=mkdtempSync(join(tmpdir(),'collection-test-'));
    let cook=20,courier=7,feathers=100,tick=0;
    const listeners=new Set<()=>void>();
    const session=(name:string,inventory:()=>any[])=>({name,tick:()=>tick,sdk:{getInventory:inventory,getState:()=>({})},
        onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as any);
    const c=session('Cook',()=>[{id:334,count:cook},{id:330,count:4}]);
    const r=session('Courier',()=>[{id:334,count:courier},{id:330,count:2},{id:314,count:feathers}]);
    let release!:()=>void;
    const signal=new Promise<void>(resolve=>release=resolve);
    const capture=<T>(p:Promise<T>)=>p.then(value=>({value}),error=>({error:String(error)}));
    try{
        const collected=capture(collectHandoff(r,'Cook','practice',async()=>{await signal;return {success:true};},root));
        if(mode==='no-transfer'){
            release();expect(await collected).toEqual({value:{result:{success:true},received:0}});
            return;
        }
        const sent=capture(sendHandoff(c,'Courier','practice',[{id:334,count:10}],async()=>{
            if(mode!=='no-cook-debit')cook-=10;
            courier+=mode==='short-credit'?9:10;feathers=0;release();
            if(mode==='lost-reply')throw Error('lost reply');
        },root));
        for(let i=0;i<70;i++){await Promise.resolve();tick++;for(const cb of [...listeners])cb();}
        const [sendResult,collectResult]=await Promise.all([sent,collected]);
        if(mode==='match'||mode==='lost-reply'){
            expect(sendResult).toEqual({value:10});
            expect(collectResult).toEqual({value:{result:{success:true},received:10}});
        }else{
            expect('error' in sendResult).toBe(true);expect('error' in collectResult).toBe(true);
            expect(JSON.parse(readFileSync(join(root,'cook-courier.json'),'utf8')).state).toBe('prepared');
        }
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('an old cook without a handoff record cannot turn a courier pack gain into verified collection',async()=>{
    const root=mkdtempSync(join(tmpdir(),'collection-legacy-test-'));
    let held=7;
    const s:any={name:'Courier',sdk:{getInventory:()=>[{id:334,count:held}]}};
    try{
        await expect(collectHandoff(s,'Cook','practice',async()=>{held+=10;return {success:true};},root)).rejects.toThrow('credit unbound');
    }finally{rmSync(root,{recursive:true,force:true});}
});

for(const mode of ['match','missing','mismatch','lost-reply']) test(`handoff orchestration ${mode}`,async()=>{
    const root=mkdtempSync(join(tmpdir(),'handoff-test-'));
    let sender=30,recipient=5,calls=0,tick=0;
    const listeners=new Set<()=>void>();
    const s:any={name:'Courier',tick:()=>tick,sdk:{getInventory:()=>[{id:334,count:sender}],getState:()=>({})},onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}};
    const r:any={name:'Farmer',sdk:{getInventory:()=>[{id:334,count:recipient}]}};
    try {
        const run=sendHandoff(s,'Farmer','practice',[{id:334,count:10}],async()=>{
            calls++;
            if(mode==='missing'){sender-=10;return;}
            await receiveHandoff(r,'Courier','practice',async()=>{sender-=10;recipient+=mode==='mismatch'?9:10;return {success:true};},root);
            recipient=0; // Refill already banked the notes; durable credit must survive.
            if(mode==='lost-reply')throw Error('lost reply');
        },root).then(value=>({value}),error=>({error:String(error)}));
        for(let i=0;i<40;i++){await Promise.resolve();tick++;for(const cb of [...listeners])cb();}
        const result=await run,record=JSON.parse(readFileSync(join(root,'courier-farmer.json'),'utf8'));
        if(mode==='match'||mode==='lost-reply'){
            expect(result).toEqual({value:10});expect(record.state).toBe('settled');
        }else{
            expect('error' in result).toBe(true);expect(record.state).toBe('prepared');
            await expect(sendHandoff(s,'Farmer','practice',[{id:334,count:10}],async()=>{calls++;},root)).rejects.toThrow('unresolved');
        }
        expect(calls).toBe(1);
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('item policy is separate from food and rejects mixed unknown expected IDs',()=>{
 const iron=createHandoff([40],join(tmpdir(),'iron-policy-test'));
 const r={...request,expected:[{id:40,count:10}]},c={...credit,before:[],after:[{id:40,count:10}]};
 expect(iron.handoffCreditMatches(r,c,[{id:40,count:10}],[],130)).toBe(true);
 expect(handoffCreditMatches(r,c,[{id:40,count:10}],[],130)).toBe(false);
 expect(iron.handoffCreditMatches({...r,expected:[...r.expected,{id:334,count:1}]},c,[{id:40,count:10}],[],130)).toBe(false);
 expect(handoffCreditMatches({...request,expected:[...request.expected,{id:40,count:1}]},credit,before,after,130)).toBe(false);
 const ids=[40];const frozen=createHandoff(ids,join(tmpdir(),'iron-policy-copy'));ids.push(334);
 expect(frozen.handoffCounts([{id:334,count:10}])).toEqual([]);
});
test('nonfood policy cannot use the food receipt namespace or an invalid policy',()=>{
 expect(()=>createHandoff([40],process.cwd()+'/.practice/courier-handoffs')).toThrow();
 for(const ids of [[],[40,40],[0],[-1],[1.5]])expect(()=>createHandoff(ids,join(tmpdir(),'invalid-policy'))).toThrow();
});

{const {receiveHandoff,sendHandoff}=createHandoff([40],join(tmpdir(),'iron-orchestration'));
for(const mode of ['match','missing','mismatch','lost-reply']) test(`iron handoff orchestration ${mode}`,async()=>{
    const root=mkdtempSync(join(tmpdir(),'handoff-test-'));
    let sender=30,recipient=5,calls=0,tick=0;
    const listeners=new Set<()=>void>();
    const s:any={name:'Courier',tick:()=>tick,sdk:{getInventory:()=>[{id:40,count:sender}],getState:()=>({})},onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);}};
    const r:any={name:'Farmer',sdk:{getInventory:()=>[{id:40,count:recipient}]}};
    try {
        const run=sendHandoff(s,'Farmer','practice',[{id:40,count:10}],async()=>{
            calls++;
            if(mode==='missing'){sender-=10;return;}
            await receiveHandoff(r,'Courier','practice',async()=>{sender-=10;recipient+=mode==='mismatch'?9:10;return {success:true};},root);
            recipient=0; // Refill already banked the notes; durable credit must survive.
            if(mode==='lost-reply')throw Error('lost reply');
        },root).then(value=>({value}),error=>({error:String(error)}));
        for(let i=0;i<40;i++){await Promise.resolve();tick++;for(const cb of [...listeners])cb();}
        const result=await run,record=JSON.parse(readFileSync(join(root,'courier-farmer.json'),'utf8'));
        if(mode==='match'||mode==='lost-reply'){
            expect(result).toEqual({value:10});expect(record.state).toBe('settled');
        }else{
            expect('error' in result).toBe(true);expect(record.state).toBe('prepared');
            await expect(sendHandoff(s,'Farmer','practice',[{id:40,count:10}],async()=>{calls++;},root)).rejects.toThrow('unresolved');
        }
        expect(calls).toBe(1);
    }finally{rmSync(root,{recursive:true,force:true});}
});


}
