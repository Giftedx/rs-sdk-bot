import {test,expect} from 'bun:test';
import {ADMISSION,glassProofPreset,glassSaveStock,glassSaveChecks,glassChildChecks,glassChildConfiguration,glassResult} from '../src/glass-supply-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
type Save=ReturnType<typeof readPracticeSave>;
const save=(pack:[number,number][],bank:[number,number][],gear:[number,number][]=[])=>({position:{x:3185,z:3436,level:0},vars:{160:2},
 skills:Array.from({length:21},(_,i)=>({index:i,level:i===12?51:i===3?39:1,xp:0,rawExperience:i===12?10000:0})),
 inventories:{93:pack.map(([id,count],slot)=>({id,count,slot})),95:bank.map(([id,count],slot)=>({id,count,slot})),94:gear.map(([id,count],slot)=>({id,count,slot}))}} as unknown as Save);
const before=()=>save([[995,17],[590,1]],[[995,2000],[314,23]],[[1205,1]]);
function after(){const a=save([],[[995,2017],[314,23],[590,1],[1205,1],[1775,1],[1925,1]]);a.position={x:3092,z:3243,level:0};a.skills[12]!.rawExperience+=5000;return a;}
const result={ok:true,conserved:true,target:1,made:1,filled:1,cooked:1,seaweed:1,buckets:1,spent:0,banked:1,ticks:1000};
const failures=(c:Record<string,boolean>)=>Object.keys(c).filter(k=>!c[k]);
test('proof admission uses shared constants and ordinary Magicwanda entry',()=>{
 expect(ADMISSION).toEqual({floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB});const p=glassProofPreset('entry');expect(p.skills).toEqual({Crafting:51,Hitpoints:39});expect(p.varps?.[160]).toBe(2);expect([...(p.inventory??[]),...(p.bank??[])].some(i=>[1775,1783,1781,401,1925].includes(i.id))).toBe(false);
});
test('native configuration invokes the actual account CLI with explicit supply limits',()=>{
 const c=glassChildConfiguration('fixture','entry',{});expect(c.cmd).toEqual(['bun','scripts/microbot-glass.ts','fixture']);expect(c.windowsHide).toBe(true);expect(c.env).toMatchObject({SUPPLY_MODE:'1',MEMBERS:'1',MAX_MAKE:'1',MAX_SPEND:'0',CAP:'4000'});expect(glassChildConfiguration('fixture','refusal',{}).env.MEMBERS).toBe('0');
});
test('save verifier reconciles actual bank output, costs, buckets and unrelated gear',()=>{
 expect(failures(glassSaveChecks(before(),after(),result,'entry'))).toEqual([]);expect(glassSaveStock(before())[1205]).toBe(1);
 const lost=after();lost.inventories[95]=lost.inventories[95]!.filter(i=>i.id!==314);expect(glassSaveChecks(before(),lost,result,'entry').assets).toBe(false);
 const noBucket=after();noBucket.inventories[95]=noBucket.inventories[95]!.filter(i=>i.id!==1925);expect(glassSaveChecks(before(),noBucket,result,'entry').assets).toBe(false);
 const pack=after();pack.inventories[95]=pack.inventories[95]!.filter(i=>i.id!==1775);pack.inventories[93]=[{id:1775,count:1,slot:0}];expect(glassSaveChecks(before(),pack,result,'entry').bank).toBe(false);
 const noXp=after();noXp.skills[12]!.rawExperience=10000;expect(glassSaveChecks(before(),noXp,result,'entry').skills).toBe(false);
 expect(glassSaveChecks(before(),after(),{...result,spent:1},'entry').result).toBe(false);
});
test('refusal requires unchanged assets and clear reason',()=>{
 const r={ok:false,failure:'Error: glass supply refused: MEMBERS=1 required',ticks:0};expect(failures(glassSaveChecks(before(),before(),r,'refusal'))).toEqual([]);expect(glassSaveChecks(before(),before(),{...r,failure:'unknown'},'refusal').result).toBe(false);
});
test('worker result is separate from exit and confirmed logout',()=>{
 const log='GLASS_SUPPLY_RESULT '+JSON.stringify(result)+'\nRESULT ok fixture\nLOGOUT logged-out\n';expect(glassResult(log)).toEqual(result);expect(failures(glassChildChecks(0,false,log,'entry'))).toEqual([]);expect(glassChildChecks(0,true,log,'entry').exit).toBe(false);expect(glassChildChecks(0,false,log.replace('LOGOUT logged-out','LOGOUT disconnected'),'entry').logout).toBe(false);expect(glassChildChecks(0,false,log+'LOGOUT logged-out\n','entry').logout).toBe(false);
});
