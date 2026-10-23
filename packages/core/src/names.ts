// Live account names. Owner rules (2026-10-23): no codes or timestamps, the name fits the job, and every name is a
// sly double meaning. Server rule (vendor/rs-sdk/bots/create-bot.ts): 1-12 letters or digits. Names are taken in
// list order; a name someone else already owns fails at login, so the caller moves on to the next one.
// Do not reorder or remove a name once an account uses it: status.ts finds a bot's role from these lists.

export const NAMES = {
    thieving: ['Pocketrocket', 'Pocketpython', 'Sneakyshaft', 'Longfingers', 'Quickhandjob', 'Pickmypocket', 'Stiffpicker', 'Pocketbulge', 'Nutsnatcher', 'Knobpicker', 'Stunnedstiff', 'Purseprober', 'Fingerblastr', 'Stallholder'],
    runecraft: ['Wandwaver', 'Woodenstaff', 'Magicwanda', 'Staffstiffy', 'Rubmyrunes', 'Pouchstuffer', 'Bigwandvibes', 'Wandtugger', 'Essencepump'],
    mining: ['Shaftsinker', 'Rockhardpick', 'Deepdigger', 'Hardpickaxe', 'Rockmyshaft', 'Mineshafted', 'Hardrockhank', 'Nuggethunter', 'Pickholder', 'Stonedboner'],
    woodcutting: ['Morningwood', 'Hardwoodhank', 'Bigwoodbill', 'Woodpecker', 'Bigchopper', 'Wiltedwillow', 'Hardoak', 'Woodenuwant', 'Lumberjohnny', 'Yewlongwood'],
    fishing: ['Mightyrod', 'Longrodlarry', 'Rodholder', 'Masterbaiter', 'Bigtackle', 'Rodstroker', 'Fishfingerer', 'Reelmyrod', 'Wormwrangler', 'Harpoonhank'],
    cooking: ['Sausageking', 'Meatpacker', 'Hotdogchef', 'Porksword', 'Saltysausage', 'Beefbaton', 'Sausagefest', 'Bigweiner', 'Meatspinner', 'Spitroaster'],
    crafting: ['Familyjewel', 'Crownjewels', 'Glassblower', 'Jewelbag', 'Ballspinner', 'Leathertool', 'Gemstoner'],
    combat: ['Swordinhand', 'Shaftswinger', 'Bigswordguy', 'Pokesword', 'Swordswallow', 'Unsheathed', 'Bigshield', 'Thickskull', 'Rockhardtank'],
    ranged: ['Earlyshooter', 'Bigquiver', 'Quiverfull', 'Longbowlad', 'Shaftshooter', 'Pullmybow'],
    magic: ['Abracadickra', 'Hocuspokeus', 'Wizardwand', 'Pointyhat', 'Wandwanker', 'Magicmissile', 'Staffoflife', 'Spellbinder'],
    prayer: ['Bigboner', 'Bonezone', 'Boneburier', 'Hardboner', 'Altarboy', 'Kneeler'],
    agility: ['Polevaulter', 'Tightsqueeze', 'Ropeburner', 'Pipecrawler', 'Bigpoledave', 'Logbalancer'],
    firemaking: ['Firecrotch', 'Tinderballs', 'Woodburner', 'Hotlogger', 'Lightmylog'],
    fletching: ['Shaftmaker', 'Nockitoff', 'Bowstringer', 'Whittlewood', 'Featherdtip'],
    smithing: ['Ironrod', 'Steelrod', 'Hammeredhard', 'Anvilpounder', 'Hotforger'],
    herblore: ['Pestlepound', 'Stirmypot', 'Hardherbs', 'Potionboner', 'Mortarboner', 'Grindmyherb', 'Vialvirile'],
    bank: ['Moneyshot', 'Fatstack', 'Bigdeposit', 'Fullvault', 'Loadedwallet', 'Stackedsack', 'Deeppockets'],
    runite: ['Runitehard', 'Lavarockhard', 'Hotrocks', 'Rockhardrune', 'Lavalover', 'Moltenrod', 'Runeboner'],
    helper: ['Bigpackage', 'Fullsack', 'Deliveryboy', 'Lunchboxlad', 'Bulgingsack', 'Heavyload', 'Sackhauler', 'Bigloads', 'Packhorse', 'Ballbag'],
} as const satisfies Record<string, readonly string[]>;

export type Role = keyof typeof NAMES;

export function pickName(role: Role, used: readonly string[]): string {
    const taken = new Set(used.map(n => n.toLowerCase()));
    const name = NAMES[role].find(n => !taken.has(n.toLowerCase()));
    if (!name) throw new Error(`no names left for ${role}`);
    return name;
}
