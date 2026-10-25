import {test,expect} from 'bun:test';
import {courierCargo, courierDeliveryWaiting, retainedTrout, separateTroutNotes, type SeparationDeps} from './courier-cargo';
import {supervise} from '../packages/practice/src/supervise';

const trout=(count:number)=>({id:333,name:'Trout',count});
function separationFixture(options:{food?:number;failDeposit?:boolean;failTrade?:boolean;failRestore?:boolean;bankReady?:boolean}={}) {
    let food=options.food??2,notes=100,bank=7,traded=0;const calls:string[]=[];
    const deps:SeparationDeps={
        inventory:()=>[{id:333,name:'Trout',count:food,slot:0},{id:334,name:'Trout',count:notes,slot:2}].filter(i=>i.count>0),
        bank:()=>options.bankReady===false?null:[{id:333,name:'Trout',count:bank,slot:5}],
        openBank:async()=>{calls.push('open');return options.bankReady!==false;},closeBank:async()=>{calls.push('close');return true;},
        deposit:async item=>{calls.push(`deposit:${item.id}`);if(options.failDeposit){food--;bank++;return false;}bank+=food;food=0;return true;},
        withdraw:async(item,n)=>{calls.push(`withdraw:${item.id}:${n}`);if(options.failRestore)return false;food+=n;bank-=n;return true;},
        tradeNotes:async n=>{calls.push(`trade:${n}`);if(options.failTrade)return {success:false,given:0};notes-=n;traded+=n;return {success:true,given:n};},
        observed:async pred=>pred(),
    };
    return {deps,calls,state:()=>({food,notes,bank,traded})};
}
test('exact-ID separation transfers100notes and restores2workingfoods without consuming bank stock',async()=>{
    const f=separationFixture();expect(await separateTroutNotes(f.deps)).toBe(100);
    expect(f.state()).toEqual({food:2,notes:0,bank:7,traded:100});
    expect(f.calls).toEqual(['open','deposit:333','close','trade:100','open','withdraw:333:2','close']);
});
test('separation restores surplus unnoted food too, leaving exact surplus for the next normal offer',async()=>{
    const f=separationFixture({food:5});expect(await separateTroutNotes(f.deps)).toBe(100);
    expect(f.state()).toEqual({food:5,notes:0,bank:7,traded:100});
    expect(courierCargo(f.deps.inventory(),2)).toEqual({items:[{name:'Trout',count:3}],blocked:[]});
});
test('separation restores working food after partial deposit or failed trade and blocks once',async()=>{
    for(const options of [{failDeposit:true},{failTrade:true}]){
        const f=separationFixture(options);
        await expect(separateTroutNotes(f.deps)).rejects.toThrow('no delivery progress');
        expect(f.state()).toEqual({food:2,notes:100,bank:7,traded:0});
        if(options.failDeposit)expect(f.calls.some(c=>c.startsWith('trade:'))).toBe(false);
    }
});
test('unknown bank readiness never trades; failed restoration reports protected stock still banked',async()=>{
    const unknown=separationFixture({bankReady:false});
    await expect(separateTroutNotes(unknown.deps)).rejects.toThrow('no delivery progress');
    expect(unknown.state()).toEqual({food:2,notes:100,bank:7,traded:0});
    const failed=separationFixture({failRestore:true});
    await expect(separateTroutNotes(failed.deps)).rejects.toThrow('restore');
    expect(failed.state()).toEqual({food:0,notes:0,bank:9,traded:100});
});
test('retained two working Trout neither wake banker nor appear in final offer',()=>{
    const inv=[trout(1),trout(1),{id:995,name:'Coins',count:100}];
    expect(courierCargo(inv,2)).toEqual({items:[],blocked:[]});
    const now=1000,job={account:'Bigpackage',script:'scripts/note-courier.ts',env:{}};
    const status={at:now,result:'',goal:'note-courier.ts',pos:{x:2654,z:3283,level:0},inventory:inv};
    expect(courierDeliveryWaiting(['Bigpackage'],{x:2654,z:3283,radius:50},[job],()=>status,now)).toBe(false);
});
test('surplus unnoted food and existing flax cargo retain exact offer counts',()=>{
    const inv=[trout(5),{id:1779,name:'Flax',count:81}];
    expect(courierCargo(inv,2)).toEqual({items:[{name:'Trout',count:3},{name:'Flax',count:81}],blocked:[]});
    const status={at:1000,result:'',goal:'note-courier.ts',inventory:inv};
    expect(courierDeliveryWaiting(['Bigpackage'],undefined,[{account:'Bigpackage',script:'scripts/note-courier.ts'}],()=>status,1000)).toBe(true);
});
test('mixed same-name notes and working food are not advertised for unsafe name-based trade',()=>{
    const inv=[trout(2),{id:334,name:'Trout',count:100}];
    expect(courierCargo(inv,2)).toEqual({items:[],blocked:['Trout: need-bank-separation']});
    expect(courierCargo([{id:334,name:'Trout',count:100}],2)).toEqual({items:[{name:'Trout',count:100}],blocked:[]});
    const status={at:1000,result:'',goal:'note-courier.ts',inventory:inv};
    expect(courierDeliveryWaiting(['Bigpackage'],undefined,[{account:'Bigpackage',script:'scripts/note-courier.ts'}],()=>status,1000)).toBe(false);
});
test('ambiguous retained food exits into one supervisor block rather than a login or idle loop',async()=>{
    const inventory=[trout(2),{id:334,name:'Trout',count:100}],before=JSON.stringify(inventory);
    const cargo=courierCargo(inventory,2);let runs=0;
    const end=await supervise({run:async()=>{runs++;return {stdout:`RESULT fail Error: no delivery progress: ${cargo.blocked.join(', ')}`,exitCode:1};},
        stopped:()=>false,pause:async()=>{throw new Error('must not retry unsafe trade');},maxRestarts:20});
    expect(end).toEqual({reason:'blocked',runs:1});expect(runs).toBe(1);
    expect(JSON.stringify(inventory)).toBe(before);
});
test('general/unconfigured food deliveries remain unchanged; invalid courier policy stays unknown',()=>{
    const status={at:1000,result:'',inventory:[trout(2)]};
    for(const jobs of [[],[{account:'Food',script:'scripts/foodcourier.ts'}]])
        expect(courierDeliveryWaiting(['Food'],undefined,jobs,()=>status,1000)).toBe(true);
    expect(retainedTrout({RETAIN_TROUT:'0'})).toBe(0);
    for(const value of ['-1','2.5','bad','']) expect(()=>retainedTrout({RETAIN_TROUT:value})).toThrow('RETAIN_TROUT');
    expect(courierDeliveryWaiting(['Food'],undefined,[{account:'Food',script:'scripts/note-courier.ts',env:{RETAIN_TROUT:'bad'}}],()=>({...status,goal:'note-courier.ts'}),1000)).toBe(false);
    expect(courierDeliveryWaiting(['Food'],undefined,[],()=>({...status,result:'ok done'}),1000)).toBe(false);
});

