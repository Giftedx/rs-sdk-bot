import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

for(const worker of ['collect-wool','gather-yews'])test(`${worker} cancels cargo immediately while its default stop logout is pending`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'cargo-caller-stop-')),preload=join(dir,'preload.ts'),root=resolve(import.meta.dir,'..');
    const code=`
        import assert from 'node:assert/strict';
        import {mock} from 'bun:test';
        import {resolve} from 'node:path';
        const wool=${worker==='collect-wool'};
        let tick=0,open=false,cargoCalls=0,finishCalls=0,closes=0,onStop;
        const inventory=wool?[{id:1735,name:'Shears',count:1,slot:0},{id:1737,name:'Wool',count:1,slot:1}]
            :[{id:1351,name:'Bronze axe',count:1,slot:0},{id:1515,name:'Yew logs',count:1,slot:1},...Array.from({length:3},(_,i)=>({id:333,name:'Trout',count:1,slot:i+2}))];
        const player={worldX:wool?3092:2727,worldZ:wool?3243:3492,level:0,lifeId:1,respawnCount:0};
        const state=()=>({player,inventory,bank:{isOpen:open,items:[]}});
        const session={name:'fixture',tick:()=>tick,ended:new Promise(()=>{}),onTick:()=>()=>{},
            sdk:{getState:state,getSkill:()=>({level:10}),getSkillXp:()=>0,getInventory:()=>inventory},
            bot:{openBank:async()=>{open=true;return{success:true};},
                depositItem:async(target)=>{const pattern=typeof target==='string'?new RegExp(target,'i'):target instanceof RegExp?target:new RegExp('^'+target.name+'$','i');for(let i=inventory.length-1;i>=0;i--)if(pattern.test(inventory[i].name))inventory.splice(i,1);return{success:true};},
                closeBank:async()=>{closes++;open=false;},closeInterface:async()=>{closes++;open=false;}}};
        const botMod=resolve('packages/core/src/bot.ts');
        const realBot=await import(botMod);
        mock.module(botMod,()=>({
            ...realBot,
            openBot:async(_name,options)=>{onStop=options?.onStop;return session;},
            finish:async(rows,ok,detail)=>{
                finishCalls++;assert.equal(rows[0],session);assert.equal(ok,false);
                if(finishCalls===1){assert.equal(detail,'stop during cargo');return new Promise(()=>{});}
                assert.match(detail,/cargo stopped/);
            },
            countItems:(s,re)=>s.sdk.getInventory().filter(i=>re.test(i.name)).reduce((n,i)=>n+i.count,0),
            getWorld:async()=>({}),accountOf:()=>({}),
        }));
        const ticksMod=resolve('packages/core/src/ticks.ts');
        const realTicks=await import(ticksMod);
        mock.module(ticksMod,()=>({...realTicks,waitTicks:async(_s,n)=>{tick+=n;},waitUntil:async()=>true}));
        const walkMod=resolve('packages/core/src/walk.ts');
        const realWalk=await import(walkMod);
        mock.module(walkMod,()=>({...realWalk,walkPath:async()=>({ok:true,ticks:0}),sessionWalker:async()=>({}),goTo:async()=>({ok:true}),expandPath:x=>x}));
        const cargoMod=resolve('packages/core/src/cargo.ts');
        const realCargo=await import(cargoMod);
        mock.module(cargoMod,()=>({...realCargo,bankCargo:async(_s,_patterns,_reserve,options)=>{
            cargoCalls++;assert.equal(options.stopped(),false);
            assert.equal(typeof onStop,'function');
            let settled=false;void onStop(session,'stop during cargo').then(()=>{settled=true;});
            assert.equal(options.stopped(),true);
            await Promise.resolve();assert.equal(settled,false);
            throw Error('cargo stopped');
        }}));
        process.on('exit',()=>{assert.equal(cargoCalls,1);assert.equal(finishCalls,2);assert.equal(closes,0);});
    `;
    writeFileSync(preload,code);
    const gatherArgs=worker==='collect-wool'?['gather','foraging','wool','15000','1']:['gather','woodcutting','yews','15000','1'];
    const child=Bun.spawn([process.execPath,'--preload',preload,join(import.meta.dir,'aio-skiller.ts'),'fixture',...gatherArgs],{
        cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true,
        env:{...process.env,REGION:'seers',TREE:'yew',CAP:'15000',MAX_TRIPS:'1'},
    });
    const deadline=setTimeout(()=>child.kill(),10000);
    try{
        const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
        expect({code,stderr},stdout).toEqual({code:1,stderr:''});
    }finally{clearTimeout(deadline);rmSync(dir,{recursive:true,force:true});}
});
