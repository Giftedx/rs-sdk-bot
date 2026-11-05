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
export function onKaramja(p:{x:number;z:number}):boolean{
    return p.z<=3260&&p.x>=2690&&p.x<=2960;
}

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