test('repurposed Bigpackage outbound stock is not inbound demand from its disabled old courier job',()=>{
    const now=1792872816000,near={x:2654,z:3283,radius:50};
    const job={account:'Bigpackage',script:'scripts/note-courier.ts',goal:'Collect advertised cargo; deliver only to owned banker',enabled:false,env:{CAP:'15000'}};
    const status={name:'Bigpackage',server:'rs-sdk-demo.fly.dev',at:now,result:'',goal:'foodcourier.ts',pos:{x:2655,z:3283,level:0},
        inventory:[{id:1778,name:'Bow string',count:500},trout(1),trout(1)]};
    expect(courierDeliveryWaiting(['Bigpackage'],near,[job],()=>status,now)).toBe(false);
});
test('an explicit outbound-only food courier never advertises its supplies to the banker',()=>{
    const now=1000,status={at:now,result:'',goal:'foodcourier.ts',pos:{x:2654,z:3283,level:0},inventory:[{id:1778,name:'Bow string',count:500},trout(2)]};
    expect(courierDeliveryWaiting(['Bigpackage'],{x:2654,z:3283,radius:50},[{account:'Bigpackage',script:'scripts/foodcourier.ts',env:{OUTBOUND_ONLY:'1'}}],()=>status,now)).toBe(false);
});
test('matching incoming courier still wakes, including manual runs with the plan disabled',()=>{
    const now=1000,near={x:2654,z:3283,radius:50},job={account:'Bigpackage',script:'scripts/note-courier.ts',goal:'Collect advertised cargo; deliver only to owned banker',enabled:false,env:{}};
    const status={at:now,result:'',goal:'note-courier.ts',pos:{x:2655,z:3283,level:0},inventory:[trout(2),{id:1779,name:'Flax',count:81}]};
    const before=JSON.stringify(status);
    for(const goal of ['note-courier.ts','scripts/note-courier.ts','scripts\\note-courier.ts',job.goal])
        expect(courierDeliveryWaiting(['Bigpackage'],near,[job],()=>({...status,goal}),now)).toBe(true);
    for(const patch of [{goal:''},{goal:undefined},{goal:'fleet-seers-entry.ts'},{goal:'handoff token receiver'},{at:now-30_001},{result:'ok done'},{pos:{x:2727,z:3492,level:0}}])
        expect(courierDeliveryWaiting(['Bigpackage'],near,[job],()=>({...status,...patch}),now)).toBe(false);
    expect(JSON.stringify(status)).toBe(before);
});
