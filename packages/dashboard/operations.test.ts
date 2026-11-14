import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const operations=readFileSync(new URL('./operations.js',import.meta.url),'utf8');
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const healthSource=shell.slice(shell.indexOf('  function recordedHp('),shell.indexOf('  const curLevel='));
const currentHp=new Function('window',`${healthSource};return currentHp;`)({});
const recordedHp=new Function('window',`${healthSource};return recordedHp;`)({});
const now=1_000_000;
function publicRow(bot:any,withHelper=true){
 const code=operations.slice(operations.indexOf(' function publicRow('),operations.indexOf(' function fleet(){'));
 const window=withHelper?{atlasCurrentHp:(b:any)=>currentHp(b,now)}:{};
 return new Function('window','S','sel','st','overallRank','totalLevel','E','nf','compactRate','safeName','skillIcon','age',`${code};return publicRow;`)
  (window,{results:[]},null,()=>['','observed'],()=>null,()=>0,String,String,String,String,()=>'/skill.png',String)(bot) as string;
}

test('public fleet injury bars use current dated health, including zero, from the shared browser guard',()=>{
 const bot={name:'Worker',operation:'observed',inWorld:true,at:now-1000,hpAt:now-1000,hp:{now:2,max:20}};
 expect(publicRow(bot)).toContain('class="fl-hp" title="Hitpoints 2 / 20"');
 expect(publicRow({...bot,hp:{now:0,max:20}})).toContain('width:0%');
 expect(publicRow({...bot,hp:{now:20,max:20}})).not.toContain('class="fl-hp"');
 expect(publicRow({...bot,hp:{now:24,max:20}})).not.toContain('class="fl-hp"');
});

test('fresh presence cannot turn old, missing or invalid recorded HP into a public injury bar',()=>{
 const bot={name:'Worker',operation:'observed',inWorld:true,fresh:true,at:now-1,hpAt:now-60_000,hp:{now:0,max:20},live:{seen:now-1}};
 for(const value of [bot,{...bot,hpAt:null},{...bot,hpAt:undefined},{...bot,hpAt:now+1},{...bot,hpAt:now-1,inWorld:false}])
  expect(publicRow(value)).not.toContain('class="fl-hp"');
 const {hpAt:_date,...legacy}=bot;
 expect(publicRow({...legacy,at:now-60_000})).not.toContain('class="fl-hp"');
 expect(publicRow({...bot,hpAt:now-1},false)).not.toContain('class="fl-hp"');
});

test('raw account evidence retains the original HP observation date separately from the response date',()=>{
 const code=operations.slice(operations.indexOf(' function raw(){'),operations.indexOf(' // Game results,'));
 const bot={name:'Worker',at:now-1,hp:{now:2,max:20},hpAt:now-60_000};
 let copied='';
 const html=new Function('bots','sel','S','tasks','safeName','page','title','button','E',`${code};return raw();`)
  (()=>[bot],'Worker',{now},()=>[],String,(s:string)=>s,()=>'',(_label:string,_action:string,json:string)=>{copied=json;return '';},String) as string;
 const data=JSON.parse(copied);
 expect(data.observedAt).toBe(now);expect(data.account.at).toBe(bot.at);expect(data.account.hpAt).toBe(bot.hpAt);
 expect(data.account.hp).toEqual(bot.hp);expect(html).toContain('"hpAt": 940000');
});

const moneySource=operations.slice(operations.indexOf(' function moneyPrice('),operations.indexOf(' const stockTabs='));
const itemPricesById={1:{name:'Ring',value:10,ask:15,bid:8},2:{name:'Ring',value:100,ask:150,bid:80},4:{name:'Zero',value:0,ask:null,bid:null}};
const economy={itemPricesById,itemPricesByName:{zero:itemPricesById[4]},itemValues:{Ring:9999,Coins:1}};

