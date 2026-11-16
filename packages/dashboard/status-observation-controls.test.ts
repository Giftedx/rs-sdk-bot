import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import './xp-tracker.js';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8'),X=(globalThis as any).atlasXp;
const section=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const combatSource=section('  // The combat level line','  // Banked XP line');
const chatSource=section('  function chatLookup(text){','  // Opponent information');
const hiscoreSource=section('  function hiscoreResults(name){','  function refreshHiscoreAccount(');
const skillsSource=section("    if(selectedTab==='skills')","    if(selectedTab==='equipment'&&");
const realSkill=(k:any)=>!/^Stat\d+$/.test(k.name)&&k.name!=='Overall';
const names=['Attack','Strength','Defence','Hitpoints','Ranged','Prayer','Magic','Mining','Runecraft'];
const levels37={Attack:72,Strength:1,Defence:1,Hitpoints:56,Ranged:1,Prayer:1,Magic:1};
const skillsOf=(levels:Record<string,any>)=>Object.entries(levels).map(([name,level])=>({name,level}));

function observed(input:any){
 const b={name:'StatusProbe',...input},env:any={b,S:{bots:[b]},window:{atlasXp:X},account:()=>b,E:String,safeName:String,nf:String,age:String,realSkill,
  skills:names,reported:()=>true,level:(name:string)=>b.skills?.find((k:any)=>k.name===name),asset:String,skillFile:String,recordedHp:()=>null,healthNote:()=>'',bankedLine:()=>''};
 return new Function(...Object.keys(env),`${combatSource}${chatSource}${hiscoreSource};return {line:()=>combatLine(b),chat:command=>chatLookup(command),hiscores:()=>hiscoreResults(b.name),panel:()=>{const selectedTab='skills';let html='';${skillsSource};return html;}};`)(...Object.values(env));
}

const noAdvice=(html:string)=>{expect(html).not.toContain('Next combat level');expect(html).not.toContain('<small>next:');};
const noCombat=(ui:any)=>{expect(ui.chat('!cmb')).toMatch(/(?:no combat(?: level)? reported|combat(?: level)?(?: is)? not reported)/i);expect(ui.line()).toContain('Combat level: —');noAdvice(ui.line());};
const overall=(html:string)=>html.match(/class="hs-cell hs-overall"[\s\S]*?<span>([^<]*)<\/span>/)?.[1];

test('empty, noncombat-only and partial combat observations do not fabricate a combat level or next-level advice',()=>{
 for(const input of [{},{skills:[]},{skills:[{name:'Mining',level:50}]},{skills:[{name:'Hitpoints',level:10}]}])noCombat(observed(input));
 for(const missing of Object.keys(levels37))noCombat(observed({skills:skillsOf(levels37).filter(k=>k.name!==missing)}));
});

test('positive safe-integer reported combat is preferred even without complete base skills',()=>{
 for(const combat of [1,44,126])for(const skills of [undefined,[],[{name:'Mining',level:50}],[{name:'Hitpoints',level:10}]]){
  const ui=observed({combat,skills});expect(ui.chat('!cmb')).toContain('combat level '+combat+'.');expect(ui.line()).toContain('Combat level: '+combat);noAdvice(ui.line());
 }
});

test('all seven valid base combat levels preserve the existing 2004 calculation and next-level advice',()=>{
 const samples=[levels37,{Attack:65,Strength:11,Defence:10,Hitpoints:56,Ranged:57,Prayer:1,Magic:1},
  {Attack:1,Strength:1,Defence:1,Hitpoints:10,Ranged:1,Prayer:1,Magic:1},
  {Attack:99,Strength:99,Defence:99,Hitpoints:99,Ranged:99,Prayer:99,Magic:99}];
 for(const levels of samples){
  const expected=X.combat(levels),ui=observed({skills:skillsOf(levels)});expect(ui.chat('!cmb')).toContain('combat level '+expected.level+'.');expect(ui.line()).toContain('Combat level: '+expected.level);
  if(expected.next)expect(ui.line()).toContain('Next combat level ('+(expected.level+1)+')');else noAdvice(ui.line());
  const matching=observed({combat:expected.level,skills:skillsOf(levels)});expect(matching.line()).toBe(ui.line());
 }
});

test('reported combat mismatches keep the observed level without advice calculated from different base stats',()=>{
 const ui=observed({combat:44,skills:skillsOf(levels37)});expect(ui.chat('!cmb')).toContain('combat level 44.');expect(ui.line()).toContain('Combat level: 44');noAdvice(ui.line());
});

test('missing, invalid or nonnumeric base levels cannot complete a derived combat observation',()=>{
 for(const level of [undefined,null,0,-1,100,1.5,'1',NaN,Infinity])noCombat(observed({skills:skillsOf({...levels37,Ranged:level})}));
});

test('invalid reported combat stays unknown without base stats and permits derivation from complete known base stats',()=>{
 for(const combat of [undefined,null,0,-1,1.5,'44',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  noCombat(observed({combat,skills:[]}));const ui=observed({combat,skills:skillsOf(levels37)});expect(ui.chat('!cmb')).toContain('combat level 37.');expect(ui.line()).toContain('Combat level: 37');expect(ui.line()).toContain('Next combat level (38)');
 }
});

test('Skills, Hiscores and total chat keep absent or ineligible skill observations unknown instead of total zero',()=>{
 for(const skills of [undefined,[],[{name:'Overall',level:2000}],[{name:'Stat0',level:99},{name:'Overall',level:2000}],
  [{name:'Attack',level:0}],[{name:'Attack',level:null}],[{name:'Attack',level:undefined}],[{name:'Attack',level:NaN}]]){
  const ui=observed({skills});expect(ui.panel()).toContain('Total level: —');expect(ui.chat('!total')).toContain('no levels reported');
  const html=ui.hiscores();expect(overall(html)).toMatch(/^(?:—|--|unknown)$/i);expect(html).toMatch(/Total level: (?:—|--|unknown|not reported)/i);expect(html).not.toContain('Total level: undefined');
 }
});

test('eligible reported partial skill sums remain useful while Overall and placeholder skills are excluded',()=>{
 const ui=observed({skills:[{name:'Attack',level:40},{name:'Runecraft',level:1},{name:'Overall',level:2000},{name:'Stat23',level:99}]});
 expect(ui.panel()).toContain('Total level: 41');expect(ui.chat('!total')).toContain('total level 41');expect(overall(ui.hiscores())).toBe('41');expect(ui.hiscores()).toContain('Total level: 41');
});
