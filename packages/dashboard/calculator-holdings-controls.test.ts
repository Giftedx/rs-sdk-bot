import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
require('./xp-tracker.js');
const X=(globalThis as any).atlasXp;
const escape=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');

function calculator(){
 const calc=shell.slice(shell.indexOf('  function calcBox(b,row){'),shell.indexOf("  const XP_STORE='atlas-xp-baselines';"));
 const commit=shell.split('\n').find(line=>line.startsWith('  function commitCalcTarget('))!;
 const handlersSource=shell.split('\n').filter(line=>line.startsWith("  body.addEventListener('change',e=>")||line.startsWith("  body.addEventListener('keydown',")).join('\n');
 const handlers:Record<string,any>={},bot={name:'CalculatorProbe',goalSkill:'Ranged',goalLevel:90,skills:[{name:'Ranged',xp:X.xpForLevel(72)+10}]};
 const env={body:{addEventListener:(type:string,handler:any)=>{handlers[type]=handler;}},window:{atlasXp:X},bot,E:escape,nf:String,dur:String,icon:()=>'',bestSpotLine:()=>''};
 const api=new Function(...Object.keys(env),`let calcSkill='Ranged',calcTarget=null,markup='';const skillActions=null;${calc}\nfunction refreshXp(){markup=calcBox(bot,{rate:1000});}\n${commit}\n${handlersSource}\nrefreshXp();return {html:()=>markup,target:()=>calcTarget};`)(...Object.values(env));
 const commitInput=(value:string,method:'Enter'|'change')=>{
  let prevented=false;const input={value,dataset:{},matches:(selector:string)=>selector==='[data-calc-target]'};
  if(method==='Enter')handlers.keydown({target:input,key:'Enter',preventDefault:()=>{prevented=true;}});
  else handlers.change({target:input});
  return prevented;
 };
 return {api,commitInput,bot};
}

for(const method of ['Enter','change'] as const)test('An empty calculator target uses the account goal after '+method,()=>{
 const c=calculator();
 expect(c.api.html()).toContain('value="90"');
 expect(c.commitInput('74',method)).toBe(method==='Enter');
 expect(c.api.target()).toBe(74);expect(c.api.html()).toContain('value="74"');
 expect(c.api.html()).toContain('<b>'+String(X.xpForLevel(74)-c.bot.skills[0]!.xp)+'</b> xp left');
 c.commitInput('',method);
 expect(c.api.html()).toContain('value="90"');expect(c.api.target()).toBeNull();
 expect(c.api.html()).toContain('<b>'+String(X.xpForLevel(90)-c.bot.skills[0]!.xp)+'</b> xp left');
});

const coal={id:453,name:'Coal',ask:10,bid:5,stock:20};
const herb={id:199,name:'Herb',ask:10,bid:5,stock:20},otherHerb={...herb,id:201};
function market(bots:any[],supplies:any[]=[coal],owner=true){
 const identity=shell.slice(shell.indexOf('  const priceName='),shell.indexOf('  function price(item)'));
 const source=shell.slice(shell.indexOf('  function gePanel(){'),shell.indexOf('  // Pull requests plugin'));
 const env={S:{bots,economy:{supplies}},window:{atlasOperator:()=>owner},E:escape,nf:String,icon:()=>''};
 return new Function(...Object.keys(env),`${identity}\nlet geQuery='',geAll=true,geLimit=80,geOpen=null;const age=()=>'';${source};return gePanel();`)(...Object.values(env)) as string;
}
const holdings=(html:string)=>new Map([...html.matchAll(/data-ge-src="([^"]*)"[\s\S]*?<span class="ge-ours">([^<]*)<\/span>/g)].map(match=>[match[1],match[2]]));

test('GE does not turn explicit invalid IDs or canonical base IDs into certain name-only holdings',()=>{
 const invalid=[{id:null},{id:undefined},{id:'453'},{id:-1},{id:453.5},{id:Number.MAX_SAFE_INTEGER+1},
  {id:453,baseId:null},{id:453,baseId:undefined},{id:453,baseId:'453'},{id:453,baseId:-1},{id:453,baseId:453.5}];
 for(const identity of invalid){
  const row={...identity,name:'Coal',count:4};
  expect(holdings(market([{bank:[row]}])).get('453')).toBe('?');
  expect(holdings(market([{bank:[{id:453,name:'Coal',count:2},row]}])).get('453')).toBe('2 + ?');
 }
});

test('GE retains exact and canonical counts, known wrong-variant zeroes and true legacy absence handling',()=>{
 const exact=holdings(market([{bank:[{id:199,name:'Herb',count:3},{id:200,baseId:199,name:'Herb (noted)',count:2},{id:201,name:'Herb',count:7}]}],[herb,otherHerb]));
 expect(exact.get('199')).toBe('5');expect(exact.get('201')).toBe('7');
 expect(holdings(market([{bank:[{id:201,name:'Herb',count:7}]}],[herb])).get('199')).toBe('0');
 expect(holdings(market([{bank:[]}])).get('453')).toBe('0');
 expect(holdings(market([{bank:[{name:'Coal',count:4}]}])).get('453')).toBe('4');
 const ambiguous=holdings(market([{bank:[{name:'Herb',count:4}]}],[herb,otherHerb]));
 expect(ambiguous.get('199')).toBe('?');expect(ambiguous.get('201')).toBe('?');
});

test('GE keeps invalid noted identity partial, excludes reserved and practice holdings, and hides owner stock publicly',()=>{
 const bots=[{bank:[{id:453,name:'Coal',count:2},{id:454,baseId:null,name:'Coal (noted)',count:4}]},
  {practice:true,bank:[{id:453,name:'Coal',count:100}]},{reserved:true,bank:[{id:453,name:'Coal',count:100}]}];
 expect(holdings(market(bots)).get('453')).toBe('2 + ?');
 const publicHtml=market(bots,[coal],false);
 expect(publicHtml).toContain('Coal');expect(publicHtml).not.toContain('class="ge-ours"');
 expect(publicHtml).not.toContain('Held in our banks');expect(publicHtml).not.toContain('>Ours<');
});
