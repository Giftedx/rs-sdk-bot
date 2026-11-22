import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
    CatalogAccept,
    CatalogEntry,
    CatalogGap,
    CatalogIntent,
    CatalogMethod,
    CatalogOptions,
    CatalogQuest,
    CatalogRoute,
    ProgressionCatalog,
} from '../../../core/src/progression-adapter';
import { TRAINING_SKILLS } from '../progression';

export type {
    CatalogAccept,
    CatalogEntry,
    CatalogGap,
    CatalogIntent,
    CatalogMethod,
    CatalogOptions,
    CatalogQuest,
    CatalogRoute,
    ProgressionCatalog,
};

/** Ordered list of skills recognized by the progression catalog. */
export const PROGRESSION_SKILLS = TRAINING_SKILLS;

export const DEFAULT_CATALOG_ROOT = resolve(import.meta.dir, '../../../..');
export const CATALOG_DATA_REL = 'packages/planner/data/progression-routes.json';
export const AIO_CATEGORIES = ['skiller', 'fighter', 'boss', 'pvp', 'quester', 'market', 'logistics'] as const;
export const AIO_WRAPPER_RE = /^scripts\/aio-(skiller|fighter|boss|pvp|quester|market|logistics)\.ts$/;

export const key = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
export const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const dated = (v: unknown, now: number): v is number => whole(v) && v > 0 && v <= now;
export const finiteLevel = (v: unknown): v is number => whole(v) && v >= 1 && v <= 99;

export function scriptPath(script: string): string {
    const p = script.replace(/\\/g, '/');
    const at = Math.max(p.lastIndexOf('/scripts/'), p.lastIndexOf('/packages/'));
    return at >= 0 ? p.slice(at + 1) : p.replace(/^\.\//, '');
}

// Match `scripts/<name>.ts` without literal file paths so worker-release keeps future worker closures excluded.
export function scriptStem(script: string): string | null {
    return script.startsWith('scripts/') && script.endsWith('.ts') ? script.slice(8, -3) : null;
}

export function entryNameOf(script: string): string {
    return (script.startsWith('scripts/') || /^packages\/[^/]+\/src\//.test(script)) && script.endsWith('.ts')
        ? script.replace(/^(?:scripts|packages\/[^/]+\/src)\/|\.ts$/g, '')
        : '';
}

export function setting(
    env: Readonly<Record<string, string | undefined>>,
    args: readonly string[],
    name: string,
): string | undefined {
    return env[name] ?? args.find(a => a.startsWith(name + '='))?.slice(name.length + 1);
}

export function positiveItems(value: Record<number, number> | undefined): Record<number, number> | null {
    return value && Object.keys(value).length && Object.entries(value).every(
        ([id, n]) => whole(Number(id)) && Number(id) > 0 && whole(n) && n > 0,
    )
        ? value
        : null;
}

/** Loads and validates the checked-in progression catalog from disk. */
export function loadProgressionCatalog(base = DEFAULT_CATALOG_ROOT): ProgressionCatalog {
    const data = JSON.parse(readFileSync(resolve(base, CATALOG_DATA_REL), 'utf8'));
    if (data?.version !== 1 || !['skills', 'routes', 'methods', 'quests', 'entries'].every(k => Array.isArray(data[k]))) {
        throw Error('invalid progression catalog');
    }
    return data;
}

/** Loads the progression catalog when the checked-in metadata file exists under `base`. */
export function optionalProgressionCatalog(base = DEFAULT_CATALOG_ROOT): ProgressionCatalog | undefined {
    return existsSync(resolve(base, CATALOG_DATA_REL)) ? loadProgressionCatalog(base) : undefined;
}

/** Finds catalog routes whose script and discriminators match the supplied invocation. */
export function matchingProgressionRoutes(
    script: string,
    args: readonly string[] = [],
    env: Readonly<Record<string, string | undefined>> = {},
    catalog: ProgressionCatalog = loadProgressionCatalog(),
): CatalogRoute[] {
    script = scriptPath(script);
    if (scriptStem(script) === 'aio') {
        const first = args[0];
        const category = first && (AIO_CATEGORIES as readonly string[]).includes(first) ? first : args[1];
        return category
            ? matchingProgressionRoutes('scripts/aio-' + category + '.ts', args.slice(category === first ? 1 : 2), env, catalog)
            : [];
    }
    const wrapper = script.match(AIO_WRAPPER_RE)?.[1];
    if (wrapper) {
        const name = wrapper === 'skiller' ? args.slice(0, 2).join(':') : args[0];
        return catalog.routes.filter(r => r.category === wrapper && r.name === name);
    }
    return catalog.routes.filter(r => {
        if (r.script !== script) return false;
        for (const [name, want] of Object.entries(r.discriminator?.env ?? {})) {
            const got = setting(env, args, name) ?? (name === 'TARGET' && scriptStem(script) === 'gather-combat' ? args[1] : undefined);
            if (got !== want) return false;
        }
        return Object.entries(r.discriminator?.args ?? {}).every(([at, want]) => args[Number(at)] === want);
    });
}

/** Summarizes route classification, skill mapping, and method qualification coverage. */
export function catalogCoverage(catalog: ProgressionCatalog = loadProgressionCatalog()) {
    const mappedSkills = [...new Set(catalog.methods.flatMap(m => Object.keys(m.effects.xp ?? {}).map(key)))].sort();
    return {
        routes: catalog.routes.length,
        classified: catalog.routes.filter(r => r.intents.length > 0).length,
        skills: [...catalog.skills],
        mappedSkills,
        missingSkills: catalog.skills.filter(s => !mappedSkills.includes(key(s))),
        methods: catalog.methods.length,
        qualified: catalog.methods.filter(m => !!m.qualification).length,
        unmapped: catalog.unmapped?.length ?? 0,
    };
}
