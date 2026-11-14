// Published owner holds (fleet/sides/<side>.json) apply until that side clears them. The same card informs adoption
// and remote supply selection; a missing or differently named card supplies no additional availability evidence.
export function publishedSideHold(card: any, side: string, account: string): 'side stopped' | 'owner pause' | 'death hold' | undefined {
    if (!card || card.side !== side) return undefined;
    if (card.stopped === true) return 'side stopped';
    const includes = (names: unknown) => Array.isArray(names) && names.some(n => typeof n === 'string' && n.toLowerCase() === account.toLowerCase());
    if (includes(card.paused)) return 'owner pause';
    if (includes(card.died)) return 'death hold';
    return undefined;
}
