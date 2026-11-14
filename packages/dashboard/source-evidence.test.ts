import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {itemSources} from './gen-map-data';
import {sourceTiles} from '../knowledge/src/item-sources';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');
const escape=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const names={npc:(name:string)=>name,item:(name:string)=>name};
function render(data:unknown,id='526'){
 const start=shell.indexOf('  function geSourceCost('),end=shell.indexOf('  // The head (counts and the price age)');
 if(start<0||end<=start)throw Error('Missing source evidence consumer');
 return new Function('itemSourcesData','E','id',`const sourcePin=null,loadItemSources=()=>{},geTele=()=>'';${shell.slice(start,end)};return geSources(id);`)(data,escape,id) as string;
}
const source=(basis:string,ticks:number|null,note='')=>({kind:'pickup',spawns:4,tiles:[{x:3200,z:3200,level:0}],cost:{helperTicksPerUnit:ticks,ticksBasis:basis,ticksNote:note}});

test('source costs reach actual source choices with basis, units and escaped conditions',()=>{
 const data=itemSources([{id:526,sources:[source('model',2.5,'level 1 <tool> & bank travel excluded'),source('measured',0.25,'three runs; helper trade included'),source('content',0)]}],names);
 const html=render(data);
 expect(html).toContain('2.5 helper ticks/item (estimate)');
 expect(html).toContain('0.25 helper ticks/item (measured)');
 expect(html).toContain('0 helper ticks/item (content)');
 expect(html).toContain('level 1 &lt;tool&gt; &amp; bank travel excluded');
 expect(html).toContain('three runs; helper trade included');
 expect(html).not.toContain('<tool>');
 expect(html).toContain('data-src-pin="0"');
});

test('legacy and unknown source costs keep their pins without inventing throughput',()=>{
 const data=itemSources([{id:526,sources:[source('unknown',null)]}],names);
 const html=render(data);
 expect(html).toContain('Show on map');expect(html).not.toContain('helper ticks/item');
 expect(render({526:[['pickup','Legacy floor source',[3200,3200,0]]]})).not.toContain('helper ticks/item');
 for(const cost of [{helperTicksPerUnit:-1,ticksBasis:'model'},{helperTicksPerUnit:1,ticksBasis:'unknown'},{helperTicksPerUnit:Infinity,ticksBasis:'measured'}]){
  expect(render({526:[['pickup','Unknown cost',[3200,3200,0],cost]]})).not.toContain('helper ticks/item');
 }
});

test('the actual Apple pie source distinguishes cash outlay from object value and conditional restock wait',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../../knowledge/item-sources.json',import.meta.url),'utf8'));
 const pie=catalog.items.find((item:any)=>item.id===2323);
 const data=itemSources([pie],names),html=render(data,'2323');
 expect(html).toContain('base value 30 gp');
 expect(html).toContain('46.6 gp/item (estimate)');
 expect(html).toContain('0.1 helper ticks/item (estimate)');
 expect(html).toContain('Conditional wait: 80 s/item (content)');
 expect(html).toContain('first 5 bought from full stock');
 expect(html).toContain('after the 5 in stock');
 expect(html).not.toContain('80.1 helper ticks');
});

test('cash and wait evidence remain independently useful when helper time is unknown',()=>{
 const data=itemSources([{id:526,sources:[{...source('unknown',null),cost:{
  helperTicksPerUnit:null,ticksBasis:'unknown',coinsPerUnit:7,coinsBasis:'measured',coinsNote:'cash <fee> & inputs excluded',
  realSecondsPerUnit:2,realBasis:'model',realNote:'after stock < 1 & respawn unchanged',
 }}]}],names);
 const html=render(data);
 expect(html).not.toContain('helper ticks/item');
 expect(html).toContain('7 gp/item (measured)');expect(html).toContain('Conditional wait: 2 s/item (estimate)');
 expect(html).toContain('cash &lt;fee&gt; &amp; inputs excluded');
 expect(html).toContain('after stock &lt; 1 &amp; respawn unchanged');
 const zero=render({526:[['pickup','Known zero outlay',[3200,3200,0],{coinsPerUnit:0,coinsBasis:'content',realSecondsPerUnit:0,realBasis:'content'}]]});
 expect(zero).toContain('0 gp/item (content)');expect(zero).toContain('0 s/item (content)');
 for(const cost of [{coinsPerUnit:-1,coinsBasis:'model'},{coinsPerUnit:0,coinsBasis:'unknown'},
  {realSecondsPerUnit:Infinity,realBasis:'content'},{realSecondsPerUnit:1,realBasis:'unknown'}]){
  const missing=render({526:[['pickup','Unknown cost',[3200,3200,0],cost]]});
  expect(missing).not.toContain('gp/item');expect(missing).not.toContain('s/item');
 }
});

test('a fourth complete source location reaches the actual nearest teleport suggestion',()=>{
 const tiles=sourceTiles([{x:2371,z:9461,level:0},{x:2372,z:9461,level:0},{x:2373,z:9461,level:0},{x:3200,z:3200,level:0},{x:3200,z:3200,level:0}]);
 const data=itemSources([{id:526,sources:[{kind:'pickup',spawns:5,tiles}]}],names);
 const nearest=shell.slice(shell.indexOf('  function nearestTeleport('),shell.indexOf('  const teleText='));
 const flat=shell.slice(shell.indexOf('  const flatTiles='),shell.indexOf('\n',shell.indexOf('  const flatTiles=')));
 const suggest=new Function('mapIcons',`${nearest}${flat};return source=>nearestTeleport(flatTiles(source));`)([[3210,3200,0,'t','Lumbridge teleport']]);
 expect(data['526']![0]![2]).toHaveLength(12);
 expect(suggest(data['526']![0]![2])).toEqual({label:'Lumbridge teleport',d:10});
 expect(suggest(data['526']![0]![2].slice(0,9))).toBeNull();
});
