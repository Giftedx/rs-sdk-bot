import { expect, test, spyOn } from 'bun:test';
import * as owner from '../packages/core/src/bot';
import { freshRangedStart, runRangedStarter } from './ranged-starter';

test('accepts only a fresh ground-floor tutorial actor', () => {
    const tutorial = { worldX: 3094, worldZ: 3106, level: 0 };
    expect(freshRangedStart(tutorial, 1, 0)).toBe(true);
    expect(freshRangedStart({ worldX: 3222, worldZ: 3222, level: 0 }, 1, 0)).toBe(false);
    expect(freshRangedStart({ ...tutorial, level: 1 }, 1, 0)).toBe(false);
    expect(freshRangedStart(tutorial, 1, 1)).toBe(false);
    expect(freshRangedStart(tutorial, 2, 83)).toBe(false);
    expect(freshRangedStart(undefined, 1, 0)).toBe(false);
});

async function rangedTutorial(mode:'waiting'|'unknown'|'stop'|'delayed-grant'|'missing-grant') {
    let tick=0,grantAt=0,earningAt=0;
    const actions:string[]=[],errors:string[]=[],listeners=new Set<()=>void>();
    const grant=[1351,590,303,315,1925,1931,2309,1265,1205,1277,1171,841].map(id=>({id,count:1}))
        .concat([{id:882,count:25},{id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2}]);
    const state:any={inGame:true,modalOpen:false,modalInterface:-1,
        player:{worldX:3094,worldZ:3106,level:0,lifeId:1},inventory:[],
        dialog:{isOpen:true,isWaiting:mode==='waiting'||mode==='stop',options:[{index:1,text:mode==='unknown'?'Tell me about this place.':'Yes please.',buttonType:1}]},
        nearbyNpcs:[{index:2,name:'Man',x:3222,z:3222,distance:1}]};
    const s:any={name:'starter',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
        client:{ingame:true,ifType:()=>({colour:state.inventory.length?0xf80000:0xff0000})},
        sdk:{getState:()=>state,getDialog:()=>state.dialog,getInventory:()=>state.inventory,
            getSkill:(name:string)=>({level:name==='Hitpoints'?10:1,baseLevel:name==='Hitpoints'?10:1}),getSkillXp:()=>0,
            clickDialogByText:async()=>{actions.push('yes');state.dialog={isOpen:false,isWaiting:false,options:[]};state.player={...state.player,worldX:3222,worldZ:3222};grantAt=tick+4;return{success:true};},
            sendClickDialog:async()=>{actions.push('unexpected-continue');return{success:true};}},
        bot:{skipTutorial:async()=>{actions.push('legacy-skip');throw Error('legacy tutorial path');},
            pickpocketNpc:async()=>{earningAt=tick;actions.push('earn');throw Error('finite entry boundary');}}};
    const settle=spyOn(owner,'settle').mockResolvedValue(true),log=spyOn(console,'log').mockImplementation(()=>{}),error=spyOn(console,'error').mockImplementation(value=>{errors.push(String(value));});
    const timer=setInterval(()=>{tick++;if(grantAt&&tick===grantAt&&mode!=='missing-grant')state.inventory=grant;for(const cb of [...listeners])cb();},1);
    try {
        expect(await runRangedStarter(s,()=>mode==='stop'&&tick>=5)).toBe(false);
        expect(actions).not.toContain('legacy-skip');
        if(mode==='delayed-grant') {expect(actions).toEqual(['yes','earn']);expect(earningAt).toBeGreaterThanOrEqual(grantAt);}
        else {
            expect(actions).not.toContain('earn');
            expect(actions).not.toContain('unexpected-continue');
            if(mode==='unknown')expect(errors.join('\n')).toContain('unsupported tutorial choice');
            else if(mode==='stop'){expect(tick).toBeLessThanOrEqual(5);expect(errors.join('\n')).toContain('stopped during starter exit');}
            else {expect(tick).toBeGreaterThanOrEqual(100);expect(tick).toBeLessThanOrEqual(101);expect(errors.join('\n')).toContain('starter entry deadline');}
        }
        expect(settle).toHaveBeenCalledWith([s],false,'fresh Ranged starter route');
    } finally {clearInterval(timer);settle.mockRestore();log.mockRestore();error.mockRestore();}
}

for(const mode of ['waiting','unknown','stop','delayed-grant','missing-grant'] as const)
    test(`Ranged caller bounds tutorial ${mode} before any earning or training`,()=>rangedTutorial(mode));
