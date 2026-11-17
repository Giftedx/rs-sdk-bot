import {describe, expect, test} from 'bun:test';
import {benchCases, BENCH_JOB_FILES, type BenchCase} from './aio-bench-cases';
import {computeCaseHash} from './aio-practice-bench';

const byKey = (key: string): BenchCase => {
  const found = benchCases().find(c => c.key === key);
  if (!found) throw Error(`missing bench case ${key}`);
  return found;
};

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
