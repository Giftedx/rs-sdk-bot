import type {SaveConfig} from '../presets';
import type {readPracticeSave} from '../fleet-player-save';

export type Save=ReturnType<typeof readPracticeSave>;
export type CaseRecord={id:string;exit:number;timedOut:boolean;saveMatched:boolean;seconds:number};

// The tick of this proof: 75 ms. At 75 ms the game outcome equals the one at 150 ms (hosted rounds 44446240837, 44447190266 and 44447293486: same results, items and XP; only wall seconds differ), at half the wall time.
export const QUEST_SWEEP_TICK_MS=75;
// Refusal cases end with exit 1; every other case must exit 0. The checks below keep their own child rule.
export const questSweepExpectedExit=(id:string)=>id==='ball-missing-gloves'||id==='doric-no-cash'||id==='scorpion-complete-refusal'?1:0;

// quest.constant scorpcatcher_complete=6. The reward is stat_advance(strength, 66250) at 25x (rawExperience units).
export const SCORPION_COMPLETE=6,SCORPION_STRENGTH=66250*25,SCORPION_TRAINED=[0,1,2,3,4,6];
export const SCORPION_BANK=[{id:995,count:268},{id:563,count:8},{id:556,count:31},{id:555,count:5},{id:554,count:1},{id:379,count:4}];
export const SCORPION_MELEE_BANK=SCORPION_BANK.map(i=>i.id===995?{id:995,count:1292}:i);
export const SCORPION_RANGED_BANK=[...SCORPION_BANK,{id:175,count:1},{id:882,count:40}];
// The staged consumables: Barcrawl and Scorpion runes, the Jailer's arrows and the meals. The run can use any part of
// each, never more and never a gain. Meals used must equal the eats in RESULT. Thormac's cage and the Barcrawl card
// leave the pack by the end (inv_del), so they have no net change. The two keys stay as gains.
export const SCORPION_SPENT=[554,555,556,557,558,562,563,882,884,886,888,890,892],SCORPION_MEALS=[379,385,373,361,333,329];
export const SCORPION_POTION_NEXT:Readonly<Record<number,number>>={2446:175,175:177,177:179,179:229,2448:181,181:183,183:185,185:229};
export const SCORPION_BOATS=new Set(['npc:captain_barnaby:brimhaven@2679,3275','npc:customs_officer:port-sarim@2953,3147',
 'npc:customs_officer:ardougne@2772,3231','npc:captain_tobias:karamja-musa-point@3028,3216']);

export const ELENA_DUST_ENTRY={x:2529,z:3162,level:1},ELENA_DUST_DOWN={x:2525,z:3162,level:0};
// shopPlan reserves 124 coins for four buckets across its sellers, plus Heckel's 106-coin reserve.
export const ELENA_COINS=230;
export const ELENA_DUST_FUNDS=[{id:995,count:82904},{id:563,count:1},{id:556,count:4},{id:555,count:2}];
export const ELENA_DUST_BANK=[{id:995,count:1680},{id:1929,count:4}];
export function questSweepElenaPreset():SaveConfig{
 // The funded live entry has maxed combat and one Falador teleport (four Air runes cannot cast Camelot).
 // Water is staged in the bank, so the missing-input pass must still reach a bank before Heckel's shop.
 return{position:{...ELENA_DUST_ENTRY},skills:{Attack:99,Defence:99,Strength:99,Hitpoints:99,Ranged:99,Prayer:99,Magic:99},bank:ELENA_DUST_BANK.map(i=>({...i})),
  inventory:[...ELENA_DUST_FUNDS.map(i=>({...i})),...[2126,952,954,1927,231].map(id=>({id,count:1}))]};
}

export const DORIC_ORES=[{id:434,count:6},{id:436,count:4},{id:440,count:2}],PICKAXES=[1265,1267,1269,1271,1273,1275];
export const MINING_GEM_BYPRODUCTS=[1617,1619,1621,1623] as const;
export const IMP_BEADS=[1470,1472,1474,1476];
export const QUEST_SWEEP_PROOF_CASE_IDS=['scorpion-barcrawl','scorpion-ranged-barcrawl','scorpion-complete-refusal','ball-worn-kit','ball-missing-gloves','bank-stage','doric-self-supply','doric-no-cash','retained-ghost','banked-ghost','fishing-stage','clock-stage','ernest-fortress','vampire-started','totem-started-cakes','hunt-crowded','rj-pirate-letter','rj-pirate-started','elena-heckel-dust','blackknight-finish','imp-surplus-beads','fluffs-yard-exit'] as const;
// Magicwanda's failed entry: Gertrude's Cat with the kitten given (%fluffs 5, varp 180), Magic 1, on the tile inside the
// lumber yard where the walk ran out (3296,3497,0). Gertrude adds a chocolate cake 1897 and a stew 2003; the kitten is a
// follower, not an item (gertrude.rs2:50-60, pet.rs2 cat_spawn).
export const FLUFFS_ENTRY={x:3296,z:3497,level:0},FLUFFS_FENCE_OUT={x:3305,z:3492,level:0};

// Explicit `--case=<id>` arguments select cases for the run and the verifier. No argument selects every case.
// The selected melee Scorpion acceptance also requires the ranged regression, for both native and saved checks.
// An unknown, empty or repeated selection refuses before any stack or save is touched.
export function selectQuestSweepProofCases(argv:readonly string[]):string[]{
 const picked=argv.filter(a=>a.startsWith('--case')).map(a=>{
  if(!a.startsWith('--case='))throw Error(`quest-sweep proof case selection must be --case=<id>: ${a}`);
  return a.slice('--case='.length);
 });
 if(!picked.length)return [...QUEST_SWEEP_PROOF_CASE_IDS];
 for(const id of picked)if(!(QUEST_SWEEP_PROOF_CASE_IDS as readonly string[]).includes(id))throw Error(`unknown quest-sweep proof case ${id||'(empty)'}`);
 if(new Set(picked).size!==picked.length)throw Error('repeated quest-sweep proof case selection');
 return QUEST_SWEEP_PROOF_CASE_IDS.filter(id=>picked.includes(id)||id==='scorpion-ranged-barcrawl'&&picked.includes('scorpion-barcrawl'));
}
