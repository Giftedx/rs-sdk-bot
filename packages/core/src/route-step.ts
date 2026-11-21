// Resolve a catalog route without letting environment-only overrides discard its positional defaults.
import { parseStep, type Step } from './chain-step';

export const DEFAULT_METHOD: Readonly<Record<string, string>> = {
    fishing: 'shark', cooking: 'food', woodcutting: 'yews', firemaking: 'order',
    fletching: 'arrows', mining: 'ore', smithing: 'smelt', crafting: 'inventory',
    herblore: 'potions', runecraft: 'bank-craft', magic: 'order', prayer: 'bury',
    agility: 'order', thieving: 'knights', foraging: 'flax',
};

export function resolveSkillerMethod(skill: string, methodInput?: string, rest: readonly string[] = []): { method: string; args: string[] } {
    const explicit = !!methodInput && (/^--method=/i.test(methodInput) || !methodInput.includes('=') && !/^\d+$/.test(methodInput));
    return {
        method: explicit ? methodInput!.toLowerCase().replace(/^--method=/, '') : DEFAULT_METHOD[skill] ?? '',
        args: explicit ? [...rest] : methodInput ? [methodInput, ...rest] : [...rest],
    };
}

export function resolveRouteStep(spec: {
    script: string;
    defaultArgs?: readonly string[];
    defaultEnv?: Readonly<Record<string, string>>;
}, rest: readonly string[] = []): Step {
    const supplied = parseStep(spec.script);
    for (const token of rest) {
        const setting = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
        if (setting) supplied.env[setting[1]!] = setting[2]!;
        else supplied.args.push(token);
    }
    return {
        script: supplied.script,
        args: supplied.args.length ? supplied.args : [...(spec.defaultArgs ?? [])],
        env: { ...(spec.defaultEnv ?? {}), ...supplied.env },
    };
}
