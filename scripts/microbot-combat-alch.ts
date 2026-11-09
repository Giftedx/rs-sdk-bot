// AIOFighter HighAlchScript39/43/84 and Rs2ItemModel262: profitable owned items, explicit blacklist.
// BSD attribution: research/microbot-ports-LICENSE.txt. Native ordinary alchemy only.
import{readFileSync,existsSync}from'node:fs';
import type{Session}from'../packages/core/src/inprocess';
import{waitTicks}from'../packages/core/src/ticks';
import{equipmentObserved}from'../packages/core/src/container-observation';
import{itemMagicRecipe,itemSpellCosts,runItemMagic,type Recipe}from'./microbot-magic-items';
import type{LootQuoteSnapshot}from'./microbot-loot-trip';
import items from'../knowledge/items.json';
export type CombatAlchPolicy={actor:string;server:string;quotes:LootQuoteSnapshot;ids:number[];blacklist:number[];maximum:number;cap:number;hpFloor:number;minimumProfit:number;reserves:Record<number,number>;xpMultiplier:number;route?:{site:{x:number;z:number;level:number};bank:{x:number;z:number;level:number}};stop?:()=>boolean};
export type PreparedCombatAlch=Readonly<CombatAlchPolicy&{recipes:Readonly<Record<number,Recipe>>}>;
const integer=(n:unknown,min:number,max=2147483647)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
export function prepareCombatAlch(p:CombatAlchPolicy):PreparedCombatAlch{
 if(!p||typeof p.actor!=='string'||!p.actor||typeof p.server!=='string'||!p.server||!Array.isArray(p.ids)||!p.ids.length||p.ids.length>14||!Array.isArray(p.blacklist)||new Set(p.ids).size!==p.ids.length||[...p.ids,...p.blacklist].some(id=>!integer(id,1))||!integer(p.maximum,1,100)||!integer(p.cap,18,10000)||!integer(p.hpFloor,1,99)||!integer(p.minimumProfit,0)||!p.reserves||Object.entries(p.reserves).some(([id,n])=>!integer(Number(id),1)||!integer(n,0))||!Number.isFinite(p.xpMultiplier)||p.xpMultiplier<=0)throw Error('invalid finite owned combat alchemy policy');
 if(p.route)for(const t of[p.route.site,p.route.bank])if(!t||!integer(t.x,0,16383)||!integer(t.z,0,16383)||!integer(t.level,0,3)||t.level!==0)throw Error('explicit native same-plane alchemy route required');
 const q=p.quotes;if(!q||new URL(q.origin).origin!==q.origin||!integer(q.observedAt,0,Number.MAX_SAFE_INTEGER)||!q.prices)throw Error('explicit server-bound unit quote snapshot required');
 const prices:Record<number,{price:number;lastTradeAt:number}>={};for(const id of [...p.ids,561,554]){const v=q.prices[id];if(!v||!integer(v.price,1)||!integer(v.lastTradeAt,0,Number.MAX_SAFE_INTEGER)||v.lastTradeAt>q.observedAt)throw Error('declared item/Nature/Fire unit quote missing');prices[id]=Object.freeze({...v});}
 const recipes:Record<number,Recipe>={};for(const id of p.ids){const item=items.find(i=>i.id===id);if(!item?.tradeable||[995,561,554].includes(id))throw Error('explicit tradeable non-supply alchemy target required');const r=itemMagicRecipe('high-alch',item.debugname);if(r.target!==id)throw Error('native alchemy target differs');itemSpellCosts(r,[],true);recipes[id]=Object.freeze({...r,inputs:Object.freeze({...r.inputs})});}
 return Object.freeze({...p,route:p.route?Object.freeze({site:Object.freeze({...p.route.site}),bank:Object.freeze({...p.route.bank})}):undefined,ids:Object.freeze([...p.ids]) as unknown as number[],blacklist:Object.freeze([...p.blacklist]) as unknown as number[],reserves:Object.freeze({...p.reserves}),quotes:Object.freeze({...q,prices:Object.freeze(prices)}),recipes:Object.freeze(recipes)});
}
export function combatAlchPolicy(env:Record<string,string|undefined>=process.env){if(!env.COMBAT_ALCH_FILE)return;const text=readFileSync(env.COMBAT_ALCH_FILE);if(text.length>32768)throw Error('combat alchemy policy too large');return prepareCombatAlch(JSON.parse(text.toString('utf8')));}
export function combatAlchMargin(p:PreparedCombatAlch,id:number,costs:Record<number,number>){const r=p.recipes[id];if(!r||p.blacklist.includes(id))return;return r.output-p.quotes.prices[id]!.price-Object.entries(costs).filter(([key])=>Number(key)!==id).reduce((sum,[key,n])=>sum+n*p.quotes.prices[Number(key)]!.price,0);}
export const combatAlchCounts=(rows:readonly{id:number;count:number}[])=>{const a:Record<number,number>={};for(const r of rows)a[r.id]=(a[r.id]??0)+r.count;return a;};
// Native deletes runes and the target before inv_add(coins); reserve the resulting slot and stack capacity before payment.
export function combatAlchCapacity(rows:readonly{id:number;count:number}[],costs:Record<number,number>,output:number){
 if(rows.length>28||!integer(output,1)||rows.some(r=>!integer(r.count,1)))return false;
 const remaining={...costs},after=rows.map(r=>{const debit=Math.min(r.count,remaining[r.id]??0);remaining[r.id]=(remaining[r.id]??0)-debit;return{id:r.id,count:r.count-debit};}).filter(r=>r.count>0);
 if(Object.values(remaining).some(n=>n!==0))return false;const coins=after.filter(r=>r.id===995).reduce((n,r)=>n+r.count,0);
 return coins+output<=2147483647&&(coins>0||after.length<28);
}
export function combatLootReceipt(before:Record<number,number>,after:Record<number,number>,item:{id:number;count:number},runes:Record<number,number>={}){return[...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(runes),String(item.id)])].every(key=>(after[+key]??0)-(before[+key]??0)===(+key===item.id?item.count:0)-(runes[+key]??0));}
export function createCombatAlch(s:Session,p:PreparedCombatAlch){
 if(s.name.toLowerCase()!==p.actor.toLowerCase()||s.lifecycle?.account.toLowerCase()!==p.actor.toLowerCase()||s.lifecycle.server!==p.server||new URL(s.sdk.config.browserLaunchUrl).origin!==p.quotes.origin||Date.now()<p.quotes.observedAt||Date.now()-p.quotes.observedAt>60000)throw Error('combat alchemy actor/server/quote admission differs');
 const client=s.client as any,owner=client.executeBotAction,first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,plane=first?.level,start=s.tick();let ended=false,busy=false,blocked=false,casts=0,coins=0;void s.ended.then(()=>{ended=true;});
 const consumed:Record<number,number>={},runes:Record<number,number>={},receipts:any[]=[];
 const unsafe=()=>{const st=s.sdk.getState(),me=st?.player;return ended||s.client!==client||client.executeBotAction!==owner||!Number.isSafeInteger(life)||!me||me.isDead||me.lifeId!==life||(me.respawnCount??0)!==respawns||me.level!==plane||(s.sdk.getSkill('Hitpoints')?.level??0)<p.hpFloor||s.sdk.getStateAge()>5000||!equipmentObserved(client)||st!.nearbyPlayers.length>0||p.stop?.()||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`)||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE);};
 const afterPickup=async(item:{id:number;count:number})=>{
  if(busy||blocked)throw Error('combat alchemy prior outcome unresolved');const recipe=p.recipes[item.id];if(!recipe||p.blacklist.includes(item.id)||casts>=p.maximum)return 0;if(!integer(item.count,1))throw Error('owned loot quantity unknown');let made=0;
  for(let n=0;n<item.count&&casts<p.maximum;n++){
   if(unsafe())throw Error('combat alchemy original owner/life/HP/stop');if(Date.now()-p.quotes.observedAt>60000)break;if(s.tick()-start+18>p.cap)break;
   const st=s.sdk.getState(),player=st?.player;if(!st||!player)throw Error('combat alchemy player absent');if(player.combat.targetType!=='none'||st.nearbyNpcs.some(n=>n.targetIndex===32768+client.selfSlot))throw Error('finish owned combat before profitable alchemy');
   const costs=itemSpellCosts(recipe,s.sdk.getEquipment(),client.membersAccount===1),margin=combatAlchMargin(p,item.id,costs);if(margin===undefined||margin<=p.minimumProfit)break;
   const before=combatAlchCounts(s.sdk.getInventory());if(Object.entries({...p.reserves,...costs}).some(([id])=>(before[+id]??0)-(costs[+id]??0)<(p.reserves[+id]??0)))break;
   if(!combatAlchCapacity(s.sdk.getInventory(),costs,recipe.output))break;
   const position={x:player.worldX,z:player.worldZ};
   const hp=s.sdk.getSkill('Hitpoints')!.level,gear=JSON.stringify(s.sdk.getEquipment()),xp=s.sdk.getSkillXp('Magic')??0,other=JSON.stringify(st.skills.filter(k=>k.name!=='Magic').map(k=>[k.name,k.experience]));busy=true;blocked=true;
   try{const result=await runItemMagic(s,recipe,{count:1,cap:Math.min(12,p.cap-(s.tick()-start)),members:client.membersAccount===1,stop:()=>!!unsafe()||s.tick()-start>=p.cap||s.sdk.getSkill('Hitpoints')?.level!==hp||s.sdk.getState()?.player?.worldX!==position.x||s.sdk.getState()?.player?.worldZ!==position.z});
    if(!result.ok||unsafe()||s.sdk.getSkill('Hitpoints')?.level!==hp||gear!==JSON.stringify(s.sdk.getEquipment())||other!==JSON.stringify(s.sdk.getState()!.skills.filter(k=>k.name!=='Magic').map(k=>[k.name,k.experience]))||(s.sdk.getSkillXp('Magic')??0)-xp!==65*p.xpMultiplier)throw Error('combat alchemy exact owned spell receipt unconfirmed');
    casts++;made++;coins+=recipe.output;consumed[item.id]=(consumed[item.id]??0)+1;for(const[id,count]of Object.entries(costs))if(+id!==item.id)runes[+id]=(runes[+id]??0)+count;receipts.push({id:item.id,costs,coins:recipe.output,margin,magicXp:65*p.xpMultiplier,tick:s.tick(),quoteObservedAt:p.quotes.observedAt});
    // Native high alchemy retains p_delay3 after publishing its output.
    const settledPack=JSON.stringify(combatAlchCounts(s.sdk.getInventory()));for(let k=0;k<4;k++){if(unsafe()||s.tick()-start>=p.cap||gear!==JSON.stringify(s.sdk.getEquipment())||s.sdk.getSkill('Hitpoints')?.level!==hp||JSON.stringify(combatAlchCounts(s.sdk.getInventory()))!==settledPack)throw Error('combat alchemy cooldown stopped');await waitTicks(s,1);}blocked=false;
   }finally{busy=false;}
  }return made;
 };
 return{afterPickup,stopped:()=>blocked||!!unsafe(),consumed,runes,receipts,get casts(){return casts;},get coins(){return coins;},get blocked(){return blocked;}};
}
