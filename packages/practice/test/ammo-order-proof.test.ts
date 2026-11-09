import {test,expect} from 'bun:test';
import {ammoOrderChecks,headlessOrderChecks,plannedEntryChecks,selectAmmoProofEndpoints,ammoProofAccountEnv,startAmmoProofStack,ammoChildConfiguration,ammoRegistrationArgs} from '../src/ammo-order-proof';

test('owned ammo endpoints reach the stack, new profiles, registration and every worker child',async()=>{
 const checked:number[]=[],samples=[0,0.01];
 const p=selectAmmoProofEndpoints(port=>{checked.push(port);return port!==20003;},()=>samples.shift()!);
 expect(checked).toEqual([20000,20001,20002,20003,20200,20201,20202,20203]);
 expect(p.ports).toEqual({engine:20200,gateway:20201,management:20202,tcp:20203});
 expect(p.instance).toMatch(/^ammo-[a-z0-9-]{1,25}$/);
 const original='SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\nPASSWORD=fixture\r\n';
 const configured=ammoProofAccountEnv(original,p);
 expect(configured).toContain(`SERVER=${p.server}\r\n`);
 expect(configured).toContain(`GATEWAY_URL=${p.gateway}\r\n`);
 expect(configured).toContain('PASSWORD=fixture\r\n');
 expect(()=>ammoProofAccountEnv(original.replace('localhost:8888','rs-sdk-demo.fly.dev'),p)).toThrow('new practice account required');
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 let stops=0;
 const owned={logs:{engine:'',gateway:''},stop:async()=>{stops++;}};
 const stack=await startAmmoProofStack(p,async opts=>{
  expect(opts).toEqual({ports:p.ports,instance:p.instance,tickMs:150,xpRate:25,readyTimeoutMs:60000});
  for(const [k,v] of Object.entries(p.env))expect(process.env[k]).toBe(v);
  return owned;
 });
 expect(stack).toBe(owned);await stack.stop();expect(stops).toBe(1);
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 await expect(startAmmoProofStack(p,async()=>{throw Error('startup refused');})).rejects.toThrow('startup refused');
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 const registration=ammoRegistrationArgs('fixture',p);
 expect(registration[0]).toBe('--eval');
 expect(registration[1]).toContain(JSON.stringify(`SERVER=${p.server}`));
 expect(registration[1]).toContain(JSON.stringify(`GATEWAY_URL=${p.gateway}`));
 expect(registration[1]).toContain('openBot(');
 expect(registration[1]).toContain('finish([session]');
 for(const args of [registration,['scripts/handoff-inputs.ts','donor','receiver','90:Iron arrowtips'],['scripts/fletch-arrows.ts','fixture','400','iron'],['scripts/handoff-inputs.ts','fixture','--headless-order','135','14']]){
  const child=ammoChildConfiguration(args,{CAP:'1600'},p,{GATEWAY_URL:'ws://localhost:7780',WEB_MANAGEMENT_PORT:'8898',NODE_PORT:'43594'});
  expect(child.cmd).toEqual(['bun',...args]);
  expect(child.env).toMatchObject({...p.env,GATEWAY_URL:p.gateway,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'1600'});
  expect(child.env.GE_DATABASE).toBe(`data/market-${p.instance}.sqlite`);
  expect(child.windowsHide).toBe(true);
 }
 expect(()=>selectAmmoProofEndpoints(()=>false,()=>0)).toThrow('owned practice ports unavailable');
});

test('ammo acceptance rejects missing product, lost reserve and absent XP',()=>{
    const save=(bank:{id:number;count:number}[],xp=0)=>({inventories:{93:[],94:[],95:bank.map((item,slot)=>({...item,slot}))},skills:Array.from({length:21},(_,i)=>({index:i,level:i===3?15:1,xp:i===9?xp:0,rawExperience:0})),position:{x:3253,z:3421,level:0},version:9,vars:{}});
    const before=[save([{id:40,count:90},{id:39,count:16}]),save([{id:53,count:390}])];
    const donor=save([{id:39,count:16}]),received=save([{id:53,count:390},{id:40,count:90}]),final=save([{id:53,count:300},{id:884,count:90}],10);
    const input={before,donor,received,final,receipt:{state:'settled',expected:[{id:40,count:90}]},transfer:{code:0,log:'HANDOFF_RESULT {"ok":true\nLOGOUT logged-out\nLOGOUT logged-out'},craft:{code:0,log:'LOGOUT logged-out'},repeat:{code:1,log:'already settled'}};
    expect(Object.values(ammoOrderChecks(input)).every(Boolean)).toBe(true);
    const emptyEquipmentOmitted={...before[0]!,inventories:{93:[],95:before[0]!.inventories[95]}};
    expect(ammoOrderChecks({...input,before:[emptyEquipmentOmitted,before[1]!]}).pack).toBe(true);
    for(const bad of [save([{id:53,count:300}],10),save([{id:53,count:299},{id:884,count:90}],10),save([{id:53,count:300},{id:884,count:90}])])
        expect(Object.values(ammoOrderChecks({...input,final:bad})).every(Boolean)).toBe(false);
    expect(ammoOrderChecks({...input,repeat:{code:1,log:'already settled\nSTART 1 2 0'}}).restart).toBe(false);
});

