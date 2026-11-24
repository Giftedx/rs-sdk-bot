import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {configTable} from './appearance';
import {buildItemExamine,catalogueIconAliases,itemExamine,projectItemExamine} from './item-examine';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const examineSource=shell.slice(shell.indexOf('  function examineOf('),shell.indexOf('  // Item stats'));
const catalogue=()=>configTable(readFileSync(new URL('../../vendor/rs-sdk/server/content/pack/obj.pack',import.meta.url),'utf8'),[
 readFileSync(new URL('../../vendor/rs-sdk/server/content/scripts/quests/quest_demon/configs/demon.obj',import.meta.url),'utf8'),
]);

test('the complete catalogue keeps actual same-name quest keys distinct and proves aliases before projection',()=>{
 const facts=buildItemExamine(catalogue()),keys=[2399,2400,2401].map(id=>({id,name:'Key'}));
 expect(keys.map(key=>itemExamine(facts,key))).toEqual(['A key given to me by Wizard Traiborn.','A key given to me by Captain Rovin.','A key I found in a drain.']);
 expect(itemExamine(facts,'Key')).toBeNull();
 expect(projectItemExamine(facts,[keys[0]!])).toEqual({itemExamineById:{2399:'A key given to me by Wizard Traiborn.'},itemExamineByName:{}});
 const full=new Map([[1,{name:'Safe',desc:'Same fact.'}],[2,{name:'Safe',desc:'Same fact.'}],
  [3,{name:'Incomplete',desc:'Known'}],[4,{name:'Incomplete'}],[5,{name:'Unique',desc:'Only one.'}]]);
 const safe=buildItemExamine(full);
 expect(itemExamine(safe,'Safe')).toBe('Same fact.');expect(itemExamine(safe,'Incomplete')).toBeNull();
 expect(catalogueIconAliases(full)).toEqual({Unique:5});
 expect(catalogueIconAliases(catalogue()).Key).toBeUndefined();
});

test('invalid or unknown raw identities never borrow an examine alias or a certificate base description',()=>{
 const facts=buildItemExamine(new Map([[1,{name:'Safe',desc:'Known fact.'}]]));
 for(const id of [undefined,null,-1,1.5,'1',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,999])
  expect(itemExamine(facts,{id,baseId:1,name:'Safe'})).toBeNull();
 expect(itemExamine(facts,{id:2,baseId:1,name:'Safe (noted)'})).toBeNull();
 expect(itemExamine(facts,{baseId:1,name:'Safe'})).toBe('Known fact.');
 expect(itemExamine(facts,'constructor')).toBeNull();
});

test('the actual server projection keeps sibling descriptions regardless of account and list order',()=>{
 const server=readFileSync(new URL('./server/state/build.ts',import.meta.url),'utf8');
 const start=server.indexOf('    const visiblePrices:'),end=server.indexOf('    for (let i = 0; i < v.items.length; i++)',start);
 expect(start).toBeGreaterThanOrEqual(0);
 expect(end).toBeGreaterThan(start);
 const line=server.split('\n').find(line=>line.includes('...projectItemExamine('))!;
 expect(line).toBeDefined();
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(`${server.slice(start,end)}\nconst result={${line}};`);
 const project=new Function('bots','itemExamines','projectItemExamine',code+'return result;'),facts=buildItemExamine(catalogue());
 const first={inventory:[{id:2399,name:'Key'}],equipment:[{id:2400,name:'Key'}]},second={bank:[{id:2401,name:'Key'}]};
 const forward=project([first,second],facts,projectItemExamine),reverse=project([second,first],facts,projectItemExamine);
 expect(reverse).toEqual(forward);expect(forward.itemExamineById[2399]).toBe('A key given to me by Wizard Traiborn.');
 expect(forward.itemExamineById[2401]).toBe('A key I found in a drain.');expect(forward.itemExamineByName).toEqual({});
});

test('inventory and equipment Examine actions consume their exact raw item instead of a sibling name',()=>{
 const projected=projectItemExamine(buildItemExamine(catalogue()),[{id:2399,name:'Key'},{id:2400,name:'Key'}]);
 const S={economy:{...projected,itemExamine:{Key:'Wrong legacy sibling.'}}};
 const select=new Function('S',`${examineSource};return examineOf;`)(S);
 expect(select({id:2399,name:'Key'})).toBe('A key given to me by Wizard Traiborn.');
 for(const item of [{name:'Key'},{id:999,name:'Key'},{id:null,name:'Key'},{id:999,baseId:2399,name:'Key (noted)'}])expect(select(item)).toBeNull();
 const start=shell.indexOf("  hud.addEventListener('contextmenu',e=>"),contextSource=shell.slice(start,shell.indexOf("  document.addEventListener('click'",start));
 const run=(worn:boolean)=>{
  let handler:any,context:any;const notices:string[]=[];
  const item={id:worn?2400:2399,name:'Key',count:1,slot:3},account={inventory:[item],equipment:[item]};
  const environment:any={S,hud:{addEventListener:(_event:string,fn:any)=>handler=fn},account:()=>account,
   document:{createElement:()=>context={style:{},remove:()=>{}},body:{append:()=>{}}},innerWidth:1000,innerHeight:800,
   E:String,nf:String,gp:String,price:()=>null,notify:(s:string)=>notices.push(s),toast:()=>{}};
  new Function(...Object.keys(environment),`let context=null;${examineSource}${contextSource}`)(...Object.values(environment));
  handler({preventDefault:()=>{},clientX:1,clientY:1,target:{closest:()=>({dataset:worn?{equipment:'3'}:{item:'0'}})}});
  context.onclick({target:{closest:(selector:string)=>selector==='[data-examine]'}});
  return notices;
 };
 expect(run(false)).toEqual(['A key given to me by Wizard Traiborn.']);
 expect(run(true)).toEqual(['A key given to me by Captain Rovin.']);
});
