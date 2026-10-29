import {expect,test} from 'bun:test';
import {ironResult,ironSaveChecks,ironChildChecks} from '../src/iron-progress-order-proof';

function fixture(){
 const before:any={position:{x:3252,z:3420,level:0},skills:Array.from({length:21},(_,index)=>({index,level:index===13?31:16,xp:100,rawExperience:1000})),vars:{},inventories:{93:[{id:1265,count:1},{id:315,count:2}],95:[{id:440,count:684},{id:995,count:24}]}};
 const after=structuredClone(before);after.position={x:3269,z:3167,level:0};after.inventories[95]=[{id:440,count:674},{id:995,count:14},{id:2351,count:6}];after.skills[13].rawExperience=2000;
 const result={ok:true,bar:'iron',mode:'exact',target:6,targetMet:true,made:6,banked:6,consumedOre:10,losses:4,coinsSpent:10,xpGain:100,died:false,hpMin:16};return{before,after,result};
}
test('independent iron proof checks failed smelts, exact bank credit and fare',()=>{
 const {before,after,result}=fixture();expect(Object.values(ironSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(true);
 result.losses=0;expect(ironSaveChecks(before,after,result,'entry').ore).toBe(false);
 result.bar='gold';expect(ironSaveChecks(before,after,result,'entry').output).toBe(false);
});
test('wrong entry, missing food, pack bars, unrelated XP and unpaid fare reject the proof',()=>{
 for(const mutate of [(b:any,a:any)=>b.position.x=3269,(_:any,a:any)=>a.inventories[93].pop(),(_:any,a:any)=>a.inventories[93].push({id:2351,count:6}),(_:any,a:any)=>a.skills[14].rawExperience++,(_:any,a:any)=>a.inventories[95][1].count=24]){
  const {before,after,result}=fixture();mutate(before,after);expect(Object.values(ironSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(false);
 }
});
test('CLI success without a single confirmed logout is insufficient',()=>{
 expect(ironChildChecks(0,false,'RESULT ok test\n','entry').logout).toBe(false);
 expect(Object.values(ironChildChecks(0,false,'LOGOUT logged-out\nRESULT ok test\n','entry')).every(Boolean)).toBe(true);
 expect(ironChildChecks(0,true,'LOGOUT logged-out\nRESULT ok test\n','entry').exit).toBe(false);
 expect(ironChildChecks(0,false,'LOGOUT logged-out\nRESULT ok test\n','limited').exit).toBe(false);
 expect(ironResult('SMELT_RESULT '+JSON.stringify({made:6}))).toEqual({made:6});
});
