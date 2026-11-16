import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {remoteBots} from './fleet-view';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const bestSource=operations.slice(operations.indexOf(' function bestInSlot(){'),operations.indexOf(' // Collection log (RuneLite'));
const collectionSource=operations.slice(operations.indexOf(' function heldIds(){'),operations.indexOf(' function moneyPrice('));
const rawSource=operations.slice(operations.indexOf(' function raw(){'),operations.indexOf(' // Game results,'));
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const sword={id:1277,name:'Bronze sword',count:1,slot:3};
const target={slot:'Weapon',ids:[1277],name:'Bronze sword',need:'A reported sword',source:'Reported item observations'};
const notice='Equipment is not reported for some accounts';

function stockPanels(bots:any[]){
 const env={bots:()=>bots,S:{economy:{gearTargets:[target]}},E:escape,nf:String,safeName:String,age:String,icon:()=>'',
  itemList:[[1277,'Bronze sword','Weapons']],itemListError:'',logCat:'Weapons',logQuery:''};
 return new Function(...Object.keys(env),bestSource+collectionSource+';return {best:bestInSlot(),collection:collectionLog(),held:heldIds()};')(...Object.values(env));
}

test('Stock excludes retained unobserved worn rows from Best in slot and Collection log',()=>{
 const now=1_000_000;
 const [bot]=remoteBots([{side:'cloud',at:now,accounts:[{name:'Remote',server:'rs-sdk-demo.fly.dev',at:now,bank:[],bankAt:now,inventory:[],equipment:[sword],equipmentObserved:false}]}],new Set(),new Map(),new Map(),now);
 expect(bot.equipment).toEqual([sword]);expect(bot.equipmentObserved).toBe(false);
 const panels=stockPanels([bot]);
 expect(panels.best).toContain('<b>0 / 1</b>');expect(panels.best).not.toContain('1 held');
 expect(panels.best).toMatch(/<strong[^>]*>not observed<\/strong>/);expect(panels.best).not.toContain('>missing<');
 expect(panels.best).toContain(notice);expect(panels.best).toContain('unreported worn items are excluded');
 expect(panels.held.has(1277)).toBe(false);
 expect(panels.collection).toContain('<b>0 / 1</b>');expect(panels.collection).not.toContain('held by Remote');
 expect(panels.collection).toContain('Bronze sword · not observed in reported holdings');
 expect(panels.collection).not.toContain(' · not held');expect(panels.collection).toContain(notice);
});

test('Stock preserves observed and legacy worn holdings without an unreported-equipment notice',()=>{
 for(const observed of [true,undefined]){
  const panels=stockPanels([{name:'Worker',at:1,equipment:[sword],...(observed===undefined?{}:{equipmentObserved:observed})}]);
  expect(panels.best).toContain('<b>1 / 1</b>');expect(panels.best).toContain('1 held');expect(panels.best).toContain('worn');
  expect(panels.best).not.toContain(notice);expect(panels.collection).not.toContain(notice);
  expect(panels.collection).toContain('<b>1 / 1</b>');expect(panels.collection).toContain('held by Worker');
  expect(panels.held.get(1277)).toEqual(new Set(['Worker']));
 }
});

test('Stock still counts known bank and pack items when that account does not report equipment',()=>{
 for(const place of ['bank','inventory']){
  const panels=stockPanels([{name:'Worker',at:1,bankAt:1,equipmentObserved:false,equipment:[{id:1291,name:'Bronze longsword',count:1}],
   [place]:[{id:1278,baseId:1277,name:'Bronze sword (noted)',count:2}]}]);
  expect(panels.best).toContain('<b>1 / 1</b>');expect(panels.best).toContain('1 held');
  expect(panels.best).toContain(place==='bank'?'bank':'pack');expect(panels.best).toContain(notice);
  expect(panels.collection).toContain('<b>1 / 1</b>');expect(panels.collection).toContain('held by Worker');
  expect(panels.held.has(1291)).toBe(false);
 }
});

test('Unheld Stock items use observation wording and practice equipment cannot count or raise the notice',()=>{
 const panels=stockPanels([{name:'Worker',bank:[],inventory:[],equipment:[],equipmentObserved:true},
  {name:'Practice',practice:true,equipmentObserved:false,equipment:[sword]}]);
 expect(panels.best).toContain('<b>0 / 1</b>');expect(panels.best).toMatch(/<strong[^>]*>not observed<\/strong>/);
 expect(panels.best).not.toContain('>missing<');expect(panels.best).not.toContain(notice);
 expect(panels.collection).toContain('Bronze sword · not observed in reported holdings');
 expect(panels.collection).not.toContain(' · not held');expect(panels.collection).not.toContain(notice);
 expect(panels.held.has(1277)).toBe(false);
});

test('Raw evidence preserves retained equipment together with its explicit observation flag',()=>{
 for(const equipmentObserved of [false,true]){
  const bot={name:'Worker',at:1,equipment:[sword],equipmentObserved};let copied='';
  const env={bots:()=>[bot],sel:'Worker',S:{now:2},tasks:()=>[],safeName:String,page:String,title:()=>'',
   button:(_label:string,_op:string,value:string)=>{copied=value;return '';},E:escape};
  new Function(...Object.keys(env),rawSource+';return raw();')(...Object.values(env));
  const account=JSON.parse(copied).account;
  expect(account.equipment).toEqual([sword]);expect(account.equipmentObserved).toBe(equipmentObserved);
 }
});
