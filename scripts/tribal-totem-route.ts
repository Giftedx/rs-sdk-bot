// Tribal Totem (scripts/generated/quest-totem.ts) on an ordinary account: which steps a resumed quest skips and how the
// bot travels between Kangai Mau in Brimhaven and Ardougne. The journal shows one colour for stages 1 to 4 (varp 200,
// quest_totem.constant), and each step on the way is idempotent on the server (quest_totem.rs2, rdpt_employee.rs2,
// wizard_cromperty.rs2): the horn crate gives the label whenever it is not held, the teleport crate answers "already
// replaced" past stage 2, the RPDT employee only offers the delivery option at stage 2 and Cromperty teleports at any
// stage before complete.
import type {QuestFlag} from '../packages/core/src/quest-status';

export const TOTEM_FARE=30;
export const CUSTOMS_OFFICER_ARDOUGNE='npc:customs_officer:ardougne@2772,3225';
export const BARNABY_BRIMHAVEN='npc:captain_barnaby:brimhaven@2679,3275';

// Kangai Mau starts the quest only while it is not started; a started quest answers "Have you got our totem back?".
export function totemStartsAtKangai(state:QuestFlag['state']):boolean{
    return state==='not started'||state==='unknown';
}

// Brimhaven and Musa Point lie south of z 3260 between x 2690 and 2960; Ardougne's docks are north of that line.
export {onKaramja} from '../packages/core/src/spawn-index';

// Ardougne Teleport needs Plague City, Magic 51, two law and two water runes (magic_spells.dbrow:102-103).
export const TELEPORT_RUNES={law:2,water:2};
export const canTeleportToArdougne=(a:{plagueCity:QuestFlag['state'];magic:number;law:number;water:number})=>
    a.plagueCity==='complete'&&a.magic>=51&&a.law>=TELEPORT_RUNES.law&&a.water>=TELEPORT_RUNES.water;

// How the bot reaches the Ardougne depot, and the fares it must hold. Every run ends with Captain Barnaby's boat to
// Kangai Mau (one fare). From Karamja: the teleport when castable, else the customs officer's boat (customs_officer.rs2:82,
// one more fare). On the mainland with the quest started: walk; the depot is in Ardougne. On the mainland with the quest
// not started: Barnaby's boat to Brimhaven for Kangai first, then the customs officer's boat back (two more fares).
export type TotemTravel={how:'teleport'|'boat'|'walk'|'sail-to-kangai'}|{how:'missing';detail:string};
export function totemTravel(a:{karamja:boolean;started:boolean;plagueCity:QuestFlag['state'];magic:number;law:number;water:number;coins:number}):TotemTravel{
    const how=a.karamja?(canTeleportToArdougne(a)?'teleport':'boat'):a.started?'walk':'sail-to-kangai';
    const fares=1+(how==='boat'?1:how==='sail-to-kangai'?2:0);
    if(a.coins<fares*TOTEM_FARE)return {how:'missing',detail:`missing 995:${fares*TOTEM_FARE} for ${fares} boat fares (${how})`};
    return {how};
}

// The quest adds the label and then the totem to the pack (inv_add, quest_totem.rs2): with no free slot the engine drops
// the item under the player (InvOps INV_ADD overflow) and the crate still says it is fastened. The items to bank so the
// pack has `need` free slots: everything that is not coins, food or a quest item first, then food beyond keepFood.
export const TOTEM_FOOD=new Set([379,385,373,333,329,351,347,339,361,365,2309,1891]);
export function surplusForSlots(pack:readonly {id:number;count:number}[],need:number,keep:ReadonlySet<number>,food:ReadonlySet<number>=TOTEM_FOOD,keepFood=8):{id:number;count:number}[]{
    const slots=pack.length,want=Math.max(0,need-(28-slots));
    if(want===0)return [];
    const out:{id:number;count:number}[]=[];
    const other=pack.filter(i=>i.id!==995&&!keep.has(i.id)&&!food.has(i.id));
    for(const i of other){if(out.length>=want)break;out.push({id:i.id,count:i.count});}
    const foods=pack.filter(i=>food.has(i.id));
    for(let k=foods.length-1;k>=0&&out.length<want&&foods.length-(out.filter(o=>food.has(o.id)).length)>keepFood;k--)out.push({id:foods[k]!.id,count:foods[k]!.count});
    return out;
}
