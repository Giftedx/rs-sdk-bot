// The specialist accounts and the skill board each one runs a fresh clock for. Every account here stays offline until
// its scored launch (packages/core/src/specialist-launch.ts). This leaf module has no imports, so controller code can
// read the reservation list without loading the launch gate.
export const SPECIALIST_BOARDS: Readonly<Record<string, {name:string; category:number}>> = {
    hiltsdeep: {name:'Attack', category:1},
    rocksolid: {name:'Defence', category:2},
    bigswinger: {name:'Strength', category:3},
    fullblooded: {name:'Hitpoints', category:4},
    shaftshooter: {name:'Ranged', category:5},
    bigboner: {name:'Prayer', category:6},
    castmyload: {name:'Magic', category:7},
    nockandload: {name:'Fletching', category:10},
    lochnessrod: {name:'Fishing', category:11},
    cutmyjewels: {name:'Crafting', category:13},
    steelrod: {name:'Smithing', category:14},
    mineshafted: {name:'Mining', category:15},
    grindmyherb: {name:'Herblore', category:16},
    polevaulter: {name:'Agility', category:17},
    dipyourwick: {name:'Thieving', category:18},
    pouchstuffed: {name:'Runecraft', category:21},
};

// The main account and the specialists (including retired specialist clocks kept offline): no planner, recovery or transfer plan may put them online.
export const RESERVED_ACCOUNTS: readonly string[] = ['haggis', 'justthetip', ...Object.keys(SPECIALIST_BOARDS)];
