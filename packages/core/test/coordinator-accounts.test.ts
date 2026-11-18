import {expect,test} from 'bun:test';
import {boundAccounts, type AccountBindingState} from '../src/coordinator-accounts';
import {boundAccounts as routerBoundAccounts} from '../../router/src/coordinator';

const provision=(status='succeeded',ok=true,account:unknown='Helper 1'):AccountBindingState=>({tasks:[{spec:{id:'new-account'},status,receipt:{ok,output:{account}}}]});
test('shared account binding preserves literal names, ordering and the exact legacy name alphabet',()=>{
 const state:AccountBindingState={tasks:[]};expect(boundAccounts({},state)).toEqual([]);
 expect(boundAccounts({account:'Two Words'},state)).toEqual(['Two Words']);
 expect(boundAccounts({participants:['One_Name','Two-Names']},state)).toEqual(['One_Name','Two-Names']);
 expect(boundAccounts({participants:['abcdefghijkl']},state)).toEqual(['abcdefghijkl']);
 expect(boundAccounts({account:''},state)).toEqual([]);expect(boundAccounts({participants:['']},state)).toBeNull();
 for(const account of ['abcdefghijklm', 'bad.name', 'Årcher'])expect(boundAccounts({account},state)).toBeNull();
});
test('shared account binding resolves dynamic provision receipts and keeps unknown or failed identities unbound',()=>{
 const task={participants:['Donor','@new-account']};expect(boundAccounts(task,provision())).toEqual(['Donor','Helper 1']);
 expect(boundAccounts({accountFrom:'new-account'},provision())).toEqual(['Helper 1']);
 for(const state of [provision('pending'),provision('running'),provision('failed'),provision('succeeded',false),provision('succeeded',true,42),{tasks:[]}])expect(boundAccounts(task,state)).toBeNull();
});
test('shared account binding retains participants precedence and rejects case-folded aliases',()=>{
 expect(boundAccounts({participants:['Explicit'],account:'Unused',accountFrom:'missing'},provision())).toEqual(['Explicit']);
 expect(boundAccounts({participants:[],account:'Unused'},provision())).toEqual([]);
 expect(boundAccounts({accountFrom:'new-account',account:'Unused'},provision())).toEqual(['Helper 1']);
 expect(boundAccounts({participants:['Donor','donor']},provision())).toBeNull();
 expect(boundAccounts({participants:['Helper 1','@new-account']},provision())).toBeNull();
});
test('router callers retain the same shared account binding API',()=>{
 expect(routerBoundAccounts).toBe(boundAccounts);
 expect(routerBoundAccounts({participants:['Donor','@new-account']} as any,provision() as any)).toEqual(['Donor','Helper 1']);
});
