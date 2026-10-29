import {fresh,gateProblem} from '../core/src/launch-evidence';

export function requestEvidence(text:string,now=Date.now()){
 const historical=/^> Historical request ledger/m.test(text);
 const match=text.match(/last audited (\d{4}-\d{2}-\d{2})|checked (\d{4}-\d{2}-\d{2})/i);
 const auditedAt=match?Date.parse((match[1]??match[2])+'T00:00:00Z'):null;
 return {historical, auditedAt, current:!historical&&fresh(auditedAt,now,86400000),
  note:historical?'Historical request ledger — recorded statuses, not the current work queue':!fresh(auditedAt,now,86400000)?'Request status is undated or stale':'Dated request ledger'};
}
export function gateView(g:any,now=Date.now()){
 const problem=gateProblem(g,now,false);
 const valid=!problem;
 return {at:g?.at??null,go:valid&&g.go===true&&g.gates.every((x:any)=>x.pass===true),valid,
  state:problem?'Unavailable or expired':g.go===true?'Authorized at last check':'Not authorized',
  gates:Array.isArray(g?.gates)?g.gates.filter((x:any)=>x&&typeof x.name==='string').map((x:any)=>({...x,pass:valid&&x.pass===true,detail:problem?problem:String(x.detail??'')})):[]};
}
