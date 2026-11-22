// Facade entry point re-exporting progression catalog loading, account observation, entry intent resolution,
// and method selection/materialization from cohesive acyclic submodules under ./progression-catalog/.
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
} from './progression-catalog/catalog';

export {
    PROGRESSION_SKILLS,
    catalogCoverage,
    loadProgressionCatalog,
    matchingProgressionRoutes,
} from './progression-catalog/catalog';

export { accountFromStatus } from './progression-catalog/account';

export { intentForEntry } from './progression-catalog/intent';

export { progressionMethods, progressionStep } from './progression-catalog/methods';
