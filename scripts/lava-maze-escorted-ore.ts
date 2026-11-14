// One composed controller job: <escort> <miner>. CAP and MAX_ORE retain finite bounds.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openBot, settle, serverFromEnv } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { depositObserved } from '../packages/core/src/deposit';
import { RosterFeed } from '../packages/core/src/roster-feed';
import { waitUntil, type TickSource } from '../packages/core/src/ticks';
import { sessionWalker, walkPath, type PathDeps } from '../packages/core/src/walk';
import { readLogoutProof } from '../packages/core/src/session-lifecycle';
import { mineRock } from './gather-ore';

export type Tile = readonly [number, number];
export type RosterPlayer = [number, string, number, number, number, number];
type Frame = { tick:number; roster:RosterPlayer[]; at:number };
type MeasuredRoute = { p:Tile[]; route:Tile[]; multi:number };
const root = resolve(import.meta.dir, '..');
export const BANK:Tile = [3094,3492], STAGE:Tile = [3060,3883], CAMP:Tile = [3060,3885];
const ORE=451, FOOD=385, PICK=1275;
const MINING_GEMS=new Set([1617,1619,1621,1623]);
const distance = (a:Tile,b:Tile) => Math.max(Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1]));
function requireThat(ok:unknown,why:string):asserts ok { if(!ok)throw Error(why); }
const depth = (x:number,z:number) => x>=2944&&x<=3391&&z>=3520&&z<=6399 ? Math.floor((z-3520)/8)+1 : 0;
export function corridorThreat(roster:RosterPlayer[], own:Set<string>, corridor:readonly Tile[], combat:number) {
    return roster.find(([,name,x,z,plane,level])=>!own.has(name.toLowerCase())&&plane===0&&corridor.some(t=>{
        const limit=Math.min(depth(x,z),depth(...t));
        return limit>0&&distance([x,z],t)<=30&&Math.abs(level-combat)<=limit;
    }));
}

