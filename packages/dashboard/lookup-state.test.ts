import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
test('pending or failed lookups do not assert that a player is offline',()=>{
 const code=shell.slice(shell.indexOf('  function lookupCard(l){'),shell.indexOf('  function lookup(name){'));
 const card=new Function('l','E','age',`${code};return lookupCard(l);`);
 for(const note of ['Looking up…','Lookup failed']){
  const html=card({name:'Worker',rows:null,note},String,String);
  expect(html).toContain('presence not loaded');expect(html).not.toContain('not seen online');
 }
 expect(card({name:'Worker',rows:null,online:false},String,String)).toContain('not seen online');
});
