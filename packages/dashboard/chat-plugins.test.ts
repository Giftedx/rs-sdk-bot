import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8'),ops=readFileSync(new URL('./operations.js',import.meta.url),'utf8');

function catalog(){
 let owner=true;const window:any={atlasOperator:()=>owner,atlasPublicHidden:['account','activity'],atlasPluginIdle:()=>true};
 const lines=[ops.split('\n').find(l=>l.startsWith(' const pluginNames=')),ops.split('\n').find(l=>l.startsWith(' const OPERATOR_ONLY=')),ops.split('\n').find(l=>l.startsWith(' const hiddenHere=')),ops.split('\n').find(l=>l.includes('window.atlasCommandPlugins='))].filter(Boolean).join('\n');
 new Function('window','isOwner',lines)(window,()=>owner);return {window,setOwner:(value:boolean)=>{owner=value;}};
}

function chat(window:any,id:string){
 const start=shell.indexOf("if(text.startsWith('::plugin ')){"),end=shell.indexOf("}else if(text.startsWith('::focus '))",start),opened:string[]=[],notes:string[]=[];
 const plugins=shell.split('\n').find(l=>l.startsWith('  const plugins='))!;
 new Function('window','text','showPlugin','notify',`const OPERATOR_PLUGINS=['operations','dispatch','raw','jobs','machine','stock','goals','prs'],PUBLIC_HIDDEN=['account','activity'];${plugins}${shell.slice(start,end)};}`)(window,'::plugin '+id,(id:string)=>opened.push(id),(note:string)=>notes.push(note));
 return {opened,notes};
}

test('chat and palette share a fresh policy-filtered catalog including command-only and unpinned plugins',()=>{
 const c=catalog();expect(typeof c.window.atlasCommandPlugins).toBe('function');
 for(const id of ['manager','operations','dispatch','raw','xp'])expect(chat(c.window,'  '+id+'  ').opened).toEqual([id]);
 c.setOwner(false);for(const id of ['manager','xp','fleet','info'])expect(chat(c.window,id).opened).toEqual([id]);
 for(const id of ['operations','dispatch','raw','account','activity','stock']){expect(chat(c.window,id).opened).toEqual([]);expect(chat(c.window,id).notes[0]).toContain('Unknown plugin');}
 const line=ops.split('\n').find(l=>l.startsWith('  const populate=()=>'))!,input={value:''},results:any={};
 const env:any={input,results,window:{atlasOperator:()=>true,atlasCommandPlugins:()=>[['manager','Configuration']]},pluginNames:{fleet:'Fleet'},hiddenHere:()=>false,bots:()=>[],caps:()=>[],tasks:()=>[],E:String};
 new Function(...Object.keys(env),line+';populate();')(...Object.values(env));expect(results.innerHTML).toContain('Configuration');expect(results.innerHTML).not.toContain('Fleet');
});

test('unknown, contextual and prototype plugin IDs are rejected before navigation in both roles',()=>{
 const c=catalog();for(const owner of [true,false]){c.setOwner(owner);for(const id of ['board','constructor','__proto__','toString','no-such-plugin']){expect(chat(c.window,id).opened).toEqual([]);expect(chat(c.window,id).notes[0]).toContain('Unknown plugin');}}
});

test('chat retains the existing static allowed plugin fallback when operations has not loaded',()=>{
 expect(chat({atlasOperator:()=>true},'world').opened).toEqual(['world']);expect(chat({atlasOperator:()=>false},'world').opened).toEqual(['world']);
 expect(chat({atlasOperator:()=>false},'jobs').opened).toEqual([]);expect(chat({atlasOperator:()=>true},'constructor').opened).toEqual([]);
});
