import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const section=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));
const table=(name:string)=>JSON.parse(readFileSync(new URL('./client-assets/'+name,import.meta.url),'utf8'));
const book=table('spellbook.json'),questData=table('quest-reqs.json'),gatherData=table('gather-chance.json');
const fireStaff={slot:3,id:1387,name:'Staff of fire',count:1},air={id:556,name:'Air rune',count:3},law={id:563,name:'Law rune',count:1},fire={id:554,name:'Fire rune',count:1};
const unknown={equipmentObserved:false},knownFlags=[{equipmentObserved:true},{}];

function spells(){
 const code=section("  // Equipment Stats (the game's","  // Items kept on death (RuneLite's");
 return new Function('asset','fetch','E','window','book',`${code};spellbookData=book;itemBonusData={1387:new Array(13).fill(0)};return {runeCasts,bestSpell,teleCasts,teleLine,wornBonuses,maxHit};`)
  (String,()=>new Promise(()=>{}),String,{},book);
}

test('unknown worn staffs do not supply free runes to actual rune and Inventory teleport consumers',()=>{
 const ui=spells(),runes=book.spells.find((row:any)=>row[0]==='Varrock teleport')[2];
 const base={equipment:[fireStaff],inventory:[air,law],skills:[{name:'Magic',level:25}]};
 expect(ui.runeCasts({...base,...unknown},runes)).toBe(0);expect(ui.teleCasts({...base,...unknown}).some((s:any)=>s.name==='Varrock teleport')).toBe(false);expect(ui.teleLine({...base,...unknown})).not.toContain('Varrock teleport');
 for(const flags of knownFlags){expect(ui.runeCasts({...base,...flags},runes)).toBe(1);expect(ui.teleCasts({...base,...flags}).find((s:any)=>s.name==='Varrock teleport')).toMatchObject({casts:1,can:true});}
});

test('known pack runes remain usable when worn equipment is unobserved',()=>{
 const ui=spells(),b={...unknown,equipment:[fireStaff],inventory:[air,law,fire],skills:[{name:'Magic',level:25}]};
 expect(ui.teleCasts(b).find((s:any)=>s.name==='Varrock teleport')).toMatchObject({casts:1,can:true});const html=ui.teleLine(b);expect(html).toContain('Varrock teleport');expect(html).toMatch(/equipment not reported/i);expect(html).toMatch(/pack runes/i);
 const spellTitle=html.match(/<span[^>]*title="([^"]*)"/)?.[1]||'';expect(spellTitle).toMatch(/equipment not reported/i);expect(spellTitle).toMatch(/pack runes/i);
});

test('a required combat staff must be observed even when its spell runes are known',()=>{
 const ui=spells(),b={equipment:[{slot:3,id:1409,name:'Staff of iban',count:1}],inventory:[{id:560,name:'Death rune',count:30},{...fire,count:100}],skills:[{name:'Magic',level:50}]};
 expect(ui.bestSpell({...b,...unknown})).toBeNull();
 for(const flags of knownFlags)expect(ui.bestSpell({...b,...flags})).toMatchObject({name:'Iban Blast',casts:20});
});

function questItems(){
 const code=section('  function questItems(b,name){','  const reqHtml=');
 return new Function('questReqData','E',`${code};return {questItems,itemHtml};`)(questData,String);
}

test('quest item counts exclude unknown worn gear, keep short counts unknown, and retain sufficient pack or bank evidence',()=>{
 const ui=questItems(),amulet={slot:2,id:552,name:'Ghostspeak amulet',count:1},base={equipment:[amulet],inventory:[],bank:[],bankAt:1};
 const get=(b:any)=>ui.questItems(b,'Nature Spirit').find((r:any)=>r.text==='Ghostspeak amulet');
 const htmlClass=(b:any)=>ui.itemHtml(b,'Nature Spirit').match(/<span class="([^"]+)"[^>]*>Ghostspeak amulet<\/span>/)?.[1];
 expect(get({...base,...unknown})).toMatchObject({have:0,ok:null});expect(htmlClass({...base,...unknown})).toBe('req-unknown');
 const unknownHtml=ui.itemHtml({...base,...unknown},'Nature Spirit');expect(unknownHtml).toMatch(/equipment not reported/i);expect(unknownHtml).toMatch(/(?:reported|known)[^<"]*0|0[^<"]*(?:reported|known)/i);
 for(const flags of knownFlags){expect(get({...base,...flags})).toMatchObject({have:1,ok:true});expect(htmlClass({...base,...flags})).toBe('req-ok');expect(get({...base,equipment:[],...flags})).toMatchObject({have:0,ok:false});}
 for(const held of [{inventory:[amulet]},{bank:[amulet]}]){const b={...base,...unknown,...held};expect(get(b)).toMatchObject({have:1,ok:true});expect(htmlClass(b)).toBe('req-ok');}
});

