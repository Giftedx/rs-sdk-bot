import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hostedPageExpandsQuests} from './publish';

test('packed quests are pushed only when the hosted page can expand them',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hosted-page-'));
 try{
  expect(hostedPageExpandsQuests(dir)).toBe(false);
  mkdirSync(join(dir,'site'));
  writeFileSync(join(dir,'site','index.html'),'<script>function receive(j){}</script>');expect(hostedPageExpandsQuests(dir)).toBe(false);
  writeFileSync(join(dir,'site','index.html'),'<script>function expandQuests(state){}</script>');expect(hostedPageExpandsQuests(dir)).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
 const source=readFileSync(join(import.meta.dir,'publish.ts'),'utf8');
 expect(source).toContain("hostedPageExpandsQuests(join(DIR,'repo'))");
 expect(source).toContain('expandQuests(state)');
});

test('the Follow in 3D panel fetches its player from /api/player and no longer reads state.lookups',async()=>{
 const shell=readFileSync(join(import.meta.dir,'client-shell.js'),'utf8');
 expect(shell).not.toContain('S.lookups?.[other');
 const code=/const followLookups=new Map\(\);[\s\S]*?window\.atlasFollowLookup=followLookup;/.exec(shell)![0];
 const urls:string[]=[],overlays:number[]=[];let now=1000;
 const win:any={atlasFollowOther:'Rival'};
 const run=new Function('fetch','window','overlay','Date',code+';return followLookup;')(
  async(url:string)=>{urls.push(url);return {ok:true,json:async()=>({name:'Rival',rows:[{board:'Overall',rank:5,level:200}]})};},win,()=>overlays.push(1),{now:()=>now});
 expect(run('Rival')).toBeNull();                       // first call starts the fetch
 await new Promise(r=>setTimeout(r,10));
 expect(urls).toEqual(['/api/player?name=Rival']);expect(overlays).toHaveLength(1);
 expect((run('Rival') as any).rows[0].rank).toBe(5);     // cached
 expect(urls).toHaveLength(1);
 now+=61000;run('Rival');await new Promise(r=>setTimeout(r,10));expect(urls).toHaveLength(2);   // refreshed after a minute
});
