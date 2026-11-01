import{test,expect}from'bun:test';
import{fittingBankBatch,validateBankJob,type BankJob}from'./microbot-bank-jobs';
test('bank refill sizes use native occupied slots rather than aggregate item counts',()=>{
 const stackable=(id:number)=>[995,554,561].includes(id);
 expect(fittingBankBatch({2357:1,1607:1},[1592],30,28,stackable)).toBe(13);
 expect(fittingBankBatch({1739:1,995:20},[],30,28,stackable)).toBe(27);
 expect(fittingBankBatch({440:1,453:8,554:4,561:1},[],3,28,stackable)).toBe(2);
 expect(fittingBankBatch({1783:1,1781:1},[],20,27,stackable)).toBe(13);
 expect(fittingBankBatch({2357:1,1607:1},[1592],1,2,stackable)).toBe(0);
 expect(fittingBankBatch({1889:1},[],28,28,stackable,{1891:1,1887:1})).toBe(14);
 expect(fittingBankBatch({2357:1,1607:1},[1592],1000000000,28,stackable)).toBe(13);
});
test('bank route cannot spend its reserved return budget as production time',()=>{
 const job:BankJob={family:'tanning',recipe:'soft',target:3,batch:1,cap:200,returnTicks:50,members:true};
 expect(()=>validateBankJob(job)).not.toThrow();
 for(const change of [{cap:50},{target:0},{batch:-1},{returnTicks:0},{reserve:-1},{bank:{x:1.5,z:2,level:0}},{family:'eval'}])expect(()=>validateBankJob({...job,...change}as BankJob)).toThrow();
});
