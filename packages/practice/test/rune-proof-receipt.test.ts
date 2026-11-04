import {test,expect} from 'bun:test';
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
