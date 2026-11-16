import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const extract=(start:string,end:string)=>shell.slice(shell.indexOf(start),shell.indexOf(end,shell.indexOf(start)));

function setupHarness(kit:any){
 const code=extract('  let pkKits=',"  // Screenshot (RuneLite's Screenshot plugin)");
 const icons:any[]=[],priced:any[]=[],requests:string[]=[];
 const api=new Function('localStorage','fetch','asset','E','icon','nf','price','kit',`${code};pkKits=[kit];setupKit=kit.name;return {setupSlot,setupPanel};`)
  ({getItem:()=>null},(url:string)=>{requests.push(url);return new Promise(()=>{});},String,String,(item:any)=>{icons.push(item);return '';},String,(item:any)=>{priced.push(item);return item?.id===2503?{value:900}:item?.id===1135?{value:100}:null;},kit);
 return {...api,icons,priced,requests};
}

test('PK setups distinguish exact worn and carried variants and canonical bank notes through restock',()=>{
 const kit={name:'black',worn:{4:['Dragonhide body',1,2503]},carried:[['Dragonhide body',3,2503]]},ui=setupHarness(kit);
 const green={id:1135,name:'Dragonhide body',count:5,slot:4},black={id:2503,name:'Dragonhide body',count:1,slot:4};
 const note={id:2504,baseId:2503,name:'Dragonhide body',count:1,slot:4};
 expect(ui.setupSlot({equipment:[green]},4,green).cls).toBe(' setup-miss');
 expect(ui.setupSlot({equipment:[black]},4,black).cls).toBe(' setup-ok');
 expect(ui.setupSlot({equipment:[note]},4,note).cls).toBe(' setup-miss');
 const html=ui.setupPanel({equipment:[black],inventory:[green,{...black,count:1},{...note,count:4}],bank:[{...note,count:1},green]});
 expect(html).toContain('1 / 3 <small class="setup-bank setup-bank-short">bank 1</small>');
 expect(html).toContain('Restock: 1 Dragonhide body');expect(html).toContain('≈ 900 gp');
 expect(ui.icons).toContainEqual({id:2503,name:'Dragonhide body'});expect(ui.priced).toContainEqual({id:2503,name:'Dragonhide body'});
 expect(ui.requests).toContain('pk-kits.json?v=2');
});

test('legacy or unknown PK item identities remain unverified instead of green or definite restock totals',()=>{
 for(const want of [['Dragonhide body',1],['Dragonhide body',1,null]]){
  const ui=setupHarness({name:'legacy',worn:{4:want},carried:[want]}),item={id:2503,name:'Dragonhide body',count:1,slot:4};
  expect(ui.setupSlot({equipment:[item]},4,item).cls).not.toBe(' setup-ok');
  const html=ui.setupPanel({equipment:[item],inventory:[item],bank:[]});
  expect(html).toContain('Item IDs are not reported');expect(html).not.toContain('setup-have');expect(html).not.toContain('Every worn slot matches');expect(html).not.toContain('≈ 0 gp');
 }
 const ui=setupHarness({name:'exact',worn:{4:['Dragonhide body',1,2503]},carried:[['Dragonhide body',1,2503]]});
 const html=ui.setupPanel({equipment:[{name:'Dragonhide body',count:1,slot:4}],inventory:[{name:'Dragonhide body',count:1}],bank:[]});
 expect(html).toContain('item counts unknown');expect(html).not.toContain('setup-have');expect(html).not.toContain('≈ 0 gp');
});

