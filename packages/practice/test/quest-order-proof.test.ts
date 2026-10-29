import {test,expect} from 'bun:test';
import {questOrderChecks,questRecoveryChecks,questJournalChecks} from '../src/quest-order-proof';

const save=(vars:Record<number,number>,pack:number[],bank:{id:number;count:number}[]=[])=>({version:9,position:{x:3208,z:3214,level:0},skills:[],vars,
 inventories:{93:pack.map((id,slot)=>({id,count:1,slot})),95:bank.map((i,slot)=>({...i,slot}))}}) as any;
const line=(r:object)=>'QUEST_ORDER_RESULT '+JSON.stringify(r);
const summary={ok:true,quest:'cook',saved:{done:true,progress:2,qp:1},stages:{quest:{ok:true,code:0,result:'RESULT ok qp=1'},bank:{ok:true,banked:1}}};
const input={
 before:save({},[1944,1927,1933,1351]),after:save({29:2,101:1},[],[{id:1351,count:1}]),
 afterHash:'a',rerunAfter:'a',missBefore:'m',missAfter:'m',
 order:{code:0,log:`START 3208 3214 0\nRESULT ok qp=1\nLOGOUT logged-out\nSTART 3208 3214 0\nLOGOUT logged-out\nRESULT ok bank\n${line(summary)}`},
 missing:{code:1,log:line({ok:false,refused:'missing item Pot of flour 0/1',login:false})},
 rerun:{code:1,log:line({ok:false,refused:'quest already complete',login:false})},
};
test('quest acceptance passes only with saved varp, QP, banked leftover, two logouts and pre-login refusals',()=>{
 expect(Object.values(questOrderChecks(input)).every(Boolean)).toBe(true);
 expect(questOrderChecks({...input,after:save({29:2,101:0},[],[{id:1351,count:1}])}).questPoints).toBe(false);
 expect(questOrderChecks({...input,after:save({29:1,101:1},[],[{id:1351,count:1}])}).varp).toBe(false);
 expect(questOrderChecks({...input,after:save({29:2,101:1},[1351])}).banked).toBe(false);
 expect(questOrderChecks({...input,order:{...input.order,log:input.order.log.replace(/LOGOUT logged-out\nRESULT ok bank/,'LOGOUT timeout\nRESULT fail bank')}}).logout).toBe(false);
});
test('a claimed success cannot replace retained stage results or contradict the saved quest',()=>{
 const order=(value:object)=>({...input.order,log:input.order.log.replace(line(summary),line(value))});
 expect(questOrderChecks({...input,order:order({...summary,stages:{}})}).stages).toBe(false);
 expect(questOrderChecks({...input,order:order({...summary,stages:{...summary.stages,quest:{ok:false,code:1,result:'RESULT fail'}}})}).stages).toBe(false);
 expect(questOrderChecks({...input,order:order({...summary,stages:{...summary.stages,bank:{ok:false,banked:1}}})}).stages).toBe(false);
 expect(questOrderChecks({...input,order:order({...summary,saved:{done:true,progress:2,qp:99}})}).order).toBe(false);
 expect(questOrderChecks({...input,order:{...input.order,log:'QUEST_ORDER_RESULT {broken'}}).order).toBe(false);
});
test('a refusal after login, a changed save or a wrong reason fails the refusal checks',()=>{
 expect(questOrderChecks({...input,rerun:{code:1,log:'START 3208 3214 0\n'+input.rerun.log}}).rerun).toBe(false);
 expect(questOrderChecks({...input,rerunAfter:'b'}).rerun).toBe(false);
 expect(questOrderChecks({...input,rerun:{code:1,log:line({ok:false,refused:'quest state unknown',login:false})}}).rerun).toBe(false);
 expect(questOrderChecks({...input,missing:{...input.missing,code:0}}).missing).toBe(false);
 expect(questOrderChecks({...input,missAfter:'x'}).missing).toBe(false);
});

const completedSave=save({29:2,101:1},[1351]);
const recoveredSummary={...summary,stages:{quest:{ok:false,logout:true,code:1,result:'RESULT fail after completion'},completion:{matched:true},bank:{ok:true,logout:true,banked:1}}};
const recovery={before:input.before,after:input.after,afterHash:'a',rerunHash:'a',rerun:input.rerun,
 first:{code:0,log:`START 3208 3214 0\nLOGOUT logged-out\nSTART 3208 3214 0\nLOGOUT logged-out\n${line(recoveredSummary)}`}};
test('native child-failure proof needs saved completion, retained failure and both logouts',()=>{
 expect(Object.values(questRecoveryChecks(recovery)).every(Boolean)).toBe(true);
 expect(questRecoveryChecks({...recovery,after:save({29:2,101:8},[],[{id:1351,count:1}])}).questPoints).toBe(false);
 expect(questRecoveryChecks({...recovery,first:{...recovery.first,log:recovery.first.log.replace('LOGOUT logged-out','LOGOUT timeout')}}).logout).toBe(false);
 expect(questRecoveryChecks({...recovery,first:{code:0,log:line({...recoveredSummary,stages:{...recoveredSummary.stages,quest:{ok:true,logout:true,code:0}}})}}).child).toBe(false);
});
test('native bank-resume proof requires a failed clean bank session and exactly one new session',()=>{
 const child={ok:true,logout:true,code:0,result:'RESULT ok'};
 const first={code:1,log:`START quest\nLOGOUT logged-out\nSTART bank\nLOGOUT logged-out\n${line({ok:false,failed:'bank',stages:{quest:child,bank:{ok:false,logout:true,banked:0}}})}`};
 const resumed={...recoveredSummary,stages:{...recoveredSummary.stages,quest:child,resumed:true}};
 const resume={code:0,log:`START bank\nLOGOUT logged-out\n${line(resumed)}`};
 const p={...recovery,first,resume,interrupted:completedSave};
 expect(Object.values(questRecoveryChecks(p)).every(Boolean)).toBe(true);
 expect(questRecoveryChecks({...p,resume:{...resume,log:'START quest\nMILESTONE 1\n'+resume.log}}).resume).toBe(false);
 expect(questRecoveryChecks({...p,interrupted:input.before}).interruption).toBe(false);
 expect(questRecoveryChecks({...p,interrupted:input.after}).interruption).toBe(false);
 expect(questRecoveryChecks({...p,rerunHash:'changed'}).rerun).toBe(false);
 expect(questRecoveryChecks({...p,after:save({29:2,101:1},[],[{id:1351,count:2}])}).assets).toBe(false);
});
test('retained native journals must bind recovery to the same account, server and original baseline',()=>{
 const pending={version:1,account:'qcook1',quest:'cook',server:'localhost:8888',save:'F:/players/qcook1.sav',before:input.before,state:'pending',child:{ok:true,logout:true},bank:{ok:false,logout:true}};
 const settled={...pending,state:'settled',bank:{ok:true,logout:true}};
 const p={pending,settled,before:input.before,account:'qcook1'};
 expect(Object.values(questJournalChecks(p)).every(Boolean)).toBe(true);
 expect(questJournalChecks({...p,pending:{...pending,account:'other'}}).pending).toBe(false);
 expect(questJournalChecks({...p,pending:{...pending,before:completedSave}}).pending).toBe(false);
 expect(questJournalChecks({...p,settled:{...settled,server:'other'}}).settled).toBe(false);
 expect(questJournalChecks({...p,settled:{...settled,child:{ok:false,logout:true}}}).retained).toBe(false);
});
