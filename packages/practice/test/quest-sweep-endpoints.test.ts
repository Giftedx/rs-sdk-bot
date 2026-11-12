import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {questSweepProofAccountEnv,questSweepProofEndpoints} from '../src/quest-sweep-proof';
test('a newly created Windows local bot gets both owned endpoints even when SDK newline replacement omitted the gateway',()=>{
 const p=questSweepProofEndpoints({engine:22100,gateway:22101,management:22102,tcp:22103},'quest-sweep-12345678901234567890');
 const env=questSweepProofAccountEnv('SERVER=localhost\r\nTELEMETRY=false\r\n',p);
 expect(env).toContain('SERVER=127.0.0.1:22100');expect(env).toContain('GATEWAY_URL=ws://127.0.0.1:22101');
 for(const text of ['SERVER=rs-sdk-demo.fly.dev\n','SERVER=localhost:8910\n','SERVER=localhost\nGATEWAY_URL=ws://example.com\n'])expect(()=>questSweepProofAccountEnv(text,p)).toThrow('new practice account required');
});

test('the started Totem fixture credits the completed Clock Tower before the server recounts quest points',()=>{
 const source=readFileSync(new URL('../src/quest-sweep-proof.ts',import.meta.url),'utf8');
 const seeded=source.match(/applyPreset\(name,\s*totem\s*\?\s*\{.*?varps:\s*\{([^}]+)\}/s);
 expect(seeded).not.toBeNull();
 const vars=Object.fromEntries(seeded![1]!.split(',').map(pair=>pair.trim().split(':').map(Number)));
 expect(vars[200]).toBe(1);
 expect(vars[10]).toBe(8);
 expect(vars[101]).toBe(1);
});
