// Tribal Totem (scripts/generated/quest-totem.ts) on an ordinary account: which steps a resumed quest skips and how the
// bot crosses from Brimhaven to Ardougne. The journal shows one colour for stages 1 to 4 (varp 200, quest_totem.constant),
// and each step on the way is idempotent on the server (quest_totem.rs2, rdpt_employee.rs2, wizard_cromperty.rs2):
// the horn crate gives the label whenever it is not held, the teleport crate answers "already replaced" past stage 2,
// the RPDT employee only offers the delivery option at stage 2 and Cromperty teleports at any stage before complete.
import type {QuestFlag} from '../packages/core/src/quest-status';

export const TOTEM_FARE=30, ROUND_TRIP_FARE=2*TOTEM_FARE;
export const CUSTOMS_OFFICER_ARDOUGNE='npc:customs_officer:ardougne@2772,3225';

// Kangai Mau starts the quest only while it is not started; a started quest answers "Have you got our totem back?".
export function totemStartsAtKangai(state:QuestFlag['state']):boolean{
    return state==='not started'||state==='unknown';
}

// Ardougne Teleport needs Plague City, Magic 51, a law and a water rune (magic_spells.dbrow); otherwise the customs
// officer's boat from Brimhaven (customs_officer.rs2:82) for TOTEM_FARE coins, with Captain Barnaby's fare back.
export type TotemTravel={how:'teleport'}|{how:'boat'}|{how:'missing';detail:string};
export function totemTravel(a:{plagueCity:QuestFlag['state'];magic:number;law:number;water:number;coins:number}):TotemTravel{
    if(a.plagueCity==='complete'&&a.magic>=51&&a.law>=1&&a.water>=1)return {how:'teleport'};
    if(a.coins<ROUND_TRIP_FARE)return {how:'missing',detail:`missing 995:${ROUND_TRIP_FARE} for the Brimhaven and Ardougne boats`};
    return {how:'boat'};
}
