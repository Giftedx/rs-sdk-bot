// One local actor clones the fresh owned Abra snapshot, buys one glove, and banks it.
// Operator supplies an existing practice stack. This never starts/stops a stack or a live actor.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createBot} from '../../packages/practice/src/bots';
import {applyPreset} from '../../packages/practice/src/presets';
import {runBotName} from '../../packages/practice/src/prove';
import {readPracticeSave, setPracticeSkills, waitPracticeSave} from './fleet-player-save';
import {PROFILES} from '../shop-buyer';

const script = 'scripts/shop-buyer.ts';
const expected = '8EC89E8467EEFED8EC0B22A807EE2CFA63DACCE74B5A459612BCA34ADB70F886';
const sourceSha256 = createHash('sha256').update(readFileSync(script)).digest('hex').toUpperCase();
if (sourceSha256 !== expected || process.env.REUSE_STACK !== '1') throw new Error('frozen buyer and operator-owned existing stack required');
const profile = PROFILES.thessalia;
if (!profile || profile.npcSpot.x !== 3204 || profile.npcSpot.z !== 3417 || profile.bankSpot.x !== 3253
    || profile.bankSpot.z !== 3420 || profile.items.length !== 1 || !profile.items[0]!.re.test('Leather gloves'))
    throw new Error('one-glove Thessalia profile unavailable');
type Item = {id:number; count:number; slot?:number};
type Skill = {name:string; level:number; xp:number};
type Status = {name:string; server:string; at:number; bankAt:number; result:string; pos:{x:number;z:number;level:number};
    hp:{now:number;max:number}; inventory:Item[]; equipment:(Item & {slot:number})[] | null; bank:Item[]; skills:Skill[]};
const sourcePath = resolve(process.env.SOURCE_STATUS ?? '.practice/status/Abracadickra.json');
const sourceBytes = readFileSync(sourcePath);
const source = JSON.parse(sourceBytes.toString()) as Status;
const recent = (at:number) => Number.isFinite(at) && Date.now()-at >= -5000 && Date.now()-at <= 30*60*1000;
if (source.name !== 'Abracadickra' || source.server !== 'rs-sdk-demo.fly.dev' || !recent(source.at) || !recent(source.bankAt)
    || !source.result?.startsWith('ok ') || !Array.isArray(source.equipment) || !Array.isArray(source.bank)
    || !Array.isArray(source.inventory) || source.skills?.length !== 21 || source.hp.now !== 10 || source.hp.max !== 10
    || source.pos.level !== 0 || Math.max(Math.abs(source.pos.x-3253), Math.abs(source.pos.z-3420)) > 3)
    throw new Error('requires fresh completed owned Abra bank read, known equipment, HP10 and Varrock East start');
const count = (items:Item[], id:number) => items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const knownEquipment = source.equipment;
const sourceTotal = [...source.inventory,...source.bank,...knownEquipment];
if (count(sourceTotal,1059) !== 0 || count(source.inventory,315) !== 1 || count(source.inventory,2309) !== 1
    || count(source.inventory,995) < 5050 || count(sourceTotal,995) !== 18047)
    throw new Error('fixture must use actual unmodified 18047 owned GP, both foods, and no existing gloves');
if (sourceTotal.some(i=>!Number.isSafeInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count)||i.count<=0))
    throw new Error('invalid source assets');
const world = JSON.parse(readFileSync('knowledge/ubermouse/world.json','utf8'));
const booths:{id:number;tile:{x:number;z:number;level:number}}[] = world.features.filter((f:any)=>f.source==='loc'
    && f.id===2213 && f.tile?.level===0 && f.tile.z===3419 && [3252,3253,3254,3256].includes(f.tile.x));
if (booths.length !== 4) throw new Error('actual Varrock East booth source facts changed');
const atBooth = (p:{x:number;z:number;level:number}) => p.level===0 && booths.some(b=>Math.max(Math.abs(p.x-b.tile.x),Math.abs(p.z-b.tile.z))<=1);
if (!atBooth(source.pos)) throw new Error('source not adjacent to actual bank booth');
const free = Number(Bun.spawnSync(['powershell','-NoProfile','-Command','(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB'],{windowsHide:true}).stdout.toString().trim());
if (!Number.isFinite(free) || free < 9) throw new Error(`single practice actor needs9GiB; actual=${free}`);
const dir = resolve('.practice/fleet-proof'); mkdirSync(dir,{recursive:true});
const actor = runBotName('flglove',1), prefix = `thessalia-${actor}`;
writeFileSync(resolve(dir,`${prefix}-source.json`),sourceBytes);
await createBot(actor);
const path = await applyPreset(actor,{position:source.pos,skills:Object.fromEntries(source.skills.map(s=>[s.name,s.level])),
    inventory:source.inventory.map(i=>({id:i.id,count:i.count})), equipment:knownEquipment,
    bank:source.bank.map(i=>({id:i.id,count:i.count}))});
