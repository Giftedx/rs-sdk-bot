import {expect,test} from 'bun:test';
import {reachableComponents,directedAreas} from './route-audit-components';
test('component reachability preserves direction and total fares across boats',()=>{
 const edges=[{from:[0],to:[1],fare:30,allowed:()=>true},{from:[1],to:[2],fare:30,allowed:()=>true}];
 expect([...reachableComponents([0],edges,30)]).toEqual([[0,0],[1,30]]);
 expect([...reachableComponents([2],edges,20000)]).toEqual([[2,0]]);
 expect(reachableComponents([0],edges,60).get(2)).toBe(60);
});
test('a cheaper directed detour can fund a downstream gate and rejected portals stay closed',()=>{
 const edge=(from:number,to:number,fare:number,allowed=()=>true)=>({from:[from],to:[to],fare,allowed});
 const graph=[edge(0,1,30),edge(0,3,0),edge(3,1,5),edge(1,2,20),edge(2,4,0,()=>false)];
 const result=reachableComponents([0],graph,30);expect(result.get(1)).toBe(5);expect(result.get(2)).toBe(25);expect(result.has(4)).toBe(false);
});

test('a one-way door does not merge its two sides into mutual reachability',()=>{
 for(const allowed of [1,-1]){
  const {labels,edges}=directedAreas([[0,0,0]],(l,x,z)=>l===0&&z===0&&(x===0||x===1),(_l,x,z,dx,dz)=>z===0&&dz===0&&dx===allowed&&x+dx>=0&&x+dx<=1);
  const a=labels.area(0,0,0),b=labels.area(0,1,0);expect(a).not.toBe(b);
  const start=allowed===1?a:b,end=allowed===1?b:a;
  expect(reachableComponents([start],edges,0).has(end)).toBe(true);
  expect(reachableComponents([end],edges,0).has(start)).toBe(false);
 }
});
