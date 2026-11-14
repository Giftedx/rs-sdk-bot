import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {bootstrapAccountServer,bootstrapPracticeServer} from './supply-bootstrap';

test('destructive bootstrap accepts isolated loopback engines on their own ports',()=>{
 for(const server of ['localhost:8888','127.0.0.1:21000','127.1.2.3:21010','[::1]:21100','::1','LOCALHOST:8888']){
  expect(bootstrapPracticeServer(`SERVER=${server}\r\nPASSWORD=fixture\r\n`)).toBe(server);
 }
 expect(bootstrapPracticeServer('PASSWORD=fixture\n')).toBe('localhost:8888');
});

test('public endpoints and loopback-looking domain names never admit destructive bootstrap',()=>{
 for(const server of ['rs-sdk-demo.fly.dev','example.com:8888','localhost.evil.test:8888','127.0.0.1.evil.test:8888','0.0.0.0:8888']){
  expect(()=>bootstrapPracticeServer(`SERVER=${server}\nDEMO_OK=1\n`)).toThrow('isolated loopback');
 }
 for(const name of ['','../Haggis','worker.env','toolongaccountname'])expect(()=>bootstrapAccountServer(name)).toThrow('valid practice account');
});

test('CLI refuses a public endpoint before opening a session even with the public-server override',()=>{
 const root=resolve(import.meta.dir,'..'),dir=mkdtempSync(join(root,'vendor/rs-sdk/bots','bp'));
 try{
  const name=basename(dir);
  writeFileSync(join(dir,'bot.env'),'SERVER=rs-sdk-demo.fly.dev\nPASSWORD=fixture-never-authenticate\n');
  const result=Bun.spawnSync([process.execPath,'scripts/supply-bootstrap.ts',name],{
   cwd:root,env:{...process.env,ROLE:'producer',PHASE:'clean',DEMO_OK:'1'},stdout:'pipe',stderr:'pipe',timeout:15000,windowsHide:true,
  });
  const output=result.stdout.toString()+result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(output).toMatch(/^RESULT fail (?:Error: )?supply bootstrap: isolated loopback practice actor required/m);
  expect(output).not.toMatch(/^START /m);
  expect(output).not.toContain('BOOTSTRAP_DISCARD');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
