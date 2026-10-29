// Live account names (owner rule, AGENTS.md "Accounts"). Every name is a real joke: the RuneScape meaning and the
// innuendo both work for the role, ideally a known phrase or a true double meaning (Moneyshot, Earlyshooter, Porksword,
// YewGotWood). A rude word bolted onto a skill word is not a joke (CoinCock, PickpockDick, NabTheKnob). Scottish where
// it fits. Server rule (vendor/rs-sdk/bots/create-bot.ts): 1-12 letters or digits. Names are taken in list order; a
// name someone else owns fails at login, so the caller moves on. Never remove or reorder a name an account uses:
// status.ts finds a bot's role from these lists. Each list starts with the names in use.

export const NAMES = {
    thieving: ['Pocketrocket', 'Pocketpython', 'Quickhandjob', 'TrouserSnake', 'TheFullMonty', 'UnderMyKilt', 'Fingerblastr'],
    runecraft: ['Wandwaver', 'Woodenstaff', 'Magicwanda', 'Rubmyrunes', 'ChaosInPants', 'Staffstiffy'],
    mining: ['Shaftsinker', 'HardRockCafe', 'Stonedboner', 'Mineshafted'],
    woodcutting: ['Woodpecker', 'Bigchopper', 'Morningwood', 'YewGotWood', 'WoodInMyKilt'],
    fishing: ['Mightyrod', 'Masterbaiter', 'LochNessRod', 'Fishfingerer'],
    cooking: ['Porksword', 'MeatNTwoVeg', 'Spitroaster', 'Sausagefest', 'Saltysausage'],
    crafting: ['Ballspinner', 'Crownjewels', 'Familyjewel', 'Glassblower'],
    combat: ['Swordinhand', 'BraveHardon', 'TossTheCaber', 'Swordswallow', 'Unsheathed'],
    ranged: ['Shaftshooter', 'Earlyshooter', 'Pullmybow', 'Quiverfull'],
    magic: ['Abracadickra', 'Hocuspokeus', 'Wandwanker'],
    prayer: ['Bigboner', 'BoneToPick', 'Bonezone'],
    agility: ['Polevaulter', 'PoleDancer', 'Tightsqueeze'],
    firemaking: ['Firecrotch', 'Lightmylog', 'Tinderballs'],
    fletching: ['Shaftmaker', 'Nockitoff'],
    smithing: ['Hammeredhard', 'Ironrod', 'Steelrod'],
    herblore: ['Stirmypot', 'Grindmyherb', 'Vialvirile'],
    bank: ['Moneyshot', 'SporranBulge', 'Fatstack', 'Deeppockets'],
    runite: ['Runeboner', 'Hotrocks', 'Moltenrod'],
    helper: ['Bigpackage', 'Ballbag', 'Packhorse', 'Heavyload'],
} as const satisfies Record<string, readonly string[]>;

export type Role = keyof typeof NAMES;

export function pickName(role: Role, used: readonly string[]): string {
    const taken = new Set(used.map(n => n.toLowerCase()));
    const name = NAMES[role].find(n => !taken.has(n.toLowerCase()));
    if (!name) throw new Error(`no names left for ${role}`);
    return name;
}