// A lost frame invalidates this trip. A later frame cannot erase the missing observation.
export class RosterEvidence {
    private frame?:Frame;
    failure?:string;
    accept(value:unknown,at=Date.now()) {
        const v=value as {t?:string;k?:number;p?:RosterPlayer[]};
        if(v?.t!=='roster')return;
        const valid=Number.isSafeInteger(v.k)&&Array.isArray(v.p)&&v.p.every(p=>Array.isArray(p)&&p.length===6&&
            Number.isSafeInteger(p[0])&&typeof p[1]==='string'&&p[1].length>0&&p.slice(2).every(Number.isSafeInteger)&&p[4]>=0&&p[4]<=3&&p[5]>=3&&p[5]<=126)&&
            new Set(v.p.map(p=>p[1].toLowerCase())).size===v.p.length;
        if(!valid) {this.failure??='Malformed roster';return;}
        if(this.frame&&(v.k!==this.frame.tick+10||at-this.frame.at>=10000))this.failure??='Roster frame gap';
        this.frame={tick:v.k!,roster:v.p!,at};
    }
    fresh(now=Date.now()):Frame|undefined {
        if(this.frame&&now-this.frame.at>=10000)this.failure??='Stale roster';
        return this.failure?undefined:this.frame;
    }
}
type EntryParticipant={name:string;player:{worldX:number;worldZ:number;level:number;combatLevel?:number}|undefined|null};
export function entryRosterReady(frame:Frame|undefined,participants:readonly EntryParticipant[]) {
    return !!frame&&participants.length===2&&participants.every(({name,player:p})=>p?.level===0&&
        distance([p.worldX,p.worldZ],BANK)===0&&frame.roster.some(row=>row[1].toLowerCase()===name.toLowerCase()&&
            row[2]===p.worldX&&row[3]===p.worldZ&&row[4]===p.level&&row[5]===p.combatLevel));
}
export async function waitForRosterEntry(s:TickSource,read:()=>Frame|undefined,participants:()=>readonly EntryParticipant[],refused:()=>boolean) {
    const ready=()=>entryRosterReady(read(),participants());
    return await waitUntil(s,()=>refused()||ready(),{timeoutTicks:40})&&!refused()&&ready();
}
export function stageRelease(escort:string,miner:string) {
    let previous:number|undefined,frames=0;
    return (frame:Frame|undefined,localReady:boolean) => {
        const at=(name:string,t:Tile,combat:number)=>frame?.roster.some(p=>p[1].toLowerCase()===name.toLowerCase()&&p[4]===0&&p[5]===combat&&distance([p[2],p[3]],t)===0);
        if(!frame||!localReady||!at(escort,STAGE,75)||!at(miner,BANK,29)){frames=0;previous=undefined;return false;}
        if(frame.tick!==previous){frames=previous===undefined||frame.tick===previous+10?frames+1:1;previous=frame.tick;}
        return frames>=3;
    };
}
export function readEscortRoute() {
    const r=JSON.parse(readFileSync(resolve(root,'scripts/lava-maze-escort-route.json'),'utf8')) as {out:MeasuredRoute;back:MeasuredRoute};
    const zones=new Set(readFileSync(resolve(root,'vendor/rs-sdk/server/content/maps/multiway.csv'),'utf8').split(/\r?\n/));
    const multi=(t:Tile)=>zones.has([0,t[0]>>6,t[1]>>6,t[0]&56,t[1]&56].join('_'));
    for(const [path,start,end] of [[r.out,BANK,STAGE],[r.back,STAGE,BANK]] as const) {
        requireThat(path?.p?.length===453&&distance(path.p[0]!,start)===0&&distance(path.p.at(-1)!,end)===0,'Measured route endpoints differ');
        requireThat(path.p.every((t,i)=>t.length===2&&t.every(Number.isSafeInteger)&&(i===0||distance(path.p[i-1]!,t)===1)),'Measured route has a gap');
        requireThat(path.p.filter(multi).length===40&&path.multi===40,'Measured multi transit differs');
    }
    requireThat([STAGE,CAMP,[3059,3885] as Tile,[3060,3884] as Tile].every(t=>!multi(t)),'Stage and rocks must be singles');
    const points=(r:MeasuredRoute)=>{
        const turns=new Set(r.route.filter(t=>t[1]>=3860).map(t=>t.join(',')));
        return r.p.filter((t,i)=>i%8===0||i===r.p.length-1||turns.has(t.join(',')));
    };
    return {...r,multiTiles:40,outbound:points(r.out),inbound:points(r.back),
        corridor:[...r.out.p,...r.back.p,CAMP,[3060,3884],[3059,3885]] as Tile[]};
}
function radar(url:string) {
    const evidence=new RosterEvidence(),socket=new WebSocket(url),feed=new RosterFeed();
    let heartbeat:ReturnType<typeof setInterval>|undefined;
    socket.addEventListener('open',()=>{
        socket.send(JSON.stringify({t:'roster',on:true}));
        heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({t:'ping'}));},30000);
    });
    socket.addEventListener('message',({data})=>{try{evidence.accept(feed.expand(JSON.parse(String(data))));}catch{evidence.failure??='Invalid roster JSON';}});
    socket.addEventListener('close',()=>{evidence.failure??='Roster socket closed';if(heartbeat)clearInterval(heartbeat);});
    socket.addEventListener('error',()=>{evidence.failure??='Roster socket failed';});
    return {evidence,fresh:()=>socket.readyState===WebSocket.OPEN?evidence.fresh():undefined,
        close:()=>{if(heartbeat)clearInterval(heartbeat);socket.close();}};
}
const player=(s:Session)=>s.sdk.getState()?.player;
const tile=(s:Session):Tile|undefined=>{const p=player(s);return p?.level===0?[p.worldX,p.worldZ]:undefined;};
const at=(s:Session,t:Tile)=>{const p=tile(s);return !!p&&distance(p,t)===0;};
const atEdgeville=(s:Session)=>{const p=tile(s);return !!p&&distance(p,BANK)<=3;};
const held=(s:Session,id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const hp=(s:Session)=>player(s)?.hp??0;
const prayer=(s:Session)=>s.sdk.getPrayerState()?.prayerPoints??0;
const alive=(s:Session)=>!!tile(s)&&hp(s)>0&&!player(s)?.isDead;
const totals=(items:readonly {id:number;count:number}[])=>items.reduce<Record<number,number>>((a,i)=>{a[i.id]=(a[i.id]??0)+i.count;return a;},{});

// Bank interactions can change the actor's tile. Safe staging needs no departure roster.
export async function alignAtBank(walker:PathDeps,refused:()=>boolean) {
    let stopped=false;
    const stop=()=>{
        const p=walker.pos();
        stopped=stopped||refused()||!p||p.level!==0||distance([p.x,p.z],BANK)>3;
        return stopped;
    };
    if(stop())return false;
    const result=await walkPath(walker,[{x:BANK[0],z:BANK[1],tol:0}],{maxTicks:12,idleMs:8000,stop});
    const p=walker.pos();
    return !stop()&&result.ok&&!!p&&p.level===0&&p.x===BANK[0]&&p.z===BANK[1];
}

export async function runEscortedOre(names:readonly string[],cap=Number(process.env.CAP??1800)) {
    requireThat(names.length===2&&names.every(n=>/^[a-z0-9]{1,12}$/i.test(n))&&names[0]!.toLowerCase()!==names[1]!.toLowerCase(),'Two distinct owned accounts required');
    requireThat(Number.isSafeInteger(cap)&&cap>=1&&cap<=6000&&Number(process.env.MAX_ORE??1)===1,'One ore and a finite tick cap required');
    const servers=names.map(n=>serverFromEnv(readFileSync(resolve(root,'vendor/rs-sdk/bots',n,'bot.env'),'utf8')));
    requireThat(servers[0]===servers[1],'Participant servers differ');
    const local=/^127\.0\.0\.1:\d+$/.test(servers[0]!);
    // The controller retains launch admission, holds and the complete participant reservation.
    if(!local) {
        const participants=JSON.parse(process.env.COORDINATOR_PARTICIPANTS??'null');
        requireThat(process.env.COORDINATOR_RUN_ID&&Array.isArray(participants)&&participants.length===2&&
            names.every(n=>participants.some((p:string)=>p.toLowerCase()===n.toLowerCase())),'Composed controller ownership required');
        requireThat(process.env.STANDING!=='1','Standing repeat is not this pilot');
    }
    const fixtureFeed=process.env.LAVA_ESCORT_ROSTER_URL;
    if(fixtureFeed)requireThat(local&&/^ws:\/\/127\.0\.0\.1:\d+\/worldfeed$/.test(fixtureFeed)&&process.env.DEMO_OK!=='1','Fixture roster requires loopback accounts');
    const holdPaths=['all','swarm','coordinator'].map(n=>resolve(root,'.practice/stop-'+n));
    const holdState=()=>JSON.stringify(holdPaths.map(p=>existsSync(p)?readFileSync(p,'utf8'):null));
    const fixtureHolds=process.env.LAVA_ESCORT_HOLDS;
    if(fixtureHolds!==undefined)requireThat(local&&fixtureFeed&&fixtureHolds===holdState(),'Loopback hold snapshot differs');
    const stop=()=> (local&&fixtureHolds!==undefined?fixtureHolds!==holdState():holdPaths.some(p=>existsSync(p)))||
        [...names,'lava-maze-escorted-ore'].some(n=>existsSync(resolve(root,'.practice/stop-'+n)));
    const route=readEscortRoute(),own=new Set(names.map(n=>n.toLowerCase()));
    const sessions:Session[]=[],offs:(()=>void)[]=[],faults=new Map<Session,string>();
    const report={mined:0,banked:0,released:false,stage:undefined as undefined|{tick:number;hp:number;prayer:number;frames:number},
        rocks:[] as {tick:number;x:number;z:number;id:number}[],attempts:[] as Awaited<ReturnType<typeof mineRock>>[],
        actors:[] as {name:string;ticks:number;wallMs:number;foodUsed:number;hpStart:number;hpMin:number;hpEnd:number;prayerStart:number;prayerEnd:number;position:Tile|undefined}[]};
    let feed:ReturnType<typeof radar>|undefined,failure:string|undefined,abort:string|undefined,holding=false;
    let escort:Session|undefined,miner:Session|undefined,previousEscortHp=0,meleeProtectAt=-10;
    const starts=new Map<Session,{tick:number;wall:number;hp:number;min:number;prayer:number;food:number;inventory:Record<number,number>;equipment:string}>();
    const walkers=new Map<Session,Awaited<ReturnType<typeof sessionWalker>>>();
    const lastTicks=new Map<Session,number>();
    const limits=()=>stop()||sessions.some(s=>faults.has(s)||!alive(s)||Date.now()-(lastTicks.get(s)??0)>10000||
        s.tick()-starts.get(s)!.tick>=cap)||Date.now()-began>12*60*1000;
    const protectedEscort=()=>!!escort&&escort.sdk.isPrayerActive('protect_items')&&prayer(escort)>=10;
    const checkOutbound=(entering=false)=>{
        if(abort)return true;
        const frame=feed?.fresh();
        if(limits())abort='Account, stop or budget gate failed';
        else if(feed?.evidence.failure)abort=feed.evidence.failure;
        else if(!frame&&!entering)abort='Fresh roster unavailable';
        else if(!entering&&frame&&!sessions.every(s=>frame.roster.some(p=>p[1].toLowerCase()===s.name.toLowerCase()&&p[4]===0&&p[5]===player(s)?.combatLevel)))abort='Participant roster evidence missing';
        else if(!protectedEscort())abort='Escort prayer reserve lost';
        else if(frame&&sessions.some(s=>corridorThreat(frame.roster,own,route.corridor,player(s)!.combatLevel!)))abort='Full corridor threat';
        else if(sessions.some(s=>(s.sdk.getState()?.nearbyPlayers??[]).some(p=>!own.has(p.name.toLowerCase())&&
            (!Number.isSafeInteger(p.combatLevel)||!!corridorThreat([[p.index,p.name,p.x,p.z,0,p.combatLevel]],own,route.corridor,player(s)!.combatLevel!)))))abort='Local player threat';
        else if(holding&&(!escort||!at(escort,STAGE)||hp(escort)<previousEscortHp||report.released&&!frame?.roster.some(p=>p[1].toLowerCase()===escort!.name.toLowerCase()&&p[4]===0&&p[2]===STAGE[0]&&p[3]===STAGE[1])))abort='Escort stage or HP changed';
        if(holding&&escort)previousEscortHp=hp(escort);
        return !!abort;
    };
    const began=Date.now();
    const heal=async(s:Session)=>{
        if(hp(s)>(s===escort?46:24)||hp(s)>=(player(s)?.maxHp??hp(s)))return;
        const food=held(s,FOOD),before=hp(s);
        requireThat(food>0,'Retreat food exhausted '+s.name);
        await s.bot.eatFood(/^shark$/i);
        requireThat(await waitUntil(s,()=>held(s,FOOD)===food-1&&hp(s)>before,{timeoutTicks:8}),'Food effect unconfirmed '+s.name);
    };
    const move=async(s:Session,points:readonly Tile[],retreat=false,expired=()=>false)=>{
        for(const t of points){
            requireThat(alive(s)&&!expired(),'Account or retreat budget failed '+s.name);
            if(at(s,t))continue;
            if(retreat)await heal(s);
            else {requireThat(!checkOutbound(),abort??'Outbound refused');await heal(s);requireThat(!checkOutbound(),abort??'Outbound refused');}
            const result=await walkPath(walkers.get(s)!,[{x:t[0],z:t[1],tol:0}],{
                maxTicks:40,idleMs:8000,
                stop:()=>!alive(s)||expired()||(!retreat&&checkOutbound())});
            requireThat(result.ok&&at(s,t),'Waypoint unconfirmed '+s.name+' '+t.join(',')+' '+result.detail);
        }
    };
    const home=async(s:Session)=>{
        if(at(s,BANK))return;
        const from=tile(s);requireThat(from,'Retreat position unknown '+s.name);
        const near=route.inbound.reduce((a,t,i)=>distance(from,t)<distance(from,route.inbound[a]!)?i:a,0);
        const start=s.tick(),wall=Date.now();
        await move(s,route.inbound.slice(near),true,()=>s.tick()-start>=650||Date.now()-wall>=300000);
        requireThat(at(s,BANK)&&alive(s),'Safe bank return unconfirmed '+s.name);
    };
    try {
        requireThat(!stop(),'Owner hold present');
        for(const name of names){
            requireThat(!stop(),'Owner hold before login');
            const fault=async(s:Session,d:string)=>{faults.set(s,d);abort??=name+': '+d;};
            const s=await openBot(name,{onStop:fault,onSessionEnd:fault});sessions.push(s);
            starts.set(s,{tick:s.tick(),wall:Date.now(),hp:hp(s),min:hp(s),prayer:prayer(s),food:held(s,FOOD),inventory:{},equipment:''});
            lastTicks.set(s,Date.now());
            offs.push(s.onTick(()=>{
                lastTicks.set(s,Date.now());const initial=starts.get(s)!;initial.min=Math.min(initial.min,hp(s));
                // An npc of the maze (a deadly red spider) can walk to the stage and attack: Protect from Melee goes up
                // while one within 3 tiles has a player as its target (index 32768 and up), before its first hit.
                if(holding&&s===escort&&!s.sdk.isPrayerActive('protect_from_melee')&&prayer(s)>=10&&s.tick()-meleeProtectAt>=2&&
                    (s.sdk.getState()?.nearbyNpcs??[]).some(n=>n.distance<=3&&n.targetIndex>=32768)){meleeProtectAt=s.tick();void s.sdk.sendTogglePrayer('protect_from_melee');}
                if(holding&&s===escort&&hp(s)<previousEscortHp)abort??='Escort HP dropped';
                if(holding&&s===escort)previousEscortHp=hp(s);
                if(holding)checkOutbound();
            }));
            requireThat(await waitUntil(s,()=>atEdgeville(s)&&alive(s),{timeoutTicks:20}),'Observed Edgeville entry required '+name);
            if(s.sdk.getState()?.autoRetaliateEnabled===true)await s.sdk.sendClickComponent(151);
            requireThat(await waitUntil(s,()=>s.sdk.getState()?.autoRetaliateEnabled===false,{timeoutTicks:8}),'Auto retaliation remains active '+name);
            walkers.set(s,await sessionWalker(s));
            if(!at(s,BANK)){
                requireThat(await alignAtBank(walkers.get(s)!,limits)&&at(s,BANK),'Edgeville route start unconfirmed '+name);
            }
        }
        [escort,miner]=sessions;
        requireThat(player(escort!)?.combatLevel===75&&player(miner!)?.combatLevel===29,'Expected combat75 escort and combat29 miner');
        requireThat((miner!.sdk.getSkill('Mining')?.baseLevel??0)>=85&&hp(miner!)>=30&&hp(escort!)>=47,'Mining or HP prerequisite missing');
        requireThat(held(miner!,ORE)===0,'Miner must start without carried Runite');
        let bankBaseline=0;
        for(const s of sessions){
            requireThat(!limits(),'Entry stopped');
            await s.bot.openBank();
            requireThat(await waitUntil(s,()=>!!s.bankObservation?.(),{timeoutTicks:14}),'Fresh bank observation missing '+s.name);
            if(s===miner){bankBaseline=(s.bankObservation!()!.items).filter(i=>i.id===ORE).reduce((n,i)=>n+i.count,0);
                requireThat(bankBaseline===Number(process.env.EXPECTED_BANK_ORE??57),'Miner bank baseline differs');}
            for(const [id,re,want] of [[FOOD,/^shark$/i,4],...(s===miner?[[PICK,/^rune pickaxe$/i,1] as const]:[])] as const){
                const missing=want-held(s,id);if(missing<=0)continue;
                requireThat(s.bankObservation!()!.items.some(i=>i.id===id&&i.count>=missing),'Missing owned supply '+id+' '+s.name);
                await s.bot.withdrawItem(re,missing,{asNote:false});
                requireThat(await waitUntil(s,()=>held(s,id)>=want,{timeoutTicks:10}),'Supply withdrawal unconfirmed '+s.name);
            }
            await s.bot.closeBank();
            const initial=starts.get(s)!;initial.food=held(s,FOOD);initial.inventory=totals(s.sdk.getInventory());initial.equipment=JSON.stringify(s.sdk.getEquipment());
        }
        requireThat(held(miner!,PICK)===1&&held(miner!,FOOD)>=4&&held(escort!,FOOD)>=4,'Observed kit missing');
        if(!escort!.sdk.isPrayerActive('protect_items'))await escort!.bot.activatePrayer('protect_items');
        requireThat(await waitUntil(escort!,protectedEscort,{timeoutTicks:8}),'Protect Item or ten-Prayer reserve missing');
        for(const s of sessions)requireThat(await alignAtBank(walkers.get(s)!,()=>!!abort||limits())&&at(s,BANK),'Post-bank stage unconfirmed '+s.name);
        requireThat(sessions.every(s=>at(s,BANK)&&alive(s)),'Exact participant bank staging unconfirmed');
        feed=radar(fixtureFeed??`${local?'ws':'wss'}://${servers[0]}/worldfeed`);
        requireThat(await waitForRosterEntry(miner!,()=>feed!.fresh(),()=>sessions.map(s=>({name:s.name,player:player(s)})),()=>checkOutbound(true)),
            abort??'Participant roster unavailable before departure');
        requireThat(!checkOutbound(),abort??'Departure refused');
        await move(escort!,route.outbound);
        requireThat(at(escort!,STAGE),'Exact escort stage unconfirmed');
        holding=true;previousEscortHp=hp(escort!);
        const release=stageRelease(escort!.name,miner!.name);
        requireThat(await waitUntil(miner!,()=>checkOutbound()||release(feed!.fresh(),at(miner!,BANK)&&at(escort!,STAGE)),{timeoutTicks:45})&&
            !checkOutbound()&&release(feed.fresh(),at(miner!,BANK)&&at(escort!,STAGE)),'Three fresh stage frames unconfirmed');
        report.stage={tick:feed.fresh()!.tick,hp:hp(escort!),prayer:prayer(escort!),frames:3};
        report.released=true;
        await move(miner!,[...route.outbound,CAMP]);
        const rock=()=>miner!.sdk.getState()?.nearbyLocs.find(l=>l.level===0&&[2106,2107].includes(l.id)&&
            ((l.x===3059&&l.z===3885)||(l.x===3060&&l.z===3884))&&l.reachable!==false&&l.optionsWithIndex.some(o=>/^mine$/i.test(o.text)));
        requireThat(await waitUntil(miner!,()=>checkOutbound()||!!rock(),{timeoutTicks:120})&&!checkOutbound()&&rock(),'Counted Runite rock unavailable');
        const startXp=miner!.sdk.getSkillXp('mining')??0,start=miner!.tick();
        // MINE_TICKS (default 210) bounds the time at the rock. Runite succeeds 18 in 256 a swing at Mining 99
        // (mine.dbrow rock_successchance 1,18; stat_random), a swing each 3 ticks: no ore in 105 ticks is 8% of
        // trips, in 210 ticks 0.6%. A threat still ends the wait on any tick (checkOutbound).
        const mineTicks=Math.max(25,Math.min(600,Number(process.env.MINE_TICKS??210)));
        for(let i=0;i<Math.ceil(mineTicks/25)+1&&miner!.tick()-start<mineTicks&&held(miner!,ORE)===0;i++){
            requireThat(!checkOutbound(),abort??'Mining stopped');
            await heal(miner!);const loc=rock();if(!loc)break;
            report.rocks.push({tick:miner!.tick(),x:loc.x,z:loc.z,id:loc.id});
            report.attempts.push(await mineRock(miner!,loc,()=>checkOutbound()||held(miner!,ORE)>=1,Math.min(25,mineTicks-(miner!.tick()-start)),/^runite ore$/i));
        }
        requireThat(await waitUntil(miner!,()=>held(miner!,ORE)===1&&(miner!.sdk.getSkillXp('mining')??0)>startXp,{timeoutTicks:2}),'Exactly one new ore and Mining XP required');
        report.mined=1;
        // Retreat has a separate bounded budget. A stale roster cannot trap an account in the Wilderness.
        await home(miner!);holding=false;await home(escort!);
        requireThat(!abort&&!stop(),'Pilot interrupted '+abort);
        await miner!.bot.openBank();
        requireThat(await waitUntil(miner!,()=>!!miner!.bankObservation?.(),{timeoutTicks:14}),'Return bank unavailable');
        requireThat(held(miner!,ORE)===1,'New carried ore differs before deposit');
        report.banked=await depositObserved(miner!,{id:ORE,name:'Runite ore'});
        requireThat(report.banked===1&&held(miner!,ORE)===0&&miner!.bankObservation!()!.items.filter(i=>i.id===ORE).reduce((n,i)=>n+i.count,0)===bankBaseline+1,'Exact bank credit unconfirmed');
        await miner!.bot.closeBank();
        requireThat(await alignAtBank(walkers.get(miner!)!,()=>!!abort||limits())&&at(miner!,BANK),'Post-deposit bank position unconfirmed');
        for(const s of sessions){
            const initial=starts.get(s)!,after=totals(s.sdk.getInventory());
            requireThat(at(s,BANK)&&alive(s),'Safe return unconfirmed '+s.name);
            requireThat(JSON.stringify(s.sdk.getEquipment())===initial.equipment&&Object.keys({...initial.inventory,...after}).every(id=>
                Number(id)===FOOD||Number(id)===ORE||(s===miner&&MINING_GEMS.has(Number(id))?
                    (after[Number(id)]??0)>=(initial.inventory[Number(id)]??0):
                    (initial.inventory[Number(id)]??0)===(after[Number(id)]??0))),'Unrelated carried assets differ '+s.name);
        }
    } catch(error) {
        failure=String(error);holding=false;
        const returned=await Promise.allSettled(sessions.map(async s=>{if(walkers.has(s)&&alive(s))await home(s);}));
        returned.forEach((r,i)=>{if(r.status==='rejected')failure+=' | retreat '+sessions[i]!.name+': '+String(r.reason);});
    } finally {
        holding=false;offs.forEach(off=>off());feed?.close();
    }
    for(const s of sessions){const b=starts.get(s)!;report.actors.push({name:s.name,ticks:s.tick()-b.tick,wallMs:Date.now()-b.wall,
        foodUsed:b.food-held(s,FOOD),hpStart:b.hp,hpMin:b.min,hpEnd:hp(s),prayerStart:b.prayer,prayerEnd:prayer(s),position:tile(s)});}
    const attempts=sessions.map(s=>s.lifecycle?.attemptId);
    const logout=await settle(sessions,!failure&&report.banked===1,failure??'One new Lava Maze Runite banked');
    const loggedOut=sessions.length===2&&sessions.every((s,i)=>{const p=readLogoutProof(s.name,servers[0]!);return p.state==='confirmed'&&p.attemptId===attempts[i];});
    // settle's boolean also includes worker success. Refusal logouts are checked by their own receipts.
    return {...report,ok:!failure&&logout&&loggedOut,logout:loggedOut,failure,wallMs:Date.now()-began};
}
if(import.meta.main){
    try {const result=await runEscortedOre(process.argv.slice(2));console.log('LAVA_ESCORT_RESULT '+JSON.stringify(result));process.exitCode=result.ok?0:1;}
    catch(error){console.log('LAVA_ESCORT_RESULT '+JSON.stringify({ok:false,logout:false,failure:String(error)}));process.exitCode=1;}
}
