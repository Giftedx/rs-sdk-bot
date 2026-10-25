// Seers' Village Flax Spinner: withdraws flax from Seers' Bank (2727,3492),
// walks to spinning wheel house (2715,3470), climbs to 1st floor, spins flax into bow strings,
// climbs down, and banks at Seers' Bank.
// Usage: bun scripts/spin-bowstrings.ts <botName> [CAP ticks, default 15000]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { bankCargo } from '../packages/core/src/cargo';

const SEERS_BANK = { x: 2727, z: 3492, level: 0 };
const WHEEL_HOUSE = { x: 2715, z: 3471, level: 0 };
const WHEEL_SPOT = { x: 2711, z: 3471, level: 1 };

const botName = process.argv[2] ?? 'Ballspinner';
const MAX_MAKE=Number(process.env.MAX_MAKE??56), RAW_RESERVE=Number(process.env.RAW_RESERVE??50);
if(!Number.isSafeInteger(MAX_MAKE)||MAX_MAKE<1||!Number.isSafeInteger(RAW_RESERVE)||RAW_RESERVE<0)throw new Error('invalid MAX_MAKE/RAW_RESERVE');
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);

export function spinInputFailure(made:number,maximum:number,rawBank:number,reserve:number):string {
    return made<maximum&&rawBank<=reserve?'no spinning progress: bank flax at reserve':'';
}
async function main() {
const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    // Wait for initial sync
    await waitUntil(s, st => (st?.inGame ?? false) && (st?.player !== null), { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const flaxCount = () => s.sdk.getInventory().filter(i=>i.id===1779).reduce((n,i)=>n+i.count,0);
    const bowstringsCount = () => countItems(s, /^bow string$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended=false;
    void s.ended.then(()=>{ended=true;});
    const over = () => used() >= CAP || ended;

    const xp0=s.sdk.getSkillXp('Crafting')??0;
    const protectedKit=s.sdk.getInventory().filter(i=>!/^flax$|^bow string$/i.test(i.name)).map(i=>({id:i.id,count:i.count}));
    let hpMin=s.sdk.getSkill('Hitpoints')?.level??10; const life=pos()?.lifeId;let died=false;
    const off=s.onTick(()=>{hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(pos()?.isDead||life!==undefined&&pos()?.lifeId!==life)died=true;});
    let made=0;
    let spunTotal = 0;
    let bankTrips = 0;
    let walkTicks = 0;

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const climbLadder = async (direction: 'up' | 'down'): Promise<boolean> => {
        const targetLevel = direction === 'up' ? 1 : 0;
        const opName = direction === 'up' ? 'Climb-up' : 'Climb-down';
        for (let attempt = 0; attempt < 3 && !over(); attempt++) {
            if (pos()?.level === targetLevel) return true;
            const ladder = s.sdk.findNearbyLoc(/^ladder$/i);
            if (ladder) {
                await s.bot.interactLoc(ladder, opName);
                await waitTicks(s, 2);
                if (pos()?.level === targetLevel) return true;
            }
            await waitTicks(s, 1);
        }
        return pos()?.level === targetLevel;
    };

    const bank = async (withdraw=true) => {
        if (pos()?.level === 1) {
            await climbLadder('down');
        }
        await walk(SEERS_BANK.x, SEERS_BANK.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }

        // Bank certificates first: a noted stack is not a usable spinning ingredient.
        const note=s.sdk.getInventory().find(i=>i.id===1780);
        if(note){
            const before=s.sdk.getState()?.bank?.items.filter(i=>i.id===1779).reduce((n,i)=>n+i.count,0)??0;
            const amount=note.count;await s.bot.depositItem(note,-1);await waitTicks(s,1);
            const after=s.sdk.getState()?.bank?.items.filter(i=>i.id===1779).reduce((n,i)=>n+i.count,0)??0;
            if(s.sdk.getInventory().some(i=>i.id===1780)||after!==before+amount)throw new Error('noted flax did not become raw bank stock');
            console.log(`SPIN_NOTES deposited=${amount} rawBank=${after}`);
        }

        // Deposit bow strings and any junk
        if (bowstringsCount() > 0) {
            const before=bowstringsCount();
            await s.bot.depositItem(/^bow string$/i, -1);
            spunTotal += Math.max(0,before-bowstringsCount());
        }

        await waitTicks(s,1);
        await bankCargo(s,[/^bow string$/i]);

        const stock=s.sdk.getState()?.bank?.items.find(i=>/^flax$/i.test(i.name))?.count??0;
        const held=s.sdk.getInventory().length,free=28-held;
        const take=withdraw?Math.min(free,MAX_MAKE-made,Math.max(0,stock-RAW_RESERVE)):0;
        if(take>0){const r=await s.bot.withdrawItem(/^flax$/i,take);if(!r.success)throw new Error(`withdraw flax: ${r.message}`);}
        await waitTicks(s, 1);
        await s.bot.closeInterface();
        bankTrips++;
        console.log(`MILESTONE bank t=${used()} spunTotal=${spunTotal} bankTrips=${bankTrips} flax=${flaxCount()}`);
    };

    const spin = async () => {
        // Must be on 1st floor
        if (pos()?.level === 0) {
            await walk(WHEEL_HOUSE.x, WHEEL_HOUSE.z, 1);
            await climbLadder('up');
        }

        const wheel = s.sdk.findNearbyLoc(/^spinning wheel$/i);
        if (!wheel) {
            console.log('WARN spinning wheel not found nearby');
            await waitTicks(s, 3);
            return;
        }

        if ((s.sdk.getSkill('Crafting')?.baseLevel ?? 1) < 10) throw new Error('flax requires Crafting 10');
        const clearLevelup=async()=>{
            let lastPage='';
            for(let i=0;i<12;i++){
                const d=s.sdk.getDialog();if(!d?.isOpen)return;
                const option=d.options.length===1&&/continue/i.test(d.options[0]!.text)?d.options[0]:null;
                if(!option)throw new Error('unexpected dialog during batch spinning');
                const key=d.pageId??JSON.stringify(d.options);
                if(key!==lastPage){console.log(`SPIN_CONTINUE page=${key}`);await s.sdk.sendClickDialog(option.index);lastPage=key;}
                await waitTicks(s,1);
            }
            throw new Error('level-up dialog did not clear');
        };
        let missed=0;
        while(flaxCount()>0 && made<MAX_MAKE && !over()) {
            if(s.sdk.getDialog()?.isOpen)await clearLevelup();
            await s.bot.interactLoc(wheel,'Spin');
            const menu=await waitUntil(s,()=>s.sdk.getDialog()?.options.some(o=>o.componentId===8875)??false,{timeoutTicks:8});
            const d=s.sdk.getDialog();console.log('SPIN_MENU '+JSON.stringify(d));
            const makeX=d?.options.find(o=>o.componentId===8875),flax=d?.options.find(o=>o.componentId===8878&&/flax/i.test(o.text));
            if(!menu||!makeX||!flax)throw new Error('fresh flax MakeX menu not observed');
            const amount=Math.min(flaxCount(),MAX_MAKE-made),before=flaxCount();
            await s.sdk.sendClickDialog(makeX.index);await s.sdk.sendCountDialog(amount);
            let last=before,lastProgress=s.tick();
            while(flaxCount()>before-amount&&!over()){
                await waitTicks(s,1);const n=flaxCount();
                if(n<last){made+=last-n;last=n;lastProgress=s.tick();missed=0;}
                const dialog=s.sdk.getDialog();
                if(dialog?.isOpen && dialog.options.length===1 && /continue/i.test(dialog.options[0]!.text)){await clearLevelup();break;}
                if(s.tick()-lastProgress>=8){if(++missed>=3)throw new Error('batch flax spinning made no progress');break;}
            }
        }

    };

    console.log(`START spin-bowstrings ${botName} at=${pos()?.worldX},${pos()?.worldZ},${pos()?.level}`);

    await bank();
    while (!over() && made<MAX_MAKE && bankTrips<Number(process.env.MAX_TRIPS??Infinity)) {
        if(flaxCount()===0){await bank();if(flaxCount()===0)break;}
        await spin();
    }
    await bank(false);
    if(flaxCount()>0)throw new Error('unprocessed flax remains after bound');
    if(!(await s.bot.openBank()).success)throw new Error('final bank failed');await waitTicks(s,2);
    const bankItems=s.sdk.getState()?.bank?.items??[];
    const rawBank=bankItems.filter(i=>/^flax$/i.test(i.name)).reduce((n,i)=>n+i.count,0);
    const stringsBank=bankItems.filter(i=>/^bow string$/i.test(i.name)).reduce((n,i)=>n+i.count,0);
    const preserved=protectedKit.every(i=>s.sdk.getInventory().filter(j=>j.id===i.id).reduce((n,j)=>n+j.count,0)===i.count);
    const xpGain=(s.sdk.getSkillXp('Crafting')??0)-xp0;
    const ok=made===MAX_MAKE&&spunTotal===made&&rawBank>=RAW_RESERVE&&preserved&&!died&&hpMin>=7&&xpGain>0;
    const inputFailure=spinInputFailure(made,MAX_MAKE,rawBank,RAW_RESERVE),stop=inputFailure?'input-wait':ok?'target':'incomplete';
    console.log('SPIN_BANK '+JSON.stringify({ok,made,spunTotal,rawBank,stringsBank,preserved,xpGain,hpMin,died,targetMet:ok,stop,inventory:s.sdk.getInventory(),bank:bankItems}));
    await s.bot.closeBank();off();
    await finish([s],ok,`${inputFailure?inputFailure+' ':''}ticks=${used()} made=${made} spunTotal=${spunTotal} rawBank=${rawBank} xpGain=${xpGain} preserved=${preserved} hpMin=${hpMin} died=${died} targetMet=${ok?1:0} stop=${stop}`);
} catch(e){await finish([s],false,String(e));}
}
if(import.meta.main) await main();
