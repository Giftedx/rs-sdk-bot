// Maker mould shop prerequisites and multi-step maker chain templates (`makerChains`).
import type { Template } from '../world';
import { GEM_RINGS, STEW_BATCH } from './constants';

// The shop step of a maker whose only missing input is a ring mould: Dommik's Crafting Store in Al Kharid sells it
// (scripts/shop-buyer.ts profile dommik: ring mould shelf 4, necklace/amulet moulds shelf 2). The moulds cost 5 coins each in item data and the run
// stops at the first one held (STOCK_TARGET 1).
const RING_MOULD_COINS = 100;
export function makerShopSteps(): Template[] {
    return [{
        id: 'shop-ring-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik', '600'],
        env: { ITEMS: 'ring mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy a ring mould from Dommik's Crafting Store in Al Kharid for the ring makers", repeats: false,
        resources: ['shop:dommik'], yields: () => [], provides: { item: 'ring mould', unlocks: [...GEM_RINGS.map(([gem]) => `aio-${gem}-rings`), 'squad-sapphire-ring', 'squad-emerald-ring', 'squad-dragonstone-ring'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'ring mould': 1 } },
    }, {
        id: 'shop-necklace-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik_moulds', '600'],
        env: { ITEMS: 'necklace mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy a necklace mould from Dommik's Crafting Store in Al Kharid for necklace makers", repeats: false,
        resources: ['shop:dommik_moulds'], yields: () => [], provides: { item: 'necklace mould', unlocks: ['squad-dragon-necklace'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'necklace mould': 1 } },
    }, {
        id: 'shop-amulet-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik_moulds', '600'],
        env: { ITEMS: 'amulet mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy an amulet mould from Dommik's Crafting Store in Al Kharid for amulet makers", repeats: false,
        resources: ['shop:dommik_moulds'], yields: () => [], provides: { item: 'amulet mould', unlocks: ['squad-dragonstone-amulet'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'amulet mould': 1 } },
    }];
}
export function makerChains(): Template[] {
    const step = (recipe: string, max: number, cap = 1500) => `scripts/aio.ts skiller crafting inventory ${recipe} MAX_MAKE=${max} CAP=${cap} MEMBERS=1 ORDER_MODE=best-effort`;
    const chain = (id: string, steps: string[], rest: Pick<Template, 'role' | 'goal' | 'needs' | 'yields' | 'repeats' | 'production'>): Template =>
        ({ id, pilot: true, family: 'aio:skiller:crafting:inventory', script: 'scripts/chain.ts', args: steps, env: { ROUNDS: '1' }, worker: 'scripts/microbot-production.ts', ...rest });
    return [
        chain('make-yew-shortbow', [step('cut-bow:unstrung_yew_shortbow', 1, 600), step('bow-string:yew_shortbow', 1, 600)], {
            role: 'fletching', goal: 'cut a banked yew log into a shortbow and string it', repeats: false,
            production: { output: 'yew shortbow', outputPerUnit: 1, maximum: 1, inputs: { 'yew logs': 1, 'bow string': 1 }, resize: n => ({ args: [step('cut-bow:unstrung_yew_shortbow', n, 600), step('bow-string:yew_shortbow', n, 600)] }) },
            needs: { skills: { Fletching: 65 }, items: { knife: 1, 'yew logs': 1, 'bow string': 1 }, holdsUnder: { 'yew shortbow': 1 } },
            yields: () => [{ item: 'yew shortbow', perTick: 0.01 }] }),
        chain('make-uncooked-stew', [step('prepare:potato-stew', STEW_BATCH), step('prepare:uncooked-stew', STEW_BATCH)], {
            role: 'cooking', goal: 'make uncooked stews from banked potatoes, bowls of water and cooked meat',
            repeats: false, production: { output: 'uncooked stew', outputPerUnit: 1, maximum: STEW_BATCH, inputs: { potato: 1, 'bowl of water': 1, 'cooked meat': 1 }, resize: n => ({ args: [step('prepare:potato-stew', n), step('prepare:uncooked-stew', n)] }) },
            needs: { skills: { Cooking: 25 }, items: { potato: STEW_BATCH, 'bowl of water': STEW_BATCH, 'cooked meat': STEW_BATCH } },
            yields: () => [{ item: 'uncooked stew', perTick: 0.05 }] }),
    ];
}
