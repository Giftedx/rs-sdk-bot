// The altar data of the rune carrier pipeline: one row for each altar that a crafter can hold while carriers bring
// essence. scripts/rune-carrier-altar.test.ts checks every number against the pinned server content:
//  - level, experience (tenths of XP), rune, talisman, multiplier and enter_coord:
//    vendor/rs-sdk/server/content/scripts/skill_runecraft/configs/runecraft.dbrow
//  - rune and talisman ids: content/pack/obj.pack; altar loc ids: content/pack/loc.pack
//  - altar placement: content/maps/m<square>.jm2 (each altar is a 3x3 loc of shape 10)
//  - runes for each essence: skill_runecraft/scripts/runecraft.rs2 [label,runecraft_runes],
//    calc($level / multiplier + 1) when the row has a multiplier, else 1
//  - carriers' bank: packages/planner/src/haggis-travel.json nearestBank["<name>-ruins"] (rs-sdk pathfinder legs)
// The crafter stands at the west face of the altar, middle row; the carriers stage one tile north of it. Body is
// the pipeline's first altar (crafter 2523,4832, staging 2523,4833); the other rows take the same faces, and the
// test checks that each tile is walkable and reachable from the entry tile.
// This module imports nothing, so a test that mocks the bank or trade module keeps these rows.
export type Point={x:number;z:number};
export type CarrierAltarName='air'|'mind'|'water'|'earth'|'fire'|'body';
export interface RuneCarrierAltar{
 name:CarrierAltarName;level:number;
 // runecraft_table:experience is in tenths of an XP point.
 xpTenths:number;
 rune:number;talisman:number;
 // runecraft_table:multiplier; null when the row has none (one rune for each essence).
 multiplier:number|null;
 altar:{id:number;x:number;z:number};
 enter:Point;
 bank:Point&{site:string};
 crafter:Point;staging:Point;
}
const row=(name:CarrierAltarName,level:number,xpTenths:number,rune:number,talisman:number,multiplier:number|null,
 altar:{id:number;x:number;z:number},enter:Point,bank:Point&{site:string}):RuneCarrierAltar=>
 ({name,level,xpTenths,rune,talisman,multiplier,altar,enter,bank,crafter:{x:altar.x-1,z:altar.z+1},staging:{x:altar.x-1,z:altar.z+2}});
const FALADOR_EAST={x:3013,z:3355,site:'bank:falador-east-bank:0'},EDGEVILLE={x:3094,z:3491,site:'bank:edgeville-bank:0'},
 DRAYNOR={x:3092,z:3243,site:'bank:draynor-bank:0'},VARROCK_EAST={x:3254,z:3420,site:'bank:varrock-east-bank:0'},
 AL_KHARID={x:3269,z:3167,site:'bank:al-kharid-bank:0'};
export const RUNE_CARRIER_ALTARS:readonly RuneCarrierAltar[]=[
 row('air',1,50,556,1438,11,{id:2478,x:2843,z:4833},{x:2841,z:4830},FALADOR_EAST),
 row('mind',2,55,558,1448,14,{id:2479,x:2785,z:4840},{x:2793,z:4829},EDGEVILLE),
 row('water',5,60,555,1444,19,{id:2480,x:2715,z:4835},{x:2725,z:4832},DRAYNOR),
 row('earth',9,65,557,1440,26,{id:2481,x:2657,z:4840},{x:2657,z:4830},VARROCK_EAST),
 row('fire',14,70,554,1442,35,{id:2482,x:2584,z:4837},{x:2576,z:4848},AL_KHARID),
 row('body',20,75,559,1446,46,{id:2483,x:2524,z:4831},{x:2523,z:4838},EDGEVILLE),
];
// The other runecraft.dbrow rows. The pipeline does not run them; each reason names the gate it does not cross.
export const UNSUPPORTED_CARRIER_ALTARS:readonly {name:string;reason:string}[]=[
 {name:'cosmic',reason:'members; the ruins are in Zanaris (Lost City quest gate) and the travel cache has no Zanaris leg'},
 {name:'chaos',reason:'members; Wilderness ruins (players attack carriers) and a multi-level maze: enter_coord is on level 3'},
 {name:'nature',reason:'members; Karamja ruins whose nearest bank is in Shilo Village (Shilo Village quest gate); no RUNE_ALTARS row'},
 {name:'law',reason:'members; Entrana ruins: a boat each trip, no weapons or armour, and no bank on the island'},
 {name:'death',reason:'members; the row puts altar, entry and exit on one Lumbridge tile (3221,3218): this content has no death temple'},
];
export const BODY_CARRIER_ALTAR=carrierAltar('body');
export function carrierAltar(name:string):RuneCarrierAltar{
 const a=RUNE_CARRIER_ALTARS.find(r=>r.name===name);
 if(!a)throw Error(`no rune carrier altar ${name}: ${UNSUPPORTED_CARRIER_ALTARS.find(r=>r.name===name)?.reason??'not a runecraft altar'}`);
 return a;
}
export const runesPerEssence=(a:Pick<RuneCarrierAltar,'multiplier'>,level:number)=>a.multiplier===null?1:Math.floor(level/a.multiplier)+1;
export const carrierXpPerEssence=(a:Pick<RuneCarrierAltar,'xpTenths'>,rate:number)=>rate*a.xpTenths/10;
// Every temple is on level 0 in the map square of its entry tile.
export const insideCarrierAltar=(a:Pick<RuneCarrierAltar,'enter'>,p:{worldX:number;worldZ:number;level:number}|null|undefined)=>
 !!p&&p.level===0&&Math.floor(p.worldX/64)===Math.floor(a.enter.x/64)&&Math.floor(p.worldZ/64)===Math.floor(a.enter.z/64);
