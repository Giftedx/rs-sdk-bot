export type Truth=true|false|null;
export type Requirement={fact:string}|{ref:string}|{all:Requirement[]}|{any:Requirement[]};
export type RequirementResult={state:Truth;blockers:string[]};

// Facts belong to one dated account snapshot. This checks readiness; it does not
// allocate consumables (the preparation ledger sums those separately).
export function requirements(graph:Record<string,Requirement>,facts:Record<string,Truth>,goals:string[]) {
 const memo=new Map<string,RequirementResult>();
 const visit=(id:string,stack:Set<string>):RequirementResult=>{
  if(stack.has(id))return {state:null,blockers:['cycle:'+id]};
  if(memo.has(id))return memo.get(id)!;
  const node=graph[id];if(!node)return {state:null,blockers:['missing:'+id]};
  const result=check(node,new Set([...stack,id]));
  // A cycle result depends on the current traversal, so do not cache it for
  // another root that may resolve an independently satisfied alternative.
  if(!result.blockers.some(b=>b.startsWith('cycle:')))memo.set(id,result);
  return result;
 };
 const check=(r:Requirement,stack:Set<string>):RequirementResult=>{
  if('fact' in r){const state=facts[r.fact]??null;return {state,blockers:state===true?[]:[r.fact+(state===null?' unknown':' unmet')]};}
  if('ref' in r)return visit(r.ref,stack);
  const all='all' in r,children=(all?r.all:r.any).map(c=>check(c,stack));
  const state=all?(children.some(c=>c.state===false)?false:children.some(c=>c.state===null)?null:true)
   :(children.some(c=>c.state===true)?true:children.some(c=>c.state===null)?null:false);
  return {state,blockers:state===true?[]:[...new Set(children.flatMap(c=>c.blockers))]};
 };
 return Object.fromEntries(goals.map(id=>[id,visit(id,new Set())]));
}