test('operations pricing cannot borrow legacy aliases for explicit unknown or malformed identities',()=>{
 const {moneyPrice,moneyKey}=new Function('S','window',`${moneySource};return {moneyPrice,moneyKey};`)({economy},{});
 expect(moneyPrice({id:1,name:'Ring'}).value).toBe(10);expect(moneyPrice({id:3,baseId:2,name:'Ring (noted)'}).value).toBe(100);
 expect(moneyKey({id:3,baseId:2,name:'Ring (noted)'})).toBe('id:2');expect(moneyKey({name:'Ring'})).toBe('name:ring');
 expect(moneyPrice({name:'Ring'})).toBeNull();expect(moneyPrice({name:'Zero'}).value).toBe(0);
 expect(moneyPrice({id:995,name:'Other'}).value).toBe(1);expect(moneyPrice({name:'Coins'}).value).toBe(1);
 for(const item of [{id:617,name:'Coins'},{id:-1,name:'Coins'},{id:undefined,name:'Coins'},{id:1,baseId:undefined,name:'Ring'},{id:1,baseId:-1,name:'Ring'}])expect(moneyPrice(item)).toBeNull();
 expect(moneyKey({id:-1,name:'Coins'})).toBe('invalid:coins');
 const legacy=new Function('S','window',`${moneySource};return moneyPrice;`)({economy:{itemValues:{Ring:20}}},{});
 expect(legacy('Ring').value).toBe(20);expect(legacy({id:1,name:'Ring'})).toBeNull();
});

test('operations name-price authority survives null tables and legacy values cannot hide visible variant ambiguity',()=>{
 const run=(S:any)=>new Function('S','window',`${moneySource};return moneyPrice;`)(S,{});
 for(const table of [null,undefined,{}]){
  const price=run({economy:{itemPricesByName:table,itemValues:{Ring:9999}}});
  expect(price({name:'Ring'})).toBeNull();
 }
 const legacy={economy:{itemValues:{Ring:20},supplies:[{id:1,name:'Ring'}]},bots:[{bank:[{id:3,baseId:1,name:'Ring (noted)',count:2}]}]};
 expect(run(legacy)('Ring').value).toBe(20);
 for(const place of ['inventory','bank','equipment']){
  const state={...legacy,bots:[{...legacy.bots[0],[place]:[{id:2,name:'Ring',count:1}]}]};
  expect(run(state)({name:'Ring'})).toBeNull();
 }
 expect(run({...legacy,economy:{...legacy.economy,supplies:[{id:1,name:'Ring'},{id:2,name:'Ring'}]}})('Ring')).toBeNull();
});

test('the displayed bank ledger retains exact variants, canonical notes and separate unpriced name-only stock',()=>{
 const code=operations.slice(operations.indexOf(' function stock(){'),operations.indexOf(' // Fleet deck:'));
 const bank=[{id:1,name:'Ring',count:2},{id:2,name:'Ring',count:3},{id:3,baseId:1,name:'Ring (noted)',count:5},
  {name:'Ring',count:9},{id:4,name:'Zero',count:1},{id:617,name:'Coins',count:100},{id:-1,name:'Coins',count:4},{name:'Odd',count:8}];
 const bots=[{name:'Worker',bankAt:1,bank}],env:any={S:{economy},window:{},stockView:'stock',stockAccount:'',stockQuery:'',bots:()=>bots,page:String,title:()=>'',stockTabs:()=>'',E:String,nf:String,gp:String,safeName:String,age:String,button:()=>'',icon:()=>''};
 const html=new Function(...Object.keys(env),`${moneySource}${code};return stock();`)(...Object.values(env)) as string;
 expect(html).toContain('<b>370 + ?</b>');expect(html).toContain('4 item kinds without a price');expect(html).toContain('<b>7</b><span>item kinds</span>');
 expect(html).toContain('<strong>7 <small class="op-sub">· 70</small>');expect(html).toContain('<strong>3 <small class="op-sub">· 300</small>');
 expect(html).toContain('<strong>9 <small class="op-sub">· unpriced</small>');expect(html).toContain('<strong>1 <small class="op-sub">· 0</small>');
 expect(html).not.toContain('9999');
});

