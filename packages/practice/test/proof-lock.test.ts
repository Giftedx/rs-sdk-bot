import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recoverProofLock} from '../src/proof-lock';

test('timeout cleanup retains a dead owned lock as evidence and frees the next run',()=>{
    const dir=mkdtempSync(join(tmpdir(),'proof-lock-')),file=join(dir,'lock'),saved=join(dir,'expired.json');
    try{
        writeFileSync(file,JSON.stringify({pid:123,directory:dir}));
        expect(recoverProofLock(file,dir,saved,{alive:()=>false,portsFree:()=>true})).toBe(true);
        expect(existsSync(file)).toBe(false);expect(JSON.parse(readFileSync(saved,'utf8')).pid).toBe(123);
    }finally{rmSync(dir,{recursive:true,force:true});}
});
test('cleanup preserves another owner, a live process, unknown ownership and an occupied stack',()=>{
    const dir=mkdtempSync(join(tmpdir(),'proof-lock-')),file=join(dir,'lock'),saved=join(dir,'expired.json');
    try{
        for(const [owner,alive,portsFree] of [[{pid:123,directory:'other'},false,true],[{pid:123,directory:dir},true,true],[{pid:123,directory:dir},false,false],[{},false,true]] as const){
            writeFileSync(file,JSON.stringify(owner));
            expect(recoverProofLock(file,dir,saved,{alive:()=>alive,portsFree:()=>portsFree})).toBe(false);
            expect(existsSync(file)).toBe(true);
        }
    }finally{rmSync(dir,{recursive:true,force:true});}
});