setPracticeSkills(path,source.skills);
const initial = readPracticeSave(path);
const totals = (s:typeof initial) => {
    const m = new Map<number,number>();
    for (const items of Object.values(s.inventories)) for (const i of items) m.set(i.id,(m.get(i.id)??0)+i.count);
    return m;
};
const before = totals(initial);
for (const id of new Set([...sourceTotal.map(i=>i.id),...before.keys()]))
    if ((before.get(id)??0)!==count(sourceTotal,id)) throw new Error('fixture asset clone mismatch');
if (initial.skills.some((s,i)=>s.xp!==source.skills[i]!.xp || s.level!==source.skills[i]!.level)) throw new Error('fixture skill clone mismatch');
writeFileSync(resolve(dir,`${prefix}-initial.json`),JSON.stringify(initial,null,2));
console.log(`PROOF_START actor=${actor} source=${sourceSha256} ownedStatusAt=${source.at} equipmentKnown=true freeGiB=${free}`);
const p = Bun.spawn(['bun','--preload',resolve('scripts/measure/fleet-observe.ts'),resolve(script),actor,'thessalia','400','100'],{
    env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',PROOF_EXPECT_SKILLS:JSON.stringify(source.skills),PROOF_TRACE_PATH:'1',
        STOCK_TARGET:'1',MAX_ITEMS:'1',MAX_SPEND:'50',COIN_RESERVE:'5000',NO_BUY_TICKS:'25',STOP_AT_TARGET:'1',FLOAT:'5050'},stdout:'pipe',stderr:'pipe',windowsHide:true});
let output='', stoppedOnDamage=false, timedOut=false, forcedKill=false;
const stop = (why:string) => writeFileSync(resolve('.practice',`stop-${actor}`),why);
const timer = setTimeout(()=>{timedOut=true;stop('local one-glove proof timed out');},240000);
const hardTimer = setTimeout(()=>{forcedKill=true;p.kill();},285000);
const read = async(stream:ReadableStream<Uint8Array>) => {for await (const b of stream) {
    const part = new TextDecoder().decode(b); output+=part;
    writeFileSync(resolve(dir,`${prefix}.log`),output); process.stdout.write(part);
    if (!stoppedOnDamage && output.includes('PROOF_DAMAGE ')) {stoppedOnDamage=true;stop('local one-glove proof HP damage');}
}};
await Promise.all([read(p.stdout),read(p.stderr)]); const code = await p.exited; clearTimeout(timer);clearTimeout(hardTimer);
const final = await waitPracticeSave(path,s=>count(s.inventories[95]??[],1059)===1 && atBooth(s.position));
const after = totals(final.save), spent = (before.get(995)??0)-(after.get(995)??0);
const assets = [...new Set([...before.keys(),...after.keys()])].every(id=>id===995 || (after.get(id)??0)===(before.get(id)??0)+(id===1059?1:0));
const equipment = JSON.stringify(final.save.inventories[94]??[])===JSON.stringify(initial.inventories[94]??[]);
const xp = final.save.skills.every((s,i)=>s.xp===initial.skills[i]!.xp && s.level===initial.skills[i]!.level);
const life = /PROOF_SURVIVAL started=true died=false hpMin=10 finalHp=10/.test(output);
const resultLine = output.match(/^RESULT ok (.+)$/m)?.[1]??'';
const field = (key:string) => Number(resultLine.match(new RegExp(`(?:^| )${key}=([0-9]+)(?: |$)`))?.[1]??NaN);
const production = field('boughtTotal')===1 && field('bankedTotal')===1 && field('targetMet')===1 && field('spentTotal')===spent;
const banked = count(final.save.inventories[95]??[],1059)===1 && count(final.save.inventories[93]??[],1059)===0;
const ok = code===0 && final.matched && production && banked && assets && equipment && xp && life && atBooth(final.save.position)
    && spent>0 && spent<=50 && (after.get(995)??0)>=5000 && !stoppedOnDamage && !timedOut && !forcedKill && output.includes('LOGOUT logged-out');
writeFileSync(resolve(dir,`${prefix}-snapshot.json`),JSON.stringify({ok,actor,sourceSha256,sourcePath,sourceStatusAt:source.at,
    sourceSnapshotSha256:createHash('sha256').update(sourceBytes).digest('hex'),qualification:'exact fresh owned Abra stocks/skills/equipment; no injected funds or supplies',
    booths,code,resultLine,production,banked,assets,equipment,xp,life,spent,stoppedOnDamage,timedOut,forcedKill,initial,final:final.save},null,2));
console.log(`PROOF_GATE thessalia ok=${ok} newBankedGloves=${count(final.save.inventories[95]??[],1059)} spent=${spent} assets=${assets} equipment=${equipment} xp=${xp} life=${life}`);
process.exitCode=ok?0:1;
