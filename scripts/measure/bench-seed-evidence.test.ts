import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {seedArtifacts} from './aio-practice-bench';

test.each([0,1,3])('each seed keeps its worker logs, ACKs, trace and stdout with %i jobs',jobs=>{
 const env={BENCH_TRACE:'.practice/test-trace',Q_BURST:'0'};
 const first=seedArtifacts(7,0,jobs,env),second=seedArtifacts(8,jobs>1?1:0,jobs,env);
 for(const field of ['BENCH_OUTPUT_DIR','BENCH_PROFILE_DIR','BENCH_TRACE'])expect(first.env[field]).not.toBe(second.env[field]);
 expect(first.stdout).not.toBe(second.stdout);
 expect(first.out).toBe(join('.practice/sim/aio-bench','seed-7.json'));
 expect(first.env.Q_BURST).toBe('0');
 expect(env).toEqual({BENCH_TRACE:'.practice/test-trace',Q_BURST:'0'});
});

test('custom evidence roots keep serial engine allocation and every seed remains distinct',()=>{
 const env={BENCH_SEED_OUT:'.practice/custom-rows',BENCH_OUTPUT_DIR:'.practice/custom-logs',BENCH_PROFILE_DIR:'.practice/custom-profile',BENCH_SLOT_BASE:'24',BENCH_PARALLEL:'1'};
 const result=seedArtifacts(7,0,1,env);
 expect(result.out).toBe(join('.practice/custom-rows','seed-7.json'));
 expect(result.stdout).toBe(join('.practice/custom-rows','seed-7.log'));
 expect(result.env.BENCH_OUTPUT_DIR).toBe(join('.practice/custom-logs','seed-7'));
 expect(result.env.BENCH_PROFILE_DIR).toBe(join('.practice/custom-profile','seed-7'));
 expect(result.env.BENCH_SLOT_BASE).toBe('24');
 expect(result.env.BENCH_PARALLEL).toBe('1');
});

test('parallel seed engines retain eight-slot spacing',()=>{
 const result=seedArtifacts(9,2,3,{});
 expect(result.env.BENCH_SLOT_BASE).toBe('16');
 expect(result.env.BENCH_PARALLEL).toBe('1');
});
