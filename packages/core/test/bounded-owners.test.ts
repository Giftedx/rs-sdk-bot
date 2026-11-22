import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {observeBoundedOwners} from '../src/bounded-owners';

test('a journaled successor, unknown owner or surviving child cannot prove bounded shutdown',()=>{
 const base=mkdtempSync(join(tmpdir(),'bounded-owners-')),dir=join(base,'.practice/live');mkdirSync(dir,{recursive:true});
 const binding={watchId:randomUUID(),plan:join(base,'handoff.json'),side:'cloud'};
 writeFileSync(join(dir,'swarm-owner.json'),JSON.stringify({...binding,pid:11,nonce:'old',successor:{pid:22,nonce:'reload-new'}}));
 const deps={alive:(pid:number)=>pid===22,command:(pid:number)=>pid===22?`${join(base,'scripts/swarm.ts')} reload-new`:null,groups:()=>[22]};
 expect(observeBoundedOwners(base,binding,[{pid:11,nonce:'old'}],deps)).toMatchObject({known:true,settled:false,active:[22]});
 expect(observeBoundedOwners(base,binding,[],{...deps,command:()=>null})).toMatchObject({known:false,settled:false});
 expect(observeBoundedOwners(base,binding,[],{...deps,alive:()=>false,groups:()=>[33]})).toMatchObject({known:true,settled:false,active:[33]});
 writeFileSync(join(dir,'swarm-owner.json'),JSON.stringify({pid:33,nonce:'prior-swarm',watchId:'prior-watch',plan:'prior-plan',side:'cloud'}));
 expect(observeBoundedOwners(base,binding,[],{...deps,alive:()=>false,groups:()=>[]})).toMatchObject({known:true,settled:true,active:[]});
 expect(observeBoundedOwners(base,binding,[],{...deps,alive:()=>false,groups:ids=>ids.includes(33)?[44]:[]})).toMatchObject({known:false,settled:false});
 unlinkSync(join(dir,'swarm-owner.json'));
 expect(observeBoundedOwners(base,binding,[],deps)).toMatchObject({known:false,settled:false});
 writeFileSync(join(dir,'swarm-owner.json'),'partial');
 expect(observeBoundedOwners(base,binding,[],deps)).toMatchObject({known:false,settled:false});
 rmSync(base,{recursive:true,force:true});
});