function gather(){
 const code=section("  // Gather chance (RuneLite's Woodcutting and Mining overlays",'  function calcBox(');
 return new Function('fetch','asset','E','nf','bestSpot','data',`let calcSkill='Woodcutting',sourcePin=null;${code};gatherData=data;return {gatherText,bestSpotLine};`)
  (()=>new Promise(()=>{}),String,String,String,()=>({name:'Willow tree',item:'Willow logs',level:30}),gatherData);
}

test('actual gather chance and calculator spot text use known pack tools and distinguish unknown from observed missing axes',()=>{
 const ui=gather(),axe={id:1359,name:'Rune axe',slot:3,count:1},bronze={id:1351,name:'Bronze axe',count:1},base={equipment:[axe],inventory:[]};
 expect(ui.gatherText({...base,...unknown},'Willow logs',40,'Woodcutting')).toBe('axe not reported');expect(ui.bestSpotLine({...base,...unknown},40)).toContain('axe not reported');expect(ui.bestSpotLine({...base,...unknown},40)).not.toContain('with the rune axe');
 const packOnly=ui.gatherText({inventory:[bronze],equipment:[],equipmentObserved:true},'Willow logs',40,'Woodcutting');
 const carried=ui.gatherText({...base,inventory:[bronze],...unknown},'Willow logs',40,'Woodcutting');expect(carried).toContain(packOnly);expect(carried).toMatch(/equipment not reported|worn tool not reported/i);expect(packOnly).toContain('with the bronze axe');
 for(const flags of knownFlags){expect(ui.gatherText({...base,...flags},'Willow logs',40,'Woodcutting')).toContain('with the rune axe');expect(ui.gatherText({inventory:[],equipment:[],...flags},'Willow logs',40,'Woodcutting')).toBe('no axe held');}
 expect(ui.gatherText({...base,...unknown},'Iron ore',40,'Mining')).toBe(ui.gatherText({...base,equipmentObserved:true},'Iron ore',40,'Mining'));
});

function infoboxes(b:any){
 const element:any={innerHTML:''},code=section('  function infoboxes(){','  // Board progress');
 const env:any={account:()=>({name:'GearProbe',skills:[],...b}),hud:{querySelector:()=>element},S:{bots:[],roster:[]},E:String,asset:String,skillFile:String,dur:String,age:String,realSkill:()=>true,icon:(item:any)=>'['+(typeof item==='object'?item.id:item)+']',wildLevel:()=>0};
 new Function(...Object.keys(env),`${code};infoboxes();`)(...Object.values(env));return element.innerHTML as string;
}

const ammo={slot:13,id:892,name:'Rune arrow',count:120},glory={slot:2,id:1706,name:'Amulet of glory(1)',count:1};
test('ammo and charge infoboxes never claim unobserved worn gear but retain observed and legacy worn facts',()=>{
 const base={inventory:[],equipment:[ammo,glory]},hidden=infoboxes({...base,...unknown});expect(hidden).not.toContain('class="infobox ammo"');expect(hidden).not.toContain('Last charge:');
 for(const flags of knownFlags){const html=infoboxes({...base,...flags});expect(html).toContain('class="infobox ammo" title="Rune arrow × 120"');expect(html).toContain('title="Last charge: Amulet of glory(1)"');}
});

test('known pack charge warnings remain while unobserved worn duplicates and bank-only items do not count',()=>{
 const html=infoboxes({...unknown,equipment:[ammo,glory],inventory:[glory],bank:[glory]});expect(html).not.toContain('class="infobox ammo"');expect(html).toContain('title="Last charge: Amulet of glory(1)"');expect(html).toMatch(/title="Last charge: Amulet of glory\(1\)"[\s\S]*?<span>1<\/span>/);
 expect(infoboxes({...unknown,equipment:[],inventory:[],bank:[glory]})).not.toContain('Last charge:');
});

test('hour-rate weapon reads remain stopped by the existing worn-bonus observation guard',()=>{
 const ui=spells(),b={...unknown,equipment:[fireStaff],inventory:[air,law,fire]},known={...b,equipmentObserved:true};
 expect(ui.wornBonuses(known)).not.toBeNull();expect(ui.wornBonuses(b)).toBeNull();
 const code=section('  function hourRates(name,safeOnly){','  function hourText('),npc=[42,30,1,0,0,0,0,0,30,30,33,31,2,60,1000,60];
 const rate=new Function('account','npcDefData','wornBonuses','maxHit',`${code};return hourRates;`)(()=>b,{'Moss giant':[npc]},ui.wornBonuses,ui.maxHit);
 expect(rate('Moss giant')).toBeNull();
});
