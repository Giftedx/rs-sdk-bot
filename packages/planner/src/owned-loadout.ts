// Independent TypeScript rewrite of counted owned candidates (buderw Bank /
// LoadoutOptimizer) and required/pinned slots (Loadout Lab OptimizationRequest).
// Exact search replaces beam pruning for these small worker kits. This selects
// advisory stock; it neither reserves an item nor proves equip/delivery effects.
export type GearCount={id:number;count:number};
export type GearOption=GearCount&{preference:number;equippable:boolean|null;occupies?:string[]};
export type GearSlot={key:string;options:readonly GearOption[]};
export type GearChoice=GearCount&{slot:string;preference:number};
export type OwnedLoadout={state:'ready'|'missing'|'unknown';selected:GearChoice[];preference:number|null;reasons:string[];searched:number};

const whole=(n:number)=>Number.isSafeInteger(n)&&n>=0;
function totals(items:readonly GearCount[]){
 const out=new Map<number,number>();
 for(const item of items){
  if(!whole(item.id)||!whole(item.count))throw Error('Invalid gear identity/quantity');
  const n=(out.get(item.id)??0)+item.count;
  if(!whole(n))throw Error('Gear quantity overflow');out.set(item.id,n);
 }
 return out;
}

export function ownedLoadout(slots:readonly GearSlot[],stock:readonly GearCount[],reserved:readonly GearCount[]=[],stockComplete=true):OwnedLoadout{
 if(new Set(slots.map(s=>s.key)).size!==slots.length||slots.some(s=>!s.key))throw Error('Gear slot identity must be unique');
 for(const slot of slots)for(const o of slot.options){
  if(!whole(o.id)||!whole(o.count)||o.count===0||!whole(o.preference)||![true,false,null].includes(o.equippable)
   ||o.occupies?.some(k=>!k))throw Error('Invalid gear option');
 }
 const available=totals(stock),held=totals(reserved);
 for(const [id,n] of held)available.set(id,Math.max(0,(available.get(id)??0)-n));
 let best:GearChoice[]|null=null,bestRank=Infinity,searched=0,limited=false;
 const unknown=slots.some(s=>s.options.some(o=>o.equippable===null&&(available.get(o.id)??0)>=o.count));
 const visit=(index:number,chosen:GearChoice[],rank:number,occupied:Set<string>)=>{
  if(++searched>100000){limited=true;return;}
  if(rank>=bestRank)return;
  if(index===slots.length){best=[...chosen];bestRank=rank;return;}
  const slot=slots[index]!;
  if(occupied.has(slot.key))return;
  for(const option of [...slot.options].sort((a,b)=>a.preference-b.preference||a.id-b.id)){
   if(option.equippable!==true||(available.get(option.id)??0)<option.count)continue;
   const occupies=[slot.key,...(option.occupies??[])];
   if(occupies.some(k=>occupied.has(k)||chosen.some(c=>c.slot===k)))continue;
   const nextRank=rank+option.preference;if(!whole(nextRank))throw Error('Gear preference overflow');
   available.set(option.id,available.get(option.id)!-option.count);
   visit(index+1,[...chosen,{slot:slot.key,id:option.id,count:option.count,preference:option.preference}],nextRank,new Set([...occupied,...occupies]));
   available.set(option.id,available.get(option.id)!+option.count);
   if(limited)return;
  }
 };
 visit(0,[],0,new Set());
 if(limited)return{state:'unknown',selected:[],preference:null,reasons:['Gear search bound reached; no complete selection accepted'],searched};
 if(best)return{state:'ready',selected:best,preference:bestRank,reasons:[],searched};
 return{state:unknown||!stockComplete?'unknown':'missing',selected:[],preference:null,
  reasons:[...slots.filter(s=>!s.options.some(o=>o.equippable===true&&(available.get(o.id)??0)>=o.count)).map(s=>s.key+': no known unreserved usable option'),...(unknown?['Unknown equip prerequisite']:[]),...(!stockComplete?['Stock observation incomplete']:[]),...(slots.length?['No simultaneous assignment satisfies quantities and occupied slots']:[])],searched};
}

// Pinned rev289 content: levelrequire/scripts/tier1.rs2 and tier30.rs2.
// IDs/order match the existing finite Fire worker. Rank is worker preference,
// not a measured DPS ranking. Noted item IDs are deliberately absent.
export function fireWeaponSlot(attack:number|null):GearSlot{
 const known=attack!==null&&Number.isSafeInteger(attack)&&attack>=1&&attack<=99;
 return{key:'weapon',options:[1331,1287,1301,1277].map((id,preference)=>({id,count:1,preference,equippable:known?attack!>=(id===1277?1:30):null}))};
}

export function fireKit(attack:number|null):GearSlot[]{
 return [fireWeaponSlot(attack),...[{key:'shield',id:1171,count:1},{key:'amulet',id:295,count:1},{key:'rope',id:954,count:1},{key:'salmon',id:329,count:16}].map(x=>({key:x.key,options:[{id:x.id,count:x.count,preference:0,equippable:true}]}))];
}
