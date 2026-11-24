import {describe, expect, test} from 'bun:test';
import {benchCases, BENCH_JOB_FILES, type BenchCase} from './aio-bench-cases';
import {computeCaseHash} from './aio-practice-bench';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const byKey = (key: string): BenchCase => {
  const found = benchCases().find(c => c.key === key);
  if (!found) throw Error(`missing bench case ${key}`);
  return found;
};

describe('post-Dragon Slayer cannon route', () => {
  const completed = 'LOGOUT logged-out\nRESULT ok cannon-fight spot=spiders ticks=2100 levels=Ranged:99,Defence:99,Hitpoints:99 done=Ranged:2100,Defence:400,Hitpoints:2050 died=false picked=true clear=true stop=-';

  test('accepts all three target levels with the cannon recovered and logout confirmed', () => {
    expect(byKey('extra:cannon-post-dragon-r1').pass(completed)).toBe(true);
  });

  test.each(['Ranged', 'Defence', 'Hitpoints'])('rejects a capped run short of %s 99', skill => {
    expect(byKey('extra:cannon-post-dragon-r1').pass(completed.replace(`${skill}:99`, `${skill}:98`))).toBe(false);
  });

  test.each([
    ['died=false', 'died=true'],
    ['picked=true', 'picked=false'],
    ['clear=true', 'clear=false'],
    ['LOGOUT logged-out', 'LOGOUT failed'],
    ['LOGOUT logged-out\n', ''],
    ['stop=-', 'stop=owner'],
  ])('rejects incomplete recovery or settlement: %s', (before, after) => {
    expect(byKey('extra:cannon-post-dragon-r1').pass(completed.replace(before, after))).toBe(false);
  });

  test('starts at the route combat level floors with Ranged 1 and a usable first weapon', () => {
    const fixture = byKey('extra:cannon-post-dragon-r1').presetConfig!;
    expect(fixture.skills).toEqual({Attack: 99, Strength: 99, Defence: 98, Hitpoints: 97, Prayer: 99, Magic: 80, Ranged: 1});
    expect(fixture.equipment!.find(i => i.slot === 3)?.id).toBe(1333);
    // The Ranged 55 fixture's coif and green dragonhide cannot be worn at Ranged 1.
    expect(fixture.equipment!.map(i => i.id)).not.toContain(1169);
    expect(fixture.equipment!.map(i => i.id)).not.toContain(1135);
    expect(fixture.equipment!.map(i => i.id)).not.toContain(1099);
    expect(fixture.equipment!.map(i => i.id)).not.toContain(1065);
    expect(fixture.inventory).toContainEqual({id: 861, count: 1});
    expect(byKey('extra:cannon-post-dragon-r1').scriptArgs).toContain('PHASES=1333:3:Defence=99,Ranged=55;861:1');
  });
});

