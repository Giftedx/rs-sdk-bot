import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {RouteResources} from '../packages/planner/src/supply-route';

export type RouteActor={name:string;server?:string;at:number|null;inventory:unknown;equipment:unknown;equipmentObserved?:boolean;skills:unknown;guildFacts?:unknown;doorStates?:unknown};
// Input is the report's account snapshot, never route-request assertions. Notes
// keep their exact raw IDs: a noted rope cannot satisfy a carried rope gate.
export function observedRouteResources(actor:RouteActor|undefined,name:string|undefined,server:string|undefined,now:number,tokens:string[],reserved?:Record<string,number>){
 const current=!!actor&&!!name&&actor.name.toLowerCase()===name.toLowerCase()&&actor.server==='rs-sdk-demo.fly.dev'&&server===actor.server
  &&Number.isSafeInteger(actor.at)&&actor.at!>0&&actor.at!<=now&&now-actor.at!<=300000;
 const items=JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/items.json'),'utf8')) as {id:number;debugname:string}[];
 const names=new Map(items.map(i=>[i.id,i.debugname]));
 const counts=(value:unknown):Record<string,number>|null=>{
  if(!current||!Array.isArray(value))return null;
  const result:Record<string,number>={};
  for(const item of value){
   if(!Number.isSafeInteger(item?.id)||item.id<0||!Number.isSafeInteger(item.count)||item.count<=0)return null;
   const key=names.get(item.id);if(!key)return null;
   const n=(result[key]??0)+item.count;if(!Number.isSafeInteger(n))return null;result[key]=n;
  }
  return result;
 };
 const held=counts(actor?.inventory),worn=actor?.equipmentObserved===true?counts(actor.equipment):null;
 const observed:any=current?actor.guildFacts:null;
 const facts:Record<string,true|false|null>={},unsupported:string[]=[];
 for(const token of new Set(tokens)){
  const match=/^(base-skill|skill):([^:]+):(\d+)$/.exec(token);
  if(match){
   const threshold=Number(match[3]),rows=current&&Array.isArray(actor.skills)?actor.skills.filter((s:any)=>s?.name?.toLowerCase()===match[2]!.toLowerCase()):[];
   // Pinned STAT gates read the current level. Base levels belong to wield
   // requirements (STAT_BASE); drained/boosted values must not be conflated.
   const level=rows.length===1?rows[0][match[1]==='base-skill'?'level':'currentLevel']:undefined;
   const validLevel=Number.isSafeInteger(level)&&level>=(match[1]==='base-skill'?1:0)&&(match[1]!=='base-skill'||level<=99);
   facts[token]=Number.isSafeInteger(threshold)&&threshold>=0&&validLevel?level>=threshold:null;
  }else if(/^questpoints:\d+$/.test(token)){
   const threshold=Number(token.slice('questpoints:'.length)),qp=observed?.varps?.qp;
   facts[token]=Number.isSafeInteger(threshold)&&threshold>0&&Number.isSafeInteger(qp)&&qp>0?qp>=threshold:null;
  }else if(/^quest:(heroquest|legendsquest|mcannon):\d+$/.test(token)){
   const [,key,raw]=token.split(':'),threshold=Number(raw),stage=observed?.questStages?.[key!];
   // Journal/quest-colour observations are lower bounds. A smaller bound does
   // not prove the actual private stage is below the requested threshold.
   facts[token]=Number.isSafeInteger(threshold)&&threshold>0&&Number.isSafeInteger(stage)&&stage>=threshold?true:null;
  }else if(/^unlock:(prayer-guild|dwarf-tower)$/.test(token)){
   facts[token]=Array.isArray(observed?.unlocks)&&observed.unlocks.includes(token.slice('unlock:'.length))?true:null;
  }else if(/^cw:team:[01]$/.test(token)){
   const team=observed?.castlewarsTeam;
   facts[token]=team===0||team===1?team===Number(token.slice('cw:team:'.length)):null;
  }else if(/^door-open:[0-3]:\d+:\d+$/.test(token)){
   const [,level,x,z]=token.split(':'),coords=[Number(x),Number(z)],states:any=current?actor.doorStates:null,key=[Number(level),...coords].join(',');
   const known=coords.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=16383)&&states&&typeof states==='object'&&!Array.isArray(states)&&Object.prototype.hasOwnProperty.call(states,key);
   facts[token]=known&&typeof states[key]==='boolean'?states[key]:null;
  }else if(/^cw:not-own-banner:[01]:[a-z0-9_]+$/.test(token)){
   const parts=token.split(':'),team=observed?.castlewarsTeam,owner=Number(parts[2]),flag=parts[3]!;
   facts[token]=(team===0||team===1)&&team!==owner?true:worn&&(worn[flag]??0)===0?true:worn&&team===owner?false:null;
  }else if(!/^(coins:|consume:|item:)/.test(token)){facts[token]=null;unsupported.push(token);}
 }
 const resources:RouteResources={held,worn,facts,coinsKnown:held!==null,...(reserved?{reserved}:{})};
 return{resources,evidence:{account:name??null,at:current?actor.at:null,current,unsupported}};
}
