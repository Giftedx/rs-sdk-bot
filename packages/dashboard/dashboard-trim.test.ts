import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packQuests,expandQuests} from './quest-pack';
import {tailLines,cachedTail} from './jsonl-tail';
import {bindRetry} from './bind-retry';
import {withoutClocks,pushDue,HEARTBEAT_MS} from './publish-relay';

const journal=(done:number[],started:number[]=[])=>[1,2,3,4].map(id=>({id,name:'Q'+id,state:done.includes(id)?'complete':started.includes(id)?'started':'not started'}));

test('packed quests expand to the same journal and shrink the bot row',()=>{
 const bots=[{name:'A',quests:journal([1,3],[2])},{name:'B',quests:journal([])},{name:'C',quests:null},{name:'D',quests:[{id:9,name:'Other',state:'complete'}]}];
 const before=JSON.stringify(bots);
 const packed=packQuests(bots);
 expect(packed.questList).toHaveLength(4);
 expect(packed.bots[0].quests).toBeUndefined();expect(packed.bots[0].questsDone).toEqual([1,3]);expect(packed.bots[0].questsStarted).toEqual([2]);
 expect('questsUnknown' in packed.bots[0]).toBe(false);
 expect(packed.bots[1].questsDone).toEqual([]);expect('questsStarted' in packed.bots[1]).toBe(false);
 expect(packed.bots[2].quests).toBeNull();                       // never observed stays null
 expect(packed.bots[3].quests).toHaveLength(1);                   // a different journal stays whole
 expect(JSON.stringify(packed.bots).length).toBeLessThan(before.length);
 const state=expandQuests({bots:structuredClone(packed.bots),questList:packed.questList});
 expect(state.bots[0].quests).toEqual(bots[0].quests);expect(state.bots[1].quests).toEqual(bots[1].quests);
 expect(JSON.stringify(bots)).toBe(before);                       // the input is not changed
});

test('the page expands quests with the same rule as quest-pack.ts',()=>{
 const html=readFileSync(join(import.meta.dir,'index.html'),'utf8'),m=/function expandQuests\(state\)\{[\s\S]*?\n\}\n/.exec(html);
 expect(m).not.toBeNull();
 const page=new Function(m![0]+';return expandQuests;')() as (s:any)=>any;
 const packed=packQuests([{name:'A',quests:journal([2,4],[1])}]);
 expect(page({bots:structuredClone(packed.bots),questList:packed.questList}).bots[0].quests).toEqual(journal([2,4],[1]));
});

test('tailLines reads the last lines from the end, across chunk edges',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tail-')),f=join(dir,'x.jsonl');
 try{
  expect(tailLines(join(dir,'none'),3)).toEqual([]);
  const rows=Array.from({length:30000},(_,i)=>JSON.stringify({i,pad:'é'.repeat(20)}));
  writeFileSync(f,rows.join('\n')+'\n');
  expect(tailLines(f,3)).toEqual(rows.slice(-3));
  expect(tailLines(f,40000)).toHaveLength(30000);
  expect(tailLines(f,1)).toEqual(rows.slice(-1));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('cachedTail parses again only when the file changed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tail-')),f=join(dir,'v.jsonl');
 try{
  writeFileSync(f,'{"a":1}\n');const one=cachedTail<any>(f,10);expect(cachedTail<any>(f,10)).toBe(one);
  appendFileSync(f,'{"a":2}\n');expect(cachedTail<any>(f,10)).toHaveLength(2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a busy port is asked again, another error is not',async()=>{
 let calls=0;const waits:number[]=[];
 const busy=()=>{calls++;if(calls<3)throw Object.assign(Error('in use'),{code:'EADDRINUSE'});return 'bound';};
 expect(await bindRetry(busy,{waitMs:7,sleep:async ms=>{waits.push(ms);}})).toBe('bound');expect(calls).toBe(3);expect(waits).toEqual([7,7]);
 await expect(bindRetry(()=>{throw Object.assign(Error('denied'),{code:'EACCES'});},{sleep:async()=>{}})).rejects.toThrow('denied');
 let n=0;await expect(bindRetry(()=>{n++;throw Object.assign(Error('in use'),{code:'EADDRINUSE'});},{tries:3,sleep:async()=>{}})).rejects.toThrow('in use');expect(n).toBe(3);
});

test('a push waits while only clocks change, and goes after the heartbeat',()=>{
 const doc=(at:number,xp:number)=>JSON.stringify({now:at,hosted:{at},bots:[{at,skills:[{xp}]}]});
 const last={stable:withoutClocks(doc(1_800_000_000_000,5)),at:1_800_000_000_000};
 expect(pushDue(doc(1_800_000_060_000,5),last,1_800_000_060_000)).toBe(false);
 expect(pushDue(doc(1_800_000_060_000,6),last,1_800_000_060_000)).toBe(true);
 expect(pushDue(doc(1_800_000_000_000+HEARTBEAT_MS,5),last,1_800_000_000_000+HEARTBEAT_MS)).toBe(true);
 expect(pushDue(doc(1,1),null,1)).toBe(true);
});

test("the collector reads logs from their tail, keeps 5000 results, caches the vault tail and the proof scan",()=>{
 const server=['server.ts','server/config.ts','server/market.ts','server/world.ts','server/state.ts','server/routes.ts'].map(f=>readFileSync(join(import.meta.dir,f),'utf8')).join('\n');
 expect(server).toContain("tailJsonlFile<T>(file, n)");
 expect(server).toContain("const RESULT_KEEP = 5000;");
 expect(server).toContain("cachedTail<any>(FILES.vault, 100_000)");
 expect(server).not.toContain("tailJsonl<any>(FILES.vault");
 expect(server).toContain("proofStamp");
 expect(server).toContain("rankChangedAt");
 expect(server).toContain("await bindRetry(");
 expect(readFileSync(join(import.meta.dir,"publish.ts"),"utf8")).not.toContain("'pr','list'");
});
