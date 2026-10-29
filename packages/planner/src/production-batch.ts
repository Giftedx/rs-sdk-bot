// Recipe stock-bound pattern adapted from Iron Compass BankedGoalService.availableActions:
// gabworknestio-beep/iron-compass@4f55942723b2f1fd609213ea1b2b528e7641a670.
// BSD-2-Clause notice: ../THIRD_PARTY_NOTICES.md. Our reserves, slot bound and
// exact-order policy are local. This plans withdrawal, not output or bank proof.
// freeSlots excludes protected kit and any separately required output slots.
export type BatchIngredient={id:number;available:number;reserved:number;units:number;stackable:boolean};

export function productionBatch(ingredients:BatchIngredient[],freeSlots:number,requested:number,mode:'exact'|'best-effort'){
 const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 if(!integer(freeSlots)||!integer(requested)||!['exact','best-effort'].includes(mode)||!ingredients.length)throw Error('invalid production batch');
 const seen=new Set<number>();
 let possible=requested,perActionSlots=0,stackSlots=0;
 for(const i of ingredients){
  if(![i.id,i.available,i.reserved,i.units].every(integer)||i.units<1||typeof i.stackable!=='boolean'||seen.has(i.id))throw Error('invalid or duplicate recipe ingredient');
  seen.add(i.id);
  possible=Math.min(possible,Math.floor(Math.max(0,i.available-i.reserved)/i.units));
  if(i.stackable)stackSlots++;else perActionSlots+=i.units;
  if(!integer(perActionSlots))throw Error('recipe slots exceed safe integer range');
 }
 const inputSlots=freeSlots-stackSlots;
 possible=inputSlots<0?0:perActionSlots?Math.min(possible,Math.floor(inputSlots/perActionSlots)):possible;
 const targetMet=possible===requested;
 return {possible,planned:mode==='exact'&&!targetMet?0:possible,targetMet};
}
