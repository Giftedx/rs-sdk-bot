import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const shell=readFileSync(new URL('./client-shell.js',import.meta.url),'utf8');

function itemMenus(){
 const start=shell.indexOf("  hud.addEventListener('contextmenu',e=>{const cell="),code=shell.slice(start,shell.indexOf("  document.addEventListener('click',e=>{if(context",start));
 const attached=new Set<any>(),created:any[]=[];let onContext:any;
 const bot:any={inventory:[{id:385,name:'Shark',count:1},{id:995,name:'Coins',count:42}],equipment:[{slot:3,id:1277,name:'Bronze sword',count:1}],equipmentObserved:true};
 const document={createElement:()=>{const node:any={style:{},innerHTML:'',isConnected:false,remove:()=>{node.isConnected=false;attached.delete(node);}};created.push(node);return node;},body:{append:(node:any)=>{node.isConnected=true;attached.add(node);}}};
 const env:any={hud:{addEventListener:(kind:string,fn:any)=>{if(kind==='contextmenu')onContext=fn;}},account:()=>bot,document,innerWidth:800,innerHeight:600,E:String};
 new Function(...Object.keys(env),`let context=null;${code}`)(...Object.values(env));
 const cell=(dataset:any,inventoryCell=false)=>{const node:any={dataset,closest:(selector:string)=>selector.split(',').some(s=>s==='[data-item]'&&dataset.item!==undefined||s==='[data-equipment]'&&dataset.equipment!==undefined||s==='.inventory-cell'&&inventoryCell)?node:null};return node;};
 const open=(dataset:any,inventoryCell=false)=>{let prevented=false;onContext({target:cell(dataset,inventoryCell),clientX:100,clientY:100,preventDefault:()=>{prevented=true;}});return prevented;};
 return {bot,attached,created,open};
}

test('a populated item menu replaces the prior attached menu',()=>{
 const ui=itemMenus();ui.open({item:'0'},true);const old=ui.created[0];expect(old.isConnected).toBe(true);expect(old.innerHTML).toContain('Shark');
 ui.open({item:'1'},true);expect(old.isConnected).toBe(false);expect(ui.attached.size).toBe(1);expect([...ui.attached][0].innerHTML).toContain('Coins');
});

test('right-clicking an empty inventory or worn cell removes an already attached item menu',()=>{
 for(const blank of [{dataset:{},inventoryCell:true},{dataset:{equipment:'0'},inventoryCell:false}]){
  const ui=itemMenus();ui.open({item:'0'},true);const old=ui.created[0];expect(ui.attached.has(old)).toBe(true);
  expect(ui.open(blank.dataset,blank.inventoryCell)).toBe(true);
  expect(old.isConnected).toBe(false);expect(ui.attached.size).toBe(0);expect(ui.created).toHaveLength(1);
 }
});

test('right-clicking an unobserved worn cell closes the old menu without creating a hidden-gear menu',()=>{
 const ui=itemMenus();ui.open({item:'0'},true);const old=ui.created[0];expect(old.isConnected).toBe(true);
 ui.bot.equipmentObserved=false;expect(ui.open({equipment:'3'})).toBe(true);
 expect(old.isConnected).toBe(false);expect(ui.attached.size).toBe(0);expect(ui.created).toHaveLength(1);
});

function hudKeys(){
 const start=shell.lastIndexOf("  window.addEventListener('keydown',e=>{"),code=shell.slice(start,shell.indexOf('  window.atlasClient=',start));let onKey:any,redraws=0;
 const env:any={window:{addEventListener:(_kind:string,fn:any)=>{onKey=fn;},atlasWallOn:()=>false},document:{body:{},querySelector:()=>null},focus:{classList:{contains:()=>false}},focusOpen(){},wallEnd:()=>false,context:null,hud:{classList:{remove(){}},querySelector:()=>null},gamePanel:()=>{redraws++;},showPlugin(){},$:()=>null};
 const api=new Function(...Object.keys(env),`let selectedTab='inventory';${code};return {selected:()=>selectedTab};`)(...Object.values(env));
 const key=(shiftKey:boolean)=>{let prevented=false,stopped=false;onKey({key:'F10',shiftKey,ctrlKey:false,altKey:false,metaKey:false,target:{tagName:'BUTTON',dataset:{item:'0'},closest:()=>null},preventDefault:()=>{prevented=true;},stopPropagation:()=>{stopped=true;}});return {prevented,stopped};};
 return {key,api,redraws:()=>redraws};
}

test('Shift+F10 on a held item keeps the keyboard context command while plain F10 still opens Settings',()=>{
 const ui=hudKeys();expect(ui.key(true)).toEqual({prevented:false,stopped:false});expect(ui.api.selected()).toBe('inventory');expect(ui.redraws()).toBe(0);
 expect(ui.key(false)).toEqual({prevented:true,stopped:true});expect(ui.api.selected()).toBe('settings');expect(ui.redraws()).toBe(1);
});
