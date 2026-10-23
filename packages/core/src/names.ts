// Live account names. Owner rules (2026-10-23): no codes or timestamps, the name fits the job, and every name is a
// sly double meaning. Server rule (vendor/rs-sdk/bots/create-bot.ts): 1-12 letters or digits. Names are taken in
// list order; a name someone else already owns fails at login, so the caller moves on to the next one.

export const NAMES = {
    thieving: ['Pocketrocket', 'Pocketpython', 'Sneakyshaft', 'Longfingers', 'Quickhandjob'],
    runecraft: ['Wandwaver', 'Woodenstaff', 'Magicwanda', 'Staffstiffy'],
    mining: ['Shaftsinker', 'Rockhardpick', 'Deepdigger', 'Hardpickaxe'],
    woodcutting: ['Morningwood', 'Hardwoodhank', 'Bigwoodbill'],
    fishing: ['Mightyrod', 'Longrodlarry', 'Rodholder'],
    cooking: ['Sausageking', 'Meatpacker', 'Hotdogchef'],
    crafting: ['Familyjewel', 'Crownjewels'],
    combat: ['Swordinhand', 'Shaftswinger', 'Bigswordguy'],
    helper: ['Bigpackage', 'Fullsack', 'Deliveryboy', 'Lunchboxlad'],
} as const satisfies Record<string, readonly string[]>;

export type Role = keyof typeof NAMES;

export function pickName(role: Role, used: readonly string[]): string {
    const taken = new Set(used.map(n => n.toLowerCase()));
    const name = NAMES[role].find(n => !taken.has(n.toLowerCase()));
    if (!name) throw new Error(`no names left for ${role}`);
    return name;
}