test('owned headless saved-state gate rejects asset loss, old output, no XP and unclear refusal/logout',()=>{
 const save=(bank:{id:number;count:number}[],xp=0)=>({inventories:{93:[],94:[],95:bank.map((item,slot)=>({...item,slot}))},skills:Array.from({length:21},(_,i)=>({index:i,level:i===3?69:1,xp:i===9?xp:0,rawExperience:0})),position:{x:3185,z:3436,level:0},version:9,vars:{}});
 const before=save([{id:1511,count:15},{id:52,count:35},{id:314,count:5705},{id:53,count:300},{id:946,count:1},{id:995,count:331135}]);
 const final=save([{id:1511,count:1},{id:52,count:110},{id:314,count:5570},{id:53,count:435},{id:946,count:1},{id:995,count:331135}],200);
 const production={code:0,log:'HANDOFF_RESULT {"ok":true\nLOGOUT logged-out'},refusal={code:1,log:'missing owned inputs\nLOGOUT logged-out'};
 expect(Object.values(headlessOrderChecks(before,final,final,production,refusal)).every(Boolean)).toBe(true);
 for(const id of [1511,52,314,53,946,995]){
  const lost=save(final.inventories[95].map(i=>({...i,count:i.count-(i.id===id?1:0)})),200);
  expect(Object.values(headlessOrderChecks(before,lost,lost,production,refusal)).every(Boolean)).toBe(false);
 }
 expect(headlessOrderChecks(before,{...final,skills:before.skills},final,production,refusal).headlessXp).toBe(false);
 expect(headlessOrderChecks(before,final,final,production,{code:1,log:'missing owned inputs'}).headlessLogout).toBe(false);
 expect(headlessOrderChecks(before,final,final,production,{...refusal,log:refusal.log+'\nSHAFT_BANK {}'}).refusal).toBe(false);
});

test('planned entry gate rejects missing approach, lost assets, wrong fares, unclear refusal and no logout',()=>{
 const save=(pack:{id:number;count:number}[],bank:{id:number;count:number}[],x=2615,z=3332)=>({inventories:{93:pack.map((item,slot)=>({...item,slot})),94:[],95:bank.map((item,slot)=>({...item,slot}))},skills:[],position:{x,z,level:0},version:9,vars:{}}) as any;
 const donorPack=[{id:379,count:1},{id:379,count:1},{id:231,count:1}];
 const before=[save([...donorPack,{id:995,count:100}],[{id:379,count:173},{id:995,count:19885}],3028,3221),save([{id:1891,count:3}],[{id:995,count:175}],2662,3305)];
 const final=[save([...donorPack,{id:995,count:40}],[{id:379,count:73},{id:995,count:19885}]),save([{id:1891,count:3}],[{id:995,count:175},{id:379,count:100}])];
 const input={before,refused:before,final,names:['pdon','prec'],receipt:{state:'settled',expected:[{id:379,count:100}]},
  planned:{code:0,log:'HANDOFF_APPROACH {"account":"pdon"\nHANDOFF_APPROACH {"account":"prec"\nHANDOFF_RESULT {"ok":true\nLOGOUT logged-out\nLOGOUT logged-out'},
  refusal:{code:1,log:'handoff approach deadline\nLOGOUT logged-out\nLOGOUT logged-out'},repeat:{code:1,log:'already settled'}};
 expect(Object.values(plannedEntryChecks(input)).every(Boolean)).toBe(true);
 expect(plannedEntryChecks({...input,planned:{...input.planned,log:input.planned.log.replace('"prec"','"other"')}}).plannedTransfer).toBe(false);
 const overpaid=save([...donorPack,{id:995,count:39}],[{id:379,count:73},{id:995,count:19885}]);
 expect(plannedEntryChecks({...input,final:[overpaid,final[1]!]}).plannedAssets).toBe(false);
 const spentFood=save([{id:231,count:1},{id:995,count:40}],[{id:379,count:75},{id:995,count:19885}]);
 expect(plannedEntryChecks({...input,final:[spentFood,final[1]!]}).plannedPreHeld).toBe(false);
 expect(plannedEntryChecks({...input,final:[final[0]!,save([{id:1891,count:3}],[{id:995,count:175},{id:379,count:100}],2662,3305)]}).plannedPosition).toBe(false);
 expect(plannedEntryChecks({...input,refusal:{code:1,log:input.refusal.log+'\nHANDOFF_RECEIPT {}'}}).plannedRefusal).toBe(false);
 expect(plannedEntryChecks({...input,refused:[final[0]!,before[1]!]}).plannedRefusal).toBe(false);
 expect(plannedEntryChecks({...input,refusal:{code:1,log:'handoff approach deadline\nLOGOUT logged-out'}}).plannedLogout).toBe(false);
});
