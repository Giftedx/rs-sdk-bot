import{test,expect}from'bun:test';
import{trawlerCatchRows,trawlerAssetsReconcile}from'./microbot-trawler-trip';
test('native reward rows use owned component ids with one based item encoding',()=>{expect(trawlerCatchRows({linkObjType:Int32Array.from([0,390,392]),linkObjNumber:Int32Array.from([0,2,1])})).toEqual([{id:389,slot:1,count:2},{id:391,slot:2,count:1}]);expect(()=>trawlerCatchRows(undefined)).toThrow('owned');});

test('trip bank audit requires every owned reward and only declared repair costs',()=>{
 const initial=new Map([[1941,100],[954,10],[583,1],[995,1000]]),rewards={389:2,391:1};
 const final={1941:80,954:8,583:1,995:1000,389:2,391:1};
 expect(trawlerAssetsReconcile(initial,final,rewards,20,2)).toBe(true);
 expect(trawlerAssetsReconcile(initial,{...final,389:0},rewards,20,2)).toBe(false);
 expect(trawlerAssetsReconcile(initial,{1941:80,954:8,583:1,995:1000},rewards,20,2)).toBe(false);
 expect(trawlerAssetsReconcile(initial,{...final,995:999},rewards,20,2)).toBe(false);
 expect(trawlerAssetsReconcile(initial,{...final,954:7},rewards,20,2)).toBe(false);
});

import {trawlerInterruption} from './microbot-trawler-trip-effects';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
test('only the native rip dialog and flood form explain a cancelled pending action',()=>{
 const a={player:{worldX:1886,worldZ:4824,level:0},dialog:{isOpen:false,isWaiting:false,options:[]}} as unknown as BotWorldState;
 expect(trawlerInterruption(a,{...a,dialog:{isOpen:true,isWaiting:false,options:[{index:1,text:'Click here to continue',componentId:362,buttonType:6}],allComponents:[{id:360,type:4,buttonType:0,option:'',text:'The net has ripped!'}]}})).toBe('net-rip');
 expect(trawlerInterruption(a,{...a,player:{...a.player!,worldX:2014}})).toBe('flood-form');
 expect(trawlerInterruption(a,{...a,dialog:{isOpen:true,isWaiting:false,options:[],text:'Another modal'}})).toBeNull();
 expect(trawlerInterruption(a,a)).toBeNull();
});

import {trawlerNetWindow} from './microbot-trawler-trip-effects';
test('net excursions leave active leaks and high water to the hold crew',()=>{
 expect(trawlerNetWindow(true,7,0)).toBe(true);
 expect(trawlerNetWindow(true,7,1)).toBe(false);
 expect(trawlerNetWindow(true,10,0)).toBe(true);
 expect(trawlerNetWindow(true,11,0)).toBe(false);
 expect(trawlerNetWindow(true,20,0)).toBe(false);
 expect(trawlerNetWindow(true,38,0)).toBe(false);
 expect(trawlerNetWindow(true,60,3)).toBe(false);
 expect(trawlerNetWindow(false,0,0)).toBe(false);
});
