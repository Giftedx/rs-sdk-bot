import {test,expect} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runeProofReceiptChecks} from '../src/rune-proof-receipt';
const started=1793534657343,directory='F:/proofs/rune-bank-craft-'+started+'-egMBcJ';
const receipt={source:'scoped-source',at:1793534746865,delivery:'rune-bank-craft-'+started+'-egMBcJ'};
test('a receipt from this delivery survives its long carrier phase and FIFO waits',()=>{
 expect(runeProofReceiptChecks(receipt,'scoped-source',directory,1793536223091)).toEqual({source:true,fresh:true});
});
test('another delivery cannot supply the receipt',()=>{
 expect(runeProofReceiptChecks({...receipt,delivery:'rune-bank-craft-'+started+'-Other'},'scoped-source',directory,receipt.at+1).fresh).toBe(false);
});
test('producer time must be within this delivery and not in the future',()=>{
 expect(runeProofReceiptChecks({...receipt,at:started-1},'scoped-source',directory,receipt.at).fresh).toBe(false);
 expect(runeProofReceiptChecks(receipt,'scoped-source',directory,receipt.at-1).fresh).toBe(false);
});
test('changed source and missing delivery identity still refuse',()=>{
 expect(runeProofReceiptChecks(receipt,'changed-source',directory,receipt.at).source).toBe(false);
 expect(runeProofReceiptChecks({...receipt,delivery:undefined},'scoped-source',directory,receipt.at).fresh).toBe(false);
});

test('a carrier memory stop explains failure before checking for final saves',()=>{
 const delivery=mkdtempSync(join(tmpdir(),'rune-carrier-floor-')),dir=join(delivery,'rune-carriers');
 mkdirSync(dir);
 writeFileSync(join(dir,'native.json'),JSON.stringify({names:['Fixture'],lowMemory:true,code:1,timedOut:false}));
 writeFileSync(join(dir,'worker.log'),'');
 const child=Bun.spawnSync([process.execPath,'packages/practice/src/rune-carriers-proof.ts','--verify'],{
  cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',DELIVERY_DIR:delivery},windowsHide:true,timeout:10000,
 });
 expect(child.exitCode).toBe(1);
 expect(child.stderr.toString()).toContain('Error: insufficient practice free memory floor');
 expect(existsSync(join(dir,'consumer.json'))).toBe(false);
});