describe('Dragon Slayer before the combat top-ups', () => {
  const completed = 'LOGOUT logged-out\nRESULT ok questMsg=true xp=strength=466250,defence=466250 at=2857,9638,0 ticks=1400 died=false milestones=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16';

  test('accepts quest completion, both reward deltas and confirmed logout', () => {
    expect(byKey('extra:dragon-post-mm').pass(completed)).toBe(true);
  });

  test.each([
    ['questMsg=true', 'questMsg=false'],
    ['strength=466250', 'strength=0'],
    ['defence=466250', 'defence=0'],
    ['died=false', 'died=true'],
    ['LOGOUT logged-out', 'LOGOUT failed'],
    ['LOGOUT logged-out\n', ''],
  ])('rejects incomplete early Dragon Slayer: %s', (before, after) => {
    expect(byKey('extra:dragon-post-mm').pass(completed.replace(before, after))).toBe(false);
  });

  test('prices only the route\'s 32 QP and uses gear wearable before Dragon Slayer', () => {
    const fixture = byKey('extra:dragon-post-mm').presetConfig!;
    expect(fixture.skills).toMatchObject({Attack: 99, Strength: 97, Defence: 89, Hitpoints: 97, Prayer: 99, Magic: 80, Ranged: 1});
    expect(fixture.varps![176] ?? 0).toBe(0);
    expect(fixture.equipment!.map(i => i.id)).not.toContain(1127);
    expect(fixture.equipment!.find(i => i.slot === 4)?.id).toBe(1113);
    const varpIds = new Map(readFileSync(join(import.meta.dir, '../../vendor/rs-sdk/server/content/pack/varp.pack'), 'utf8').trim().split(/\r?\n/).map(line => {
      const [id, name] = line.split('=');
      return [name!, Number(id)];
    }));
    const quests = JSON.parse(readFileSync(join(import.meta.dir, '../../knowledge/quests.json'), 'utf8')) as {varp: string; complete: number; questPoints: number}[];
    let qp = quests.filter(q => {
      const progress = fixture.varps![varpIds.get(q.varp)!] ?? 0;
      return ['arenaquest', 'mm_main'].includes(q.varp) ? progress >= q.complete : progress === q.complete;
    }).reduce((sum, q) => sum + q.questPoints, 0);
    // The generated quest catalog omits MM's completion constant, which is in the quest's own config.
    if (!quests.some(q => q.varp === 'mm_main')) {
      const constants = readFileSync(join(import.meta.dir, '../../vendor/rs-sdk/server/content/scripts/general/configs/quest.constant'), 'utf8');
      const mm = readFileSync(join(import.meta.dir, '../../vendor/rs-sdk/server/content/scripts/quests/quest_mm/configs/quest_mm.constant'), 'utf8');
      const complete = Number(mm.match(/^\^mm_complete = (\d+)$/m)![1]);
      if (fixture.varps![varpIds.get('mm_main')!]! >= complete) qp += Number(constants.match(/^\^mm_questpoints = (\d+)$/m)![1]);
    }
    expect(qp).toBe(32);
  });
});

describe('early Dragon Slayer with an explicit Varrock return', () => {
  const result = 'LOGOUT logged-out\nRESULT ok questMsg=true xp=strength=466250,defence=466250,magic=3100 at=3212,3424,0 ticks=2200 died=false';
  const teleport = 'QUEST_TELEPORT {"label":"dragon return varrock","comp":"magic:varrock_teleport","to":{"x":3212,"z":3424},"at":{"x":3212,"z":3424,"level":0},"magicXp":875}';
  const completed = teleport + '\n' + result;

  test('requires the observed return spell and final Varrock landing', () => {
    expect(byKey('extra:dragon-post-mm-return').pass(completed)).toBe(true);
  });

  test.each([
    [teleport + '\n', ''],
    ['magic:varrock_teleport', 'magic:lumbridge_teleport'],
    ['"magicXp":875', '"magicXp":0'],
    ['"x":3212,"z":3424,"level":0', '"x":2846,"z":9636,"level":0'],
    ['at=3212,3424,0', 'at=2846,9636,0'],
    ['defence=466250', 'defence=0'],
    ['died=false', 'died=true'],
    ['LOGOUT logged-out', 'LOGOUT failed'],
  ])('rejects incomplete quest return: %s', (before, after) => {
    expect(byKey('extra:dragon-post-mm-return').pass(completed.replace(before, after))).toBe(false);
  });

  test('adds only the missing fire rune to the early quest fixture', () => {
    const base = byKey('extra:dragon-post-mm'), returned = byKey('extra:dragon-post-mm-return');
    expect(returned.scriptArgs).toEqual(['dragon', 'DS_RETURN=varrock']);
    expect(returned.presetConfig).toEqual({...base.presetConfig, inventory: [...base.presetConfig!.inventory!, {id: 554, count: 1}]});
  });
});

