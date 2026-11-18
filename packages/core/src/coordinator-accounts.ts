// Runtime consumers need only this structural view of the coordinator's identities.
export interface AccountBindingTask {readonly account?:string;readonly accountFrom?:string;readonly participants?:readonly string[]}
export interface AccountBindingState {
 readonly tasks:readonly {readonly spec:AccountBindingTask&{readonly id:string};readonly status:string;readonly receipt?:{readonly ok:boolean;readonly output?:unknown}}[];
}
export const COORDINATOR_ACCOUNT_PATTERN=/^[A-Za-z0-9_ -]{1,12}$/;

/** Null means a referenced identity is unproved, invalid, or aliases another participant. */
export function boundAccounts(task:AccountBindingTask,state:AccountBindingState):string[]|null{
 const bindings=task.participants??(task.accountFrom?['@'+task.accountFrom]:task.account?[task.account]:[]);
 const names:string[]=[];
 for(const binding of bindings){
  const record=binding.startsWith('@')?state.tasks.find(r=>r.spec.id===binding.slice(1)):undefined;
  const name=binding.startsWith('@')?(record?.status==='succeeded'&&record.receipt?.ok?(record.receipt.output as {account?:unknown}|null|undefined)?.account:undefined):binding;
  if(typeof name!=='string'||!COORDINATOR_ACCOUNT_PATTERN.test(name))return null;
  names.push(name);
 }
 return new Set(names.map(n=>n.toLowerCase())).size===names.length?names:null;
}
