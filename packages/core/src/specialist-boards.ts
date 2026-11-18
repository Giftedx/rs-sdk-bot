// The specialist accounts and the skill board each one runs a fresh clock for. Every account here stays offline until
// its scored launch (packages/core/src/specialist-launch.ts). This leaf module has no imports, so controller code can
// read the reservation list without loading the launch gate.
export const SPECIALIST_BOARDS: Readonly<Record<string, {name:string; category:number}>> = {
    shaftshooter: {name:'Ranged', category:5},
    polevaulter: {name:'Agility', category:17},
    hiltsdeep: {name:'Attack', category:1},
};

// The main account and the specialists: no planner, recovery or transfer plan may put them online.
export const RESERVED_ACCOUNTS: readonly string[] = ['haggis', ...Object.keys(SPECIALIST_BOARDS)];
