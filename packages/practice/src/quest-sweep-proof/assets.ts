import {ELENA_DUST_ENTRY,SCORPION_BOATS,SCORPION_MEALS,SCORPION_POTION_NEXT,SCORPION_SPENT,type Save} from './fixtures';

export const lines=(log:string,prefix:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(prefix+' ')).map(l=>JSON.parse(l.slice(prefix.length+1)));
export const total=(s:Save,id:number)=>[93,95].reduce((n,t)=>n+(s.inventories[t]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
export const carried=(s:Save,id:number)=>(s.inventories[93]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export const bankCount=(s:Save,id:number)=>(s.inventories[95]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);

// The server writes an empty worn row (94) on first logout; an empty row and an absent row hold the same items.
export const equipment=(s:Pick<Save,'inventories'>)=>JSON.stringify(Object.entries(s.inventories)
 .filter(([k,rows])=>!['93','95'].includes(k)&&(rows??[]).length).sort(([a],[b])=>Number(a)-Number(b))
 .map(([k,rows])=>[k,[...rows!].sort((a,b)=>a.slot-b.slot).map(i=>[i.slot,i.id,i.count])]));

export const sameAssets=(a:Save,b:Save,cost:Record<number,number>,allowedGains:readonly number[]=[])=>{
 const gains=new Set(allowedGains);
 const ids=new Set([...Object.keys(cost).map(Number),...[a,b].flatMap(s=>[93,95].flatMap(t=>(s.inventories[t]??[]).map(i=>i.id)))]);
 return [...ids].every(id=>gains.has(id)?total(b,id)>=total(a,id)+(cost[id]??0):total(b,id)===total(a,id)+(cost[id]??0))&&equipment(a)===equipment(b);
};

export function ballAssets(before:Save,after:Save,cost:Record<number,number>){
 const normalize=(s:Save)=>{
  const copy=structuredClone(s);
  copy.inventories[93]=[...(copy.inventories[93]??[]),...(copy.inventories[94]??[])];
  copy.inventories[94]=[];return copy;
 };
 return sameAssets(normalize(before),normalize(after),cost);
}

export function huntAssets(before:Save,after:Save,eaten:number){
 // The bought apron moves from the pack to the body slot. Compare its total with the other assets.
 const normalized=structuredClone(after),worn=normalized.inventories[94]??[];
 const apron=worn.filter(i=>i.id===1005);
 normalized.inventories[94]=worn.filter(i=>i.id!==1005);
 normalized.inventories[93]=[...(normalized.inventories[93]??[]),...apron];
 // The eight carried cakes hold 24 bites. A bite turns cake 1891 into 2/3 cake 1893, then slice 1895, then nothing.
 // The cake forms left over from the eight hold exactly 24-eaten bites. The starting bananas and other food stay in the bank.
 const left=[total(after,1891)-total(before,1891)+8,total(after,1893)-total(before,1893),total(after,1895)-total(before,1895)];
 const cakes=Number.isSafeInteger(eaten)&&eaten>=0&&eaten<=24&&left.every(n=>n>=0)&&left[0]!+left[1]!+left[2]!<=8
  &&3*left[0]!+2*left[1]!+left[2]! ===24-eaten;
 // Three 30-coin crossings, 30 for rum and 2 for the apron; Luthas pays 30 and the treasure gives 450.
 return cakes&&sameAssets(before,normalized,{995:358,1891:left[0]!-8,1893:left[1]!,1895:left[2]!,1005:1,433:1,1635:1,1605:1});
}

export function scorpionPotionLedger(before:Save,log:string){
 const forms=[...Object.keys(SCORPION_POTION_NEXT).map(Number),229],held:Record<number,number>=Object.fromEntries(forms.map(id=>[id,total(before,id)]));
 const delta:Record<number,number>={},phases=new Set<string>();let bought=0,paid=0,boatCoins=0,boatCount=0,travelCoins=0,doses=0,last:{next:number;slot:number}|undefined;
 for(const line of log.split(/\r?\n/)){
  if(line.startsWith('QUEST_SWEEP_BUY ')){
   const r=JSON.parse(line.slice('QUEST_SWEEP_BUY '.length)),coins=r.coinsBefore-r.coins;
   if(r.item!==175||r.count!==1||r.before!==0||r.after!==1||!Number.isSafeInteger(r.coinsBefore)||!Number.isSafeInteger(r.coins)||r.coins<0
    ||!Number.isSafeInteger(coins)||coins<=0||coins>964||++bought>1)return{ok:false,delta,bought,paid,boatCoins,boatCount,travelCoins,doses};
   held[175]=(held[175]??0)+1;delta[175]=(delta[175]??0)+1;paid+=coins;
  }else if(line.startsWith('QUEST_SWEEP_BOAT ')){
   const r=JSON.parse(line.slice('QUEST_SWEEP_BOAT '.length));
   if(!SCORPION_BOATS.has(r.id)||r.coins!==30||++boatCount>2)return{ok:false,delta,bought,paid,boatCoins,boatCount,travelCoins,doses};
   boatCoins+=r.coins;
  }else if(line.startsWith('QUEST_SWEEP_TRAVEL_COST ')){
   const r=JSON.parse(line.slice('QUEST_SWEEP_TRAVEL_COST '.length)),coins=r.coinsBefore-r.coins;
   if(!['shop','start'].includes(r.phase)||phases.has(r.phase)||r.phase==='shop'&&r.item!==175||r.observed!==true
    ||!Number.isSafeInteger(r.coinsBefore)||!Number.isSafeInteger(r.coins)||r.coins<0||!Number.isSafeInteger(coins)||coins<0||coins%30!==0||coins>60
    ||travelCoins+coins>60)return{ok:false,delta,bought,paid,boatCoins,boatCount,travelCoins,doses};
   phases.add(r.phase);travelCoins+=coins;
  }else if(line.startsWith('SCORP_ANTIPOISON ')){
   const r=JSON.parse(line.slice('SCORP_ANTIPOISON '.length));
   if(r.observed!==true||!Number.isSafeInteger(r.item)||!Number.isSafeInteger(r.next)||SCORPION_POTION_NEXT[r.item]!==r.next||!Number.isSafeInteger(r.slot)||r.slot<0||r.slot>27
    ||(held[r.item]??0)<1||last&&(last.next!==r.item||last.slot!==r.slot))return{ok:false,delta,bought,paid,boatCoins,boatCount,travelCoins,doses};
   held[r.item]=(held[r.item]??0)-1;held[r.next]=(held[r.next]??0)+1;delta[r.item]=(delta[r.item]??0)-1;delta[r.next]=(delta[r.next]??0)+1;
   last={next:r.next,slot:r.slot};doses++;
  }
 }
 // The movement snapshots include any boat records from the same trip. Charge those fares once.
 return{ok:doses>0&&(!phases.size||boatCoins<=travelCoins)&&!/^QUEST_SWEEP_FARE /m.test(log),delta,bought,paid,boatCoins,boatCount,travelCoins:phases.size?travelCoins:boatCoins,doses};
}

export function scorpionAssets(before:Save,after:Save,eaten:number,log=''){
 // Arrows move between the bank, the pack and the worn ammunition slot (13). Count them as carried; the rest of the worn
 // gear must stay in place.
 const carry=(s:Save)=>{
  const copy=structuredClone(s),worn=copy.inventories[94]??[];
  copy.inventories[93]=[...(copy.inventories[93]??[]),...worn.filter(i=>i.slot===13)];
  copy.inventories[94]=worn.filter(i=>i.slot!==13);return copy;
 };
 const potion=scorpionPotionLedger(before,log);if(!potion.ok)return false;
 const b=carry(before),a=carry(after),cost:Record<number,number>={995:-268-potion.paid-potion.travelCoins,...potion.delta};
 for(const id of SCORPION_SPENT){const used=total(b,id)-total(a,id);if(used<0)return false;if(used)cost[id]=-used;}
 const meals=SCORPION_MEALS.reduce((n,id)=>n+total(b,id)-total(a,id),0);
 if(!Number.isSafeInteger(eaten)||eaten<0||meals!==eaten||SCORPION_MEALS.some(id=>total(a,id)>total(b,id)))return false;
 for(const id of SCORPION_MEALS)if(total(b,id)!==total(a,id))cost[id]=total(a,id)-total(b,id);
 return sameAssets(b,a,cost,[1590,1591])&&[1590,1591].every(id=>total(a,id)<=total(b,id)+1);
}

export function elenaAssets(before:Save,after:Save){
 // The new gas mask occupies the head slot; all other worn and stored assets must match.
 const normalized=structuredClone(after),worn=normalized.inventories[94]??[];
 const mask=worn.filter(i=>i.id===1506);
 normalized.inventories[94]=worn.filter(i=>i.id!==1506);
 normalized.inventories[93]=[...(normalized.inventories[93]??[]),...mask];
 // Staged water becomes four empty buckets. A normal acquisition buys those buckets for eight coins first.
 const water=total(before,1929);
 const upstairs=before.position.x===ELENA_DUST_ENTRY.x&&before.position.z===ELENA_DUST_ENTRY.z&&before.position.level===ELENA_DUST_ENTRY.level;
 const cost:Record<number,number>={995:water===4?-2:-10,1929:-water,2126:-1,1925:4,954:-1,1927:-1,231:-1,1505:1,1506:1};
 if(upstairs)Object.assign(cost,{563:-1,556:-3,555:-1});
 return mask.length===1&&mask[0]!.slot===0&&sameAssets(before,normalized,cost);
}
