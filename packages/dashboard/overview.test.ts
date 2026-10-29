import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function overview(){'),html.indexOf('const LOCAL_ITEMS='));
function render(bots:any[],rows:any[]=[]){
 let output='';
 const run=new Function('S','liveBots','SKILL_ICONS','skills','boardKey','safeName','age','observedAt','E','icon','skillIcon','goalMetrics','put',source+';overview();');
 run({now:1000},()=>bots,{attack:'local'},(b:any)=>b.skills||[],(s:string)=>s.toLowerCase(),(s:string)=>s,()=> 'old', (at:number)=>at>=900,(s:any)=>String(s??''),()=>'<i></i>',()=>'<img>',()=>Array.from({length:6},(_,i)=>({rows:i===1?rows:[],next:'Next '+i,blocker:'Block '+i})),(_:string,s:string)=>output=s);
 return output;
}
test('overview marks historical skill peaks and excludes future observations',()=>{
 const result=render([{name:'Old',at:100,skills:[{name:'Attack',level:80}]},{name:'New',at:999,skills:[{name:'Attack',level:70}]},{name:'Future',at:1001,skills:[{name:'Attack',level:99}]}]);
 expect(result).toContain('~80');expect(result).not.toContain('Future');expect(result).not.toContain('~99');
 expect(result.match(/data-lane=/g)).toHaveLength(6);
});
test('overview keeps missing skills and gear unknown and preserves blocker text',()=>{
 const result=render([],[{label:'Hat · Dragon med helm',value:'not observed · Defence 60'}]);
 expect(result).toContain('<b>?</b>');expect(result).toContain('not observed');expect(result).toContain('Blocker: Block 0');expect(result).not.toContain('mastered');
 expect(html).toContain("url('/items.png')");expect(html).not.toContain("url('/icons.png')");
});
