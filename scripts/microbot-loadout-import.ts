// Format source: Microbot 13b518350c4c81d64e4cfbb45b3d5d2f38488825 inventorysetups/serialization.
// Independent native adapter; original InventorySetups format by dillydill123 (BSD-2-Clause).
// bun scripts/microbot-loadout-import.ts <donor-setup.json> <native-bindings.json> > <owned-kit.json>
// Outputs exact item counts and native worn slots. Inventory positions, bank-tag layout and UI are not targets.
import {readFileSync} from 'node:fs';
import {validateOwnedKit,nativeKitItem,type OwnedKit} from './microbot-owned-loadout';

export interface SetupBindings{items:Record<string,number>;bank:OwnedKit['bank'];cap:number;maximumMoves:number;packPolicy:'exact-counts';setupName?:string}
type ObjectRow=Record<string,unknown>;
const object=(value:unknown):ObjectRow=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('donor setup/bindings object required');return value as ObjectRow;};
const whole=(value:unknown,min=0,max=2147483647):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const rowFields=new Set(['id','q','f','sc','l','s','name']);
const setupFields=new Set(['inv','eq','rp','bp','qv','afi','name','notes','hc','hd','dc','fb','uh','sb','fv','iId']);

export function compileInventorySetup(input:unknown,nativeBindings:unknown):OwnedKit{
 const declaration=object(nativeBindings),items=object(declaration.items);
 if(declaration.packPolicy!=='exact-counts'||Object.keys(items).length>128)throw Error('native setup requires exact-counts policy and bounded item bindings');
 for(const [id,native]of Object.entries(items))if(!/^(0|[1-9]\d*)$/.test(id)||!whole(Number(id))||!whole(native))throw Error('invalid explicit native item binding');
 if(declaration.setupName!==undefined&&(typeof declaration.setupName!=='string'||!declaration.setupName.trim()||declaration.setupName.length>256))throw Error('invalid setup name selector');
 if(Array.isArray(input)){
  if(input.length>64||!declaration.setupName)throw Error('portable list requires an exact setup name');
  const matching=input.filter(value=>{const row=object(value),setup=Object.hasOwn(row,'setup')?object(row.setup):row;return setup.name===declaration.setupName;});
  if(matching.length!==1)throw Error('setup name missing or ambiguous');input=matching[0];
 }
 const root=object(input),portable=Object.hasOwn(root,'setup');
 if(portable&&Object.keys(root).some(k=>!['setup','layout'].includes(k)))throw Error('ambiguous portable setup fields');
 const setup=portable?object(root.setup):root;
 if(declaration.setupName!==undefined&&setup.name!==declaration.setupName)throw Error('setup name does not match selector');
 for(const key of Object.keys(setup))if(!setupFields.has(key))throw Error('unsupported donor setup field '+key);
 if(setup.sb!=null&&![0,4].includes(setup.sb as number))throw Error('donor spellbook has no native loadout equivalent');

 const decode=(value:unknown)=>{
  if(value===null)return null;const row=object(value);
  for(const key of Object.keys(row))if(!rowFields.has(key))throw Error('unsupported donor item field '+key);
  if(row.f!=null&&row.f!==false||row.l!=null&&row.l!==false||row.sc!=null&&!['None','Standard'].includes(row.sc as string))throw Error('fuzzy, locked or inequality setup policy needs a native consumer');
  if(row.s!=null&&!whole(row.s,-1,27))throw Error('invalid donor item slot');
  if(row.id===-1){if(row.q!=null&&row.q!==0)throw Error('invalid donor empty item');return null;}
  if(!whole(row.id)||!whole(row.q??1,1))throw Error('invalid donor item ID/quantity');
  return{id:row.id,count:(row.q??1) as number,slot:(row.s??-1) as number};
 };
 for(const key of ['rp','bp','qv'])if(setup[key]!=null){const rows=setup[key];if(!Array.isArray(rows)||rows.length>28||rows.some(row=>decode(row)!==null))throw Error('unsupported native special container '+key);}
 if(setup.afi!=null&&Object.keys(object(setup.afi)).length)throw Error('additional filtered items need a separate native policy');
 const pack:OwnedKit['pack']=[],wear:OwnedKit['wear']=[];
 for(const [kind,max]of [['inv',28],['eq',14]] as const){
  const rows=setup[kind];if(!Array.isArray(rows)||rows.length>max)throw Error('donor inventory/equipment list missing or too large');
  const occupied=new Set<number>();
  rows.forEach((value,index)=>{
   const source=decode(value);if(!source)return;
   const sourceSlot=source.slot<0?index:source.slot;
   if(sourceSlot>=max||occupied.has(sourceSlot))throw Error('duplicate or invalid donor source slot');occupied.add(sourceSlot);
   if(!Object.hasOwn(items,String(source.id)))throw Error('donor item '+source.id+' needs explicit native binding');
   const id=items[String(source.id)] as number,item=nativeKitItem(id);
   if(kind==='eq'){
    if(item.slot===undefined||item.noted)throw Error('native item cannot be worn '+id);
    wear.push({id,count:source.count,slot:item.slot});
   }else{
    const existing=pack.find(row=>row.id===id);
    if(existing)existing.count+=source.count;else pack.push({id,count:source.count});
   }
  });
 }
 pack.sort((a,b)=>a.id-b.id);wear.sort((a,b)=>a.slot-b.slot);
 const kit=validateOwnedKit({bank:declaration.bank,cap:declaration.cap,maximumMoves:declaration.maximumMoves,pack,wear});
 if(pack.reduce((n,row)=>n+(nativeKitItem(row.id).stackable?1:row.count),0)>28)throw Error('native setup exceeds28 inventory slots');
 return kit;
}

if(import.meta.main){
 const [source,bindings,...extra]=process.argv.slice(2);if(!source||!bindings||extra.length)throw Error('Usage: bun scripts/microbot-loadout-import.ts <donor-setup.json> <native-bindings.json>');
 const read=(path:string)=>{const bytes=readFileSync(path);if(bytes.length>131072)throw Error('setup input exceeds128KiB');return JSON.parse(bytes.toString('utf8')) as unknown;};
 const kit=compileInventorySetup(read(source),read(bindings));process.stdout.write(JSON.stringify(kit,null,2)+'\n');
}