test('a canonical ID alone cannot prove raw worn or carried identity but can count bank stock',()=>{
 const ui=setupHarness({name:'black',worn:{4:['Dragonhide body',1,2503]},carried:[['Dragonhide body',1,2503]]});
 const canonical={baseId:2503,name:'Dragonhide body',count:1,slot:4};
 expect(ui.setupSlot({equipment:[canonical]},4,canonical)).toEqual({cls:'',tip:' · kit match unverified: item ID not reported'});
 const pack=ui.setupPanel({equipment:[canonical],inventory:[canonical],bank:[]});
 expect(pack).toContain('? / 1');expect(pack).toContain('item counts unknown');expect(pack).not.toContain('setup-have');
 const bank=ui.setupPanel({equipment:[],inventory:[],bank:[canonical]});
 expect(bank).toContain('0 / 1 <small class="setup-bank">bank 1</small>');expect(bank).not.toContain('item counts unknown');expect(bank).not.toContain('Restock:');
});

test('the generated black dragonhide kit keeps the required content ID',()=>{
 const kits=JSON.parse(readFileSync(new URL('./client-assets/pk-kits.json',import.meta.url),'utf8'));
 expect(kits.find((k:any)=>k.name==='tribrid-snare-dhide').worn[4]).toEqual(['Dragonhide body',1,2503]);
});

test('teleport readiness separates unknown Magic, a low level and a met requirement',()=>{
 const code=extract('  function teleCasts(b){','  // Items kept on death');
 const api=new Function('E',`const spellbookData={staffs:{},spells:[['Varrock teleport',25,[['Law rune',1]]]]},curLevel=b=>b.skills?.find(s=>s.name==='Magic')?.level;${code};return {teleCasts,teleLine};`)(String);
 const bot=(level?:number)=>({inventory:[{name:'Law rune',count:2}],skills:level===undefined?[]:[{name:'Magic',level}]});
 expect(api.teleCasts(bot())[0].can).toBeNull();expect(api.teleLine(bot())).toContain('Magic level not reported');
 expect(api.teleCasts(bot(1))[0].can).toBe(false);expect(api.teleLine(bot(1))).toContain('too low');
 expect(api.teleCasts(bot(25))[0].can).toBe(true);expect(api.teleLine(bot(25))).not.toContain('tele-low');
});

test('minimap dots and hit targets use the shown floor while cross-floor pins stay labelled',()=>{
 const code=extract('  function minimap(){','  // A click on the minimap');
 const account={name:'Me',pos:{x:3200,z:3200,level:0}},roster=[['Ground',3201,3200,0,3],['Roof',3202,3200,1,3]];
 const bots=[account,{name:'Mate',pos:{x:3203,z:3200,level:0}},{name:'UpperMate',pos:{x:3204,z:3200,level:1}}];
 const paths:any[]=[],g:any=new Proxy({moveTo:(...p:any[])=>paths.push(['move',...p]),lineTo:(...p:any[])=>paths.push(['line',...p])},{get:(o:any,k)=>k in o?o[k]:()=>{}}),canvas={width:146,height:151,getContext:()=>g};
 const env:any={S:{bots,roster,map:{x0:3000,z0:3000,w:500,h:500,scale:1}},hud:{querySelector:(q:string)=>q.endsWith('canvas')?canvas:null},account:()=>account,mapWorld:()=>({bots,roster}),window:{},mode:'2d',st:()=>['off'],safeName:String,
  hl:{trail:true,idle:true,fails:true},trails:new Map([['roof',[{x:3200,z:3200,l:1},{x:3201,z:3200,l:1}]]]),idleRows:()=>[{name:'UpperMate',x:3204,z:3200,l:1,ms:180000}],failSpots:()=>[{x:3205,z:3200,l:1,names:['Failed'],reason:'stalled'}],
  recap:{state:'ok',name:'Me',data:{pos:{x:3206,z:3200,level:1}}},pinned:()=>({label:'NPC',tip:'NPC',tiles:[{x:3207,z:3200,l:1}]})};
 const hits=new Function(...Object.keys(env),`let miniView;${code};minimap();return minimap.hits;`)(...Object.values(env)).map((h:any)=>h[2]);
 expect(hits).toEqual(['Ground','Mate','NPC · floor 1']);expect(paths).toEqual([]);
 account.pos.level=1;
 const upper=new Function(...Object.keys(env),`let miniView;${code};minimap();return minimap.hits;`)(...Object.values(env)).map((h:any)=>h[2]);
 expect(upper).toContain('Roof');expect(upper).toContain('UpperMate');expect(upper).not.toContain('Ground');expect(upper).not.toContain('Mate');
});