describe('kept bench results', () => {
  test('reuse an unchanged case', () => {
    const c = byKey('pvp:fight');
    expect(computeCaseHash({...c})).toBe(computeCaseHash(c));
  });

  test('do not reuse a fight after the opponent kit changes', () => {
    const c = byKey('pvp:fight');
    const companions = c.companions!.map(k => ({...k, presetConfig: {...k.presetConfig, inventory: [{id: 385, count: 28}]}}));
    expect(computeCaseHash({...c, companions})).not.toBe(computeCaseHash(c));
  });

  test('do not reuse a fight after its engine rules change', () => {
    const c = byKey('pvp:fight');
    expect(computeCaseHash({...c, engineEnv: {...c.engineEnv, NODE_INFINITE_RUN: 'false'}})).not.toBe(computeCaseHash(c));
  });

  test('do not reuse a producer after its job target changes', () => {
    const c = byKey('skiller:crafting:jewellery-trip');
    const jobFiles = Object.fromEntries(Object.entries(c.jobFiles!).map(([path, job]) => [path, {...job as object, target: 13}]));
    expect(computeCaseHash({...c, jobFiles})).not.toBe(computeCaseHash(c));
  });

  test('do not reuse a result after the pass rule changes', () => {
    const c = byKey('pvp:fight');
    expect(computeCaseHash({...c, pass: () => false})).not.toBe(computeCaseHash(c));
  });

  test('do not reuse a rate after the output rule changes', () => {
    const c = byKey('pvp:fight');
    expect(computeCaseHash({...c, output: /different=(\d+)/i})).not.toBe(computeCaseHash(c));
  });

  test('do not reuse a result under a different timeout', () => {
    const c = byKey('pvp:fight');
    expect(computeCaseHash({...c, timeoutMs: 1})).not.toBe(computeCaseHash(c));
  });

  test('do not reuse shared job input after its quantity changes', () => {
    const c = byKey('pvp:fight');
    const before = computeCaseHash(c);
    const path = Object.keys(BENCH_JOB_FILES)[0]!;
    const original = BENCH_JOB_FILES[path];
    try {
      BENCH_JOB_FILES[path] = {...original as object, target: 13};
      expect(computeCaseHash(c)).not.toBe(before);
    } finally {
      BENCH_JOB_FILES[path] = original;
    }
  });
});

test('the end step case passes only when the account left its tile, the logout window opened and the server confirmed the logout', () => {
    const pass = byKey('extra:trooper-end-under-attack').pass;
    const leave = 'COMBAT_END leave {"tick":262,"at":{"x":2525,"z":3242,"level":0},"squares":14,"to":{"x":2563,"z":3238,"level":0}}';
    const result = 'RESULT fail mode=combat-end-case stop=cap creditedKills=0 runFailure="bank retreat failed" endTicks=71 endUnderAttack=true endLeft=true endQuiet=true endTiles=38 endEats=1 logout=confirmed logoutTries=1';
    const run = [leave, 'LOGOUT logged-out', result].join('\n');
    expect(pass(run)).toBe(true);
    // A step with no ground to leave, or with its own tile as the answer, is no proof.
    expect(pass(run.replace('"squares":14', '"squares":0'))).toBe(false);
    expect(pass(run.replace('"to":{"x":2563,"z":3238,"level":0}', '"to":{"x":2525,"z":3242,"level":0}'))).toBe(false);
    expect(pass(run.replace('"to":{"x":2563,"z":3238,"level":0}', '"to":null'))).toBe(false);
    expect(pass([result, 'LOGOUT logged-out'].join('\n'))).toBe(false);
    expect(pass(run.replace('endTiles=38', 'endTiles=0'))).toBe(false);
    // No fight before the step, no open logout window after it, or no confirmed logout.
    expect(pass(run.replace('endUnderAttack=true', 'endUnderAttack=false'))).toBe(false);
    expect(pass(run.replace('endQuiet=true', 'endQuiet=false'))).toBe(false);
    expect(pass(run.replace('logout=confirmed', 'logout=timeout'))).toBe(false);
    expect(pass(run.replace('LOGOUT logged-out', 'LOGOUT timeout'))).toBe(false);
});

