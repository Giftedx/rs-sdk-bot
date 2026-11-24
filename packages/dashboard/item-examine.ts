// Descriptions and legacy icon aliases come from the complete object catalogue, before visible items are selected.
export type ExamineIdentity={id?:unknown;baseId?:unknown;name?:unknown};
export type ExamineTables={byId:Record<string,string>;byName:Record<string,string>};
type Catalogue=ReadonlyMap<number,{name:string;desc?:string}>;
export const examineName=(name:unknown)=>typeof name==='string'?name.trim().toLowerCase():'';
export const hasExamineId=(item:ExamineIdentity|string|null|undefined)=>!!item&&typeof item==='object'
 &&(Object.hasOwn(item,'id')||Object.hasOwn(item,'baseId'));
export function examineId(item:ExamineIdentity|string|null|undefined):number|null{
 if(!item||typeof item!=='object')return null;
 const id=Object.hasOwn(item,'id')?item.id:item.baseId;
 return Number.isSafeInteger(id)&&Number(id)>=0?Number(id):null;
}
function catalogueGroups(catalogue:Catalogue){
 const groups=new Map<string,{id:number;name:string;desc?:string}[]>();
 for(const [id,item]of catalogue){
  const name=examineName(item?.name);if(!name||!Number.isSafeInteger(id)||id<0)continue;
  const rows=groups.get(name)??[];rows.push({id,...item});groups.set(name,rows);
 }
 return groups;
}
export function buildItemExamine(catalogue:Catalogue):ExamineTables{
 const byId:Record<string,string>={},byName:Record<string,string>={};
 for(const [name,rows]of catalogueGroups(catalogue)){
  for(const row of rows)if(typeof row.desc==='string'&&row.desc.trim())byId[row.id]=row.desc;
  const first=rows[0]?.desc;
  if(typeof first==='string'&&first.trim()&&rows.every(row=>row.desc===first))byName[name]=first;
 }
 return{byId,byName};
}
export function itemExamine(tables:ExamineTables,item:ExamineIdentity|string|null|undefined):string|null{
 const id=examineId(item);if(id!==null)return Object.hasOwn(tables.byId,id)?tables.byId[id]!:null;if(hasExamineId(item))return null;
 const name=examineName(typeof item==='string'?item:item?.name);return Object.hasOwn(tables.byName,name)?tables.byName[name]!:null;
}
export function projectItemExamine(tables:ExamineTables,visible:readonly(ExamineIdentity|string)[]){
 const itemExamineById:Record<string,string>={},itemExamineByName:Record<string,string>={};
 for(let i=0;i<visible.length;i++){
  const item=visible[i]!;
  const id=examineId(item),name=examineName(typeof item==='string'?item:item?.name);
  if(id!==null&&Object.hasOwn(tables.byId,id))itemExamineById[id]=tables.byId[id]!;
  if(name&&Object.hasOwn(tables.byName,name))itemExamineByName[name]=tables.byName[name]!;
 }
 return{itemExamineById,itemExamineByName};
}
// Different raw IDs have different sprite cells, including certificates. A name alone must identify one raw ID.
export function catalogueIconAliases(catalogue:Catalogue):Record<string,number>{
 const out:Record<string,number>={};
 for(const rows of catalogueGroups(catalogue).values())if(rows.length===1)out[rows[0]!.name]=rows[0]!.id;
 return out;
}