test('a floor change at the same coordinates resets the old minimap trail',()=>{
 const code=extract('  function trackTrails(){','  function overlayMessage(){'),bot={name:'Me',inWorld:true,action:'move',pos:{x:3200,z:3200,level:0}},trails=new Map();
 const track=new Function('S','trails','idleSince',`${code};return trackTrails;`)({bots:[bot]},trails,new Map());
 track();bot.pos.level=1;track();expect(trails.get('Me')).toEqual([{x:3200,z:3200,l:1}]);
});

function spawnHarness(){
 const code=extract('  let npcSpawns=null','  // World Map icons');
 const list=extract('  function finderList(){','  // Respawn timers');
 const train=extract('  function trainInner(){','  function finderList(){'),retry=shell.split('\n').find(line=>line.includes("if(e.target.closest('[data-finder-retry]'))loadSpawns(true)"))!;
 const pending:Array<{resolve:(r:any)=>void;reject:(e:any)=>void}>=[],nodes:any={};
 let retryHandler:any;const body={querySelector:(selector:string)=>nodes[selector]??={innerHTML:''},addEventListener:(_kind:string,handler:any)=>{retryHandler=handler;}};
 const api=new Function('fetch','asset','body','S','safeName','E','nf',`const selectedPlugin='world',miniView={};${code};const combatText=()=>'',teleText=()=>'',thieveText=()=>'',meleeHitText=()=>'',npcHitsText=()=>'',killXpText=()=>'',lootText=()=>'',hourText=()=>'',trainRows=()=>[];${train}${list}${retry};return {loadSpawns,finderList,setQuery:q=>{finderQuery=q;}};`)
  (()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),String,body,{roster:[['Giantfan',3200,3200,0,3]]},String,String,String);
 return {...api,pending,nodes,retry:()=>retryHandler({target:{closest:()=>({})}})};
}

test('NPC spawn failures have a visible retry and keep player results available',async()=>{
 for(const failure of ['http','network','shape']){
  const ui=spawnHarness();ui.setQuery('gi');ui.loadSpawns();ui.loadSpawns();expect(ui.pending).toHaveLength(1);
  expect(ui.finderList()).toContain('Loading NPC spawns');expect(ui.finderList()).toContain('data-finder-player="Giantfan"');
  if(failure==='http')ui.pending[0]!.resolve(Response.json({}, {status:503}));
  else if(failure==='network')ui.pending[0]!.reject(Error('offline'));
  else ui.pending[0]!.resolve(Response.json({wrong:[]}));
  await Bun.sleep(0);
  expect(ui.finderList()).toContain('NPC spawns unavailable');expect(ui.finderList()).toContain('data-finder-retry');expect(ui.finderList()).toContain('data-finder-player="Giantfan"');expect(ui.finderList()).not.toContain('Loading NPC spawns');
  expect(ui.nodes['.train-box'].innerHTML).toContain('NPC spawns unavailable');
  ui.loadSpawns();expect(ui.pending).toHaveLength(1);ui.retry();expect(ui.pending).toHaveLength(2);ui.pending[1]!.resolve(Response.json([['Giant',3,3,[3200,3200,0]]]));await Bun.sleep(0);
  expect(ui.finderList()).toContain('data-finder-pick="Giant"');expect(ui.finderList()).not.toContain('unavailable');
 }
});

test('an empty successful NPC table is a finished search, not endless loading',async()=>{
 const ui=spawnHarness();ui.setQuery('cow');ui.loadSpawns();ui.pending[0]!.resolve(Response.json([]));await Bun.sleep(0);
 expect(ui.finderList()).toContain('No NPC or online player');expect(ui.finderList()).not.toContain('Loading');expect(ui.finderList()).not.toContain('unavailable');
});