describe('kill receipt pass rules', () => {
  test('the fight case passes only with the practice receipt of its kill', () => {
    const pass = byKey('pvp:fight').pass, tail = '{"outcome":"kill","ticks":40}';
    expect(pass(`RESULT ok pvp fight exit=0 kill killReceipts=1 receiptDomain=practice ${tail}`)).toBe(true);
    expect(pass(`RESULT ok pvp fight exit=0 kill killReceipts=0 receiptDomain=none ${tail}`)).toBe(false);
    expect(pass(`RESULT ok pvp fight exit=0 kill killReceipts=1 receiptDomain=live ${tail}`)).toBe(false);
    expect(pass(`RESULT ok pvp fight exit=0 kill ${tail}`)).toBe(false);
  });

  test('a squad case passes only when each kill has a practice receipt', () => {
    const pass = byKey('pvp:squad').pass;
    expect(pass('RESULT ok squad accounts=4 kills=3 killReceipts=3 receiptDomain=practice gangDied=3 died=0')).toBe(true);
    expect(pass('RESULT ok squad accounts=4 kills=0 killReceipts=0 receiptDomain=none gangDied=0 died=0')).toBe(true);
    expect(pass('RESULT ok squad accounts=4 kills=3 killReceipts=2 receiptDomain=practice gangDied=3 died=0')).toBe(false);
    expect(pass('RESULT ok squad accounts=4 kills=3 killReceipts=3 receiptDomain=live gangDied=3 died=0')).toBe(false);
    expect(pass('RESULT ok squad accounts=4 kills=3 killReceipts=3 receiptDomain=mixed gangDied=3 died=0')).toBe(false);
    expect(pass('RESULT ok squad accounts=4 kills=3 gangDied=3 died=0')).toBe(false);
    expect(pass('RESULT fail squad accounts=4 kills=3 killReceipts=3 receiptDomain=practice')).toBe(false);
  });
});

describe('benchCases lazy cache invariants', () => {
  test('invalidates cached cases when case environment overrides change and returns fresh array copies', () => {
    const prev = process.env.SPAR_NPC_NEAR;
    try {
      delete process.env.SPAR_NPC_NEAR;
      const a = benchCases();
      const origLen = a.length;
      a.pop();
      expect(benchCases().length).toBe(origLen);
      expect(byKey('pvp:fight').engineEnv?.SIM_NPC_NEAR).toBe('64');

      process.env.SPAR_NPC_NEAR = '32';
      expect(byKey('pvp:fight').engineEnv?.SIM_NPC_NEAR).toBe('32');
    } finally {
      if (prev === undefined) delete process.env.SPAR_NPC_NEAR;
      else process.env.SPAR_NPC_NEAR = prev;
    }
  });

  test('computeCaseHash invalidates stat-mtime memoized import closure when a transitive script changes', () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const pracDir = join(repoRoot, '.practice');
    mkdirSync(pracDir, { recursive: true });
    const dir = mkdtempSync(join(pracDir, 'case-hash-inval-'));
    try {
      const dep = join(dir, 'dep.ts');
      const entry = join(dir, 'entry.ts');
      writeFileSync(dep, 'export const v = 1;\n');
      utimesSync(dep, 1_700_000_000, 1_700_000_000);
      writeFileSync(entry, "import { v } from './dep';\nexport const out = v;\n");
      utimesSync(entry, 1_700_000_000, 1_700_000_000);
      const relEntry = entry.slice(repoRoot.length + 1).replace(/\\/g, '/');
      const sampleCase: BenchCase = {
        ...byKey('pvp:fight'),
        key: 'test:hash-inval',
        script: relEntry,
        scriptArgs: [],
      };
      const h1 = computeCaseHash(sampleCase);
      expect(computeCaseHash(sampleCase)).toBe(h1);

      writeFileSync(dep, 'export const v = 2;\n');
      utimesSync(dep, 1_700_000_010, 1_700_000_010);
      expect(computeCaseHash(sampleCase)).not.toBe(h1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