test('activity flow totals and tooltips price retained IDs and mark unknown historical names as partial',()=>{
 const code=operations.slice(operations.indexOf('  function flowBoxes(kind){'),operations.indexOf("if(activityFilter==='shots')"));
 const flow={at:now,since:now-3_600_000,loot:[{id:1,name:'Ring',count:2},{id:2,name:'Ring',count:3},{id:3,baseId:1,name:'Ring (noted)',count:2},{name:'Ring',count:7},{id:617,name:'Coins',count:4}],used:[{id:1,name:'Ring',count:1}]};
 const env:any={S:{economy},window:{},bots:()=>[{name:'Worker',flow}],E:String,nf:String,gp:String,safeName:String,age:String,icon:()=>''};
 const html=new Function(...Object.keys(env),`${moneySource}${code};return flowBoxes('loot');`)(...Object.values(env)) as string;
 expect(html).toContain('<strong>340 gp + ?');expect(html).toContain('Ring × 2 · 20 gp');expect(html).toContain('Ring × 3 · 300 gp');
 expect(html).toContain('Ring (noted) × 2 · 20 gp');expect(html).toContain('Ring × 7 · unpriced');expect(html).toContain('Coins × 4 · unpriced');
 expect(html).toContain('net 330 gp (priced items only; 2 unpriced item kinds)');
});

test('transfer summaries retain known values and aggregate unpriced coverage without claiming a complete zero',()=>{
 const code=operations.slice(operations.indexOf(' function transfers(){'),operations.indexOf(' // Best in slot (Supply ledger tab):'));
 const flow=[
  {from:'Worker',to:'Banker',value:20,coins:0,valueComplete:true,unpriced:0,items:[{id:1,name:'Ring',count:2}]},
  {from:'Worker',to:'Banker',value:0,coins:0,valueComplete:false,unpriced:1,items:[{id:2,name:'Ring',count:3}]},
  {from:'Worker',to:'Banker',value:0,coins:0,valueComplete:false,unpriced:2,items:[{name:'Ring',count:4}]},
  {from:'Banker',to:'Worker',value:0,coins:0,valueComplete:false,items:[{name:'Unknown',count:1}]},
 ];
 const env:any={S:{vault:{flow}},window:{},bots:()=>[{name:'Worker'},{name:'Banker'}],E:String,nf:String,gp:String,safeName:String,age:String};
 const html=new Function(...Object.keys(env),`${moneySource}${code};return transfers();`)(...Object.values(env)) as string;
 expect(html).toContain('<strong>20 + 3 unpriced</strong>');expect(html).toContain('<strong>0 + ? unpriced</strong>');
 expect(html).toContain('Ring × 4 · Ring × 3 · Ring × 2');expect(html).not.toContain('Ring × 9');
 expect(html).not.toContain('<strong>0</strong>');
});

test('the account HP KPI dates recorded health and labels it current only while the current guard passes',()=>{
 const code=operations.slice(operations.indexOf(' function account(){'),operations.indexOf(' function raw(){'));
 const html=(bot:any,helpers=true)=>{
  const window=helpers?{atlasOperator:()=>false,atlasRecordedHp:(b:any)=>recordedHp(b,now),atlasCurrentHp:(b:any)=>currentHp(b,now)}:{atlasOperator:()=>false};
  const env:any={window,bots:()=>[bot],sel:'Worker',meta:null,tasks:()=>[],page:String,title:()=>'',button:()=>'',safeName:String,age:(at:number)=>String(now-at),badge:()=>'',issues:()=>[],E:String,nf:String,gp:String};
  return new Function(...Object.keys(env),`${code};return account();`)(...Object.values(env)) as string;
 };
 const bot={name:'Worker',operation:'observed',inWorld:true,at:now-1,hpAt:now-60_000,hp:{now:2,max:20}};
 expect(html(bot)).toContain('<b>2 / 20</b><span>recorded hitpoints</span><small>60000 old</small>');
 expect(html({...bot,hpAt:now-1})).toContain('<b>2 / 20</b><span>current hitpoints</span><small>1 old</small>');
 for(const b of [{...bot,hpAt:null},{...bot,hp:{now:NaN,max:20}},{...bot,hpAt:now+1}])expect(html(b)).toContain('<b>—</b><span>recorded hitpoints</span><small>Not reported</small>');
 expect(html(bot,false)).toContain('<b>—</b><span>recorded hitpoints</span>');
});
